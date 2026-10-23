@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Instalar Panel Joaco
cls

rem ============================================================
rem  Instalar Panel Joaco. Windows 10 y 11.
rem  Joaco solo hace doble clic en ESTE archivo. No hace falta otro.
rem
rem  Para publicar otra version, cambia solo VERSION y CCX_SHA256.
rem  El nombre del .ccx y el link salen solos de VERSION.
rem  CCX_SHA256 es el sha256 de instalador\panel-joaco-VERSION.ccx
rem
rem  Deja las lineas CAND1 a CAND4 afuera de un bloque if.
rem  El parentesis de Program Files x86 cortaria el bloque.
rem
rem  La linea del Listo no puede tener un signo de exclamacion.
rem  Si lo tiene, el escape del mayor-que deja de funcionar.
rem
rem  Nota: publicar.ps1 del repo privado sincroniza este repo.
rem  Si ese script reemplaza la carpeta instalador, puede borrar
rem  este .bat y el COMO INSTALAR. Hay que conservarlos al publicar.
rem ============================================================

set "VERSION=0.9.0"
set "CCX_SHA256=51323650dfd86b3e37668487cd954ed4a0e9e05311c3cc97387213061bd01f91"
set "PLUGIN_ID=ar.mauroarredondo.panel-joaco"
set "PLUGIN_NOMBRE=Panel Joaco"
set "CCX_NAME=panel-joaco-%VERSION%.ccx"
set "CCX_URL=https://github.com/mauritenss/panel-joaco-herramientas/raw/main/instalador/panel-joaco-%VERSION%.ccx"
set "CCX=%TEMP%\%CCX_NAME%"
set "LOG=%TEMP%\panel-joaco-upia.log"
set "LOG2=%TEMP%\panel-joaco-upia-remove.log"
set "SALIDA=1"

set "CAND1=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "CAND2=%ProgramFiles%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "CAND3=%CommonProgramFiles(x86)%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "CAND4=%ProgramFiles(x86)%\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

echo ========================================
echo   Instalar Panel Joaco !VERSION!
echo ========================================
echo.
echo Antes de seguir, cerrá Premiere Pro.
echo Si está abierto, espero. No lo voy a cerrar yo.
echo.

:esperar_premiere
tasklist /FI "IMAGENAME eq Adobe Premiere Pro.exe" /FO CSV /NH 2>nul | find /I "Adobe Premiere Pro.exe" >nul
if errorlevel 1 goto premiere_ok
echo Premiere sigue abierto.
echo Cerralo vos y después apretá una tecla acá.
echo No lo voy a cerrar yo.
echo.
pause >nul
goto esperar_premiere

:premiere_ok
echo Premiere está cerrado. Sigo.

:bajar
echo.
echo Bajando el panel. Esperá un toque...
echo.
if exist "!CCX!" del /f /q "!CCX!"
where.exe curl.exe >nul 2>&1
if errorlevel 1 goto bajar_powershell
curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 180 --progress-bar -A "PanelJoacoInstalador" -o "!CCX!" "!CCX_URL!"
if not errorlevel 1 goto verificar
echo.
echo Con la primera forma no se pudo. Reintento...
echo.
if exist "!CCX!" del /f /q "!CCX!"
curl.exe -L --fail --retry 2 --retry-delay 2 --connect-timeout 30 --max-time 180 --ssl-no-revoke --progress-bar -A "PanelJoacoInstalador" -o "!CCX!" "!CCX_URL!"
if not errorlevel 1 goto verificar
echo.
echo Sigo de otra forma...
echo.
if exist "!CCX!" del /f /q "!CCX!"

:bajar_powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 -Uri $env:CCX_URL -OutFile $env:CCX; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 goto error_descarga

:verificar
if not exist "!CCX!" goto error_descarga
echo Reviso que el archivo esté entero...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; $fs = [System.IO.File]::OpenRead($env:CCX); $b0 = $fs.ReadByte(); $b1 = $fs.ReadByte(); $fs.Close(); if ($b0 -eq 80 -and $b1 -eq 75) { exit 0 } else { exit 2 } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }"
set "EC=!ERRORLEVEL!"
if "!EC!"=="0" goto chequear_hash
if "!EC!"=="2" goto error_no_zip
goto error_lectura

