@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: VibeWorker 启动脚本 (Windows)
:: 用法: start.bat [start|stop|restart|status]

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%backend"
set "FRONTEND_DIR=%SCRIPT_DIR%frontend"
set "BACKEND_PORT=8088"
set "FRONTEND_PORT=3000"

if "%1"=="" goto :start
if "%1"=="start" goto :start
if "%1"=="stop" goto :stop
if "%1"=="restart" goto :restart
if "%1"=="status" goto :status
if "%1"=="help" goto :help
if "%1"=="--help" goto :help
if "%1"=="-h" goto :help
goto :unknown

:start
echo [INFO] 启动 VibeWorker...
echo.

:: 启动后端
echo [INFO] 启动后端服务...
cd /d "%BACKEND_DIR%"

:: 检查虚拟环境
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else if exist ".venv\Scripts\activate.bat" (
    call .venv\Scripts\activate.bat
)

start "VibeWorker-Backend" /min cmd /c "python app.py"
echo [INFO] 后端启动中... http://localhost:%BACKEND_PORT%

:: 启动前端
echo [INFO] 启动前端服务...
cd /d "%FRONTEND_DIR%"
start "VibeWorker-Frontend" /min cmd /c "npm run dev"
echo [INFO] 前端启动中... http://localhost:%FRONTEND_PORT%

echo.
echo ========== VibeWorker 启动完成 ==========
echo 后端: http://localhost:%BACKEND_PORT%
echo 前端: http://localhost:%FRONTEND_PORT%
echo.
echo 提示: 使用 start.bat stop 停止服务
echo ==========================================
goto :end

:stop
echo [INFO] 停止 VibeWorker...
echo.

:: 停止占用后端端口的进程
call :kill_port %BACKEND_PORT% "后端"

:: 停止占用前端端口的进程
call :kill_port %FRONTEND_PORT% "前端"

echo.
echo [INFO] VibeWorker 已停止
goto :end

:restart
echo [INFO] 重启 VibeWorker...
call :stop
timeout /t 2 /nobreak >nul
call :start
goto :end

:status
echo.
echo ========== VibeWorker 状态 ==========

:: 检查后端端口
set "BACKEND_RUNNING=0"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%BACKEND_PORT% "') do (
    set "BACKEND_RUNNING=1"
)
if "!BACKEND_RUNNING!"=="1" (
    echo 后端: [运行中] http://localhost:%BACKEND_PORT%
) else (
    echo 后端: [未运行]
)

:: 检查前端端口
set "FRONTEND_RUNNING=0"
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%FRONTEND_PORT% "') do (
    set "FRONTEND_RUNNING=1"
)
if "!FRONTEND_RUNNING!"=="1" (
    echo 前端: [运行中] http://localhost:%FRONTEND_PORT%
) else (
    echo 前端: [未运行]
)

echo =====================================
echo.
goto :end

:kill_port
:: 杀死占用指定端口的所有进程（含子进程树）
:: %1 = 端口号, %2 = 显示名称
set "FOUND=0"
set "KILLED_PIDS="

:: 第一轮：通过端口查找并杀死进程树
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%~1 "') do (
    if not "%%a"=="0" (
        :: 去重：检查 PID 是否已被处理
        echo !KILLED_PIDS! | findstr /C:" %%a " >nul 2>&1
        if errorlevel 1 (
            set "KILLED_PIDS=!KILLED_PIDS! %%a "
            taskkill /PID %%a /F /T >nul 2>&1
            echo [INFO] 停止%~2 (PID: %%a, 端口: %~1)
            set "FOUND=1"
        )
    )
)

:: 兜底：通过窗口标题杀残留进程
if "%~1"=="8088" (
    taskkill /FI "WINDOWTITLE eq VibeWorker-Backend*" /F /T >nul 2>&1
)
if "%~1"=="3000" (
    taskkill /FI "WINDOWTITLE eq VibeWorker-Frontend*" /F /T >nul 2>&1
)

:: 等待端口释放
if "!FOUND!"=="1" (
    set "RETRIES=0"
    :wait_port_free
    timeout /t 1 /nobreak >nul
    set /a RETRIES+=1
    netstat -ano 2>nul | findstr "LISTENING" | findstr ":%~1 " >nul 2>&1
    if not errorlevel 1 (
        if !RETRIES! LSS 5 (
            echo [INFO] 等待端口 %~1 释放... (!RETRIES!/5)
            :: 再次尝试杀死残留进程
            for /f "tokens=5" %%b in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%~1 "') do (
                if not "%%b"=="0" (
                    taskkill /PID %%b /F /T >nul 2>&1
                )
            )
            goto :wait_port_free
        ) else (
            echo [WARN] 端口 %~1 仍被占用，请手动检查！
        )
    ) else (
        echo [INFO] 端口 %~1 已释放
    )
) else (
    echo [INFO] %~2未运行 (端口 %~1 空闲)
)
goto :eof

:help
echo.
echo VibeWorker 启动脚本 (Windows)
echo.
echo 用法: %~nx0 [命令]
echo.
echo 命令:
echo   start     启动前后端 (默认)
echo   stop      停止前后端
echo   restart   重启前后端
echo   status    查看运行状态
echo   help      显示帮助信息
echo.
echo 示例:
echo   %~nx0           启动所有服务
echo   %~nx0 restart   重启所有服务
echo   %~nx0 status    查看状态
echo.
goto :end

:unknown
echo [ERROR] 未知命令: %1
echo 使用 '%~nx0 help' 查看帮助
goto :end

:end
endlocal
