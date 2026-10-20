// 複数の上流の組へ同時に問い合わせ、解決できた応答を返す
// 上流ごとに担当する範囲が違うため、否定の応答はすぐには採用せず、全組が解決できなかったときだけ返す
// 組の並び順を優先順位にする（i261020-03）。後ろの組が先に解決したら候補として持ち、
// 前の組がすべて「解決できないと決まる」か、候補を持ってから priorityWaitMs たつまで待つ
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
	/** 後ろの組が先に解決したとき、前の組を待つ上限。0 または省略なら、最初に解決した応答を返す */
	priorityWaitMs?: number;
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
		const groupPending = new Map<Group, number>(groups.map((g) => [g, 0]));
		const resolvedGroups = new Set<Group>();
		const waitMs = opt.priorityWaitMs ?? 0;
		let candidate: { index: number; response: Buffer; winner: string } | null = null;

		// 解決できないと決まった組（secondary まで送り、どれも返し終え、解決しなかった）
		const concluded = (g: Group) => secondaryStarted.has(g) && groupPending.get(g) === 0 && !resolvedGroups.has(g);

		const finishCandidate = () => {
			if (candidate) finish({ response: withId(candidate.response, id), outcome: 'resolved', winner: candidate.winner });
		};

		// 候補より前の組がすべて決着していれば、候補を返す
		const tryCandidate = () => {
			if (candidate && groups.slice(0, candidate.index).every(concluded)) finishCandidate();
		};

		const onResolved = (g: Group, response: Buffer, winner: string) => {
			resolvedGroups.add(g);
			const index = groups.indexOf(g);
			if (candidate && candidate.index <= index) return;
			const first = candidate === null;
			candidate = { index, response, winner };
			if (waitMs <= 0) return finishCandidate();
			if (first) timers.push(setTimeout(finishCandidate, waitMs));
			tryCandidate();
		};

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
			if (candidate) return finishCandidate();
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
			groupPending.set(g, (groupPending.get(g) ?? 0) + 1);
			const settle = () => {
				pending--;
				groupPending.set(g, (groupPending.get(g) ?? 1) - 1);
			};
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
					settle();
					const outcome = classify(response);
					report(outcome);
					if (finished) return;
					if (outcome === 'resolved') return onResolved(g, response, winner);
					const rank = NEGATIVE_RANK[outcome];
					if (!best || rank > best.rank) best = { rank, outcome, response, winner };
					// primary が解決できなければ、待ち時間を待たずに secondary へ送る
					start(g, 'secondary');
					tryCandidate();
					checkAllDone();
				},
				() => {
					settle();
					report(finished ? 'aborted' : 'error');
					if (finished) return;
					start(g, 'secondary');
					tryCandidate();
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
