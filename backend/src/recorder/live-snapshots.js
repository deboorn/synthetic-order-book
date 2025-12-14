/**
 * Live Snapshot Generator
 * 
 * Generates book snapshots in real-time as candles close during recording.
 * Coordinates OHLC and book data to produce snapshots that can be streamed
 * to the frontend for live metric computation.
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const EventEmitter = require("events");

const MAX_BOOK_LEVELS = 200;

/**
 * OrderBook - Maintains current order book state
 */
class OrderBook {
  constructor() {
    this.bids = new Map();
    this.asks = new Map();
    this.lastUpdateMs = 0;
  }

  apply(payload) {
    if (!payload) return;
    const bids = payload.bids || [];
    const asks = payload.asks || [];

    for (const [price, size] of bids) {
      const pf = parseFloat(price);
      const sf = parseFloat(size);
      if (sf > 0) this.bids.set(pf, sf);
      else this.bids.delete(pf);
    }

    for (const [price, size] of asks) {
      const pf = parseFloat(price);
      const sf = parseFloat(size);
      if (sf > 0) this.asks.set(pf, sf);
      else this.asks.delete(pf);
    }

    this.lastUpdateMs = Date.now();
  }

  getSnapshot(maxLevels = MAX_BOOK_LEVELS) {
    if (this.bids.size === 0 && this.asks.size === 0) return null;

    const bidPrices = Array.from(this.bids.keys()).sort((a, b) => b - a).slice(0, maxLevels);
    const askPrices = Array.from(this.asks.keys()).sort((a, b) => a - b).slice(0, maxLevels);

    return {
      bids: bidPrices.map((p) => [p, this.bids.get(p)]),
      asks: askPrices.map((p) => [p, this.asks.get(p)]),
    };
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateMs = 0;
  }
}

/**
 * LiveSnapshotGenerator - Generates snapshots as candles close
 * 
 * Events:
 *   - "snapshot" (snapshot) - Emitted when a new snapshot is ready
 *   - "status" (status) - Emitted when recording status changes
 */
class LiveSnapshotGenerator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.symbol = options.symbol || "BTC";
    this.outDir = options.outDir;
    this.logger = options.logger || console;

    this.orderBook = new OrderBook();
    this.currentCandle = null;
    this.lastCandleTime = 0;
    this.snapshotCount = 0;
    
    // Output file for live snapshots
    this.outputStream = null;
    this.outputPath = null;
    
    // Status tracking
    this.isRecording = false;
    this.startTime = null;
  }

  async start() {
    if (this.isRecording) return;
    
    // Create output directory
    const snapshotsDir = path.join(this.outDir, "derived", this.symbol, "snapshots");
    await fsp.mkdir(snapshotsDir, { recursive: true });
    
    // Live snapshots go to a separate file that gets appended
    this.outputPath = path.join(snapshotsDir, "live.ndjson");
    this.outputStream = fs.createWriteStream(this.outputPath, { flags: "w" });
    
    this.isRecording = true;
    this.startTime = Date.now();
    this.snapshotCount = 0;
    
    this.logger.log(`[live-snapshots] Started for ${this.symbol}`);
    this.logger.log(`[live-snapshots] Output: ${this.outputPath}`);
    
    this.emit("status", { recording: true, symbol: this.symbol, startTime: this.startTime });
  }

  async stop() {
    if (!this.isRecording) return;
    
    this.isRecording = false;
    
    if (this.outputStream) {
      this.outputStream.end();
      this.outputStream = null;
    }
    
    this.logger.log(`[live-snapshots] Stopped. Generated ${this.snapshotCount} snapshots`);
    
    this.emit("status", { recording: false, symbol: this.symbol, snapshotCount: this.snapshotCount });
  }

  /**
   * Process incoming OHLC record
   * When a new candle arrives, the previous candle is "closed" - generate snapshot
   */
  onOHLC(record) {
    if (!this.isRecording) return;
    if (!record || !record.payload) return;

    const p = record.payload;
    const candleTime = p.end_time_sec || p.time_sec || Math.floor(Date.now() / 1000);
    
    // First candle - just store it
    if (this.lastCandleTime === 0) {
      this.currentCandle = {
        time: candleTime,
        open: Number(p.open),
        high: Number(p.high),
        low: Number(p.low),
        close: Number(p.close),
        volume: Number(p.volume) || 0,
      };
      this.lastCandleTime = candleTime;
      return;
    }
    
    // New candle means previous one closed
    if (candleTime > this.lastCandleTime && this.currentCandle) {
      this._emitSnapshot();
    }
    
    // Update current candle
    this.currentCandle = {
      time: candleTime,
      open: Number(p.open),
      high: Number(p.high),
      low: Number(p.low),
      close: Number(p.close),
      volume: Number(p.volume) || 0,
    };
    this.lastCandleTime = candleTime;
  }

  /**
   * Process incoming book record
   */
  onBook(record) {
    if (!this.isRecording) return;
    if (!record || !record.payload) return;
    
    this.orderBook.apply(record.payload);
  }

  /**
   * Emit a snapshot for the current candle
   */
  _emitSnapshot() {
    if (!this.currentCandle) return;
    
    const book = this.orderBook.getSnapshot(MAX_BOOK_LEVELS);
    if (!book) return;
    
    const snapshot = {
      time: this.currentCandle.time,
      candle: {
        o: this.currentCandle.open,
        h: this.currentCandle.high,
        l: this.currentCandle.low,
        c: this.currentCandle.close,
        v: this.currentCandle.volume,
      },
      book: book,
    };
    
    // Write to file
    if (this.outputStream) {
      const line = JSON.stringify(snapshot) + "\n";
      this.outputStream.write(line);
    }
    
    this.snapshotCount++;
    
    // Emit event for WebSocket broadcast
    this.emit("snapshot", snapshot);
    
    if (this.snapshotCount % 10 === 0) {
      this.logger.log(`[live-snapshots] ${this.snapshotCount} snapshots generated`);
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      recording: this.isRecording,
      symbol: this.symbol,
      startTime: this.startTime,
      snapshotCount: this.snapshotCount,
      lastCandleTime: this.lastCandleTime,
      hasBook: this.orderBook.bids.size > 0 || this.orderBook.asks.size > 0,
    };
  }
}

module.exports = { LiveSnapshotGenerator, OrderBook };

