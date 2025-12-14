"use strict";

const { BaseConnector } = require("./base");

/**
 * Kraken Order Book Connector with 1-minute sampling.
 * 
 * Instead of recording every tick (which can be 100k+ records/hour),
 * we maintain the book state internally and only emit a full snapshot
 * at the START of each 1-minute candle boundary.
 * 
 * This matches how TradingView and institutional platforms handle
 * historical order book data for charting/backtesting.
 */
class KrakenBookConnector extends BaseConnector {
  constructor({ symbol, pair, depth = 100, sampleIntervalMs = 60000, onRecord, logger }) {
    super({ name: `kraken_book_${symbol}`, url: "wss://ws.kraken.com", onRecord, logger });
    this.symbol = symbol;
    this.pair = pair;
    this.depth = Number(depth) || 100;
    this.sampleIntervalMs = sampleIntervalMs; // Default 1 minute
    
    // Internal book state
    this.bids = new Map(); // price -> size
    this.asks = new Map(); // price -> size
    this.lastEmitMinute = null;
    this.hasReceivedSnapshot = false;
  }

  async onOpen(ws) {
    // Reset state on reconnect
    this.bids.clear();
    this.asks.clear();
    this.lastEmitMinute = null;
    this.hasReceivedSnapshot = false;
    
    ws.send(
      JSON.stringify({
        event: "subscribe",
        pair: [this.pair],
        subscription: { name: "book", depth: this.depth },
      })
    );
  }

  _getMinuteBoundary(tsMs) {
    return Math.floor(tsMs / this.sampleIntervalMs) * this.sampleIntervalMs;
  }

  _applyDelta(map, updates) {
    for (const [price, size] of updates) {
      if (size === 0) {
        map.delete(price);
      } else {
        map.set(price, size);
      }
    }
  }

  _getTopLevels(map, count, descending = false) {
    const sorted = Array.from(map.entries()).sort((a, b) => 
      descending ? b[0] - a[0] : a[0] - b[0]
    );
    return sorted.slice(0, count).map(([price, size]) => [price, size]);
  }

  _emitSnapshot(ts_capture_ms) {
    // Get top N levels sorted correctly
    const bids = this._getTopLevels(this.bids, this.depth, true);  // Descending (highest first)
    const asks = this._getTopLevels(this.asks, this.depth, false); // Ascending (lowest first)
    
    const minuteBoundary = this._getMinuteBoundary(ts_capture_ms);
    
    this.onRecord({
      v: 1,
      ts_capture_ms: minuteBoundary, // Use the minute boundary as timestamp
      exchange: "kraken",
      stream: "book",
      symbol: this.symbol,
      ts_event_ms: minuteBoundary,
      seq: this._nextSeq(),
      payload: {
        type: "snapshot",
        sampled: true, // Flag to indicate this is a sampled snapshot
        interval_ms: this.sampleIntervalMs,
        depth: this.depth,
        pair: this.pair,
        bids, // [price, size]
        asks, // [price, size]
      },
      raw: null,
    });
    
    this.lastEmitMinute = minuteBoundary;
  }

  onMessage(buf) {
    const ts_capture_ms = Date.now();
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch (_) {
      return;
    }

    // status / lifecycle - always record these
    if (msg && msg.event) {
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "kraken",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: msg,
        raw: null,
      });
      return;
    }

    // Book format: [channelID, data, "book-100", "pair"]
    if (!Array.isArray(msg) || msg.length < 4) return;
    if (typeof msg[2] !== "string" || !msg[2].startsWith("book")) return;

    const d = msg[1] || {};
    const isSnapshot = d.as !== undefined || d.bs !== undefined;

    const bidsRaw = isSnapshot ? d.bs : d.b;
    const asksRaw = isSnapshot ? d.as : d.a;

    const bidsUpdates = Array.isArray(bidsRaw)
      ? bidsRaw
          .map((r) => [parseFloat(r[0]), parseFloat(r[1])])
          .filter((r) => isFinite(r[0]) && isFinite(r[1]))
      : [];
    const asksUpdates = Array.isArray(asksRaw)
      ? asksRaw
          .map((r) => [parseFloat(r[0]), parseFloat(r[1])])
          .filter((r) => isFinite(r[0]) && isFinite(r[1]))
      : [];

    // Apply updates to internal state
    if (isSnapshot) {
      // Full snapshot - replace entire book
      this.bids.clear();
      this.asks.clear();
      for (const [price, size] of bidsUpdates) {
        if (size > 0) this.bids.set(price, size);
      }
      for (const [price, size] of asksUpdates) {
        if (size > 0) this.asks.set(price, size);
      }
      this.hasReceivedSnapshot = true;
    } else {
      // Delta - apply changes
      this._applyDelta(this.bids, bidsUpdates);
      this._applyDelta(this.asks, asksUpdates);
    }

    // Check if we should emit a snapshot (at minute boundary)
    if (!this.hasReceivedSnapshot) return;
    
    const currentMinute = this._getMinuteBoundary(ts_capture_ms);
    if (this.lastEmitMinute === null || currentMinute > this.lastEmitMinute) {
      this._emitSnapshot(ts_capture_ms);
    }
  }
}

module.exports = { KrakenBookConnector };
