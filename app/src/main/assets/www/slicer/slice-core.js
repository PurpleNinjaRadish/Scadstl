// Slicing pipeline for Bambu Lab P1P / P1S. Pure functions, no DOM: used by slice-worker.js
// in the app and directly under Node for tests.
//
//   binary STL -> centred mesh -> CuraEngine (WASM) -> post-processed G-code
//   wrapped in Bambu's own start/end G-code -> plain .gcode and a .gcode.3mf project.

export const PRINTERS = {
  P1S: { name: "Bambu Lab P1S", modelId: "C12", start: "p1s_start.gcode", end: "p1_end.gcode" },
  P1P: { name: "Bambu Lab P1P", modelId: "C11", start: "p1p_start.gcode", end: "p1_end.gcode" },
};

// Values from Bambu Studio's "Generic PLA" / "Generic PETG" profiles.
export const FILAMENTS = {
  PLA: {
    type: "PLA", nozzle: 220, bed: 55, coolPlateBed: 35, maxVol: 12, flow: 98, density: 1.24,
    flushTemp: 240, fanMin: 100, fanMax: 100, fanOffLayers: 1, minLayerTime: 8, auxFan: 70,
    trayInfo: "GFL99",
  },
  PETG: {
    type: "PETG", nozzle: 255, bed: 70, coolPlateBed: 70, maxVol: 12, flow: 95, density: 1.27,
    flushTemp: 270, fanMin: 40, fanMax: 90, fanOffLayers: 3, minLayerTime: 12, auxFan: 0,
    trayInfo: "GFG99",
  },
};

export const PLATES = ["Textured PEI Plate", "High Temp Plate", "Cool Plate"];
export const BED = { x: 256, y: 256, z: 250, excludeX: 18, excludeY: 28 };

export const DEFAULTS = {
  printer: "P1S", filament: "PLA", plate: PLATES[0], nozzleTemp: 220, bedTemp: 55,
  layerHeight: 0.2, infill: 15, walls: 2, support: "off", brim: false, name: "model",
};

const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };

// ---- Template rendering (the small subset of Bambu Studio's placeholder language that the
// P1 start/end G-code uses: [name], {expression}, {if}/{elsif}/{else}/{endif}) --------------

function evalExpr(expr, ctx) {
  let js = "";
  const re = /"[^"]*"|[A-Za-z_][A-Za-z_0-9]*|[^"A-Za-z_]+/g;
  let m;
  while ((m = re.exec(expr))) {
    const tok = m[0];
    if (/^[A-Za-z_]/.test(tok)) {
      if (!(tok in ctx)) throw new Error("G-code template uses unknown variable: " + tok);
      js += "ctx." + tok;
    } else {
      js += tok;
    }
  }
  return new Function("ctx", "return (" + js + ");")(ctx);
}

function fmt(v) {
  if (Array.isArray(v)) v = v[0];
  if (typeof v === "number") return String(round(v, 5));
  return String(v);
}

export function renderTemplate(tpl, ctx) {
  let out = "";
  const stack = []; // {active: emit this branch, done: a branch already matched, parent: parent active}
  const active = () => (stack.length ? stack[stack.length - 1].active : true);
  const re = /\{([^{}]*)\}/g;
  let last = 0, m;
  const literal = (s) => {
    if (active()) {
      out += s.replace(/\[([a-z_0-9]+)\]/g, (all, name) => {
        if (!(name in ctx)) throw new Error("G-code template uses unknown variable: " + name);
        return fmt(ctx[name]);
      });
    }
  };
  while ((m = re.exec(tpl))) {
    literal(tpl.slice(last, m.index));
    last = re.lastIndex;
    const body = m[1].trim();
    let c;
    if ((c = /^if\b(.*)$/s.exec(body))) {
      const parent = active();
      const hit = parent && !!evalExpr(c[1], ctx);
      stack.push({ active: hit, done: hit, parent });
    } else if ((c = /^elsif\b(.*)$/s.exec(body))) {
      const top = stack[stack.length - 1];
      if (!top) throw new Error("G-code template: elsif without if");
      const hit = top.parent && !top.done && !!evalExpr(c[1], ctx);
      top.active = hit; top.done = top.done || hit;
    } else if (body === "else") {
      const top = stack[stack.length - 1];
      if (!top) throw new Error("G-code template: else without if");
      top.active = top.parent && !top.done; top.done = true;
    } else if (body === "endif") {
      if (!stack.pop()) throw new Error("G-code template: endif without if");
    } else if (active()) {
      out += fmt(evalExpr(body, ctx));
    }
  }
  literal(tpl.slice(last));
  if (stack.length) throw new Error("G-code template: missing endif");
  return out;
}

