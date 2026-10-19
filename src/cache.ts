// 解決できた応答だけを TTL のあいだ持つ。件数を超えたら最も長く使われていないものから捨てる
// 否定応答は持たない（担当の上流が一時的に落ちていただけの場合に、否定を返し続けないため）
import { classify, decrementTtls, minTtl, parseQuestion, readId, withId } from './dns-message.ts';

interface Entry {
	response: Buffer;
	storedAt: number;
	expiresAt: number;
}

export interface CacheOptions {
	maxEntries: number;
	now?: () => number;
}

/** TTL が長すぎる応答も 1 日で手放す */
const MAX_TTL_SECONDS = 86400;

export class DnsCache {
	private readonly entries = new Map<string, Entry>();
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(opt: CacheOptions) {
		this.maxEntries = opt.maxEntries;
		this.now = opt.now ?? Date.now;
	}

	private key(query: Buffer): string {
		const q = parseQuestion(query);
		return `${q.name}|${q.qtype}|${q.qclass}`;
	}

	get(query: Buffer): Buffer | null {
		const key = this.key(query);
		const e = this.entries.get(key);
		if (!e) return null;
		const now = this.now();
		if (now >= e.expiresAt) {
			this.entries.delete(key);
			return null;
		}
		// 使った項目を末尾へ移し、捨てる順を後ろにする
		this.entries.delete(key);
		this.entries.set(key, e);
		return withId(decrementTtls(e.response, (now - e.storedAt) / 1000), readId(query));
	}

	set(query: Buffer, response: Buffer): void {
		if (classify(response) !== 'resolved') return;
		const ttl = Math.min(minTtl(response) ?? 0, MAX_TTL_SECONDS);
		if (ttl <= 0) return;
		const key = this.key(query);
		const now = this.now();
		this.entries.delete(key);
		this.entries.set(key, { response, storedAt: now, expiresAt: now + ttl * 1000 });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	get size(): number {
		return this.entries.size;
	}
}
