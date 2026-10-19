import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAllowList } from '../src/cidr.ts';

test('複数のサブネットのどれかに入る送信元だけを許可する', () => {
	const allow = buildAllowList(['127.0.0.0/8', '192.0.2.0/24']);
	assert.equal(allow('127.0.0.1'), true);
	assert.equal(allow('192.0.2.200'), true);
	assert.equal(allow('192.0.3.1'), false);
	assert.equal(allow('198.51.100.1'), false);
});

test('IPv4 射影の IPv6 表記（::ffff:a.b.c.d）も IPv4 として照合する', () => {
	const allow = buildAllowList(['192.0.2.0/24']);
	assert.equal(allow('::ffff:192.0.2.5'), true);
});

test('IPv6 のサブネットも照合できる', () => {
	const allow = buildAllowList(['::1/128', '2001:db8::/32']);
	assert.equal(allow('::1'), true);
	assert.equal(allow('2001:db8:1::5'), true);
	assert.equal(allow('2001:db9::1'), false);
	assert.equal(allow('127.0.0.1'), false);
});

test('ビット長を省いたアドレスは 1 件だけを許可する', () => {
	const allow = buildAllowList(['192.0.2.7']);
	assert.equal(allow('192.0.2.7'), true);
	assert.equal(allow('192.0.2.8'), false);
});

test('書式の誤りは起動時に例外にする', () => {
	assert.throws(() => buildAllowList(['192.0.2.0/33']));
	assert.throws(() => buildAllowList(['example.com/24']));
});