// ---- Mesh ----------------------------------------------------------------------------------

// Centres a binary STL on the bed origin (CuraEngine adds half the bed size itself) and rests
// it on Z=0. Returns the moved copy and its size.
export function prepareMesh(bytes, margin = 0) {
  if (bytes.byteLength < 84) throw new Error("Model is empty");
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = src.getUint32(80, true);
  if (n === 0 || bytes.byteLength < 84 + n * 50) throw new Error("Model is empty or not a binary STL");
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, o = 84; i < n; i++, o += 50) {
    for (let k = 0; k < 9; k++) {
      const v = src.getFloat32(o + 12 + k * 4, true);
      if (!Number.isFinite(v)) throw new Error("Model has invalid coordinates");
      if (v < lo[k % 3]) lo[k % 3] = v;
      if (v > hi[k % 3]) hi[k % 3] = v;
    }
  }
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const limit = [BED.x - 2 * margin, BED.y - 2 * margin, BED.z];
  if (size[0] > limit[0] || size[1] > limit[1] || size[2] > limit[2]) {
    throw new Error("Model is " + size.map((v) => round(v, 1)).join(" x ") +
      " mm, larger than the printable " + limit.join(" x ") + " mm");
  }
  if (size[2] < 0.05) throw new Error("Model has no height");
  const shift = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
  const copy = new Uint8Array(84 + n * 50);
  copy.set(bytes.subarray(0, 84 + n * 50));
  const dst = new DataView(copy.buffer);
  for (let i = 0, o = 84; i < n; i++, o += 50) {
    for (let k = 0; k < 9; k++) {
      const p = o + 12 + k * 4;
      dst.setFloat32(p, src.getFloat32(p, true) + shift[k % 3], true);
    }
  }
  return { stl: copy, size, triangles: n };
}

// ---- CuraEngine settings -------------------------------------------------------------------

