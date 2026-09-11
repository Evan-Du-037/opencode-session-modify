@echo off
rem build-windows.bat — Build ocedit.exe + create Desktop shortcut.
rem Delegates to build-windows.ps1 for the real work.

set "PS=pwsh.exe"
where %PS% >nul 2>&1
if errorlevel 1 set "PS=powershell.exe"

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1"
exit /b %ERRORLEVEL%