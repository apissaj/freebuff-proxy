@echo off
title Freebuff Proxy
echo =============================================
echo   Freebuff Proxy - OpenAI-compatible
echo   http://localhost:8080
echo =============================================
echo.
echo Edit config.json first:
echo   - Add your AUTH_TOKENS (from freebuff CLI or freebuff.llm.pm)
echo   - Optionally set API_KEYS for auth
echo.
node "%~dp0server.js" %*
pause