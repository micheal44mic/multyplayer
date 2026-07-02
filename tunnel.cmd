@echo off
rem Exposes Fable Paint on a public HTTPS link using Cloudflare quick tunnel.
rem It is free and accountless, useful for testing from a phone/4G connection
rem or sharing with someone else. The link changes on every run; press Ctrl+C
rem to close the tunnel.
cd /d "%~dp0"
echo Starting local server (port 4174)...
start "fable-server" /min cmd /c "node serve.mjs 4174"
echo Starting tunnel: the https://....trycloudflare.com link appears below.
echo.
.tools\cloudflared.exe tunnel --url http://localhost:4174
