"use strict";

const http = require("http");
const url = require("url");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const readline = require("readline");
const crypto = require("crypto");

const { parseArgs, csv, asBool } = require("../shared/cli");
const { listFilesRecursive } = require("../processor/readers/file-list");

let DATA_DIR = null;

// ─────────────────────────────────────────────────────────────
// WebSocket Server Implementation (RFC 6455)
// ─────────────────────────────────────────────────────────────
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class WebSocketServer {
  constructor(httpServer) {
    this.clients = new Map(); // clientId -> { socket, subscriptions: Set }
    this.watchers = new Map(); // watchKey -> FSWatcher
    this.filePositions = new Map(); // filePath -> lastReadPosition
    this.clientIdCounter = 0;
    
    httpServer.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  handleUpgrade(req, socket, head) {
    const parsed = url.parse(req.url);
    if (parsed.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(key + WS_MAGIC)
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n"
    );

    const clientId = ++this.clientIdCounter;
    const client = {
      id: clientId,
      socket,
      subscriptions: new Set(),
      buffer: Buffer.alloc(0),
    };
    this.clients.set(clientId, client);

    console.log(`[ws] Client ${clientId} connected`);

    socket.on("data", (data) => this.onData(client, data));
    socket.on("close", () => this.onClose(client));
    socket.on("error", (err) => {
      console.error(`[ws] Client ${clientId} error:`, err.message);
      this.onClose(client);
    });

    // Send welcome message
    this.send(client, { type: "connected", clientId });
  }

  onData(client, data) {
    client.buffer = Buffer.concat([client.buffer, data]);

    while (client.buffer.length >= 2) {
      const firstByte = client.buffer[0];
      const secondByte = client.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (client.buffer.length < 4) return;
        payloadLength = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (client.buffer.length < 10) return;
        payloadLength = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskOffset = offset;
      if (isMasked) offset += 4;

      const totalLength = offset + payloadLength;
      if (client.buffer.length < totalLength) return;

      let payload = client.buffer.slice(offset, totalLength);

      if (isMasked) {
        const mask = client.buffer.slice(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      client.buffer = client.buffer.slice(totalLength);

      // Handle opcodes
      if (opcode === 0x08) {
        // Close
        this.onClose(client);
        return;
      } else if (opcode === 0x09) {
        // Ping - send pong
        this.sendRaw(client, 0x0a, payload);
      } else if (opcode === 0x01) {
        // Text frame
        try {
          const msg = JSON.parse(payload.toString("utf8"));
          this.onMessage(client, msg);
        } catch (e) {
          console.error(`[ws] Client ${client.id} invalid JSON:`, e.message);
        }
      }
    }
  }

  onMessage(client, msg) {
    console.log(`[ws] Client ${client.id} message:`, msg);

    if (msg.type === "subscribe") {
      const { session, symbol } = msg;
      if (!session || !symbol) {
        this.send(client, { type: "error", message: "Missing session or symbol" });
        return;
      }

      const subKey = `${session}:${symbol}`;
      client.subscriptions.add(subKey);

      // Start watching the live snapshots file if not already
      this.startWatching(session, symbol);

      // Send current status
      this.sendSessionStatus(client, session, symbol);

      // Send existing live data
      this.sendExistingLiveData(client, session, symbol);

      this.send(client, { type: "subscribed", session, symbol });
    } else if (msg.type === "unsubscribe") {
      const { session, symbol } = msg;
      const subKey = `${session}:${symbol}`;
      client.subscriptions.delete(subKey);
      this.send(client, { type: "unsubscribed", session, symbol });
    } else if (msg.type === "ping") {
      this.send(client, { type: "pong", ts: Date.now() });
    }
  }

  onClose(client) {
    console.log(`[ws] Client ${client.id} disconnected`);
    client.socket.destroy();
    this.clients.delete(client.id);
  }

  send(client, obj) {
    const data = JSON.stringify(obj);
    this.sendRaw(client, 0x01, Buffer.from(data, "utf8"));
  }

  sendRaw(client, opcode, payload) {
    if (!client.socket.writable) return;

    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    client.socket.write(Buffer.concat([header, payload]));
  }

  broadcast(subKey, obj) {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(subKey)) {
        this.send(client, obj);
      }
    }
  }

  async sendSessionStatus(client, session, symbol) {
    const capturesDir = DATA_DIR || getDefaultDataDir();
    const statusPath = path.join(capturesDir, session, "derived", symbol, "snapshots", "live.status.json");
    
    try {
      const content = await fsp.readFile(statusPath, "utf8");
      const status = JSON.parse(content);
      this.send(client, { type: "status", session, symbol, ...status });
    } catch (_) {
      // No status file - check if session exists
      const sessionDir = path.join(capturesDir, session);
      const exists = await existsDir(sessionDir);
      this.send(client, { 
        type: "status", 
        session, 
        symbol, 
        recording: false, 
        exists,
      });
    }
  }

  async sendExistingLiveData(client, session, symbol) {
    const capturesDir = DATA_DIR || getDefaultDataDir();
    const livePath = path.join(capturesDir, session, "derived", symbol, "snapshots", "live.ndjson");
    
    try {
      const content = await fsp.readFile(livePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      
      // Send historical data
      for (const line of lines) {
        try {
          const snapshot = JSON.parse(line);
          this.send(client, { type: "snapshot", session, symbol, snapshot });
        } catch (_) {}
      }
      
      this.send(client, { type: "history_complete", session, symbol, count: lines.length });
    } catch (_) {
      this.send(client, { type: "history_complete", session, symbol, count: 0 });
    }
  }

  startWatching(session, symbol) {
    const watchKey = `${session}:${symbol}`;
    if (this.watchers.has(watchKey)) return;

    const capturesDir = DATA_DIR || getDefaultDataDir();
    const livePath = path.join(capturesDir, session, "derived", symbol, "snapshots", "live.ndjson");
    const statusPath = path.join(capturesDir, session, "derived", symbol, "snapshots", "live.status.json");

    // Initialize file position
    try {
      const stat = fs.statSync(livePath);
      this.filePositions.set(livePath, stat.size);
    } catch (_) {
      this.filePositions.set(livePath, 0);
    }

    // Use polling interval as primary method (more reliable than fs.watch on macOS)
    const pollInterval = setInterval(async () => {
      try {
        await this.onFileChange(watchKey, livePath);
        await this.onStatusChange(watchKey, statusPath);
      } catch (err) {
        console.error(`[ws] Polling error for ${watchKey}:`, err.message);
      }
    }, 1000); // Poll every 1 second

    this.watchers.set(watchKey, { type: 'poll', interval: pollInterval });
    console.log(`[ws] Started polling ${watchKey} (1s interval)`);
  }

  async onFileChange(watchKey, filePath) {
    const lastPos = this.filePositions.get(filePath) || 0;
    
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size <= lastPos) return;

      // Read new content
      const fd = await fsp.open(filePath, "r");
      const buffer = Buffer.alloc(stat.size - lastPos);
      await fd.read(buffer, 0, buffer.length, lastPos);
      await fd.close();

      this.filePositions.set(filePath, stat.size);

      // Parse and broadcast new lines
      const lines = buffer.toString("utf8").trim().split("\n").filter(Boolean);
      const [session, symbol] = watchKey.split(":");

      for (const line of lines) {
        try {
          const snapshot = JSON.parse(line);
          this.broadcast(watchKey, { type: "snapshot", session, symbol, snapshot });
        } catch (_) {}
      }
    } catch (err) {
      console.error(`[ws] Error reading ${filePath}:`, err.message);
    }
  }

  async onStatusChange(watchKey, statusPath) {
    try {
      const content = await fsp.readFile(statusPath, "utf8");
      const status = JSON.parse(content);
      const [session, symbol] = watchKey.split(":");
      this.broadcast(watchKey, { type: "status", session, symbol, ...status });
    } catch (_) {}
  }

  stopWatching(watchKey) {
    const watcher = this.watchers.get(watchKey);
    if (watcher) {
      if (watcher.type === 'poll') {
        clearInterval(watcher.interval);
      } else {
        watcher.close();
      }
      this.watchers.delete(watchKey);
      console.log(`[ws] Stopped watching ${watchKey}`);
    }
  }

  shutdown() {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    
    for (const client of this.clients.values()) {
      this.send(client, { type: "shutdown" });
      client.socket.destroy();
    }
    this.clients.clear();
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2) + "\n";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function send404(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Not found\n");
}

function send500(res, err) {
  res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`Server error\n${err && err.message ? err.message : String(err)}\n`);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

function isNdjsonFile(p, includeTmp) {
  if (p.endsWith(".ndjson")) return true;
  if (includeTmp && p.endsWith(".ndjson.tmp")) return true;
  return false;
}

function getBackendDir() {
  return path.resolve(__dirname, "..", ".."); // backend/
}

function getPublicDir() {
  return path.join(getBackendDir(), "public"); // backend/public/
}

function getDefaultDataDir() {
  return path.join(getBackendDir(), "captures"); // backend/captures/
}

async function existsDir(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch (_) {
    return false;
  }
}

async function getSessions() {
  // DATA_DIR is now backend/captures/ by default
  const capturesDir = DATA_DIR || getDefaultDataDir();

  const sessions = [];
  const seen = new Set();

  // List all session directories under capturesDir
  if (await existsDir(capturesDir)) {
    const ents = await fsp.readdir(capturesDir, { withFileTypes: true });
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (seen.has(id)) continue;
      const rootDir = path.join(capturesDir, id);
      if (await existsDir(path.join(rootDir, "raw"))) {
        sessions.push({ id, label: id, rootDir });
        seen.add(id);
      }
    }
  }

  return sessions;
}