// The command-line engine does not evaluate Cura's setting formulas, so every derived value
// (line distances, layer counts, per-feature speeds and flows) is spelled out here.
export function curaSettings(o) {
  const f = FILAMENTS[o.filament];
  const lh = o.layerHeight;
  const lw = 0.45, lwOuter = 0.42;
  const cap = (target, width) => round(Math.min(target, (f.maxVol * 0.9) / (width * lh)), 1);
  const infill = Math.max(0, Math.min(100, o.infill));
  const fanFullLayer = f.fanOffLayers + 1;
  const s = {
    machine_width: BED.x, machine_depth: BED.y, machine_height: BED.z,
    machine_center_is_zero: false, machine_heated_bed: true, machine_extruder_count: 1,
    machine_nozzle_size: 0.4,
    machine_gcode_flavor: "RepRap (Marlin/Sprinter)",
    machine_start_gcode: "", machine_end_gcode: "",
    material_bed_temp_prepend: false, material_print_temp_prepend: false,
    material_bed_temp_wait: false, material_print_temp_wait: false,
    relative_extrusion: true,
    machine_acceleration: 5000, machine_max_acceleration_x: 5000, machine_max_acceleration_y: 5000,
    machine_max_feedrate_x: 500, machine_max_feedrate_y: 500, machine_max_feedrate_z: 20,
    machine_max_jerk_xy: 9, acceleration_enabled: false, jerk_enabled: false,

    center_object: false, mesh_position_x: 0, mesh_position_y: 0, mesh_position_z: 0,

    layer_height: lh, layer_height_0: 0.2,
    line_width: lw, wall_line_width: lw, wall_line_width_0: lwOuter, wall_line_width_x: lw,
    skin_line_width: lw, infill_line_width: lw, skirt_brim_line_width: lw, support_line_width: lw,
    initial_layer_line_width_factor: 110,
    wall_line_count: o.walls,
    top_layers: Math.max(4, Math.ceil(1.0 / lh)),
    bottom_layers: Math.max(3, Math.ceil(0.6 / lh)),
    initial_bottom_layers: Math.max(3, Math.ceil(0.6 / lh)),
    top_bottom_pattern: "lines", top_bottom_pattern_0: "lines",
    infill_sparse_density: infill, infill_pattern: "grid",
    infill_line_distance: infill > 0 ? round((lw * 100 / infill) * 2, 3) : 0,
    infill_before_walls: false, infill_overlap_mm: 0.07, skin_overlap_mm: 0.05,
    fill_outline_gaps: true, z_seam_type: "sharpest_corner",

    material_diameter: 1.75,
    material_flow: f.flow, wall_material_flow: f.flow, wall_0_material_flow: f.flow,
    wall_x_material_flow: f.flow, skin_material_flow: f.flow, infill_material_flow: f.flow,
    skirt_brim_material_flow: f.flow, support_material_flow: f.flow, material_flow_layer_0: 100,
    material_print_temperature: o.nozzleTemp, material_print_temperature_layer_0: o.nozzleTemp,
    material_initial_print_temperature: o.nozzleTemp, material_final_print_temperature: o.nozzleTemp,
    material_bed_temperature: o.bedTemp, material_bed_temperature_layer_0: o.bedTemp,

    retraction_enable: true, retraction_amount: 0.8, retraction_speed: 30,
    retraction_retract_speed: 30, retraction_prime_speed: 30, retraction_min_travel: 1,
    retraction_extrusion_window: 0.8, retraction_count_max: 100,
    retraction_hop_enabled: true, retraction_hop: 0.4, speed_z_hop: 10,
    retraction_combing: "noskin",

    speed_print: cap(120, lw), speed_infill: cap(150, lw), speed_wall: cap(100, lw),
    speed_wall_0: cap(80, lwOuter), speed_wall_x: cap(120, lw), speed_topbottom: cap(80, lw),
    speed_roofing: cap(80, lw), speed_support: cap(100, lw), speed_support_infill: cap(100, lw),
    speed_support_interface: cap(60, lw),
    speed_travel: 300, speed_layer_0: 40, speed_print_layer_0: 40, speed_travel_layer_0: 150,
    skirt_brim_speed: 40, speed_slowdown_layers: 1,

    cool_fan_enabled: true, cool_fan_speed: f.fanMin, cool_fan_speed_min: f.fanMin,
    cool_fan_speed_max: f.fanMax, cool_fan_speed_0: 0, cool_fan_full_layer: fanFullLayer,
    cool_fan_full_at_height: round(0.2 + (fanFullLayer - 1) * lh, 3),
    cool_min_layer_time: f.minLayerTime, cool_min_layer_time_fan_speed_max: f.minLayerTime + 4,
    cool_min_speed: 10, cool_lift_head: false,

    adhesion_type: o.brim ? "brim" : "none", brim_line_count: 8, skirt_brim_minimal_length: 0,

    support_enable: o.support !== "off",
    support_type: o.support === "everywhere" ? "everywhere" : "buildplate",
    support_angle: 50, support_pattern: "zigzag", support_infill_rate: 15,
    support_line_distance: 3.0, support_initial_layer_line_distance: 3.0,
    support_z_distance: 0.2, support_top_distance: 0.2, support_bottom_distance: 0.2,
    support_xy_distance: 0.7, support_interface_enable: false,
  };
  return s;
}

