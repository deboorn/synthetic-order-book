## Synthetic Order Book — Backend

This folder contains a **Node.js backend** for:

- **Recording** exchange websocket data to disk (for replay / research)
- **Processing** recorded files into **derived candle feeds** for every UI timeframe

### Requirements

- Node.js **18+**

### Install

From repo root:

```bash
cd backend
npm install
```

### Recorder (websockets → raw NDJSON logs)

The recorder writes newline-delimited JSON (NDJSON) into:

- `backend/data/raw/{exchange}/{stream}/{symbol}/YYYY/MM/DD/HH.ndjson`

Run:

```bash
cd backend
npm run recorder -- \
  --symbols BTC,ETH \
  --streams kraken_ohlc_1m,kraken_ticker,coinbase_ticker,bitstamp_trades \
  --outDir ./data
```

Notes:
- **Candles**: the processor expects Kraken **1m OHLC** logs (`kraken_ohlc_1m`).
- Files are written as `*.ndjson.tmp` during the active hour and atomically renamed to `*.ndjson` on rotation.

### Processor (raw logs → derived candle feeds)

The processor reads recorded Kraken 1m OHLC logs and produces derived candle feeds for the UI-supported timeframes:

`1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 3d, 1w`

Alignment matches the frontend (`js/chart.js#getBarTime`):
- Most timeframes align to epoch boundaries.
- **Weekly (`1w`) aligns to Monday 00:00 UTC** (Jan 5, 1970 anchor).

Run:

```bash
cd backend
npm run processor -- \
  --symbols BTC,ETH \
  --inDir ./data/raw \
  --outDir ./data/derived \
  --includeTmp true
```

Outputs:
- `backend/data/derived/candles/{symbol}/{timeframe}/YYYY/MM/DD.ndjson`

### CLI options (both commands)

- `--symbols` (required): comma-separated symbols (e.g. `BTC,ETH`)
- `--outDir` (optional): base data directory (default `./data`)

Recorder-specific:
- `--streams` (optional): comma-separated stream list

Processor-specific:
- `--inDir` (optional): raw input dir (default `./data/raw`)
- `--includeTmp` (optional): read `*.ndjson.tmp` too (default `false`)

### Data format (raw)

Each NDJSON line is a JSON object with a stable envelope:

- `v`: schema version (1)
- `ts_capture_ms`: local capture timestamp
- `exchange`: `kraken|coinbase|bitstamp`
- `stream`: `ohlc|ticker|trade|meta`
- `symbol`: normalized symbol (e.g. `BTC`)
- `ts_event_ms`: exchange timestamp if available, else null
- `seq`: per-session monotonic sequence
- `payload`: normalized payload
- `raw`: optional raw message

### Safety

- The recorder is append-only and resilient to reconnects.
- State checkpoints are written under `backend/data/state/`.

