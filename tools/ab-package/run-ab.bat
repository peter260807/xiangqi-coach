@echo off
REM ============================================================
REM  Xiangqi engine A/B match  -  Windows one-click
REM
REM  A = new      web/js/engine.js
REM  B = baseline baseline/engine.js, i.e. git HEAD
REM
REM  Usage:
REM     run-ab.bat            all mode   - default, what we intend to ship
REM     run-ab.bat perp       long-check fix only
REM
REM  all  : A = long-check fix + LMR + null-move pruning
REM         A 40-game run measured +158 Elo, CI [+64,+251], so this is the
REM         configuration we want to ship. This run is its confirmation.
REM  perp : A = long-check fix only, LMR / null-move forced OFF
REM         isolates the long-check fix from the pruning
REM
REM  "full" is a synonym of all, "safe" is a synonym of perp.
REM
REM  Result:  ab-result-<mode>.txt      readable report, send this back
REM           ab-progress-<mode>.jsonl  per-game log, enables resume
REM
REM  RESUME: if the machine reboots or you close the window, just run this
REM  again. It picks up from the last finished game. Do NOT pass --fresh
REM  unless you really want to throw the progress away.
REM
REM  STYLE NOTES - two cmd.exe traps this file deliberately avoids:
REM
REM  1. NO parenthesised "if ... ( ... )" blocks. A right paren inside echo
REM     text closes the block early and the rest of the line is parsed as a
REM     command - the infamous "and was unexpected at this time". We use
REM     goto labels instead, and keep parens out of echo text entirely.
REM  2. Pure ASCII, CRLF, no BOM. cmd.exe reads .bat with the OEM codepage
REM     - GBK on a Chinese Windows - so UTF-8 comments would be garbled and
REM     can break parsing. Chinese notes live in README.md instead.
REM ============================================================
setlocal
cd /d "%~dp0"

set MODE=%1
set EXTRA=

REM ---- tweak these if you want a different workload ----
set GAMES=1200
set MS=300
set OPENINGS=8
set OPENPLIES=8
set RANDOMPLIES=4
REM -----------------------------------------------------

if "%MODE%"=="" set MODE=all
if /i "%MODE%"=="--fresh" goto fresh_only
if /i "%2"=="--fresh" set EXTRA=--fresh
goto mode_dispatch

:fresh_only
REM A lone --fresh means "all mode, throw the progress away and start over".
set MODE=all
set EXTRA=--fresh

:mode_dispatch
if /i "%MODE%"=="all"  goto mode_all
if /i "%MODE%"=="full" goto mode_all
if /i "%MODE%"=="perp" goto mode_perp
if /i "%MODE%"=="safe" goto mode_perp

echo.
echo  [ERROR] unknown mode "%MODE%".
echo  Use:  run-ab.bat          - all mode, the default
echo        run-ab.bat perp     - long-check fix only
echo        run-ab.bat --fresh  - all mode, discard old progress
echo.
pause
exit /b 2

:mode_all
set MODE_DESC=long-check fix + LMR + null-move pruning
REM Pruning is ON by default in engine.js, so these two lines are redundant
REM today -- they are written out on purpose. An explicit positive switch
REM cannot be broken by a future change of the default. We already got bitten
REM once: a mode branch forgot to set anything, ran identical to the other
REM mode, and still reported "finished".
set XQ_LMR=1
set XQ_NULL=1
goto check_node

:mode_perp
set MODE_DESC=long-check fix only, pruning forced OFF
REM Both engines read the same environment, but the baseline has no pruning
REM code at all, so turning it off only affects A. That is what we want.
set XQ_NO_LMR=1
set XQ_NO_NULL=1
goto check_node

:check_node
where node >nul 2>&1
if errorlevel 1 goto no_node
goto go

:no_node
echo.
echo  [ERROR] node.exe not found in PATH.
echo.
echo  Install Node.js LTS from https://nodejs.org/
echo  or unzip a portable build such as node-v22-win-x64.zip and add
echo  its folder to PATH, then run this again.
echo.
pause
exit /b 1

:go
echo Node version:
node --version
echo.
echo ============================================================
echo   A/B match :  A = new  --  %MODE_DESC%
echo                B = baseline, git HEAD
echo.
echo   %MS% ms per move ^| %GAMES% games ^| %OPENINGS% openings x %OPENPLIES% plies
echo   plus %RANDOMPLIES% random plies per pair  ^|  colors alternate
echo.
echo   Each pair of games starts from the SAME position and swaps colors.
echo   Different pairs start from different positions.
echo.
echo   Estimated 8-11 hours. If it gets interrupted, just run this again:
echo   it resumes from the last finished game.
echo ============================================================
echo.
echo Engine file fingerprints, sha256 first 16 chars:
node -e "const c=require('crypto'),f=require('fs');for(const p of ['web/js/engine.js','baseline/engine.js']){console.log('  '+p+'  '+c.createHash('sha256').update(f.readFileSync(p)).digest('hex').slice(0,16));}"
echo.

node tools/match.js --a js --b js:baseline/engine.js --ms %MS% --games %GAMES% --openings %OPENINGS% --open-plies %OPENPLIES% --random-plies %RANDOMPLIES% --gamelog ab-progress-%MODE%.jsonl %EXTRA% > ab-result-%MODE%.txt 2>&1

if errorlevel 3 goto bad_resume
if errorlevel 1 goto run_failed
goto finished

:bad_resume
echo.
echo ============================================================
echo   Refused to resume: ab-progress-%MODE%.jsonl was produced
echo   with a DIFFERENT configuration, so mixing the games would
echo   give a meaningless Elo. See ab-result-%MODE%.txt.
echo.
echo   To start over, run:   run-ab.bat %MODE% --fresh
echo ============================================================
pause
exit /b 3

:run_failed
echo.
echo ============================================================
echo   The match exited with an error. See ab-result-%MODE%.txt
echo   Nothing is lost - run this script again to resume.
echo ============================================================
pause
exit /b 1

:finished
echo.
echo ============================================================
echo   Finished. Send these two files back:
echo     ab-result-%MODE%.txt      readable report
echo     ab-progress-%MODE%.jsonl  per-game log
echo ============================================================
pause