export function curaArgs(o, paths) {
  const args = ["slice", "-j", paths.definition, "-o", paths.output];
  for (const [k, v] of Object.entries(curaSettings(o))) args.push("-s", k + "=" + v);
  args.push("-l", paths.model);
  return args;
}

// ---- G-code assembly -----------------------------------------------------------------------

const DROP_COMMAND = /^(M104|M109|M140|M190|M82|M105|M84|G28|G29|T\d+)\b/;
const DROP_COMMENT = /^;(FLAVOR|TIME|Filament used|Layer height|MIN[XYZ]|MAX[XYZ]):/;

function chamberFan(f, bed) {
  if (f.type === "PLA") return bed > 55 ? "M106 P3 S200" : bed > 50 ? "M106 P3 S150" : bed > 45 ? "M106 P3 S50" : "";
  return bed > 80 ? "M106 P3 S255" : bed > 60 ? "M106 P3 S180" : "";
}

// curaGcode: text from CuraEngine. usedMm3: filament volume it reported.
export function assembleGcode(curaGcode, o, mesh, templates, usedMm3) {
  const f = FILAMENTS[o.filament];
  const lines = curaGcode.split("\n");
  let layerCount = 0, totalTime = 0;
  for (const l of lines) {
    if (l.startsWith(";LAYER_COUNT:")) layerCount = parseInt(l.slice(13), 10);
    else if (l.startsWith(";TIME_ELAPSED:")) totalTime = parseFloat(l.slice(14));
  }
  if (!layerCount || !(totalTime > 0)) throw new Error("Slicer produced no layers");
  const maxZ = round(0.2 + (layerCount - 1) * o.layerHeight, 3);
  const startOverhead = 360; // heating, levelling and purge before the first layer
  const eta = (elapsed) => Math.max(0, Math.round((totalTime - elapsed) / 60));

  const body = [];
  let elapsed = 0;
  for (let line of lines) {
    line = line.replace(/\r$/, "");
    if (DROP_COMMAND.test(line) || DROP_COMMENT.test(line)) continue;
    if (line.startsWith(";TIME_ELAPSED:")) elapsed = parseFloat(line.slice(14));
    body.push(line);
    if (line.startsWith(";LAYER:")) {
      const n = parseInt(line.slice(7), 10);
      body.push("; layer num/total_layer_count: " + (n + 1) + "/" + layerCount);
      body.push("M73 P" + Math.min(99, Math.floor((elapsed / totalTime) * 100)) + " R" + eta(elapsed));
      body.push("M73 L" + (n + 1));
      body.push("M991 S0 P" + n + " ;notify layer change");
      if (n === 0) body.push("M204 S500 ; gentle first layer");
      if (n === 1) {
        body.push("M204 S5000");
        if (f.auxFan > 0) body.push("M106 P2 S" + Math.round(f.auxFan * 2.55) + " ; auxiliary fan");
      }
    }
  }

  // Area the first layer covers on the bed (model footprint plus brim), for bed levelling.
  const pad = o.brim ? 8 * 0.45 + 1 : 1;
  const min = [BED.x / 2 - mesh.size[0] / 2 - pad, BED.y / 2 - mesh.size[1] / 2 - pad];
  const ctx = {
    initial_extruder: 0, current_extruder: 0, initial_no_support_extruder: 0,
    bed_temperature_initial_layer_single: o.bedTemp,
    bed_temperature: [o.bedTemp], bed_temperature_initial_layer: [o.bedTemp],
    nozzle_temperature_initial_layer: [o.nozzleTemp],
    filament_type: [f.type],
    flush_volumetric_speeds: [f.maxVol], flush_temperatures: [f.flushTemp],
    first_layer_print_min: [round(Math.max(0, min[0]), 2), round(Math.max(0, min[1]), 2)],
    first_layer_print_size: [round(Math.min(BED.x, mesh.size[0] + 2 * pad), 2),
                             round(Math.min(BED.y, mesh.size[1] + 2 * pad), 2)],
    outer_wall_volumetric_speed: round(Math.min(f.maxVol, 80 * 0.42 * o.layerHeight), 3),
    curr_bed_type: o.plate,
    max_layer_z: maxZ,
  };
  const p = PRINTERS[o.printer];
  const start = renderTemplate(templates[p.start], ctx);
  const end = renderTemplate(templates[p.end], ctx);

  const meters = usedMm3 / (Math.PI * 0.875 * 0.875) / 1000;
  const grams = (usedMm3 / 1000) * f.density;
  const header = [
    "; HEADER_BLOCK_START",
    "; generated by SCAD to STL (CuraEngine) for " + p.name + " 0.4 nozzle",
    "; model printing time: " + Math.round(totalTime) + "s; total estimated time: " + Math.round(totalTime + startOverhead) + "s",
    "; total layer number: " + layerCount,
    "; total filament length [mm] : " + round(meters * 1000, 2),
    "; total filament volume [cm^3] : " + round(usedMm3 / 1000, 2),
    "; total filament weight [g] : " + round(grams, 2),
    "; filament_density: " + f.density,
    "; filament_diameter: 1.75",
    "; max_z_height: " + maxZ.toFixed(2),
    "; HEADER_BLOCK_END",
    "",
  ];
  const fan = chamberFan(f, o.bedTemp);
  const text = [
    header.join("\n"),
    start,
    "; filament start gcode",
    fan,
    "G90",
    "G21",
    "M83 ; relative extrusion",
    "; ===== sliced model =====",
    body.join("\n"),
    "M73 P100 R0",
    "; filament end gcode",
    "M106 S0",
    "M106 P2 S0",
    end,
    "",
  ].filter((s) => s !== "").join("\n") + "\n";

  const warnings = [];
  if (min[0] < BED.excludeX && min[1] < BED.excludeY) {
    warnings.push("The model reaches the front-left corner, which the P1 uses for its filament cutter. Make it smaller or expect a collision warning.");
  }
  return {
    text,
    stats: {
      layers: layerCount, printSeconds: Math.round(totalTime + startOverhead),
      meters: round(meters, 2), grams: round(grams, 1), maxZ, warnings,
    },
  };
}

