// 動作確認用の問合せ。node tools/50_run/query.ts <名前> [型] [--server 127.0.0.1] [--port 10053] [--tcp]
import { parseArgs } from 'node:util';
import { buildQuery, classify, rcodeOf, TYPE } from '../../src/dns-message.ts';
import { queryTcp, queryUdp } from '../../src/upstream.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		server: { type: 'string', default: '127.0.0.1' },
		port: { type: 'string', default: '10053' },
		tcp: { type: 'boolean', default: false },
	},
});
const [name, typeText = 'A'] = positionals;
if (!name) {
	console.error('使い方: node tools/50_run/query.ts <名前> [型] [--server <IP>] [--port <番号>] [--tcp]');
	process.exit(2);
}
const qtype = (TYPE as Record<string, number>)[typeText.toUpperCase()] ?? Number(typeText);
const query = buildQuery(name, qtype, 1, { ednsSize: 1232 });
const addr = { host: values.server, port: Number(values.port) };
const started = Date.now();
const send = values.tcp ? queryTcp : queryUdp;
const resp = await send(addr, query, AbortSignal.timeout(5000));
console.log(`${name} ${typeText} ${classify(resp)} rcode=${rcodeOf(resp)} 回答=${resp.readUInt16BE(6)} 件 ${Date.now() - started}ms ${values.tcp ? 'TCP' : 'UDP'}`);
