"use strict";

const { BaseConnector } = require("./base");

/**
 * Bitstamp Order Book Connector with 1-minute sampling.
 * 
 * Bitstamp sends full snapshots on each update (not deltas).
 * We only emit at the START of each 1-minute candle boundary.
 */
class BitstampOrderBookConnector extends BaseConnector {
  constructor({ symbol, pair, sampleIntervalMs = 60000, onRecord, logger }) {
    super({ name: `bitstamp_book_${symbol}`, url: "wss://ws.bitstamp.net", onRecord, logger });
    this.symbol = symbol;
    this.pair = pair;
    this.sampleIntervalMs = sampleIntervalMs;
    
    // Track last emitted minute
    this.lastEmitMinute = null;
    // Store latest snapshot for emission
    this.latestSnapshot = null;
  }

  async onOpen(ws) {
    this.lastEmitMinute = null;
    this.latestSnapshot = null;
    
    ws.send(
      JSON.stringify({
        event: "bts:subscribe",
        data: { channel: `order_book_${this.pair}` },
      })
    );
  }

  _getMinuteBoundary(tsMs) {
    return Math.floor(tsMs / this.sampleIntervalMs) * this.sampleIntervalMs;
  }

  onMessage(buf) {
    const ts_capture_ms = Date.now();
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch (_) {
      return;
    }

    if (msg.event === "data" && msg.data) {
      const bidsRaw = Array.isArray(msg.data.bids) ? msg.data.bids : [];
      const asksRaw = Array.isArray(msg.data.asks) ? msg.data.asks : [];

      const bids = bidsRaw
        .map((r) => [parseFloat(r[0]), parseFloat(r[1])])
        .filter((r) => isFinite(r[0]) && isFinite(r[1]) && r[1] > 0)
        .slice(0, 100); // Limit to 100 levels
      const asks = asksRaw
        .map((r) => [parseFloat(r[0]), parseFloat(r[1])])
        .filter((r) => isFinite(r[0]) && isFinite(r[1]) && r[1] > 0)
        .slice(0, 100); // Limit to 100 levels

      // Store latest snapshot
      this.latestSnapshot = { bids, asks, timestamp: msg.data.timestamp };

      // Check if we should emit
      const currentMinute = this._getMinuteBoundary(ts_capture_ms);
      if (this.lastEmitMinute === null || currentMinute > this.lastEmitMinute) {
        const minuteBoundary = currentMinute;
        
        this.onRecord({
          v: 1,
          ts_capture_ms: minuteBoundary,
          exchange: "bitstamp",
          stream: "book",
          symbol: this.symbol,
          ts_event_ms: minuteBoundary,
          seq: this._nextSeq(),
          payload: {
            type: "snapshot",
            sampled: true,
            interval_ms: this.sampleIntervalMs,
            pair: this.pair,
            bids,
            asks,
          },
          raw: null,
        });
        
        this.lastEmitMinute = minuteBoundary;
      }
      return;
    }

    if (msg.event && msg.event.startsWith("bts:")) {
      // subscription lifecycle messages
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "bitstamp",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: msg,
        raw: null,
      });
    }
  }
}

module.exports = { BitstampOrderBookConnector };
