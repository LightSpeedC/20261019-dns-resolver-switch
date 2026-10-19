// 送信元の許可リスト。サブネット（CIDR）を複数並べ、どれかに入れば許可する
import net from 'node:net';

interface Subnet {
	bytes: Uint8Array;
	prefix: number;
}

function v4Bytes(addr: string): Uint8Array {
	return Uint8Array.from(addr.split('.').map(Number));
}

function v6Bytes(addr: string): Uint8Array {
	const out = new Uint8Array(16);
	let text = addr;
	let v4: Uint8Array | null = null;
	const lastColon = text.lastIndexOf(':');
	if (text.slice(lastColon + 1).includes('.')) {
		// 末尾に IPv4 を埋め込んだ形（::ffff:192.0.2.1）は、2 群ぶんの 0 に置き換えて後で書き込む
		v4 = v4Bytes(text.slice(lastColon + 1));
		text = text.slice(0, lastColon + 1) + '0:0';
	}
	const [head, rest] = text.split('::');
	const h = head ? head.split(':') : [];
	const r = rest === undefined ? [] : rest ? rest.split(':') : [];
	const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill('0'), ...r];
	groups.forEach((g, i) => {
		const v = parseInt(g, 16);
		out[i * 2] = v >> 8;
		out[i * 2 + 1] = v & 0xff;
	});
	if (v4) out.set(v4, 12);
	return out;
}

/** アドレスをバイト列にする。IPv4 射影の IPv6 は IPv4 として扱う */
function toBytes(addr: string): Uint8Array | null {
	if (net.isIPv4(addr)) return v4Bytes(addr);
	if (!net.isIPv6(addr)) return null;
	const b = v6Bytes(addr.replace(/%.*$/, ''));
	const mapped = b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
	return mapped ? b.slice(12) : b;
}

function parseSubnet(text: string): Subnet {
	const [addr, bits] = text.split('/');
	const bytes = toBytes(addr);
	if (!bytes) throw new Error(`許可リストのアドレスが不正です: ${text}`);
	const max = bytes.length * 8;
	const prefix = bits === undefined ? max : Number(bits);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
		throw new Error(`許可リストのビット長が不正です: ${text}`);
	}
	return { bytes, prefix };
}

function contains(s: Subnet, b: Uint8Array): boolean {
	if (s.bytes.length !== b.length) return false;
	const full = Math.floor(s.prefix / 8);
	for (let i = 0; i < full; i++) if (s.bytes[i] !== b[i]) return false;
	const rem = s.prefix % 8;
	if (rem === 0) return true;
	const mask = (0xff << (8 - rem)) & 0xff;
	return (s.bytes[full] & mask) === (b[full] & mask);
}

export function buildAllowList(list: string[]): (addr: string) => boolean {
	const subnets = list.map(parseSubnet);
	return (addr: string) => {
		const b = toBytes(addr);
		return b !== null && subnets.some((s) => contains(s, b));
	};
}
