// 設定の読み込みと既定値。上流は IP アドレスで持ち、primary / secondary を 1 組にする
import fs from 'node:fs';
import net from 'node:net';
import { buildAllowList } from './cidr.ts';

export interface Address {
	host: string;
	port: number;
}

export interface Group {
	name: string;
	primary: Address;
	secondary: Address;
}

export interface Config {
	listen: Address;
	/** 受け付ける送信元のサブネット（CIDR） */
	allow: string[];
	/** primary が返さないとき、secondary にも送るまでの待ち時間 */
	hedgeMs: number;
	/** 1 件の問合せ全体の期限。過ぎたら届いた中で最も強い否定か SERVFAIL を返す */
	timeoutMs: number;
	cacheMaxEntries: number;
	/** 上流ごとの集計をログへ出す間隔。0 で止める（停止時には出す） */
	statsIntervalMs: number;
	upstreams: Group[];
}

interface RawGroup {
	name?: string;
	primary?: string;
	secondary?: string;
}

interface RawConfig {
	listen?: { host?: string; port?: number };
	allow?: string[];
	hedgeMs?: number;
	timeoutMs?: number;
	cacheMaxEntries?: number;
	statsIntervalMs?: number;
	upstreams?: RawGroup[];
}

const DEFAULT_RAW = {
	// LAN にも公開する（送信元は allow で絞る）。開発中は 53 とぶつけないよう高位ポートにする
	listen: { host: '0.0.0.0', port: 10053 },
	allow: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
	hedgeMs: 300,
	timeoutMs: 2000,
	cacheMaxEntries: 10000,
	statsIntervalMs: 600_000,
	upstreams: [
		{ name: 'google', primary: '8.8.8.8', secondary: '8.8.4.4' },
		{ name: 'cloudflare', primary: '1.1.1.1', secondary: '1.0.0.1' },
		{ name: 'quad9', primary: '9.9.9.9', secondary: '149.112.112.112' },
	],
};

function port(value: number, what: string): number {
	if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${what} のポートが不正です: ${value}`);
	return value;
}

/** "192.0.2.1"・"192.0.2.1:5300"・"2001:db8::1"・"[2001:db8::1]:5300" を読む。ポートを省くと 53 */
export function parseAddress(text: string): Address {
	let host = text;
	let p = 53;
	const bracket = /^\[(.+)\](?::(\d+))?$/.exec(text);
	if (bracket) {
		host = bracket[1];
		if (bracket[2]) p = Number(bracket[2]);
	} else if (!net.isIPv6(text) && text.includes(':')) {
		const i = text.lastIndexOf(':');
		host = text.slice(0, i);
		p = Number(text.slice(i + 1));
	}
	if (!net.isIP(host)) throw new Error(`上流は IP アドレスで指定してください: ${text}`);
	return { host, port: port(p, text) };
}

function positive(value: number, what: string): number {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${what} は正の数にしてください: ${value}`);
	return value;
}

function nonNegative(value: number, what: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${what} は 0 以上にしてください: ${value}`);
	return value;
}

export function parseConfig(input: unknown): Config {
	const raw = (input ?? {}) as RawConfig;
	const groups = raw.upstreams ?? DEFAULT_RAW.upstreams;
	if (!Array.isArray(groups) || groups.length === 0) throw new Error('上流の組が 1 つもありません');
	const config: Config = {
		listen: {
			host: raw.listen?.host ?? DEFAULT_RAW.listen.host,
			port: port(raw.listen?.port ?? DEFAULT_RAW.listen.port, 'listen'),
		},
		allow: raw.allow ?? DEFAULT_RAW.allow,
		hedgeMs: positive(raw.hedgeMs ?? DEFAULT_RAW.hedgeMs, 'hedgeMs'),
		timeoutMs: positive(raw.timeoutMs ?? DEFAULT_RAW.timeoutMs, 'timeoutMs'),
		cacheMaxEntries: positive(raw.cacheMaxEntries ?? DEFAULT_RAW.cacheMaxEntries, 'cacheMaxEntries'),
		statsIntervalMs: nonNegative(raw.statsIntervalMs ?? DEFAULT_RAW.statsIntervalMs, 'statsIntervalMs'),
		upstreams: groups.map((g, i) => {
			if (!g.primary || !g.secondary) throw new Error(`上流の組 ${i + 1} に primary と secondary を書いてください`);
			return { name: g.name ?? `group${i + 1}`, primary: parseAddress(g.primary), secondary: parseAddress(g.secondary) };
		}),
	};
	if (!net.isIP(config.listen.host)) throw new Error(`listen.host は IP アドレスにしてください: ${config.listen.host}`);
	if (config.hedgeMs >= config.timeoutMs) throw new Error('hedgeMs は timeoutMs より短くしてください');
	// 書式の誤りを起動時に見つける
	buildAllowList(config.allow);
	return config;
}

export function loadConfig(path: string): Config {
	return parseConfig(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export const DEFAULT_CONFIG: Config = parseConfig({});
