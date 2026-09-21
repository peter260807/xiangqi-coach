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
rem  CUDA wheel index - keep in sync with 1-install.bat
rem ===================================================================
set CUDA_INDEX=https://download.pytorch.org/whl/cu126
set TORCH_VER=2.8.0
rem ===================================================================

echo ================================================================
echo  Fix PyTorch problems on Windows
echo ================================================================
echo.
echo  This script checks and repairs, in order:
echo    1. Missing or broken PyTorch (the c10.dll initialization bug)
echo    2. A CPU-only build installed by mistake (very common)
echo    3. An NVIDIA driver too old for the selected CUDA version
echo.
echo  Why 2 happens: PyPI's Windows torch wheel is CPU-only. A plain
echo  "pip install torch" succeeds and looks fine, but the GPU is never
echo  used and torch.cuda.is_available() stays False.
echo.
echo  Why 3 happens: this script installs CUDA 12.6 wheels, which need
echo  NVIDIA driver 527 or newer.
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPY

echo [1/5] Currently installed PyTorch:
python -m pip show torch 2>nul | findstr /B /C:"Version:"
if errorlevel 1 echo         (torch is not installed)
echo.

echo [2/5] NVIDIA driver:
where nvidia-smi >nul 2>nul
if errorlevel 1 (
  echo         nvidia-smi not found - no NVIDIA driver, or not in PATH.
  echo         Training will run on CPU.
) else (
  for /f "tokens=*" %%l in ('nvidia-smi --query-gpu^=name^,driver_version --format^=csv^,noheader 2^>nul') do echo         %%l
)
echo.

echo [3/5] Trying to import torch:
python -c "import torch;print('        OK, version', torch.__version__, '| cuda tag:', torch.version.cuda)"
if not errorlevel 1 goto IMPORT_OK

echo.
echo         Import failed - that is the c10.dll problem. Repairing.
echo.
echo [4/5] Removing the broken install ...
python -m pip uninstall -y torch torchvision torchaudio >nul 2>nul
echo       done.
echo.
echo [5/5] Installing %TORCH_VER% with CUDA (about 2.5 GB) ...
python -m pip install "torch==%TORCH_VER%" --index-url %CUDA_INDEX%
if errorlevel 1 goto PIPFAIL
echo.
echo Verifying:
python -c "import torch;print('        version:', torch.__version__);print('        cuda tag:', torch.version.cuda);print('        available:', torch.cuda.is_available())"
if errorlevel 1 goto VCFAIL
python -c "import sys,torch;sys.exit(0 if torch.cuda.is_available() else 1)"
if errorlevel 1 goto NOCUDA
echo.
echo ----------------------------------------------------------------
echo  Fixed, and the GPU is usable.
echo ----------------------------------------------------------------
echo.
echo Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0

:IMPORT_OK
echo.
echo         torch imports fine.
echo.
python -c "import sys,torch;sys.exit(0 if torch.version.cuda is None else 1)"
rem  torch.version.cuda is None means this is a CPU-only build.
python -c "import sys,torch;sys.exit(0 if torch.version.cuda is None else 1)"
if not errorlevel 1 goto NEEDCUDA
if errorlevel 1 goto NOCUDA
echo.
echo All good, no repair needed.
echo Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0

:NEEDCUDA
echo ================================================================
echo  [FOUND IT] You have the CPU-only build of PyTorch
echo ================================================================
echo.
echo  This is not a driver problem and not a hardware problem.
echo  PyPI's Windows torch wheel does not include CUDA, so a plain
echo  "pip install torch" silently gives you a CPU build.
echo.
echo  Reinstalling from PyTorch's CUDA index ...
echo.
python -m pip uninstall -y torch torchvision torchaudio >nul 2>nul
python -m pip install "torch==%TORCH_VER%" --index-url %CUDA_INDEX%
if errorlevel 1 goto PIPFAIL
echo.
echo Verifying:
python -c "import torch;print('        version:', torch.__version__);print('        cuda tag:', torch.version.cuda);print('        available:', torch.cuda.is_available())"
python -c "import sys,torch;sys.exit(0 if torch.cuda.is_available() else 1)"
if errorlevel 1 goto NOCUDA
echo.
echo ----------------------------------------------------------------
echo  Fixed - now running the CUDA build.
echo ----------------------------------------------------------------
echo.
echo Next step: run 2-selfcheck.bat
echo.
pause
exit /b 0

:NOCUDA
echo.
echo ================================================================
echo  [FAIL] CUDA build is in place but the GPU is still not usable
echo ================================================================
echo.
echo  Work through these in order:
echo.
echo    1. Run "nvidia-smi". If it fails, install the NVIDIA driver.
echo    2. Check the driver version shown above. CUDA 12.6 needs 527+.
echo       If yours is older, update the driver from nvidia.com.
echo    3. If you see "CUDA tag: None" in the output above, the CPU
echo       build is somehow still active -- check with "pip show torch"
echo       and look at the Location, then remove other torch copies.
echo.
echo  Send back the full output of this script if it still fails.
echo.
pause
exit /b 1

:PIPFAIL
echo.
echo [FAIL] pip install failed. See the error above.
echo  Needs network access to download.pytorch.org and about 6 GB free.
echo.
pause
exit /b 1

:VCFAIL
echo.
echo ================================================================
echo  Still failing - likely a missing C++ runtime
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