// ---- MD5, CRC-32, ZIP ----------------------------------------------------------------------

export function md5(bytes) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const len = bytes.length, padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len << 3) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let fn, g;
      if (i < 16) { fn = (b & c) | (~b & d); g = i; }
      else if (i < 32) { fn = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { fn = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { fn = c ^ (b | ~d); g = (7 * i) & 15; }
      const x = (a + fn + K[i] + M[g]) | 0, r = S[((i >> 4) << 2) | (i & 3)];
      a = d; d = c; c = b;
      b = (b + ((x << r) | (x >>> (32 - r)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setInt32(i * 4, v, true));
  let hex = "";
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    return null; // older WebView without deflate-raw: store uncompressed
  }
}

// files: [{name, data: Uint8Array}]
export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const packed = f.data.length > 256 ? await deflateRaw(f.data) : null;
    const useDeflate = packed && packed.length < f.data.length;
    const data = useDeflate ? packed : f.data;
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true);
    local.setUint16(8, useDeflate ? 8 : 0, true);
    local.setUint16(10, DOS_TIME, true); local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
    local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(10, useDeflate ? 8 : 0, true);
    cd.setUint16(12, DOS_TIME, true); cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true);
    cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

// ---- Bambu .gcode.3mf project --------------------------------------------------------------
//
// Bambu Connect silently ignores a .gcode.3mf unless it looks like Bambu Studio's
// "export plate sliced file" output: a complete project_settings.config (~550 keys, per-filament
// arrays padded to 5 slots), and specific keys, in a specific order, in model_settings.config and
// slice_info.config. The layout below follows bambox (github.com/estampo/bambox, MIT), whose
// authors worked out by trial what Bambu Connect accepts; its P1S base profile is bundled in
// bambu/base_p1s.json.

