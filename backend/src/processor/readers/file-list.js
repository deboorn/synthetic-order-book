"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(p) {
    let ents;
    try {
      ents = await fsp.readdir(p, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of ents) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  // Sort deterministically, with special handling for hourly raw files:
  // HH.ndjson should come before HH-001.ndjson, HH-002.ndjson, ...
  out.sort((a, b) => {
    const pa = a.split(path.sep);
    const pb = b.split(path.sep);

    // Compare directory parts first.
    const da = pa.slice(0, -1).join(path.sep);
    const db = pb.slice(0, -1).join(path.sep);
    if (da !== db) return da < db ? -1 : 1;

    const fa = pa[pa.length - 1];
    const fb = pb[pb.length - 1];

    const ra = fa.match(/^(\d{2})(?:-(\d{3}))?\.ndjson(?:\.tmp)?$/);
    const rb = fb.match(/^(\d{2})(?:-(\d{3}))?\.ndjson(?:\.tmp)?$/);
    if (ra && rb) {
      const ha = Number(ra[1]);
      const hb = Number(rb[1]);
      if (ha !== hb) return ha - hb;
      const partA = ra[2] ? Number(ra[2]) : 0;
      const partB = rb[2] ? Number(rb[2]) : 0;
      if (partA !== partB) return partA - partB;
    }

    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  return out;
}

module.exports = { listFilesRecursive };
