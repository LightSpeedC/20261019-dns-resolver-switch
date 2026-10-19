# dns-resolver-switch

上流 DNS の複数の組へ同時に問い合わせ、最初に解決できた応答を返す Node.js 製のリゾルバ。

> 📅 作成: 2026-10-19 / 更新: 2026-10-20

[⌂](../)

## 何をするか

- 受けた問合せを、上流の組（primary / secondary の IP アドレスの組。既定は 3 組）へ同時に送り、**最初に解決できた応答**を返す
- 上流ごとに解決できる範囲が違ってもよい。NXDOMAIN や回答の無い応答は「その上流では解決できなかった」と読み、ほかの組を待つ。**全組が解決できなかったときだけ**、届いた中で最も強い否定（NXDOMAIN ＞ NODATA ＞ SERVFAIL）を返す
- primary が一定時間（既定 300 ms）返さないか解決できなければ、その組の secondary にも送る
- UDP と TCP の両方を同じポートで受ける。上流の応答が切り詰め（TC）なら TCP で取り直す
- UDP に答えない上流は、起動時（待ち受けを始める前）に見つけて TCP 専用にする。動いている間も、UDP の応答の無い試行が続けば確かめ直し、TCP 専用にした上流も 10 分ごとに UDP を確かめ直す
- 解決できた応答は TTL のあいだキャッシュする。否定応答はキャッシュしない
- 受け付ける送信元は、サブネット（CIDR）の許可リストで絞る

## 使い方

Node.js（TypeScript をそのまま実行できる版。動作を確かめたのは v26.11.1）。実行時の依存パッケージは無い。

```shell
node src/main.ts                                  # config/resolver.json で起動
node src/main.ts --port 53 --host 0.0.0.0         # 待受けだけを変える
node src/main.ts --config path/to/resolver.json   # 別の設定で起動
node tools/50_run/query.ts example.com A          # 動作確認（--tcp で TCP）
```

Windows の nslookup は `-port` を付けても 53 番へ送る。nslookup で確かめるときは 53 番で起動する。

## 設定（config/resolver.json）

| 項目 | 既定値 | 意味 |
|---|---|---|
| `listen` | 0.0.0.0:10053 | 待ち受けるアドレスとポート（UDP・TCP 共通） |
| `allow` | 127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 | 受け付ける送信元のサブネット。外れた送信元には UDP は返事をせず、TCP は接続を閉じる |
| `hedgeMs` | 300 | primary が返さないとき、secondary にも送るまでの時間 |
| `timeoutMs` | 2000 | 1 件の問合せ全体の期限 |
| `cacheMaxEntries` | 10000 | キャッシュの件数の上限 |
| `statsIntervalMs` | 600000 | 上流ごとの集計（送信・応答・勝ち・平均応答時間）をログへ出す間隔。0 で止める。停止時にも出す |
| `upstreams` | google / cloudflare / quad9 | 上流の組。`name`・`primary`・`secondary` を IP アドレスで書く（`192.0.2.1:5300`・`[2001:db8::1]:53` の形でポートも書ける）。`transport` は `auto`（既定・確かめて決める）／ `udp` ／ `tcp`（決め打ち） |

## Windows サービスとして動かす

サービス ID は `node-dns-resolver-switch`（表示名 `␣dns-resolver-switch DNS リゾルバ`。先頭は半角空白）。UDP・TCP の 53 番で待ち受け、OS の起動時に自動で起動する。

```shell
tools/70_deploy/install-service.cmd     # 導入・入れ直し（一般ユーザのコンソールから。自動で管理者へ昇格する）
tools/70_deploy/uninstall-service.cmd   # 停止して削除
Restart-Service node-dns-resolver-switch  # 設定・ソースを変えたあとの反映（管理者の PowerShell）
```

- node の実行ファイルを `deploy/node-dns-resolver-switch.exe` として複製して動かす（プロセス一覧でサービスと見分けるため）。node の版を上げたら入れ直す
- winsw は ai-chat-lite のものを複製する
- ログは `logs/node-dns-resolver-switch/`

## LAN から使うときのファイアウォールの許可

導入スクリプトは許可の規則を足さない。LAN の端末から使うときは、管理者の PowerShell で、この exe の 53 番をローカル サブネットからだけ許可する（`<実体のフォルダ>` はプロジェクトの実体のパス。subst のドライブではなく C: のパスを書く）。

```powershell
$exe = '<実体のフォルダ>\deploy\node-dns-resolver-switch.exe'
foreach ($p in 'UDP', 'TCP') {
	New-NetFirewallRule -DisplayName " dns-resolver-switch DNS ($p)" -Direction Inbound -Program $exe -Protocol $p -LocalPort 53 -RemoteAddress LocalSubnet -Action Allow
}
# 消すとき
Get-NetFirewallRule -DisplayName ' dns-resolver-switch DNS (*)' | Remove-NetFirewallRule
```

## テスト

```shell
npm install                      # 型チェック用（typescript・@types/node）
tools/40_test/run-tests.cmd      # tsc・node --test・bun test を順に実行
```

上流は偽の DNS サーバをテストの中で立てるので、実ネットには出ない。

## フォルダ構成

```text
src/        本体
config/     既定の設定
tests/      テスト
deploy/     サービスの定義（winsw）
tools/      テストのランチャ（40_test）・動作確認の道具（50_run）・サービスの導入（70_deploy）
notes/      計画・状態・課題
```

1. [計画](#1-計画)
2. [状態](#2-状態)
3. [課題](#3-課題)

## 1. 計画

- [計画: 並列問合せ DNS リゾルバ（Node.js）](notes/10_plan/p261019-01-並列問合せDNSリゾルバ.md)
- [計画: 停止と異常の扱い（i261019-04）](notes/10_plan/i261019-04-停止と異常の扱い.md)
- [計画: Windows サービス化（i261019-03）](notes/10_plan/i261019-03-Windowsサービス化.md)

## 2. 状態

- [状態](notes/30_status/status.md)

## 3. 課題

- [課題](notes/40_issues/issues.md)

[⌂](../)
