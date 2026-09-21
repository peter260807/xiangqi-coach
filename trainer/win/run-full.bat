@echo off
rem ===================================================================
rem  ONE-CLICK FULL PIPELINE for a long unattended run (default ~10h)
rem
rem    data generation -> dataset stats -> training -> export
rem    -> verify -> strength evaluation -> package results
rem
rem  ------------------------------------------------------------------
rem  KEEP THIS FILE PURE ASCII. Do not add non-ASCII characters.
rem
rem  cmd.exe reads a .bat using the system OEM code page (936/GBK on
rem  Chinese Windows). UTF-8 CJK text gets mis-decoded and can break
rem  parsing. "chcp 65001" only changes console OUTPUT, it does NOT
rem  change how cmd READS the file. Every other bat in this folder
rem  follows the same rule for the same reason.
rem
rem  No "for" loops and no delayed expansion here on purpose. An
rem  earlier version lost one space in "setlocal enabledelayedexpansion"
rem  and every !VAR! silently turned into literal text -- the symptom
rem  looked like a bad engine path. Plain %VAR% only, no parentheses
rem  blocks, goto for all branching.
rem  ------------------------------------------------------------------
rem
rem  Budget with the defaults below, on 8C/16T + a mid GPU:
rem    generation  540 min  ->  roughly 60-90 million records, 6-8 GB
rem    training    8 epochs ->  roughly 20-40 min (after de-duplication)
rem    export+verify+eval   ->  roughly 12 min
rem    total about 9.5-10 hours, leaving headroom inside a 12h window.
rem
rem  Disk: make sure there is at least 20 GB free. Generation writes
rem  6-8 GB, and training loads all of it into RAM (about 2x peak).
rem ===================================================================
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

rem ===================================================================
rem  CONFIG - edit these numbers only
rem ===================================================================
set WORKERS=14
set DEPTH=8
set OPENING=14
set GENMINUTES=540
set EPOCHS=8
set BATCH=8192
set LR=0.001
set L1=512
set L2=64
set EVALPOS=500
set DATADIR=data\v2
set OUTDIR=logs\v2
set RESDIR=results
set NET=%OUTDIR%\xq-v2.xqnn
rem ===================================================================

echo ================================================================
echo  XiangqiCoach NNUE - one-click full pipeline
echo ================================================================
echo.
echo   data generation : %GENMINUTES% minutes, %WORKERS% workers, depth %DEPTH%
echo   data diversity  : --opening-plies %OPENING%
echo   network         : 1260 - %L1% - %L2% - 1
echo   training        : %EPOCHS% epochs, batch %BATCH%
echo   eval benchmark  : %EVALPOS% positions
echo.
echo   started at %DATE% %TIME%
echo.

if not exist "%OUTDIR%" mkdir "%OUTDIR%"
if not exist "%RESDIR%" mkdir "%RESDIR%"

rem ===================================================================
echo ================================================================
echo  [0/7] Environment self-check
echo ================================================================
python src\selfcheck.py
if errorlevel 1 echo   [WARN] self-check reported problems - read the lines above.
echo.

rem ===================================================================
echo ================================================================
echo  [1/7] Generating data         started at %TIME%
echo ================================================================
rem  gen_data opens part_*.bin in APPEND mode. If the folder already
rem  exists, old and new data would be mixed into the same shards, so
rem  an existing folder has to go. Ask before deleting anything.
if not exist "%DATADIR%" goto GEN
echo   WARNING: %DATADIR% already exists.
echo.
echo   gen_data APPENDS to part_*.bin, so old and new data would be
echo   merged into the same files and the duplicate rate would be
echo   meaningless. The folder will be DELETED.
echo.
echo   Press Ctrl+C now to abort, or
pause
rd /s /q "%DATADIR%"
:GEN
if not exist "%DATADIR%" mkdir "%DATADIR%"

python src\gen_data.py --workers %WORKERS% --depth %DEPTH% --opening-plies %OPENING% --minutes %GENMINUTES% --out %DATADIR%
if errorlevel 1 goto FAIL
echo   data generation finished at %TIME%
echo.

