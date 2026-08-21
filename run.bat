@echo off
setlocal EnableExtensions

rem Canonical launcher: production account backend and default HeySure server.
call "%~dp0v-start.bat"
exit /b %ERRORLEVEL%
