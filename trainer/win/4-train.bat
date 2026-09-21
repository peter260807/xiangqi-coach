@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  步骤 4 / 5   训练网络
echo ================================================================
echo.

rem ===================================================================
rem  可以按需要改下面这几个参数
rem
rem  EPOCHS  把数据过几遍。数据越多、轮次越多效果越好，但要控制总时间
rem  BATCH   每批样本数。2080Ti 11G 显存跑 8192 没问题，可以再调大
rem  LR      学习率
rem ===================================================================
set EPOCHS=8
set BATCH=8192
set LR=0.001
rem ===================================================================

if not exist "data" (
  echo [失败] 没有 data 目录，请先跑 3-gen-data.bat 生成数据。
  echo.
  pause
  exit /b 1
)

dir /b data\part_*.bin >nul 2>nul
if errorlevel 1 (
  echo [失败] data 目录里没有 part_*.bin 数据文件。
  echo        请先跑 3-gen-data.bat。
  echo.
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs" 2>nul

echo 轮次      : %EPOCHS%
echo 批大小    : %BATCH%
echo 学习率    : %LR%
echo 数据目录  : data\
echo 输出目录  : logs\
echo.
echo 每轮结束都会保存 checkpoint（logs\ckpt.pt），
echo 中途想停下来按 Ctrl+C 即可，已保存的进度不会丢。
echo.
echo ----------------------------------------------------------------
echo.

python src\train.py --data data --out logs --epochs %EPOCHS% --batch %BATCH% --lr %LR%

echo.
echo 下一步跑：5-export-verify.bat
echo.
pause
