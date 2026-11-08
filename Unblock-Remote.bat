@echo off
rem Undo Block-Remote.bat. Asks for admin.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scriptsridge-block.ps1" -Undo
