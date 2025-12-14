/**
 * metrics.js - Pre-compute all metrics from raw book data
 * 
 * Usage:
 *   node src/processor/metrics.js --session=20251213-031154_BTC_2h --symbol=BTC --timeframe=1m
 *   node src/processor/metrics.js --session=20251213-031154_BTC_2h --symbol=BTC --timeframe=1m --maxCandles=10
 * 
 * Output:
 *   captures/{session}/derived/{symbol}/metrics/{timeframe}.ndjson
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

  // Sort files by name (chronological)
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

  getSnapshot() {
    if (this.bids.size === 0 || this.asks.size === 0) return null;

    const bidPrices = Array.from(this.bids.keys()).sort((a, b) => b - a);
    const askPrices = Array.from(this.asks.keys()).sort((a, b) => a - b);

    const bestBid = bidPrices[0];
    const bestAsk = askPrices[0];
    const mid = (bestBid + bestAsk) / 2;

    let bidVolume = 0, askVolume = 0;
    for (const v of this.bids.values()) bidVolume += v;
    for (const v of this.asks.values()) askVolume += v;

    return {
      bids: bidPrices.map((p) => ({ price: p, size: this.bids.get(p) })),
      asks: askPrices.map((p) => ({ price: p, size: this.asks.get(p) })),
      bestBid,
      bestAsk,
      mid,
      bidVolume,
      askVolume,
      spread: bestAsk - bestBid,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Metrics Calculator
// ─────────────────────────────────────────────────────────────
function computeMetrics(book, candle, settings = {}) {
  const { clusterPct = 0.0015, priceRangePct = 10 } = settings;
  const price = candle.close;

  // Filter levels within price range
  const minPrice = price * (1 - priceRangePct / 100);
  const maxPrice = price * (1 + priceRangePct / 100);

  const filteredBids = book.bids.filter((l) => l.price >= minPrice && l.price < price);
  const filteredAsks = book.asks.filter((l) => l.price <= maxPrice && l.price > price);

  // Cluster levels
  const clusterSize = price * clusterPct;
  const levels = [];

  function clusterLevels(arr, side) {
    const clustered = new Map();
    for (const lvl of arr) {
      const bucket = Math.round(lvl.price / clusterSize) * clusterSize;
      if (!clustered.has(bucket)) {
        clustered.set(bucket, { price: bucket, volume: 0, count: 0 });
      }
      const c = clustered.get(bucket);
      c.volume += lvl.size;
      c.count += 1;
    }
    return Array.from(clustered.values()).map((c) => ({ ...c, side }));
  }

  levels.push(...clusterLevels(filteredBids, "bid"));
  levels.push(...clusterLevels(filteredAsks, "ask"));

  // Calculate BPR (Bid/Ask Pressure Ratio)
  let bidTotal = 0, askTotal = 0;
  for (const lvl of levels) {
    if (lvl.side === "bid") bidTotal += lvl.volume;
    else askTotal += lvl.volume;
  }
  const bpr = askTotal > 0 ? bidTotal / askTotal : (bidTotal > 0 ? 10 : 1);

  // Calculate LD (Liquidity Delta)
  const ldDelta = bidTotal - askTotal;
  const ldTotal = bidTotal + askTotal;
  const ldPct = ldTotal > 0 ? (ldDelta / ldTotal) * 100 : 0;

  // Near vs Far delta (within 1% vs beyond)
  const nearThreshold = price * 0.01;
  let nearBid = 0, nearAsk = 0, farBid = 0, farAsk = 0;
  for (const lvl of levels) {
    const dist = Math.abs(lvl.price - price);
    if (lvl.side === "bid") {
      if (dist <= nearThreshold) nearBid += lvl.volume;
      else farBid += lvl.volume;
    } else {
      if (dist <= nearThreshold) nearAsk += lvl.volume;
      else farAsk += lvl.volume;
    }
  }
  const ldNearDelta = nearBid - nearAsk;
  const ldFarDelta = farBid - farAsk;

  // Calculate VWMP (Volume-Weighted Mid Price)
  let vwmpNum = 0, vwmpDen = 0;
  for (const lvl of [...filteredBids, ...filteredAsks]) {
    vwmpNum += lvl.price * lvl.size;
    vwmpDen += lvl.size;
  }
  const vwmp = vwmpDen > 0 ? vwmpNum / vwmpDen : book.mid;

  // Calculate IFV (Imbalance Fair Value)
  let bidWeighted = 0, askWeighted = 0, bidVolSum = 0, askVolSum = 0;
  for (const lvl of filteredBids) {
    bidWeighted += lvl.price * lvl.size;
    bidVolSum += lvl.size;
  }
  for (const lvl of filteredAsks) {
    askWeighted += lvl.price * lvl.size;
    askVolSum += lvl.size;
  }
  const bidAvg = bidVolSum > 0 ? bidWeighted / bidVolSum : price;
  const askAvg = askVolSum > 0 ? askWeighted / askVolSum : price;
  const totalVol = bidVolSum + askVolSum;
  const ifv = totalVol > 0 ? (bidAvg * bidVolSum + askAvg * askVolSum) / totalVol : book.mid;

  // Depth metrics
  const depthBid = book.bidVolume;
  const depthAsk = book.askVolume;
  const depthTotal = depthBid + depthAsk;
  const depthImbalancePct = depthTotal > 0 ? ((depthBid - depthAsk) / depthTotal) * 100 : 0;

  // Alpha score (based on liquidity imbalance)
  const alphaSensitivity = (settings.alphaSensitivity || 50) / 100;
  const rawAlpha = 50 + (ldPct * alphaSensitivity * 2);
  const alpha = Math.max(0, Math.min(100, rawAlpha));

  // Price vs fair value deviations
  const vsMidPct = book.mid ? ((price - book.mid) / book.mid) * 100 : 0;
  const vsVwmpPct = vwmp ? ((price - vwmp) / vwmp) * 100 : 0;
  const vsIfvPct = ifv ? ((price - ifv) / ifv) * 100 : 0;

  // MCS biases (Market Consensus Score)
  const mmBias = -vsVwmpPct * 10; // MM fades moves
  const swingBias = ldPct * 0.5; // Swing follows liquidity
  const htfBias = -vsIfvPct * 5; // HTF mean reverts to fair value
  const mcs = (mmBias + swingBias + htfBias) / 3;

  return {
    // Price levels
    mid: book.mid,
    vwmp,
    ifv,
    spread: book.spread,

    // Order flow
    bpr: Math.round(bpr * 1000) / 1000,
    ldDelta: Math.round(ldDelta * 100) / 100,
    ldPct: Math.round(ldPct * 100) / 100,
    ldNearDelta: Math.round(ldNearDelta * 100) / 100,
    ldFarDelta: Math.round(ldFarDelta * 100) / 100,

    // Depth
    depthBid: Math.round(depthBid * 100) / 100,
    depthAsk: Math.round(depthAsk * 100) / 100,
    depthImbalancePct: Math.round(depthImbalancePct * 100) / 100,

    // Alpha & consensus
    alpha: Math.round(alpha * 10) / 10,
    mcs: Math.round(mcs * 100) / 100,
    mmBias: Math.round(mmBias * 100) / 100,
    swingBias: Math.round(swingBias * 100) / 100,
    htfBias: Math.round(htfBias * 100) / 100,

    // Fair value deviations
    vsMidPct: Math.round(vsMidPct * 1000) / 1000,
    vsVwmpPct: Math.round(vsVwmpPct * 1000) / 1000,
    vsIfvPct: Math.round(vsIfvPct * 1000) / 1000,

    // Meta
    bidLevels: filteredBids.length,
    askLevels: filteredAsks.length,
    clusteredLevels: levels.length,
  };
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
async function processMetrics(options) {
  const { session, symbol, timeframe, maxCandles, sessionDir } = options;
  const tfSeconds = TF_SECONDS[timeframe];

  if (!tfSeconds) {
    console.error(`[metrics] Invalid timeframe: ${timeframe}`);
    process.exit(1);
  }

  console.log(`[metrics] Processing ${session} / ${symbol} / ${timeframe}`);
  console.log(`[metrics] Session dir: ${sessionDir}`);

  // Load candles
  console.log(`[metrics] Loading candles...`);
  let candles = await loadCandles(sessionDir, symbol, tfSeconds);
  console.log(`[metrics] Loaded ${candles.length} candles`);

  if (candles.length === 0) {
    console.error(`[metrics] No candles found`);
    process.exit(1);
  }

  // Apply max candles limit (take last N)
  if (maxCandles && maxCandles > 0 && candles.length > maxCandles) {
    candles = candles.slice(-maxCandles);
    console.log(`[metrics] Limited to last ${maxCandles} candles`);
  }

  // Calculate time bounds
  const firstCandleMs = candles[0].time * 1000;
  const lastCandleMs = (candles[candles.length - 1].time + tfSeconds) * 1000;
  console.log(`[metrics] Time range: ${new Date(firstCandleMs).toISOString()} - ${new Date(lastCandleMs).toISOString()}`);

  // Prepare output
  const outputDir = path.join(sessionDir, "derived", symbol, "metrics");
  await fsp.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${timeframe}.ndjson`);
  const outputStream = fs.createWriteStream(outputPath);

  // Load and index book records
  console.log(`[metrics] Loading book records...`);
  const bookDirs = [
    path.join(sessionDir, "raw", "kraken", "book", symbol),
    path.join(sessionDir, "raw", "coinbase", "book", symbol),
    path.join(sessionDir, "raw", "bitstamp", "book", symbol),
  ];

  const bookRecords = [];
  for (const dir of bookDirs) {
    for await (const rec of readNdjsonFiles(dir)) {
      const ts = Number(rec.ts_capture_ms || rec.ts_event_ms || 0);
      // Only load records within our time window (with 1 min buffer)
      if (ts >= firstCandleMs - 60000 && ts <= lastCandleMs + 60000) {
        bookRecords.push(rec);
      }
    }
  }

  // Sort by timestamp
  bookRecords.sort((a, b) => {
    const tsA = Number(a.ts_capture_ms || a.ts_event_ms || 0);
    const tsB = Number(b.ts_capture_ms || b.ts_event_ms || 0);
    return tsA - tsB;
  });

  console.log(`[metrics] Loaded ${bookRecords.length} book records for ${candles.length} candles`);

  // Process each candle
  const orderBook = new OrderBook();
  let bookIdx = 0;
  let processed = 0;

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

    // Get book snapshot and compute metrics
    const book = orderBook.getSnapshot();
    let metrics = null;

    if (book) {
      metrics = computeMetrics(book, candle, {
        clusterPct: 0.0015,
        priceRangePct: 10,
        alphaSensitivity: 50,
      });
    }

    // Write output record
    const record = {
      time: candle.time,
      candle: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
      metrics,
    };

    outputStream.write(JSON.stringify(record) + "\n");
    processed++;

    if (processed % 10 === 0 || processed === candles.length) {
      process.stdout.write(`\r[metrics] Processed ${processed}/${candles.length} candles`);
    }
  }

  outputStream.end();
  console.log(`\n[metrics] Output written to: ${outputPath}`);
  console.log(`[metrics] Done.`);
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

  // Captures are stored at order-book/captures, not backend/captures
  const orderBookRoot = path.resolve(__dirname, "..", "..", "..");
  const defaultCapturesDir = path.join(orderBookRoot, "captures");

  if (!session) {
    console.error("Usage: node src/processor/metrics.js --session=<session> [--symbol=BTC] [--timeframe=1m] [--maxCandles=10]");
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
    console.error(`[metrics] Session not found: ${session}`);
    console.error(`[metrics] Searched: ${possiblePaths.join(", ")}`);
    process.exit(1);
  }

  await processMetrics({
    session,
    symbol,
    timeframe,
    maxCandles,
    sessionDir,
  });
}

main().catch((e) => {
  console.error("[metrics] Fatal error:", e);
  process.exit(1);
});