:chequear_hash
echo Reviso que sea el archivo de Mauro...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; $h = (Get-FileHash -LiteralPath $env:CCX -Algorithm SHA256).Hash.ToLower(); if ($h -eq $env:CCX_SHA256.ToLower()) { exit 0 } else { exit 2 } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }"
set "EC=!ERRORLEVEL!"
if "!EC!"=="0" goto buscar_upia
if "!EC!"=="2" goto error_hash
goto error_hash_tecnico

:buscar_upia
set "UPIA="
if exist "!CAND1!" set "UPIA=!CAND1!"
if not defined UPIA if exist "!CAND2!" set "UPIA=!CAND2!"
if not defined UPIA if exist "!CAND3!" set "UPIA=!CAND3!"
if not defined UPIA if exist "!CAND4!" set "UPIA=!CAND4!"
if not defined UPIA goto error_sin_upia
echo Encontré el instalador de Adobe.

:instalar
echo.
echo Instalando. Puede tardar un toque...
echo.
set "MODO=--"
goto correr_install

:correr_install_barra
echo.
echo Esa forma no anduvo. Pruebo otra...
echo.
set "MODO=/"

:correr_install
del /f /q "!LOG!" 2>nul
"!UPIA!" !MODO!install "!CCX!" > "!LOG!" 2>&1
set "EC=!ERRORLEVEL!"
echo --- para Mauro: salida del instalador ---
type "!LOG!"
echo --- fin, codigo !EC! ---
set "LOGACTUAL=!LOG!"
if "!MODO!"=="--" call :log_uso_invalido
if "!MODO!"=="--" if defined USO_INVALIDO goto correr_install_barra
if "!EC!"=="0" call :log_tiene_error
if "!EC!"=="0" if not defined LOG_ERROR goto ok
call :log_ya_instalado
if defined YA_INSTALADO goto reinstalar
if "!EC!"=="429" goto reinstalar
if "!EC!"=="-429" goto reinstalar
if "!EC!"=="412" goto reinstalar
if "!EC!"=="-412" goto reinstalar
if "!EC!"=="418" goto reinstalar
if "!EC!"=="-418" goto reinstalar
if "!EC!"=="422" goto reinstalar
if "!EC!"=="-422" goto reinstalar
if "!EC!"=="506" goto reinstalar
if "!EC!"=="-506" goto reinstalar
call :log_pide_admin
if defined PIDE_ADMIN goto error_admin
goto error_instalar

:reinstalar
echo.
echo El panel ya estaba instalado.
echo Lo saco y lo vuelvo a poner.
echo.
goto correr_remove

:correr_remove_barra
echo.
echo Esa forma no anduvo. Pruebo otra...
echo.
set "MODO=/"

:correr_remove
"!UPIA!" !MODO!remove "!PLUGIN_ID!" > "!LOG2!" 2>&1
set "EC=!ERRORLEVEL!"
echo --- para Mauro: sacar el panel, codigo !EC! ---
type "!LOG2!"
set "LOGACTUAL=!LOG2!"
if "!MODO!"=="--" call :log_uso_invalido
if "!MODO!"=="--" if defined USO_INVALIDO goto correr_remove_barra
if "!EC!"=="0" call :log_tiene_error
if "!EC!"=="0" if not defined LOG_ERROR goto reinstalar_install
echo.
echo Con el código no alcanzó. Pruebo con el nombre del panel.
echo.
"!UPIA!" !MODO!remove "!PLUGIN_NOMBRE!" > "!LOG2!" 2>&1
set "EC=!ERRORLEVEL!"
echo --- para Mauro: sacar el panel, codigo !EC! ---
type "!LOG2!"
goto reinstalar_install

:reinstalar_install
echo.
echo Lo vuelvo a instalar...
echo.
"!UPIA!" !MODO!install "!CCX!" > "!LOG!" 2>&1
set "EC=!ERRORLEVEL!"
echo --- para Mauro: salida del instalador ---
type "!LOG!"
echo --- fin, codigo !EC! ---
set "LOGACTUAL=!LOG!"
if "!EC!"=="0" call :log_tiene_error
if "!EC!"=="0" if not defined LOG_ERROR goto ok
goto error_reinstalar

:ok
echo.
echo Listo: abrí Premiere ^> Ventana ^> Extensiones (UXP) ^> Panel Joaco. Se actualiza solo con internet.
set "SALIDA=0"
goto limpiar

:error_descarga
echo.
echo No pude bajar el panel.
echo Revisá que tengas internet y volvé a hacer doble clic.
echo Si sigue igual, mandale una captura de esta ventana a Mauro.
echo Link:
echo !CCX_URL!
goto limpiar

