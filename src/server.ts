// 受け口。UDP と TCP を同じポートで待ち受け、許可リストに入る送信元にだけ答える
import dgram from 'node:dgram';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { DnsCache } from './cache.ts';
import { buildAllowList } from './cidr.ts';
import type { Config } from './config.ts';
import { hasEdns, isResponse, parseQuestion, truncateForUdp, udpLimit } from './dns-message.ts';
import { consoleLogger, type Logger } from './log.ts';
import { resolveListenHosts } from './listen.ts';
import { queryLogLine, type QueryOutcome } from './query-log.ts';
import { resolveRace, type Attempt } from './race.ts';
import { UpstreamStats } from './stats.ts';
import { DEFAULT_TRANSPORT_OPTIONS, TransportModes } from './transport.ts';

export interface RunningServer {
	port: number;
	/** 実際に待ち受けているアドレス（outbound を置き換えたあと） */
	hosts: string[];
	close(): Promise<void>;
}

/** TCP の接続を、問合せが来ないまま持ち続ける長さ */
const TCP_IDLE_MS = 10_000;

export async function startServer(config: Config, log: Logger = consoleLogger): Promise<RunningServer> {
	const allow = buildAllowList(config.allow);
	const cache = new DnsCache({ maxEntries: config.cacheMaxEntries });
	const stats = new UpstreamStats();
	const raceOptions = { ...config, onAttempt: (a: Attempt) => stats.attempt(a) };
	// 待ち受けを始める前に、UDP に答えない上流を見つけて TCP 専用にする
	const modes = new TransportModes(DEFAULT_TRANSPORT_OPTIONS, log);
	for (const g of config.upstreams) {
		modes.watch(g.primary, g.transport);
		modes.watch(g.secondary, g.transport);
	}
	await modes.probeAll();
	modes.start();
	const statsTimer = config.statsIntervalMs > 0 ? setInterval(() => log('INFO', stats.summary()), config.statsIntervalMs) : null;
	statsTimer?.unref();

	const handle = async (query: Buffer, transport: string, from: string): Promise<Buffer | null> => {
		let question: { name: string; qtype: number };
		try {
			if (isResponse(query)) return null;
			question = parseQuestion(query);
		} catch {
			// 壊れたメッセージには答えない
			return null;
		}
		const write = (outcome: QueryOutcome, upstream: string | undefined, ms: number, response: Buffer) => {
			const line = queryLogLine({ outcome, transport, from, name: question.name, qtype: question.qtype, upstream, ms, response });
			log(line.level, line.message);
		};
		const cached = cache.get(query);
		if (cached) {
			write('cached', 'cache', 0, cached);
			return cached;
		}
		const r = await resolveRace(query, config.upstreams, raceOptions, modes.send);
		stats.query(r.outcome === 'resolved' ? r.winner : undefined);
		if (r.outcome === 'resolved') cache.set(query, r.response);
		write(r.outcome, r.winner, r.elapsedMs, r.response);
		return r.response;
	};

	let closed = false;
	const sockets = new Set<net.Socket>();
	const onConnection = (sock: net.Socket) => {
		if (!allow(sock.remoteAddress ?? '')) {
			sock.destroy();
			return;
		}
		const from = sock.remoteAddress ?? '?';
		sockets.add(sock);
		sock.setTimeout(TCP_IDLE_MS, () => sock.destroy());
		sock.on('close', () => sockets.delete(sock));
		sock.on('error', () => sock.destroy());
		let buf = Buffer.alloc(0);
		sock.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				const msg = Buffer.from(buf.subarray(2, 2 + buf.readUInt16BE(0)));
				buf = buf.subarray(2 + msg.length);
				// 応答は問合せの ID で照合されるので、届いた順に返さなくてよい
				handle(msg, 'tcp', from).then((res) => {
					if (!res || sock.destroyed) return;
					const len = Buffer.alloc(2);
					len.writeUInt16BE(res.length);
					sock.write(Buffer.concat([len, res]));
				}).catch((err) => log('ERROR', `tcp ${from} ${String(err)}`));
			}
		});
	};

	const createUdp = (host: string): dgram.Socket => {
		const udp = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
		udp.on('message', (msg, rinfo) => {
			if (!allow(rinfo.address)) return;
			handle(msg, 'udp', rinfo.address).then((res) => {
				if (!res || closed) return;
				// 送信先が消えた・停止の途中で閉じた、などの失敗は WARN にとどめる
				udp.send(truncateForUdp(res, udpLimit(msg), hasEdns(msg)), rinfo.port, rinfo.address, (err) => {
					if (err) log('WARN', `udp ${rinfo.address} 応答を送れませんでした: ${String(err)}`);
				});
			}).catch((err) => log('ERROR', `udp ${rinfo.address} ${String(err)}`));
		});
		return udp;
	};

	// 待ち受けるアドレスごとに TCP と UDP を開く。outbound は外向けのアドレスに置き換える
	const hosts = await resolveListenHosts(config.listen.hosts, config.upstreams[0].primary);
	const tcps: net.Server[] = [];
	const udps: dgram.Socket[] = [];
	let port = config.listen.port;
	const closeAll = async () => {
		for (const s of sockets) s.destroy();
		for (const u of udps) await new Promise<void>((r) => { try { u.close(() => r()); } catch { r(); } });
		for (const t of tcps) await new Promise<void>((r) => t.close(() => r()));
	};
	try {
		for (const host of hosts) {
			// ポート 0 のときは最初のアドレスの TCP で空きを取り、ほかもすべて同じ番号で待ち受ける
			const tcp = net.createServer(onConnection);
			await new Promise<void>((resolve, reject) => {
				tcp.once('error', reject);
				tcp.listen(port, host, () => resolve());
			});
			tcps.push(tcp);
			port = (tcp.address() as AddressInfo).port;
			const udp = createUdp(host);
			await new Promise<void>((resolve, reject) => {
				udp.once('error', reject);
				udp.bind(port, host, () => resolve());
			});
			udp.on('error', (err) => log('ERROR', `udp ${host} ${String(err)}`));
			udps.push(udp);
		}
	} catch (err) {
		// 一部だけ開いた状態で終わらないよう、開いた分を閉じてから起動の失敗にする
		await closeAll();
		await modes.stop();
		if (statsTimer) clearInterval(statsTimer);
		throw err;
	}

	return {
		port,
		hosts,
		// 後片付けの各段は、1 段が失敗しても次の段へ進む
		close: async () => {
			if (closed) return;
			closed = true;
			if (statsTimer) clearInterval(statsTimer);
			const steps: Array<[string, () => Promise<void> | void]> = [
				['集計の記録', () => log('INFO', stats.summary())],
				['受け口を閉じる', closeAll],
				['上流の確かめを止める', () => modes.stop()],
			];
			for (const [name, step] of steps) {
				try {
					await step();
				} catch (err) {
					log('WARN', `停止処理（${name}）に失敗しました: ${String(err)}`);
				}
			}
		},
	};
}
