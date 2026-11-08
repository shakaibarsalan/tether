@echo off
rem Cut Claude sessions on other computers off from this Chrome. Asks for admin.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bridge-block.ps1"
