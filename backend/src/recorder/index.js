"use strict";

const path = require("path");

const { parseArgs, csv } = require("../shared/cli");
const { writeJsonAtomic, readJsonIfExists } = require("../shared/state");

const { getExchangeSymbol } = require("../config/symbols");
const { RotatingNdjsonWriter } = require("./writer/rotating-ndjson-writer");
const { rawFilePathForTsMs } = require("./writer/raw-paths");

const { KrakenOHLCConnector } = require("./connectors/kraken-ohlc");
const { KrakenTickerConnector } = require("./connectors/kraken-ticker");
const { CoinbaseTickerConnector } = require("./connectors/coinbase-ticker");
const { BitstampTradesConnector } = require("./connectors/bitstamp-trades");

function makeStatePath(outDir, keyParts) {
  return path.join(outDir, "state", "recorder", ...keyParts) + ".json";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const symbols = csv(args.symbols).map((s) => s.toUpperCase());
  if (!symbols.length) {
    console.error("Missing --symbols (e.g. --symbols BTC,ETH)");
    process.exit(2);
  }

  const outDir = args.outDir ? path.resolve(args.outDir) : path.resolve(__dirname, "..", "..", "data");

  const streams = csv(args.streams);
  const enabled = new Set(streams.length ? streams : ["kraken_ohlc_1m"]);

  // One writer per (exchange, stream, symbol).
  const writers = new Map();
  function getWriter(exchange, stream, symbol) {
    const key = `${exchange}:${stream}:${symbol}`;
    if (writers.has(key)) return writers.get(key);

    const w = new RotatingNdjsonWriter({
      filePathForTsMs: (tsMs) => rawFilePathForTsMs({ outDir, exchange, stream, symbol }, tsMs),
    });
    writers.set(key, w);
    return w;
  }

  // Checkpoint seq per connector (best-effort)
  const connectorSeq = new Map();

  async function record(rec) {
    const exchange = rec.exchange;
    const stream = rec.stream;
    const symbol = rec.symbol || "";

    // route meta events to a shared meta log
    if (exchange === "meta" && stream === "meta") {
      const mw = getWriter("meta", "meta", "_");
      await mw.write(rec);
      return;
    }

    const w = getWriter(exchange, stream, symbol);
    await w.write(rec);

    // occasionally checkpoint (per connector name if present)
    if (rec && rec._connectorKey) {
      connectorSeq.set(rec._connectorKey, rec.seq);
      if (rec.seq % 200 === 0) {
        await writeJsonAtomic(makeStatePath(outDir, [rec._connectorKey]), { seq: rec.seq, ts: Date.now() });
      }
    }
  }

  function wrapRecord(connectorKey) {
    return async (base) => {
      // Keep connector-emitted routing keys (exchange/stream/symbol) so we don't
      // accidentally route lifecycle/meta messages into the wrong stream.
      const rec = { ...base, _connectorKey: connectorKey };
      await record(rec);
    };
  }

  const connectors = [];

  for (const symbol of symbols) {
    if (enabled.has("kraken_ohlc_1m")) {
      const pair = getExchangeSymbol("kraken", symbol);
      if (pair) {
        const connectorKey = `kraken_ohlc_${symbol}_1m`;
        const state = await readJsonIfExists(makeStatePath(outDir, [connectorKey]), { seq: 0 });
        const c = new KrakenOHLCConnector({
          symbol,
          pair,
          intervalMin: 1,
          logger: console,
          onRecord: wrapRecord(connectorKey),
        });
        if (state && state.seq) c.seq = state.seq;
        connectors.push(c);
      } else {
        console.warn(`[recorder] Kraken does not support symbol ${symbol}`);
      }
    }

    if (enabled.has("kraken_ticker")) {
      const pair = getExchangeSymbol("kraken", symbol);
      if (pair) {
        const connectorKey = `kraken_ticker_${symbol}`;
        const state = await readJsonIfExists(makeStatePath(outDir, [connectorKey]), { seq: 0 });
        const c = new KrakenTickerConnector({
          symbol,
          pair,
          logger: console,
          onRecord: wrapRecord(connectorKey),
        });
        if (state && state.seq) c.seq = state.seq;
        connectors.push(c);
      }
    }

    if (enabled.has("coinbase_ticker")) {
      const productId = getExchangeSymbol("coinbase", symbol);
      if (productId) {
        const connectorKey = `coinbase_ticker_${symbol}`;
        const state = await readJsonIfExists(makeStatePath(outDir, [connectorKey]), { seq: 0 });
        const c = new CoinbaseTickerConnector({
          symbol,
          productId,
          logger: console,
          onRecord: wrapRecord(connectorKey),
        });
        if (state && state.seq) c.seq = state.seq;
        connectors.push(c);
      }
    }

    if (enabled.has("bitstamp_trades")) {
      const pair = getExchangeSymbol("bitstamp", symbol);
      if (pair) {
        const connectorKey = `bitstamp_trades_${symbol}`;
        const state = await readJsonIfExists(makeStatePath(outDir, [connectorKey]), { seq: 0 });
        const c = new BitstampTradesConnector({
          symbol,
          pair,
          logger: console,
          onRecord: wrapRecord(connectorKey),
        });
        if (state && state.seq) c.seq = state.seq;
        connectors.push(c);
      }
    }
  }

  if (!connectors.length) {
    console.error("No connectors started (check --symbols and --streams)");
    process.exit(2);
  }

  console.log(`[recorder] outDir=${outDir}`);
  console.log(`[recorder] symbols=${symbols.join(",")}`);
  console.log(`[recorder] streams=${Array.from(enabled).join(",")}`);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    console.log("[recorder] shutting down...");

    await Promise.allSettled(connectors.map((c) => c.stop()));
    await Promise.allSettled(Array.from(writers.values()).map((w) => w.close()));

    // final checkpoint best-effort
    const writes = [];
    for (const [key, seq] of connectorSeq.entries()) {
      writes.push(writeJsonAtomic(makeStatePath(outDir, [key]), { seq, ts: Date.now() }));
    }
    await Promise.allSettled(writes);

    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start all connectors concurrently.
  await Promise.all(connectors.map((c) => c.start()));
}

main().catch((e) => {
  console.error("[recorder] fatal", e);
  process.exit(1);
});
