"use strict";

const path = require("path");
const fs = require("fs");
const readline = require("readline");

const { parseArgs, csv, asBool } = require("../shared/cli");
const { SUPPORTED_TIMEFRAMES } = require("../shared/timeframes");

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

  const writers = new Map();
  function getWriter(timeframe) {
    if (writers.has(timeframe)) return writers.get(timeframe);
    const w = new RotatingCandleWriter({ outDir, symbol, timeframe });
    writers.set(timeframe, w);
    return w;
  }

  const aggregators = new Map();
  for (const tf of SUPPORTED_TIMEFRAMES) {
    const w = getWriter(tf);
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
      for (const agg of aggregators.values()) {
        agg.ingestBaseCandle({ timeSec, open, high, low, close, volume });
      }
    }
  }

  for (const agg of aggregators.values()) agg.flush();
  await Promise.allSettled(Array.from(writers.values()).map((w) => w.close()));

  console.log(`[processor] ${symbol}: read ${files.length} files, ${lines} lines, ${candles} base candles`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbols = csv(args.symbols).map((s) => s.toUpperCase());
  if (!symbols.length) {
    console.error("Missing --symbols (e.g. --symbols BTC,ETH)");
    process.exit(2);
  }

  const inDir = args.inDir ? path.resolve(args.inDir) : path.resolve(__dirname, "..", "..", "data", "raw");
  const outDir = args.outDir ? path.resolve(args.outDir) : path.resolve(__dirname, "..", "..", "data", "derived");
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
