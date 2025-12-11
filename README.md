# Synthetic Order Book

A real-time, multi-exchange cryptocurrency order book visualization and analysis tool. Aggregates order book data from Kraken, Coinbase, and Bitstamp via WebSocket connections to provide institutional-grade market insights.

![Synthetic Order Book](https://img.shields.io/badge/License-Personal%20Use-blue) ![Version](https://img.shields.io/badge/Version-1.0.0-green)

## 📸 Screenshots

### Desktop View
![Synthetic Order Book - Desktop](./screenshot-desktop.jpg)

### Mobile View
<p align="center">
  <img src="./screenshot_mobile.png" alt="Synthetic Order Book - Mobile" width="350">
</p>

## 🔗 Quick Links

- **[Live Demo](https://deboorn.github.io/synthetic-order-book/)** - GitHub Pages deployment

---

## 📋 Table of Contents

1. [Features](#features)
2. [Understanding the Interface](#understanding-the-interface)
3. [Output Reference Guide](#output-reference-guide)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [License](#license)

---

## ✨ Features

- **Multi-Exchange Aggregation** - Real-time data from Kraken, Coinbase, Bitstamp
- **WebSocket-Only Architecture** - No backend required, runs entirely in browser
- **Market Depth Visualization** - Cumulative bid/ask volume chart
- **Order Book Imbalance Curve (OBIC)** - Proprietary imbalance analysis
- **Liquidity Delta Analysis** - Institutional flow detection
- **Multi-Timeframe Consensus** - MM, Swing, and HTF perspectives
- **Support/Resistance Levels** - Auto-detected from order book clusters
- **Historical Klines** - Via Binance Vision API (CORS-friendly)

---

## 🖥️ Understanding the Interface

### Layout Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BTC ORDERBOOK          BTC/USD   $92,165.90  [LIVE]        ⚙ Live [OHLC] ⟳ │
├───────────────┬─────────────────────────────────────┬───────────────────────┤
│ ▼ MARKET DEPTH│                                     │ ▼ MARKET CONSENSUS    │
│   [Live]      │      [4h ▼]  6h 53m    ⓘ ⚙        │                       │
│    ╱╲         │  ┌─────────────────────────────┐   │   ┌─────────────────┐ │
│   ╱  ╲        │  │ ▓▓▓▓▓░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓ │   │   │  WAIT/NEUTRAL   │ │
│  ╱    ╲       │  │ ▓▓▓▓▓▓░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓ │   │   └─────────────────┘ │
│ ╱      ╲      │  │ ▓▓▓▓▓▓▓░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │   │   MM   ████░░ (+40)   │
│ BID    ASK    │  │ ▓▓▓▓▓▓▓▓░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │   │   Swing ███░░░ (-20)  │
│ 2,461  1,355  │  │          Mid                │   │   HTF   ██░░░░ (-20)  │
│ IMBALANCE     │  │ ──────────────92,165──────  │   │                       │
│   +29.0%      │  └─────────────────────────────┘   │ ▼ MM (Microstructure) │
├───────────────┤  │ ▼ 78.66 BTC   94990.50     │   │   Order Flow: LD +24  │
│ ▼ ORDER FLOW  │  │ ▲ 40.60 BTC   92250.69     │   │   BPR: 1.01           │
│   [Live]      │  │ ▼ 95.52 BTC   92180.47     │   │                       │
│ BPR     1.01  │  │ ▲ 80.75 BTC   92043.49     │   │ ▼ Swing (Short-term)  │
│ ████████░░░░  │  │ ▼ 22.06 BTC   91888.71     │   │   Alpha: 50/100       │
│               │  │                             │   │   +14.72% vs IFV      │
│ LD    +26.7   │  └─────────────────────────────┘   │                       │
│ Liquidity ↑   │                                     │ ▼ HTF (Macro)         │
├───────────────┤                                     │   Regime: MEAN REV    │
│ LD_VEL  -87.1 │                                     │   VWMP: $115,385      │
│ LD_CLU +2.1M  │                                     │                       │
│ PROJ +22/+39/+16                                   │ ● WAIT / SCALP ONLY   │
├───────────────┤                                     ├───────────────────────┤
│ ▼ LD TRADING  │                                     │ ▼ Key Levels          │
│   GUIDE       │                                     │ [All] [Bid] [Ask]     │
│               │                                     │ ▼ 78.66  94990.50    │
│ ⚠ WHAT'S      │                                     │ ▲ 40.60  92250.69    │
│   HAPPENING   │                                     │ ▼ 95.52  92180.47    │
├───────────────┤                                     │ ▲ 80.75  92043.49    │
│ ▼ OBIC        │                                     │ ▼ 22.06  91888.71    │
│     ╱╲        │                                     │                       │
│ ___╱  ╲___    │                                     │                       │
│ SUP  MID RES  │                                     │                       │
├───────────────┴─────────────────────────────────────┴───────────────────────┤
│ Cache: 29KB  WS(3/3)  Last update: 12:10 PM · © 2025 Daniel Boorn · Personal│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Output Reference Guide

### 1. Price Header

```
┌─────────────────────────────────────────────────────────────────┐
│  BTC ORDERBOOK       BTC/USD  $92,165.90  [LIVE] ▲    ⚙ [OHLC] │
│  ─────────────       ───────  ──────────  ────── ─    ───────  │
│  App Title           Pair     Price       Status Dir  Controls │
└─────────────────────────────────────────────────────────────────┘
```

| Element | Description |
|---------|-------------|
| **BTC/USD** | Trading pair indicator |
| **$XX,XXX.XX** | Current aggregated price from exchanges |
| **LIVE** | Green badge = WebSocket connected |
| **▲/▼** | Price direction indicator (green up, red down) |

---

### 2. Market Depth Panel

#### Depth Chart - Valley Shape Visualization

```
         BIDS (Green)              ASKS (Red)
              │                        │
    2,500 ────┼────────────────────────┼────
              │█                      █│
    2,000 ────┼██                    ██│────
              │███                  ███│
    1,500 ────┼████                ████│────
              │█████              █████│
    1,000 ────┼██████            ██████│────
              │███████          ███████│
      500 ────┼████████        ████████│────
              │█████████      █████████│
        0 ────┼──────────╲  ╱──────────│────
              │           ╲╱           │
              └───────────┼────────────┘
                      MID PRICE
                      $92,165

    ◄── Price decreases    Price increases ──►
```

**How to Read:**
- Valley center = current market price
- Green area grows LEFT = cumulative buy orders below price
- Red area grows RIGHT = cumulative sell orders above price
- Steeper slope = more liquidity concentrated near price
- Wider base = liquidity spread across price range

#### Depth Statistics

```
┌─────────────────────────────────┐
│  BID VOLUME      ASK VOLUME     │
│   2,461.05        1,355.89      │
│     BTC             BTC         │
│                                 │
│       IMBALANCE: +29.0%         │
│       ████████████░░░░░         │
└─────────────────────────────────┘
```

| Metric | Description | Interpretation |
|--------|-------------|----------------|
| **BID VOLUME** | Total buy-side liquidity (BTC) | Higher = stronger support |
| **ASK VOLUME** | Total sell-side liquidity (BTC) | Higher = stronger resistance |
| **IMBALANCE** | (Bids - Asks) / Total × 100% | +% = bullish, -% = bearish |

**Imbalance Scale:**
```
-50%        -20%    -5%   0   +5%    +20%        +50%
  │           │      │    │    │      │           │
  ▼           ▼      ▼    │    ▼      ▼           ▼
STRONG    BEARISH  MILD   │  MILD  BULLISH    STRONG
BEARISH            BEAR   │  BULL             BULLISH
                       NEUTRAL
```

---

### 3. Order Flow Panel

#### BPR (Bid/Ask Pressure Ratio)

```
┌─────────────────────────────────┐
│  BPR                            │
│  Bid/Ask Ratio        1.01     │
│  ██████████████░░░░░░░░░░░░░   │
│  ◄── Sells    │    Buys ──►    │
│             BALANCED            │
└─────────────────────────────────┘

Formula: BPR = Total Bid Volume / Total Ask Volume

   0.5     0.7     0.9  1.0  1.1     1.5     2.0
    │       │       │    │    │       │       │
    ▼       ▼       ▼    │    ▼       ▼       ▼
  STRONG  MODERATE MILD  │  MILD  MODERATE STRONG
  SELLING SELLING  SELL  │  BUY   BUYING   BUYING
                      NEUTRAL
```

#### LD (Liquidity Delta)

```
┌─────────────────────────────────┐
│  LD                             │
│  Liquidity Delta    +26.7 BTC ↑│
│                                 │
│  Near-price bids vs asks        │
│  (within ±2% of current price)  │
└─────────────────────────────────┘

Formula: LD = Near Bids - Near Asks

    -100      -50       0       +50      +100
      │        │        │        │        │
   ───┼────────┼────────┼────────┼────────┼───
      │        │        │        │        │
    STRONG   MODERATE   │    MODERATE  STRONG
    SELLING  SELLING    │    BUYING    BUYING
                     NEUTRAL
                        ↑
                   +26.7 (mild bullish)
```

#### LD_VEL (Liquidity Delta Velocity)

```
┌─────────────────────────────────┐
│  LD_VEL             -87.1      │
│  ██████░░░░░░░░░░░░░░░░░░░░░░  │
│                                 │
│  Rate of LD change over time    │
│  (momentum acceleration)        │
└─────────────────────────────────┘

Interpretation:
  +100 ──► Rapid increase in buy pressure
     0 ──► Stable, no momentum change
  -100 ──► Rapid increase in sell pressure
```

#### LD_CLU (Liquidity Delta Cumulative)

```
┌─────────────────────────────────┐
│  LD_CLU          +2,175,836.7  │
│  ████████████████████████████░ │
│                                 │
│  Running total of LD changes    │
│  Shows institutional flow       │
└─────────────────────────────────┘

Trend Analysis:
  ╱ Rising  = Sustained accumulation (bullish)
  ╲ Falling = Sustained distribution (bearish)
  ─ Flat    = No clear institutional bias
```

#### PROJ (Projection Scores)

```
┌─────────────────────────────────┐
│  PROJ         +22   +39   +16  │
│               ───   ───   ───  │
│              Short  Med  Long  │
│              (±5%) (±15%)(±30%)│
│                                 │
│  [+22] [+39] [+16]             │
│   ██    ███   ██               │
└─────────────────────────────────┘

Score Scale:
  -100 ────── -50 ────── 0 ────── +50 ────── +100
    │          │         │          │          │
  STRONG    MODERATE  NEUTRAL   MODERATE   STRONG
  BEARISH   BEARISH             BULLISH    BULLISH
```

#### Absorption & Pressure Indicators

```
┌─────────────────────────────────┐
│  PRESS                          │
│  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄   │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀   │
│  -10%              0%       +10%│
│                                 │
│  ● Absorption (Maker Control)   │
│  ▲ Aggressive bid stacking      │
└─────────────────────────────────┘

Signals:
  ● Absorption      = Large orders absorbing aggression
  ▲ Bid stacking    = Buyers building walls (bullish)
  ▼ Ask stacking    = Sellers building walls (bearish)
  ⊟ Bid removal     = Support pulled (hidden bearish)
  ⊞ Ask removal     = Resistance pulled (hidden bullish)
```

---

### 4. LD Trading Guide

```
┌─────────────────────────────────┐
│ ▼ LD TRADING GUIDE              │
├─────────────────────────────────┤
│ 📰 WHAT'S HAPPENING             │
│                                 │
│ Order flow is balanced (LD:     │
│ +26.7 BTC). Velocity and        │
│ clusters conflict - unclear     │
│ who's really in control.        │
│                                 │
├─────────────────────────────────┤
│ 📋 WHAT TO DO                   │
│                                 │
│ ⬜ Chop zone - wait for clarity.│
│ Don't force trades in either    │
│ direction. Scalp only if you    │
│ must, with tight stops.         │
│                                 │
├─────────────────────────────────┤
│ 🎯 KEY FLOW ZONES               │
│                                 │
│ Range support:  $84,874.37      │
│ Range resistance: $99,635.14    │
│                                 │
├─────────────────────────────────┤
│ 🟡 NEWBIE TAKEAWAY              │
│                                 │
│ "Neither buyers nor sellers are │
│ winning. Best to wait - don't   │
│ trade when it's this unclear."  │
└─────────────────────────────────┘

Traffic Light System:
  🟢 Green  = Generally bullish, favor longs
  🟡 Yellow = Uncertain, scalp only or wait
  🔴 Red    = Generally bearish, favor shorts
```

---

### 5. OBIC (Order Book Imbalance Curve)

```
┌─────────────────────────────────┐
│ OBIC - Imbalance Curve          │
│                                 │
│        │    ╱╲                  │
│        │   ╱  ╲                 │
│        │  ╱    ╲                │
│   0 ───┼─╱──────╲───────────    │
│        │╱        ╲              │
│        ╱          ╲             │
│       ╱│           ╲            │
│      ╱ │            ╲           │
│     ╱  │             ╲          │
│ ───────┼───────────────────     │
│  SUPPORT    MID    RESISTANCE   │
│  (green)          (red)         │
└─────────────────────────────────┘

Formula: OBIC(price) = Σ Bids Below - Σ Asks Above

Reading the Curve:
  ╱ Above zero line = More cumulative bids = Bullish
  ╲ Below zero line = More cumulative asks = Bearish
  ╳ Zero crossing   = Equilibrium (fair value)

  Steep ╱ = Strong buying interest at that price
  Steep ╲ = Strong selling interest at that price
```

---

### 6. Main Chart

#### Candlestick + Levels Visualization

```
                              ▼ 78.66 BTC  94990.50
                         ═══════════════════════════ (resistance)
     95,000 ─────────────────────────────────────────
              │                          │
              │    ┌───┐                 │
     94,500 ──│────│   │─────────────────│───────────
              │    │   │    ┌───┐        │
              │    │ █ │    │   │        │
     94,000 ──│────│ █ │────│ █ │────────│───────────
              │    │ █ │    │ █ │  ┌───┐ │
              │    └─┬─┘    │ █ │  │   │ │
     93,500 ──│──────│──────│ █ │──│ █ │─│───────────
              │      │      └─┬─┘  │ █ │ │
                                   └─┬─┘
                         ═══════════════════════════ (support)
                              ▲ 40.60 BTC  92250.69

Legend:
  ┌───┐
  │ █ │ = Bullish candle (green) - Close > Open
  │   │
  └───┘

  ┌───┐
  │   │ = Bearish candle (red) - Close < Open
  │ █ │
  └───┘

  │    = Wick (high/low range)
  
  ═══  = Support/Resistance level
         Cyan = Support (bid cluster)
         Magenta = Resistance (ask cluster)
         Opacity = Volume strength
         Thickness = Significance
```

#### Level Labels

```
Right-side labels:
┌──────────────────────────┐
│ ▼ 78.66 BTC   94990.50   │  ← Red ▼ = Resistance (ask cluster)
│ ▲ 40.60 BTC   92250.69   │  ← Green ▲ = Support (bid cluster)
│ ▼ 95.52 BTC   92180.47   │
│ ▲ 80.75 BTC   92043.49   │
│        Mid    92165.90   │  ← Gray = Current price
│ ▼ 22.06 BTC   91888.71   │
└──────────────────────────┘
    ▲        ▲       ▲
    │        │       │
  Type    Volume   Price
```

---

### 7. Market Consensus Panel

```
┌─────────────────────────────────┐
│ ▼ MARKET CONSENSUS        Live  │
├─────────────────────────────────┤
│                                 │
│   ┌─────────────────────────┐   │
│   │                         │   │
│   │    WAIT / NEUTRAL       │   │
│   │       (4/100)   72%     │   │
│   │                 HIGH    │   │
│   └─────────────────────────┘   │
│                                 │
│   ●●● SPLIT                     │
│                                 │
│   MM    ████████░░░░ (+40)     │
│   Swing ███░░░░░░░░░ (-20)     │
│   HTF   ██░░░░░░░░░░ (-20)     │
│                                 │
└─────────────────────────────────┘

Timeframe Bars:
  ████████░░░░ = Mostly bullish (green filled)
  ░░░░░░░░████ = Mostly bearish (red filled)
  ████░░░░████ = Mixed signals

Primary Signal Badge:
  ┌──────────────┐
  │ WAIT/NEUTRAL │ = No clear edge
  │    LONG      │ = Bullish bias
  │    SHORT     │ = Bearish bias
  └──────────────┘

Confidence Indicator:
  > 70%  = HIGH (strong signal)
  40-70% = MEDIUM (moderate signal)
  < 40%  = LOW (weak signal)
```

---

### 8. MM (Microstructure) Analysis

```
┌─────────────────────────────────┐
│ ▼ MM (Microstructure)     Long  │
├─────────────────────────────────┤
│                                 │
│ Order Flow: LD +24.5 BTC        │
│            BPR 1.01 (45% bids)  │
│                                 │
│ Near Levels:                    │
│   Support  $84,878.37           │
│   Resist   $99,639.83           │
│                                 │
└─────────────────────────────────┘

Focus: Scalping, market microstructure
Timeframe: Minutes
```

---

### 9. Swing (Short-term) Analysis

```
┌─────────────────────────────────┐
│ ▼ Swing (Short-term)     Short  │
├─────────────────────────────────┤
│                                 │
│ Alpha: 50/100 (Neutral)         │
│ Price: +14.72% vs fair value    │
│                                 │
│ Triggers:                       │
│   Long above $94,104.28         │
│   Short below $90,413.92        │
│                                 │
└─────────────────────────────────┘

Focus: Day trading, swing positions
Timeframe: Hours
```

---

### 10. HTF (Macro) Analysis

```
┌─────────────────────────────────┐
│ ▼ HTF (Macro)            Short  │
├─────────────────────────────────┤
│                                 │
│ Regime: MEAN REVERSION          │
│                                 │
│ Fair Value:                     │
│   VWMP: $115,385.68 (-33.59%)   │
│   IFV:  $79,848.81 (+14.72%)    │
│                                 │
│ Range: $90k - $94k until        │
│        breakout                 │
│                                 │
└─────────────────────────────────┘

Regimes:
  TREND          = Directional move in progress
  RANGE          = Sideways consolidation
  MEAN REVERSION = Expected return to fair value

Focus: Position trading, macro view
Timeframe: Days
```

---

### 11. Key Levels Table

```
┌─────────────────────────────────┐
│ ▼ Key Levels                    │
│                                 │
│ [All] [Bid] [Ask]               │
│  ▲     ▲      ▲                 │
│ Show  Show   Show               │
│ all   bids   asks               │
│       only   only               │
├─────────────────────────────────┤
│ Type    Volume      Price       │
├─────────────────────────────────┤
│  ▼    78.66 BTC   94,990.50    │
│  ▲    40.60 BTC   92,250.69    │
│  ▼    95.52 BTC   92,180.47    │
│  ▲    80.75 BTC   92,043.49    │
│  ▼    22.06 BTC   91,888.71    │
│  ▲    17.32 BTC   87,994.35    │
└─────────────────────────────────┘

Legend:
  ▼ Red   = Resistance (ask cluster above price)
  ▲ Green = Support (bid cluster below price)
```

---

### 12. Footer Indicators

```
┌─────────────────────────────────────────────────────────────────┐
│ Cache: 29512.1 KB │ Last update: 12:10:39 PM │ Data refresh: 10s│
│ WS (3/3)          │ © 2025 Daniel Boorn      │ [Off|5s|10s|30s] │
└─────────────────────────────────────────────────────────────────┘
   ▲      ▲              ▲           ▲                ▲
   │      │              │           │                │
IndexedDB │         Timestamp    Copyright      Auto-refresh
 storage  │                                     interval
          │
   WebSocket connections
   (connected / total)
   3/3 = All exchanges connected
   2/3 = One exchange disconnected
   0/3 = All disconnected
```

---

## 🚀 Installation

### GitHub Pages (Recommended)

Access at `https://deboorn.github.io/synthetic-order-book/`

### Local Development

```bash
# Clone the repository
git clone https://github.com/yourusername/synthetic-order-book.git
cd synthetic-order-book

# Start a local server (Python)
python -m http.server 8888

# Or with PHP
php -S localhost:8888

# Open in browser
open http://localhost:8888
```

### Requirements

- Modern browser (Chrome, Firefox, Safari, Edge)
- JavaScript enabled
- WebSocket support
- No backend required - runs entirely client-side

---

## ⚙️ Configuration

### Settings Panel (⚙️ Icon)

```
┌─────────────────────────────────┐
│ Settings                      ✕ │
├─────────────────────────────────┤
│ Level Filtering                 │
│ ─────────────────               │
│ Update Throttle    [====●===]   │
│                    500ms        │
│                                 │
│ Price Clustering % [0.15    ]   │
│                                 │
│ Max Levels         [====●===]   │
│                    500          │
│                                 │
│ Min Volume (BTC)   [====●===]   │
│                    15           │
│                                 │
│ Price Range %      [========●]  │
│                    100%         │
├─────────────────────────────────┤
│ Level Appearance                │
│ ─────────────────               │
│ Signal Amplifier   [====●===]   │
│                    50%          │
│                                 │
│ Thickness          [========●]  │
│                    5 (max)      │
│                                 │
│ EMA Grid Spacing   [0.005   ]   │
├─────────────────────────────────┤
│        [Reset Defaults] [Apply] │
└─────────────────────────────────┘
```

#### Level Filtering
| Setting | Description | Default |
|---------|-------------|---------|
| Update Throttle | WebSocket update frequency (ms) | 500 |
| Price Clustering % | Group orders within X% | 0.15 |
| Max Levels | Maximum levels to display | 500 |
| Min Volume | Hide levels below X BTC | 15 |
| Price Range % | Show levels within ±X% | 100 |

#### Level Appearance
| Setting | Description | Default |
|---------|-------------|---------|
| Signal Amplifier | Amplify weak signals | 50% |
| Thickness Amplifier | Amplify weak thicknesses | 5 (max) |
| EMA Grid Spacing | Grid multiplier | 0.005 |

---

## 📜 License

**© 2025 Daniel Boorn <daniel.boorn@gmail.com>**

This software is free for **personal, non-commercial use only**.

- ✅ Personal learning and research
- ✅ Non-commercial educational use
- ❌ Commercial use without license
- ❌ Redistribution for profit

**For commercial licensing inquiries, contact:** [daniel.boorn@gmail.com](mailto:daniel.boorn@gmail.com)

---

## ⚠️ Disclaimer

**This tool is for educational purposes only.**

- Not financial advice
- Not investment recommendations
- Use at your own risk
- Cryptocurrency trading involves substantial risk of loss

Always conduct your own research and consult qualified financial advisors before making investment decisions.

---

## 🙏 Acknowledgments

Special thanks to:

- **[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)** - Performant financial charts built with HTML5 canvas. The charting library powering this application.
- **[GitHub](https://github.com)** - For hosting this project and providing GitHub Pages for the live demo.
- **[Binance Vision API](https://data.binance.vision/)** - Historical kline/candlestick data.
- **Exchange WebSocket APIs** - Real-time order book data from Kraken, Coinbase, and Bitstamp.
