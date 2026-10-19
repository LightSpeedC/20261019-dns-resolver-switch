// DNS メッセージ（RFC 1035）の読み書き。中継に要る範囲だけを扱う
// ID の書き換え、質問部の読み取り、応答の分類、TTL の読み書き、UDP の大きさの上限

export const TYPE = {
	A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DNAME: 39, OPT: 41, HTTPS: 65, ANY: 255,
} as const;

export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;

/** 応答の分類。resolved 以外は「解決できない応答」で、ほかの上流を待つ */
export type Outcome = 'resolved' | 'nxdomain' | 'nodata' | 'fail';

export interface Question {
	/** 小文字・末尾の点なし */
	name: string;
	qtype: number;
	qclass: number;
	/** 質問部の直後の位置 */
	end: number;
}

interface RecordInfo {
	type: number;
	ttlOffset: number;
	start: number;
	end: number;
}

/** 本リゾルバが UDP で受けられると伝える大きさ（DNS Flag Day 2020 の推奨値） */
export const OWN_EDNS_SIZE = 1232;

const HEADER_LEN = 12;

function need(buf: Buffer, offset: number, length: number): void {
	if (offset + length > buf.length) throw new Error('DNS メッセージが途中で切れています');
}

export function encodeName(name: string): Buffer {
	const trimmed = name.replace(/\.$/, '');
	const parts: Buffer[] = [];
	for (const label of trimmed === '' ? [] : trimmed.split('.')) {
		const b = Buffer.from(label, 'latin1');
		if (b.length === 0 || b.length > 63) throw new Error(`ラベルの長さが不正です: ${name}`);
		parts.push(Buffer.from([b.length]), b);
	}
	parts.push(Buffer.from([0]));
	return Buffer.concat(parts);
}

/** 名前を読む。圧縮ポインタをたどる。end はポインタを含めた元の位置での直後 */
function readName(buf: Buffer, offset: number): { name: string; end: number } {
	const labels: string[] = [];
	let pos = offset;
	let end = -1;
	let jumps = 0;
	for (;;) {
		need(buf, pos, 1);
		const len = buf[pos];
		if ((len & 0xc0) === 0xc0) {
			need(buf, pos, 2);
			if (end < 0) end = pos + 2;
			// ポインタの輪で止まらないように、たどる回数に上限を置く
			if (++jumps > 64) throw new Error('名前の圧縮ポインタが多すぎます');
			pos = buf.readUInt16BE(pos) & 0x3fff;
			continue;
		}
		if (len & 0xc0) throw new Error('未対応のラベル形式です');
		if (len === 0) {
			if (end < 0) end = pos + 1;
			break;
		}
		need(buf, pos + 1, len);
		labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
		pos += 1 + len;
	}
	return { name: labels.join('.').toLowerCase(), end };
}

export function parseQuestion(buf: Buffer): Question {
	need(buf, 0, HEADER_LEN);
	if (buf.readUInt16BE(4) !== 1) throw new Error('質問がちょうど 1 件ではありません');
	const { name, end } = readName(buf, HEADER_LEN);
	need(buf, end, 4);
	return { name, qtype: buf.readUInt16BE(end), qclass: buf.readUInt16BE(end + 2), end: end + 4 };
}

/** 回答・権威・追加の各部のレコードを順に返す */
function records(buf: Buffer): { an: RecordInfo[]; rest: RecordInfo[] } {
	const q = parseQuestion(buf);
	const counts = [buf.readUInt16BE(6), buf.readUInt16BE(8) + buf.readUInt16BE(10)];
	const out: RecordInfo[][] = [[], []];
	let pos = q.end;
	counts.forEach((count, section) => {
		for (let i = 0; i < count; i++) {
			const { end } = readName(buf, pos);
			need(buf, end, 10);
			const rdlen = buf.readUInt16BE(end + 8);
			need(buf, end + 10, rdlen);
			out[section].push({ type: buf.readUInt16BE(end), ttlOffset: end + 4, start: pos, end: end + 10 + rdlen });
			pos = end + 10 + rdlen;
		}
	});
	return { an: out[0], rest: out[1] };
}

export interface QueryOptions {
	rd?: boolean;
	/** 指定すると EDNS の OPT を付け、UDP で受けられる大きさとして伝える */
	ednsSize?: number;
}

export function buildQuery(name: string, qtype: number, id: number, opt: QueryOptions = {}): Buffer {
	const header = Buffer.alloc(HEADER_LEN);
	header.writeUInt16BE(id, 0);
	header[2] = opt.rd === false ? 0 : 0x01;
	header.writeUInt16BE(1, 4);
	const tail = Buffer.alloc(4);
	tail.writeUInt16BE(qtype, 0);
	tail.writeUInt16BE(1, 2);
	const parts = [header, encodeName(name), tail];
	if (opt.ednsSize !== undefined) {
		header.writeUInt16BE(1, 10);
		const rr = Buffer.alloc(11);
		rr.writeUInt16BE(TYPE.OPT, 1);
		rr.writeUInt16BE(opt.ednsSize, 3);
		parts.push(rr);
	}
	return Buffer.concat(parts);
}

export function readId(buf: Buffer): number {
	return buf.readUInt16BE(0);
}

