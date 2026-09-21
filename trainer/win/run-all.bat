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
echo  Unattended run: generate data - train - export and verify
echo ================================================================
echo.
echo Requires: 1-install.bat already done, 2-selfcheck.bat passed.
echo You can start this and walk away. Check back later for results.
echo.

rem ===================================================================
rem  Defaults tuned for 5700X + 2080Ti, roughly 5-8 hours total.
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
  echo [FAIL] No engine found. Put Pikafish into the engine\ folder.
  pause
  exit /b 1
)
if "!NNUE!"=="" (
  echo [FAIL] No .nnue weights found. Copy pikafish.nnue next to the exe.
  pause
  exit /b 1
)

if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"

echo ================================================================
echo  [1/3] Generating data   started at %TIME%
echo ================================================================
python src\gen_data.py --engine "!ENGINE!" --nnue "!NNUE!" --workers %WORKERS% --depth %DEPTH% --minutes %GENMINUTES% --out data
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
python src\export.py --weights logs\weights.pt --out logs\xq-v1.xqnn
if errorlevel 1 goto FAIL
python src\verify.py --data data --net logs\xq-v1.xqnn --samples 4000 --show 3
if errorlevel 1 goto FAIL

echo.
echo ================================================================
echo  All done
echo ================================================================
echo.
echo Finished at %TIME%
echo.
echo Output: logs\xq-v1.xqnn
echo Send back that file plus the verification output above.
echo.
pause
exit /b 0

:FAIL
echo.
echo ================================================================
echo  Something failed. Send back the error above.
echo ================================================================
echo.
pause
exit /b 1
