"use strict";

const { BaseConnector } = require("./base");

class KrakenOHLCConnector extends BaseConnector {
  constructor({ symbol, pair, intervalMin, onRecord, logger }) {
    super({ name: `kraken_ohlc_${symbol}_${intervalMin}m`, url: "wss://ws.kraken.com", onRecord, logger });
    this.symbol = symbol;
    this.pair = pair;
    this.intervalMin = intervalMin;
  }

  async onOpen(ws) {
    ws.send(
      JSON.stringify({
        event: "subscribe",
        pair: [this.pair],
        subscription: { name: "ohlc", interval: this.intervalMin },
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

    // status
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

    // OHLC format: [channelID, [time, etime, open, high, low, close, vwap, volume, count], "ohlc-X", "pair"]
    if (Array.isArray(msg) && msg.length >= 4 && typeof msg[2] === "string" && msg[2].startsWith("ohlc")) {
      const arr = msg[1];
      if (!Array.isArray(arr) || arr.length < 8) return;

      const payload = {
        time_sec: parseInt(arr[0], 10),
        end_time_sec: parseInt(arr[1], 10),
        interval_min: this.intervalMin,
        open: parseFloat(arr[2]),
        high: parseFloat(arr[3]),
        low: parseFloat(arr[4]),
        close: parseFloat(arr[5]),
        vwap: arr[6] !== undefined ? parseFloat(arr[6]) : null,
        volume: arr[7] !== undefined ? parseFloat(arr[7]) : 0,
        count: arr[8] !== undefined ? parseInt(arr[8], 10) : null,
        pair: this.pair,
        channel: msg[2],
      };

      this.onRecord({
        v: 1,
        ts_capture_ms,
        exchange: "kraken",
        stream: "ohlc",
        symbol: this.symbol,
        ts_event_ms: payload.time_sec ? payload.time_sec * 1000 : null,
        seq: this._nextSeq(),
        payload,
        raw: null,
      });
    }
  }
}

module.exports = { KrakenOHLCConnector };
