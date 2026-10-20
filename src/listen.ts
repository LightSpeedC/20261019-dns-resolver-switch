// 待ち受けるアドレスを決める。設定の outbound は、起動時に「外向けのアドレス」へ置き換える
// 外向けのアドレスは DHCP で変わるので、設定に数字で書かずに済むようにする。
// 0.0.0.0 は Windows の ICS（インターネット接続の共有）が UDP 53 番を持っていると取れないため、個別のアドレスで待ち受ける
import dgram from 'node:dgram';
import net from 'node:net';
import type { Address } from './config.ts';

export const OUTBOUND = 'outbound';

/** target へ送るときに OS が使う送信元アドレス。UDP の connect で経路を決めるだけで、パケットは送らない */
export function outboundAddress(target: Address): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = dgram.createSocket(net.isIPv6(target.host) ? 'udp6' : 'udp4');
		sock.on('error', (err) => { sock.close(); reject(err); });
		sock.connect(target.port, target.host, () => {
			const { address } = sock.address();
			sock.close();
			resolve(address);
		});
	});
}

/** outbound を外向けのアドレスに置き換え、重なりを除く。外向けは target（最初の上流）への経路で決める */
export async function resolveListenHosts(hosts: string[], target: Address): Promise<string[]> {
	const out: string[] = [];
	for (const h of hosts) {
		const ip = h === OUTBOUND ? await outboundAddress(target) : h;
		if (!out.includes(ip)) out.push(ip);
	}
	return out;
}
