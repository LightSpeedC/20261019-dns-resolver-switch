import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const root = path.join(import.meta.dirname, '..');
const main = path.join(root, 'src', 'main.ts');
const tmpRoot = path.join(root, 'tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const workDir = fs.mkdtempSync(path.join(tmpRoot, 'main-test-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

// 起動時の確かめで実ネットに出ないよう、上流は届かない宛先に決め打ちする
const configPath = path.join(workDir, 'resolver.json');
fs.writeFileSync(configPath, JSON.stringify({
	listen: { host: '127.0.0.1', port: 0 },
	allow: ['127.0.0.0/8'],
	upstreams: [{ name: 'X', primary: '127.0.0.1:9', secondary: '127.0.0.1:9', transport: 'udp' }],
}));

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [main, '--config', configPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (d) => { stderr += d; });
		child.stdout.resume();
		const t = setTimeout(() => child.kill(), 10_000);
		child.on('exit', (code) => { clearTimeout(t); resolve({ code, stderr }); });
	});
}

test('待ち受けるポートが使用中なら、ポートを含む日本語の記録を出して終了コード 2 で終わる', async () => {
	const blocker = net.createServer();
	await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
	const port = (blocker.address() as AddressInfo).port;
	try {
		const r = await run(['--port', String(port)]);
		assert.equal(r.code, 2);
		assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
		assert.match(r.stderr, /使用中/);
	} finally {
		await new Promise<void>((r) => blocker.close(() => r()));
	}
});

test('設定の誤りは、何が誤りかを記録して終了コード 2 で終わる', async () => {
	const r = await run(['--port', 'abc']);
	assert.equal(r.code, 2);
	assert.match(r.stderr, /ポート/);
});
