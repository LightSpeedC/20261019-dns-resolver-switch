import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildQuery, parseQuestion, classify, readId, withId, minTtl, decrementTtls,
	buildServfail, udpLimit, truncateForUdp, RCODE, TYPE,
} from '../src/dns-message.ts';
import { buildAnswer } from './helpers/fake-upstream.ts';

test('問合せを組み立てて質問部を読み戻せる（名前は小文字・末尾の点なし）', () => {
	const q = buildQuery('WWW.Example.com.', TYPE.A, 0x1234);
	const p = parseQuestion(q);
	assert.equal(p.name, 'www.example.com');
	assert.equal(p.qtype, TYPE.A);
	assert.equal(p.qclass, 1);
	assert.equal(readId(q), 0x1234);
});

test('回答部に問い合わせた型があれば resolved', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	assert.equal(classify(buildAnswer(q, { behavior: 'resolve' }, true)), 'resolved');
});

test('担当外の返事（NXDOMAIN・回答なしの NOERROR）は解決できない応答として区別する', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	assert.equal(classify(buildAnswer(q, { behavior: 'nxdomain' }, true)), 'nxdomain');
	assert.equal(classify(buildAnswer(q, { behavior: 'nodata' }, true)), 'nodata');
	assert.equal(classify(buildAnswer(q, { behavior: 'servfail' }, true)), 'fail');
	assert.equal(classify(buildAnswer(q, { behavior: 'refused' }, true)), 'fail');
});

test('withId は元のバッファを書き換えずに ID だけ差し替える', () => {
	const q = buildQuery('a.example', TYPE.A, 7);
	const r = withId(q, 9);
	assert.equal(readId(r), 9);
	assert.equal(readId(q), 7);
});

test('TTL の最小値を読み、経過秒だけ減らせる', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	const r = buildAnswer(q, { behavior: 'resolve', ttl: 120 }, true);
	assert.equal(minTtl(r), 120);
	assert.equal(minTtl(decrementTtls(r, 20)), 100);
	assert.equal(minTtl(decrementTtls(r, 500)), 0);
});

test('SERVFAIL は問合せの ID と質問部を保ったまま作る', () => {
	const q = buildQuery('a.example', TYPE.A, 0x55aa);
	const r = buildServfail(q);
	assert.equal(readId(r), 0x55aa);
	assert.equal(r[3] & 0x0f, RCODE.SERVFAIL);
	assert.equal(parseQuestion(r).name, 'a.example');
	assert.equal(r[2] & 0x80, 0x80);
});

test('EDNS が無い問合せの UDP 上限は 512、上限を超える応答は TC を立てて質問部だけにする', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	assert.equal(udpLimit(q), 512);
	const big = Buffer.concat([buildAnswer(q, { behavior: 'resolve' }, true), Buffer.alloc(600)]);
	const t = truncateForUdp(big, 512);
	assert.equal(t[2] & 0x02, 0x02);
	assert.equal(t.readUInt16BE(6), 0);
	assert.ok(t.length <= 512);
});

test('EDNS の OPT があればその大きさを UDP 上限にする', () => {
	const q = buildQuery('a.example', TYPE.A, 1, { ednsSize: 1232 });
	assert.equal(udpLimit(q), 1232);
});

test('壊れたメッセージは例外にする（短すぎる・名前が範囲外）', () => {
	assert.throws(() => parseQuestion(Buffer.alloc(5)));
	const bad = Buffer.alloc(14);
	bad.writeUInt16BE(1, 4);
	bad[12] = 40;
	assert.throws(() => parseQuestion(bad));
});
