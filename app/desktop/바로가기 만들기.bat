@echo off
rem TWIN Reservoir Lab: creates shortcuts on the Desktop and in the Start menu. Run after unzipping (keep this folder together).
set "APPDIR=%~dp0"
set "APP=%APPDIR%TWIN Reservoir Lab.exe"
if not exist "%APP%" (
  echo TWIN Reservoir Lab.exe was not found next to this script.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = New-Object -ComObject WScript.Shell; $targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')); foreach ($d in $targets) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }; $l = $s.CreateShortcut((Join-Path $d 'TWIN Reservoir Lab.lnk')); $l.TargetPath = '%APP%'; $l.WorkingDirectory = '%APPDIR%'; $l.IconLocation = '%APP%,0'; $l.Description = 'TWIN Reservoir Lab'; $l.Save() }"
if errorlevel 1 (
  echo Could not create the shortcuts.
) else (
  echo Shortcuts created: Desktop and Start menu ^(TWIN Reservoir Lab^).
)
pause
