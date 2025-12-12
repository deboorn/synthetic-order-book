"use strict";

const path = require("path");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function utcPartsFromMs(tsMs) {
  const d = new Date(tsMs);
  return {
    YYYY: String(d.getUTCFullYear()),
    MM: pad2(d.getUTCMonth() + 1),
    DD: pad2(d.getUTCDate()),
    HH: pad2(d.getUTCHours()),
  };
}

function utcPartsFromSec(tsSec) {
  return utcPartsFromMs(tsSec * 1000);
}

function join(...parts) {
  return path.join(...parts);
}

module.exports = { utcPartsFromMs, utcPartsFromSec, join };
