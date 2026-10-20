import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { parseConfig, parseAddress, DEFAULT_CONFIG, ensureConfigFile, loadConfig } from '../src/config.ts';

const tmpRoot = path.join(import.meta.dirname, '..', 'tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const workDir = fs.mkdtempSync(path.join(tmpRoot, 'config-test-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test('実ファイルが無ければテンプレートから写し、写したことを返す（2 回目は写さない）', () => {
	const template = path.join(workDir, 'resolver.example.json');
	const actual = path.join(workDir, '_resolver.json');
	fs.writeFileSync(template, JSON.stringify({ hedgeMs: 123 }));
	assert.equal(ensureConfigFile(actual, template), true);
	assert.equal(loadConfig(actual).hedgeMs, 123);
	// 実ファイルを書き換えたら、それが残る（テンプレートで上書きしない）
	fs.writeFileSync(actual, JSON.stringify({ hedgeMs: 456 }));
	assert.equal(ensureConfigFile(actual, template), false);
	assert.equal(loadConfig(actual).hedgeMs, 456);
});

test('テンプレートも無ければ例外にする', () => {
	assert.throws(() => ensureConfigFile(path.join(workDir, 'none.json'), path.join(workDir, 'none.example.json')), /テンプレート/);
});

test('リポジトリのテンプレートは読める設定になっている', () => {
	const c = loadConfig(path.join(import.meta.dirname, '..', 'config', 'resolver.example.json'));
	assert.equal(c.upstreams.length, 3);
});

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

test('組ごとの transport は既定が auto、udp・tcp で決め打ちでき、それ以外は例外にする', () => {
	assert.ok(parseConfig({}).upstreams.every((g) => g.transport === 'auto'));
	const c = parseConfig({ upstreams: [{ primary: '192.0.2.1', secondary: '192.0.2.2', transport: 'tcp' }] });
	assert.equal(c.upstreams[0].transport, 'tcp');
	assert.throws(() => parseConfig({ upstreams: [{ primary: '192.0.2.1', secondary: '192.0.2.2', transport: 'quic' }] }));
});

test('上流の組が 0 件・待ち時間の逆転は起動時に例外にする', () => {
	assert.throws(() => parseConfig({ upstreams: [] }));
	assert.throws(() => parseConfig({ hedgeMs: 3000, timeoutMs: 1000 }));
});
