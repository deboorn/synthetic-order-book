"use strict";

const path = require("path");
const fs = require("fs");
const readline = require("readline");

const { parseArgs, csv, asBool } = require("../shared/cli");
const { SUPPORTED_TIMEFRAMES } = require("../shared/timeframes");
const { readJsonIfExists, writeJsonAtomic } = require("../shared/state");

const { listFilesRecursive } = require("./readers/file-list");
const { CandleAggregator } = require("./aggregators/candle-aggregator");
const { RotatingCandleWriter } = require("./writers/rotating-candle-writer");

function isNdjsonFile(p, includeTmp) {
  if (p.endsWith(".ndjson")) return true;
  if (includeTmp && p.endsWith(".ndjson.tmp")) return true;
  return false;
}

async function processSymbol({ symbol, inDir, outDir, includeTmp }) {
  const rawDir = path.join(inDir, "kraken", "ohlc", symbol);
  const files = (await listFilesRecursive(rawDir)).filter((p) => isNdjsonFile(p, includeTmp));

  if (!files.length) {
    console.warn(`[processor] no raw files for ${symbol} under ${rawDir}`);
    return;
  }

  const stateDir = path.resolve(outDir, "..", "state", "processor", "candles", symbol);

  const writers = new Map();
  async function getWriter(timeframe) {
    if (writers.has(timeframe)) return writers.get(timeframe);

    const statePath = path.join(stateDir, `${timeframe}.json`);
    const state = await readJsonIfExists(statePath, { lastWrittenTime: 0 });
    const w = new RotatingCandleWriter({ outDir, symbol, timeframe });

    const wrapped = {
      timeframe,
      writer: w,
      statePath,
      lastWrittenTime: Number(state.lastWrittenTime) || 0,
      written: 0,
      async writeCandle(c) {
        // Output-side dedupe/idempotency: only append strictly increasing bars.
        if (!c || !c.time) return;
        if (c.time <= this.lastWrittenTime) return;
        await this.writer.writeCandle(c);
        this.lastWrittenTime = c.time;
        this.written += 1;

        // Periodic checkpoint so restarts don't re-append.
        if (this.written % 200 === 0) {
          await writeJsonAtomic(this.statePath, { lastWrittenTime: this.lastWrittenTime, ts: Date.now() });
        }
      },
      async close() {
        await this.writer.close();
        await writeJsonAtomic(this.statePath, { lastWrittenTime: this.lastWrittenTime, ts: Date.now() });
      },
    };

    writers.set(timeframe, wrapped);
    return wrapped;
  }

  const aggregators = new Map();
  for (const tf of SUPPORTED_TIMEFRAMES) {
    const w = await getWriter(tf);
    aggregators.set(
      tf,
      new CandleAggregator({
        symbol,
        timeframe: tf,
        onCandle: (c) => {
          // fire-and-forget: serialize per writer internally
          w.writeCandle(c);
        },
      })
    );
  }

  let lines = 0;
  let candles = 0;
  let baseFinalized = 0;
  let baseUpdatesCollapsed = 0;

  // Dedup strategy for Kraken OHLC 1m:
  // Kraken may emit multiple updates for the same 1m candle. We coalesce them
  // into a single finalized 1m candle when the timestamp advances.
  let currentBase = null; // { timeSec, open, high, low, close, volume }

  function finalizeBaseIfAny() {
    if (!currentBase) return;
    baseFinalized += 1;
    for (const agg of aggregators.values()) {
      agg.ingestBaseCandle({
        timeSec: currentBase.timeSec,
        open: currentBase.open,
        high: currentBase.high,
        low: currentBase.low,
        close: currentBase.close,
        volume: currentBase.volume,
      });
    }
  }

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lines += 1;
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (_) {
        continue;
      }

      if (!rec || rec.exchange !== "kraken" || rec.stream !== "ohlc" || rec.symbol !== symbol) continue;
      if (!rec.payload || rec.payload.interval_min !== 1) continue;

      const p = rec.payload;
      const timeSec = Number(p.time_sec);
      const open = Number(p.open);
      const high = Number(p.high);
      const low = Number(p.low);
      const close = Number(p.close);
      const volume = p.volume !== undefined ? Number(p.volume) : 0;

      if (!timeSec || !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)) continue;

      candles += 1;

      if (!currentBase) {
        currentBase = { timeSec, open, high, low, close, volume };
        continue;
      }

      if (timeSec === currentBase.timeSec) {
        // Coalesce updates for the same 1m candle.
        currentBase.high = Math.max(currentBase.high, high);
        currentBase.low = Math.min(currentBase.low, low);
        currentBase.close = close;
        // Kraken OHLC volume is cumulative within the candle; keep the latest value.
        currentBase.volume = volume;
        baseUpdatesCollapsed += 1;
        continue;
      }

      if (timeSec > currentBase.timeSec) {
        // Finalize the previous candle and start a new one.
        finalizeBaseIfAny();
        currentBase = { timeSec, open, high, low, close, volume };
        continue;
      }

      // Out-of-order (older candle) – ignore to keep outputs append-only/deterministic.
    }
  }

  // Final flush: push the last coalesced 1m candle, then flush aggregators.
  finalizeBaseIfAny();
  currentBase = null;

  for (const agg of aggregators.values()) agg.flush();
  await Promise.allSettled(Array.from(writers.values()).map((w) => w.close()));

  console.log(
    `[processor] ${symbol}: read ${files.length} files, ${lines} lines, ${candles} raw ohlc lines, finalized ${baseFinalized} base candles, collapsed ${baseUpdatesCollapsed} intra-candle updates`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbols = csv(args.symbols).map((s) => s.toUpperCase());
  if (!symbols.length) {
    console.error("Missing --symbols (e.g. --symbols BTC,ETH)");
    process.exit(2);
  }

  const inDir = args.inDir ? path.resolve(args.inDir) : path.resolve(__dirname, "..", "..", "captures", "raw");
  const outDir = args.outDir ? path.resolve(args.outDir) : path.resolve(__dirname, "..", "..", "captures", "derived");
  const includeTmp = asBool(args.includeTmp, false);

  console.log(`[processor] inDir=${inDir}`);
  console.log(`[processor] outDir=${outDir}`);
  console.log(`[processor] symbols=${symbols.join(",")}`);
  console.log(`[processor] includeTmp=${includeTmp}`);

  for (const symbol of symbols) {
    await processSymbol({ symbol, inDir, outDir, includeTmp });
  }
}

main().catch((e) => {
  console.error("[processor] fatal", e);
  process.exit(1);
});
