// 問合せ 1 件のログの行。日時とレベルの直後に OK / NG と結果の語を置き、成功か失敗かを行の頭で見分けられるようにする
//   OK resolved / OK cached           … INFO
//   NG nodata                         … INFO（IPv4 だけの名前に AAAA を問うと普通に起きるため）
//   NG nxdomain                       … WARN
//   NG servfail                       … ERROR（どの上流も答えなかった・失敗した）
// 解決したら、末尾に => と回答（A・AAAA のアドレス、CNAME の行き先）を出す。上流ごとに違う値を返すことがあるため
import { answerSummary, typeName } from './dns-message.ts';
import type { Logger } from './log.ts';

export type QueryOutcome = 'resolved' | 'cached' | 'nxdomain' | 'nodata' | 'servfail';

export interface QueryLogInput {
	outcome: QueryOutcome;
	transport: string;
	from: string;
	name: string;
	qtype: number;
	/** 応答を採った上流（"組の名前/primary"）、キャッシュなら "cache"。無ければ "-" */
	upstream: string | undefined;
	ms: number;
	response: Buffer;
}

const LEVELS: Record<QueryOutcome, Parameters<Logger>[0]> = {
	resolved: 'INFO', cached: 'INFO', nodata: 'INFO', nxdomain: 'WARN', servfail: 'ERROR',
};

export function queryLogLine(q: QueryLogInput): { level: Parameters<Logger>[0]; message: string } {
	const ok = q.outcome === 'resolved' || q.outcome === 'cached';
	let message = `${ok ? 'OK' : 'NG'} ${q.outcome.padEnd(8)} ${q.transport} ${q.from} ${q.name} ${typeName(q.qtype)} ${q.upstream ?? '-'} ${q.ms}ms`;
	if (ok) {
		try {
			const answers = answerSummary(q.response);
			if (answers) message += ` => ${answers}`;
		} catch {
			// 回答が読めなくても、ログの行そのものは出す
		}
	}
	return { level: LEVELS[q.outcome], message };
}
