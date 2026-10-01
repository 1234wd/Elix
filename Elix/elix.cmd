@echo off
rem Elix Windows wrapper. Prefers the built release; falls back to tsx (dev).
setlocal
if exist "%~dp0dist\cli\index.js" (
  node "%~dp0dist\cli\index.js" %*
) else (
  "%~dp0node_modules\.bin\tsx.cmd" "%~dp0src\cli\index.ts" %*
)
