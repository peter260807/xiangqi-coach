@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  修复 PyTorch 的 c10.dll 初始化失败
echo ================================================================
echo.
echo 这个报错的已知原因有三个，本脚本按顺序排查：
echo   1. PyTorch 2.9.x 本身有这个 bug（回退到 2.8.0 即可）
echo   2. 缺少 Visual C++ 运行库
echo   3. 装了 CUDA 版但机器环境不匹配
echo.

where python >nul 2>nul
if errorlevel 1 goto NOPY

echo [1/4] 当前安装的版本：
python -m pip show torch 2>nul | findstr /B /C:"Version:"
if errorlevel 1 echo         （没有安装 torch）
echo.

echo [2/4] 试着导入一次：
python -c "import torch; print('        导入成功，版本', torch.__version__)"
if not errorlevel 1 goto OK

echo.
echo         导入失败 —— 正是 c10.dll 的问题，开始修复。
echo.

echo [3/4] 卸载现有 PyTorch ...
python -m pip uninstall -y torch
echo.

echo [4/4] 安装 2.8.0（这个版本没有该问题）...
python -m pip install "torch==2.8.0"
echo.

echo 验证：
python -c "import torch;print('        PyTorch',torch.__version__);print('        CUDA 可用:',torch.cuda.is_available());print('        设备:',torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
if errorlevel 1 goto VCFAIL

echo.
echo ----------------------------------------------------------------
echo  修好了，接着跑 2-selfcheck.bat
echo ----------------------------------------------------------------
echo.
pause
exit /b 0

:VCFAIL
echo.
echo ================================================================
echo  换成 2.8.0 还是失败，那就是缺 Visual C++ 运行库
echo ================================================================
echo.
echo  下载安装这个（注意要 64 位那个 x64）：
echo    https://aka.ms/vs/17/release/vc_redist.x64.exe
echo.
echo  装完重启电脑，再跑一次本脚本。
echo.
pause
exit /b 1

:NOPY
echo [失败] 没找到 python 命令。请先跑 1-install.bat。
echo.
pause
exit /b 1

:OK
echo.
echo 一切正常，不需要修复。
echo 可以接着跑 2-selfcheck.bat。
echo.
pause
exit /b 0
