' Freebuff Proxy Auto-Start (hidden)
' Runs freebuff-proxy server.js without showing a console window at boot.
' Logs output to freebuff-proxy\server.log

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

proxyDir = "C:\Users\TUF Gaming A15\freebuff-proxy"
logFile = proxyDir & "\server.log"

' Start node hidden, redirect stdout/stderr to log
cmd = "cmd /c cd /d """ & proxyDir & """ && node server.js >> """ & logFile & """ 2>&1"
WshShell.Run cmd, 0, False