const xmlEscape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export const BAMBU_STUDIO_VERSION = "02.05.00.66";
const SLOTS = 5; // P1 with AMS: 4 AMS slots + external spool
const FILAMENT_COLOR = "#F5B301";

// 1x1 transparent PNG, used when no preview image is available.
const PLACEHOLDER_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1,
  13, 10, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

// Keys Bambu Connect requires that the base profile may lack.
const BC_REQUIRED_KEYS = {
  bbl_use_printhost: "1", default_bed_type: "", filament_retract_lift_above: ["0"],
  filament_retract_lift_below: ["0"], filament_retract_lift_enforce: [""], host_type: "octoprint",
  pellet_flow_coefficient: "0", pellet_modded_printer: "0", printhost_authorization_type: "key",
  printhost_ssl_ignore_revoke: "0", thumbnails_format: "BTT_TFT",
};

const PLATE_TEMP_KEYS = {
  "Textured PEI Plate": "textured_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Cool Plate": "cool_plate_temp",
};

// profiles: { base: {...}, varyingKeys: [...], filaments: { PLA: {...}, PETG: {...} } }
export function projectSettings(o, profiles) {
  const p = PRINTERS[o.printer];
  const fil = profiles.filaments[o.filament];
  if (!fil) throw new Error("No settings profile for " + o.filament);
  const out = {};
  for (const [k, v] of Object.entries(profiles.base)) out[k] = Array.isArray(v) ? v.slice() : v;
  for (const k of profiles.varyingKeys) {
    out[k] = Array(SLOTS).fill(k in fil ? String(fil[k]) : "");
  }
  out.filament_colour = Array(SLOTS).fill(FILAMENT_COLOR);

  // What this print actually uses.
  const temp = String(o.nozzleTemp), bed = String(o.bedTemp);
  out.nozzle_temperature = Array(SLOTS).fill(temp);
  out.nozzle_temperature_initial_layer = Array(SLOTS).fill(temp);
  const plateKey = PLATE_TEMP_KEYS[o.plate];
  if (plateKey) {
    out[plateKey] = Array(SLOTS).fill(bed);
    out[plateKey + "_initial_layer"] = Array(SLOTS).fill(bed);
  }
  Object.assign(out, {
    printer_model: p.name,
    printer_settings_id: p.name + " 0.4 nozzle",
    curr_bed_type: o.plate,
    layer_height: String(o.layerHeight),
    wall_loops: String(o.walls),
    sparse_infill_density: o.infill + "%",
    enable_support: o.support !== "off" ? "1" : "0",
    support_on_build_plate_only: o.support === "buildplate" ? "1" : "0",
    brim_type: o.brim ? "outer_only" : "no_brim",
    filament_settings_id: Array(SLOTS).fill(String(fil.filament_settings_id)),
  });
  if (Array.isArray(out.default_filament_profile)) {
    out.default_filament_profile = out.default_filament_profile.map((s) => s.replace(/P1S/g, o.printer));
  }

  for (const [k, v] of Object.entries(BC_REQUIRED_KEYS)) {
    if (!(k in out)) out[k] = Array.isArray(v) ? v.slice() : v;
  }
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length > 0 && v.length < SLOTS) {
      const padded = v.slice();
      while (padded.length < SLOTS) padded.push(padded[padded.length - 1]);
      out[k] = padded;
    }
  }
  return out;
}

const ones = (n, v) => Array(n).fill(v).join(" ");

function modelSettingsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    "  <plate>",
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="plater_name" value=""/>',
    '    <metadata key="locked" value="false"/>',
    '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
    '    <metadata key="filament_maps" value="' + ones(SLOTS, "1") + '"/>',
    '    <metadata key="filament_volume_maps" value="' + ones(SLOTS, "0") + '"/>',
    '    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>',
    '    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>',
    '    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>',
    '    <metadata key="top_file" value="Metadata/top_1.png"/>',
    '    <metadata key="pick_file" value="Metadata/pick_1.png"/>',
    '    <metadata key="pattern_bbox_file" value="Metadata/plate_1.json"/>',
    "  </plate>",
    "</config>",
    "",
  ].join("\n");
}

