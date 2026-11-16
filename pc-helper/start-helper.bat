@echo off
rem Starts the SCAD to STL PC helper. Needs Python 3 from python.org or the Microsoft Store.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 scad2stl_pc_helper.py %* & goto end)
where python >nul 2>nul && (python scad2stl_pc_helper.py %* & goto end)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ and run this again.
:end
pause
