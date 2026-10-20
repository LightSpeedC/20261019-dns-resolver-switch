import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryLogLine } from '../src/query-log.ts';
import { answerSummary, buildQuery, encodeName, TYPE } from '../src/dns-message.ts';
import { buildAnswer } from './helpers/fake-upstream.ts';

/** 回答部に任意のレコードを並べた応答を作る */
function response(name: string, qtype: number, rrs: Array<{ type: number; rdata: Buffer }>): Buffer {
	const q = buildQuery(name, qtype, 1);
	const header = Buffer.from(q.subarray(0, 12));
	header[2] = 0x81;
	header[3] = 0x80;
	header.writeUInt16BE(rrs.length, 6);
	const parts = [header, q.subarray(12)];
	for (const rr of rrs) {
		const fixed = Buffer.alloc(12);
		fixed.writeUInt16BE(0xc00c, 0);
		fixed.writeUInt16BE(rr.type, 2);
		fixed.writeUInt16BE(1, 4);
		fixed.writeUInt32BE(60, 6);
		fixed.writeUInt16BE(rr.rdata.length, 10);
		parts.push(fixed, rr.rdata);
	}
	return Buffer.concat(parts);
}

const v4 = (a: string) => Buffer.from(a.split('.').map(Number));

test('回答の A・AAAA・CNAME を、並んだ順にカンマで並べる（IPv6 は短い表記）', () => {
	const aaaa = Buffer.alloc(16);
	aaaa.writeUInt16BE(0x2001, 0);
	aaaa.writeUInt16BE(0x0db8, 2);
	aaaa.writeUInt16BE(1, 14);
	const r = response('www.example', TYPE.A, [
		{ type: TYPE.CNAME, rdata: encodeName('Edge.Example.net') },
		{ type: TYPE.A, rdata: v4('192.0.2.1') },
		{ type: TYPE.AAAA, rdata: aaaa },
	]);
	assert.equal(answerSummary(r), 'CNAME edge.example.net, 192.0.2.1, 2001:db8::1');
});

test('回答が 8 件を超えたら 8 件までにして、残りの件数を書く', () => {
	const rrs = Array.from({ length: 10 }, (_, i) => ({ type: TYPE.A, rdata: v4(`192.0.2.${i + 1}`) }));
	const s = answerSummary(response('many.example', TYPE.A, rrs));
	assert.equal(s.split(', ').length, 9);
	assert.match(s, /192\.0\.2\.8, ほか 2 件$/);
});

test('A・AAAA・CNAME 以外の回答は型の名前だけを出す', () => {
	const r = response('mx.example', TYPE.MX, [{ type: TYPE.MX, rdata: Buffer.concat([Buffer.from([0, 10]), encodeName('mail.example')]) }]);
	assert.equal(answerSummary(r), 'MX');
});

const base = { transport: 'udp', from: '127.0.0.1', name: 'a.example', qtype: TYPE.A, ms: 7 };

test('解決できたら INFO の OK resolved で、上流と解決したアドレスを出す', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	const line = queryLogLine({ ...base, outcome: 'resolved', upstream: 'quad9/primary', response: buildAnswer(q, { behavior: 'resolve', answer: '192.0.2.5' }, true) });
	assert.equal(line.level, 'INFO');
	assert.equal(line.message, 'OK resolved udp 127.0.0.1 a.example A quad9/primary 7ms => 192.0.2.5');
});

test('キャッシュから返したら INFO の OK cached（結果の語は 8 文字の幅に揃える）', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	const line = queryLogLine({ ...base, outcome: 'cached', upstream: 'cache', ms: 0, response: buildAnswer(q, { behavior: 'resolve', answer: '192.0.2.5' }, true) });
	assert.equal(line.level, 'INFO');
	assert.equal(line.message, 'OK cached   udp 127.0.0.1 a.example A cache 0ms => 192.0.2.5');
});

test('名前が無ければ WARN の NG nxdomain、型のレコードが無ければ INFO の NG nodata（AAAA でよく起きるため）', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	const nx = queryLogLine({ ...base, outcome: 'nxdomain', upstream: 'quad9/primary', response: buildAnswer(q, { behavior: 'nxdomain' }, true) });
	assert.equal(nx.level, 'WARN');
	assert.equal(nx.message, 'NG nxdomain udp 127.0.0.1 a.example A quad9/primary 7ms');
	const nodata = queryLogLine({ ...base, outcome: 'nodata', upstream: 'quad9/primary', response: buildAnswer(q, { behavior: 'nodata' }, true) });
	assert.equal(nodata.level, 'INFO');
	assert.match(nodata.message, /^NG nodata   /);
});

test('どの上流も答えなければ ERROR の NG servfail', () => {
	const q = buildQuery('a.example', TYPE.A, 1);
	const line = queryLogLine({ ...base, outcome: 'servfail', upstream: undefined, ms: 2000, response: buildAnswer(q, { behavior: 'servfail' }, true) });
	assert.equal(line.level, 'ERROR');
	assert.equal(line.message, 'NG servfail udp 127.0.0.1 a.example A - 2000ms');
});