async function getSessionRoot(sessionId) {
  const sessions = await getSessions();
  const s = sessions.find((x) => x.id === sessionId) || null;
  return s ? s.rootDir : null;
}

async function listNdjsonFiles(dir, includeTmp) {
  const files = await listFilesRecursive(dir);
  return files.filter((p) => isNdjsonFile(p, includeTmp));
}

async function* iterNdjsonLines(files) {
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      yield line;
    }
  }
}

function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

async function* iterTimestampedNdjson(files, { fromMs = null, toMs = null } = {}) {
  for await (const line of iterNdjsonLines(files)) {
    const obj = safeParseJson(line);
    if (!obj) continue;
    const ts = Number(obj.ts_capture_ms || obj.ts_event_ms || 0) || 0;
    if (fromMs && ts < fromMs) continue;
    if (toMs && ts > toMs) continue;
    yield { ts, line };
  }
}

async function streamNdjson(res, iterator) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "Transfer-Encoding": "chunked",
  });

  for await (const item of iterator) {
    const line = typeof item === "string" ? item : item.line;
    res.write(line + "\n");
  }
  res.end();
}

async function serveStatic(req, res, staticRoot) {
  const parsed = url.parse(req.url);
  let pathname = parsed.pathname || "/";
  if (pathname === "/") pathname = "/replay.html";

  // normalize and prevent traversal
  const fsPath = path.resolve(staticRoot, "." + pathname);
  if (!fsPath.startsWith(staticRoot)) {
    return send404(res);
  }

  try {
    const st = await fsp.stat(fsPath);
    if (!st.isFile()) return send404(res);

    res.writeHead(200, {
      "Content-Type": contentTypeFor(fsPath),
      "Cache-Control": "no-store",
    });
    fs.createReadStream(fsPath).pipe(res);
  } catch (_) {
    send404(res);
  }
}

