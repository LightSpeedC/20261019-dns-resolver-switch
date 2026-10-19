import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { startServer, type RunningServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { buildQuery, classify, readId, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.ts';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers.reverse()) await c(); });

async function setup(allow: string[]): Promise<{ server: RunningServer; ok: FakeUpstream }> {
	const ok = await startFakeUpstream({ behavior: 'resolve', answer: '192.0.2.50' });
	const nx = await startFakeUpstream({ behavior: 'nxdomain' });
	closers.push(() => ok.close(), () => nx.close());
	const config = parseConfig({
		listen: { host: '127.0.0.1', port: 0 },
		allow,
		hedgeMs: 100,
		timeoutMs: 800,
		upstreams: [
			{ name: 'A', primary: `127.0.0.1:${nx.port}`, secondary: `127.0.0.1:${nx.port}` },
			{ name: 'B', primary: `127.0.0.1:${ok.port}`, secondary: `127.0.0.1:${ok.port}` },
		],
	});
	const server = await startServer(config, () => {});
	closers.push(() => server.close());
	return { server, ok };
}

function askUdp(port: number, q: Buffer, waitMs = 1500): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const s = dgram.createSocket('udp4');
		const t = setTimeout(() => { s.close(); resolve(null); }, waitMs);
		s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m); });
		s.send(q, port, '127.0.0.1');
	});
}

function askTcp(port: number, qs: Buffer[]): Promise<Buffer[]> {
	return new Promise((resolve, reject) => {
		const sock = net.connect(port, '127.0.0.1');
		const out: Buffer[] = [];
		let buf = Buffer.alloc(0);
		// サーバが送信中の接続を閉じると、Windows ではクライアントに ECONNRESET が届く。閉じられた扱いにする
		sock.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' ? resolve(out) : reject(err)));
		sock.on('close', () => resolve(out));
		sock.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				out.push(buf.subarray(2, 2 + buf.readUInt16BE(0)));
				buf = buf.subarray(2 + buf.readUInt16BE(0));
			}
			if (out.length === qs.length) sock.end();
		});
		// 長さ前置きを 2 件まとめて 1 回で送り、1 本の接続で続けて来る問合せに応えることを確かめる
		sock.write(Buffer.concat(qs.map((q) => {
			const len = Buffer.alloc(2);
			len.writeUInt16BE(q.length);
			return Buffer.concat([len, q]);
		})));
	});
}

test('UDP で問い合わせると、解決できた組の応答が問合せの ID で返る', async () => {
	const { server } = await setup(['127.0.0.0/8']);
	const r = await askUdp(server.port, buildQuery('a.example', TYPE.A, 0x1111));
	assert.ok(r);
	assert.equal(classify(r), 'resolved');
	assert.equal(readId(r), 0x1111);
});

test('TCP で 1 本の接続に続けて 2 件問い合わせても、両方に答える', async () => {
	const { server } = await setup(['127.0.0.0/8']);
	const rs = await askTcp(server.port, [buildQuery('a.example', TYPE.A, 1), buildQuery('b.example', TYPE.A, 2)]);
	assert.equal(rs.length, 2);
	assert.deepEqual(rs.map(readId).sort(), [1, 2]);
	assert.ok(rs.every((r) => classify(r) === 'resolved'));
});

test('2 回目の同じ問合せはキャッシュから返し、上流へは送らない', async () => {
	const { server, ok } = await setup(['127.0.0.0/8']);
	await askUdp(server.port, buildQuery('cached.example', TYPE.A, 1));
	const hits = ok.udpHits;
	const r = await askUdp(server.port, buildQuery('cached.example', TYPE.A, 2));
	assert.ok(r);
	assert.equal(readId(r), 2);
	assert.equal(ok.udpHits, hits);
});

test('許可リストに無い送信元には、UDP は返事をせず、TCP は接続を閉じる', async () => {
	const { server } = await setup(['192.0.2.0/24']);
	assert.equal(await askUdp(server.port, buildQuery('a.example', TYPE.A, 1), 400), null);
	const rs = await askTcp(server.port, [buildQuery('a.example', TYPE.A, 1)]);
	assert.equal(rs.length, 0);
});

test('起動時に UDP に答えない上流を見つけ、その上流には最初から TCP で問い合わせる', async () => {
	const tcpOnly = await startFakeUpstream({ behavior: 'resolve', noUdp: true, answer: '192.0.2.60' });
	closers.push(() => tcpOnly.close());
	const config = parseConfig({
		listen: { host: '127.0.0.1', port: 0 },
		allow: ['127.0.0.0/8'],
		hedgeMs: 100,
		timeoutMs: 800,
		upstreams: [{ name: 'T', primary: `127.0.0.1:${tcpOnly.port}`, secondary: `127.0.0.1:${tcpOnly.port}` }],
	});
	const server = await startServer(config, () => {});
	closers.push(() => server.close());
	const probeHits = tcpOnly.udpHits;
	const t0 = Date.now();
	const r = await askUdp(server.port, buildQuery('t.example', TYPE.A, 8));
	assert.ok(r);
	assert.equal(classify(r), 'resolved');
	assert.equal(tcpOnly.udpHits, probeHits);
	// UDP を待たないので、secondary へ送るまでの待ち時間より早く返る
	assert.ok(Date.now() - t0 < 100);
});

test('壊れたメッセージを受けても落ちず、次の問合せに答える', async () => {
	const { server } = await setup(['127.0.0.0/8']);
	assert.equal(await askUdp(server.port, Buffer.from([1, 2, 3]), 300), null);
	const r = await askUdp(server.port, buildQuery('a.example', TYPE.A, 5));
	assert.ok(r);
	assert.equal(readId(r), 5);
});
