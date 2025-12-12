"use strict";

const { BaseConnector } = require("./base");

class CoinbaseTickerConnector extends BaseConnector {
  constructor({ symbol, productId, onRecord, logger }) {
    super({ name: `coinbase_ticker_${symbol}`, url: "wss://ws-feed.exchange.coinbase.com", onRecord, logger });
    this.symbol = symbol;
    this.productId = productId;
  }

  async onOpen(ws) {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: [this.productId],
        channels: ["ticker"],
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

    if (msg.type === "ticker" && msg.price) {
      const payload = {
        price: parseFloat(msg.price),
        best_bid: msg.best_bid ? parseFloat(msg.best_bid) : null,
        best_ask: msg.best_ask ? parseFloat(msg.best_ask) : null,
        volume_24h: msg.volume_24h ? parseFloat(msg.volume_24h) : null,
        product_id: this.productId,
        time: msg.time || null,
      };

      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "coinbase",
        stream: "ticker",
        symbol: this.symbol,
        ts_event_ms: msg.time ? Date.parse(msg.time) : null,
        seq: this._nextSeq(),
        payload,
        raw: null,
      });
    } else if (msg.type === "error") {
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "coinbase",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: { event: "error", message: msg.message, reason: msg.reason || null },
        raw: msg,
      });
    }
  }
}

module.exports = { CoinbaseTickerConnector };
