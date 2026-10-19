@echo off
rem dns-resolver-switch のサービスを止めて削除する。一般ユーザのコンソールから実行する（自動で管理者へ昇格する）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-service.ps1" -Uninstall
pause