:error_no_zip
echo.
echo Bajó un archivo, pero no es el panel.
echo No instalo nada.
echo Mandale una captura de esta ventana a Mauro.
goto limpiar

:error_lectura
echo.
echo Bajó algo, pero no pude leerlo.
echo No instalo nada.
echo Mandale una captura de esta ventana a Mauro.
goto limpiar

:error_hash
echo.
echo El archivo bajó, pero no es el que publicó Mauro.
echo No instalo nada, por las dudas.
echo Tenía que ser:
echo !CCX_SHA256!
echo Y es:
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $ErrorActionPreference='Stop'; (Get-FileHash -LiteralPath $env:CCX -Algorithm SHA256).Hash.ToLower() } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 3 }"
echo.
echo Mandale una captura de esta ventana a Mauro.
goto limpiar

:error_hash_tecnico
echo.
echo No pude revisar que el archivo sea el de Mauro.
echo No instalo nada.
echo Mandale una captura de esta ventana a Mauro.
goto limpiar

:error_sin_upia
echo.
echo No encontré el instalador de Adobe.
echo Falta el programa que instala los plugins. Viene con Creative Cloud.
echo No toqué nada.
echo Mandale a Mauro una captura de Ayuda ^> Acerca de Premiere Pro.
goto limpiar

:error_admin
echo.
echo El instalador de Adobe pidió permisos de administrador.
echo Cerrá esta ventana.
echo Hacé clic derecho en "Instalar Panel Joaco.bat"
echo y elegí "Ejecutar como administrador".
echo Después seguí los mismos pasos.
goto limpiar

:error_instalar
echo.
echo No se pudo instalar.
echo El error está arriba, tal cual. Mandale una captura de esta ventana a Mauro.
echo Si Creative Cloud está cerrado, abrilo, fijate que estés logueado y volvé a intentar.
echo Si Windows pidió permiso de administrador: clic derecho en
echo "Instalar Panel Joaco.bat" y elegí "Ejecutar como administrador".
goto limpiar

:error_reinstalar
echo.
echo Intenté sacar el panel viejo y poner el nuevo, y no quedó instalado.
echo El error está arriba, tal cual. Mandale una captura de esta ventana a Mauro.
goto limpiar

:limpiar
if exist "!CCX!" del /f /q "!CCX!" 2>nul
if exist "!LOG!" del /f /q "!LOG!" 2>nul
if exist "!LOG2!" del /f /q "!LOG2!" 2>nul
echo.
echo Apretá una tecla para cerrar esta ventana.
pause
endlocal & exit /b %SALIDA%

:log_tiene_error
set "LOG_ERROR="
findstr /I /C:"-429" /C:"-412" /C:"-418" /C:"-422" /C:"-506" /C:"failed" /C:"error code" /C:"already installed" /C:"installation failed" /C:"no se pudo" "!LOGACTUAL!" >nul
if not errorlevel 1 set "LOG_ERROR=1"
goto :eof

:log_ya_instalado
set "YA_INSTALADO="
findstr /I /C:"Usage:" /C:"Uso:" "!LOGACTUAL!" >nul
if not errorlevel 1 goto :eof
findstr /I /C:"-429" /C:"-412" /C:"-418" /C:"-422" /C:"-506" /C:"already installed" /C:"already been installed" /C:"ya esta instal" /C:"ya está instal" /C:"ya se instal" /C:"newer version" /C:"mas nueva" /C:"más nueva" /C:"same name" "!LOGACTUAL!" >nul
if not errorlevel 1 set "YA_INSTALADO=1"
goto :eof

:log_uso_invalido
set "USO_INVALIDO="
if "!EC!"=="0" goto :eof
findstr /I /C:"unknown option" /C:"unrecognized" /C:"not recognized" /C:"Usage:" /C:"Uso:" "!LOGACTUAL!" >nul
if not errorlevel 1 set "USO_INVALIDO=1"
goto :eof

:log_pide_admin
set "PIDE_ADMIN="
findstr /I /C:"access is denied" /C:"acceso denegado" /C:"requires elevation" /C:"requieren privilegios" /C:"ejecutar como administrador" /C:"error 740" /C:"error: 740" "!LOGACTUAL!" >nul
if not errorlevel 1 set "PIDE_ADMIN=1"
goto :eof