function sliceInfoXml(o, stats) {
  const p = PRINTERS[o.printer], f = FILAMENTS[o.filament];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    "  <header>",
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
    '    <header_item key="X-BBL-Client-Version" value="' + BAMBU_STUDIO_VERSION + '"/>',
    "  </header>",
    "  <plate>",
    '    <metadata key="index" value="1"/>',
    '    <metadata key="extruder_type" value="0"/>',
    '    <metadata key="nozzle_volume_type" value="0"/>',
    '    <metadata key="printer_model_id" value="' + p.modelId + '"/>',
    '    <metadata key="nozzle_diameters" value="0.4"/>',
    '    <metadata key="timelapse_type" value="0"/>',
    '    <metadata key="prediction" value="' + stats.printSeconds + '"/>',
    '    <metadata key="weight" value="' + stats.grams.toFixed(2) + '"/>',
    '    <metadata key="outside" value="false"/>',
    '    <metadata key="support_used" value="' + (o.support !== "off") + '"/>',
    '    <metadata key="label_object_enabled" value="false"/>',
    '    <metadata key="filament_maps" value="' + ones(SLOTS, "1") + '"/>',
    '    <metadata key="limit_filament_maps" value="' + ones(SLOTS, "0") + '"/>',
    '    <object identify_id="1" name="' + xmlEscape(o.name) + '" skipped="false" />',
    '    <filament id="1" tray_info_idx="' + f.trayInfo + '" type="' + f.type + '" color="' + FILAMENT_COLOR +
      '" used_m="' + stats.meters.toFixed(2) + '" used_g="' + stats.grams.toFixed(2) +
      '" used_for_object="true" used_for_support="false" group_id="0" nozzle_diameter="0.40" volume_type="Standard"/>',
    "  </plate>",
    "</config>",
    "",
  ].join("\n");
}

const MODEL_XML = (title) => [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
  ' <metadata name="Application">BambuStudio-' + BAMBU_STUDIO_VERSION + "</metadata>",
  ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
  ...["Copyright", "CreationDate", "Description", "Designer", "DesignerCover", "DesignerUserId", "License",
    "ModificationDate", "Origin", "ProfileCover", "ProfileDescription", "ProfileTitle"]
    .map((n) => ' <metadata name="' + n + '"></metadata>'),
  ' <metadata name="Title">' + xmlEscape(title) + "</metadata>",
  " <resources>",
  " </resources>",
  " <build/>",
  "</model>",
  "",
].join("\n");

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
  ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
  ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
  ' <Default Extension="png" ContentType="image/png"/>\n' +
  ' <Default Extension="gcode" ContentType="text/x.gcode"/>\n' +
  "</Types>";

const RELS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
  ' <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>\n' +
  ' <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>\n' +
  ' <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>\n' +
  "</Relationships>";

const MODEL_SETTINGS_RELS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
  ' <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>\n' +
  "</Relationships>";

