// テスト用の偽の上流 DNS。実ネットに出ずに、遅延・否定応答・無応答・切り詰めを再現する
import dgram from 'node:dgram';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { encodeName, parseQuestion, TYPE } from '../../src/dns-message.ts';

export type Behavior = 'resolve' | 'nxdomain' | 'nodata' | 'servfail' | 'refused' | 'silent' | 'truncate';

export interface FakeUpstream {
	host: string;
	port: number;
	udpHits: number;
	tcpHits: number;
	close(): Promise<void>;
}

export interface FakeOptions {
	behavior: Behavior;
	delayMs?: number;
	/** resolve のときに返す A レコードのアドレス */
	answer?: string;
	ttl?: number;
}

/** 問合せに対する応答を組み立てる。full=false のときは TC を立てて回答部を空にする */
export function buildAnswer(query: Buffer, opt: FakeOptions, full: boolean): Buffer {
	const q = parseQuestion(query);
	const header = Buffer.alloc(12);
	query.copy(header, 0, 0, 2);
	const rd = query[2] & 0x01;
	let rcode = 0;
	if (opt.behavior === 'nxdomain') rcode = 3;
	if (opt.behavior === 'servfail') rcode = 2;
	if (opt.behavior === 'refused') rcode = 5;
	const withAnswer = (opt.behavior === 'resolve' || opt.behavior === 'truncate') && full && q.qtype === TYPE.A;
	const tc = opt.behavior === 'truncate' && !full ? 0x02 : 0;
	header[2] = 0x80 | tc | rd;
	header[3] = 0x80 | rcode;
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(withAnswer ? 1 : 0, 6);
	const question = query.subarray(12, q.end);
	if (!withAnswer) return Buffer.concat([header, question]);
	const rr = Buffer.alloc(14);
	rr.writeUInt16BE(0xc00c, 0);
	rr.writeUInt16BE(TYPE.A, 2);
	rr.writeUInt16BE(1, 4);
	rr.writeUInt32BE(opt.ttl ?? 300, 6);
	rr.writeUInt16BE(4, 10);
	const addr = Buffer.from((opt.answer ?? '192.0.2.1').split('.').map(Number));
	return Buffer.concat([header, question, rr.subarray(0, 12), addr]);
}

export async function startFakeUpstream(opt: FakeOptions): Promise<FakeUpstream> {
	const udp = dgram.createSocket('udp4');
	const tcp = net.createServer();
	const timers = new Set<NodeJS.Timeout>();
	const later = (fn: () => void) => {
		const t = setTimeout(() => { timers.delete(t); fn(); }, opt.delayMs ?? 0);
		timers.add(t);
	};
	const self: FakeUpstream = {
		host: '127.0.0.1',
		port: 0,
		udpHits: 0,
		tcpHits: 0,
		close: async () => {
			for (const t of timers) clearTimeout(t);
			await new Promise<void>((r) => udp.close(() => r()));
			await new Promise<void>((r) => tcp.close(() => r()));
		},
	};
	udp.on('message', (msg, rinfo) => {
		self.udpHits++;
		if (opt.behavior === 'silent') return;
		later(() => udp.send(buildAnswer(msg, opt, opt.behavior !== 'truncate'), rinfo.port, rinfo.address));
	});
	tcp.on('connection', (sock) => {
		let buf = Buffer.alloc(0);
		sock.on('error', () => {});
		sock.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
				const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
				buf = buf.subarray(2 + msg.length);
				self.tcpHits++;
				if (opt.behavior === 'silent') continue;
				later(() => {
					const res = buildAnswer(msg, opt, true);
					const len = Buffer.alloc(2);
					len.writeUInt16BE(res.length);
					sock.end(Buffer.concat([len, res]));
				});
			}
		});
	});
	await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
	self.port = (tcp.address() as AddressInfo).port;
	await new Promise<void>((r) => udp.bind(self.port, '127.0.0.1', () => r()));
	return self;
}

export { encodeName };
