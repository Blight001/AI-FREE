@echo off
setlocal EnableExtensions

rem Canonical local-HeySure launcher. The account backend remains production.
call "%~dp0v-start.bat" --local
exit /b %ERRORLEVEL%