// gcode: Uint8Array of the final G-code. thumbnail: optional PNG bytes.
export async function build3mf(gcode, o, stats, thumbnail, profiles) {
  if (!profiles) throw new Error("Bambu settings profiles are missing");
  const enc = new TextEncoder();
  const settings = projectSettings(o, profiles);
  const plate = {
    bed_type: "textured_plate", // Bambu Connect rejects other values here; the real plate is curr_bed_type
    filament_colors: [FILAMENT_COLOR], filament_ids: [0], first_extruder: 0,
    is_seq_print: false, nozzle_diameter: 0.4, version: 2,
  };
  const png = thumbnail && thumbnail.length > 24 ? thumbnail : PLACEHOLDER_PNG;
  const files = [
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES_XML) },
    { name: "Metadata/plate_1.json", data: enc.encode(JSON.stringify(plate)) },
    { name: "3D/3dmodel.model", data: enc.encode(MODEL_XML(o.name)) },
    { name: "Metadata/project_settings.config", data: enc.encode(JSON.stringify(settings, null, 4) + "\n") },
    { name: "Metadata/plate_1.gcode.md5", data: enc.encode(md5(gcode)) },
    { name: "Metadata/plate_1.gcode", data: gcode },
    { name: "Metadata/_rels/model_settings.config.rels", data: enc.encode(MODEL_SETTINGS_RELS_XML) },
    { name: "Metadata/model_settings.config", data: enc.encode(modelSettingsXml()) },
    { name: "Metadata/slice_info.config", data: enc.encode(sliceInfoXml(o, stats)) },
    { name: "_rels/.rels", data: enc.encode(RELS_XML) },
    { name: "Metadata/plate_1.png", data: png },
    { name: "Metadata/plate_no_light_1.png", data: png },
    { name: "Metadata/plate_1_small.png", data: png },
    { name: "Metadata/top_1.png", data: PLACEHOLDER_PNG },
    { name: "Metadata/pick_1.png", data: PLACEHOLDER_PNG },
  ];
  return zip(files);
}

// ---- Whole pipeline ------------------------------------------------------------------------

// env: { createEngine(opts) -> Promise<emscripten module>, definitions: {name: text},
//        templates: {name: text}, profiles (see projectSettings), onProgress(0..1), onLog(text) }
export async function slice(stlBytes, options, env, thumbnail) {
  const o = { ...DEFAULTS, ...options };
  if (!PRINTERS[o.printer]) throw new Error("Unknown printer " + o.printer);
  if (!FILAMENTS[o.filament]) throw new Error("Unknown filament " + o.filament);
  if (!(o.layerHeight >= 0.08 && o.layerHeight <= 0.28)) throw new Error("Layer height must be 0.08 to 0.28 mm");
  if (!(o.nozzleTemp >= 170 && o.nozzleTemp <= 300)) throw new Error("Nozzle temperature must be 170 to 300 °C");
  if (!(o.bedTemp >= 0 && o.bedTemp <= 110)) throw new Error("Bed temperature must be 0 to 110 °C");
  o.walls = Math.max(1, Math.min(6, Math.round(o.walls)));

  const mesh = prepareMesh(stlBytes, o.brim ? 6 : 2);
  const log = env.onLog || (() => {});
  const engine = await env.createEngine({ noInitialRun: true, print: log, printErr: log });
  engine.FS.mkdir("/defs");
  for (const [name, text] of Object.entries(env.definitions)) engine.FS.writeFile("/defs/" + name, text);
  engine.FS.writeFile("/defs/printer.def.json", JSON.stringify({
    version: 2, name: PRINTERS[o.printer].name, inherits: "fdmprinter",
    metadata: { machine_extruder_trains: { "0": "fdmextruder" } }, overrides: {},
  }));
  engine.FS.writeFile("/model.stl", mesh.stl);

  let usedMm3 = 0;
  globalThis["cura-wasm-progress-callback"] = (v) => env.onProgress && env.onProgress(v);
  globalThis["cura-wasm-metadata-callback"] = (flavor, time, material1) => { if (time !== 6666) usedMm3 = material1; };
  try {
    engine.callMain(curaArgs(o, { definition: "/defs/printer.def.json", output: "/out.gcode", model: "/model.stl" }));
  } catch (e) {
    if (!(e && e.name === "ExitStatus")) throw new Error("Slicer crashed: " + ((e && e.message) || e));
  } finally {
    delete globalThis["cura-wasm-progress-callback"];
    delete globalThis["cura-wasm-metadata-callback"];
  }
  let raw;
  try { raw = engine.FS.readFile("/out.gcode"); } catch (e) { throw new Error("Slicer produced no output"); }
  const { text, stats } = assembleGcode(new TextDecoder().decode(raw), o, mesh, env.templates, usedMm3);
  const gcode = new TextEncoder().encode(text);
  const project = await build3mf(gcode, o, stats, thumbnail, env.profiles);
  return { gcode, project, stats, options: o };
}
