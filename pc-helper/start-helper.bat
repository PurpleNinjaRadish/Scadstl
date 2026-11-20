@echo off
rem Starts the SCAD to STL PC helper. Needs Python 3 from python.org or the Microsoft Store.
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/ and run this again.
  goto end
)
rem pywinauto lets the helper press Print and Send in Bambu Connect for you.
%PY% -c "import pywinauto" >nul 2>nul || (
  echo Installing pywinauto, needed for automatic printing...
  %PY% -m pip install --user --disable-pip-version-check pywinauto
)
%PY% scad2stl_pc_helper.py %*
:end
pause
