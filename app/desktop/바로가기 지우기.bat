@echo off
rem TWIN Reservoir Lab: removes the shortcuts made by the other script. The program folder itself is not deleted.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')); foreach ($d in $targets) { $p = Join-Path $d 'TWIN Reservoir Lab.lnk'; if (Test-Path $p) { Remove-Item $p } }"
echo Shortcuts removed. Delete this folder to uninstall the program completely.
pause
