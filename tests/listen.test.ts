import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { outboundAddress, resolveListenHosts } from '../src/listen.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { buildQuery, classify, readId, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream } from './helpers/fake-upstream.ts';

const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers.reverse()) await c(); });

test('外向けのアドレスは、上流へ送るときの送信元アドレス（127.0.0.1 宛てなら 127.0.0.1）', async () => {
	assert.equal(await outboundAddress({ host: '127.0.0.1', port: 53 }), '127.0.0.1');
});

test('outbound を外向けのアドレスに置き換え、重なったアドレスは 1 つにまとめる', async () => {
	const hosts = await resolveListenHosts(['127.0.0.1', 'outbound', '192.0.2.10'], { host: '127.0.0.1', port: 53 });
	assert.deepEqual(hosts, ['127.0.0.1', '192.0.2.10']);
});

function askUdp(host: string, port: number, q: Buffer): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const s = dgram.createSocket('udp4');
		const t = setTimeout(() => { s.close(); resolve(null); }, 1500);
		s.on('message', (m) => { clearTimeout(t); s.close(); resolve(m); });
		s.send(q, port, host);
	});
}

test('複数のアドレスで、同じポートで待ち受け、どちらに問い合わせても答える', async () => {
	const ok = await startFakeUpstream({ behavior: 'resolve' });
	closers.push(() => ok.close());
	const config = parseConfig({
		listen: { hosts: ['127.0.0.1', '127.0.0.2'], port: 0 },
		allow: ['127.0.0.0/8'],
		hedgeMs: 100,
		timeoutMs: 800,
		upstreams: [{ name: 'A', primary: `127.0.0.1:${ok.port}`, secondary: `127.0.0.1:${ok.port}`, transport: 'udp' }],
	});
	const server = await startServer(config, () => {});
	closers.push(() => server.close());
	assert.deepEqual(server.hosts, ['127.0.0.1', '127.0.0.2']);
	for (const [i, host] of server.hosts.entries()) {
		const r = await askUdp(host, server.port, buildQuery('a.example', TYPE.A, 10 + i));
		assert.ok(r, `${host} から返事が無い`);
		assert.equal(classify(r), 'resolved');
		assert.equal(readId(r), 10 + i);
	}
});
