@echo off
REM ============================================================
REM  Xiangqi engine A/B match  (Windows one-click)
REM
REM  A = new      (web/js/engine.js)
REM  B = baseline (baseline/engine.js, i.e. git HEAD)
REM
REM  Usage:
REM     run-ab.bat            all mode   (default) = what we intend to ship
REM     run-ab.bat perp       long-check fix only
REM
REM  all  : A = long-check fix + LMR + null-move pruning
REM         (a 40-game run measured +158 Elo, CI [+64,+251], so this is
REM          the configuration we want to ship; this run is its confirmation)
REM  perp : A = long-check fix only (LMR / null-move forced OFF)
REM         isolates the long-check fix from the pruning
REM
REM  "full" is accepted as a synonym of all, "safe" as a synonym of perp.
REM
REM  Result is written to ab-result-<mode>.txt -- please send it back.
REM
REM  NOTE: this file is deliberately pure ASCII. cmd.exe reads .bat
REM  with the OEM codepage (GBK on a Chinese Windows), so UTF-8
REM  Chinese comments would be garbled and can break parsing.
REM  Chinese notes live in README.md instead.
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [ERROR] node.exe not found in PATH.
  echo.
  echo  Install Node.js LTS from https://nodejs.org/
  echo  or unzip a portable build (node-v22-win-x64.zip) and add
  echo  its folder to PATH, then run this again.
  echo.
  pause
  exit /b 1
)

set MODE=%1
if "%MODE%"=="" set MODE=all

set GAMES=1200
set MS=300
set OPENINGS=8
set OPENPLIES=8
set RANDOMPLIES=4

if /i "%MODE%"=="all"  goto mode_all
if /i "%MODE%"=="full" goto mode_all
if /i "%MODE%"=="perp" goto mode_perp
if /i "%MODE%"=="safe" goto mode_perp
echo.
echo  [ERROR] unknown mode "%MODE%".  Use:  run-ab.bat  or  run-ab.bat perp
echo.
pause
exit /b 2

:mode_all
set MODE_DESC=long-check fix + LMR + null-move pruning
REM Pruning is ON by default in engine.js, so these two lines are redundant
REM today -- but they are written out on purpose: an explicit positive switch
REM cannot be broken by a future change of the default. (We already got bitten
REM once by relying on the default: the "full" branch forgot to set anything,
REM so it silently ran identical to "safe" while still reporting "finished".)
set XQ_LMR=1
set XQ_NULL=1
goto go

:mode_perp
set MODE_DESC=long-check fix only (pruning forced OFF)
REM Both engines read the same env, but the baseline has no pruning code at
REM all, so turning it off only affects A. That is exactly what we want here.
set XQ_NO_LMR=1
set XQ_NO_NULL=1
goto go

:go
echo Node version:
node --version
echo.
echo ============================================================
echo   A/B match :  A = new (%MODE_DESC%)
echo                B = baseline (git HEAD)
echo.
echo   %MS% ms per move ^| %GAMES% games ^| %OPENINGS% openings x %OPENPLIES% plies
echo   + %RANDOMPLIES% random plies per pair  ^|  colors alternate
echo.
echo   Each pair of games starts from the SAME position and
echo   swaps colors. Different pairs start from different
echo   positions, so games are not replays of each other.
echo.
echo   Estimated 8-11 hours. Keep this window open.
echo ============================================================
echo.
echo Engine file fingerprints (sha256, first 16 chars):
node -e "const c=require('crypto'),f=require('fs');for(const p of ['web/js/engine.js','baseline/engine.js']){console.log('  '+p+'  '+c.createHash('sha256').update(f.readFileSync(p)).digest('hex').slice(0,16));}"
echo.

node tools/match.js --a js --b js:baseline/engine.js --ms %MS% --games %GAMES% --openings %OPENINGS% --open-plies %OPENPLIES% --random-plies %RANDOMPLIES% > ab-result-%MODE%.txt 2>&1

echo.
echo ============================================================
echo   Finished. Results are in  ab-result-%MODE%.txt
echo   Please send that file back.
echo ============================================================
pause
