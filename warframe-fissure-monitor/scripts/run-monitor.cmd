@echo off
setlocal

rem =====================================================================
rem  warframe-fissure-monitor - long-running launcher (Task Scheduler)
rem
rem  Usage: scripts\run-monitor.cmd
rem
rem  ASCII-ONLY FILE - do not add non-ASCII characters, comments or echo
rem  text: classic Windows cmd.exe parses batch files using the local
rem  code page, so UTF-8 Chinese in a .cmd file can fail with mojibake
rem  errors such as: "'<garbled>rem' is not recognized as an internal command".
rem  Do NOT use the localized date/time pseudo variables either: they
rem  emit locale-dependent text (for example Chinese weekday names) and
rem  would mix encodings inside logs\monitor.log, which is otherwise
rem  pure UTF-8 written by the Node logger.
rem
rem  This script must never contain credentials (QQ id / token / proxy).
rem  All configuration comes from .env or the process environment, and
rem  the log timestamps are produced by the Node logger itself.
rem
rem  Guarded by tests/run-monitor-cmd.test.ts
rem =====================================================================

rem Project root is resolved relatively from this script location
cd /d "%~dp0.."
if errorlevel 1 exit /b 1

if not exist "logs" mkdir "logs"

if not exist "dist\index.js" (
  echo [run-monitor] dist\index.js not found. Run npm run build first.>>"logs\monitor.log"
  echo [run-monitor] dist\index.js not found. Run npm run build first.
  exit /b 1
)

echo.>>"logs\monitor.log"
echo [run-monitor] ===== START =====>>"logs\monitor.log"

rem Node writes its own UTF-8 log lines (including timestamps) here
node "dist\index.js" >>"logs\monitor.log" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

echo [run-monitor] ===== EXIT code=%EXIT_CODE% =====>>"logs\monitor.log"

exit /b %EXIT_CODE%
