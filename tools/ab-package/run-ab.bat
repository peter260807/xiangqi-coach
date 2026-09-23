@echo off
REM ============================================================
REM  Xiangqi engine A/B match  (Windows one-click)
REM
REM  A = new      (web/js/engine.js)
REM  B = baseline (baseline/engine.js, i.e. git HEAD)
REM
REM  Usage:
REM     run-ab.bat            safe mode  (default)
REM     run-ab.bat full       full pruning mode
REM
REM  safe : A = long-check fix only (LMR / null-move disabled)
REM  full : A = long-check fix + LMR + null-move pruning
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
if "%MODE%"=="" set MODE=safe

set GAMES=1200
set MS=300
set OPENINGS=8
set OPENPLIES=8
set RANDOMPLIES=4

if /i "%MODE%"=="full" goto mode_full
if /i "%MODE%"=="safe" goto mode_safe
echo.
echo  [ERROR] unknown mode "%MODE%".  Use:  run-ab.bat  or  run-ab.bat full
echo.
pause
exit /b 2

:mode_full
set MODE_DESC=long-check fix + LMR + null-move pruning
REM Pruning is OFF by default in engine.js (not yet proven by a large A/B),
REM so this mode has to switch it ON explicitly. Without these two lines
REM "full" would silently be identical to "safe".
set XQ_LMR=1
set XQ_NULL=1
goto go

:mode_safe
set MODE_DESC=long-check fix only (pruning OFF)
REM Redundant today (pruning is already off by default) but written out on
REM purpose: if the default is ever flipped after a positive A/B, this mode
REM must still mean "no pruning". Both engines read the same env, but the
REM baseline has no pruning code at all, so it is unaffected either way.
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
