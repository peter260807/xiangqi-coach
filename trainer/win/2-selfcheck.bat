@echo off
rem ===================================================================
rem  Keep this file PURE ASCII. Do not add non-ASCII characters.
rem  cmd.exe reads .bat using the system OEM code page (936/GBK on
rem  Chinese Windows). UTF-8 CJK text gets mis-decoded and can break
rem  parsing so the script fails to run. "chcp 65001" only changes
rem  console OUTPUT, not how cmd READS the file.
rem ===================================================================
chcp 65001 >nul
setlocal
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
cd /d "%~dp0.."

echo ================================================================
echo  Step 2/5 - Environment self-check
echo ================================================================
echo.

if not exist "engine" (
  echo [INFO] No engine folder yet, creating it ...
  mkdir "engine" 2>nul
)

set HAVEENGINE=0
for %%f in (engine\pikafish.exe) do if exist "%%f" set HAVEENGINE=1
for %%f in (engine\pikafish*.exe) do if exist "%%f" set HAVEENGINE=1

if "%HAVEENGINE%"=="0" (
  echo ----------------------------------------------------------------
  echo [ACTION REQUIRED] Put the Pikafish engine in place
  echo ----------------------------------------------------------------
  echo.
  echo  1. Open https://github.com/official-pikafish/Pikafish/releases
  echo  2. Download the latest Pikafish.YYYY-MM-DD.7z
  echo  3. Extract it, then copy these two files into the engine\ folder:
  echo       Pikafish-Windows-x86-64-universal.exe  (rename to pikafish.exe)
  echo       pikafish.nnue                          (about 50 MB)
  echo.
  echo  The exe and the nnue file MUST be in the same folder.
  echo.
)

python src\selfcheck.py %*
echo.
pause
