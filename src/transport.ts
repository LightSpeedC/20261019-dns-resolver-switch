// 上流ごとの問合せ方式（UDP / TCP）。UDP に答えない上流は TCP 専用にして、UDP の待ちを省く
// 起動時に確かめ、動いている間も UDP の応答の無い試行が続いたら確かめ直す。TCP 専用の上流も定期的に UDP を確かめ直す
import { randomInt } from 'node:crypto';
import type { Address, TransportSetting } from './config.ts';
import { buildQuery, TYPE } from './dns-message.ts';
import type { Logger } from './log.ts';
import { queryTcp, queryUdp, type Sender } from './upstream.ts';

export type Transport = 'udp' | 'tcp';

export interface TransportOptions {
	/** 確かめる問合せ 1 回の期限（UDP・TCP それぞれ） */
	probeTimeoutMs: number;
	/** UDP の応答の無い試行がこの回数続いたら確かめ直す */
	failThreshold: number;
	/** TCP 専用の上流の UDP を確かめ直す間隔 */
	recheckMs: number;
	/** 同じ上流を確かめ直す最短の間隔（ほかの上流に負けて打ち切られただけの試行でも数えるため、確かめ過ぎを抑える） */
	minProbeGapMs: number;
}

export const DEFAULT_TRANSPORT_OPTIONS: TransportOptions = {
	probeTimeoutMs: 1500,
	failThreshold: 5,
	recheckMs: 600_000,
	minProbeGapMs: 60_000,
};

interface State {
	addr: Address;
	setting: TransportSetting;
	mode: Transport;
	udpFails: number;
	lastProbeAt: number;
	probing: Promise<unknown> | null;
}

function keyOf(a: Address): string {
	return `${a.host}:${a.port}`;
}

export class TransportModes {
	private readonly states = new Map<string, State>();
	private readonly running = new Set<Promise<unknown>>();
	private readonly opt: TransportOptions;
	private readonly log: Logger;
	private timer: NodeJS.Timeout | null = null;

	constructor(opt: TransportOptions, log: Logger) {
		this.opt = opt;
		this.log = log;
	}

	/** 上流を登録する。同じアドレスを 2 回登録したら先の設定を残す */
	watch(addr: Address, setting: TransportSetting): void {
		if (this.states.has(keyOf(addr))) return;
		this.states.set(keyOf(addr), {
			addr, setting, mode: setting === 'tcp' ? 'tcp' : 'udp', udpFails: 0, lastProbeAt: -Infinity, probing: null,
		});
	}

	mode(addr: Address): Transport {
		return this.states.get(keyOf(addr))?.mode ?? 'udp';
	}

	force(addr: Address, mode: Transport): void {
		const s = this.states.get(keyOf(addr));
		if (s) s.mode = mode;
	}

	/** どんな応答（REFUSED 等を含む）でも返れば、その方式は使えるとみなす */
	private async reachable(addr: Address, transport: Transport): Promise<boolean> {
		const query = buildQuery('.', TYPE.NS, randomInt(0x10000), { rd: false });
		try {
			await (transport === 'udp' ? queryUdp : queryTcp)(addr, query, AbortSignal.timeout(this.opt.probeTimeoutMs));
			return true;
		} catch {
			return false;
		}
	}

	/** 確かめて方式を決める。決め打ち（udp / tcp）の上流は確かめない。どちらも返らなければ方式を変えない */
	async probe(addr: Address): Promise<Transport | 'unknown'> {
		const s = this.states.get(keyOf(addr));
		if (!s || s.setting !== 'auto') return this.mode(addr);
		s.lastProbeAt = Date.now();
		s.udpFails = 0;
		const result: Transport | 'unknown' = (await this.reachable(addr, 'udp')) ? 'udp'
			: (await this.reachable(addr, 'tcp')) ? 'tcp' : 'unknown';
		if (result === 'unknown') {
			this.log('WARN', `上流 ${keyOf(addr)} は UDP にも TCP にも答えません（${s.mode} のまま）`);
		} else if (result !== s.mode) {
			this.log('INFO', `上流 ${keyOf(addr)} を ${result === 'tcp' ? 'TCP 専用' : 'UDP'} に切り替えました`);
			s.mode = result;
		}
		return result;
	}

	private track(p: Promise<unknown>): void {
		this.running.add(p);
		p.finally(() => this.running.delete(p));
	}

	async probeAll(): Promise<void> {
		await Promise.all([...this.states.values()].map((s) => this.probe(s.addr)));
	}

	async recheckTcp(): Promise<void> {
		await Promise.all([...this.states.values()].filter((s) => s.mode === 'tcp').map((s) => this.probe(s.addr)));
	}

	/** 確かめ直しが走っていれば、終わるまで待つ */
	async idle(): Promise<void> {
		while (this.running.size) await Promise.all([...this.running]);
	}

	private noteUdpFailure(addr: Address): void {
		const s = this.states.get(keyOf(addr));
		if (!s || s.setting !== 'auto' || s.probing) return;
		s.udpFails++;
		if (s.udpFails < this.opt.failThreshold || Date.now() - s.lastProbeAt < this.opt.minProbeGapMs) return;
		const p = this.probe(addr).finally(() => { s.probing = null; });
		s.probing = p;
		this.track(p);
	}

	/** 上流へ送る。TCP 専用なら TCP だけ、それ以外は UDP で送り、TC が立っていれば TCP で取り直す */
	readonly send: Sender = async (addr, query, signal) => {
		if (this.mode(addr) === 'tcp') return queryTcp(addr, query, signal);
		let resp: Buffer;
		try {
			resp = await queryUdp(addr, query, signal);
		} catch (err) {
			this.noteUdpFailure(addr);
			throw err;
		}
		const s = this.states.get(keyOf(addr));
		if (s) s.udpFails = 0;
		if ((resp[2] & 0x02) === 0) return resp;
		return queryTcp(addr, query, signal);
	};

	start(): void {
		this.timer = setInterval(() => this.track(this.recheckTcp()), this.opt.recheckMs);
		this.timer.unref();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.idle();
	}
}
