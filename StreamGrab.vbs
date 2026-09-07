' Launches StreamGrab silently (no console window).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\Anirudh\Coding Projects\Claude Code\Download Manager"
sh.Run "cmd /c npm start", 0, False
