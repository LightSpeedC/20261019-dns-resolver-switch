<#
.SYNOPSIS
	dns-resolver-switch を Windows サービス（winsw）として導入する。管理者権限が要る（自動で昇格する）。

.DESCRIPTION
	deploy/ に、node の複製・winsw の複製・winsw の定義（XML。Git に入れてある）をそろえ、サービスを導入して起動する。
	すでに導入済みなら、止めて入れ直す（定義や node の版の更新を反映するため）。
	ソースの更新だけなら入れ直しは要らない。管理者で Restart-Service node-dns-resolver-switch を実行する。

	【subst ドライブ】
	サービスは別のログオンセッションで動くため W: や T: が見えない。昇格する前に、渡すパスをすべて実体へ直す。
	管理者のコンソールを直接開いて実行すると、subst が見えず直せない。一般ユーザのコンソールから実行する。

.PARAMETER Uninstall
	サービスを止めて、削除する。deploy/ の exe とログは残す。

.PARAMETER WinswSource
	複製元の winsw の実行ファイル。

.PARAMETER NodeSource
	複製元の node の実行ファイル。既定は PATH の node。
#>
[CmdletBinding()]
param(
	[switch]$Uninstall,
	[string]$WinswSource = 'T:/ai-chat-lite/deploy/node-ai-chat-lite-winsw.exe',
	[string]$NodeSource = '',
	[switch]$NoElevate,
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

function Test-Admin {
	return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# subst で割り当てたドライブは昇格先・サービスから見えないため、実体パスへ直す
function Resolve-SubstPath([string]$Path) {
	# 区切りが / のパスも扱う。先に \ に揃えないと、ドライブの判定から外れて素通りする
	$Path = $Path.Replace('/', '\')
	$rootPath = [System.IO.Path]::GetPathRoot($Path)
	if (-not $rootPath) { return $Path }
	$drive = $rootPath.TrimEnd('\')
	if ($drive.Length -ne 2) { return $Path }
	foreach ($line in (subst)) {
		# subst の出力は「W:\: => C:\〈実体フォルダ〉」の形
		$m = [regex]::Match([string]$line, '^\s*([A-Za-z]:)\\:\s+=>\s+(.+?)\s*$')
		if ($m.Success -and $m.Groups[1].Value -eq $drive) {
			return $m.Groups[2].Value + $Path.Substring($drive.Length)
		}
	}
	return $Path
}

if (-not $NodeSource) {
	$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
	if ($nodeCommand) { $NodeSource = $nodeCommand.Source }
}

# 管理者へ昇格する。自分のパスと、引数の既定値も含めて、渡すパスはすべて実体へ直してから渡す
if ((-not (Test-Admin)) -and (-not $NoElevate)) {
	$q = [char]34
	$argLine = '-NoProfile -ExecutionPolicy Bypass -File ' + $q + (Resolve-SubstPath $MyInvocation.MyCommand.Path) + $q + ' -NoElevate -Pause'
	if ($Uninstall) { $argLine += ' -Uninstall' }
	$argLine += ' -WinswSource ' + $q + (Resolve-SubstPath $WinswSource) + $q
	if ($NodeSource) { $argLine += ' -NodeSource ' + $q + (Resolve-SubstPath $NodeSource) + $q }
	Write-Host '管理者権限で起動し直します...'
	try {
		Start-Process -FilePath 'powershell' -Verb RunAs -ArgumentList $argLine -ErrorAction Stop
		exit 0
	} catch {
		Write-Host '  昇格が取り消されました。このまま非管理者で続行します（失敗する場合があります）。' -ForegroundColor Yellow
	}
}

try {
	$root = Resolve-SubstPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
	$deployDir = Join-Path $root 'deploy'
	$winsw = Join-Path $deployDir ($ServiceId + '-winsw.exe')
	$nodeCopy = Join-Path $deployDir ($ServiceId + '.exe')
	$xmlPath = Join-Path $deployDir ($ServiceId + '-winsw.xml')

	function Invoke-Winsw([string]$Command) {
		# winsw の出力は画面へ出し、戻り値には含めない（含めると、成功しても戻り値の比較が真になる）
		& $winsw $Command | Out-Host
		return $LASTEXITCODE
	}

	# 導入済みなら、止めて削除する（入れ直しの前提。-Uninstall のときはこれで終わり）
	if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
		if (-not (Test-Path -LiteralPath $winsw)) {
			Write-Host ('サービスは導入済みですが、winsw が見つかりません: ' + $winsw) -ForegroundColor Red
			Complete-Script 1
		}
		Write-Host 'サービスを止めます...'
		[void](Invoke-Winsw 'stop')
		Write-Host 'サービスを削除します...'
		if ((Invoke-Winsw 'uninstall') -ne 0) {
			Write-Host '削除に失敗しました。' -ForegroundColor Red
			Complete-Script 1
		}
	}
	if ($Uninstall) {
		Write-Host ('サービスを削除しました: ' + $ServiceId)
		Complete-Script 0
	}

	if (-not (Test-Path -LiteralPath $xmlPath)) {
		Write-Host ('winsw の定義（XML）がありません: ' + $xmlPath) -ForegroundColor Red
		Complete-Script 1
	}
	if (-not (Test-Path -LiteralPath $winsw)) {
		if (-not (Test-Path -LiteralPath $WinswSource)) {
			Write-Host ('winsw の複製元が見つかりません: ' + $WinswSource) -ForegroundColor Red
			Write-Host '管理者のコンソールを直接開いて実行すると、T: や W: が見えません。一般ユーザのコンソールから実行してください（自動で昇格し、パスも実体へ直して渡します）。'
			Complete-Script 1
		}
		Copy-Item -LiteralPath $WinswSource -Destination $winsw
		Write-Host 'winsw を複製しました。'
	}
	# node は入れ直しのたびに写し直す（node の版を上げたときに反映するため）。サービスは上で止めてある
	if (-not $NodeSource -or -not (Test-Path -LiteralPath $NodeSource)) {
		Write-Host ('node の実行ファイルが見つかりません: ' + $NodeSource) -ForegroundColor Red
		Complete-Script 1
	}
	Copy-Item -LiteralPath $NodeSource -Destination $nodeCopy -Force
	Write-Host ('node を複製しました（' + (& $nodeCopy --version) + '）。')

	Write-Host 'サービスを導入します...'
	if ((Invoke-Winsw 'install') -ne 0) {
		Write-Host '導入に失敗しました。' -ForegroundColor Red
		Complete-Script 1
	}
	Write-Host 'サービスを起動します...'
	if ((Invoke-Winsw 'start') -ne 0) {
		Write-Host '起動に失敗しました。' -ForegroundColor Red
		Complete-Script 1
	}

	Start-Sleep -Seconds 5
	$svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
	Write-Host ''
	Write-Host ('サービス: ' + $ServiceId + ' / 状態: ' + $svc.Status + ' / 開始の種類: ' + $svc.StartType)
	# 登録された実行ファイルのパスが、実体のパスであること（subst のドライブだと、OS の再起動後に起動できない）を目で確かめる
	$imagePath = (Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $ServiceId + "'")).PathName
	Write-Host ('登録された実行ファイル: ' + $imagePath)
	Write-Host ('ログ: logs/' + $ServiceId + '/')
	Complete-Script 0
} catch {
	Write-Host ('失敗しました: ' + $_.Exception.Message) -ForegroundColor Red
	Complete-Script 1
}
