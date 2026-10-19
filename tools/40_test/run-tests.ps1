# テストを全件実行する（node --test、bun があれば bun test も）
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$testDir = Join-Path $root 'tests'
if (-not (Test-Path $testDir)) { throw "テストのフォルダが見つかりません: tests" }
$files = @(Get-ChildItem $testDir -Filter '*.test.ts' | ForEach-Object { $_.FullName })
if ($files.Count -eq 0) { throw 'テストが 1 件もありません' }

Write-Host '== 型チェック（tsc） =='
& node (Join-Path $root 'node_modules/typescript/bin/tsc') -p (Join-Path $root 'tsconfig.json') | Out-Host
$tscCode = $LASTEXITCODE

Write-Host '== node --test =='
& node --test @files | Out-Host
$nodeCode = $LASTEXITCODE

$bunCode = 0
if (Get-Command bun -ErrorAction SilentlyContinue) {
	Write-Host '== bun test =='
	& bun test @files | Out-Host
	$bunCode = $LASTEXITCODE
}

if ($tscCode -ne 0 -or $nodeCode -ne 0 -or $bunCode -ne 0) {
	Write-Host "失敗: tsc=$tscCode node=$nodeCode bun=$bunCode"
	exit 1
}
Write-Host 'すべて成功'