/** ID だけを差し替えた写しを返す（元は書き換えない） */
export function withId(buf: Buffer, id: number): Buffer {
	const copy = Buffer.from(buf);
	copy.writeUInt16BE(id, 0);
	return copy;
}

export function isResponse(buf: Buffer): boolean {
	return buf.length >= HEADER_LEN && (buf[2] & 0x80) !== 0;
}

export function rcodeOf(buf: Buffer): number {
	return buf[3] & 0x0f;
}

/**
 * 応答を分類する。上流ごとに担当する範囲が違うため、NXDOMAIN と回答なしの NOERROR は
 * 「その上流では解決できなかった」と読み、確定した否定とはみなさない（判断は race 側）
 */
export function classify(resp: Buffer): Outcome {
	try {
		if (!isResponse(resp)) return 'fail';
		const rcode = rcodeOf(resp);
		if (rcode === RCODE.NXDOMAIN) return 'nxdomain';
		if (rcode !== RCODE.NOERROR) return 'fail';
		const q = parseQuestion(resp);
		const { an } = records(resp);
		const hit = an.some((r) => r.type === q.qtype || r.type === TYPE.CNAME || r.type === TYPE.DNAME || q.qtype === TYPE.ANY);
		return hit ? 'resolved' : 'nodata';
	} catch {
		return 'fail';
	}
}

/** OPT を除いたレコードの TTL の最小値。レコードが無ければ null */
export function minTtl(resp: Buffer): number | null {
	const { an, rest } = records(resp);
	let min: number | null = null;
	for (const r of [...an, ...rest]) {
		if (r.type === TYPE.OPT) continue;
		const ttl = resp.readUInt32BE(r.ttlOffset);
		if (min === null || ttl < min) min = ttl;
	}
	return min;
}

/** すべての TTL を経過秒だけ減らした写しを返す（0 で止める） */
export function decrementTtls(resp: Buffer, seconds: number): Buffer {
	const copy = Buffer.from(resp);
	const { an, rest } = records(copy);
	for (const r of [...an, ...rest]) {
		if (r.type === TYPE.OPT) continue;
		copy.writeUInt32BE(Math.max(0, copy.readUInt32BE(r.ttlOffset) - Math.floor(seconds)), r.ttlOffset);
	}
	return copy;
}

/** 問合せと同じ ID・質問部で、回答の無い応答を作る */
function emptyResponse(query: Buffer, rcode: number, tc: boolean): Buffer {
	const q = parseQuestion(query);
	const header = Buffer.from(query.subarray(0, HEADER_LEN));
	// QR を立て、opcode と RD は問合せのまま残す
	header[2] = 0x80 | (query[2] & 0x79) | (tc ? 0x02 : 0);
	header[3] = 0x80 | rcode;
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(0, 6);
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(0, 10);
	return Buffer.concat([header, query.subarray(HEADER_LEN, q.end)]);
}

export function buildServfail(query: Buffer): Buffer {
	return emptyResponse(query, RCODE.SERVFAIL, false);
}

/** 問合せ元が UDP で受けられる大きさ。EDNS の OPT が無ければ 512 */
export function udpLimit(query: Buffer): number {
	try {
		const opt = records(query).rest.find((r) => r.type === TYPE.OPT);
		// OPT の class 欄（TTL の 2 つ前の 2 バイト）が大きさ
		if (opt) return Math.max(512, query.readUInt16BE(opt.ttlOffset - 2));
	} catch {
		// 読めなければ既定の 512 とする
	}
	return 512;
}

/**
 * 上限を超える応答は TC を立てて質問部だけにする。問合せ元は TCP で取り直す
 * 問合せに OPT があれば応答にも OPT を残す（RFC 6891。落とすと EDNS 非対応と誤解され、以後 512 バイトに下がる）
 */
export function truncateForUdp(resp: Buffer, limit: number, queryHasEdns = false): Buffer {
	if (resp.length <= limit) return resp;
	const truncated = emptyResponse(resp, rcodeOf(resp), true);
	truncated[2] |= resp[2] & 0x04;
	if (!queryHasEdns) return truncated;
	let opt: Buffer | null = null;
	try {
		const r = records(resp).rest.find((x) => x.type === TYPE.OPT);
		if (r) opt = resp.subarray(r.start, r.end);
	} catch {
		// 読めない応答なら自分の OPT を付ける
	}
	if (!opt) {
		opt = Buffer.alloc(11);
		opt.writeUInt16BE(TYPE.OPT, 1);
		opt.writeUInt16BE(OWN_EDNS_SIZE, 3);
	}
	truncated.writeUInt16BE(1, 10);
	return Buffer.concat([truncated, opt]);
}

/** 問合せに EDNS の OPT が付いているか */
export function hasEdns(query: Buffer): boolean {
	try {
		return records(query).rest.some((r) => r.type === TYPE.OPT);
	} catch {
		return false;
	}
}

const TYPE_NAMES = new Map<number, string>(Object.entries(TYPE).map(([k, v]) => [v, k]));

export function typeName(qtype: number): string {
	return TYPE_NAMES.get(qtype) ?? `TYPE${qtype}`;
}
