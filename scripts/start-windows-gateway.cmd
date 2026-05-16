@echo off
cd /d C:\Users\browserfarm\Workspace\browserfarm
set "BROWSERFARM_CHROME_PATH=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
pnpm dev > gateway.out.log 2> gateway.err.log
