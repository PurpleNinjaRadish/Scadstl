# SCAD to STL (Android)

Type or open OpenSCAD code on your phone, tap **Render**, preview the model, and
**Save STL**. Everything runs on the device, with no network access and no permissions.

## How it works

- `app/src/main/assets/www/` is the whole UI: a code editor, a WebGL preview and a
  log. `worker.js` runs OpenSCAD compiled to WebAssembly (`openscad.js`, from the
  `openscad-wasm-prebuilt` npm package) in a background thread and exports binary STL.
- `MainActivity.java` is a small WebView shell. It serves those assets from a private
  https origin and handles the two things a page cannot do: Android's "open file" and
  "save as" pickers.
- Liberation fonts are bundled so `text()` works (Sans regular/bold/italic, Mono, Serif).

## Getting an APK

**Without a computer (GitHub builds it):**

1. Create a GitHub repository and upload the contents of this folder to the `main` branch.
2. The "Build APK" workflow runs automatically (Actions tab), takes a few minutes, and
   publishes `scad2stl.apk` under Releases → "Latest build".
3. Open that file on your phone and allow installing from your browser when asked.

**With Android Studio:** open this folder, let it sync, press Run.

**Command line:** `./gradlew assembleDebug` (needs JDK 17 and the Android SDK), then
install `app/build/outputs/apk/debug/app-debug.apk`.

Builds are debug-signed. Each GitHub build uses a new debug key, so uninstall the old
app before installing a newer build.

## Limits

- This OpenSCAD build uses the CGAL backend (no Manifold), so heavy boolean work such
  as `minkowski()` or high `$fn` unions is slow on a phone. Use **Cancel** if needed.
- Single file only: `include`/`use` of other files and libraries such as MCAD or BOSL2
  are not bundled.
- Fonts other than Liberation fall back to Liberation Sans.
- Requires Android 8.0 or newer.

## Licences

OpenSCAD is GPL-2.0-or-later, and this app bundles it, so distribute the app under the
GPL as well. Liberation fonts are under the SIL Open Font License 1.1.
