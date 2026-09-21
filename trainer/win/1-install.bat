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

rem ===================================================================
rem  CUDA wheel index -- this is the part that is easy to get wrong.
rem
rem  PyPI's Windows torch wheel is CPU-ONLY: 230 MB, versus 847 MB for
rem  the same version on Linux which does bundle CUDA (verified against
rem  the PyPI metadata). So a plain "pip install torch" gives you a CPU
rem  build and torch.cuda.is_available() stays False -- no error, just
rem  silently no GPU. CUDA builds only exist on PyTorch's own index and
rem  must be selected with --index-url.
rem
rem    cu126  requires driver >= 527   <- default, best for RTX 2080 Ti
rem    cu128  requires driver >= 570
rem    cu129  requires driver >= 575
rem
rem  RTX 2080 Ti is Turing (sm_75). All three still support it.
rem ===================================================================
set CUDA_INDEX=https://download.pytorch.org/whl/cu126
set TORCH_VER=2.8.0
rem ===================================================================

echo ================================================================
echo  Step 1/5 - Install dependencies
echo ================================================================
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPYTHON

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Found Python %PYVER%

python -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)"
if errorlevel 1 goto OLDPY
echo.

echo [1/5] Upgrading pip ...
python -m pip install --upgrade pip --quiet
echo [2/5] Installing numpy ...
python -m pip install numpy --quiet

echo [3/5] Removing any existing PyTorch build ...
rem Must be explicit. A leftover CPU build reports version "2.8.0" and
rem pip considers that to already satisfy "torch==2.8.0", so it would
rem skip the download and you would stay on the CPU build forever.
python -m pip uninstall -y torch torchvision torchaudio >nul 2>nul
echo       done.

echo [4/5] Installing PyTorch %TORCH_VER% with CUDA from:
echo       %CUDA_INDEX%
echo       This is a large download (about 2.5 GB). Progress is shown on
echo       purpose so you can tell it is not stuck.
echo.
python -m pip install "torch==%TORCH_VER%" --index-url %CUDA_INDEX%
if errorlevel 1 goto PIPFAIL

echo.
echo [5/5] Checking the result ...
echo.
echo ----------------------------------------------------------------
echo  GPU check
echo ----------------------------------------------------------------
python -c "import torch;print('  PyTorch version :',torch.__version__);print('  CUDA tag        :',torch.version.cuda);print('  CUDA available  :',torch.cuda.is_available())"
if errorlevel 1 goto IMPORTFAIL

python -c "import sys,torch;sys.exit(0 if torch.cuda.is_available() else 1)"
if errorlevel 1 goto NOCUDA

python -c "import torch;p=torch.cuda.get_device_properties(0);print('  Device          :',p.name);print('  Compute cap     : sm_%d%d' % torch.cuda.get_device_capability(0));print('  VRAM            : %.1f GB' % (p.total_memory/1024**3))"

echo.
echo ----------------------------------------------------------------
echo  All good - training will use the GPU.
echo ----------------------------------------------------------------
echo.
echo Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0

:NOCUDA
echo.
echo ================================================================
echo  [FAIL] The CUDA build is installed, but the GPU is not usable
echo ================================================================
echo.
echo  Most likely the NVIDIA driver is too old for CUDA 12.6
echo  (it needs driver 527 or newer). Check it with:
echo.
echo      nvidia-smi
echo.
echo  Update the driver from nvidia.com -- that is the clean fix.
echo  If you cannot update the driver, tell me and I will pick a
echo  torch version that matches your driver instead.
echo.
pause
exit /b 1

:PIPFAIL
echo.
echo [FAIL] pip could not install PyTorch.
echo.
echo  Read the error above. Common causes:
echo    - No network access to download.pytorch.org
echo    - Not enough disk space (needs about 6 GB free)
echo    - Python version has no matching wheel (3.10 - 3.13 are safe)
echo.
pause
exit /b 1

:IMPORTFAIL
echo.
echo [FAIL] torch imports but cannot be queried. Run 0-fix-torch.bat.
echo.
pause
exit /b 1

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
echo [FAIL] Python is older than 3.10.
echo.
echo PyTorch 2.8.0 has no Windows wheel below 3.10.
echo Please install Python 3.10 - 3.13 and run this again.
echo.
pause
exit /b 1
