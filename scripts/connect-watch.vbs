' Runs connect-watch.ps1 with no window. Started by Task Scheduler at login
' (see connect-watch-setup.ps1). A .vbs launcher is the reliable way to start
' PowerShell without a console window flashing up.
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
WScript.Quit CreateObject("WScript.Shell").Run("powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & dir & "\connect-watch.ps1""", 0, True)
