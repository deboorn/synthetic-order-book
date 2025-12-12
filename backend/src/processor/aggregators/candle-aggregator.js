"use strict";

const { alignBarStart } = require("../../shared/timeframes");

class CandleAggregator {
  constructor({ symbol, timeframe, onCandle }) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.onCandle = onCandle;

    this.current = null; // { time, open, high, low, close, volume }
  }

  ingestBaseCandle({ timeSec, open, high, low, close, volume }) {
    const barStart = alignBarStart(timeSec, this.timeframe);

    if (!this.current) {
      this.current = {
        time: barStart,
        open,
        high,
        low,
        close,
        volume: volume || 0,
      };
      return;
    }

    if (barStart === this.current.time) {
      this.current.high = Math.max(this.current.high, high);
      this.current.low = Math.min(this.current.low, low);
      this.current.close = close;
      this.current.volume += volume || 0;
      return;
    }

    if (barStart > this.current.time) {
      const finished = this.current;
      this.onCandle(finished);

      this.current = {
        time: barStart,
        open,
        high,
        low,
        close,
        volume: volume || 0,
      };
      return;
    }

    // out-of-order; ignore to keep outputs append-only
  }

  flush() {
    if (this.current) {
      this.onCandle(this.current);
      this.current = null;
    }
  }
}

module.exports = { CandleAggregator };
