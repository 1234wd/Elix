@echo off
REM ---------------------------------------------------------------------------
REM  run-elix-agent.cmd - keeps the OpenCode agent working on Elix without you.
REM
REM  It starts a fresh "opencode run --auto" session, waits for it to finish,
REM  and starts the next one, which picks up from PROGRESS.md. It stops when:
REM    - PROGRESS.md contains the line  ROUND 20 COMPLETE
REM    - two sessions in a row made no new git commit (stuck), or
REM    - MAX_SESSIONS sessions have run.
REM
REM  Put this file in your elix folder (the one that contains the Elix folder),
REM  double-click it, and leave the window open. The final report is written to
REM  Elix\docs\ROUND20_REPORT.md.
REM ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set MAX_SESSIONS=15
set /a SESSION=0
set /a STUCK=0

where opencode >nul 2>&1
if errorlevel 1 (
  echo OpenCode was not found. Open a new terminal after installing it, or add it to PATH.
  pause
  exit /b 1
)

:loop
findstr /C:"ROUND 20 COMPLETE" "Elix\PROGRESS.md" >nul 2>&1
if not errorlevel 1 goto finished

set /a SESSION+=1
if !SESSION! GTR %MAX_SESSIONS% goto limit

for /f %%h in ('git rev-parse HEAD') do set BEFORE=%%h
echo.
echo ===== Elix agent session !SESSION! of %MAX_SESSIONS%  (%date% %time%) =====
opencode run --auto "Read Elix/docs/LONG_RUN_BRIEF.md and Elix/PROGRESS.md first, then continue from the first unfinished item. Every rule in the brief applies. Do not stop to report between items. When every item is DONE, PARTIAL or BLOCKED, write the final report to Elix/docs/ROUND20_REPORT.md, commit it, and add the line ROUND 20 COMPLETE as the last line of Elix/PROGRESS.md."

for /f %%h in ('git rev-parse HEAD') do set AFTER=%%h
if "!BEFORE!"=="!AFTER!" (
  set /a STUCK+=1
  echo Session !SESSION! made no new commit. ^(!STUCK! in a row^)
  if !STUCK! GEQ 2 goto stuck
) else (
  set /a STUCK=0
)
timeout /t 15 /nobreak >nul
goto loop

:finished
echo.
echo Round 20 is complete. Report: Elix\docs\ROUND20_REPORT.md
goto end

:stuck
echo.
echo Stopped: two sessions in a row made no progress. Check Elix\PROGRESS.md.
goto end

:limit
echo.
echo Stopped after %MAX_SESSIONS% sessions. Check Elix\PROGRESS.md.

:end
pause
