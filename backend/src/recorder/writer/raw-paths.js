"use strict";

const path = require("path");
const { utcPartsFromMs } = require("../../shared/paths");

function rawFilePathForTsMs({ outDir, exchange, stream, symbol }, tsMs) {
  const { YYYY, MM, DD, HH } = utcPartsFromMs(tsMs);
  const baseDir = path.join(outDir, "raw", exchange, stream, symbol, YYYY, MM, DD);
  const name = `${HH}.ndjson`;
  const finalPath = path.join(baseDir, name);
  const tmpPath = finalPath + ".tmp";
  const hourKey = `${YYYY}${MM}${DD}${HH}`;
  return { finalPath, tmpPath, hourKey };
}

module.exports = { rawFilePathForTsMs };
