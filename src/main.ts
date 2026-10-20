// 起動口。node src/main.ts [--config <path>] [--host <IP>] [--port <番号>]
// 終了コード: 0 = 停止の合図で終わった ／ 1 = 動いている間の異常 ／ 2 = 起動の失敗（設定の誤り・ポートが使えない）
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ensureConfigFile, loadConfig, parseConfig, type Config } from './config.ts';
import { consoleLogger } from './log.ts';
import { startServer, type RunningServer } from './server.ts';
import { installShutdown } from './shutdown.ts';

const log = consoleLogger;

function loadFromArgs(): Config {
	const { values } = parseArgs({
		options: {
			config: { type: 'string' },
			host: { type: 'string' },
			port: { type: 'string' },
		},
	});
	let configPath = values.config;
	if (!configPath) {
		// 既定は config/_resolver.json（Git に入らない）。無ければテンプレートから写す
		const configDir = path.join(import.meta.dirname, '..', 'config');
		configPath = path.join(configDir, '_resolver.json');
		if (ensureConfigFile(configPath, path.join(configDir, 'resolver.example.json'))) {
			log('INFO', '設定 config/_resolver.json が無いため、config/resolver.example.json から写しました');
		}
	}
	const base = loadConfig(configPath);
	return parseConfig({
		...base,
		listen: { host: values.host ?? base.listen.host, port: values.port !== undefined ? Number(values.port) : base.listen.port },
		upstreams: base.upstreams.map((g) => ({
			name: g.name,
			primary: `[${g.primary.host}]:${g.primary.port}`,
			secondary: `[${g.secondary.host}]:${g.secondary.port}`,
			transport: g.transport,
		})),
	});
}

function startupMessage(err: unknown, config: Config | null): string {
	const where = config ? `${config.listen.host}:${config.listen.port}` : '';
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === 'EADDRINUSE') return `起動できません: ${where} は使用中です（ほかのプロセスが待ち受けています）`;
	if (code === 'EACCES') return `起動できません: ${where} で待ち受ける権限がありません`;
	if (code === 'EADDRNOTAVAIL') return `起動できません: ${where} はこの PC のアドレスではありません`;
	return `起動できません: ${err instanceof Error ? err.message : String(err)}`;
}

let config: Config | null = null;
let server: RunningServer;
try {
	config = loadFromArgs();
	server = await startServer(config, log);
} catch (err) {
	log('ERROR', startupMessage(err, config));
	process.exit(2);
}

// 本番とテストを同時に動かしたとき、プロセス一覧で見分けられるようにポートを名前に入れる
process.title = `dns-resolver-switch:${server.port}`;
log('INFO', `起動 ${config.listen.host}:${server.port}（UDP・TCP） 上流 ${config.upstreams.length} 組`);

installShutdown({
	source: process,
	log,
	close: () => server.close(),
	exit: (code) => process.exit(code),
});
