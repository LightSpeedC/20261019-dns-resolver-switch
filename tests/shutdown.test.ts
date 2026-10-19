import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installShutdown } from '../src/shutdown.ts';

// Windows ではテストから子プロセスへ SIGINT を送れない（kill は強制終了になる）ため、
// process の代わりの発信元に合図を出して確かめる
function harness(close: () => Promise<void>, forceMs = 1000) {
	const source = new EventEmitter();
	const exits: number[] = [];
	const lines: string[] = [];
	let exited!: () => void;
	const done = new Promise<void>((r) => { exited = r; });
	installShutdown({
		source,
		log: (level, message) => lines.push(`${level} ${message}`),
		close,
		exit: (code) => { exits.push(code); exited(); },
		forceMs,
		signals: ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'],
	});
	return { source, exits, lines, done };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
	test(`${signal} で後片付けを済ませてから終了コード 0 で終わる`, async () => {
		let closed = 0;
		const h = harness(async () => { closed++; });
		h.source.emit(signal);
		await h.done;
		assert.equal(closed, 1);
		assert.deepEqual(h.exits, [0]);
	});
}

test('2 回目の合図では後片付けを待たずに終わる', async () => {
	const h = harness(() => new Promise(() => {}), 10_000);
	h.source.emit('SIGINT');
	h.source.emit('SIGINT');
	await h.done;
	assert.deepEqual(h.exits, [0]);
	assert.ok(h.lines.some((l) => l.startsWith('WARN')));
});

test('後片付けが期限を超えたら強制的に終わる', async () => {
	const h = harness(() => new Promise(() => {}), 100);
	const t0 = Date.now();
	h.source.emit('SIGTERM');
	await h.done;
	assert.deepEqual(h.exits, [0]);
	assert.ok(Date.now() - t0 >= 95);
});

test('後片付けが失敗しても記録して終わる', async () => {
	const h = harness(async () => { throw new Error('閉じられない'); });
	h.source.emit('SIGINT');
	await h.done;
	assert.deepEqual(h.exits, [0]);
	assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('閉じられない')));
});

test('捕まえていない例外・拒否は ERROR を記録し、後片付けをして終了コード 1 で終わる', async () => {
	for (const event of ['uncaughtException', 'unhandledRejection']) {
		let closed = 0;
		const h = harness(async () => { closed++; });
		h.source.emit(event, new Error('想定外'));
		await h.done;
		assert.equal(closed, 1);
		assert.deepEqual(h.exits, [1]);
		assert.ok(h.lines.some((l) => l.startsWith('ERROR') && l.includes('想定外')));
	}
});
