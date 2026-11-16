"use strict";
// "Slice & print" sheet: slicing settings, saving the sliced file, and sending it to a
// Bambu Lab printer on the local network (through MainActivity).
(function () {
  const $ = (id) => document.getElementById(id);
  const App = window.App, bridge = App.bridge;

  const TEMPS = { PLA: { nozzle: 220, bed: 55, coolBed: 35 }, PETG: { nozzle: 255, bed: 70, coolBed: 70 } };
  // id -> [settings key, default]
  const FIELDS = {
    pPrinter: ["printer", "P1S"], pFilament: ["filament", "PLA"], pPlate: ["plate", "Textured PEI Plate"],
    pNozzle: ["nozzleTemp", 220], pBed: ["bedTemp", 55], pLayer: ["layerHeight", "0.2"],
    pInfill: ["infill", 15], pWalls: ["walls", "2"], pSupport: ["support", "off"], pBrim: ["brim", false],
    pHost: ["host", ""], pCode: ["code", ""], pSerial: ["serial", ""], pSource: ["source", "loaded"],
    pLevel: ["level", true], pFormat: ["format", "project"], pAfter: ["after", "start"],
  };
  const SLICE_FIELDS = ["pPrinter", "pFilament", "pPlate", "pNozzle", "pBed", "pLayer", "pInfill", "pWalls", "pSupport", "pBrim"];

  let worker = null, slicing = false, busy = false, result = null, confirmAction = null;

  // ---- settings ---------------------------------------------------------
  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("scad.print") || "{}"); } catch (e) {}
    for (const [id, [key, def]] of Object.entries(FIELDS)) {
      const el = $(id), v = key in saved ? saved[key] : def;
      if (el.type === "checkbox") el.checked = !!v; else el.value = v;
    }
  }
  function readSettings() {
    const s = {};
    for (const [id, [key]] of Object.entries(FIELDS)) {
      const el = $(id);
      s[key] = el.type === "checkbox" ? el.checked : el.value.trim();
    }
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem("scad.print", JSON.stringify(readSettings())); } catch (e) {}
  }

  function msg(el, text, kind) {
    el.textContent = text;
    el.className = "msg" + (kind ? " " + kind : "");
  }
  const sliceMsg = (t, k) => msg($("sliceMsg"), t, k);
  const sendMsg = (t, k) => msg($("sendMsg"), t, k);

  function refresh() {
    const ready = !!result && !slicing;
    $("slice").disabled = slicing || !App.stl();
    $("saveGcode").disabled = !ready;
    $("save3mf").disabled = !ready;
    $("send").disabled = !ready || busy || !bridge;
    $("find").disabled = busy || !bridge;
    $("test").disabled = busy || !bridge;
  }

  function duration(sec) {
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h ? h + " h " + m + " min" : m + " min";
  }

  function invalidate(reason) {
    if (!result && !slicing) return;
    result = null;
    if (!slicing) sliceMsg(reason || "Settings changed. Slice again.");
    refresh();
  }

  // ---- slicing ----------------------------------------------------------
  function dataUrlBytes(url) {
    const bin = atob(url.slice(url.indexOf(",") + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function startSlice() {
    const stl = App.stl();
    if (!stl || slicing) return;
    const s = readSettings();
    const options = {
      printer: s.printer, filament: s.filament, plate: s.plate,
      nozzleTemp: Number(s.nozzleTemp), bedTemp: Number(s.bedTemp),
      layerHeight: Number(s.layerHeight), infill: Number(s.infill), walls: Number(s.walls),
      support: s.support, brim: s.brim, name: App.name(),
    };
    if (!worker) {
      worker = new Worker("slicer/slice-worker.js", { type: "module" });
      worker.onmessage = onWorker;
      worker.onerror = (e) => { slicing = false; sliceMsg("Slicer failed to load: " + (e.message || "error"), "err"); refresh(); };
    }
    let thumbnail = null;
    try { const shot = App.snapshot(); if (shot) thumbnail = dataUrlBytes(shot).buffer; } catch (e) {}
    slicing = true; result = null;
    sliceMsg("Slicing…");
    refresh();
    const copy = stl.slice().buffer;
    worker.postMessage({ stl: copy, options, thumbnail }, thumbnail ? [copy, thumbnail] : [copy]);
  }

  function onWorker(ev) {
    const m = ev.data;
    if (m.type === "progress") {
      sliceMsg("Slicing… " + m.percent + "%");
    } else if (m.type === "done") {
      slicing = false;
      result = { gcode: new Uint8Array(m.gcode), project: new Uint8Array(m.project), stats: m.stats, options: m.options };
      const st = m.stats;
      sliceMsg("Ready: about " + duration(st.printSeconds) + " · " + st.grams + " g (" + st.meters + " m) · " +
        st.layers + " layers" + (st.warnings.length ? "\n" + st.warnings.join("\n") : ""), st.warnings.length ? "err" : "ok");
      refresh();
    } else if (m.type === "error") {
      slicing = false;
      sliceMsg(m.message, "err");
      refresh();
    }
  }

  // ---- sending ----------------------------------------------------------
  const safeName = () => (App.name().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "model").slice(0, 40);

  function printerConfig() {
    const s = readSettings();
    if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(s.host)) { sendMsg("Enter the printer's IP address, for example 192.168.1.50.", "err"); return null; }
    if (!s.code) { sendMsg("Enter the printer's access code.", "err"); return null; }
    return { host: s.host, code: s.code, serial: s.serial };
  }

  function send() {
    if (!result || busy) return;
    const cfg = printerConfig();
    if (!cfg) return;
    const s = readSettings();
    const project = s.format === "project";
    const remote = safeName() + (project ? ".gcode.3mf" : ".gcode");
    let publish = "", command = "";
    if (s.after === "start") {
      const seq = String(Date.now() % 100000);
      if (project) {
        const useAms = s.source !== "loaded";
        command = "project_file";
        publish = JSON.stringify({ print: {
          sequence_id: seq, command, param: "Metadata/plate_1.gcode",
          project_id: "0", profile_id: "0", task_id: "0", subtask_id: "0",
          subtask_name: safeName(), file: "", url: "file:///sdcard/" + remote, md5: "",
          timelapse: false, bed_type: "auto", bed_levelling: s.level, bed_leveling: s.level,
          flow_cali: false, vibration_cali: false, layer_inspect: false,
          ams_mapping: [useAms ? Number(s.source) : 0], use_ams: useAms,
        } });
      } else {
        command = "gcode_file";
        publish = JSON.stringify({ print: { sequence_id: seq, command, param: "/sdcard/" + remote } });
      }
    }
    const go = () => {
      busy = true; refresh();
      sendMsg("Connecting to the printer…");
      // Let the message paint before the (synchronous) hand-over of the file to Java.
      setTimeout(() => {
        App.pushBytes(project ? result.project : result.gcode);
        bridge.printerSend(JSON.stringify({ ...cfg, remoteName: remote, publish, command }));
      }, 30);
    };
    if (s.after === "start") {
      $("confirmText").textContent = "Upload to " + cfg.host + " and start printing now? Make sure the build plate is clear and " +
        (s.source === "loaded" ? "filament is loaded." : "AMS slot " + (Number(s.source) + 1) + " has " + result.options.filament + ".");
      confirmAction = go;
      $("confirm").classList.remove("hidden");
    } else {
      go();
    }
  }

  // Events from MainActivity.
  function native(event, a, b, c, d) {
    if (event === "status") {
      sendMsg(a);
    } else if (event === "progress") {
      sendMsg("Uploading… " + a + "%");
    } else if (event === "serial") {
      if (!$("pSerial").value.trim()) { $("pSerial").value = a; saveSettings(); }
    } else if (event === "found") {
      $("pHost").value = a; $("pSerial").value = b; saveSettings();
      sendMsg("Found " + (c || "printer") + " at " + a + (d ? " (" + d + ")" : ""), "ok");
    } else if (event === "idle") {
      busy = false; refresh();
    } else if (event === "done") {
      busy = false; sendMsg(a, "ok"); refresh();
    } else if (event === "error") {
      busy = false; sendMsg(a, "err"); refresh();
    }
  }

  // ---- wiring -----------------------------------------------------------
  loadSettings();
  for (const id of Object.keys(FIELDS)) {
    $(id).addEventListener("change", () => {
      if (id === "pFilament" || id === "pPlate") {
        const t = TEMPS[$("pFilament").value];
        if (id === "pFilament") $("pNozzle").value = t.nozzle;
        $("pBed").value = $("pPlate").value === "Cool Plate" ? t.coolBed : t.bed;
      }
      saveSettings();
      if (SLICE_FIELDS.includes(id)) invalidate();
    });
  }
  $("slice").onclick = startSlice;
  $("saveGcode").onclick = () => result && App.saveBytes(result.gcode, safeName() + ".gcode", "text/x.gcode");
  $("save3mf").onclick = () => result && App.saveBytes(result.project, safeName() + ".gcode.3mf", "model/3mf");
  $("send").onclick = send;
  $("find").onclick = () => { busy = true; refresh(); sendMsg("Listening for printers on this Wi-Fi…"); bridge.printerFind(); };
  $("test").onclick = () => {
    const cfg = printerConfig();
    if (!cfg) return;
    busy = true; refresh(); sendMsg("Testing…");
    bridge.printerTest(JSON.stringify(cfg));
  };
  $("sheetClose").onclick = () => $("sheet").classList.add("hidden");
  $("confirmNo").onclick = () => { $("confirm").classList.add("hidden"); confirmAction = null; };
  $("confirmYes").onclick = () => {
    $("confirm").classList.add("hidden");
    const fn = confirmAction; confirmAction = null;
    if (fn) fn();
  };
  if (!bridge) sendMsg("Sending to a printer needs the Android app. Saving files works here.");

  window.PrintUI = {
    open() {
      $("sheet").classList.remove("hidden");
      if (!result && !slicing) sliceMsg("Choose settings, then Slice.");
      refresh();
    },
    modelChanged() { invalidate("The model changed. Slice again."); },
    saved(ok, text) { if (!$("sheet").classList.contains("hidden")) sliceMsg(ok ? "Saved " + text : "Save failed: " + text, ok ? "ok" : "err"); },
    native,
  };
})();
