"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const bridge = window.Android || null; // provided by MainActivity; absent in a plain browser

  const EXAMPLES = {
    "Text plate":
`// Nameplate with raised text
label = "OpenSCAD";
size  = 10;   // text height, mm
pad   = 4;
w = len(label) * size * 0.95 + pad * 2;

cube([w, size + pad * 2, 2]);
translate([pad, pad, 2])
  linear_extrude(1.5)
    text(label, size = size, font = "Liberation Sans:style=Bold");
`,
    "Box with hole":
`// Cube with a spherical cut-out
$fn = 48;
difference() {
  cube(20, center = true);
  sphere(13);
}
`,
    "Hex nut":
`// Simple M8-style hex nut (no thread)
$fn = 60;
difference() {
  cylinder(h = 6.5, d = 15, $fn = 6);
  translate([0, 0, -1]) cylinder(h = 9, d = 8);
}
`,
  };

  const code = $("code"), statusEl = $("status"), logEl = $("log");
  const btnRender = $("render"), btnCancel = $("cancel"), btnSave = $("save");
  let worker = null, rendering = false, lastStl = null, baseName = "model", lastError = "";

  // ---- UI helpers -------------------------------------------------------
  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("err", !!isError);
  }
  function addLog(text) {
    const span = document.createElement("span");
    if (/error/i.test(text)) { span.className = "e"; if (!lastError) lastError = text; }
    else if (/warning|deprecated/i.test(text)) span.className = "w";
    span.textContent = text + "\n";
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function showTab(name) {
    const isLog = name === "log";
    $("tabLog").classList.toggle("on", isLog);
    $("tabPreview").classList.toggle("on", !isLog);
    logEl.classList.toggle("hidden", !isLog);
    $("view").classList.toggle("hidden", isLog);
    $("hint").classList.toggle("hidden", isLog || !!lastStl);
    if (!isLog && viewer.ok) viewer.redraw();
  }
  function setBusy(busy) {
    rendering = busy;
    btnRender.disabled = busy;
    btnCancel.classList.toggle("hidden", !busy);
    btnSave.disabled = busy || !lastStl;
  }

  const viewer = new StlViewer($("view"));
  if (!viewer.ok) $("hint").textContent = "3D preview is not available on this device. Rendering and saving still work.";

  // ---- Worker -----------------------------------------------------------
  function startWorker() {
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "ready") {
        if (!rendering) setStatus("Ready");
      } else if (m.type === "log") {
        addLog(m.text);
      } else if (m.type === "done") {
        lastStl = new Uint8Array(m.stl);
        const tris = new DataView(m.stl).getUint32(80, true);
        let dims = "";
        if (viewer.ok) {
          const info = viewer.setMesh(lastStl);
          dims = " · " + info.size.map((v) => +v.toFixed(1)).join("×") + " mm";
        }
        setBusy(false);
        setStatus(tris.toLocaleString() + " triangles" + dims + " · " + (m.ms / 1000).toFixed(1) + " s");
        showTab("preview");
      } else if (m.type === "error") {
        setBusy(false);
        setStatus(lastError || m.message, true);
        addLog("ERROR: " + m.message);
        showTab("log");
      }
    };
    worker.onerror = (e) => {
      setBusy(false);
      setStatus("Engine failed to load", true);
      addLog("ERROR: " + (e.message || "worker error"));
      showTab("log");
    };
  }

  function render() {
    if (rendering) return;
    if (!code.value.trim()) { setStatus("Nothing to render", true); return; }
    logEl.textContent = "";
    lastError = "";
    persist();
    setBusy(true);
    setStatus("Rendering…");
    worker.postMessage({ type: "render", code: code.value });
  }
  function cancel() {
    if (!rendering) return;
    worker.terminate();
    startWorker();
    setBusy(false);
    setStatus("Cancelled");
  }

  // ---- Save / open ------------------------------------------------------
  function save() {
    if (!lastStl) return;
    const name = baseName + ".stl";
    if (bridge) {
      // Hand the bytes to Java in base64 chunks, then let Android show its "save as" picker.
      const CHUNK = 3 * 131072;
      bridge.stlBegin();
      for (let off = 0; off < lastStl.length; off += CHUNK) {
        const part = lastStl.subarray(off, Math.min(off + CHUNK, lastStl.length));
        let bin = "";
        for (let i = 0; i < part.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        }
        bridge.stlAppend(btoa(bin));
      }
      bridge.stlSave(name);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lastStl], { type: "model/stl" }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }
  function setCode(text, name) {
    code.value = text;
    if (name) baseName = name.replace(/\.[^.]*$/, "") || "model";
    persist();
  }
  function persist() {
    try { localStorage.setItem("scad.code", code.value); localStorage.setItem("scad.name", baseName); } catch (e) {}
  }

  // Callbacks invoked from MainActivity.
  window.onNative = {
    saved(ok, msg) { setStatus(ok ? "Saved " + msg : "Save failed: " + msg, !ok); },
    opened(name, text) { setCode(text, name); setStatus("Opened " + name); },
    failed(msg) { setStatus(msg, true); },
  };

  // ---- Wire up ----------------------------------------------------------
  btnRender.onclick = render;
  btnCancel.onclick = cancel;
  btnSave.onclick = save;
  $("tabPreview").onclick = () => showTab("preview");
  $("tabLog").onclick = () => showTab("log");
  $("open").onclick = () => (bridge ? bridge.openScad() : $("file").click());
  $("file").onchange = (e) => {
    const f = e.target.files[0];
    if (f) f.text().then((t) => { setCode(t, f.name); setStatus("Opened " + f.name); });
    e.target.value = "";
  };
  const sel = $("examples");
  Object.keys(EXAMPLES).forEach((k) => sel.add(new Option(k, k)));
  sel.onchange = () => {
    if (sel.value) { setCode(EXAMPLES[sel.value], sel.value.toLowerCase().replace(/\s+/g, "-")); setStatus("Loaded example"); }
    sel.value = "";
  };
  let saveTimer = 0;
  code.addEventListener("input", () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); });

  let stored = null;
  try { stored = localStorage.getItem("scad.code"); baseName = localStorage.getItem("scad.name") || baseName; } catch (e) {}
  if (stored) code.value = stored; else setCode(EXAMPLES["Text plate"], "text-plate");

  startWorker();
})();
