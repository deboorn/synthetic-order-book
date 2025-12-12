"use strict";

const path = require("path");
const { RotatingNdjsonWriter } = require("../../recorder/writer/rotating-ndjson-writer");
const { utcPartsFromSec } = require("../../shared/paths");

function candleFilePathForTime({ outDir, symbol, timeframe }, tsSec) {
  const { YYYY, MM, DD } = utcPartsFromSec(tsSec);
  const baseDir = path.join(outDir, "candles", symbol, timeframe, YYYY, MM);
  const name = `${DD}.ndjson`;
  const finalPath = path.join(baseDir, name);
  const tmpPath = finalPath + ".tmp";
  // rotate on day
  const hourKey = `${YYYY}${MM}${DD}`;
  return { finalPath, tmpPath, hourKey };
}

class RotatingCandleWriter {
  constructor({ outDir, symbol, timeframe }) {
    this.outDir = outDir;
    this.symbol = symbol;
    this.timeframe = timeframe;

    this.writer = new RotatingNdjsonWriter({
      filePathForTsMs: (tsMs) => {
        // We rotate by day based on the candle time, not current wall clock.
        const tsSec = Math.floor(tsMs / 1000);
        return candleFilePathForTime({ outDir, symbol, timeframe }, tsSec);
      },
    });
  }

  async writeCandle(c) {
    await this.writer.write({
      v: 1,
      // Ensure rotation is based on candle time (not wall clock).
      ts_capture_ms: c.time * 1000,
      symbol: this.symbol,
      timeframe: this.timeframe,
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
  }

  async close() {
    await this.writer.close();
  }
}

module.exports = { RotatingCandleWriter };
