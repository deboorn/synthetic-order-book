"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

class RotatingNdjsonWriter {
  constructor({ filePathForTsMs }) {
    this.filePathForTsMs = filePathForTsMs;
    this.current = null; // { finalPath, tmpPath, hourKey, stream }
    this.queue = Promise.resolve();
  }

  async _openFor(tsMs) {
    const { finalPath, tmpPath, hourKey } = this.filePathForTsMs(tsMs);

    if (this.current && this.current.hourKey === hourKey) {
      return;
    }

    // rotate
    if (this.current) {
      await this._closeAndFinalize();
    }

    await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
    const stream = fs.createWriteStream(tmpPath, { flags: "a" });
    this.current = { finalPath, tmpPath, hourKey, stream };
  }

  async _closeAndFinalize() {
    const c = this.current;
    if (!c) return;

    await new Promise((resolve) => c.stream.end(resolve));

    // finalize: tmp -> final (atomic)
    try {
      await fsp.rename(c.tmpPath, c.finalPath);
    } catch (e) {
      // If rename fails (e.g. final exists from a previous run),
      // append tmp to final then remove tmp (best-effort).
      try {
        await fsp.mkdir(path.dirname(c.finalPath), { recursive: true });
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(c.tmpPath);
          const ws = fs.createWriteStream(c.finalPath, { flags: "a" });
          rs.on("error", reject);
          ws.on("error", reject);
          ws.on("close", resolve);
          rs.pipe(ws);
        });
        await fsp.unlink(c.tmpPath);
      } catch (_) {
        // As a last resort, leave tmp behind. Processor can optionally read tmp files.
      }
    }

    this.current = null;
  }

  write(obj) {
    const tsMs = (obj && obj.ts_capture_ms) || Date.now();

    this.queue = this.queue
      .then(async () => {
        await this._openFor(tsMs);
        const line = JSON.stringify(obj) + "\n";
        const ok = this.current.stream.write(line);
        if (!ok) {
          await new Promise((resolve) => this.current.stream.once("drain", resolve));
        }
      })
      .catch(() => {
        // swallow to keep writer alive; caller handles logging
      });

    return this.queue;
  }

  async close() {
    await this.queue;
    await this._closeAndFinalize();
  }
}

module.exports = { RotatingNdjsonWriter };
