@echo off
rem mcp.cmd — Windows launcher for the mcp-chrome-bridge CLI
setlocal
node "%~dp0scripts\mcp.js" %*
exit /b %errorlevel%
