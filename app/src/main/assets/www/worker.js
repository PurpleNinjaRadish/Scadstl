// Runs OpenSCAD (WebAssembly) off the UI thread. One render per message.
import { createOpenSCAD } from "./openscad.js";

const FONT_FILES = [
  "LiberationSans-Regular.ttf",
  "LiberationSans-Bold.ttf",
  "LiberationSans-Italic.ttf",
  "LiberationMono-Regular.ttf",
  "LiberationSerif-Regular.ttf",
];
const FONT_CONF =
  '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">' +
  "<fontconfig><dir>/fonts</dir><cachedir>/tmp/fc</cachedir></fontconfig>";

let fontsPromise = null;
function loadFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all(
      FONT_FILES.map(async (name) => {
        const res = await fetch("fonts/" + name);
        if (!res.ok) throw new Error("font " + name + " missing");
        return [name, new Uint8Array(await res.arrayBuffer())];
      })
    );
  }
  return fontsPromise;
}

const log = (text) => postMessage({ type: "log", text: String(text) });

async function render(code) {
  const t0 = Date.now();
  const fonts = await loadFonts();
  // The WASM instance cannot be reused after main() has run, so make a fresh one.
  const scad = await createOpenSCAD({ print: log, printErr: log });
  const m = scad.getInstance();
  m.FS.mkdir("/fonts");
  m.FS.writeFile("/fonts/fonts.conf", FONT_CONF);
  for (const [name, bytes] of fonts) m.FS.writeFile("/fonts/" + name, bytes);
  m.FS.writeFile("/input.scad", code);

  let rc = -1;
  try {
    rc = m.callMain(["/input.scad", "--export-format=binstl", "-o", "/output.stl"]);
  } catch (e) {
    if (e && typeof e.status === "number") rc = e.status;
    else if (typeof e === "number") throw new Error("OpenSCAD crashed (out of memory or model too complex)");
    else if (!(e && e.name === "ExitStatus")) throw e;
  }
  let stl = null;
  try { stl = m.FS.readFile("/output.stl", { encoding: "binary" }); } catch (e) { /* no output */ }
  if (!stl || stl.length < 84) {
    throw new Error(rc === 0 ? "Nothing to export (model is empty or 2D only)" : "OpenSCAD failed, see log");
  }
  const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  postMessage({ type: "done", stl: buf, ms: Date.now() - t0 }, [buf]);
}

onmessage = async (ev) => {
  if (ev.data.type !== "render") return;
  try {
    await render(ev.data.code);
  } catch (e) {
    postMessage({ type: "error", message: (e && e.message) || String(e) });
  }
};

loadFonts().then(
  () => postMessage({ type: "ready" }),
  (e) => postMessage({ type: "error", message: e.message })
);
