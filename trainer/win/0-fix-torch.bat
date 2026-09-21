@echo off
rem ===================================================================
rem  Keep this file PURE ASCII. Do not add non-ASCII characters.
rem
rem  Why: cmd.exe reads a .bat file using the system OEM code page
rem  (936/GBK on Chinese Windows). A UTF-8 file containing CJK text
rem  gets mis-decoded, and the garbled bytes can break parsing so the
rem  script fails to run at all. "chcp 65001" does NOT fix this -- it
rem  only changes console OUTPUT, not how cmd READS the file.
rem
rem  So: English messages here; Chinese messages come from the Python
rem  scripts (UTF-8 env vars are set below).
rem ===================================================================
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

echo ================================================================
echo  Fix PyTorch c10.dll initialization failure
echo ================================================================
echo.
echo Known causes, checked in this order:
echo   1. PyTorch 2.9.x has this bug on Windows -- 2.8.0 works
echo   2. Missing Visual C++ Redistributable
echo   3. CUDA build installed but machine environment does not match
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPY

echo [1/4] Currently installed version:
python -m pip show torch 2>nul | findstr /B /C:"Version:"
if errorlevel 1 echo         (torch is not installed)
echo.

echo [2/4] Trying to import torch:
python -c "import torch; print('        OK, version', torch.__version__)"
if not errorlevel 1 goto OK

echo.
echo         Import failed -- this is the c10.dll problem. Starting repair.
echo.

echo [3/4] Removing current PyTorch ...
python -m pip uninstall -y torch
echo.

echo [4/4] Installing 2.8.0 (known to work) ...
python -m pip install "torch==2.8.0"
echo.

echo Verifying:
python -c "import torch;print('        PyTorch',torch.__version__);print('        CUDA available:',torch.cuda.is_available());print('        Device:',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
if errorlevel 1 goto VCFAIL

echo.
echo ----------------------------------------------------------------
echo  Fixed. Next step: run 2-selfcheck.bat
echo ----------------------------------------------------------------
echo.
pause
exit /b 0

:VCFAIL
echo.
echo ================================================================
echo  Still failing -- the cause is likely a missing C++ runtime
echo ================================================================
echo.
echo  Download and install this (the x64 one):
echo    https://aka.ms/vs/17/release/vc_redist.x64.exe
echo.
echo  Reboot, then run this script again.
echo.
pause
exit /b 1

:NOPY
echo [FAIL] python not found. Run 1-install.bat first.
echo.
pause
exit /b 1

:OK
echo.
echo All good, no repair needed.
echo Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0
