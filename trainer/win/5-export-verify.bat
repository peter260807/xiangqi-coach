@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo ================================================================
echo  步骤 5 / 5   导出网络 + 验证效果
echo ================================================================
echo.

if not exist "logs\weights.pt" (
  echo [失败] 找不到 logs\weights.pt，请先跑 4-train.bat 完成训练。
  echo.
  pause
  exit /b 1
)

echo ----------------------------------------------------------------
echo  导出为引擎可加载的格式
echo ----------------------------------------------------------------
echo.
python src\export.py --weights logs\weights.pt --out logs\xq-v1.xqnn
if errorlevel 1 goto EXPORTFAIL

echo.
echo ----------------------------------------------------------------
echo  验证训练效果
echo ----------------------------------------------------------------
echo.
python src\verify.py --data data --net logs\xq-v1.xqnn --samples 4000 --show 3

echo.
echo ================================================================
echo  完成
echo ================================================================
echo.
echo 产出文件：
echo   logs\xq-v1.xqnn   最终网络（引擎可以加载这个文件）
echo   logs\weights.pt   训练权重（可以继续训练）
echo   logs\train.log    训练日志
echo   data\part_*.bin   训练数据（确认没问题后可以删掉腾空间）
echo.
echo 把 logs\xq-v1.xqnn 连同上面这份验证输出发回来即可。
echo.
pause
exit /b 0

:EXPORTFAIL
echo.
echo [失败] 导出过程出错，请把上面的报错信息发回来。
echo.
pause
exit /b 1
