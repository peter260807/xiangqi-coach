@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  步骤 1 / 5   安装依赖
echo ================================================================
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPYTHON

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo 检测到 Python %PYVER%

python -c "import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)"
if errorlevel 1 goto OLDPY
echo.

echo [1/3] 升级 pip ...
python -m pip install --upgrade pip --quiet
echo [2/3] 安装 numpy ...
python -m pip install numpy --quiet
echo [3/3] 安装 PyTorch（带 CUDA，下载量较大请耐心等待）...
python -m pip install torch --quiet

echo.
echo ----------------------------------------------------------------
echo 检查 GPU 是否可用
echo ----------------------------------------------------------------
python -c "import torch;print('  PyTorch 版本:',torch.__version__);print('  CUDA 可用  :',torch.cuda.is_available());print('  CUDA 版本  :',torch.version.cuda);print('  设备       :',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU（训练会慢很多）')"

echo.
echo 安装完成。下一步跑：2-selfcheck.bat
echo.
pause
exit /b 0

:NOPYTHON
echo [失败] 没有找到 python 命令。
echo.
echo 请先安装 Python（3.10 或更高版本）：
echo   https://www.python.org/downloads/
echo.
echo 安装时务必勾选 "Add python.exe to PATH"，否则命令行里找不到它。
echo.
pause
exit /b 1

:OLDPY
echo.
echo [失败] Python 版本低于 3.9，请升级。
echo.
pause
exit /b 1
