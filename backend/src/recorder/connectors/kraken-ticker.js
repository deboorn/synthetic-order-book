"use strict";

const { BaseConnector } = require("./base");

class KrakenTickerConnector extends BaseConnector {
  constructor({ symbol, pair, onRecord, logger }) {
    super({ name: `kraken_ticker_${symbol}`, url: "wss://ws.kraken.com", onRecord, logger });
    this.symbol = symbol;
    this.pair = pair;
  }

  async onOpen(ws) {
    ws.send(
      JSON.stringify({
        event: "subscribe",
        pair: [this.pair],
        subscription: { name: "ticker" },
      })
    );
  }

  onMessage(buf) {
    const ts_capture_ms = Date.now();
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch (_) {
      return;
    }

    if (msg && msg.event) {
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "kraken",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: msg,
        raw: null,
      });
      return;
    }

    // Kraken ticker: [channelID, data, "ticker", "pair"]
    if (Array.isArray(msg) && msg[2] === "ticker") {
      const d = msg[1] || {};
      const payload = {
        price: d.c && d.c[0] ? parseFloat(d.c[0]) : null,
        best_bid: d.b && d.b[0] ? parseFloat(d.b[0]) : null,
        best_ask: d.a && d.a[0] ? parseFloat(d.a[0]) : null,
        volume_24h: d.v && d.v[1] ? parseFloat(d.v[1]) : null,
        pair: this.pair,
      };

      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "kraken",
        stream: "ticker",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload,
        raw: null,
      });
    }
  }
}

module.exports = { KrakenTickerConnector };
