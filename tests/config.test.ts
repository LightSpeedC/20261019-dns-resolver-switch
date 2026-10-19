import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseAddress, DEFAULT_CONFIG } from '../src/config.ts';

test('上流のアドレスはポートを省くと 53 になる（IPv4・IPv6 とも）', () => {
	assert.deepEqual(parseAddress('192.0.2.1'), { host: '192.0.2.1', port: 53 });
	assert.deepEqual(parseAddress('192.0.2.1:5300'), { host: '192.0.2.1', port: 5300 });
	assert.deepEqual(parseAddress('[2001:db8::1]:5300'), { host: '2001:db8::1', port: 5300 });
	assert.deepEqual(parseAddress('2001:db8::1'), { host: '2001:db8::1', port: 53 });
});

test('上流はホスト名ではなく IP アドレスで持つ（ホスト名は起動時に例外）', () => {
	assert.throws(() => parseAddress('dns.example'));
});

test('既定の設定は primary / secondary の組を 3 つ持つ', () => {
	const c = parseConfig({});
	assert.equal(c.upstreams.length, 3);
	assert.ok(c.upstreams.every((g) => g.primary.port === 53 && g.secondary.port === 53));
	assert.equal(DEFAULT_CONFIG.upstreams.length, 3);
});

test('指定した項目だけを既定値に上書きする', () => {
	const c = parseConfig({ listen: { port: 5353 }, hedgeMs: 50 });
	assert.equal(c.listen.port, 5353);
	assert.equal(c.listen.host, DEFAULT_CONFIG.listen.host);
	assert.equal(c.hedgeMs, 50);
	assert.equal(c.timeoutMs, DEFAULT_CONFIG.timeoutMs);
});

test('統計をログへ出す間隔の既定は 10 分、0 で止められる', () => {
	assert.equal(parseConfig({}).statsIntervalMs, 600_000);
	assert.equal(parseConfig({ statsIntervalMs: 0 }).statsIntervalMs, 0);
	assert.throws(() => parseConfig({ statsIntervalMs: -1 }));
});

test('上流の組が 0 件・待ち時間の逆転は起動時に例外にする', () => {
	assert.throws(() => parseConfig({ upstreams: [] }));
	assert.throws(() => parseConfig({ hedgeMs: 3000, timeoutMs: 1000 }));
});
