#!/usr/bin/env python3
"""SCAD to STL - PC helper.

Run this on the Windows PC that has Bambu Connect installed. The Android app sends a
sliced .gcode.3mf file to it over your home network; the helper saves the file and opens
it in Bambu Connect, where you pick the plate and press Print.

    python scad2stl_pc_helper.py            (or double-click start-helper.bat)

Needs Python 3.8 or newer, nothing else. Options:
    --port 8765      port to listen on
    --dry-run        save files but do not open Bambu Connect
"""
import argparse
import hmac
import json
import os
import re
import secrets
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

MAX_BYTES = 300 * 1024 * 1024
HERE = Path(__file__).resolve().parent
CONFIG = HERE / "scad2stl_helper.json"
SAVE_DIR = Path.home() / "Documents" / "Scad2Stl"


def load_code():
    """Pairing code, created on first run and kept so the phone setting stays valid."""
    try:
        code = json.loads(CONFIG.read_text())["code"]
        if re.fullmatch(r"\d{6}", code):
            return code
    except (OSError, ValueError, KeyError, TypeError):
        pass
    code = "%06d" % secrets.randbelow(1000000)
    try:
        CONFIG.write_text(json.dumps({"code": code}))
    except OSError:
        pass  # still works, the code just changes next start
    return code


def lan_addresses():
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outgoing interface
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in found and not ip.startswith("127."):
                found.append(ip)
    except OSError:
        pass
    return found or ["(could not detect; run ipconfig)"]


def open_in_bambu_connect(path, title):
    url = "bambu-connect://import-file?path=%s&name=%s&version=1.0.0" % (
        quote(str(path), safe=""), quote(title, safe=""))
    if sys.platform.startswith("win"):
        os.startfile(url)  # hands the link to whatever registered bambu-connect://
    elif sys.platform == "darwin":
        subprocess.run(["open", url], check=True)
    else:
        subprocess.run(["xdg-open", url], check=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "Scad2StlHelper/1"
    code = ""
    dry_run = False

    def reply(self, status, ok, message):
        body = json.dumps({"ok": ok, "message": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def authorised(self):
        given = self.headers.get("X-Code", "")
        if hmac.compare_digest(given.encode(), self.code.encode()):
            return True
        self.reply(403, False, "Wrong pairing code. Use the code shown in the helper window on the PC.")
        return False

    def do_GET(self):
        if urlparse(self.path).path != "/ping":
            self.reply(404, False, "Not found")
        elif self.authorised():
            self.reply(200, True, "PC helper on %s is ready." % socket.gethostname())

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/print":
            self.reply(404, False, "Not found")
            return
        if not self.authorised():
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.reply(411, False, "Missing Content-Length")
            return
        if length <= 0 or length > MAX_BYTES:
            self.reply(413, False, "File is empty or too large")
            return
        raw = parse_qs(url.query).get("name", ["model"])[0]
        stem = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")[:60] or "model"
        data = b""
        while len(data) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) != length or data[:2] != b"PK":
            self.reply(400, False, "Upload was incomplete or is not a 3MF file")
            return
        try:
            SAVE_DIR.mkdir(parents=True, exist_ok=True)
            target = SAVE_DIR / (stem + ".gcode.3mf")
            target.write_bytes(data)
        except OSError as e:
            self.reply(500, False, "Could not save the file on the PC: %s" % e)
            return
        print("Received %s (%d KB)" % (target, len(data) // 1024), flush=True)
        if self.dry_run:
            self.reply(200, True, "Saved on the PC as %s (dry run, Bambu Connect not opened)." % target.name)
            return
        try:
            open_in_bambu_connect(target, stem)
        except (OSError, subprocess.SubprocessError) as e:
            print("Could not open Bambu Connect: %s" % e, flush=True)
            self.reply(500, False, "Saved on the PC as %s, but Bambu Connect did not open. "
                                   "Is it installed and has it been run once?" % target.name)
            return
        self.reply(200, True, "Opened in Bambu Connect on the PC. Pick the plate and press Print there.")

    def log_message(self, fmt, *args):
        pass  # keep the window quiet; uploads are reported above


def main():
    ap = argparse.ArgumentParser(description="SCAD to STL PC helper for Bambu Connect")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dry-run", action="store_true", help="save files but do not open Bambu Connect")
    args = ap.parse_args()

    Handler.code = load_code()
    Handler.dry_run = args.dry_run
    try:
        server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    except OSError as e:
        sys.exit("Cannot listen on port %d: %s" % (args.port, e))

    print("SCAD to STL PC helper is running. Leave this window open.")
    print()
    print("In the Android app, under 'Send via PC', enter:")
    for ip in lan_addresses():
        print("    PC address:   %s%s" % (ip, "" if args.port == 8765 else ":%d" % args.port))
    print("    Pairing code: %s" % Handler.code)
    print()
    print("Files are saved to %s" % SAVE_DIR)
    print("If Windows asks, allow Python on private networks. Press Ctrl+C to stop.")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()
