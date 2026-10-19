import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamStats } from '../src/stats.ts';
import { resolveRace, type Attempt } from '../src/race.ts';
import { buildQuery, TYPE } from '../src/dns-message.ts';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.ts';

const started: FakeUpstream[] = [];
after(async () => { await Promise.all(started.map((u) => u.close())); });

test('上流ごとに送信数・応答数・勝ち数・平均応答時間を集計し、1 行にまとめる', () => {
	const s = new UpstreamStats();
	s.attempt({ upstream: 'google/primary', result: 'resolved', ms: 10 });
	s.attempt({ upstream: 'google/primary', result: 'nxdomain', ms: 30 });
	s.attempt({ upstream: 'quad9/primary', result: 'error', ms: 2000 });
	s.query('google/primary');
	s.query(undefined);
	assert.equal(
		s.summary(),
		'統計 問合せ 2 件 google/primary 送信 2 応答 2 勝ち 1 平均 20ms / quad9/primary 送信 1 応答 0 勝ち 0 平均 -',
	);
});

test('問合せが 0 件のときもその旨を 1 行で出す', () => {
	assert.equal(new UpstreamStats().summary(), '統計 問合せ 0 件');
});

test('中止した問合せ（ほかの上流が先に解決した）は送信数にだけ数え、平均に入れない', () => {
	const s = new UpstreamStats();
	s.attempt({ upstream: 'a/primary', result: 'aborted', ms: 5 });
	assert.match(s.summary(), /a\/primary 送信 1 応答 0 勝ち 0 平均 -/);
});

test('resolveRace は上流ごとの試行の結果を onAttempt で知らせる', async () => {
	const fast = await startFakeUpstream({ behavior: 'resolve', delayMs: 0 });
	const slow = await startFakeUpstream({ behavior: 'resolve', delayMs: 200 });
	started.push(fast, slow);
	const seen: Attempt[] = [];
	const g = (name: string, u: FakeUpstream) => ({
		name, primary: { host: u.host, port: u.port }, secondary: { host: u.host, port: u.port }, transport: 'auto' as const,
	});
	await resolveRace(buildQuery('a.example', TYPE.A, 1), [g('F', fast), g('S', slow)], {
		hedgeMs: 100, timeoutMs: 800, onAttempt: (a) => seen.push(a),
	});
	const f = seen.find((a) => a.upstream === 'F/primary');
	const s = seen.find((a) => a.upstream === 'S/primary');
	assert.equal(f?.result, 'resolved');
	assert.equal(s?.result, 'aborted');
});
