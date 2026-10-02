@echo off
rem Kolomapa - spusteni dvojklikem (Windows).
rem Okno nechte otevrene: dokud bezi, bezi i mapa a denni stahovani. Zavrenim okna se Kolomapa ukonci.
rem Nastaveni (port, heslo, zdroje, cas stahovani ...) je v souboru nastaveni.txt v teto slozce.
rem Automaticke spusteni po prihlaseni: Win+R, shell:startup, do slozky vlozte zastupce tohoto souboru.
setlocal
cd /d "%~dp0"
title Kolomapa

where node >nul 2>nul
if errorlevel 1 goto chybi_node

if not exist "nastaveni.txt" if exist "nastaveni-vzor.txt" copy /y "nastaveni-vzor.txt" "nastaveni.txt" >nul

node tools\start.js %*
if errorlevel 1 goto chyba
exit /b 0

:chybi_node
echo.
echo  Chybi Node.js. Stahnete verzi LTS z https://nodejs.org a nainstalujte ji
echo  (staci klikat Dalsi). Pak toto okno zavrete a spustte start.cmd znovu.
echo.
start "" "https://nodejs.org/"
pause
exit /b 1

:chyba
echo.
echo  Kolomapa se nespustila nebo skoncila chybou - duvod je vypsany vyse.
echo  Napovedu najdete v README.md v casti Reseni potizi.
echo.
pause
exit /b 1
