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
echo  Step 1/5 - Install dependencies
echo ================================================================
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPYTHON

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Found Python %PYVER%

python -c "import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)"
if errorlevel 1 goto OLDPY
echo.

echo [1/3] Upgrading pip ...
python -m pip install --upgrade pip --quiet
echo [2/3] Installing numpy ...
python -m pip install numpy --quiet
echo [3/3] Installing PyTorch (CUDA build, large download) ...
echo       NOTE: version is pinned to 2.8.0. PyTorch 2.9.x has a
echo       known c10.dll initialization bug on Windows.
python -m pip install "torch==2.8.0" --quiet

echo.
echo ----------------------------------------------------------------
echo  Checking GPU
echo ----------------------------------------------------------------
python -c "import torch;print('  PyTorch version :',torch.__version__);print('  CUDA available  :',torch.cuda.is_available());print('  CUDA version    :',torch.version.cuda);print('  Device          :',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU (training will be much slower)')"

echo.
echo Done. Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0

:NOPYTHON
echo [FAIL] python command not found.
echo.
echo Please install Python 3.10 or newer first:
echo   https://www.python.org/downloads/
echo.
echo Make sure to tick "Add python.exe to PATH" during installation.
echo.
pause
exit /b 1

:OLDPY
echo.
echo [FAIL] Python version is older than 3.9. Please upgrade.
echo.
pause
exit /b 1
