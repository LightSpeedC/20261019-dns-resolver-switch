// 上流 1 台への問合せ。UDP で送り、TC が立っていたら TCP で取り直す
import dgram from 'node:dgram';
import net from 'node:net';
import { randomInt } from 'node:crypto';
import type { Address } from './config.ts';
import { isResponse, parseQuestion, readId, withId } from './dns-message.ts';

export type Sender = (addr: Address, query: Buffer, signal: AbortSignal) => Promise<Buffer>;

function aborted(): Error {
	return new Error('中止しました');
}

/** 応答が送った問合せに対するものか（ID と質問部が一致するか） */
function matches(resp: Buffer, id: number, query: Buffer): boolean {
	if (!isResponse(resp) || readId(resp) !== id) return false;
	try {
		const a = parseQuestion(resp);
		const b = parseQuestion(query);
		return a.name === b.name && a.qtype === b.qtype && a.qclass === b.qclass;
	} catch {
		return false;
	}
}

/** 上流ごとに ID を振り直す（なりすましの応答を受けにくくする）。返す応答の ID は元に戻す */
export function queryUdp(addr: Address, query: Buffer, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(aborted());
		const id = randomInt(0x10000);
		const sock = dgram.createSocket(net.isIPv6(addr.host) ? 'udp6' : 'udp4');
		const done = (fn: () => void) => {
			signal.removeEventListener('abort', onAbort);
			sock.close();
			fn();
		};
		const onAbort = () => done(() => reject(aborted()));
		signal.addEventListener('abort', onAbort);
		sock.on('error', (err) => done(() => reject(err)));
		sock.on('message', (msg, rinfo) => {
			if (rinfo.address !== addr.host || rinfo.port !== addr.port) return;
			if (!matches(msg, id, query)) return;
			done(() => resolve(withId(msg, readId(query))));
		});
		sock.send(withId(query, id), addr.port, addr.host);
	});
}

export function queryTcp(addr: Address, query: Buffer, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(aborted());
		const id = randomInt(0x10000);
		const sock = net.connect(addr.port, addr.host);
		let buf = Buffer.alloc(0);
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			sock.destroy();
			fn();
		};
		const onAbort = () => done(() => reject(aborted()));
		signal.addEventListener('abort', onAbort);
		sock.on('error', (err) => done(() => reject(err)));
		sock.on('close', () => done(() => reject(new Error('応答の前に接続が閉じました'))));
		sock.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
				buf = buf.subarray(2 + msg.length);
				if (matches(msg, id, query)) return done(() => resolve(withId(msg, readId(query))));
			}
		});
		const body = withId(query, id);
		const len = Buffer.alloc(2);
		len.writeUInt16BE(body.length);
		sock.write(Buffer.concat([len, body]));
	});
}

export const queryUpstream: Sender = async (addr, query, signal) => {
	const resp = await queryUdp(addr, query, signal);
	if ((resp[2] & 0x02) === 0) return resp;
	return queryTcp(addr, query, signal);
};
