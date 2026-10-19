// 複数の上流の組へ同時に問い合わせ、最初に解決できた応答を返す
// 上流ごとに担当する範囲が違うため、否定の応答はすぐには採用せず、全組が解決できなかったときだけ返す
import type { Group } from './config.ts';
import { buildServfail, classify, readId, withId, type Outcome } from './dns-message.ts';
import { queryUpstream, type Sender } from './upstream.ts';

/** 上流 1 台への試行の結果。aborted はほかの上流が先に決着したため打ち切ったもの */
export interface Attempt {
	upstream: string;
	result: Outcome | 'error' | 'aborted';
	ms: number;
}

export interface RaceOptions {
	hedgeMs: number;
	timeoutMs: number;
	onAttempt?: (a: Attempt) => void;
}

export interface RaceResult {
	response: Buffer;
	outcome: 'resolved' | 'nxdomain' | 'nodata' | 'servfail';
	/** 応答を採った上流（"組の名前/primary" の形）。SERVFAIL を作って返したときは無い */
	winner?: string;
	elapsedMs: number;
}

/** 否定の強さ。届いた中で最も強いものを返す */
const NEGATIVE_RANK = { nxdomain: 3, nodata: 2, fail: 1 } as const;

type Which = 'primary' | 'secondary';

export function resolveRace(query: Buffer, groups: Group[], opt: RaceOptions, send: Sender = queryUpstream): Promise<RaceResult> {
	return new Promise((resolve) => {
		const started = Date.now();
		const id = readId(query);
		const ac = new AbortController();
		const timers: NodeJS.Timeout[] = [];
		const secondaryStarted = new Set<Group>();
		const inFlight = new Set<(result: Attempt['result']) => void>();
		let pending = 0;
		let finished = false;
		let best: { rank: number; outcome: keyof typeof NEGATIVE_RANK; response: Buffer; winner: string } | null = null;

		const finish = (r: Omit<RaceResult, 'elapsedMs'>) => {
			if (finished) return;
			finished = true;
			// 打ち切る試行は、決着と同時に中止として知らせる（取り消しの知らせは決着より後に届くため）
			for (const report of [...inFlight]) report('aborted');
			ac.abort();
			for (const t of timers) clearTimeout(t);
			resolve({ ...r, elapsedMs: Date.now() - started });
		};

		const finishNegative = () => {
			if (best && best.outcome !== 'fail') {
				finish({ response: withId(best.response, id), outcome: best.outcome, winner: best.winner });
			} else {
				finish({ response: buildServfail(query), outcome: 'servfail' });
			}
		};

		// 全組の secondary まで送り終え、どれも返し終えたら、期限を待たずに否定を返す
		const checkAllDone = () => {
			if (pending === 0 && secondaryStarted.size === groups.length) finishNegative();
		};

		const start = (g: Group, which: Which) => {
			if (which === 'secondary') {
				if (secondaryStarted.has(g)) return;
				secondaryStarted.add(g);
			}
			const winner = `${g.name}/${which}`;
			pending++;
			const sentAt = Date.now();
			let reported = false;
			const report = (result: Attempt['result']) => {
				if (reported) return;
				reported = true;
				inFlight.delete(report);
				opt.onAttempt?.({ upstream: winner, result, ms: Date.now() - sentAt });
			};
			inFlight.add(report);
			send(g[which], query, ac.signal).then(
				(response) => {
					pending--;
					const outcome = classify(response);
					report(outcome);
					if (finished) return;
					if (outcome === 'resolved') return finish({ response: withId(response, id), outcome, winner });
					const rank = NEGATIVE_RANK[outcome];
					if (!best || rank > best.rank) best = { rank, outcome, response, winner };
					// primary が解決できなければ、待ち時間を待たずに secondary へ送る
					start(g, 'secondary');
					checkAllDone();
				},
				() => {
					pending--;
					report(finished ? 'aborted' : 'error');
					if (finished) return;
					start(g, 'secondary');
					checkAllDone();
				},
			);
		};

		for (const g of groups) {
			start(g, 'primary');
			timers.push(setTimeout(() => start(g, 'secondary'), opt.hedgeMs));
		}
		timers.push(setTimeout(finishNegative, opt.timeoutMs));
	});
}
