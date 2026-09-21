@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  步骤 2 / 5   环境自检
echo ================================================================
echo.

if not exist "engine" (
  echo [提示] 还没有 engine 目录，正在创建 ...
  mkdir "engine" 2>nul
)

set HAVEENGINE=0
for %%f in (engine\pikafish.exe) do if exist "%%f" set HAVEENGINE=1
for %%f in (engine\pikafish*.exe) do if exist "%%f" set HAVEENGINE=1

if "%HAVEENGINE%"=="0" (
  echo ----------------------------------------------------------------
  echo [需要手动做一步] 把 Pikafish 引擎放进来
  echo ----------------------------------------------------------------
  echo.
  echo  1. 打开 https://github.com/official-pikafish/Pikafish/releases
  echo  2. 下载最新的 Pikafish.YYYY-MM-DD.7z
  echo  3. 解压，把里面的这两类文件复制到本目录的 engine\ 文件夹：
  echo       Pikafish-Windows-x86-64-universal.exe   （建议改名为 pikafish.exe）
  echo       pikafish.nnue                           （神经网络权重，约 50MB）
  echo.
  echo  注意：exe 和 nnue 必须放在同一个目录里。
  echo.
)

python src\selfcheck.py %*
echo.
pause
