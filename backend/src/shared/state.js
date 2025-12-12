"use strict";

const fs = require("fs");
const fsp = fs.promises;

async function readJsonIfExists(filePath, fallback) {
  try {
    const s = await fsp.readFile(filePath, "utf8");
    return JSON.parse(s);
  } catch (e) {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = filePath + ".tmp";
  await fsp.mkdir(require("path").dirname(filePath), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, filePath);
}

module.exports = { readJsonIfExists, writeJsonAtomic };
