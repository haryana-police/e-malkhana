@echo off
REM Daily e-Malkhana backup launcher
REM Used by Windows Task Scheduler to call the bash script.
REM
REM Schedule:
REM   taskschd.msc → Create Basic Task → Daily 02:00
REM   Program: C:\Users\gsash\e-malkhana\server\scripts\backup-to-drive.cmd
REM   Start in: C:\Users\gsash\e-malkhana

setlocal
cd /d C:\Users\gsash\e-malkhana

"C:\Users\gsash\AppData\Local\hermes\git\usr\bin\bash.exe" -lc "cd /c/Users/gsash/e-malkhana && bash server/scripts/backup-to-drive.sh"

endlocal