"""Clicks through Bambu Connect's import-to-print flow on Windows (experimental).

Bambu Connect has no API for starting a print, so this drives its window through Windows
UI Automation (the pywinauto package): after a file is imported it presses "Print" and then
"Send", the same buttons a person would press. Bambu Connect's own choices (printer, plate
type, AMS mapping) are used as they are.

If Bambu Connect's layout changes, or a dialog appears that this does not know, it stops and
writes the window's structure to bambu_connect_ui.txt so the button names can be fixed.
"""
import re
import subprocess
import sys
import time
from pathlib import Path, PureWindowsPath

UI_DUMP = Path(__file__).resolve().parent / "bambu_connect_ui.txt"
WINDOW_TITLE = re.compile(r"(?i)bambu\s*connect")
ACCESSIBILITY_FLAG = "--force-renderer-accessibility"

# Each step: (what to say in messages, accepted button names). Matching ignores case and
# surrounding spaces.
STEPS = [
    ("Print", ["Print", "Print plate", "Print Plate"]),
    ("Send", ["Send", "Send print", "Start printing", "Print now"]),
]
PLATE_NAMES = re.compile(r"(?i)^\s*plate\s*0?1\b")


class AutoClickError(Exception):
    pass


# ---------------------------------------------------------------- launching

def registry_command():
    """The command Windows runs for bambu-connect:// links, or None."""
    try:
        import winreg
    except ImportError:
        return None
    for root, key in ((winreg.HKEY_CURRENT_USER, r"Software\Classes\bambu-connect\shell\open\command"),
                      (winreg.HKEY_CLASSES_ROOT, r"bambu-connect\shell\open\command")):
        try:
            with winreg.OpenKey(root, key) as k:
                value, _ = winreg.QueryValueEx(k, "")
                if value:
                    return value
        except OSError:
            continue
    return None


def launch_command(template, url):
    """Builds the command line that opens url in Bambu Connect with accessibility switched on.

    template is the registry value, e.g. '"C:\\...\\Bambu Connect.exe" "%1"'.
    """
    template = template.strip()
    if template.startswith('"'):
        end = template.find('"', 1)
        if end < 0:
            raise ValueError("unbalanced quotes in " + template)
        exe, rest = template[:end + 1], template[end + 1:]
    else:
        exe, _, rest = template.partition(" ")
        rest = " " + rest if rest else ""
    if "%1" in rest:
        rest = rest.replace("%1", url)
    else:
        rest = rest + ' "' + url + '"'
    return exe + " " + ACCESSIBILITY_FLAG + rest


def exe_name(template):
    m = re.match(r'\s*"([^"]+)"|\s*(\S+)', template or "")
    path = (m.group(1) or m.group(2)) if m else ""
    return PureWindowsPath(path).name if path else ""


def is_running(image):
    if not image:
        return False
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq " + image, "/NH"],
                             capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return image.lower() in out.lower()


def open_with_accessibility(url):
    """Opens url in Bambu Connect. Returns True if Bambu Connect was already running, in which
    case it may have been started without accessibility and its buttons may be invisible."""
    template = registry_command()
    if not template:
        import os
        os.startfile(url)
        return True
    running = is_running(exe_name(template))
    subprocess.Popen(launch_command(template, url))
    return running


# ---------------------------------------------------------------- clicking

def _norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def find_window(timeout):
    from pywinauto import Desktop
    deadline = time.time() + timeout
    while time.time() < deadline:
        for w in Desktop(backend="uia").windows():
            try:
                if WINDOW_TITLE.search(w.window_text() or "") and w.is_visible():
                    return w
            except Exception:
                continue
        time.sleep(1)
    raise AutoClickError("Bambu Connect's window did not appear.")


def _candidates(window, names):
    wanted = {_norm(n) for n in names}
    found = []
    for el in window.descendants():
        try:
            if _norm(el.window_text()) in wanted and el.is_visible():
                found.append(el)
        except Exception:
            continue
    # Real buttons first, then anything else carrying the label (some web UIs use divs).
    found.sort(key=lambda e: 0 if getattr(e.element_info, "control_type", "") == "Button" else 1)
    return found


def click_step(window, label, names, timeout, log):
    deadline = time.time() + timeout
    seen_disabled = 0.0
    while time.time() < deadline:
        for el in _candidates(window, names):
            try:
                if el.is_enabled():
                    window.set_focus()
                    el.click_input()
                    log("Clicked %s" % label)
                    return
            except Exception:
                continue
            if not seen_disabled:
                seen_disabled = time.time()
        # A disabled Print button usually means no plate is selected yet.
        if seen_disabled and time.time() - seen_disabled > 4 and label == "Print":
            for el in window.descendants():
                try:
                    if PLATE_NAMES.match(el.window_text() or "") and el.is_visible():
                        el.click_input()
                        log("Selected plate 1")
                        seen_disabled = time.time()
                        break
                except Exception:
                    continue
        time.sleep(1)
    raise AutoClickError("Could not find an enabled \"%s\" button in Bambu Connect." % label)


def dump_ui(window=None):
    """Writes Bambu Connect's control tree to bambu_connect_ui.txt. Returns the path or None."""
    try:
        if window is None:
            window = find_window(5)
        lines = []
        for el in window.descendants():
            info = el.element_info
            try:
                text = el.window_text()
            except Exception:
                text = "?"
            lines.append("%-14s %-40r enabled=%s visible=%s" % (
                getattr(info, "control_type", "?"), text, el.is_enabled(), el.is_visible()))
        UI_DUMP.write_text("Bambu Connect window: %r\n%d elements\n\n%s\n" % (
            window.window_text(), len(lines), "\n".join(lines)), encoding="utf-8")
        return UI_DUMP
    except Exception as e:  # diagnostics must never hide the real error
        try:
            UI_DUMP.write_text("Could not read Bambu Connect's window: %r\n" % (e,), encoding="utf-8")
            return UI_DUMP
        except OSError:
            return None


def print_imported_file(log=print, window_timeout=60, step_timeout=45):
    """Presses Print, then Send, in the Bambu Connect window. Raises AutoClickError."""
    if not sys.platform.startswith("win"):
        raise AutoClickError("Automatic clicking only works on Windows.")
    try:
        import pywinauto  # noqa: F401
    except ImportError:
        raise AutoClickError("Automatic clicking needs the pywinauto package. Close the helper "
                             "and start it again with start-helper.bat, which installs it.")
    window = find_window(window_timeout)
    try:
        window.set_focus()
    except Exception:
        pass
    time.sleep(2)  # let the imported file render
    try:
        if not window.descendants():
            raise AutoClickError("Bambu Connect's buttons are not visible to the helper. Close "
                                 "Bambu Connect completely and send again, so the helper can "
                                 "start it with accessibility switched on.")
        for label, names in STEPS:
            click_step(window, label, names, step_timeout, log)
            time.sleep(2)
    except AutoClickError:
        path = dump_ui(window)
        raise AutoClickError(str(sys.exc_info()[1]) + (
            " Details saved to %s; send that file to whoever maintains the app." % path.name if path else ""))
