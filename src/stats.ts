// 上流ごとの集計（送信数・応答数・勝ち数・平均応答時間）。起動中だけ持ち、ログへ 1 行で出す
import type { Attempt } from './race.ts';

interface Counter {
	sent: number;
	answered: number;
	wins: number;
	totalMs: number;
}

export class UpstreamStats {
	private readonly counters = new Map<string, Counter>();
	private queries = 0;

	private counter(upstream: string): Counter {
		let c = this.counters.get(upstream);
		if (!c) {
			c = { sent: 0, answered: 0, wins: 0, totalMs: 0 };
			this.counters.set(upstream, c);
		}
		return c;
	}

	/** 上流 1 台への試行 1 回。中止と失敗は応答時間に入れない */
	attempt(a: Attempt): void {
		const c = this.counter(a.upstream);
		c.sent++;
		if (a.result === 'aborted' || a.result === 'error') return;
		c.answered++;
		c.totalMs += a.ms;
	}

	/** 問合せ 1 件の終わり。winner は解決できた応答を採った上流（無ければ undefined） */
	query(winner: string | undefined): void {
		this.queries++;
		if (winner) this.counter(winner).wins++;
	}

	summary(): string {
		const parts = [...this.counters].map(([name, c]) => {
			const avg = c.answered ? `${Math.round(c.totalMs / c.answered)}ms` : '-';
			return `${name} 送信 ${c.sent} 応答 ${c.answered} 勝ち ${c.wins} 平均 ${avg}`;
		});
		return `統計 問合せ ${this.queries} 件${parts.length ? ' ' + parts.join(' / ') : ''}`;
	}
}
