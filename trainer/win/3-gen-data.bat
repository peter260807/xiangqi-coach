@echo off
rem ===================================================================
rem  Keep this file PURE ASCII. Do not add non-ASCII characters.
rem  cmd.exe reads .bat using the system OEM code page (936/GBK on
rem  Chinese Windows). UTF-8 CJK text gets mis-decoded and can break
rem  parsing so the script fails to run. "chcp 65001" only changes
rem  console OUTPUT, not how cmd READS the file.
rem ===================================================================
chcp 65001 >nul
setlocalenabledelayedexpansion
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

echo ================================================================
echo  Step 3/5 - Generate training data (this takes hours)
echo ================================================================
echo.

rem ===================================================================
rem  Tunable parameters
rem  WORKERS  parallel processes. 5700X is 8C/16T, 14 works well.
rem  DEPTH    search depth per move. 8 is a good balance.
rem  MINUTES  how long to run. 180 = 3 hours.
rem ===================================================================
set WORKERS=14
set DEPTH=8
set MINUTES=180
rem ===================================================================

set ENGINE=
for %%f in (engine\pikafish.exe) do if exist "%%f" set ENGINE=%%~ff
if "!ENGINE!"=="" for %%f in (engine\pikafish*.exe) do if exist "%%f" set ENGINE=%%~ff

if "!ENGINE!"=="" (
  echo [FAIL] No pikafish*.exe found in the engine\ folder.
  echo        See the instructions in 2-selfcheck.bat.
  echo.
  pause
  exit /b 1
)

set NNUE=
for %%f in (engine\*.nnue) do if exist "%%f" set NNUE=%%~ff

if "!NNUE!"=="" (
  echo [FAIL] No .nnue weight file found in the engine\ folder.
  echo        Copy pikafish.nnue next to the exe.
  echo.
  pause
  exit /b 1
)

if not exist "data" mkdir "data" 2>nul

echo Engine     : !ENGINE!
echo Weights    : !NNUE!
echo Workers    : %WORKERS%
echo Depth      : %DEPTH%
echo Duration   : %MINUTES% minutes
echo Output     : data\
echo.
echo Press Ctrl+C to stop early. Generated data is kept.
echo.
echo ----------------------------------------------------------------
echo.

python src\gen_data.py --engine "!ENGINE!" --nnue "!NNUE!" --workers %WORKERS% --depth %DEPTH% --minutes %MINUTES% --out data

echo.
echo Next step: run 4-train.bat
echo.
pause
