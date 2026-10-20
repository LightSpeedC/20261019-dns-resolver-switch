<#
.SYNOPSIS
	別の PC へ持っていく配布物を _releases/ に作る（フォルダと zip）。

.DESCRIPTION
	含めるのは、サービスとして動かすのに要るものだけ。テスト・資料（notes）・開発用の設定（tsconfig 等）は入れない。
	node と winsw の実行ファイルも deploy/ に入れるので、持ち込む先の PC に node が無くても導入できる。
	実際に読む設定（config/_resolver.json）は入れない（社内のアドレスを書くことがあるため）。持ち込む先で、テンプレートから写される。

.PARAMETER WinswSource
	winsw の実行ファイルの複製元。

.PARAMETER NodeSource
	node の実行ファイルの複製元。既定は PATH の node。
#>
[CmdletBinding()]
param(
	[string]$WinswSource = 'T:/ai-chat-lite/deploy/node-ai-chat-lite-winsw.exe',
	[string]$NodeSource = '',
	[switch]$Pause
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'node-dns-resolver-switch'

function Complete-Script([int]$Code) {
	if ($Pause) {
		Write-Host ''
		Read-Host 'Enter キーで終了します'
	}
	exit $Code
}

try {
	$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
	if (-not $NodeSource) { $NodeSource = (Get-Command node).Source }
	foreach ($src in @($WinswSource, $NodeSource)) {
		if (-not (Test-Path -LiteralPath $src)) {
			Write-Host ('複製元が見つかりません: ' + $src) -ForegroundColor Red
			Complete-Script 1
		}
	}

	$name = '20261019-dns-resolver-switch-' + (Get-Date -Format 'yyyyMMdd')
	$outRoot = Join-Path $root '_releases'
	$outDir = Join-Path $outRoot $name
	$zipPath = $outDir + '.zip'
	if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
	if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
	New-Item -ItemType Directory -Force $outDir | Out-Null

	# リポジトリから写すもの（相対パス）
	$files = @(
		'README.html'
		'config/resolver.example.json'
		'deploy/node-dns-resolver-switch-winsw.xml'
		'tools/70_deploy/install-service.ps1'
		'tools/70_deploy/install-service.cmd'
		'tools/70_deploy/uninstall-service.cmd'
		'tools/50_run/query.ts'
	)
	$files += Get-ChildItem (Join-Path $root 'src') -Filter '*.ts' | ForEach-Object { 'src/' + $_.Name }
	foreach ($rel in $files) {
		$dst = Join-Path $outDir $rel
		New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
		Copy-Item -LiteralPath (Join-Path $root $rel) -Destination $dst
	}

	# .ts を ES モジュールとして読ませるための最小の package.json（開発用の依存は入れない）
	$pkg = '{' + "`n" + '	"name": "dns-resolver-switch",' + "`n" + '	"private": true,' + "`n" + '	"type": "module"' + "`n" + '}' + "`n"
	[System.IO.File]::WriteAllText((Join-Path $outDir 'package.json'), $pkg, (New-Object System.Text.UTF8Encoding($false)))

	# 実行ファイル（Git に入れていないもの）
	Copy-Item -LiteralPath $WinswSource -Destination (Join-Path $outDir ('deploy/' + $ServiceId + '-winsw.exe'))
	Copy-Item -LiteralPath $NodeSource -Destination (Join-Path $outDir ('deploy/' + $ServiceId + '.exe'))

	Compress-Archive -Path (Join-Path $outDir '*') -DestinationPath $zipPath

	$count = @(Get-ChildItem $outDir -Recurse -File).Count
	$sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
	Write-Host ('配布物を作りました: _releases/' + $name + '（' + $count + ' ファイル） / zip ' + $sizeMb + ' MB')
	Write-Host ('node の版: ' + (& $NodeSource --version))
	Complete-Script 0
} catch {
	Write-Host ('失敗しました: ' + $_.Exception.Message) -ForegroundColor Red
	Complete-Script 1
}
