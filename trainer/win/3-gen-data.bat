@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ================================================================
echo  步骤 3 / 5   生成训练数据（这一步最耗时间）
echo ================================================================
echo.

rem ===================================================================
rem  可以按需要改下面这几个参数
rem
rem  WORKERS  并行进程数。5700X 是 8 核 16 线程，建议 14（留 2 线程给系统）
rem  DEPTH    每步搜索深度。8 是比较均衡的档位，调到 10~12 数据质量更高但更慢
rem  MINUTES  跑多少分钟。180 = 3 小时
rem ===================================================================
set WORKERS=14
set DEPTH=8
set MINUTES=180
rem ===================================================================

set ENGINE=
for %%f in (engine\pikafish.exe) do if exist "%%f" set ENGINE=%%~ff
if "!ENGINE!"=="" for %%f in (engine\pikafish*.exe) do if exist "%%f" set ENGINE=%%~ff

if "!ENGINE!"=="" (
  echo [失败] 在 engine\ 目录里没找到 pikafish*.exe
  echo        请先按 2-selfcheck.bat 的提示把引擎放进去。
  echo.
  pause
  exit /b 1
)

set NNUE=
for %%f in (engine\*.nnue) do if exist "%%f" set NNUE=%%~ff

if "!NNUE!"=="" (
  echo [失败] 在 engine\ 目录里没找到 .nnue 权重文件
  echo        引擎需要它才能工作，请把 pikafish.nnue 放到引擎同目录。
  echo.
  pause
  exit /b 1
)

for %%d in (data) do if not exist "%%d" mkdir "%%d" 2>nul

echo 引擎      : !ENGINE!
echo 权重      : !NNUE!
echo 并行进程  : %WORKERS%
echo 搜索深度  : %DEPTH%
echo 运行时长  : %MINUTES% 分钟
echo 输出目录  : data\
echo.
echo 预计产出：约 %WORKERS% x 900 x %MINUTES% 个局面（数量级参考）
echo 按 Ctrl+C 可以提前结束，已生成的数据不会丢。
echo.
echo ----------------------------------------------------------------
echo.

python src\gen_data.py --engine "!ENGINE!" --nnue "!NNUE!" --workers %WORKERS% --depth %DEPTH% --minutes %MINUTES% --out data

echo.
echo 下一步跑：4-train.bat
echo.
pause
