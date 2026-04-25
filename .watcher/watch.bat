@echo off
REM Application Watcher - Windows Batch Wrapper
REM Usage: watch.bat [options]

setlocal enabledelayedexpansion

REM Default values
set HOST=localhost
set PORT=3000
set WATCHER_DIR=.watcher
set CHECK_INTERVAL=2
set RESPONSE_THRESHOLD=1000

REM Parse arguments
:parse_args
if "%1"=="" goto args_done
if "%1"=="--help" goto show_help
if "%1"=="-h" (
    set HOST=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--host" (
    set HOST=%2
    shift
    shift
    goto parse_args
)
if "%1"=="-p" (
    set PORT=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--port" (
    set PORT=%2
    shift
    shift
    goto parse_args
)
if "%1"=="-d" (
    set WATCHER_DIR=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--dir" (
    set WATCHER_DIR=%2
    shift
    shift
    goto parse_args
)
if "%1"=="-i" (
    set CHECK_INTERVAL=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--interval" (
    set CHECK_INTERVAL=%2
    shift
    shift
    goto parse_args
)
if "%1"=="-t" (
    set RESPONSE_THRESHOLD=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--threshold" (
    set RESPONSE_THRESHOLD=%2
    shift
    shift
    goto parse_args
)
if "%1"=="--setup" (
    echo Running setup wizard...
    python setup_watcher.py
    exit /b %ERRORLEVEL%
)
shift
goto parse_args

:args_done
REM Check Python
python --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python not found. Please install Python 3.7+
    exit /b 1
)

REM Check if app_watcher.py exists
if not exist "app_watcher.py" (
    if not exist "%WATCHER_DIR%\app_watcher.py" (
        echo [ERROR] app_watcher.py not found
        echo Run: copy app_watcher.py %WATCHER_DIR%\
        exit /b 1
    )
    set APP_WATCHER=%WATCHER_DIR%\app_watcher.py
) else (
    set APP_WATCHER=app_watcher.py
)

REM Check dependencies
echo Checking dependencies...
python -c "import requests" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Installing required packages...
    pip install -q requests psutil beautifulsoup4
)

REM Create directories
if not exist "%WATCHER_DIR%\logs" mkdir "%WATCHER_DIR%\logs"
if not exist "%WATCHER_DIR%\reports" mkdir "%WATCHER_DIR%\reports"

REM Print header
echo.
echo ========================================================================
echo Application Watcher
echo ========================================================================
echo.
echo Configuration:
echo   Host:               %HOST%
echo   Port:               %PORT%
echo   Check Interval:     %CHECK_INTERVAL%s
echo   Slow Threshold:     %RESPONSE_THRESHOLD%ms
echo   Reports Dir:        %WATCHER_DIR%\reports\
echo.
echo Status:

REM Health check
python -c "import requests; requests.get('http://%HOST%:%PORT%/', timeout=5)" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   ^[OK^] Application is accessible
) else (
    echo   [ERROR] Cannot reach http://%HOST%:%PORT%/
    echo   Make sure your application is running first
    echo.
    exit /b 1
)

echo.
echo Monitoring started...
echo Press Ctrl+C to stop and generate reports
echo.

REM Run watcher
python %APP_WATCHER% ^
    --host %HOST% ^
    --port %PORT% ^
    --watcher-dir %WATCHER_DIR% ^
    --check-interval %CHECK_INTERVAL% ^
    --response-threshold %RESPONSE_THRESHOLD%

set EXIT_CODE=%ERRORLEVEL%

echo.
echo ========================================================================
echo Watcher stopped
echo.
echo Generated reports:
dir "%WATCHER_DIR%\reports\" /B 2>nul || echo   (No reports generated)
echo.
echo Next steps:
echo   1. Review reports: %WATCHER_DIR%\reports\
echo   2. Check error analysis: type "%WATCHER_DIR%\reports\error_analysis_*.json"
echo   3. View logs: type "%WATCHER_DIR%\logs\*.log"
echo.

exit /b %EXIT_CODE%

:show_help
echo.
echo Application Watcher - Real-time Performance ^& Error Monitoring
echo.
echo Usage:
echo     watch.bat [OPTIONS]
echo.
echo Options:
echo     -h, --host HOST              Application host (default: localhost)
echo     -p, --port PORT              Application port (default: 3000)
echo     -d, --dir DIR                Watcher directory (default: .watcher)
echo     -i, --interval SECONDS       Check interval (default: 2)
echo     -t, --threshold MS           Response threshold in ms (default: 1000)
echo     --setup                      Run setup wizard
echo     --help                       Show this help message
echo.
echo Examples:
echo     watch.bat                                    :: Monitor localhost:3000
echo     watch.bat -p 8080                           :: Monitor localhost:8080
echo     watch.bat -h 127.0.0.1 -p 5000 -i 5         :: Custom config
echo     watch.bat --setup                           :: Initialize watcher
echo.
echo Quick Start:
echo     1. Command Prompt 1: npm start
echo     2. Command Prompt 2: watch.bat
echo     3. Use app normally
echo     4. Press Ctrl+C to stop and generate reports
echo     5. Check .watcher\reports\ for CSV files
echo.
exit /b 0
