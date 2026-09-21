@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0.."

echo ================================================================
echo  无人值守模式：数据生成 → 训练 → 导出验证
echo ================================================================
echo.
echo 前提：已经跑过 1-install.bat 装好依赖、2-selfcheck.bat 确认引擎就位。
echo 全程不需要人盯着，可以出门前双击，回来直接看结果。
echo.

rem ===================================================================
rem  想调整就改这里。默认参数按 5700X + 2080Ti 的配置估算，约 8~10 小时。
rem ===================================================================
set WORKERS=14
set DEPTH=8
set GENMINUTES=180
set EPOCHS=8
set BATCH=8192
set LR=0.001
rem ===================================================================

set ENGINE=
for %%f in (engine\pikafish.exe) do if exist "%%f" set ENGINE=%%~ff
if "!ENGINE!"=="" for %%f in (engine\pikafish*.exe) do if exist "%%f" set ENGINE=%%~ff

set NNUE=
for %%f in (engine\*.nnue) do if exist "%%f" set NNUE=%%~ff

if "!ENGINE!"=="" (
  echo [失败] 没找到引擎，请先把 Pikafish 放进 engine\ 目录。
  pause
  exit /b 1
)
if "!NNUE!"=="" (
  echo [失败] 没找到 .nnue 权重，请把 pikafish.nnue 放到引擎同目录。
  pause
  exit /b 1
)

if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"

set T0=%TIME%

echo ================================================================
echo  [1/3] 生成数据   开始于 %TIME%
echo ================================================================
python src\gen_data.py --engine "!ENGINE!" --nnue "!NNUE!" --workers %WORKERS% --depth %DEPTH% --minutes %GENMINUTES% --out data
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  [2/3] 训练网络   开始于 %TIME%
echo ================================================================
python src\train.py --data data --out logs --epochs %EPOCHS% --batch %BATCH% --lr %LR%
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  [3/3] 导出与验证   开始于 %TIME%
echo ================================================================
python src\export.py --weights logs\weights.pt --out logs\xq-v1.xqnn
if errorlevel 1 goto FAIL
python src\verify.py --data data --net logs\xq-v1.xqnn --samples 4000 --show 3
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  全部完成
echo ================================================================
echo.
echo 开始时间 %T0%    结束时间 %TIME%
echo.
echo 产出：logs\xq-v1.xqnn
echo 把上面验证部分输出 + 这个文件发回来就行。
echo.
pause
exit /b 0

:FAIL
echo.
echo ================================================================
echo  出错了，请把上面的报错信息发回来
echo ================================================================
echo.
pause
exit /b 1
