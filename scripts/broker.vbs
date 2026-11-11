' Runs the Tether broker (broker\tether-broker.mjs) with no window. Started by
' Task Scheduler at login (see broker-setup.ps1). Argument 1: full path of node.exe.
Dim fso, repo, node
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "node.exe"
If WScript.Arguments.Count > 0 Then node = WScript.Arguments(0)
WScript.Quit CreateObject("WScript.Shell").Run("""" & node & """ """ & repo & "\broker\tether-broker.mjs""", 0, True)
