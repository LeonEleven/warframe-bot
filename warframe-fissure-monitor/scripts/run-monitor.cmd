@echo off
rem =====================================================================
rem  warframe-fissure-monitor 长期运行启动脚本（供 Windows 任务计划程序调用）
rem
rem  用法：scripts\run-monitor.cmd
rem  说明：本文件不得包含任何敏感信息（QQ 号 / token / 代理密码），
rem        所有配置都来自项目根目录的 .env 或系统环境变量。
rem =====================================================================
setlocal

rem 切到项目根目录（本脚本位于 scripts\ 下）
cd /d "%~dp0.."

if not exist "logs" mkdir "logs"

if not exist "dist\index.js" (
  echo [run-monitor] 未找到 dist\index.js，请先执行: npm run build>> "logs\monitor.log"
  echo [run-monitor] 未找到 dist\index.js，请先执行: npm run build
  exit /b 1
)

echo. >> "logs\monitor.log"
echo [run-monitor] ===== 启动 %DATE% %TIME% ===== >> "logs\monitor.log"

node "dist\index.js" >> "logs\monitor.log" 2>&1
set EXIT_CODE=%ERRORLEVEL%

echo [run-monitor] ===== 退出 %DATE% %TIME% exitcode=%EXIT_CODE% ===== >> "logs\monitor.log"
exit /b %EXIT_CODE%
