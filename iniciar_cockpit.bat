@echo off
chcp 65001 >nul
title NTT DATA — Cockpit Multimodal RAG (:4545)

echo ===============================================================================
echo   🚀 NTT DATA — AXET-AGENT-CONTEXT-GEN
echo   Iniciando o Cockpit Multimodal Local...
echo ===============================================================================
echo.

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

:: 1. Converter caminho para o formato WSL
for /f "tokens=*" %%a in ('wsl -d Ubuntu wslpath -u "%SCRIPT_DIR%" 2^>nul ^|^| wsl wslpath -u "%SCRIPT_DIR%" 2^>nul') do set "WSL_PROJECT_DIR=%%a"
set "WSL_PROJECT_DIR=%WSL_PROJECT_DIR:/mnt/host/=/mnt/%"

if "%WSL_PROJECT_DIR%"=="" (
    echo [ERRO] Não foi possível comunicar com o WSL2.
    echo Certifique-se de que o WSL está instalado executando 'instalar_windows.bat'.
    pause
    exit /b 1
)

:: 2. Testar se o Local AI Gateway já está rodando na porta 8766
powershell -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 8766); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] Inicializando Local AI Gateway corporativo na porta 8766...
    start "AXET Local AI Gateway" /min wsl -d Ubuntu -- bash -c "cd '%WSL_PROJECT_DIR%' && if [ -f .venv/bin/activate ]; then source .venv/bin/activate; fi && exec python3 gateway/local_ai_gateway.py"
    timeout /t 1 /nobreak >nul
) else (
    echo [OK] Local AI Gateway corporativo já está ativo na porta 8766.
)

:: 3. Testar se o Cockpit já está rodando na porta 4545
powershell -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 4545); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] O servidor do Cockpit já está ativo na porta 4545!
    echo Abrindo o navegador...
    start http://localhost:4545/
    exit /b 0
)

:: 4. Iniciar o servidor Node.js dentro do WSL em segundo plano
echo [INFO] Inicializando servidor do Cockpit no WSL2...
echo Diretório: %WSL_PROJECT_DIR%
echo.

start "AXET Cockpit Server" /min wsl -d Ubuntu -- bash -c "cd '%WSL_PROJECT_DIR%' && if [ -f .venv/bin/activate ]; then source .venv/bin/activate; fi && exec node dashboard/server.js 4545"

:: 4. Aguardar inicialização e abrir o navegador
echo Aguardando inicialização do Cockpit...
set /a ATTEMPTS=0

:WAIT_LOOP
timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1

powershell -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 4545); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 (
    goto OPEN_BROWSER
)

if %ATTEMPTS% geq 10 (
    echo [AVISO] Tempo limite atingido. Abrindo o navegador mesmo assim...
    goto OPEN_BROWSER
)

goto WAIT_LOOP

:OPEN_BROWSER
echo.
echo ===============================================================================
echo   ✅ Cockpit pronto e conectado em http://localhost:4545/
echo ===============================================================================
echo.
start http://localhost:4545/

echo Para encerrar o servidor, feche esta janela ou a janela minimizada do terminal.
echo.
exit /b 0
