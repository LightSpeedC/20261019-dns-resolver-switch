// ログの日時は実行環境のタイムゾーンに関係なく JST の yyyy/mm/dd hh:mm:ss.ccc
export type Logger = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
}

export function jstTimestamp(ms = Date.now()): string {
	const d = new Date(ms + 9 * 3600 * 1000);
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} `
		+ `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

export const consoleLogger: Logger = (level, message) => {
	const line = `${jstTimestamp()} ${level.padEnd(5)} ${message}`;
	if (level === 'INFO') console.log(line);
	else console.error(line);
};
