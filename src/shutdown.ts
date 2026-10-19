// 停止の合図と異常の受け付け。止め方を問わず、後片付け（停止時の集計・受け口を閉じる）を済ませてから終わる
// 強制終了（taskkill /F 等）はプロセスに知らされないので、ここでは受けられない
import type { Logger } from './log.ts';

export interface SignalSource {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ShutdownOptions {
	source: SignalSource;
	log: Logger;
	close: () => Promise<void>;
	exit: (code: number) => void;
	/** 後片付けがこの時間で終わらなければ、待たずに終わる（閉じられない接続で止まり続けないため） */
	forceMs?: number;
	signals?: string[];
}

/** SIGBREAK（Ctrl+Break）は Windows だけ。SIGHUP は Windows ではコンソールの窓を閉じたときに届く */
export const DEFAULT_SIGNALS = process.platform === 'win32'
	? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']
	: ['SIGINT', 'SIGTERM', 'SIGHUP'];

function describe(err: unknown): string {
	return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

export function installShutdown(opt: ShutdownOptions): void {
	const forceMs = opt.forceMs ?? 5000;
	let stopping = false;
	let exited = false;
	const exit = (code: number) => {
		if (exited) return;
		exited = true;
		opt.exit(code);
	};

	const stop = async (code: number, reason: string) => {
		if (stopping) {
			opt.log('WARN', `${reason} を受けました。後片付けを待たずに終わります`);
			exit(code);
			return;
		}
		stopping = true;
		opt.log('INFO', `${reason} を受けました。停止します`);
		const timer = setTimeout(() => {
			opt.log('WARN', `後片付けが ${forceMs}ms で終わらないため、強制的に終わります`);
			exit(code);
		}, forceMs);
		try {
			await opt.close();
		} catch (err) {
			opt.log('ERROR', `後片付けに失敗しました: ${describe(err)}`);
		}
		clearTimeout(timer);
		opt.log('INFO', '停止');
		exit(code);
	};

	for (const signal of opt.signals ?? DEFAULT_SIGNALS) {
		opt.source.on(signal, () => { void stop(0, signal); });
	}
	opt.source.on('uncaughtException', (err) => {
		opt.log('ERROR', `捕まえていない例外: ${describe(err)}`);
		void stop(1, 'uncaughtException');
	});
	opt.source.on('unhandledRejection', (reason) => {
		opt.log('ERROR', `捕まえていない拒否: ${describe(reason)}`);
		void stop(1, 'unhandledRejection');
	});
}
