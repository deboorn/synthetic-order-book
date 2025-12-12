"use strict";

const { BaseConnector } = require("./base");

class BitstampTradesConnector extends BaseConnector {
  constructor({ symbol, pair, onRecord, logger }) {
    super({ name: `bitstamp_trades_${symbol}`, url: "wss://ws.bitstamp.net", onRecord, logger });
    this.symbol = symbol;
    this.pair = pair;
  }

  async onOpen(ws) {
    ws.send(
      JSON.stringify({
        event: "bts:subscribe",
        data: { channel: `live_trades_${this.pair}` },
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

    if (msg.event === "trade" && msg.data && msg.data.price) {
      const payload = {
        trade_id: msg.data.id ?? null,
        price: parseFloat(msg.data.price),
        size: msg.data.amount !== undefined ? parseFloat(msg.data.amount) : msg.data.size !== undefined ? parseFloat(msg.data.size) : null,
        side: msg.data.type === 0 ? "buy" : msg.data.type === 1 ? "sell" : null,
        ts_trade_ms: msg.data.timestamp ? parseInt(msg.data.timestamp, 10) * 1000 : null,
        pair: this.pair,
      };

      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "bitstamp",
        stream: "trade",
        symbol: this.symbol,
        ts_event_ms: payload.ts_trade_ms,
        seq: this._nextSeq(),
        payload,
        raw: null,
      });
    } else if (msg.event && msg.event.startsWith("bts:")) {
      // subscription lifecycle messages
      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "bitstamp",
        stream: "meta",
        symbol: this.symbol,
        ts_event_ms: null,
        seq: this._nextSeq(),
        payload: msg,
        raw: null,
      });
    }
  }
}

module.exports = { BitstampTradesConnector };
