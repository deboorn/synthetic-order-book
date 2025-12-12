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
  out.sort();
  return out;
}

module.exports = { listFilesRecursive };
