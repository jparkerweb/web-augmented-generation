@echo off
setlocal

REM Clear the console
cls

set script_dir=%~dp0
set parent_dir=%script_dir%..

set /p user_prompt=Enter your prompt: 
node --no-warnings "%parent_dir%\main.js" --from-ask-script "%user_prompt%"
