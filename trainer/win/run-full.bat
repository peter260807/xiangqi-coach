@echo off
rem ===================================================================
rem  XiangqiCoach NNUE - one click full pipeline (resumable)
rem
rem  This file is deliberately THIN: every "is this step already done"
rem  decision lives in src\pipeline.py, where it can be tested. The
rem  previous version of this script DELETED the data folder whenever it
rem  found one, so a Windows update rebooting the machine halfway
rem  through a 540-minute data run threw all of that work away.
rem
rem  Usage:
rem    run-full.bat            resume - finished steps are skipped
rem    run-full.bat --fresh    ignore all progress, start over
rem    run-full.bat --status   only print what is done, run nothing
rem
rem  Tune parameters in src\pipeline.py (the CONFIG block at the top),
rem  not here. This file must stay pure ASCII + CRLF to survive the
rem  GBK code page that cmd.exe uses for reading batch files.
rem ===================================================================

setlocal

rem  Always run from the trainer folder, so src\ and data\ resolve no
rem  matter whether this was double-clicked or started from a console.
cd /d "%~dp0.."

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo ================================================================
echo  XiangqiCoach NNUE - full pipeline
echo ================================================================
echo   started at %DATE% %TIME%
echo.

if /i "%~1"=="--status" goto STATUS
if /i "%~1"=="--fresh"  goto FRESH
goto RUN

:STATUS
python src\pipeline.py status
echo.
pause
exit /b 0

:FRESH
python src\pipeline.py run --fresh
if errorlevel 1 goto FAIL
goto DONE

:RUN
python src\pipeline.py run
if errorlevel 1 goto FAIL
goto DONE

:DONE
echo.
echo ================================================================
echo  All done at %DATE% %TIME%
echo ================================================================
echo.
echo  Send back the whole results\ folder. It contains:
echo    xq-v2.xqnn          the trained network
echo    train.log           full training log (across restarts)
echo    ckpt.pt             checkpoint, lets training resume
echo    01-dataset-info.txt records / unique positions / duplicate rate
echo    02-export.txt       export + independent roundtrip check
echo    03-verify.txt       fit report
echo    04-strength.txt     strength evaluation (rank + centipawn loss)
echo    05-handcrafted.txt  paired test against the handcrafted eval
echo    positions.json      positions and candidates, for re-checking
echo.
pause
exit /b 0

:FAIL
echo.
echo ================================================================
echo  FAILED - read the message above this line first.
echo ================================================================
echo.
echo  Most common causes:
echo.
echo   1. engine\ missing these two files (side by side):
echo        Pikafish-Windows-x86-64-universal.exe   (rename to pikafish.exe)
echo        pikafish.nnue                           (about 50 MB)
echo      https://github.com/official-pikafish/Pikafish/releases
echo.
echo   2. PyTorch installed as the CPU-only build.
echo      Run 0-fix-torch.bat, then 1-install.bat again.
echo.
echo   3. Out of disk. Generation writes 6-8 GB.
echo.
echo  Just run this script again after fixing it: finished steps are
echo  skipped, data generation continues from the existing shards, and
echo  training continues from the last completed epoch.
echo.
pause
exit /b 1
