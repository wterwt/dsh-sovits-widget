@echo off
chcp 65001 >nul
setlocal
title dsh-sovits-widget 安装

echo ============================================================
echo   dsh-sovits-widget 安装程序
echo   GPT-SoVITS 语音播报插件 for DeepSeek Harness
echo ============================================================
echo.

set "PLUGIN_DIR=%~dp0.."
pushd "%PLUGIN_DIR%"
set "PLUGIN_DIR=%CD%"
popd

if not exist "%PLUGIN_DIR%\lib\index.js" goto :bad_plugin
if not exist "%PLUGIN_DIR%\cordis.patch.yml" goto :bad_plugin
echo [1/4] 插件文件检查通过
echo       目录: %PLUGIN_DIR%
echo.

if "%DSH_HOME%"=="" set "DSH_HOME=%USERPROFILE%\.dsh"
if not exist "%DSH_HOME%\profiles" goto :no_dsh
echo [2/4] dsh 配置目录: %DSH_HOME%
echo.

set "PROFILE_NAME=desktop"
if not exist "%DSH_HOME%\profiles\desktop\package.json" set "PROFILE_NAME=web"
if not exist "%DSH_HOME%\profiles\%PROFILE_NAME%\package.json" goto :no_profile

set "PROFILE_DIR=%DSH_HOME%\profiles\%PROFILE_NAME%"
echo [3/4] 使用 profile: %PROFILE_NAME%
echo.

set "NODE_EXE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo [4/4] 写入配置...
echo.
"%NODE_EXE%" "%PLUGIN_DIR%\scripts\install-helper.mjs" "%PROFILE_DIR%" "%PLUGIN_DIR%"
if errorlevel 1 goto :write_failed

echo.
echo ============================================================
echo   安装完成
echo ============================================================
echo.
echo 接下来请依次完成：
echo.
echo   [必做] 1. 完全退出 DeepSeek Harness（托盘图标 - 退出），再重新打开
echo   [必做] 2. 确认 GPT-SoVITS 服务已启动（端口 9880）
echo           没有的话，双击 scripts\start-sovits.bat
echo   [必做] 3. 重启后点击界面右下角的喇叭按钮
echo   [必做] 4. 进入「音色管理」新建角色，选择参考音频
echo   [必做] 5. 进入「基础设置」打开「自动播报助手回复」
echo.
echo 详细说明见同目录的 INSTALL.md
echo 卸载方法：把 package.json.bak-sovits 改名回 package.json 即可
echo.
pause
exit /b 0

:bad_plugin
echo [错误] 当前目录不是完整的插件目录。
echo        缺少 lib\index.js 或 cordis.patch.yml
echo        请把插件解压到固定目录后再运行本脚本。
echo        当前目录: %PLUGIN_DIR%
pause
exit /b 1

:no_dsh
echo [错误] 没有找到 dsh 配置目录: %DSH_HOME%\profiles
echo        请先安装 DeepSeek Harness 桌面版，并至少启动过一次。
pause
exit /b 1

:no_profile
echo [错误] 没有找到可用的 profile（desktop 与 web 都不存在）
echo        路径: %DSH_HOME%\profiles
pause
exit /b 1

:write_failed
echo.
echo [错误] 配置写入失败。
echo        请手动编辑: %PROFILE_DIR%\package.json
echo        参考 INSTALL.md 的「方式 B：手动安装」
pause
exit /b 1
