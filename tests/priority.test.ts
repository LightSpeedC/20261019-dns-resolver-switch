import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRace } from '../src/race.ts';
import type { Group } from '../src/config.ts';
import { buildQuery, classify, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream, type FakeOptions, type FakeUpstream } from './helpers/fake-upstream.ts';

// 設定の並び順を優先順位にする（i261020-03）。後ろの組が先に解決しても、前の組を最大 priorityWaitMs 待つ

const started: FakeUpstream[] = [];
after(async () => { await Promise.all(started.map((u) => u.close())); });

async function group(name: string, opt: FakeOptions): Promise<Group> {
	const u = await startFakeUpstream(opt);
	started.push(u);
	const a = { host: u.host, port: u.port };
	return { name, primary: a, secondary: a, transport: 'auto' };
}

const opts = { hedgeMs: 100, timeoutMs: 2000, priorityWaitMs: 300 };
const q = () => buildQuery('p.example', TYPE.A, 1);
const aOf = (res: Buffer) => [...res.subarray(res.length - 4)].join('.');

test('組 2 が先に解決しても、組 1 が待つ間に解決すれば組 1 の応答を返す', async () => {
	const g1 = await group('G1', { behavior: 'resolve', delayMs: 60, answer: '192.0.2.1' });
	const g2 = await group('G2', { behavior: 'resolve', delayMs: 0, answer: '192.0.2.2' });
	const t0 = Date.now();
	const r = await resolveRace(q(), [g1, g2], opts);
	assert.equal(aOf(r.response), '192.0.2.1');
	assert.equal(r.winner, 'G1/primary');
	assert.ok(Date.now() - t0 >= 55);
	assert.ok(Date.now() - t0 < 250);
});

test('前の組が解決できないと決まったら、待たずに後ろの組の応答を返す', async () => {
	const g1 = await group('G1', { behavior: 'nxdomain' });
	const g2 = await group('G2', { behavior: 'resolve', delayMs: 20, answer: '192.0.2.2' });
	const t0 = Date.now();
	const r = await resolveRace(q(), [g1, g2], opts);
	assert.equal(aOf(r.response), '192.0.2.2');
	assert.ok(Date.now() - t0 < 200);
});

test('組 3・組 2 の順に解決し、組 1 が解決できないと決まったら、組 2 の応答を返す', async () => {
	const g1 = await group('G1', { behavior: 'nxdomain', delayMs: 60 });
	const g2 = await group('G2', { behavior: 'resolve', delayMs: 30, answer: '192.0.2.2' });
	const g3 = await group('G3', { behavior: 'resolve', delayMs: 0, answer: '192.0.2.3' });
	const r = await resolveRace(q(), [g1, g2, g3], opts);
	assert.equal(aOf(r.response), '192.0.2.2');
	assert.equal(classify(r.response), 'resolved');
});

test('前の組が答えなければ、最初の候補から priorityWaitMs で後ろの組の応答を返す', async () => {
	const g1 = await group('G1', { behavior: 'silent' });
	const g2 = await group('G2', { behavior: 'resolve', delayMs: 0, answer: '192.0.2.2' });
	const t0 = Date.now();
	const r = await resolveRace(q(), [g1, g2], opts);
	assert.equal(aOf(r.response), '192.0.2.2');
	assert.ok(Date.now() - t0 >= 290);
	assert.ok(Date.now() - t0 < 700);
});

test('先頭の組が解決したら待たずに返す', async () => {
	const g1 = await group('G1', { behavior: 'resolve', delayMs: 0, answer: '192.0.2.1' });
	const g2 = await group('G2', { behavior: 'silent' });
	const t0 = Date.now();
	const r = await resolveRace(q(), [g1, g2], opts);
	assert.equal(aOf(r.response), '192.0.2.1');
	assert.ok(Date.now() - t0 < 100);
});

test('priorityWaitMs が 0 なら、最初に解決した応答を返す（従来の動き）', async () => {
	const g1 = await group('G1', { behavior: 'resolve', delayMs: 100, answer: '192.0.2.1' });
	const g2 = await group('G2', { behavior: 'resolve', delayMs: 0, answer: '192.0.2.2' });
	const r = await resolveRace(q(), [g1, g2], { ...opts, priorityWaitMs: 0 });
	assert.equal(aOf(r.response), '192.0.2.2');
});
