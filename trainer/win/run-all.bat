@echo off
rem ===================================================================
rem  Keep this file PURE ASCII. Do not add non-ASCII characters.
rem
rem  cmd.exe reads a .bat using the system OEM code page (936/GBK on
rem  Chinese Windows). UTF-8 CJK text gets mis-decoded and can break
rem  parsing. "chcp 65001" only changes console OUTPUT, not how cmd
rem  READS the file.
rem
rem  Also: do NOT do path detection in here. An earlier version tried to
rem  locate the engine with "for" loops plus delayed expansion, and a
rem  missing space in "setlocal enabledelayedexpansion" silently turned
rem  it into one unknown command -- so !ENGINE! never expanded and the
rem  literal text "!ENGINE!" got passed to Python. The scripts now hand
rem  no paths at all; gen_data.py finds the engine itself and prints a
rem  clear message plus the folder listing if it cannot.
rem ===================================================================
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

echo ================================================================
echo  Unattended run: generate data - train - export and verify
echo ================================================================
echo.
echo Requires: 1-install.bat already done, and 2-selfcheck.bat passed.
echo You can start this and walk away. Check back later for results.
echo.

rem ===================================================================
rem  Defaults tuned for 8C/16T + a mid-range GPU, roughly 5-8 hours.
rem ===================================================================
set WORKERS=14
set DEPTH=8
set GENMINUTES=180
set EPOCHS=8
set BATCH=8192
set LR=0.001
rem ===================================================================

if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"

echo ================================================================
echo  [1/3] Generating data   started at %TIME%
echo ================================================================
python src\gen_data.py --workers %WORKERS% --depth %DEPTH% --minutes %GENMINUTES% --out data
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  [2/3] Training          started at %TIME%
echo ================================================================
python src\train.py --data data --out logs --epochs %EPOCHS% --batch %BATCH% --lr %LR%
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  [3/3] Export + verify   started at %TIME%
echo ================================================================
python src\export.py --weights logs\weights.pt --out logs\xq-v2.xqnn
if errorlevel 1 goto FAIL
python src\verify.py --data data --net logs\xq-v2.xqnn --samples 4000 --show 3
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  All done
echo ================================================================
echo.
echo Finished at %TIME%
echo.
echo Output: logs\xq-v2.xqnn
echo Send back that file plus the verification output above.
echo.
pause
exit /b 0

:FAIL
echo.
echo ================================================================
echo  Failed. Read the message above first.
echo ================================================================
echo.
echo  Most common cause: the engine is not in the engine\ folder.
echo  Put these two files there, side by side:
echo.
echo    Pikafish-Windows-x86-64-universal.exe   rename to pikafish.exe
echo    pikafish.nnue                           about 50 MB
echo.
echo  Download: https://github.com/official-pikafish/Pikafish/releases
echo.
pause
exit /b 1
