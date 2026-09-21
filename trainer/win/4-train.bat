@echo off
rem ===================================================================
rem  Keep this file PURE ASCII. Do not add non-ASCII characters.
rem  cmd.exe reads .bat using the system OEM code page (936/GBK on
rem  Chinese Windows). UTF-8 CJK text gets mis-decoded and can break
rem  parsing so the script fails to run. "chcp 65001" only changes
rem  console OUTPUT, not how cmd READS the file.
rem ===================================================================
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

echo ================================================================
echo  Step 4/5 - Train the network
echo ================================================================
echo.

rem ===================================================================
rem  EPOCHS  how many passes over the data
rem  BATCH   samples per step. 8192 is fine for an 11G card.
rem  LR      learning rate
rem ===================================================================
set EPOCHS=8
set BATCH=8192
set LR=0.001
rem ===================================================================

if not exist "data" (
  echo [FAIL] No data folder. Run 3-gen-data.bat first.
  echo.
  pause
  exit /b 1
)

dir /b data\part_*.bin >nul 2>nul
if errorlevel 1 (
  echo [FAIL] No part_*.bin files in the data folder.
  echo        Run 3-gen-data.bat first.
  echo.
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs" 2>nul

echo Epochs     : %EPOCHS%
echo Batch      : %BATCH%
echo LR         : %LR%
echo Data       : data\
echo Output     : logs\
echo.
echo A checkpoint is saved after every epoch (logs\ckpt.pt).
echo Press Ctrl+C to stop; saved progress is kept.
echo.
echo ----------------------------------------------------------------
echo.

python src\train.py --data data --out logs --epochs %EPOCHS% --batch %BATCH% --lr %LR%

echo.
echo Next step: run 5-export-verify.bat
echo.
pause
