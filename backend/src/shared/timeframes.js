"use strict";

// Matches frontend list in index.html and alignment logic in js/chart.js#getBarTime.
const SUPPORTED_TIMEFRAMES = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "1d",
  "3d",
  "1w",
];

const SECONDS_BY_TF = {
  "1m": 60,
  "3m": 3 * 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "2h": 2 * 60 * 60,
  "4h": 4 * 60 * 60,
  "6h": 6 * 60 * 60,
  "12h": 12 * 60 * 60,
  "1d": 24 * 60 * 60,
  "3d": 3 * 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
};

// Jan 5, 1970 00:00 UTC (Monday). Same constant used in frontend.
const REFERENCE_MONDAY = 345600;

function alignBarStart(tsSec, timeframe) {
  const seconds = SECONDS_BY_TF[timeframe] || SECONDS_BY_TF["4h"];
  if (timeframe === "1w") {
    const sinceRef = tsSec - REFERENCE_MONDAY;
    const weeks = Math.floor(sinceRef / seconds);
    return REFERENCE_MONDAY + weeks * seconds;
  }
  return Math.floor(tsSec / seconds) * seconds;
}

module.exports = {
  SUPPORTED_TIMEFRAMES,
  SECONDS_BY_TF,
  REFERENCE_MONDAY,
  alignBarStart,
};
