import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRace } from '../src/race.ts';
import type { Group } from '../src/config.ts';
import { buildQuery, classify, readId, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream, type FakeOptions, type FakeUpstream } from './helpers/fake-upstream.ts';

const started: FakeUpstream[] = [];
after(async () => { await Promise.all(started.map((u) => u.close())); });

async function up(opt: FakeOptions): Promise<FakeUpstream> {
	const u = await startFakeUpstream(opt);
	started.push(u);
	return u;
}

function group(name: string, p: FakeUpstream, s: FakeUpstream): Group {
	return { name, primary: { host: p.host, port: p.port }, secondary: { host: s.host, port: s.port } };
}

const opts = { hedgeMs: 100, timeoutMs: 800 };

function aOf(res: Buffer): string {
	return [...res.subarray(res.length - 4)].join('.');
}

test('一番速く解決できた上流の応答が返り、ID は問合せの ID になる', async () => {
	const slow = await up({ behavior: 'resolve', delayMs: 200, answer: '192.0.2.1' });
	const fast = await up({ behavior: 'resolve', delayMs: 10, answer: '192.0.2.2' });
	const mid = await up({ behavior: 'resolve', delayMs: 100, answer: '192.0.2.3' });
	const spare = await up({ behavior: 'silent' });
	const q = buildQuery('a.example', TYPE.A, 0x4242);
	const r = await resolveRace(q, [group('A', slow, spare), group('B', fast, spare), group('C', mid, spare)], opts);
	assert.equal(classify(r.response), 'resolved');
	assert.equal(aOf(r.response), '192.0.2.2');
	assert.equal(readId(r.response), 0x4242);
	assert.equal(r.winner, 'B/primary');
});

test('先に NXDOMAIN が返っても、後から解決できた組の応答を返す（担当外の返事を採用しない）', async () => {
	const nx = await up({ behavior: 'nxdomain', delayMs: 0 });
	const nodata = await up({ behavior: 'nodata', delayMs: 0 });
	const ok = await up({ behavior: 'resolve', delayMs: 150, answer: '192.0.2.9' });
	const q = buildQuery('intra.example', TYPE.A, 1);
	const r = await resolveRace(q, [group('A', nx, nx), group('B', nodata, nodata), group('C', ok, ok)], opts);
	assert.equal(classify(r.response), 'resolved');
	assert.equal(aOf(r.response), '192.0.2.9');
});

test('全組（代替を含む）が NXDOMAIN なら NXDOMAIN を返す', async () => {
	const nx = await up({ behavior: 'nxdomain' });
	const q = buildQuery('none.example', TYPE.A, 3);
	const r = await resolveRace(q, [group('A', nx, nx), group('B', nx, nx), group('C', nx, nx)], opts);
	assert.equal(classify(r.response), 'nxdomain');
	assert.equal(readId(r.response), 3);
	assert.equal(r.outcome, 'nxdomain');
});

test('否定の強さは NXDOMAIN ＞ NODATA ＞ SERVFAIL の順に選ぶ', async () => {
	const nodata = await up({ behavior: 'nodata' });
	const fail = await up({ behavior: 'servfail' });
	const nx = await up({ behavior: 'nxdomain', delayMs: 50 });
	const q = buildQuery('x.example', TYPE.A, 1);
	const r1 = await resolveRace(q, [group('A', nodata, nodata), group('B', fail, fail)], opts);
	assert.equal(classify(r1.response), 'nodata');
	const r2 = await resolveRace(q, [group('A', nodata, nodata), group('B', fail, fail), group('C', nx, nx)], opts);
	assert.equal(classify(r2.response), 'nxdomain');
});

test('primary が一定時間返さなければ secondary にも送り、その応答を使う', async () => {
	const dead = await up({ behavior: 'silent' });
	const second = await up({ behavior: 'resolve', answer: '192.0.2.20' });
	const q = buildQuery('b.example', TYPE.A, 1);
	const t0 = Date.now();
	const r = await resolveRace(q, [group('A', dead, second)], opts);
	assert.equal(aOf(r.response), '192.0.2.20');
	assert.equal(r.winner, 'A/secondary');
	assert.ok(Date.now() - t0 >= opts.hedgeMs - 5);
	assert.ok(Date.now() - t0 < opts.timeoutMs);
});

test('primary が速く解決できれば secondary には送らない', async () => {
	const first = await up({ behavior: 'resolve', delayMs: 0 });
	const second = await up({ behavior: 'resolve' });
	const q = buildQuery('c.example', TYPE.A, 1);
	await resolveRace(q, [group('A', first, second)], opts);
	assert.equal(second.udpHits, 0);
});

test('primary が解決できない返事をしたら、待たずに secondary へ送る', async () => {
	const fail = await up({ behavior: 'servfail' });
	const second = await up({ behavior: 'resolve', answer: '192.0.2.30' });
	const q = buildQuery('d.example', TYPE.A, 1);
	const t0 = Date.now();
	const r = await resolveRace(q, [group('A', fail, second)], { hedgeMs: 500, timeoutMs: 1500 });
	assert.equal(aOf(r.response), '192.0.2.30');
	assert.ok(Date.now() - t0 < 400);
});

test('全組が無応答なら全体の期限で SERVFAIL を返す', async () => {
	const dead = await up({ behavior: 'silent' });
	const q = buildQuery('e.example', TYPE.A, 0x77);
	const t0 = Date.now();
	const r = await resolveRace(q, [group('A', dead, dead), group('B', dead, dead)], { hedgeMs: 50, timeoutMs: 300 });
	assert.equal(r.outcome, 'servfail');
	assert.equal(r.response[3] & 0x0f, 2);
	assert.equal(readId(r.response), 0x77);
	assert.ok(Date.now() - t0 >= 290);
});

test('TC 付きの応答は同じ上流へ TCP で取り直す', async () => {
	const tc = await up({ behavior: 'truncate', answer: '192.0.2.40' });
	const q = buildQuery('big.example', TYPE.A, 1);
	const r = await resolveRace(q, [group('A', tc, tc)], opts);
	assert.equal(classify(r.response), 'resolved');
	assert.equal(aOf(r.response), '192.0.2.40');
	assert.equal(tc.tcpHits, 1);
});
