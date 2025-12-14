"use strict";

const { BaseConnector } = require("./base");

/**
 * Coinbase Level2 Order Book Connector with 1-minute sampling.
 * 
 * Instead of recording every tick, we maintain the book state internally
 * and only emit a full snapshot at the START of each 1-minute candle boundary.
 */
class CoinbaseLevel2Connector extends BaseConnector {
  constructor({ symbol, productId, sampleIntervalMs = 60000, onRecord, logger }) {
    super({ name: `coinbase_level2_${symbol}`, url: "wss://ws-feed.exchange.coinbase.com", onRecord, logger });
    this.symbol = symbol;
    this.productId = productId;
    this.sampleIntervalMs = sampleIntervalMs;
    
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
        type: "subscribe",
        product_ids: [this.productId],
        channels: ["level2_batch"],
      })
    );
  }

  _getMinuteBoundary(tsMs) {
    return Math.floor(tsMs / this.sampleIntervalMs) * this.sampleIntervalMs;
  }

  _getTopLevels(map, count, descending = false) {
    const sorted = Array.from(map.entries()).sort((a, b) => 
      descending ? b[0] - a[0] : a[0] - b[0]
    );
    return sorted.slice(0, count).map(([price, size]) => [price, size]);
  }

  _emitSnapshot(ts_capture_ms) {
    const bids = this._getTopLevels(this.bids, 100, true);  // Top 100 bids
    const asks = this._getTopLevels(this.asks, 100, false); // Top 100 asks
    
    const minuteBoundary = this._getMinuteBoundary(ts_capture_ms);
    
    this.onRecord({
      v: 1,
      ts_capture_ms: minuteBoundary,
      exchange: "coinbase",
      stream: "book",
      symbol: this.symbol,
      ts_event_ms: minuteBoundary,
      seq: this._nextSeq(),
      payload: {
        type: "snapshot",
        sampled: true,
        interval_ms: this.sampleIntervalMs,
        product_id: this.productId,
        bids,
        asks,
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

    if (msg.type === "snapshot" && Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
      // Full snapshot - replace entire book
      this.bids.clear();
      this.asks.clear();
      
      for (const r of msg.bids) {
        const price = parseFloat(r[0]);
        const size = parseFloat(r[1]);
        if (isFinite(price) && isFinite(size) && size > 0) {
          this.bids.set(price, size);
        }
      }
      for (const r of msg.asks) {
        const price = parseFloat(r[0]);
        const size = parseFloat(r[1]);
        if (isFinite(price) && isFinite(size) && size > 0) {
          this.asks.set(price, size);
        }
      }
      
      this.hasReceivedSnapshot = true;
      
      // Emit immediately on first snapshot
      const currentMinute = this._getMinuteBoundary(ts_capture_ms);
      if (this.lastEmitMinute === null) {
        this._emitSnapshot(ts_capture_ms);
      }
      return;
    }

    if (msg.type === "l2update" && Array.isArray(msg.changes)) {
      // Apply delta changes
      for (const r of msg.changes) {
        const side = String(r[0] || "");
        const price = parseFloat(r[1]);
        const size = parseFloat(r[2]);
        
        if (!isFinite(price) || !isFinite(size)) continue;
        
        const map = side === "buy" ? this.bids : side === "sell" ? this.asks : null;
        if (!map) continue;
        
        if (size === 0) {
          map.delete(price);
        } else {
          map.set(price, size);
        }
      }
      
      // Check if we should emit
      if (!this.hasReceivedSnapshot) return;
      
      const currentMinute = this._getMinuteBoundary(ts_capture_ms);
      if (this.lastEmitMinute === null || currentMinute > this.lastEmitMinute) {
        this._emitSnapshot(ts_capture_ms);
      }
      return;
    }

    if (msg.type === "error") {
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "coinbase",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: { event: "error", message: msg.message, reason: msg.reason || null },
        raw: msg,
      });
    }
  }
}

module.exports = { CoinbaseLevel2Connector };
