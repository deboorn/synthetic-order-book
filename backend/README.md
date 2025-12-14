# Synthetic Order Book — Backend

This folder contains the **Node.js backend** for:

- **Recording** exchange websocket data (order book, trades, OHLC)
- **Processing** recorded data into derived candle feeds and book snapshots
- **Serving** the replay UI for historical analysis

## Directory Structure

```
backend/
├── captures/           # Recorded session data
│   └── {session-id}/
│       ├── raw/        # Raw NDJSON logs
│       ├── derived/    # Processed candles & snapshots
│       └── state/      # Checkpoints
├── public/             # Replay UI (served by the server)
│   ├── replay.html
│   ├── js/
│   └── css/
├── src/
│   ├── recorder/       # WebSocket → NDJSON recorder
│   ├── processor/      # Raw → Derived candles
│   └── server/         # HTTP server for replay
└── package.json
```

## Requirements

- Node.js **18+** (use `nvm use 18` if needed)

## Install

```bash
cd backend
npm install
```

## Quick Start

### 1. Record a Session

```bash
npm run recorder -- \
  --symbols=BTC \
  --enabled=kraken_ohlc,kraken_book,coinbase_level2 \
  --session=my-session
```

This creates `captures/my-session/raw/...` with live data.

### 2. Process Candles

```bash
npm run processor -- \
  --session=my-session \
  --symbols=BTC
```

This creates derived candles at `captures/my-session/derived/candles/...`.

### 3. Generate Book Snapshots (for Replay)

```bash
npm run snapshots -- \
  --session=my-session \
  --symbol=BTC \
  --timeframe=1m
```

This creates `captures/my-session/derived/BTC/snapshots/1m.ndjson`.

### 4. Start Replay Server

```bash
npm run server
```

Open http://127.0.0.1:8787/ to access the replay UI.

## Commands

| Command | Description |
|---------|-------------|
| `npm run recorder` | Record live exchange data |
| `npm run processor` | Process raw OHLC → derived candles |
| `npm run snapshots` | Generate book snapshots for replay |
| `npm run server` | Start HTTP server for replay UI |

## Recorder Options

```bash
npm run recorder -- \
  --symbols=BTC,ETH \
  --enabled=kraken_ohlc,kraken_book,coinbase_level2,bitstamp_book \
  --session=my-session \
  --bookDepth=100 \
  --maxFileMb=256
```

| Option | Default | Description |
|--------|---------|-------------|
| `--symbols` | (required) | Comma-separated symbols |
| `--enabled` | `kraken_ohlc` | Streams to enable |
| `--session` | timestamp | Session folder name |
| `--bookDepth` | `100` | Order book depth levels |
| `--maxFileMb` | `0` | Max file size before rotation (0=disabled) |

### Order Book Sampling (1-minute intervals)

Book connectors sample at **1-minute intervals** (candle open), not every tick.
This is how TradingView and institutional platforms handle historical order book data.

**Storage comparison (per hour):**
| Mode | Book Records | Size |
|------|--------------|------|
| Every tick | ~110,000 | ~180 MB |
| **1-min sampling** | ~60 | **~100 KB** |

The connectors maintain internal book state and emit a single snapshot at each minute boundary.

Available streams:
- `kraken_ohlc` - 1m OHLC candles (required for processing)
- `kraken_book` - Order book snapshots
- `kraken_ticker` - Ticker updates
- `coinbase_level2` - L2 order book
- `coinbase_ticker` - Ticker updates
- `bitstamp_book` - Order book
- `bitstamp_trades` - Trade stream

## Server Options

```bash
npm run server -- --port=8787 --host=127.0.0.1
```

The server:
- Serves `public/replay.html` as the replay UI
- Provides `/api/replay/sessions` - list available sessions
- Provides `/api/replay/stream?kind=snapshots&session=X&symbol=BTC&timeframe=1m` - stream book snapshots

## Data Format

### Raw NDJSON

Each line is a JSON object:

```json
{
  "v": 1,
  "ts_capture_ms": 1702425600000,
  "exchange": "kraken",
  "stream": "book",
  "symbol": "BTC",
  "seq": 12345,
  "payload": { ... }
}
```

### Derived Candles

```json
{
  "time": 1702425600,
  "open": 43000.5,
  "high": 43100.0,
  "low": 42950.0,
  "close": 43050.0,
  "volume": 12.5
}
```

### Book Snapshots

```json
{
  "time": 1702425600,
  "candle": { "o": 43000, "h": 43100, "l": 42950, "c": 43050, "v": 12.5 },
  "book": {
    "bids": [[42999, 1.5], [42998, 2.0], ...],
    "asks": [[43001, 1.2], [43002, 0.8], ...]
  }
}
```

## Replay UI

The replay UI (`public/replay.html`) allows you to:

- Load recorded sessions
- View all metrics computed from historical order book data
- Adjust alpha sensitivity settings per metric (MM, Swing, HTF)
- Analyze predictive signals vs price action

Metrics include:
- Fair Value (VWMP, IFV, Mid)
- Order Flow (BPR, LD Delta, LD%)
- Alpha Scores (MM, Swing, HTF)
- Market Consensus (MCS, biases)
- Regime Engine (pressure, imbalance)
- Predictive Signals (Next Regime Probability)
