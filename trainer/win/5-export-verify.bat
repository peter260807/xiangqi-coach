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
echo  Step 5/5 - Export the network and verify it
echo ================================================================
echo.

if not exist "logs\weights.pt" (
  echo [FAIL] logs\weights.pt not found. Run 4-train.bat first.
  echo.
  pause
  exit /b 1
)

echo ----------------------------------------------------------------
echo  Exporting to engine-loadable format
echo ----------------------------------------------------------------
echo.
python src\export.py --weights logs\weights.pt --out logs\xq-v1.xqnn
if errorlevel 1 goto EXPORTFAIL

echo.
echo ----------------------------------------------------------------
echo  Verifying quality
echo ----------------------------------------------------------------
echo.
python src\verify.py --data data --net logs\xq-v1.xqnn --samples 4000 --show 3

echo.
echo ================================================================
echo  Done
echo ================================================================
echo.
echo Output files:
echo   logs\xq-v1.xqnn   final network (this is what the engine loads)
echo   logs\weights.pt   training weights (keep for further training)
echo   logs\train.log    training log
echo   data\part_*.bin   training data (safe to delete after training)
echo.
echo Send back logs\xq-v1.xqnn plus the verification output above.
echo.
pause
exit /b 0

:EXPORTFAIL
echo.
echo [FAIL] Export failed. Send back the error message above.
echo.
pause
exit /b 1
