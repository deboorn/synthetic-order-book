"use strict";

const path = require("path");
const { utcPartsFromMs } = require("../../shared/paths");

function pad3(n) {
  return String(n).padStart(3, "0");
}

function rawFilePathForTsMs({ outDir, exchange, stream, symbol }, tsMs, part = 0) {
  const { YYYY, MM, DD, HH } = utcPartsFromMs(tsMs);
  const baseDir = path.join(outDir, "raw", exchange, stream, symbol, YYYY, MM, DD);
  // Keep the original naming for part 0; add suffixes for additional rotations.
  const name = part > 0 ? `${HH}-${pad3(part)}.ndjson` : `${HH}.ndjson`;
  const finalPath = path.join(baseDir, name);
  const tmpPath = finalPath + ".tmp";
  const key = `${YYYY}${MM}${DD}${HH}`;
  return { finalPath, tmpPath, key };
}

module.exports = { rawFilePathForTsMs };
