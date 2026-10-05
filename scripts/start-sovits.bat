@echo off
rem ============================================================================
rem GPT-SoVITS 服务启动脚本（常驻，独立于 dsh）
rem ============================================================================
rem 用法：
rem   1) 把本文件放到 GPT-SoVITS 安装目录下（与 api_v2.py 同级），双击运行；
rem   2) 或直接双击，脚本会自动在常见位置查找 GPT-SoVITS；
rem   3) 开机自启：Win+R 输入 shell:startup，把本文件（或快捷方式）放进启动文件夹。
rem
rem 说明：dsh 插件检测到该服务已在运行时会自动复用，不会重复拉起。
rem ============================================================================

chcp 65001 >nul
setlocal enabledelayedexpansion

set "SOVITS_DIR="

rem ---- 1) 本脚本所在目录就是 GPT-SoVITS 根目录（找得到 api_v2.py） ----
if exist "%~dp0api_v2.py" set "SOVITS_DIR=%~dp0"

rem ---- 2) 脚本位于 plugins\ 或 scripts\ 子目录时，向上一级查找 ----
if not defined SOVITS_DIR if exist "%~dp0..\api_v2.py" set "SOVITS_DIR=%~dp0..\"

rem ---- 3) 常见安装位置探测 ----
if not defined SOVITS_DIR (
  for %%D in (D C E F) do (
    if not defined SOVITS_DIR (
      for /d %%P in ("%%D:\GPT-SoVITS*") do (
        if not defined SOVITS_DIR if exist "%%~fP\api_v2.py" set "SOVITS_DIR=%%~fP"
      )
    )
    if not defined SOVITS_DIR (
      for /d %%P in ("%%D:\1\GPT-SoVITS*") do (
        if not defined SOVITS_DIR if exist "%%~fP\api_v2.py" set "SOVITS_DIR=%%~fP"
      )
    )
  )
)

if not defined SOVITS_DIR (
  echo.
  echo [错误] 没有找到 GPT-SoVITS 安装目录（需要包含 api_v2.py）。
  echo.
  echo 解决办法：把本脚本复制到 GPT-SoVITS 根目录下再运行，
  echo           或手动执行下面的命令（把路径换成你自己的）：
  echo.
  echo   cd /d 你的GPT-SoVITS目录
  echo   runtime\python.exe api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml
  echo.
  pause
  exit /b 1
)

echo 找到 GPT-SoVITS: %SOVITS_DIR%
cd /d "%SOVITS_DIR%"

rem ---- 优先使用整合包自带 runtime，否则回退到系统 python ----
if exist "runtime\python.exe" (
  set "PY=runtime\python.exe"
) else (
  set "PY=python"
  echo [提示] 未找到 runtime\python.exe，改用系统 python。
)

rem ---- 端口占用检查 ----
netstat -ano | findstr ":9880.*LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [提示] 端口 9880 已被占用，服务可能已在运行。
  echo         如需重启，请先关闭占用该端口的进程。
  pause
  exit /b 0
)

echo.
echo 正在启动 GPT-SoVITS API（端口 9880）...
echo 首次启动需加载模型，约 1 分钟，请耐心等待。
echo 看到 "Uvicorn running on http://0.0.0.0:9880" 即为就绪。
echo 保持本窗口打开即为常驻；关闭窗口即停止服务。
echo.

"%PY%" api_v2.py -a 0.0.0.0 -p 9880 -c GPT_SoVITS\configs\tts_infer.yaml

echo.
echo 服务已退出。
pause
