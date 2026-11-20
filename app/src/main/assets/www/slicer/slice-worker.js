// Runs the slicer off the UI thread. One slice per message.
import CuraEngine from "./CuraEngine.js";
import { slice } from "./slice-core.js";

const DEFINITIONS = ["fdmprinter.def.json", "fdmextruder.def.json"];
const TEMPLATES = ["p1s_start.gcode", "p1p_start.gcode", "p1_end.gcode"];

const PROFILES = { base: "base_p1s.json", varyingKeys: "varying_keys.json", PLA: "filament_pla.json", PETG: "filament_petg.json" };

let assetsPromise = null;
function loadAssets() {
  if (!assetsPromise) {
    const text = async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Missing slicer file " + url);
      return res.text();
    };
    const json = async (name) => JSON.parse(await text("bambu/" + name));
    assetsPromise = Promise.all([
      Promise.all(DEFINITIONS.map(async (n) => [n, await text(n)])),
      Promise.all(TEMPLATES.map(async (n) => [n, await text("bambu/" + n)])),
      Promise.all(Object.entries(PROFILES).map(async ([k, n]) => [k, await json(n)])),
    ]).then(([defs, tpls, prof]) => {
      const p = Object.fromEntries(prof);
      return {
        definitions: Object.fromEntries(defs),
        templates: Object.fromEntries(tpls),
        profiles: { base: p.base, varyingKeys: p.varyingKeys, filaments: { PLA: p.PLA, PETG: p.PETG } },
      };
    });
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
      profiles: assets.profiles,
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
