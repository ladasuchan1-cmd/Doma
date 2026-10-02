@echo off
rem Kolomapa - jednorazove stazeni a naceneni inzeratu, pak skonci (pro Planovac uloh Windows).
rem Vystup se pripisuje do data\stahovani.log (nad 5 MB se stary log prejmenuje na stahovani-stary.log).
rem Navratovy kod: 0 = v poradku, 1 = chyba (Planovac uloh pak ukaze vysledek 0x1).
rem Pouzivate-li Planovac uloh, v nastaveni.txt nastavte KOLOMAPA_SCHEDULE=off (jinak stahuje i start.cmd).
cd /d "%~dp0"
if not exist "data" mkdir "data"
if exist "data\stahovani.log" for %%F in ("data\stahovani.log") do if %%~zF GTR 5000000 move /y "data\stahovani.log" "data\stahovani-stary.log" >nul
echo Kolomapa stahuje inzeraty - prvni beh trva 2 az 3 hodiny, dalsi kratsi. Prubeh: data\stahovani.log
node tools\run.js %* >> "data\stahovani.log" 2>&1
exit /b %errorlevel%
