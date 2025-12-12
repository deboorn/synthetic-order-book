"use strict";

const WebSocket = require("ws");

class BaseConnector {
  constructor({ name, url, onRecord, logger }) {
    this.name = name;
    this.url = url;
    this.onRecord = onRecord;
    this.logger = logger || console;

    this.ws = null;
    this.shouldRun = false;
    this.seq = 0;
    this.reconnectAttempt = 0;
  }

  _nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  async start() {
    this.shouldRun = true;
    await this._connectLoop();
  }

  async stop() {
    this.shouldRun = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
    }
  }

  async _connectLoop() {
    while (this.shouldRun) {
      try {
        await this._connectOnce();
      } catch (e) {
        this.logger.warn(`[${this.name}] connect loop error`, e && e.message ? e.message : e);
      }

      if (!this.shouldRun) break;

      this.reconnectAttempt += 1;
      const delayMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempt, 5)));
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  async _connectOnce() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      let opened = false;

      ws.on("open", async () => {
        opened = true;
        this.reconnectAttempt = 0;
        this.onRecord({
          v: 1,
          ts_capture_ms: Date.now(),
          exchange: "meta",
          stream: "meta",
          symbol: "",
          ts_event_ms: null,
          seq: this._nextSeq(),
          payload: { event: "connect", connector: this.name, url: this.url },
          raw: null,
        });

        try {
          await this.onOpen(ws);
          resolve(); // resolve start() once first open succeeds
        } catch (e) {
          reject(e);
        }
      });

      ws.on("message", (buf) => {
        this.onMessage(buf);
      });

      ws.on("close", () => {
        this.onRecord({
          v: 1,
          ts_capture_ms: Date.now(),
          exchange: "meta",
          stream: "meta",
          symbol: "",
          ts_event_ms: null,
          seq: this._nextSeq(),
          payload: { event: "disconnect", connector: this.name },
          raw: null,
        });

        // If we never opened, fail this attempt.
        if (!opened) {
          reject(new Error("WebSocket closed before open"));
        }
      });

      ws.on("error", (err) => {
        this.onRecord({
          v: 1,
          ts_capture_ms: Date.now(),
          exchange: "meta",
          stream: "meta",
          symbol: "",
          ts_event_ms: null,
          seq: this._nextSeq(),
          payload: { event: "error", connector: this.name, message: String(err && err.message ? err.message : err) },
          raw: null,
        });

        if (!opened) reject(err);
      });
    });

    // Keep connection alive until it closes.
    await new Promise((resolve) => {
      const ws = this.ws;
      if (!ws) return resolve();
      ws.once("close", resolve);
    });
  }

  // override
  async onOpen(_ws) {}
  // override
  onMessage(_buf) {}
}

module.exports = { BaseConnector };