async function handleApi(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "";
  const q = parsed.query || {};

  if (pathname === "/api/replay/sessions") {
    const sessions = await getSessions();
    
    // Check recording status for each session
    const sessionsWithStatus = await Promise.all(
      sessions.map(async (s) => {
        const result = { id: s.id, label: s.label, recording: false, symbols: [] };
        
        // Check for live status files
        const derivedDir = path.join(s.rootDir, "derived");
        try {
          const symbols = await fsp.readdir(derivedDir);
          for (const symbol of symbols) {
            const statusPath = path.join(derivedDir, symbol, "snapshots", "live.status.json");
            try {
              const content = await fsp.readFile(statusPath, "utf8");
              const status = JSON.parse(content);
              if (status.recording) {
                result.recording = true;
                result.symbols.push({ symbol, snapshotCount: status.snapshotCount });
              }
            } catch (_) {}
          }
        } catch (_) {}
        
        return result;
      })
    );
    
    return json(res, 200, sessionsWithStatus);
  }
  
  if (pathname === "/api/replay/session/status") {
    const sessionId = String(q.session || "");
    const symbol = String(q.symbol || "BTC").toUpperCase();
    
    if (!sessionId) return json(res, 400, { error: "Missing session" });
    
    const rootDir = await getSessionRoot(sessionId);
    if (!rootDir) return json(res, 404, { error: "Session not found" });
    
    const statusPath = path.join(rootDir, "derived", symbol, "snapshots", "live.status.json");
    
    try {
      const content = await fsp.readFile(statusPath, "utf8");
      const status = JSON.parse(content);
      return json(res, 200, { session: sessionId, symbol, ...status });
    } catch (_) {
      return json(res, 200, { session: sessionId, symbol, recording: false });
    }
  }

  if (pathname === "/api/replay/files") {
    const sessionId = String(q.session || "default");
    const kind = String(q.kind || "raw");
    const includeTmp = asBool(q.includeTmp, false);

    const rootDir = await getSessionRoot(sessionId);
    if (!rootDir) return json(res, 400, { error: "Unknown session" });

    if (kind === "raw") {
      const exchange = String(q.exchange || "");
      const stream = String(q.stream || "");
      const symbol = String(q.symbol || "").toUpperCase();
      if (!exchange || !stream || !symbol) return json(res, 400, { error: "Missing exchange/stream/symbol" });
      const dir = path.join(rootDir, "raw", exchange, stream, symbol);
      const files = await listNdjsonFiles(dir, includeTmp);
      return json(res, 200, { files: files.map((p) => path.relative(rootDir, p)) });
    }

    if (kind === "candles") {
      const symbol = String(q.symbol || "").toUpperCase();
      const timeframe = String(q.timeframe || "");
      if (!symbol || !timeframe) return json(res, 400, { error: "Missing symbol/timeframe" });
      const dir = path.join(rootDir, "derived", "candles", symbol, timeframe);
      const files = await listNdjsonFiles(dir, includeTmp);
      return json(res, 200, { files: files.map((p) => path.relative(rootDir, p)) });
    }

    return json(res, 400, { error: "Unknown kind" });
  }

  if (pathname === "/api/replay/stream") {
    const sessionId = String(q.session || "default");
    const kind = String(q.kind || "raw");
    const includeTmp = asBool(q.includeTmp, false);
    const fromMs = q.fromMs !== undefined ? Number(q.fromMs) : null;
    const toMs = q.toMs !== undefined ? Number(q.toMs) : null;

    const rootDir = await getSessionRoot(sessionId);
    if (!rootDir) return json(res, 400, { error: "Unknown session" });

    if (kind === "raw") {
      const exchange = String(q.exchange || "");
      const stream = String(q.stream || "");
      const symbol = String(q.symbol || "").toUpperCase();
      if (!exchange || !stream || !symbol) return json(res, 400, { error: "Missing exchange/stream/symbol" });
      const dir = path.join(rootDir, "raw", exchange, stream, symbol);
      const files = await listNdjsonFiles(dir, includeTmp);
      return streamNdjson(res, iterTimestampedNdjson(files, { fromMs, toMs }));
    }

    if (kind === "candles") {
      const symbol = String(q.symbol || "").toUpperCase();
      const timeframe = String(q.timeframe || "");
      if (!symbol || !timeframe) return json(res, 400, { error: "Missing symbol/timeframe" });
      const dir = path.join(rootDir, "derived", "candles", symbol, timeframe);
      const files = await listNdjsonFiles(dir, includeTmp);
      return streamNdjson(res, iterTimestampedNdjson(files, { fromMs, toMs }));
    }

    if (kind === "book") {
      const symbol = String(q.symbol || "").toUpperCase();
      const exchanges = csv(q.exchanges).map((s) => s.toLowerCase());
      const ex = exchanges.length ? exchanges : ["kraken", "coinbase", "bitstamp"];
      if (!symbol) return json(res, 400, { error: "Missing symbol" });

      // Each exchange book stream is assumed at raw/{exchange}/book/{symbol}/...
      const sources = [];
      for (const exchange of ex) {
        const dir = path.join(rootDir, "raw", exchange, "book", symbol);
        const files = await listNdjsonFiles(dir, includeTmp);
        sources.push({ exchange, iter: iterTimestampedNdjson(files, { fromMs, toMs }) });
      }

      // Seed heads
      const heads = [];
      for (const s of sources) {
        const n = await s.iter.next();
        if (!n.done) heads.push({ exchange: s.exchange, iter: s.iter, ts: n.value.ts, line: n.value.line });
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "Transfer-Encoding": "chunked",
      });

      while (heads.length) {
        // k-way merge; with <=3 sources, linear scan is fine.
        let minIdx = 0;
        for (let i = 1; i < heads.length; i++) {
          if (heads[i].ts < heads[minIdx].ts) minIdx = i;
        }

        const h = heads[minIdx];
        res.write(h.line + "\n");

        const n = await h.iter.next();
        if (n.done) {
          heads.splice(minIdx, 1);
        } else {
          heads[minIdx] = { exchange: h.exchange, iter: h.iter, ts: n.value.ts, line: n.value.line };
        }
      }

      res.end();
      return;
    }

    // Pre-computed metrics feed (output from npm run metrics)
    if (kind === "metrics") {
      const symbol = String(q.symbol || "").toUpperCase();
      const timeframe = String(q.timeframe || "");
      if (!symbol || !timeframe) return json(res, 400, { error: "Missing symbol/timeframe" });
      const metricsFile = path.join(rootDir, "derived", symbol, "metrics", `${timeframe}.ndjson`);
      
      try {
        await fsp.access(metricsFile);
      } catch (_) {
        return json(res, 404, { 
          error: "Metrics not computed yet", 
          hint: `Run: npm run metrics -- --session=${sessionId} --symbol=${symbol} --timeframe=${timeframe}`
        });
      }
      
      const files = [metricsFile];
      return streamNdjson(res, iterNdjsonLines(files));
    }

    // Book snapshots feed - try live.ndjson first (always available after recording), 
    // fall back to processed ${timeframe}.ndjson
    if (kind === "snapshots") {
      const symbol = String(q.symbol || "").toUpperCase();
      const timeframe = String(q.timeframe || "");
      if (!symbol || !timeframe) return json(res, 400, { error: "Missing symbol/timeframe" });
      
      // Try live.ndjson first (always exists after recording, same format)
      const liveFile = path.join(rootDir, "derived", symbol, "snapshots", "live.ndjson");
      const processedFile = path.join(rootDir, "derived", symbol, "snapshots", `${timeframe}.ndjson`);
      
      let snapshotsFile = null;
      try {
        await fsp.access(liveFile);
        snapshotsFile = liveFile;
      } catch (_) {
        // Fall back to processed file
        try {
          await fsp.access(processedFile);
          snapshotsFile = processedFile;
        } catch (_) {
          return json(res, 404, { 
            error: "No snapshots found", 
            hint: `Either record data first, or run: npm run snapshots -- --session=${sessionId} --symbol=${symbol} --timeframe=${timeframe}`
          });
        }
      }
      
      const files = [snapshotsFile];
      return streamNdjson(res, iterNdjsonLines(files));
    }

    return json(res, 400, { error: "Unknown kind" });
  }

  return send404(res);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port !== undefined ? Number(args.port) : 8787;
  const host = args.host ? String(args.host) : "127.0.0.1";
  DATA_DIR = args.dataDir ? path.resolve(String(args.dataDir)) : getDefaultDataDir();

  const staticRoot = getPublicDir();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url && req.url.startsWith("/api/")) {
        await handleApi(req, res);
        return;
      }
      await serveStatic(req, res, staticRoot);
    } catch (e) {
      send500(res, e);
    }
  });

  // Initialize WebSocket server for live streaming
  const wsServer = new WebSocketServer(server);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("[replay-server] Shutting down...");
    wsServer.shutdown();
    server.close(() => process.exit(0));
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`[replay-server] listening on http://${host}:${port}/`);
    console.log(`[replay-server] WebSocket endpoint: ws://${host}:${port}/ws`);
    console.log(`[replay-server] dataDir=${DATA_DIR}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[replay-server] fatal", e);
  process.exit(1);
});


