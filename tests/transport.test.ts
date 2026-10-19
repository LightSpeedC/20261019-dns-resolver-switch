import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { TransportModes } from '../src/transport.ts';
import { buildQuery, classify, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream, type FakeOptions, type FakeUpstream } from './helpers/fake-upstream.ts';

const started: FakeUpstream[] = [];
after(async () => { await Promise.all(started.map((u) => u.close())); });

async function up(opt: FakeOptions): Promise<FakeUpstream> {
	const u = await startFakeUpstream(opt);
	started.push(u);
	return u;
}

const addrOf = (u: FakeUpstream) => ({ host: u.host, port: u.port });
const quiet = () => {};
const options = { probeTimeoutMs: 300, failThreshold: 3, recheckMs: 60_000, minProbeGapMs: 0 };

test('確かめる問合せで、UDP に答えず TCP に答える上流は TCP 専用になる', async () => {
	const u = await up({ behavior: 'resolve', noUdp: true });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(u), 'auto');
	assert.equal(await modes.probe(addrOf(u)), 'tcp');
	assert.equal(modes.mode(addrOf(u)), 'tcp');
});

test('UDP に答える上流は UDP のまま。否定の応答（REFUSED 等）でも答えれば使えるとみなす', async () => {
	const ok = await up({ behavior: 'resolve' });
	const refused = await up({ behavior: 'refused' });
	const modes = new TransportModes(options, quiet);
	for (const u of [ok, refused]) {
		modes.watch(addrOf(u), 'auto');
		assert.equal(await modes.probe(addrOf(u)), 'udp');
		assert.equal(modes.mode(addrOf(u)), 'udp');
	}
});

test('UDP にも TCP にも答えない上流は、落ちているだけかもしれないので UDP のままにする', async () => {
	const dead = await up({ behavior: 'silent' });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(dead), 'auto');
	assert.equal(await modes.probe(addrOf(dead)), 'unknown');
	assert.equal(modes.mode(addrOf(dead)), 'udp');
});

test('TCP 専用の上流へは UDP を送らない', async () => {
	const u = await up({ behavior: 'resolve', noUdp: true });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(u), 'tcp');
	const hits = u.udpHits;
	const r = await modes.send(addrOf(u), buildQuery('a.example', TYPE.A, 1), AbortSignal.timeout(1000));
	assert.equal(classify(r), 'resolved');
	assert.equal(u.udpHits, hits);
});

test('動いている間に UDP の応答が無い試行が続いたら確かめ直し、TCP 専用に切り替える', async () => {
	const u = await up({ behavior: 'resolve', noUdp: true });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(u), 'auto');
	for (let i = 0; i < options.failThreshold; i++) {
		await assert.rejects(modes.send(addrOf(u), buildQuery('a.example', TYPE.A, 1), AbortSignal.timeout(50)));
	}
	await modes.idle();
	assert.equal(modes.mode(addrOf(u)), 'tcp');
});

test('TCP 専用にした上流も、確かめ直して UDP に答えるようになっていれば UDP に戻す', async () => {
	const u = await up({ behavior: 'resolve' });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(u), 'auto');
	modes.force(addrOf(u), 'tcp');
	await modes.recheckTcp();
	assert.equal(modes.mode(addrOf(u)), 'udp');
});

test('設定で決め打ちした方式（udp / tcp）は、確かめ直しでも変えない', async () => {
	const noUdp = await up({ behavior: 'resolve', noUdp: true });
	const ok = await up({ behavior: 'resolve' });
	const modes = new TransportModes(options, quiet);
	modes.watch(addrOf(noUdp), 'udp');
	modes.watch(addrOf(ok), 'tcp');
	await modes.probeAll();
	for (let i = 0; i < options.failThreshold; i++) {
		await assert.rejects(modes.send(addrOf(noUdp), buildQuery('a.example', TYPE.A, 1), AbortSignal.timeout(50)));
	}
	await modes.recheckTcp();
	await modes.idle();
	assert.equal(modes.mode(addrOf(noUdp)), 'udp');
	assert.equal(modes.mode(addrOf(ok)), 'tcp');
	assert.equal(ok.udpHits, 0);
});
