@echo off
rem Cyrene 用户数据迁移脚本入口：双击运行，免除 PowerShell 执行策略限制
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-user-data.ps1"
pause
