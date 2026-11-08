@echo off
rem Undo Block-Remote.bat. Asks for admin.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bridge-block.ps1" -Undo
