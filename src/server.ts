// 受け口。UDP と TCP を同じポートで待ち受け、許可リストに入る送信元にだけ答える
import dgram from 'node:dgram';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { DnsCache } from './cache.ts';
import { buildAllowList } from './cidr.ts';
import type { Config } from './config.ts';
import { hasEdns, isResponse, parseQuestion, truncateForUdp, typeName, udpLimit } from './dns-message.ts';
import { consoleLogger, type Logger } from './log.ts';
import { resolveRace, type Attempt } from './race.ts';
import { UpstreamStats } from './stats.ts';

export interface RunningServer {
	port: number;
	close(): Promise<void>;
}

/** TCP の接続を、問合せが来ないまま持ち続ける長さ */
const TCP_IDLE_MS = 10_000;

export async function startServer(config: Config, log: Logger = consoleLogger): Promise<RunningServer> {
	const allow = buildAllowList(config.allow);
	const cache = new DnsCache({ maxEntries: config.cacheMaxEntries });
	const stats = new UpstreamStats();
	const raceOptions = { ...config, onAttempt: (a: Attempt) => stats.attempt(a) };
	const statsTimer = config.statsIntervalMs > 0 ? setInterval(() => log('INFO', stats.summary()), config.statsIntervalMs) : null;
	statsTimer?.unref();

	const handle = async (query: Buffer, transport: string, from: string): Promise<Buffer | null> => {
		let label: string;
		try {
			if (isResponse(query)) return null;
			const q = parseQuestion(query);
			label = `${q.name} ${typeName(q.qtype)}`;
		} catch {
			// 壊れたメッセージには答えない
			return null;
		}
		const cached = cache.get(query);
		if (cached) {
			log('INFO', `${transport} ${from} ${label} resolved cache`);
			return cached;
		}
		const r = await resolveRace(query, config.upstreams, raceOptions);
		stats.query(r.outcome === 'resolved' ? r.winner : undefined);
		if (r.outcome === 'resolved') cache.set(query, r.response);
		log(r.outcome === 'servfail' ? 'WARN' : 'INFO', `${transport} ${from} ${label} ${r.outcome} ${r.winner ?? '-'} ${r.elapsedMs}ms`);
		return r.response;
	};

	const tcp = net.createServer();
	const sockets = new Set<net.Socket>();
	tcp.on('connection', (sock) => {
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
				}, (err) => log('ERROR', `tcp ${from} ${String(err)}`));
			}
		});
	});

	const udp = dgram.createSocket(net.isIPv6(config.listen.host) ? 'udp6' : 'udp4');
	udp.on('message', (msg, rinfo) => {
		if (!allow(rinfo.address)) return;
		handle(msg, 'udp', rinfo.address).then((res) => {
			if (res) udp.send(truncateForUdp(res, udpLimit(msg), hasEdns(msg)), rinfo.port, rinfo.address);
		}, (err) => log('ERROR', `udp ${rinfo.address} ${String(err)}`));
	});
	udp.on('error', (err) => log('ERROR', `udp ${String(err)}`));

	// ポート 0 のときは TCP で空きを取り、同じ番号で UDP も待ち受ける
	await new Promise<void>((resolve, reject) => {
		tcp.once('error', reject);
		tcp.listen(config.listen.port, config.listen.host, () => resolve());
	});
	const port = (tcp.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) => {
		udp.once('error', reject);
		udp.bind(port, config.listen.host, () => resolve());
	});

	return {
		port,
		close: async () => {
			if (statsTimer) clearInterval(statsTimer);
			log('INFO', stats.summary());
			for (const s of sockets) s.destroy();
			await new Promise<void>((r) => udp.close(() => r()));
			await new Promise<void>((r) => tcp.close(() => r()));
		},
	};
}