rem ===================================================================
echo ================================================================
echo  [2/7] Dataset statistics
echo ================================================================
rem  Record count is a nearly useless number: with a small
rem  --opening-plies most of it is duplicated positions. This step
rem  reports the UNIQUE position count and the duplicate rate, which
rem  is what actually decides how much the network can learn.
python src\dataset_info.py --data %DATADIR% > "%RESDIR%\01-dataset-info.txt" 2>&1
if errorlevel 1 goto FAIL
type "%RESDIR%\01-dataset-info.txt"
echo.

rem ===================================================================
echo ================================================================
echo  [3/7] Training                started at %TIME%
echo ================================================================
echo   De-duplication and the train/val split both key off the
echo   position hash, so no position can leak across the two sets.
python src\train.py --data %DATADIR% --out %OUTDIR% --epochs %EPOCHS% --batch %BATCH% --lr %LR% --l1 %L1% --l2 %L2%
if errorlevel 1 goto FAIL
echo   training finished at %TIME%
echo.

rem ===================================================================
echo ================================================================
echo  [4/7] Export + roundtrip check
echo ================================================================
python src\export.py --weights %OUTDIR%\weights.pt --out %NET% > "%RESDIR%\02-export.txt" 2>&1
if errorlevel 1 goto FAIL
type "%RESDIR%\02-export.txt"
echo.

rem ===================================================================
echo ================================================================
echo  [5/7] Fit report
echo ================================================================
python src\verify.py --data %DATADIR% --net %NET% --samples 4000 --show 3 > "%RESDIR%\03-verify.txt" 2>&1
if errorlevel 1 goto FAIL
type "%RESDIR%\03-verify.txt"
echo.

rem ===================================================================
echo ================================================================
echo  [6/7] Strength evaluation     started at %TIME%
echo ================================================================
rem  This is the test that matters. It is NOT the same thing as the
rem  fit report above: a network can track the engine's score closely
rem  and still pick the wrong move.
echo   %EVALPOS% positions, MultiPV 8, benchmark depth 10. Takes a while.
python tests\eval_net_strength.py --data %DATADIR% --net %NET% --positions %EVALPOS% --multipv 8 --depth 10 --seed 7 --dump "%RESDIR%\positions.json" > "%RESDIR%\04-strength.txt" 2>&1
if errorlevel 1 goto FAIL
type "%RESDIR%\04-strength.txt"
echo.

where node >nul 2>nul
if errorlevel 1 goto NONODE
echo   node.js found - running the handcrafted comparison
node tests\eval_handcrafted.js "%RESDIR%\positions.json" "%RESDIR%\ranks.json" > "%RESDIR%\05-handcrafted.txt" 2>&1
if errorlevel 1 goto NONODE
type "%RESDIR%\05-handcrafted.txt"
goto PACK

:NONODE
echo   [skip] node.js not found, so the handcrafted comparison is skipped.
echo          Install Node.js and run this to add it afterwards:
echo            node tests\eval_handcrafted.js results\positions.json results\ranks.json
echo.

rem ===================================================================
:PACK
echo ================================================================
echo  [7/7] Packaging results
echo ================================================================
copy /y "%NET%"                 "%RESDIR%\" >nul
copy /y "%OUTDIR%\train.log"    "%RESDIR%\" >nul
copy /y "%OUTDIR%\ckpt.pt"      "%RESDIR%\" >nul
echo   Copied network, train log and checkpoint into %RESDIR%\
dir /b "%RESDIR%"
echo.

echo ================================================================
echo  All done at %DATE% %TIME%
echo ================================================================
echo.
echo  Send back the whole "%RESDIR%" folder. Contents:
echo    xq-v2.xqnn          the trained network (about 2.6 MB)
echo    train.log           full training log
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

rem ===================================================================
:FAIL
echo.
echo ================================================================
echo  FAILED - read the message above this line first.
echo ================================================================
echo.
echo  Most common causes:
echo.
echo   1. Engine missing. Put these two files side by side in engine\ :
echo        Pikafish-Windows-x86-64-universal.exe   (rename to pikafish.exe)
echo        pikafish.nnue                           (about 50 MB)
echo      https://github.com/official-pikafish/Pikafish/releases
echo.
echo   2. PyTorch missing or installed as the CPU-only build.
echo      Run 0-fix-torch.bat, then 1-install.bat again.
echo.
echo   3. Out of disk. Generation writes 6-8 GB.
echo.
echo  Partial results, if any, are in %RESDIR%\
echo.
pause
exit /b 1
