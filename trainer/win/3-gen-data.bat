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
echo  Step 3/5 - Generate training data (this takes hours)
echo ================================================================
echo.

rem ===================================================================
rem  Tunable parameters
rem  WORKERS  parallel processes. 8C/16T CPU: 14 works well.
rem  DEPTH    search depth per move. 8 is a good balance.
rem  MINUTES  how long to run. 180 = 3 hours.
rem ===================================================================
set WORKERS=14
set DEPTH=8
set MINUTES=180
rem ===================================================================

echo Workers    : %WORKERS%
echo Depth      : %DEPTH%
echo Duration   : %MINUTES% minutes
echo.
echo The Pikafish exe and its .nnue weights must be in the engine\
echo folder. Nothing to configure here - gen_data.py locates them and,
echo if it cannot, prints what the folder actually contains.
echo.
echo Press Ctrl+C to stop early. Data already written is kept.
echo.
echo ----------------------------------------------------------------
echo.

python src\gen_data.py --workers %WORKERS% --depth %DEPTH% --minutes %MINUTES% --out data
if errorlevel 1 goto FAILED

echo.
echo Next step: run 4-train.bat
echo.
pause
exit /b 0

:FAILED
echo.
echo ================================================================
echo  Something failed. Read the message above first.
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
