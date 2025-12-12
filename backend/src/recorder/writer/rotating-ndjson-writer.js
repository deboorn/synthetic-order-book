"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

class RotatingNdjsonWriter {
  constructor({ filePathForTsMs, maxBytes = 0 }) {
    this.filePathForTsMs = filePathForTsMs;
    this.maxBytes = Number(maxBytes) || 0;
    this.current = null; // { finalPath, tmpPath, key, part, stream, bytesWritten }
    this.queue = Promise.resolve();
  }

  async _openFor(tsMs, part) {
    const { finalPath, tmpPath, key } = this.filePathForTsMs(tsMs, part);

    if (this.current && this.current.key === key && this.current.part === part) {
      return;
    }

    // rotate
    if (this.current) {
      await this._closeAndFinalize();
    }

    await fsp.mkdir(path.dirname(tmpPath), { recursive: true });
    const stream = fs.createWriteStream(tmpPath, { flags: "a" });
    let bytesWritten = 0;
    try {
      const st = await fsp.stat(tmpPath);
      bytesWritten = st.size || 0;
    } catch (_) {}

    this.current = { finalPath, tmpPath, key, part, stream, bytesWritten };
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
        const line = JSON.stringify(obj) + "\n";
        const lineBytes = Buffer.byteLength(line, "utf8");

        // Rotate by time key and optional size cap.
        let part = this.current ? this.current.part : 0;
        const { key } = this.filePathForTsMs(tsMs, part);

        if (!this.current || this.current.key !== key) {
          part = 0;
        } else if (this.maxBytes > 0 && this.current.bytesWritten + lineBytes > this.maxBytes) {
          part = (this.current.part || 0) + 1;
        }

        await this._openFor(tsMs, part);

        const ok = this.current.stream.write(line);
        this.current.bytesWritten += lineBytes;
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
