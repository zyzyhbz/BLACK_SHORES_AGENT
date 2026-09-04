' BLACK_SHORES_AGENT windowless launcher.
' Runs node server.js with no console allocated, so Windows Terminal
' (when set as default console host) never surfaces a tab for it and
' closing any terminal window can no longer kill the service.
' Logs keep going to data\service.stdout.log / service.stderr.log.
Option Explicit
Dim shell, fso, root, nodeExe, logDir, stdoutPath, stderrPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = shell.ExpandEnvironmentStrings("%BLACK_SHORES_NODE%")
If nodeExe = "%BLACK_SHORES_NODE%" Or nodeExe = "" Then nodeExe = "node"
logDir = fso.BuildPath(root, "data")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
stdoutPath = fso.BuildPath(logDir, "service.stdout.log")
stderrPath = fso.BuildPath(logDir, "service.stderr.log")
shell.CurrentDirectory = root
command = "%COMSPEC% /c (netstat -ano | findstr ""LISTENING"" | findstr "":4782 "") >nul 2>&1 || (""" & nodeExe & """ server.js >>""" & stdoutPath & """ 2>>""" & stderrPath & """)"
shell.Run command, 0, False
