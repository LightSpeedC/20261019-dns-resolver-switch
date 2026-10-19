// 起動口。node src/main.ts [--config <path>] [--host <IP>] [--port <番号>]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from './config.ts';
import { consoleLogger } from './log.ts';
import { startServer } from './server.ts';

const { values } = parseArgs({
	options: {
		config: { type: 'string' },
		host: { type: 'string' },
		port: { type: 'string' },
	},
});

const defaultPath = path.join(import.meta.dirname, '..', 'config', 'resolver.json');
const configPath = values.config ?? (fs.existsSync(defaultPath) ? defaultPath : null);
const base = configPath ? loadConfig(configPath) : DEFAULT_CONFIG;
const config = parseConfig({
	...base,
	listen: { host: values.host ?? base.listen.host, port: values.port !== undefined ? Number(values.port) : base.listen.port },
	upstreams: base.upstreams.map((g) => ({
		name: g.name,
		primary: `[${g.primary.host}]:${g.primary.port}`,
		secondary: `[${g.secondary.host}]:${g.secondary.port}`,
	})),
});

const server = await startServer(config, consoleLogger);
// 本番とテストを同時に動かしたとき、プロセス一覧で見分けられるようにポートを名前に入れる
process.title = `dns-resolver-switch:${server.port}`;
consoleLogger('INFO', `起動 ${config.listen.host}:${server.port}（UDP・TCP） 上流 ${config.upstreams.length} 組`);

const stop = () => {
	consoleLogger('INFO', '停止');
	server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
