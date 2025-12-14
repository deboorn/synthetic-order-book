/**
 * snapshots.js - Generate book snapshots per candle for replay
 * 
 * Stores the book state at each candle close, allowing frontend to compute
 * metrics dynamically with user-adjustable settings.
 * 
 * Usage:
 *   node src/processor/snapshots.js --session=20251213-031154_BTC_2h --symbol=BTC --timeframe=1m
 *   node src/processor/snapshots.js --session=20251213-031154_BTC_2h --symbol=BTC --timeframe=1m --maxCandles=10
 * 
 * Output:
 *   captures/{session}/derived/{symbol}/snapshots/{timeframe}.ndjson
 *   Each line: { time, candle: {o,h,l,c,v}, book: { bids: [[price,size],...], asks: [[price,size],...] } }
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const { parseArgs } = require("../shared/cli");

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
const TF_SECONDS = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "12h": 43200,
  "1d": 86400, "3d": 259200, "1w": 604800,
};

// Max book levels to store per side (keeps file size manageable)
const MAX_BOOK_LEVELS = 200;

// ─────────────────────────────────────────────────────────────
// NDJSON Stream Reader
// ─────────────────────────────────────────────────────────────
async function* readNdjsonFiles(dir, pattern = /\.ndjson(\.tmp)?$/) {
  if (!fs.existsSync(dir)) return;

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* readNdjsonFiles(fullPath, pattern);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      files.push(fullPath);
    }
  }

  files.sort();

  for (const filePath of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Order Book State
// ─────────────────────────────────────────────────────────────
class OrderBook {
  constructor() {
    this.bids = new Map(); // price -> size
    this.asks = new Map();
    this.lastUpdateMs = 0;
  }

  apply(rec) {
    if (!rec || !rec.payload) return;
    const p = rec.payload;
    const bids = p.bids || [];
    const asks = p.asks || [];

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

    this.lastUpdateMs = Number(rec.ts_capture_ms || rec.ts_event_ms || 0);
  }

  getSnapshot(maxLevels = MAX_BOOK_LEVELS) {
    if (this.bids.size === 0 && this.asks.size === 0) return null;

    // Sort and limit
    const bidPrices = Array.from(this.bids.keys()).sort((a, b) => b - a).slice(0, maxLevels);
    const askPrices = Array.from(this.asks.keys()).sort((a, b) => a - b).slice(0, maxLevels);

    return {
      bids: bidPrices.map((p) => [p, this.bids.get(p)]),
      asks: askPrices.map((p) => [p, this.asks.get(p)]),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Build candles from raw OHLC
// ─────────────────────────────────────────────────────────────
async function loadCandles(sessionDir, symbol, tfSeconds) {
  const ohlcDir = path.join(sessionDir, "raw", "kraken", "ohlc", symbol);
  const map = new Map();

  for await (const rec of readNdjsonFiles(ohlcDir)) {
    const p = rec.payload;
    if (!p) continue;
    const ts = p.end_time_sec || p.time_sec || Math.floor((rec.ts_capture_ms || 0) / 1000);
    const bucket = Math.floor(ts / tfSeconds) * tfSeconds;

    if (!map.has(bucket)) {
      map.set(bucket, {
        time: bucket,
        open: Number(p.open),
        high: Number(p.high),
        low: Number(p.low),
        close: Number(p.close),
        volume: Number(p.volume) || 0,
      });
    } else {
      const c = map.get(bucket);
      c.high = Math.max(c.high, Number(p.high));
      c.low = Math.min(c.low, Number(p.low));
      c.close = Number(p.close);
      c.volume += Number(p.volume) || 0;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

// ─────────────────────────────────────────────────────────────
// Main processor
// ─────────────────────────────────────────────────────────────
async function processSnapshots(options) {
  const { session, symbol, timeframe, maxCandles, sessionDir } = options;
  const tfSeconds = TF_SECONDS[timeframe];

  if (!tfSeconds) {
    console.error(`[snapshots] Invalid timeframe: ${timeframe}`);
    process.exit(1);
  }

  console.log(`[snapshots] Processing ${session} / ${symbol} / ${timeframe}`);
  console.log(`[snapshots] Session dir: ${sessionDir}`);

  // Load candles
  console.log(`[snapshots] Loading candles...`);
  let candles = await loadCandles(sessionDir, symbol, tfSeconds);
  console.log(`[snapshots] Loaded ${candles.length} candles`);

  if (candles.length === 0) {
    console.error(`[snapshots] No candles found`);
    process.exit(1);
  }

  // Apply max candles limit
  if (maxCandles && maxCandles > 0 && candles.length > maxCandles) {
    candles = candles.slice(-maxCandles);
    console.log(`[snapshots] Limited to last ${maxCandles} candles`);
  }

  // Calculate time bounds
  const firstCandleMs = candles[0].time * 1000;
  const lastCandleMs = (candles[candles.length - 1].time + tfSeconds) * 1000;
  console.log(`[snapshots] Time range: ${new Date(firstCandleMs).toISOString()} - ${new Date(lastCandleMs).toISOString()}`);

  // Prepare output
  const outputDir = path.join(sessionDir, "derived", symbol, "snapshots");
  await fsp.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${timeframe}.ndjson`);
  const outputStream = fs.createWriteStream(outputPath);

  // Load and index book records
  console.log(`[snapshots] Loading book records...`);
  const bookDirs = [
    path.join(sessionDir, "raw", "kraken", "book", symbol),
    path.join(sessionDir, "raw", "coinbase", "book", symbol),
    path.join(sessionDir, "raw", "bitstamp", "book", symbol),
  ];

  const bookRecords = [];
  for (const dir of bookDirs) {
    for await (const rec of readNdjsonFiles(dir)) {
      const ts = Number(rec.ts_capture_ms || rec.ts_event_ms || 0);
      if (ts >= firstCandleMs - 60000 && ts <= lastCandleMs + 60000) {
        bookRecords.push(rec);
      }
    }
  }

  bookRecords.sort((a, b) => {
    const tsA = Number(a.ts_capture_ms || a.ts_event_ms || 0);
    const tsB = Number(b.ts_capture_ms || b.ts_event_ms || 0);
    return tsA - tsB;
  });

  console.log(`[snapshots] Loaded ${bookRecords.length} book records for ${candles.length} candles`);

  // Process each candle
  const orderBook = new OrderBook();
  let bookIdx = 0;
  let processed = 0;
  let totalBytesWritten = 0;

  for (const candle of candles) {
    const candleEndMs = (candle.time + tfSeconds) * 1000;

    // Apply all book records up to this candle's end
    while (bookIdx < bookRecords.length) {
      const rec = bookRecords[bookIdx];
      const ts = Number(rec.ts_capture_ms || rec.ts_event_ms || 0);
      if (ts > candleEndMs) break;
      orderBook.apply(rec);
      bookIdx++;
    }

    // Get book snapshot
    const book = orderBook.getSnapshot(MAX_BOOK_LEVELS);

    // Write output record
    const record = {
      time: candle.time,
      candle: {
        o: candle.open,
        h: candle.high,
        l: candle.low,
        c: candle.close,
        v: candle.volume,
      },
      book: book || { bids: [], asks: [] },
    };

    const line = JSON.stringify(record) + "\n";
    outputStream.write(line);
    totalBytesWritten += line.length;
    processed++;

    if (processed % 10 === 0 || processed === candles.length) {
      process.stdout.write(`\r[snapshots] Processed ${processed}/${candles.length} candles`);
    }
  }

  outputStream.end();
  const fileSizeKB = Math.round(totalBytesWritten / 1024);
  console.log(`\n[snapshots] Output written to: ${outputPath}`);
  console.log(`[snapshots] File size: ${fileSizeKB} KB (~${Math.round(fileSizeKB / candles.length)} KB/candle)`);
  console.log(`[snapshots] Done.`);
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const session = args.session;
  const symbol = (args.symbol || "BTC").toUpperCase();
  const timeframe = args.timeframe || "1m";
  const maxCandles = args.maxCandles ? parseInt(args.maxCandles, 10) : 0;
  const dataDir = args.dataDir
    ? path.resolve(args.dataDir)
    : path.resolve(__dirname, "..", "..", "data");

  const orderBookRoot = path.resolve(__dirname, "..", "..", "..");
  const defaultCapturesDir = path.join(orderBookRoot, "captures");

  if (!session) {
    console.error("Usage: node src/processor/snapshots.js --session=<session> [--symbol=BTC] [--timeframe=1m] [--maxCandles=10]");
    console.error("\nAvailable sessions:");
    if (fs.existsSync(defaultCapturesDir)) {
      const sessions = fs.readdirSync(defaultCapturesDir).filter((d) => {
        const p = path.join(defaultCapturesDir, d);
        return fs.statSync(p).isDirectory();
      });
      sessions.forEach((s) => console.error(`  --session=${s}`));
    }
    process.exit(1);
  }

  // Find the session directory
  let sessionDir = null;
  const possiblePaths = [
    path.join(defaultCapturesDir, session),
    path.join(dataDir, session),
    path.join(dataDir, "captures", session),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, "raw"))) {
      sessionDir = p;
      break;
    }
  }

  if (!sessionDir) {
    console.error(`[snapshots] Session not found: ${session}`);
    console.error(`[snapshots] Searched: ${possiblePaths.join(", ")}`);
    process.exit(1);
  }

  await processSnapshots({
    session,
    symbol,
    timeframe,
    maxCandles,
    sessionDir,
  });
}

main().catch((e) => {
  console.error("[snapshots] Fatal error:", e);
  process.exit(1);
});

