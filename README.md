# SCAD to STL (Android)

Type or open OpenSCAD code on your phone, tap **Render**, preview the model, and
**Save STL**. Then, for a Bambu Lab P1P or P1S, **Print** slices the model on the phone and
either saves the print file or sends it to the printer over Wi-Fi.

Rendering and slicing run on the device. The only network traffic is to your printer.

## Using it

1. Write or open a `.scad` file (the app also appears under "Open with" for `.scad` files).
2. **Render**, check the preview, optionally **Save STL**.
3. **Print** opens the slice screen. Pick printer, filament, plate, layer height, infill,
   walls, supports and brim, then **Slice**.
4. Either:
   - **Save G-code** / **Save 3MF** and copy the file to the printer's microSD card, or
   - **Send to printer** (see below).

### Sending to the printer

Bambu firmware only lets third-party apps start prints when the printer is in
**LAN-only mode** with **Developer Mode** switched on (printer screen: Settings, then
WLAN / Network). While that is on, Bambu Handy and the cloud do not work with that printer.

In the app enter the printer's IP address and access code (both shown on the printer's
network screen), or tap **Find printer**. **Test connection** checks the address and code
without printing. The serial number is read from the printer if you leave it empty.

"Send as" chooses between a Bambu project (`.gcode.3mf`, started with the same command
Bambu Studio uses) and plain G-code. "After upload" lets you only put the file on the SD
card and start it from the printer's screen.

### Sending through a PC with Bambu Connect

This route leaves the printer in its normal mode. A small helper on a Windows PC receives
the sliced file from the phone and opens it in Bambu Connect, where you choose the plate
and press Print (at the PC, or through remote desktop).

1. On the PC, install Bambu Connect and sign in, and install Python 3.
2. Download `scad2stl-pc-helper.zip` from this repository's "Latest build" release, unzip
   it, and double-click `start-helper.bat`. Allow Python on private networks if Windows asks.
3. The helper window shows a PC address and a pairing code. Enter both under
   "Send via PC" in the app, tap **Test PC**, then **Send to PC** after slicing.

Files are kept in `Documents\Scad2Stl` on the PC. The helper only accepts uploads that
carry the pairing code, and it speaks plain HTTP, so use it on your home network only.
Whether Bambu Connect accepts a project that was not sliced by Bambu Studio or OrcaSlicer
has not been confirmed.

### Before the first print

The printer side has been tested against a simulated printer only, not real hardware.
Start with a small model, stay next to the printer, and be ready to press stop. If the
upload works but the print does not start, try the other "Send as" option, or start the
uploaded file from the printer's screen.

## How it works

- `app/src/main/assets/www/` is the UI: editor, WebGL preview, log, and the slice screen.
- `worker.js` runs OpenSCAD compiled to WebAssembly (`openscad.js`, from the
  `openscad-wasm-prebuilt` npm package) and exports binary STL.
- `slicer/` holds CuraEngine compiled to WebAssembly (from the `cura-wasm` npm package)
  and `slice-core.js`, which centres the model on the 256 mm bed, runs the engine with
  explicit settings, and wraps the result in Bambu's own P1 start and end G-code
  (`slicer/bambu/`, taken unmodified from Bambu Studio's printer profiles).
- `MainActivity.java` is a WebView shell: file pickers, "Open with", and a bridge to
  `BambuLink.java`, which uploads over implicit FTPS (port 990) and sends the start command
  over MQTT/TLS (port 8883) as user `bblp` with the access code. The printer's certificate
  is signed by Bambu's private CA, so it is not verified.
- Liberation fonts are bundled so `text()` works.

## Getting an APK

Every push to `main` builds the app with GitHub Actions and publishes `scad2stl.apk` under
Releases, "Latest build". Open that file on the phone to install it. Builds are
debug-signed with a new key each time, so uninstall the old app before installing a newer
build.

With Android Studio: open this folder and press Run. Command line: `./gradlew assembleDebug`
(JDK 17 and the Android SDK).

## Limits

- OpenSCAD here uses the CGAL backend (no Manifold), so heavy boolean work is slow on a
  phone. Single file only: `include`/`use` and libraries such as MCAD or BOSL2 are not
  bundled.
- The slicer is CuraEngine, not Bambu Studio: one object, one filament, 0.4 mm nozzle,
  generic PLA or PETG, and conservative speeds. No multi-colour, no tree supports, and
  print quality will not match a tuned Bambu Studio profile.
- Time and filament figures are estimates.
- Requires Android 8.0 or newer.

## Licences

The app bundles OpenSCAD (GPL-2.0-or-later), CuraEngine (AGPL-3.0-or-later, via cura-wasm)
and G-code templates from Bambu Studio (AGPL-3.0), so distribute it under the AGPL-3.0.
Cura's printer definitions are LGPL-3.0-or-later. Liberation fonts are under the SIL Open
Font License 1.1.
