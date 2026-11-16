// Runs the slicer off the UI thread. One slice per message.
import CuraEngine from "./CuraEngine.js";
import { slice } from "./slice-core.js";

const DEFINITIONS = ["fdmprinter.def.json", "fdmextruder.def.json"];
const TEMPLATES = ["p1s_start.gcode", "p1p_start.gcode", "p1_end.gcode"];

let assetsPromise = null;
function loadAssets() {
  if (!assetsPromise) {
    const text = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Missing slicer file " + url);
      return res.text();
    };
    assetsPromise = Promise.all([
      Promise.all(DEFINITIONS.map(async (n) => [n, await text(n)])),
      Promise.all(TEMPLATES.map(async (n) => [n, await text("bambu/" + n)])),
    ]).then(([defs, tpls]) => ({ definitions: Object.fromEntries(defs), templates: Object.fromEntries(tpls) }));
  }
  return assetsPromise;
}

onmessage = async (ev) => {
  const { stl, options, thumbnail } = ev.data;
  try {
    const assets = await loadAssets();
    let last = -1;
    const result = await slice(new Uint8Array(stl), options, {
      createEngine: CuraEngine,
      definitions: assets.definitions,
      templates: assets.templates,
      onProgress: (v) => {
        const pct = Math.round(v * 100);
        if (pct !== last) { last = pct; postMessage({ type: "progress", percent: pct }); }
      },
    }, thumbnail ? new Uint8Array(thumbnail) : null);
    const gcode = result.gcode.buffer, project = result.project.buffer;
    postMessage({ type: "done", gcode, project, stats: result.stats, options: result.options }, [gcode, project]);
  } catch (e) {
    postMessage({ type: "error", message: (e && e.message) || String(e) });
  }
};
