import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DnsCache } from '../src/cache.ts';
import { buildQuery, minTtl, readId, TYPE } from '../src/dns-message.ts';
import { buildAnswer } from './helpers/fake-upstream.ts';

function clock(start = 0) {
	let t = start;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('解決できた応答を TTL のあいだ返し、ID は新しい問合せのものにする', () => {
	const c = clock();
	const cache = new DnsCache({ maxEntries: 10, now: c.now });
	const q = buildQuery('a.example', TYPE.A, 1);
	cache.set(q, buildAnswer(q, { behavior: 'resolve', ttl: 60 }, true));
	c.advance(10_000);
	const hit = cache.get(buildQuery('A.EXAMPLE', TYPE.A, 99));
	assert.ok(hit);
	assert.equal(readId(hit), 99);
	assert.equal(minTtl(hit), 50);
});

test('TTL が切れたら返さない', () => {
	const c = clock();
	const cache = new DnsCache({ maxEntries: 10, now: c.now });
	const q = buildQuery('a.example', TYPE.A, 1);
	cache.set(q, buildAnswer(q, { behavior: 'resolve', ttl: 5 }, true));
	c.advance(5_000);
	assert.equal(cache.get(q), null);
});

test('型が違えば別の項目として扱う', () => {
	const cache = new DnsCache({ maxEntries: 10, now: () => 0 });
	const q = buildQuery('a.example', TYPE.A, 1);
	cache.set(q, buildAnswer(q, { behavior: 'resolve' }, true));
	assert.equal(cache.get(buildQuery('a.example', TYPE.AAAA, 1)), null);
});

test('否定応答はキャッシュしない（担当の上流が一時的に落ちていただけの場合に否定を返し続けないため）', () => {
	const cache = new DnsCache({ maxEntries: 10, now: () => 0 });
	const q = buildQuery('a.example', TYPE.A, 1);
	cache.set(q, buildAnswer(q, { behavior: 'nxdomain' }, true));
	assert.equal(cache.get(q), null);
});

test('件数の上限を超えたら、最も長く使われていない項目から捨てる', () => {
	const cache = new DnsCache({ maxEntries: 2, now: () => 0 });
	const qa = buildQuery('a.example', TYPE.A, 1);
	const qb = buildQuery('b.example', TYPE.A, 1);
	const qc = buildQuery('c.example', TYPE.A, 1);
	cache.set(qa, buildAnswer(qa, { behavior: 'resolve' }, true));
	cache.set(qb, buildAnswer(qb, { behavior: 'resolve' }, true));
	cache.get(qa);
	cache.set(qc, buildAnswer(qc, { behavior: 'resolve' }, true));
	assert.ok(cache.get(qa));
	assert.equal(cache.get(qb), null);
	assert.ok(cache.get(qc));
});
