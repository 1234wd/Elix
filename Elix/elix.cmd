@echo off
rem Elix launcher for Windows CMD. Run `elix start` from any folder.
rem
rem Prefers the built release (dist/cli/index.js); falls back to running the
rem TypeScript sources with tsx so `elix start` works before `pnpm build`.
rem
rem Add this folder to PATH, or make a copy of this file named `elix.bat` in a
rem directory that is already on your PATH:
rem     copy elix.cmd C:\Tools\elix.bat
setlocal
set "ELIX_HOME=%~dp0"

if exist "%ELIX_HOME%dist\cli\index.js" (
  node "%ELIX_HOME%dist\cli\index.js" %*
  exit /b %ERRORLEVEL%
)

if exist "%ELIX_HOME%node_modules\.bin\tsx.cmd" (
  "%ELIX_HOME%node_modules\.bin\tsx.cmd" "%ELIX_HOME%src\cli\bin.ts" %*
  exit /b %ERRORLEVEL%
)

echo Elix is not installed here. Run this in %ELIX_HOME%:
echo     pnpm install
echo     pnpm build
exit /b 1