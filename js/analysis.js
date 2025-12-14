/**
 * analysis.js - Live metric analysis (index.html-style live data)
 *
 * - UI mirrors backend/public/replay.html
 * - Data comes directly from exchange WebSockets:
 *   - OHLC: wsManager (Kraken OHLC stream)
 *   - Order book: orderBookWS (multi-exchange book)
 *
 * This file is intentionally derived from replay.js to keep metric math
 * and chart rendering identical, while swapping the data source to live.
 */
(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────
  // DOM References
  // ─────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const sessionSelect = $("sessionSelect");
  const symbolInput = $("symbolInput");
  const timeframeSelect = $("timeframeSelect");
  const loadBtn = $("loadBtn");
  const statusEl = $("status");
  const chartsContainer = $("charts");
  const liveBadge = $("liveBadge");
  const liveIndicator = $("liveIndicator");
  
  // System status elements
  const systemStatusIcon = $("systemStatusIcon");
  const serverStatusDot = $("serverStatusDot");
  const serverStatusText = $("serverStatusText");
  const recorderStatusDot = $("recorderStatusDot");
  const recorderStatusText = $("recorderStatusText");
  const wsStatusDot = $("wsStatusDot");
  const wsStatusText = $("wsStatusText");
  const liveStats = $("liveStats");
  const liveStatsContent = $("liveStatsContent");
  const countdownContainer = $("countdownContainer");
  const countdownEl = $("countdown");
  
  // Entry Signals panel elements
  const currentSignalEl = $("currentSignal");
  const longCertaintyEl = $("longCertainty");
  const shortCertaintyEl = $("shortCertainty");
  const longCertaintyBar = $("longCertaintyBar");
  const shortCertaintyBar = $("shortCertaintyBar");
  const sigNearPressure = $("sigNearPressure");
  const sigDepthImbal = $("sigDepthImbal");
  const sigBPR = $("sigBPR");
  const sigLD = $("sigLD");
  const sigIFV = $("sigIFV");
  const sigVWMP = $("sigVWMP");
  const sigLDMom = $("sigLDMom");
  const sigSpread = $("sigSpread");

  // Settings elements
  const settingCluster = $("settingCluster");
  const settingMaxLevels = $("settingMaxLevels");
  const settingMinVol = $("settingMinVol");
  const settingPriceRange = $("settingPriceRange");
  const settingFairValueRange = $("settingFairValueRange");
  const settingAlphaMode = $("settingAlphaMode");
  
  // Individual alpha sensitivities
  const alphaSensitivityMM = $("alphaSensitivityMM");
  const alphaSensitivitySwing = $("alphaSensitivitySwing");
  const alphaSensitivityHTF = $("alphaSensitivityHTF");

  // State
  let snapshots = [];           // Aggregated snapshots (for current timeframe)
  let rawSnapshots = [];        // Raw 1m snapshots (for aggregation)
  let snapshotTimeSet = new Set(); // For O(1) duplicate detection (raw 1m times)
  let charts = [];
  
  // Live state (direct exchange WebSockets)
  let pendingSnapshot = null; // Current in-progress 1m candle snapshot
  let isStreaming = false;
  let currentTimeframe = "1m"; // Display timeframe (aggregation target)
  let currentSymbol = "BTC";
  let countdownInterval = null; // Countdown timer interval
  let lastBarTime = 0; // Last closed bar timestamp (seconds)
  const MAX_RAW_BARS = 2000; // Cap raw 1m candles kept in memory

  function setStatus(msg, isError = false) {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.style.color = isError ? "#ef4444" : "#94a3b8";
    }
    console.log("[Analysis]", msg);
  }

  // ─────────────────────────────────────────────────────────────
  // Entry Signals Panel Update
  // ─────────────────────────────────────────────────────────────
  function updateEntrySignalsPanel(metrics) {
    if (!metrics) {
      // Reset panel when no data
      if (currentSignalEl) {
        currentSignalEl.textContent = "NO DATA";
        currentSignalEl.style.background = "rgba(100,116,139,0.2)";
        currentSignalEl.style.color = "#94a3b8";
        currentSignalEl.style.borderColor = "rgba(100,116,139,0.4)";
      }
      if (longCertaintyEl) longCertaintyEl.textContent = "-";
      if (shortCertaintyEl) shortCertaintyEl.textContent = "-";
      if (longCertaintyBar) longCertaintyBar.style.width = "0%";
      if (shortCertaintyBar) shortCertaintyBar.style.width = "0%";
      return;
    }
    
    const { longCertainty, shortCertainty, entrySignal, nearPressureImbalance, depthImbalancePct, 
            bpr, ldPct, ifvDivPct, vwmpDivPct, ldMomentum, spreadState, spreadDirection } = metrics;
    
    // Update signal display
    if (currentSignalEl) {
      currentSignalEl.textContent = entrySignal;
      if (entrySignal === "LONG") {
        currentSignalEl.style.background = "rgba(16,185,129,0.3)";
        currentSignalEl.style.color = "#10b981";
        currentSignalEl.style.borderColor = "rgba(16,185,129,0.6)";
        currentSignalEl.style.animation = "pulse-btn 1s infinite";
      } else if (entrySignal === "SHORT") {
        currentSignalEl.style.background = "rgba(239,68,68,0.3)";
        currentSignalEl.style.color = "#ef4444";
        currentSignalEl.style.borderColor = "rgba(239,68,68,0.6)";
        currentSignalEl.style.animation = "pulse-btn 1s infinite";
      } else {
        currentSignalEl.style.background = "rgba(100,116,139,0.2)";
        currentSignalEl.style.color = "#94a3b8";
        currentSignalEl.style.borderColor = "rgba(100,116,139,0.4)";
        currentSignalEl.style.animation = "none";
      }
    }
    
    // Update certainty displays
    if (longCertaintyEl) longCertaintyEl.textContent = longCertainty;
    if (shortCertaintyEl) shortCertaintyEl.textContent = shortCertainty;
    if (longCertaintyBar) longCertaintyBar.style.width = `${longCertainty}%`;
    if (shortCertaintyBar) shortCertaintyBar.style.width = `${shortCertainty}%`;
    
    // Update component indicators
    const colorValue = (val, posThresh, negThresh) => {
      if (val > posThresh) return "#10b981"; // green
      if (val < negThresh) return "#ef4444"; // red
      return "#94a3b8"; // gray
    };
    
    if (sigNearPressure) {
      sigNearPressure.textContent = `${nearPressureImbalance > 0 ? "+" : ""}${nearPressureImbalance.toFixed(1)}%`;
      sigNearPressure.style.color = colorValue(nearPressureImbalance, 25, -25);
    }
    if (sigDepthImbal) {
      sigDepthImbal.textContent = `${depthImbalancePct > 0 ? "+" : ""}${depthImbalancePct.toFixed(1)}%`;
      sigDepthImbal.style.color = colorValue(depthImbalancePct, 25, -25);
    }
    if (sigBPR) {
      sigBPR.textContent = bpr.toFixed(2);
      sigBPR.style.color = bpr > 1.5 ? "#10b981" : bpr < 0.67 ? "#ef4444" : "#94a3b8";
    }
    if (sigLD) {
      sigLD.textContent = `${ldPct > 0 ? "+" : ""}${ldPct.toFixed(1)}%`;
      sigLD.style.color = colorValue(ldPct, 25, -25);
    }
    if (sigIFV) {
      const ifvStr = ifvDivPct < 0 ? "BELOW" : ifvDivPct > 0 ? "ABOVE" : "AT";
      sigIFV.textContent = `${ifvStr} (${(ifvDivPct * 100).toFixed(2)}bp)`;
      sigIFV.style.color = ifvDivPct < -0.01 ? "#10b981" : ifvDivPct > 0.01 ? "#ef4444" : "#94a3b8";
    }
    if (sigVWMP) {
      const vwmpStr = vwmpDivPct < 0 ? "BELOW" : vwmpDivPct > 0 ? "ABOVE" : "AT";
      sigVWMP.textContent = `${vwmpStr} (${(vwmpDivPct * 100).toFixed(2)}bp)`;
      sigVWMP.style.color = vwmpDivPct < -0.01 ? "#10b981" : vwmpDivPct > 0.01 ? "#ef4444" : "#94a3b8";
    }
    if (sigLDMom) {
      sigLDMom.textContent = ldMomentum.toUpperCase();
      sigLDMom.style.color = ldMomentum === "rising" ? "#10b981" : ldMomentum === "falling" ? "#ef4444" : "#94a3b8";
    }
    if (sigSpread) {
      sigSpread.textContent = `${spreadState.toUpperCase()} / ${spreadDirection.toUpperCase()}`;
      const spreadGood = spreadState === "tight" || spreadDirection === "tightening";
      sigSpread.style.color = spreadGood ? "#10b981" : spreadState === "wide" ? "#f59e0b" : "#94a3b8";
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Countdown Timer
  // ─────────────────────────────────────────────────────────────
  function startCountdown() {
    stopCountdown();
    if (countdownContainer) countdownContainer.style.display = "block";
    
    countdownInterval = setInterval(() => {
      updateCountdown();
    }, 1000);
    
    updateCountdown(); // Initial update
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (countdownContainer) countdownContainer.style.display = "none";
  }

  function updateCountdown() {
    if (!countdownEl || !isStreaming) return;
    
    // Get selected timeframe and convert to seconds
    const tf = timeframeSelect ? timeframeSelect.value : "1m";
    const tfSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
    const interval = tfSeconds[tf] || 60;
    
    const now = Math.floor(Date.now() / 1000);
    const currentBarStart = Math.floor(now / interval) * interval;
    const nextBarStart = currentBarStart + interval;
    const secondsRemaining = nextBarStart - now;
    
    // Format as mm:ss for longer intervals
    if (interval > 60) {
      const mins = Math.floor(secondsRemaining / 60);
      const secs = secondsRemaining % 60;
      countdownEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    } else {
      countdownEl.textContent = `${secondsRemaining}s`;
    }
    
    // Change color based on percentage remaining
    const pctRemaining = secondsRemaining / interval;
    if (pctRemaining <= 0.15) {
      countdownEl.style.color = "#ef4444"; // Red when close
    } else if (pctRemaining <= 0.5) {
      countdownEl.style.color = "#f59e0b"; // Orange/amber
    } else {
      countdownEl.style.color = "#3b82f6"; // Blue default
    }
  }

  // ─────────────────────────────────────────────────────────────
  // System Status Updates
  // ─────────────────────────────────────────────────────────────
  function getOrderBookConnectionStatusSafe() {
    try {
      if (typeof orderBookWS === "undefined" || !orderBookWS || typeof orderBookWS.getConnectionStatus !== "function") {
        return { kraken: false, coinbase: false, bitstamp: false, anyConnected: false, allConnected: false };
      }
      return orderBookWS.getConnectionStatus();
    } catch (_) {
      return { kraken: false, coinbase: false, bitstamp: false, anyConnected: false, allConnected: false };
    }
  }
  
  function getOhlcConnectedSafe() {
    try {
      return !!(typeof wsManager !== "undefined" && wsManager && wsManager.ohlcConnected);
    } catch (_) {
      return false;
    }
  }
  
  function updateSystemStatus() {
    const ohlcOk = getOhlcConnectedSafe();
    const ob = getOrderBookConnectionStatusSafe();
    const bookOk = !!ob.anyConnected;
    const anyOk = ohlcOk || bookOk;
    const allOk = ohlcOk && bookOk;
    
    // OHLC status (serverStatus*)
    if (serverStatusDot) {
      serverStatusDot.style.background = ohlcOk ? "#10b981" : (isStreaming ? "#f59e0b" : "#64748b");
    }
    if (serverStatusText) {
      serverStatusText.textContent = ohlcOk ? "Connected (Kraken)" : (isStreaming ? "Connecting..." : "Idle");
      serverStatusText.style.color = ohlcOk ? "#10b981" : "#94a3b8";
    }
    
    // Order Book status (recorderStatus*)
    const connectedExchanges = [];
    if (ob.kraken) connectedExchanges.push("Kraken");
    if (ob.coinbase) connectedExchanges.push("Coinbase");
    if (ob.bitstamp) connectedExchanges.push("Bitstamp");
    const obLabel = connectedExchanges.length > 0 ? connectedExchanges.join(", ") : "";
    
    if (recorderStatusDot) {
      recorderStatusDot.style.background = bookOk ? "#10b981" : (isStreaming ? "#f59e0b" : "#64748b");
    }
    if (recorderStatusText) {
      recorderStatusText.textContent = bookOk ? `Connected${obLabel ? ` (${obLabel})` : ""}` : (isStreaming ? "Connecting..." : "Idle");
      recorderStatusText.style.color = bookOk ? "#10b981" : "#94a3b8";
    }
    
    // Overall WebSocket status (wsStatus*)
    if (wsStatusDot) {
      wsStatusDot.style.background = allOk ? "#10b981" : (anyOk ? "#f59e0b" : "#64748b");
    }
    if (wsStatusText) {
      wsStatusText.textContent = allOk ? "Connected" : (isStreaming ? "Connecting..." : "Disconnected");
      wsStatusText.style.color = allOk ? "#10b981" : "#94a3b8";
    }
    
    // Overall status icon
    if (systemStatusIcon) {
      if (allOk) systemStatusIcon.textContent = "🟢";
      else if (anyOk) systemStatusIcon.textContent = "🟡";
      else systemStatusIcon.textContent = isStreaming ? "🔴" : "⚪";
    }
    
    // Sync header indicator
    updateLiveIndicator(allOk);
  }

  function updateWebSocketStatus(connected, info = "") {
    // Compatibility shim (replay.js used a backend ws; analysis uses direct exchange ws)
    void connected;
    void info;
    updateSystemStatus();
  }

  function updateLiveStats(snapshotCount, lastTime, lastPrice) {
    if (liveStats) {
      liveStats.style.display = isStreaming ? "block" : "none";
    }
    if (liveStatsContent && isStreaming) {
      const timeStr = lastTime ? new Date(lastTime * 1000).toLocaleTimeString() : "-";
      const priceStr = lastPrice ? `$${Number(lastPrice).toLocaleString()}` : "-";
      liveStatsContent.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:16px;">
          <span>Bars: <strong>${snapshotCount}</strong></span>
          <span>Last: <strong>${timeStr}</strong></span>
          <span>Price: <strong>${priceStr}</strong></span>
        </div>
      `;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────
  function getSettings() {
    return {
      clusterPct: settingCluster ? parseFloat(settingCluster.value) / 100 : 0.0015,
      maxLevels: settingMaxLevels ? parseInt(settingMaxLevels.value, 10) : 500,
      minVolume: settingMinVol ? parseFloat(settingMinVol.value) : 1,
      priceRangePct: settingPriceRange ? parseFloat(settingPriceRange.value) : 10,
      fairValueRange: settingFairValueRange ? parseFloat(settingFairValueRange.value) : 10,
      alphaMode: settingAlphaMode ? settingAlphaMode.value : "investor",
      // Individual sensitivities for each alpha mode
      alphaSensMM: alphaSensitivityMM ? parseInt(alphaSensitivityMM.value, 10) : 50,
      alphaSensSwing: alphaSensitivitySwing ? parseInt(alphaSensitivitySwing.value, 10) : 50,
      alphaSensHTF: alphaSensitivityHTF ? parseInt(alphaSensitivityHTF.value, 10) : 50,
    };
  }

  function loadSettingsFromStorage() {
    try {
      const ls = JSON.parse(localStorage.getItem("orderbook_level_settings") || "{}");
      if (settingCluster) settingCluster.value = ls.clusterPct !== undefined ? ls.clusterPct * 100 : 0.15;
      if (settingMaxLevels) settingMaxLevels.value = ls.maxLevels || 500;
      if (settingMinVol) settingMinVol.value = ls.minVolume || 1;
      if (settingPriceRange) settingPriceRange.value = ls.priceRangePct || 10;
    } catch (_) {}
    const fvRange = localStorage.getItem("fairValueRange");
    if (settingFairValueRange) settingFairValueRange.value = fvRange || 10;
    
    // Alpha mode (kept for compatibility)
    const alphaMode = localStorage.getItem("alphaMode") || "investor";
    if (settingAlphaMode) settingAlphaMode.value = alphaMode;
    
    // Individual alpha sensitivities
    const sensMM = localStorage.getItem("replay_alphaSensMM");
    const sensSwing = localStorage.getItem("replay_alphaSensSwing");
    const sensHTF = localStorage.getItem("replay_alphaSensHTF");
    if (alphaSensitivityMM) alphaSensitivityMM.value = sensMM !== null ? sensMM : 50;
    if (alphaSensitivitySwing) alphaSensitivitySwing.value = sensSwing !== null ? sensSwing : 50;
    if (alphaSensitivityHTF) alphaSensitivityHTF.value = sensHTF !== null ? sensHTF : 50;
  }

  function bindSettingsEvents() {
    // Recompute on order book settings change
    const settingsInputs = [settingCluster, settingMaxLevels, settingMinVol, settingPriceRange, settingFairValueRange];
    settingsInputs.forEach((el) => {
      if (el) {
        el.addEventListener("change", recomputeAndRender);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // API Calls
  // ─────────────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      const res = await fetch("/api/replay/sessions");
      const data = await res.json();
      sessionSelect.innerHTML = "";
      const sessions = Array.isArray(data) ? data : (data.sessions || []);
      
      // Track recording status
      sessionRecordingStatus.clear();
      
      sessions.forEach((s) => {
        const opt = document.createElement("option");
        const id = typeof s === "string" ? s : s.id;
        const label = typeof s === "string" ? s : (s.label || s.id);
        const recording = s.recording || false;
        
        opt.value = id;
        opt.textContent = recording ? `🔴 ${label} (LIVE)` : label;
        opt.dataset.recording = recording;
        sessionSelect.appendChild(opt);
        
        sessionRecordingStatus.set(id, { recording, symbols: s.symbols || [] });
      });
      
      return sessions.length;
    } catch (e) {
      setStatus("Failed to load sessions: " + e.message, true);
      return 0;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // WebSocket / Live Mode
  // ─────────────────────────────────────────────────────────────
  function getWebSocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = getWebSocketUrl();
    console.log("[Live] Connecting to", wsUrl);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log("[Live] Connected");
      updateLiveIndicator(true);
      updateWebSocketStatus(true);
      
      // Subscribe to current session/symbol
      if (currentSession && currentSymbol) {
        ws.send(JSON.stringify({ type: "subscribe", session: currentSession, symbol: currentSymbol }));
      }
    };
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWebSocketMessage(msg);
      } catch (e) {
        console.error("[Live] Invalid message:", e);
      }
    };
    
    ws.onerror = (err) => {
      console.error("[Live] WebSocket error:", err);
    };
    
    ws.onclose = () => {
      console.log("[Live] Disconnected");
      updateLiveIndicator(false);
      updateWebSocketStatus(false);
      ws = null;
      
      // Reconnect if still streaming a recording session
      if (isSessionRecording) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectWebSocket, 3000);
        setStatus("🔄 Reconnecting to live stream...");
      }
    };
  }

  function disconnectWebSocket() {
    clearTimeout(wsReconnectTimer);
    if (ws) {
      ws.close();
      ws = null;
    }
    updateLiveIndicator(false);
    updateWebSocketStatus(false);
    updateLiveStats(0, null, null);
  }

  function handleWebSocketMessage(msg) {
    switch (msg.type) {
      case "connected":
        console.log("[Live] Client ID:", msg.clientId);
        // Subscribe to current session/symbol
        if (currentSession && currentSymbol) {
          ws.send(JSON.stringify({ type: "subscribe", session: currentSession, symbol: currentSymbol }));
        }
        break;
        
      case "subscribed":
        console.log("[Live] Subscribed to", msg.session, msg.symbol);
        // If we already have data from HTTP, don't wait for history
        if (rawSnapshots.length === 0) {
          receivingHistory = true;
          setStatus(`🔴 Live: Waiting for data from ${msg.symbol}...`);
        } else {
          // Already have data, just wait for new live bars
          receivingHistory = false;
          console.log("[Live] Already have", rawSnapshots.length, "bars from HTTP, skipping WebSocket history");
        }
        break;
        
      case "status":
        console.log("[Live] Status:", msg);
        if (msg.recording) {
          setStatus(`🔴 Live recording: ${msg.snapshotCount || 0} snapshots captured`);
        } else {
          setStatus(`Session not recording. Historical data: ${msg.snapshotCount || 0} snapshots`);
        }
        break;
        
      case "history_complete":
        // If we already have data from HTTP, skip processing WebSocket history
        if (!receivingHistory) {
          console.log("[Live] Skipping WebSocket history_complete (already have HTTP data)");
          break;
        }
        
        console.log("[Live] Received", msg.count, "historical snapshots, actual raw:", rawSnapshots.length);
        receivingHistory = false; // Stop buffering, start live updates
        
        // Sort raw snapshots by time
        rawSnapshots.sort((a, b) => a.time - b.time);
        
        // Rebuild snapshotTimeSet from WebSocket history
        snapshotTimeSet = new Set(rawSnapshots.map(s => s.time));
        
        // Aggregate to current timeframe
        snapshots = aggregateSnapshots(rawSnapshots, currentTimeframe);
        console.log(`[Live] Aggregated to ${currentTimeframe}: ${snapshots.length} bars`);
        
        // Track last bar time for countdown
        if (snapshots.length > 0) {
          lastBarTime = snapshots[snapshots.length - 1].time;
        }
        
        if (snapshots.length === 0) {
          setStatus(`🔴 Live: Waiting for first candle to close...`);
        } else {
          setStatus(`🔴 Live: ${snapshots.length} ${currentTimeframe} bars loaded. Streaming...`);
          const computed = computeAllMetrics();
          renderCharts(computed);
          // Jump to current time in live mode
          scrollChartsToLatest();
          console.log("[Live] History loaded, waiting for new bars. Last bar:", new Date(lastBarTime * 1000).toISOString());
        }
        break;
        
      case "snapshot":
        handleLiveSnapshot(msg.snapshot);
        break;
        
      case "shutdown":
        console.log("[Live] Server shutting down");
        setStatus("Server disconnected", true);
        disconnectWebSocket();
        isSessionRecording = false;
        stopCountdown();
        break;
        
      case "error":
        console.error("[Live] Error:", msg.message);
        setStatus("Live error: " + msg.message, true);
        break;
    }
  }

  function handleLiveSnapshot(snapshot) {
    // Validate snapshot
    if (!snapshot || !snapshot.time || !snapshot.candle) {
      console.warn("[Live] Invalid snapshot received:", snapshot);
      return;
    }
    
    const time = new Date(snapshot.time * 1000);
    const closePrice = snapshot.candle?.c;
    
    // Check if this is a duplicate using the Set (O(1) lookup on raw times)
    if (snapshotTimeSet.has(snapshot.time)) {
      // Don't log - this is common during history load
      return;
    }
    
    // During history load, buffer to rawSnapshots
    if (receivingHistory) {
      rawSnapshots.push(snapshot);
      snapshotTimeSet.add(snapshot.time);
      return;
    }
    
    // Add to raw snapshots (always 1m)
    rawSnapshots.push(snapshot);
    snapshotTimeSet.add(snapshot.time);
    
    // For higher timeframes, check if we need to re-aggregate
    const tfSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
    const interval = tfSeconds[currentTimeframe] || 60;
    
    // Calculate if this snapshot completes a new bar in the current timeframe
    const newBarTime = Math.floor(snapshot.time / interval) * interval;
    const lastAggBarTime = snapshots.length > 0 ? snapshots[snapshots.length - 1].time : 0;
    const isNewBar = newBarTime > lastAggBarTime;
    
    if (currentTimeframe === "1m") {
      // For 1m, every snapshot is a new bar
      console.log("[Live] ★ NEW BAR:", time.toISOString(), "Close:", closePrice, "Total bars:", rawSnapshots.length);
      snapshots = [...rawSnapshots]; // Copy array for 1m
      lastBarTime = snapshot.time;
    } else if (isNewBar) {
      // For higher timeframes, re-aggregate when a new bar completes
      console.log(`[Live] ★ NEW ${currentTimeframe} BAR at`, new Date(newBarTime * 1000).toISOString());
      snapshots = aggregateSnapshots(rawSnapshots, currentTimeframe);
      lastBarTime = newBarTime;
    } else {
      // Update in progress - update the current bar's close
      if (snapshots.length > 0) {
        const lastBar = snapshots[snapshots.length - 1];
        lastBar.candle.h = Math.max(lastBar.candle.h, snapshot.candle.h);
        lastBar.candle.l = Math.min(lastBar.candle.l, snapshot.candle.l);
        lastBar.candle.c = snapshot.candle.c;
        lastBar.candle.v = (lastBar.candle.v || 0) + (snapshot.candle.v || 0);
        lastBar.book = snapshot.book; // Use latest book
      }
      // Don't re-render for every 1m update on higher timeframes
      return;
    }
    
    // Recompute and update charts
    const computed = computeAllMetrics();
    
    // Update charts with new data - force immediate update for new bars
    if (renderDebounceTimer) {
      clearTimeout(renderDebounceTimer);
      renderDebounceTimer = null;
    }
    
    // Save scroll position before rendering
    const scrollY = window.scrollY;
    
    try {
      console.log("[Live] Rendering charts with", snapshots.length, "bars...");
      renderCharts(computed);
      
      // Restore scroll position after render, then scroll charts to latest
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollY);
        scrollChartsToLatest();
      });
    } catch (e) {
      console.error("[Live] Chart render error:", e);
    }
    
    // Update status displays
    const priceStr = closePrice ? `$${Number(closePrice).toLocaleString()}` : "";
    setStatus(`🔴 Live: ${snapshots.length} bars • ${time.toLocaleTimeString()} • ${priceStr}`);
    updateLiveStats(snapshots.length, snapshot.time, closePrice);
    updateWebSocketStatus(true, `${snapshots.length} bars`);
  }

  let renderDebounceTimer = null;
  let pendingComputed = null;
  
  function updateChartsWithNewData(computed) {
    pendingComputed = computed;
    
    // Debounce rapid updates in live mode
    if (renderDebounceTimer) {
      clearTimeout(renderDebounceTimer);
    }
    
    renderDebounceTimer = setTimeout(() => {
      if (pendingComputed) {
        try {
          renderCharts(pendingComputed);
          scrollChartsToLatest();
        } catch (e) {
          console.error("[Analysis] Chart render error:", e);
        }
        pendingComputed = null;
      }
    }, 100); // Debounce for 100ms
  }
  
  function scrollChartsToLatest() {
    if (charts.length > 0) {
      // Small delay to ensure charts are rendered
      requestAnimationFrame(() => {
        charts.forEach((c) => {
          if (c.chart) {
            c.chart.timeScale().scrollToRealTime();
          }
        });
      });
    }
  }

  function updateLiveIndicator(connected) {
    if (liveIndicator) {
      liveIndicator.style.display = isStreaming ? "flex" : "none";
      liveIndicator.querySelector(".indicator-dot")?.classList.toggle("connected", connected);
      liveIndicator.querySelector(".indicator-text").textContent = connected ? "Streaming" : "Connecting...";
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Live Data (Exchange WebSockets)
  // ─────────────────────────────────────────────────────────────
  function disconnectLive() {
    try {
      if (typeof wsManager !== "undefined" && wsManager && typeof wsManager.disconnect === "function") {
        wsManager.disconnect();
      }
    } catch (_) {}
    
    try {
      if (typeof orderBookWS !== "undefined" && orderBookWS && typeof orderBookWS.disconnect === "function") {
        orderBookWS.disconnect();
      }
    } catch (_) {}
    
    pendingSnapshot = null;
    isStreaming = false;
    stopCountdown();
    updateLiveStats(0, null, null);
    if (liveBadge) {
      liveBadge.style.display = "none";
    }
    updateSystemStatus();
  }
  
  function getLiveOrderBookSnapshot() {
    try {
      if (typeof orderBookWS === "undefined" || !orderBookWS || typeof orderBookWS.getAggregatedBook !== "function") {
        return null;
      }
      const book = orderBookWS.getAggregatedBook();
      if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) || book.bids.length === 0 || book.asks.length === 0) {
        return null;
      }
      return {
        bids: book.bids.map((lvl) => [Number(lvl.price), Number(lvl.volume)]),
        asks: book.asks.map((lvl) => [Number(lvl.price), Number(lvl.volume)]),
      };
    } catch (_) {
      return null;
    }
  }
  
  function buildSnapshotFromOhlcCandle(candle) {
    const time = candle && candle.time ? Math.floor(Number(candle.time)) : 0;
    const o = Number(candle?.open);
    const h = Number(candle?.high);
    const l = Number(candle?.low);
    const c = Number(candle?.close);
    const v = Number(candle?.volume || 0);
    
    return {
      time,
      candle: { o, h, l, c, v },
      book: getLiveOrderBookSnapshot(),
    };
  }
  
  function handleClosedBarSnapshot(snapshot) {
    if (!snapshot || !snapshot.time || !snapshot.candle) return;
    
    // Deduplicate (reconnects can replay recent bars)
    if (snapshotTimeSet.has(snapshot.time)) return;
    
    rawSnapshots.push(snapshot);
    snapshotTimeSet.add(snapshot.time);
    
    // Cap memory usage
    while (rawSnapshots.length > MAX_RAW_BARS) {
      const removed = rawSnapshots.shift();
      if (removed && removed.time) snapshotTimeSet.delete(removed.time);
    }
    
    // Aggregate to selected timeframe and render
    snapshots = aggregateSnapshots(rawSnapshots, currentTimeframe);
    
    if (snapshots.length === 0) {
      setStatus("Waiting for data...");
      return;
    }
    
    lastBarTime = snapshots[snapshots.length - 1].time;
    
    const computed = computeAllMetrics();
    updateChartsWithNewData(computed);
    
    const closePrice = snapshot.candle?.c;
    const timeObj = new Date(snapshot.time * 1000);
    const priceStr = closePrice ? `$${Number(closePrice).toLocaleString()}` : "";
    setStatus(`🔴 Live: ${snapshots.length} bars • ${timeObj.toLocaleTimeString()} • ${priceStr}`);
    
    updateLiveStats(snapshots.length, snapshot.time, closePrice);
    updateSystemStatus();
    startCountdown();
  }
  
  function onPriceUpdate(_info) {
    // wsManager fires frequently (price + ticker); keep status in sync.
    updateSystemStatus();
  }
  
  function onOhlcUpdate(candle) {
    if (!isStreaming) return;
    if (!candle || !candle.time) return;
    
    const snap = buildSnapshotFromOhlcCandle(candle);
    if (!snap.time || !isFinite(snap.candle?.c)) return;
    
    // Prime until first candle closes
    if (!pendingSnapshot) {
      pendingSnapshot = snap;
      setStatus("Connected. Waiting for first candle to close...");
      updateSystemStatus();
      return;
    }
    
    // Candle still forming
    if (snap.time === pendingSnapshot.time) {
      pendingSnapshot.candle = snap.candle;
      pendingSnapshot.book = snap.book;
      return;
    }
    
    // Candle advanced: close previous
    if (snap.time > pendingSnapshot.time) {
      const closed = pendingSnapshot;
      pendingSnapshot = snap;
      handleClosedBarSnapshot(closed);
    }
  }
  
  function connectLive(symbol) {
    if (typeof orderBookWS !== "undefined" && orderBookWS && typeof orderBookWS.setSymbol === "function") {
      try {
        orderBookWS.setSymbol(symbol);
        orderBookWS.connect();
      } catch (_) {}
    }
    
    if (typeof wsManager === "undefined" || !wsManager || typeof wsManager.connect !== "function") {
      setStatus("wsManager not available. Ensure js/websocket.js is loaded.", true);
      return;
    }
    
    wsManager.connect(symbol, "1m", onPriceUpdate, onOhlcUpdate, (err) => {
      const msg = err && err.message ? err.message : "Unknown error";
      setStatus("Live error: " + msg, true);
      updateSystemStatus();
    });
  }
  
  // Keep status panel responsive to order book connection changes
  window.addEventListener("orderBookWSConnect", () => updateSystemStatus());
  window.addEventListener("orderBookWSDisconnect", () => updateSystemStatus());
  window.addEventListener("orderBookWSError", () => updateSystemStatus());

  // Aggregate 1m snapshots into higher timeframes
  function aggregateSnapshots(snapshots, targetTimeframe) {
    if (!snapshots || snapshots.length === 0) return [];
    if (targetTimeframe === "1m") return snapshots;
    
    // Timeframe to seconds
    const tfSeconds = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "1h": 3600,
    };
    
    const interval = tfSeconds[targetTimeframe] || 60;
    const aggregated = [];
    let currentBar = null;
    let currentBarTime = 0;
    
    for (const snap of snapshots) {
      const snapTime = snap.time;
      const barTime = Math.floor(snapTime / interval) * interval;
      
      if (barTime !== currentBarTime) {
        // Save previous bar
        if (currentBar) {
          aggregated.push(currentBar);
        }
        // Start new bar
        currentBar = {
          time: barTime,
          candle: {
            o: snap.candle.o,
            h: snap.candle.h,
            l: snap.candle.l,
            c: snap.candle.c,
            v: snap.candle.v || 0,
          },
          book: snap.book, // Use last book snapshot for the bar
        };
        currentBarTime = barTime;
      } else if (currentBar) {
        // Update current bar
        currentBar.candle.h = Math.max(currentBar.candle.h, snap.candle.h);
        currentBar.candle.l = Math.min(currentBar.candle.l, snap.candle.l);
        currentBar.candle.c = snap.candle.c;
        currentBar.candle.v = (currentBar.candle.v || 0) + (snap.candle.v || 0);
        currentBar.book = snap.book; // Use the latest book for this bar
      }
    }
    
    // Don't forget the last bar
    if (currentBar) {
      aggregated.push(currentBar);
    }
    
    console.log(`[Aggregation] ${snapshots.length} x 1m bars → ${aggregated.length} x ${targetTimeframe} bars`);
    return aggregated;
  }

  async function loadSnapshots(session, symbol, timeframe) {
    // Use the timeframe from the selector (default to 1m)
    const tf = timeframe || (timeframeSelect ? timeframeSelect.value : "1m");
    
    // Always load 1m data and aggregate client-side for higher timeframes
    // This ensures we always get live data regardless of timeframe
    const url = `/api/replay/stream?kind=snapshots&session=${session}&symbol=${symbol}&timeframe=1m`;
    const res = await fetch(url);
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" }));
      if (err.hint) {
        throw new Error(`${err.error}\n\n${err.hint}`);
      }
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  }

  // ─────────────────────────────────────────────────────────────
  // Metrics Computation (Client-Side)
  // ─────────────────────────────────────────────────────────────
  function computeMetrics(book, candle, settings) {
    const { clusterPct, priceRangePct, alphaSensMM, alphaSensSwing, alphaSensHTF, alphaMode } = settings;
    const price = candle.c;

    if (!book || !book.bids || !book.asks || book.bids.length === 0 || book.asks.length === 0) {
      return null;
    }

    const bids = book.bids.map(([p, s]) => ({ price: p, size: s }));
    const asks = book.asks.map(([p, s]) => ({ price: p, size: s }));

    const bestBid = bids[0]?.price || price;
    const bestAsk = asks[0]?.price || price;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    const minPrice = price * (1 - priceRangePct / 100);
    const maxPrice = price * (1 + priceRangePct / 100);

    const filteredBids = bids.filter((l) => l.price >= minPrice && l.price < price);
    const filteredAsks = asks.filter((l) => l.price <= maxPrice && l.price > price);

    const clusterSize = price * clusterPct;
    const levels = [];

    function clusterLevels(arr, side) {
      const clustered = new Map();
      for (const lvl of arr) {
        const bucket = Math.round(lvl.price / clusterSize) * clusterSize;
        if (!clustered.has(bucket)) {
          clustered.set(bucket, { price: bucket, volume: 0, count: 0 });
        }
        const c = clustered.get(bucket);
        c.volume += lvl.size;
        c.count += 1;
      }
      return Array.from(clustered.values()).map((c) => ({ ...c, side }));
    }

    levels.push(...clusterLevels(filteredBids, "bid"));
    levels.push(...clusterLevels(filteredAsks, "ask"));

    let bidTotal = 0, askTotal = 0;
    for (const lvl of levels) {
      if (lvl.side === "bid") bidTotal += lvl.volume;
      else askTotal += lvl.volume;
    }
    const bpr = askTotal > 0 ? bidTotal / askTotal : (bidTotal > 0 ? 10 : 1);

    const ldDelta = bidTotal - askTotal;
    const ldTotal = bidTotal + askTotal;
    const ldPct = ldTotal > 0 ? (ldDelta / ldTotal) * 100 : 0;

    const nearThreshold = price * 0.01;
    let nearBid = 0, nearAsk = 0, farBid = 0, farAsk = 0;
    for (const lvl of levels) {
      const dist = Math.abs(lvl.price - price);
      if (lvl.side === "bid") {
        if (dist <= nearThreshold) nearBid += lvl.volume;
        else farBid += lvl.volume;
      } else {
        if (dist <= nearThreshold) nearAsk += lvl.volume;
        else farAsk += lvl.volume;
      }
    }
    const ldNearDelta = nearBid - nearAsk;
    const ldFarDelta = farBid - farAsk;

    let vwmpNum = 0, vwmpDen = 0;
    for (const lvl of [...filteredBids, ...filteredAsks]) {
      vwmpNum += lvl.price * lvl.size;
      vwmpDen += lvl.size;
    }
    const vwmp = vwmpDen > 0 ? vwmpNum / vwmpDen : mid;

    let bidWeighted = 0, askWeighted = 0, bidVolSum = 0, askVolSum = 0;
    for (const lvl of filteredBids) {
      bidWeighted += lvl.price * lvl.size;
      bidVolSum += lvl.size;
    }
    for (const lvl of filteredAsks) {
      askWeighted += lvl.price * lvl.size;
      askVolSum += lvl.size;
    }
    const bidAvg = bidVolSum > 0 ? bidWeighted / bidVolSum : price;
    const askAvg = askVolSum > 0 ? askWeighted / askVolSum : price;
    const totalVol = bidVolSum + askVolSum;
    const ifv = totalVol > 0 ? (bidAvg * bidVolSum + askAvg * askVolSum) / totalVol : mid;

    let depthBid = 0, depthAsk = 0;
    for (const b of bids) depthBid += b.size;
    for (const a of asks) depthAsk += a.size;
    const depthTotal = depthBid + depthAsk;
    const depthImbalancePct = depthTotal > 0 ? ((depthBid - depthAsk) / depthTotal) * 100 : 0;

    // Calculate ALL THREE alpha scores with individual sensitivities
    // Each uses DIFFERENT inputs to produce distinct signals:
    const mmMult = alphaSensMM / 50;
    const swingMult = alphaSensSwing / 50;
    const htfMult = alphaSensHTF / 50;
    
    // Alpha MM: Uses NEAR PRESSURE (within 1%) - fastest reaction to immediate book changes
    const nearPressurePct = (nearBid + nearAsk) > 0 ? ((nearBid - nearAsk) / (nearBid + nearAsk)) * 100 : 0;
    const alphaMM = Math.max(0, Math.min(100, 50 + (nearPressurePct * mmMult * 0.8)));
    
    // Alpha Swing: Uses LD% (total liquidity delta) - medium-term signal
    const alphaSwing = Math.max(0, Math.min(100, 50 + (ldPct * swingMult * 0.6)));
    
    // Alpha HTF: Uses DEPTH IMBALANCE (full book) - structural/positional view
    const alphaHTF = Math.max(0, Math.min(100, 50 + (depthImbalancePct * htfMult * 0.5)));
    
    // Selected alpha based on mode
    let alpha;
    if (alphaMode === "marketMaker") {
      alpha = alphaMM;
    } else if (alphaMode === "swingTrader") {
      alpha = alphaSwing;
    } else {
      alpha = alphaHTF;
    }
    
    // Regime signals
    const ldStrength = Math.abs(ldPct);
    const regime = ldPct > 5 ? "accumulation" : ldPct < -5 ? "distribution" : "neutral";
    const regimeScore = ldPct; // -100 to +100 range
    
    // Pressure zones
    const nearPressure = ldNearDelta;
    const farPressure = ldFarDelta;
    const pressureImbalance = nearBid + nearAsk > 0 ? ((nearBid - nearAsk) / (nearBid + nearAsk)) * 100 : 0;

    const vsMidPct = mid ? ((price - mid) / mid) * 100 : 0;
    const vsVwmpPct = vwmp ? ((price - vwmp) / vwmp) * 100 : 0;
    const vsIfvPct = ifv ? ((price - ifv) / ifv) * 100 : 0;

    const mmBias = -vsVwmpPct * 10;
    const swingBias = ldPct * 0.5;
    const htfBias = -vsIfvPct * 5;
    const mcs = (mmBias + swingBias + htfBias) / 3;
    
    // ─── PREDICTIVE SIGNALS ───
    // Next Regime Probability: Probability of transitioning to bullish (accumulation) regime
    // Combines multiple order book signals to predict near-term direction
    // 50 = neutral, >50 = bullish probability, <50 = bearish probability
    
    // Signal 1: Near pressure momentum (near stronger than far = building momentum)
    const nearFarRatio = (nearBid + nearAsk) > 0 && (farBid + farAsk) > 0 
      ? (nearBid - nearAsk) / (nearBid + nearAsk) - (farBid - farAsk) / (farBid + farAsk)
      : 0;
    const momentumSignal = nearFarRatio * 25; // -25 to +25 contribution
    
    // Signal 2: BPR signal (normalized)
    const bprSignal = Math.max(-20, Math.min(20, (bpr - 1) * 20)); // -20 to +20
    
    // Signal 3: Price vs fair value (below = bullish potential)
    const fairValueSignal = -vsVwmpPct * 5; // -15 to +15 typical range
    
    // Signal 4: Spread metrics
    const spreadPct = mid > 0 ? (spread / mid) * 100 : 0;
    const spreadSignal = spreadPct < 0.05 ? 5 : spreadPct > 0.2 ? -5 : 0;
    
    // Combine signals (base 50 for neutral)
    const nextRegimeProb = Math.max(0, Math.min(100, 
      50 + momentumSignal + bprSignal + fairValueSignal + spreadSignal
    ));
    
    // ─── ADDITIONAL METRICS FOR ENTRY SIGNALS ───
    // Spread as percentage of mid price (tighter = more consensus)
    const spreadBps = spreadPct * 100; // in basis points
    
    // Fair value divergences (price vs fair value indicators)
    const ifvDivPct = ifv > 0 ? ((price - ifv) / ifv) * 100 : 0;  // + = above IFV, - = below IFV
    const vwmpDivPct = vwmp > 0 ? ((price - vwmp) / vwmp) * 100 : 0;
    
    // Liquidity vacuum detection (thin side ratios)
    const nearTotal = nearBid + nearAsk;
    const askThinRatio = nearTotal > 0 ? nearAsk / nearTotal : 0.5; // <0.3 = asks thin = bullish
    const bidThinRatio = nearTotal > 0 ? nearBid / nearTotal : 0.5; // <0.3 = bids thin = bearish
    
    // Near pressure imbalance as percentage (-100 to +100)
    const nearPressureImbalance = nearTotal > 0 ? ((nearBid - nearAsk) / nearTotal) * 100 : 0;

    // ═══════════════════════════════════════════════════════════════
    // LEVEL-BASED METRICS - Using actual order book price levels
    // (bestBid, bestAsk already defined above)
    // ═══════════════════════════════════════════════════════════════
    
    // Distance from price to best levels (as % of price)
    const priceToBidPct = ((price - bestBid) / price) * 100;  // + = above bid, - = below bid
    const priceToAskPct = ((bestAsk - price) / price) * 100;  // + = below ask, - = above ask
    
    // Level proximity signals (is price near support/resistance?)
    const atBidSupport = priceToBidPct < 0.02;  // Within 0.02% of best bid
    const atAskResistance = priceToAskPct < 0.02;  // Within 0.02% of best ask
    
    // Calculate level strength (sum of top N level volumes)
    const topN = 5;
    let bidLevelStrength = 0, askLevelStrength = 0;
    for (let i = 0; i < Math.min(topN, bids.length); i++) bidLevelStrength += bids[i].size;
    for (let i = 0; i < Math.min(topN, asks.length); i++) askLevelStrength += asks[i].size;
    
    // Level imbalance at top levels (who has more stacked?)
    const levelImbalanceRaw = bidLevelStrength - askLevelStrength;
    const levelImbalanceTotal = bidLevelStrength + askLevelStrength;
    const levelImbalancePct = levelImbalanceTotal > 0 ? (levelImbalanceRaw / levelImbalanceTotal) * 100 : 0;
    
    // ═══════════════════════════════════════════════════════════════
    // WALL DETECTION - Find the STRONGEST walls within range
    // ═══════════════════════════════════════════════════════════════
    const wallSearchRange = 0.005; // 0.5% range to search for walls
    const minWallMultiple = 1.8; // Must be 1.8x average to be a "wall"
    
    // Calculate average sizes for comparison
    const allBidSizes = bids.slice(0, 20).map(b => b.size);
    const allAskSizes = asks.slice(0, 20).map(a => a.size);
    const avgBidSize = allBidSizes.length > 0 ? allBidSizes.reduce((a,b) => a+b, 0) / allBidSizes.length : 1;
    const avgAskSize = allAskSizes.length > 0 ? allAskSizes.reduce((a,b) => a+b, 0) / allAskSizes.length : 1;
    
    // Find strongest bid wall within range
    let strongestBidWall = { price: 0, size: 0, multiple: 0, distancePct: 999 };
    for (const bid of bids) {
      const distPct = (price - bid.price) / price;
      if (distPct > 0 && distPct < wallSearchRange) {
        const multiple = bid.size / avgBidSize;
        if (multiple > strongestBidWall.multiple && multiple >= minWallMultiple) {
          strongestBidWall = { price: bid.price, size: bid.size, multiple, distancePct: distPct * 100 };
        }
      }
    }
    
    // Find strongest ask wall within range
    let strongestAskWall = { price: 0, size: 0, multiple: 0, distancePct: 999 };
    for (const ask of asks) {
      const distPct = (ask.price - price) / price;
      if (distPct > 0 && distPct < wallSearchRange) {
        const multiple = ask.size / avgAskSize;
        if (multiple > strongestAskWall.multiple && multiple >= minWallMultiple) {
          strongestAskWall = { price: ask.price, size: ask.size, multiple, distancePct: distPct * 100 };
        }
      }
    }
    
    // Wall metrics
    const bidWallPrice = strongestBidWall.price;
    const bidWallSize = strongestBidWall.size;
    const bidWallMultiple = strongestBidWall.multiple;
    const bidWallDistPct = strongestBidWall.distancePct;
    const hasBidWall = bidWallMultiple >= minWallMultiple;
    
    const askWallPrice = strongestAskWall.price;
    const askWallSize = strongestAskWall.size;
    const askWallMultiple = strongestAskWall.multiple;
    const askWallDistPct = strongestAskWall.distancePct;
    const hasAskWall = askWallMultiple >= minWallMultiple;
    
    // Level gap detection (vacuum between levels)
    let bidLevelGap = 0, askLevelGap = 0;
    if (bids.length >= 2) bidLevelGap = ((bids[0].price - bids[1].price) / bids[0].price) * 10000; // in bps
    if (asks.length >= 2) askLevelGap = ((asks[1].price - asks[0].price) / asks[0].price) * 10000; // in bps
    const bidVacuum = bidLevelGap > 5;  // >5 bps gap = vacuum below
    const askVacuum = askLevelGap > 5;  // >5 bps gap = vacuum above
    
    // ═══════════════════════════════════════════════════════════════
    // WALL PROXIMITY SIGNALS - Price approaching wall = expect bounce
    // ═══════════════════════════════════════════════════════════════
    // Wall proximity score: 0-100 (higher = closer to wall)
    // If price is near a bid wall = expect bounce UP (bullish)
    // If price is near an ask wall = expect bounce DOWN (bearish)
    
    let bidWallProximity = 0;
    let askWallProximity = 0;
    
    if (hasBidWall && bidWallDistPct < 0.3) {
      // Very close to bid wall - strong support signal
      bidWallProximity = Math.round(100 - (bidWallDistPct / 0.3 * 50));
      // Bonus for wall strength
      bidWallProximity += Math.min(30, Math.round((bidWallMultiple - 1.8) * 15));
      bidWallProximity = Math.min(100, bidWallProximity);
    } else if (hasBidWall && bidWallDistPct < 0.5) {
      // Approaching bid wall
      bidWallProximity = Math.round(50 - (bidWallDistPct - 0.3) / 0.2 * 30);
    }
    
    if (hasAskWall && askWallDistPct < 0.3) {
      // Very close to ask wall - strong resistance signal
      askWallProximity = Math.round(100 - (askWallDistPct / 0.3 * 50));
      // Bonus for wall strength
      askWallProximity += Math.min(30, Math.round((askWallMultiple - 1.8) * 15));
      askWallProximity = Math.min(100, askWallProximity);
    } else if (hasAskWall && askWallDistPct < 0.5) {
      // Approaching ask wall
      askWallProximity = Math.round(50 - (askWallDistPct - 0.3) / 0.2 * 30);
    }
    
    // Level support/resistance score (0-100)
    // High score = strong level support/resistance
    let bidSupportScore = 0;
    let askResistanceScore = 0;
    
    // Major points for wall proximity (up to 50 points)
    bidSupportScore += Math.round(bidWallProximity * 0.5);
    askResistanceScore += Math.round(askWallProximity * 0.5);
    
    // Points for being near the best level
    if (priceToBidPct < 0.05) bidSupportScore += 20;
    else if (priceToBidPct < 0.1) bidSupportScore += 10;
    
    if (priceToAskPct < 0.05) askResistanceScore += 20;
    else if (priceToAskPct < 0.1) askResistanceScore += 10;
    
    // Points for stacked levels (strength)
    if (levelImbalancePct > 30) bidSupportScore += 15;
    else if (levelImbalancePct > 15) bidSupportScore += 8;
    
    if (levelImbalancePct < -30) askResistanceScore += 15;
    else if (levelImbalancePct < -15) askResistanceScore += 8;
    
    // Points for tight spread (consensus at these levels)
    if (spreadPct < 0.02) {
      bidSupportScore += 15;
      askResistanceScore += 15;
    } else if (spreadPct < 0.05) {
      bidSupportScore += 8;
      askResistanceScore += 8;
    }
    
    // Deduct for vacuum (easier to break through)
    if (bidVacuum) bidSupportScore -= 10;
    if (askVacuum) askResistanceScore -= 10;
    
    bidSupportScore = Math.max(0, Math.min(100, bidSupportScore));
    askResistanceScore = Math.max(0, Math.min(100, askResistanceScore));

    return {
      mid: round(mid, 2), vwmp: round(vwmp, 2), ifv: round(ifv, 2), spread: round(spread, 4),
      bpr: round(bpr, 3), ldDelta: round(ldDelta, 2), ldPct: round(ldPct, 2),
      ldNearDelta: round(ldNearDelta, 2), ldFarDelta: round(ldFarDelta, 2),
      depthBid: round(depthBid, 2), depthAsk: round(depthAsk, 2), depthImbalancePct: round(depthImbalancePct, 2),
      // All 3 Alpha scores
      alpha: round(alpha, 1),
      alphaMM: round(alphaMM, 1),
      alphaSwing: round(alphaSwing, 1),
      alphaHTF: round(alphaHTF, 1),
      // Market Consensus
      mcs: round(mcs, 2),
      mmBias: round(mmBias, 2), swingBias: round(swingBias, 2), htfBias: round(htfBias, 2),
      // Regime Engine
      regime,
      regimeScore: round(regimeScore, 2),
      ldStrength: round(ldStrength, 2),
      nearPressure: round(nearPressure, 2),
      farPressure: round(farPressure, 2),
      pressureImbalance: round(pressureImbalance, 2),
      // Predictive Signals
      nextRegimeProb: round(nextRegimeProb, 1),
      // Price deviations
      vsMidPct: round(vsMidPct, 3), vsVwmpPct: round(vsVwmpPct, 3), vsIfvPct: round(vsIfvPct, 3),
      // Entry Signal Components
      spreadPct: round(spreadPct, 4),
      spreadBps: round(spreadBps, 2),
      ifvDivPct: round(ifvDivPct, 4),
      vwmpDivPct: round(vwmpDivPct, 4),
      askThinRatio: round(askThinRatio, 3),
      bidThinRatio: round(bidThinRatio, 3),
      // Wall Detection Metrics (NEW)
      bidWallPrice: round(bidWallPrice, 2),
      bidWallSize: round(bidWallSize, 4),
      bidWallMultiple: round(bidWallMultiple, 2),
      bidWallDistPct: round(bidWallDistPct, 3),
      hasBidWall,
      askWallPrice: round(askWallPrice, 2),
      askWallSize: round(askWallSize, 4),
      askWallMultiple: round(askWallMultiple, 2),
      askWallDistPct: round(askWallDistPct, 3),
      hasAskWall,
      bidWallProximity: round(bidWallProximity, 0),
      askWallProximity: round(askWallProximity, 0),
      nearPressureImbalance: round(nearPressureImbalance, 2),
      nearBid: round(nearBid, 2),
      nearAsk: round(nearAsk, 2),
      // ─── LEVEL-BASED METRICS ───
      bestBid: round(bestBid, 2),
      bestAsk: round(bestAsk, 2),
      priceToBidPct: round(priceToBidPct, 4),
      priceToAskPct: round(priceToAskPct, 4),
      atBidSupport,
      atAskResistance,
      bidLevelStrength: round(bidLevelStrength, 2),
      askLevelStrength: round(askLevelStrength, 2),
      levelImbalancePct: round(levelImbalancePct, 2),
      bidWallMultiple: round(bidWallMultiple, 2),
      askWallMultiple: round(askWallMultiple, 2),
      hasBidWall,
      hasAskWall,
      bidLevelGap: round(bidLevelGap, 2),
      askLevelGap: round(askLevelGap, 2),
      bidVacuum,
      askVacuum,
      bidSupportScore: round(bidSupportScore, 0),
      askResistanceScore: round(askResistanceScore, 0),
    };
  }

  function round(v, decimals) {
    const m = Math.pow(10, decimals);
    return Math.round(v * m) / m;
  }

  function computeAllMetrics() {
    const settings = getSettings();
    let prevMetrics = null;
    let prevSpreadPct = null;
    
    const results = snapshots.map((snap, idx) => {
      const candle = { o: snap.candle.o, h: snap.candle.h, l: snap.candle.l, c: snap.candle.c, v: snap.candle.v };
      const metrics = computeMetrics(snap.book, candle, settings);
      
      if (!metrics) {
        prevMetrics = null;
        prevSpreadPct = null;
        return { time: snap.time, candle: { open: candle.o, high: candle.h, low: candle.l, close: candle.c, volume: candle.v }, metrics: null };
      }
      
      // ─── DELTA METRICS (bar-over-bar changes) ───
      let ldDeltaChange = 0, bprDelta = 0, nearPressureDeltaChange = 0, spreadDeltaChange = 0;
      let ldMomentum = "flat"; // "rising", "falling", "flat"
      let spreadState = "normal"; // "tight", "normal", "wide"
      let spreadDirection = "stable"; // "tightening", "stable", "widening"
      
      if (prevMetrics) {
        ldDeltaChange = metrics.ldPct - prevMetrics.ldPct;
        bprDelta = metrics.bpr - prevMetrics.bpr;
        nearPressureDeltaChange = metrics.nearPressureImbalance - prevMetrics.nearPressureImbalance;
        
        // LD Momentum
        if (ldDeltaChange > 2) ldMomentum = "rising";
        else if (ldDeltaChange < -2) ldMomentum = "falling";
        
        // Spread delta
        if (prevSpreadPct !== null) {
          spreadDeltaChange = metrics.spreadPct - prevSpreadPct;
          if (spreadDeltaChange < -0.001) spreadDirection = "tightening";
          else if (spreadDeltaChange > 0.001) spreadDirection = "widening";
        }
      }
      
      // Spread state classification
      if (metrics.spreadPct < 0.02) spreadState = "tight";  // <2 bps
      else if (metrics.spreadPct > 0.08) spreadState = "wide"; // >8 bps
      
      // Store for next iteration
      prevMetrics = metrics;
      prevSpreadPct = metrics.spreadPct;
      
      // ─── CERTAINTY SCORE CALCULATION ───
      // Each component adds points when conditions are met. 80+ = definitive signal.
      let longCertainty = 0;
      let shortCertainty = 0;
      
      // ═══════════════════════════════════════════════════════════════
      // WALL PROXIMITY SIGNALS (HIGHEST PRIORITY - up to 40 points)
      // When price approaches a wall, expect bounce!
      // ═══════════════════════════════════════════════════════════════
      
      // Component WALL-A: Bid Wall Proximity (up to 40 points for LONG)
      // Price near a bid wall = expect bounce UP
      if (metrics.bidWallProximity >= 80) longCertainty += 40;
      else if (metrics.bidWallProximity >= 60) longCertainty += 30;
      else if (metrics.bidWallProximity >= 40) longCertainty += 20;
      else if (metrics.bidWallProximity >= 20) longCertainty += 10;
      
      // Component WALL-B: Ask Wall Proximity (up to 40 points for SHORT)
      // Price near an ask wall = expect bounce DOWN
      if (metrics.askWallProximity >= 80) shortCertainty += 40;
      else if (metrics.askWallProximity >= 60) shortCertainty += 30;
      else if (metrics.askWallProximity >= 40) shortCertainty += 20;
      else if (metrics.askWallProximity >= 20) shortCertainty += 10;
      
      // ═══════════════════════════════════════════════════════════════
      // LEVEL-BASED SIGNALS (High priority, up to 25 points)
      // ═══════════════════════════════════════════════════════════════
      
      // Component 0a: Bid Support Score (up to 20 points for LONG)
      // Strong bid levels below price = support = bullish
      if (metrics.bidSupportScore >= 70) longCertainty += 20;
      else if (metrics.bidSupportScore >= 50) longCertainty += 15;
      else if (metrics.bidSupportScore >= 30) longCertainty += 8;
      
      // Component 0b: Ask Resistance Score (up to 20 points for SHORT)
      // Strong ask levels above price = resistance = bearish
      if (metrics.askResistanceScore >= 70) shortCertainty += 20;
      else if (metrics.askResistanceScore >= 50) shortCertainty += 15;
      else if (metrics.askResistanceScore >= 30) shortCertainty += 8;
      
      // Component 0c: Level Imbalance (up to 12 points)
      // More bid levels stacked = support, more ask levels = resistance
      if (metrics.levelImbalancePct > 30) longCertainty += 12;
      else if (metrics.levelImbalancePct > 15) longCertainty += 6;
      
      if (metrics.levelImbalancePct < -30) shortCertainty += 12;
      else if (metrics.levelImbalancePct < -15) shortCertainty += 6;
      
      // Component 0d: Vacuum Detection (up to 10 points)
      // Vacuum above = easy upward movement = bullish
      // Vacuum below = easy downward movement = bearish
      if (metrics.askVacuum && !metrics.bidVacuum) longCertainty += 10;
      if (metrics.bidVacuum && !metrics.askVacuum) shortCertainty += 10;
      
      // ═══════════════════════════════════════════════════════════════
      // FLOW-BASED SIGNALS (Original components, reduced weight)
      // ═══════════════════════════════════════════════════════════════
      
      // Component 1: Near Pressure Imbalance (±15 points, reduced from 20)
      if (metrics.nearPressureImbalance > 40) longCertainty += 15;
      else if (metrics.nearPressureImbalance > 25) longCertainty += 10;
      else if (metrics.nearPressureImbalance > 10) longCertainty += 5;
      
      if (metrics.nearPressureImbalance < -40) shortCertainty += 15;
      else if (metrics.nearPressureImbalance < -25) shortCertainty += 10;
      else if (metrics.nearPressureImbalance < -10) shortCertainty += 5;
      
      // Component 2: Depth Imbalance (±15 points, reduced from 20)
      if (metrics.depthImbalancePct > 40) longCertainty += 15;
      else if (metrics.depthImbalancePct > 25) longCertainty += 10;
      else if (metrics.depthImbalancePct > 10) longCertainty += 5;
      
      if (metrics.depthImbalancePct < -40) shortCertainty += 15;
      else if (metrics.depthImbalancePct < -25) shortCertainty += 10;
      else if (metrics.depthImbalancePct < -10) shortCertainty += 5;
      
      // Component 3: BPR (±12 points, reduced from 15)
      if (metrics.bpr > 2.0) longCertainty += 12;
      else if (metrics.bpr > 1.5) longCertainty += 8;
      else if (metrics.bpr > 1.2) longCertainty += 4;
      
      if (metrics.bpr < 0.5) shortCertainty += 12;
      else if (metrics.bpr < 0.67) shortCertainty += 8;
      else if (metrics.bpr < 0.83) shortCertainty += 4;
      
      // Component 4: LD% (±12 points, reduced from 15)
      if (metrics.ldPct > 40) longCertainty += 12;
      else if (metrics.ldPct > 25) longCertainty += 8;
      else if (metrics.ldPct > 10) longCertainty += 4;
      
      if (metrics.ldPct < -40) shortCertainty += 12;
      else if (metrics.ldPct < -25) shortCertainty += 8;
      else if (metrics.ldPct < -10) shortCertainty += 4;
      
      // Component 5: Price vs IFV (±8 points, reduced from 10)
      if (metrics.ifvDivPct < -0.02) longCertainty += 8;
      else if (metrics.ifvDivPct < -0.01) longCertainty += 4;
      
      if (metrics.ifvDivPct > 0.02) shortCertainty += 8;
      else if (metrics.ifvDivPct > 0.01) shortCertainty += 4;
      
      // Component 6: Price vs VWMP (±8 points, reduced from 10)
      if (metrics.vwmpDivPct < -0.02) longCertainty += 8;
      else if (metrics.vwmpDivPct < -0.01) longCertainty += 4;
      
      if (metrics.vwmpDivPct > 0.02) shortCertainty += 8;
      else if (metrics.vwmpDivPct > 0.01) shortCertainty += 4;
      
      // Component 7: LD Momentum (±8 points, reduced from 10)
      if (ldMomentum === "rising") longCertainty += 8;
      else if (ldDeltaChange > 1) longCertainty += 4;
      
      if (ldMomentum === "falling") shortCertainty += 8;
      else if (ldDeltaChange < -1) shortCertainty += 4;
      
      // Component 8: Spread State (±8 points bonus for tight/tightening)
      if (spreadState === "tight" || spreadDirection === "tightening") {
        if (longCertainty > shortCertainty) longCertainty += 8;
        else if (shortCertainty > longCertainty) shortCertainty += 8;
      }
      if (spreadState === "wide" || spreadDirection === "widening") {
        longCertainty = Math.max(0, longCertainty - 5);
        shortCertainty = Math.max(0, shortCertainty - 5);
      }
      
      // Cap at 100
      longCertainty = Math.min(100, longCertainty);
      shortCertainty = Math.min(100, shortCertainty);
      
      // ─── ENTRY SIGNAL DETERMINATION ───
      // Only signal when one side has overwhelming certainty AND the other is low
      let entrySignal = "WAIT";
      if (longCertainty >= 80 && shortCertainty < 30) {
        entrySignal = "LONG";
      } else if (shortCertainty >= 80 && longCertainty < 30) {
        entrySignal = "SHORT";
      }
      
      // Add enhanced metrics to result
      const enhancedMetrics = {
        ...metrics,
        // Delta metrics
        ldDeltaChange: round(ldDeltaChange, 2),
        bprDelta: round(bprDelta, 3),
        nearPressureDeltaChange: round(nearPressureDeltaChange, 2),
        spreadDeltaChange: round(spreadDeltaChange, 5),
        ldMomentum,
        spreadState,
        spreadDirection,
        // Entry signals
        longCertainty: round(longCertainty, 0),
        shortCertainty: round(shortCertainty, 0),
        entrySignal,
      };
      
      return {
        time: snap.time,
        candle: { open: candle.o, high: candle.h, low: candle.l, close: candle.c, volume: candle.v },
        metrics: enhancedMetrics,
      };
    });
    
    return results;
  }

  // ─────────────────────────────────────────────────────────────
  // Chart Rendering
  // ─────────────────────────────────────────────────────────────
  function clearChartElements() {
    // Only clear visual chart elements, not data
    charts.forEach((c) => c.chart.remove());
    charts = [];
    chartsContainer.innerHTML = "";
  }
  
  function clearCharts() {
    clearChartElements();
    // Reset snapshot state for new load
    snapshots = [];
    rawSnapshots = [];
    snapshotTimeSet = new Set();
    pendingSnapshot = null;
    lastBarTime = 0;
  }

  // Time formatter for chart axis - shows HH:MM for intraday
  function formatTimeAxis(time) {
    const date = new Date(time * 1000);
    const hours = date.getHours().toString().padStart(2, "0");
    const mins = date.getMinutes().toString().padStart(2, "0");
    return `${hours}:${mins}`;
  }

  // Common timeScale configuration with time display
  const timeScaleConfig = {
    borderColor: "rgba(30,41,59,0.9)",
    barSpacing: 8,
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (time) => formatTimeAxis(time),
  };

  // Standard chart with histogram metric in lower pane
  function createDualPaneChart(container, candleData, metricData, colorFn) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.02, bottom: 0.45 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.60, bottom: 0.02 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    
    // Validate candle data
    const validCandleData = candleData.filter((c) => 
      c.time && c.time > 0 && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
    );
    if (validCandleData.length > 0) {
      try {
        barSeries.setData(validCandleData);
      } catch (e) {
        console.warn("[DualPaneChart] Error setting bar data:", e.message);
      }
    }

    const metricSeries = chart.addHistogramSeries({
      priceScaleId: "left", color: "rgba(148,163,184,0.6)", base: 0,
    });
    
    // Validate metric data
    const validMetricData = metricData
      .filter((d) => d.time && d.time > 0 && d.value !== null && d.value !== undefined && isFinite(d.value))
      .map((d) => ({ time: d.time, value: d.value, color: colorFn(d.value) }));
    if (validMetricData.length > 0) {
      try {
        metricSeries.setData(validMetricData);
      } catch (e) {
        console.warn("[DualPaneChart] Error setting metric data:", e.message);
      }
    }

    chart.timeScale().fitContent();
    return { chart, barSeries, metricSeries };
  }

  // Extract RGB from hex color
  function extractRGB(color) {
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return { r: 128, g: 128, b: 128 };
  }

  // ─────────────────────────────────────────────────────────────
  // Technical Indicator Helpers (for ZEMA and BB Pulse)
  // ─────────────────────────────────────────────────────────────
  function calcEMA(data, period) {
    if (data.length < period) return [];
    const mult = 2 / (period + 1);
    const result = [];
    let sum = 0;
    let validCount = 0;
    for (let i = 0; i < period; i++) {
      const val = data[i];
      if (val !== null && val !== undefined && isFinite(val)) {
        sum += val;
        validCount++;
      }
    }
    if (validCount === 0) return [];
    let ema = sum / validCount;
    result.push(ema);
    for (let i = period; i < data.length; i++) {
      const val = data[i];
      if (val !== null && val !== undefined && isFinite(val)) {
        ema = (val - ema) * mult + ema;
      }
      result.push(ema);
    }
    return result;
  }

  function calcZEMASeries(candles, period = 30) {
    if (candles.length < period * 2) return [];
    const closes = candles.map((c) => c.close);
    const ema1 = calcEMA(closes, period);
    if (ema1.length < period) return [];
    const ema2 = calcEMA(ema1, period);
    if (ema2.length === 0) return [];
    const result = [];
    for (let i = 0; i < ema2.length; i++) {
      const idx1 = i + (period - 1);
      if (idx1 < ema1.length) {
        const zema = (2 * ema1[idx1]) - ema2[i];
        const candleIdx = (period - 1) + idx1;
        if (candleIdx < candles.length) {
          result.push({ time: candles[candleIdx].time, value: zema });
        }
      }
    }
    return result;
  }

  function calcSMA(data, period) {
    if (data.length < period) return [];
    const result = [];
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      let validCount = 0;
      for (let j = 0; j < period; j++) {
        const val = data[i - j];
        if (val !== null && val !== undefined && isFinite(val)) {
          sum += val;
          validCount++;
        }
      }
      result.push(validCount > 0 ? sum / validCount : 0);
    }
    return result;
  }

  function calcStdev(data, period) {
    if (data.length < period) return [];
    const result = [];
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      let validCount = 0;
      const values = [];
      for (let j = 0; j < period; j++) {
        const val = data[i - j];
        if (val !== null && val !== undefined && isFinite(val)) {
          sum += val;
          validCount++;
          values.push(val);
        }
      }
      if (validCount === 0) {
        result.push(0);
        continue;
      }
      const mean = sum / validCount;
      let variance = 0;
      for (const v of values) variance += Math.pow(v - mean, 2);
      result.push(Math.sqrt(variance / validCount));
    }
    return result;
  }

  function calcHighest(data, period) {
    if (data.length < period) return [];
    const result = [];
    for (let i = period - 1; i < data.length; i++) {
      let max = -Infinity;
      for (let j = 0; j < period; j++) {
        const val = data[i - j];
        if (val !== null && val !== undefined && isFinite(val) && val > max) max = val;
      }
      result.push(isFinite(max) ? max : 0);
    }
    return result;
  }

  function calcLowest(data, period) {
    if (data.length < period) return [];
    const result = [];
    for (let i = period - 1; i < data.length; i++) {
      let min = Infinity;
      for (let j = 0; j < period; j++) {
        const val = data[i - j];
        if (val !== null && val !== undefined && isFinite(val) && val < min) min = val;
      }
      result.push(isFinite(min) ? min : 0);
    }
    return result;
  }

  function calcNormalize(data, period, top, bottom) {
    if (data.length < period) return [];
    const mins = calcLowest(data, period);
    const maxs = calcHighest(data, period);
    const result = [];
    for (let i = 0; i < mins.length; i++) {
      const min = mins[i];
      const max = maxs[i];
      const idx = i + period - 1;
      const val = data[idx];
      if (val === null || val === undefined || !isFinite(val) || !isFinite(min) || !isFinite(max)) {
        result.push((top + bottom) / 2); // Return midpoint for invalid data
        continue;
      }
      const range = (max - min) || 1e-10;
      const norm01 = (val - min) / range;
      result.push((norm01 * (top - bottom)) + bottom);
    }
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // Price + ZEMA Grid Chart (with BB Pulse signals)
  // ─────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────
  // Entry Signal History Chart (Price with LONG/SHORT arrows)
  // ─────────────────────────────────────────────────────────────
  function createSignalChart(container, records) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.1, bottom: 0.1 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.65, bottom: 0.02 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    
    // Price candles
    const candleData = records.map((r) => ({
      time: r.time, open: r.candle.open, high: r.candle.high, low: r.candle.low, close: r.candle.close,
    })).filter((c) => c.time && c.time > 0 && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
    
    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    if (candleData.length > 0) {
      try { barSeries.setData(candleData); } catch (e) { console.warn("[SignalChart] Error setting bars:", e.message); }
    }
    
    // Entry signal markers
    const markers = [];
    const longSignals = [];
    const shortSignals = [];
    
    for (const r of records) {
      if (!r.metrics) continue;
      const { entrySignal, longCertainty, shortCertainty } = r.metrics;
      
      // Track certainty for the lower histogram
      longSignals.push({ time: r.time, value: longCertainty, color: longCertainty >= 80 ? "rgba(16, 185, 129, 1)" : "rgba(16, 185, 129, 0.4)" });
      shortSignals.push({ time: r.time, value: -shortCertainty, color: shortCertainty >= 80 ? "rgba(239, 68, 68, 1)" : "rgba(239, 68, 68, 0.4)" });
      
      // Entry signal arrows on price
      if (entrySignal === "LONG") {
        markers.push({
          time: r.time,
          position: "belowBar",
          color: "#10b981",
          shape: "arrowUp",
          text: `LONG ${longCertainty}`,
          size: 2,
        });
      } else if (entrySignal === "SHORT") {
        markers.push({
          time: r.time,
          position: "aboveBar",
          color: "#ef4444",
          shape: "arrowDown",
          text: `SHORT ${shortCertainty}`,
          size: 2,
        });
      }
    }
    
    // Add markers to price series
    if (markers.length > 0) {
      try { barSeries.setMarkers(markers); } catch (e) { console.warn("[SignalChart] Error setting markers:", e.message); }
    }
    
    // Long certainty histogram (positive values)
    const longHist = chart.addHistogramSeries({
      priceScaleId: "left", color: "rgba(16, 185, 129, 0.5)", base: 0,
    });
    const validLong = longSignals.filter((d) => d.time && isFinite(d.value));
    if (validLong.length > 0) {
      try { longHist.setData(validLong); } catch (e) { console.warn("[SignalChart] Error setting long hist:", e.message); }
    }
    
    // Short certainty histogram (negative values)
    const shortHist = chart.addHistogramSeries({
      priceScaleId: "left", color: "rgba(239, 68, 68, 0.5)", base: 0,
    });
    const validShort = shortSignals.filter((d) => d.time && isFinite(d.value));
    if (validShort.length > 0) {
      try { shortHist.setData(validShort); } catch (e) { console.warn("[SignalChart] Error setting short hist:", e.message); }
    }
    
    // Add 80/-80 threshold lines
    const upperThreshold = chart.addLineSeries({
      priceScaleId: "left", color: "rgba(16, 185, 129, 0.5)", lineWidth: 1, lineStyle: 2, // Dashed
    });
    const lowerThreshold = chart.addLineSeries({
      priceScaleId: "left", color: "rgba(239, 68, 68, 0.5)", lineWidth: 1, lineStyle: 2,
    });
    const times = records.filter((r) => r.time).map((r) => r.time);
    if (times.length >= 2) {
      upperThreshold.setData([{ time: times[0], value: 80 }, { time: times[times.length - 1], value: 80 }]);
      lowerThreshold.setData([{ time: times[0], value: -80 }, { time: times[times.length - 1], value: -80 }]);
    }
    
    // Signal count summary
    const longCount = markers.filter((m) => m.shape === "arrowUp").length;
    const shortCount = markers.filter((m) => m.shape === "arrowDown").length;
    console.log(`[SignalChart] ${longCount} LONG signals, ${shortCount} SHORT signals out of ${records.length} bars`);
    
    return chart;
  }

  // ─────────────────────────────────────────────────────────────
  // Trading Performance Chart - Shows actual trades with P&L
  // ─────────────────────────────────────────────────────────────
  function createTradingPerformanceChart(container, records, statsContainer) {
    // Simulate trades based on entry signals
    const trades = [];
    let position = null; // { type: 'LONG'|'SHORT', entryTime, entryPrice, entryBar }
    let cumulativePnL = 0;
    const pnlHistory = [];
    
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.metrics) continue;
      
      const { entrySignal, longCertainty, shortCertainty } = r.metrics;
      const price = r.candle.close;
      const time = r.time;
      
      // Track cumulative PnL at each bar
      let unrealizedPnL = 0;
      if (position) {
        if (position.type === "LONG") {
          unrealizedPnL = ((price - position.entryPrice) / position.entryPrice) * 100;
        } else {
          unrealizedPnL = ((position.entryPrice - price) / position.entryPrice) * 100;
        }
      }
      pnlHistory.push({ time, value: cumulativePnL + unrealizedPnL });
      
      // Exit conditions: opposite signal OR certainty drops significantly
      if (position) {
        let shouldExit = false;
        let exitReason = "";
        
        if (position.type === "LONG") {
          if (entrySignal === "SHORT") {
            shouldExit = true;
            exitReason = "Opposite signal (SHORT)";
          } else if (longCertainty < 30) {
            shouldExit = true;
            exitReason = "Long certainty dropped <30";
          }
        } else { // SHORT position
          if (entrySignal === "LONG") {
            shouldExit = true;
            exitReason = "Opposite signal (LONG)";
          } else if (shortCertainty < 30) {
            shouldExit = true;
            exitReason = "Short certainty dropped <30";
          }
        }
        
        if (shouldExit) {
          const exitPrice = price;
          let pnl;
          if (position.type === "LONG") {
            pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          } else {
            pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          }
          
          cumulativePnL += pnl;
          
          trades.push({
            type: position.type,
            entryTime: position.entryTime,
            entryPrice: position.entryPrice,
            exitTime: time,
            exitPrice: exitPrice,
            pnl: pnl,
            cumulativePnL: cumulativePnL,
            exitReason: exitReason,
            bars: i - position.entryBar
          });
          
          position = null;
        }
      }
      
      // Entry conditions: certainty >= 80 and not in position
      if (!position && entrySignal !== "WAIT") {
        position = {
          type: entrySignal,
          entryTime: time,
          entryPrice: price,
          entryBar: i,
          entryCertainty: entrySignal === "LONG" ? longCertainty : shortCertainty
        };
      }
    }
    
    // Close any open position at end
    if (position && records.length > 0) {
      const lastRecord = records[records.length - 1];
      const exitPrice = lastRecord.candle.close;
      let pnl;
      if (position.type === "LONG") {
        pnl = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      } else {
        pnl = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
      }
      cumulativePnL += pnl;
      trades.push({
        type: position.type,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: lastRecord.time,
        exitPrice: exitPrice,
        pnl: pnl,
        cumulativePnL: cumulativePnL,
        exitReason: "End of data (still open)",
        bars: records.length - 1 - position.entryBar,
        stillOpen: true
      });
    }
    
    // Calculate stats
    const wins = trades.filter((t) => t.pnl > 0 && !t.stillOpen).length;
    const losses = trades.filter((t) => t.pnl <= 0 && !t.stillOpen).length;
    const closedTrades = trades.filter((t) => !t.stillOpen);
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : 0;
    const totalPnL = closedTrades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = wins > 0 ? trades.filter((t) => t.pnl > 0 && !t.stillOpen).reduce((sum, t) => sum + t.pnl, 0) / wins : 0;
    const avgLoss = losses > 0 ? trades.filter((t) => t.pnl <= 0 && !t.stillOpen).reduce((sum, t) => sum + t.pnl, 0) / losses : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : avgWin > 0 ? Infinity : 0;
    
    // Create chart
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.1, bottom: 0.35 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.70, bottom: 0.02 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });
    
    // Price bars
    const candleData = records.map((r) => ({
      time: r.time, open: r.candle.open, high: r.candle.high, low: r.candle.low, close: r.candle.close,
    })).filter((c) => c.time && c.time > 0 && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
    
    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    if (candleData.length > 0) {
      try { barSeries.setData(candleData); } catch (e) { console.warn("[TradingPerf] Error setting bars:", e.message); }
    }
    
    // Create markers for entries and exits
    const markers = [];
    for (const trade of trades) {
      // Entry marker
      markers.push({
        time: trade.entryTime,
        position: trade.type === "LONG" ? "belowBar" : "aboveBar",
        color: trade.type === "LONG" ? "#10b981" : "#ef4444",
        shape: trade.type === "LONG" ? "arrowUp" : "arrowDown",
        text: `${trade.type} @ $${trade.entryPrice.toFixed(0)}`,
        size: 2,
      });
      
      // Exit marker
      const exitColor = trade.pnl > 0 ? "#10b981" : "#ef4444";
      const pnlText = trade.pnl > 0 ? `+${trade.pnl.toFixed(2)}%` : `${trade.pnl.toFixed(2)}%`;
      markers.push({
        time: trade.exitTime,
        position: trade.type === "LONG" ? "aboveBar" : "belowBar",
        color: exitColor,
        shape: "circle",
        text: `EXIT ${pnlText}`,
        size: 1,
      });
    }
    
    if (markers.length > 0) {
      try { barSeries.setMarkers(markers); } catch (e) { console.warn("[TradingPerf] Error setting markers:", e.message); }
    }
    
    // Cumulative P&L line
    const pnlSeries = chart.addLineSeries({
      priceScaleId: "left",
      color: totalPnL >= 0 ? "#10b981" : "#ef4444",
      lineWidth: 2,
      crosshairMarkerVisible: true,
      lastValueVisible: true,
      priceLineVisible: true,
    });
    const validPnL = pnlHistory.filter((d) => d.time && isFinite(d.value));
    if (validPnL.length > 0) {
      try { pnlSeries.setData(validPnL); } catch (e) { console.warn("[TradingPerf] Error setting PnL data:", e.message); }
    }
    
    // Zero line for P&L
    const zeroLine = chart.addLineSeries({
      priceScaleId: "left",
      color: "rgba(148, 163, 184, 0.3)",
      lineWidth: 1,
      lineStyle: 2,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    if (validPnL.length >= 2) {
      zeroLine.setData([
        { time: validPnL[0].time, value: 0 },
        { time: validPnL[validPnL.length - 1].time, value: 0 }
      ]);
    }
    
    // Update stats container
    if (statsContainer) {
      const statsColor = totalPnL >= 0 ? "#10b981" : "#ef4444";
      statsContainer.innerHTML = `
        <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap:12px; padding:12px; background:rgba(30,41,59,0.3); border-radius:8px; margin-top:8px;">
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Total Trades</div>
            <div style="font-size:18px; font-weight:700; color:#e2e8f0;">${trades.length}</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Wins</div>
            <div style="font-size:18px; font-weight:700; color:#10b981;">${wins}</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Losses</div>
            <div style="font-size:18px; font-weight:700; color:#ef4444;">${losses}</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Win Rate</div>
            <div style="font-size:18px; font-weight:700; color:${parseFloat(winRate) >= 50 ? '#10b981' : '#ef4444'};">${winRate}%</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Total P&L</div>
            <div style="font-size:18px; font-weight:700; color:${statsColor};">${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}%</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px; color:#64748b; text-transform:uppercase;">Profit Factor</div>
            <div style="font-size:18px; font-weight:700; color:${profitFactor >= 1 ? '#10b981' : '#ef4444'};">${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</div>
          </div>
        </div>
        
        ${trades.length > 0 ? `
        <div style="margin-top:12px; max-height:200px; overflow-y:auto;">
          <table style="width:100%; font-size:11px; border-collapse:collapse;">
            <thead>
              <tr style="background:rgba(30,41,59,0.5); color:#94a3b8;">
                <th style="padding:6px; text-align:left;">#</th>
                <th style="padding:6px; text-align:left;">Type</th>
                <th style="padding:6px; text-align:right;">Entry</th>
                <th style="padding:6px; text-align:right;">Exit</th>
                <th style="padding:6px; text-align:right;">P&L</th>
                <th style="padding:6px; text-align:right;">Cumul.</th>
                <th style="padding:6px; text-align:center;">Bars</th>
                <th style="padding:6px; text-align:left;">Exit Reason</th>
              </tr>
            </thead>
            <tbody>
              ${trades.map((t, i) => `
                <tr style="border-bottom:1px solid rgba(30,41,59,0.5); ${t.stillOpen ? 'opacity:0.6;' : ''}">
                  <td style="padding:6px; color:#64748b;">${i + 1}</td>
                  <td style="padding:6px; color:${t.type === 'LONG' ? '#10b981' : '#ef4444'}; font-weight:600;">${t.type}</td>
                  <td style="padding:6px; text-align:right; color:#e2e8f0;">$${t.entryPrice.toFixed(2)}</td>
                  <td style="padding:6px; text-align:right; color:#e2e8f0;">$${t.exitPrice.toFixed(2)}</td>
                  <td style="padding:6px; text-align:right; color:${t.pnl > 0 ? '#10b981' : '#ef4444'}; font-weight:600;">${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}%</td>
                  <td style="padding:6px; text-align:right; color:${t.cumulativePnL > 0 ? '#10b981' : '#ef4444'};">${t.cumulativePnL > 0 ? '+' : ''}${t.cumulativePnL.toFixed(2)}%</td>
                  <td style="padding:6px; text-align:center; color:#94a3b8;">${t.bars}</td>
                  <td style="padding:6px; color:#64748b; font-size:10px;">${t.exitReason}${t.stillOpen ? ' ⏳' : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ` : '<div style="text-align:center; padding:20px; color:#64748b;">No trades yet - waiting for signals with certainty ≥80</div>'}
      `;
    }
    
    console.log(`[TradingPerf] ${trades.length} trades, ${wins}W/${losses}L, ${winRate}% WR, ${totalPnL.toFixed(2)}% P&L`);
    
    return { chart, barSeries, trades, stats: { wins, losses, winRate, totalPnL, profitFactor } };
  }

  function createPriceZemaChart(container, candleData, gridSpacing = 0.00008) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    
    // Validate candle data
    const validCandleData = candleData.filter((c) => 
      c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
    );
    if (validCandleData.length > 0) {
      try {
        barSeries.setData(validCandleData);
      } catch (e) {
        console.warn("[PriceZemaChart] Error setting bar data:", e.message);
      }
    }

    // Calculate ZEMA 30
    const zemaPeriod = 30;
    const zemaData = calcZEMASeries(candleData, zemaPeriod);
    const zemaColor = "#8b5cf6"; // Purple

    // Filter out null/NaN values and invalid times
    const validZemaData = zemaData.filter((d) => 
      d.time && d.time > 0 && d.value !== null && d.value !== undefined && isFinite(d.value)
    );
    
    if (validZemaData.length > 0) {
      try {
        const zemaSeries = chart.addLineSeries({
          priceScaleId: "right",
          color: zemaColor,
          lineWidth: 2,
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
          title: `ZEMA(${zemaPeriod})`,
        });
        zemaSeries.setData(validZemaData);

        // Draw grid lines
        const gridLines = [];
        const maxLines = 10;
        const baseColor = extractRGB(zemaColor);

        if (gridSpacing > 0) {
          for (let i = 1; i <= maxLines; i++) {
            const opacity = Math.max(0.1, 0.4 - (i * 0.03));
            const gridColor = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${opacity})`;

            const aboveData = validZemaData
              .filter((p) => p.time && p.time > 0 && isFinite(p.value))
              .map((p) => ({ time: p.time, value: p.value * (1 + gridSpacing * i) }));
            if (aboveData.length > 0) {
              const aboveSeries = chart.addLineSeries({
                priceScaleId: "right", color: gridColor, lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dotted,
                crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false,
              });
              aboveSeries.setData(aboveData);
              gridLines.push(aboveSeries);
            }

            const belowMult = 1 - gridSpacing * i;
            if (belowMult > 0) {
              const belowData = validZemaData
                .filter((p) => p.time && p.time > 0 && isFinite(p.value))
                .map((p) => ({ time: p.time, value: p.value * belowMult }));
              if (belowData.length > 0) {
                const belowSeries = chart.addLineSeries({
                  priceScaleId: "right", color: gridColor, lineWidth: 1,
                  lineStyle: LightweightCharts.LineStyle.Dotted,
                  crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false,
                });
                belowSeries.setData(belowData);
                gridLines.push(belowSeries);
              }
            }
          }

          // Calculate arrow signals for ZEMA grid
          const markers = [];
          const zemaByTime = new Map();
          for (const z of validZemaData) zemaByTime.set(z.time, z.value);

          for (const candle of validCandleData) {
            if (!candle.time || candle.time <= 0) continue;
            const zema = zemaByTime.get(candle.time);
            if (!zema) continue;
            const highestGrid = zema * (1 + maxLines * gridSpacing);
            const lowestGrid = zema * (1 - maxLines * gridSpacing);

            if (candle.high >= highestGrid) {
              markers.push({ time: candle.time, position: "aboveBar", color: zemaColor, shape: "arrowDown", text: "▼" });
            }
            if (candle.low <= lowestGrid) {
              markers.push({ time: candle.time, position: "belowBar", color: zemaColor, shape: "arrowUp", text: "▲" });
            }
          }
          if (markers.length > 0) barSeries.setMarkers(markers);
        }
      } catch (e) {
        console.warn("[PriceZemaChart] Error setting ZEMA data:", e.message);
      }
    }

    chart.timeScale().fitContent();
    return { chart, barSeries };
  }

  // ─────────────────────────────────────────────────────────────
  // BB Pulse Lighting Chart (works with price candles or metric series)
  // ─────────────────────────────────────────────────────────────
  function createBBPulseChart(container, candleData, lineColor = "#3b82f6", metricData = null) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: false, minimum: -0.5, maximum: 1.5 },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Filter out invalid data first
    const validCandleData = candleData.filter((c) => 
      c && c.time && c.time > 0 && isFinite(c.close) && isFinite(c.open) && isFinite(c.high) && isFinite(c.low)
    );
    
    // Use metric values if provided, otherwise use candle closes
    let inputData = [];
    if (metricData) {
      inputData = metricData.filter((d) => d && d.time && d.time > 0 && d.value !== null && d.value !== undefined && isFinite(d.value));
    } else {
      inputData = validCandleData.map((c) => ({ time: c.time, value: c.close }));
    }
    
    if (inputData.length < 40) { // Need at least period * 2 data points
      chart.timeScale().fitContent();
      return { chart };
    }
    
    const inputValues = inputData.map((d) => d.value);
    const inputTimes = inputData.map((d) => d.time);
    const period = 20;
    const mult = 1.5;
    const pulseNLen = 20;
    const pulseTop = 1.5;
    const pulseBottom = -0.5;

    if (inputValues.length < period * 2) {
      chart.timeScale().fitContent();
      return { chart };
    }

    // Calculate BB%B
    const basis = calcSMA(inputValues, period);
    const dev = calcStdev(inputValues, period);
    const bbr = [];
    for (let i = 0; i < basis.length; i++) {
      const upper = basis[i] + (mult * dev[i]);
      const lower = basis[i] - (mult * dev[i]);
      const val = inputValues[i + period - 1];
      const range = upper - lower;
      bbr.push(range > 0 ? (val - lower) / range : 0.5);
    }

    // Calculate BBW (inverted) for Pulse
    const bbw = [];
    for (let i = 0; i < basis.length; i++) {
      const upper = basis[i] + (2.0 * dev[i]);
      const lower = basis[i] - (2.0 * dev[i]);
      const width = ((upper - lower) / basis[i]) * 100;
      bbw.push(width * -1);
    }
    const pulse = calcNormalize(bbw, pulseNLen, pulseTop, pulseBottom);

    // Use inputTimes offset by period - filter out null/undefined
    const chartTimes = inputTimes.slice(period - 1).filter((t) => t !== null && t !== undefined);

    // Reference lines - only if we have valid times
    if (chartTimes.length === 0) {
      chart.timeScale().fitContent();
      return { chart };
    }
    
    try {
      // Filter to valid times only
      const validRefTimes = chartTimes.filter((t) => t !== null && t !== undefined && t > 0);
      if (validRefTimes.length > 0) {
        const line1 = chart.addLineSeries({ color: "rgba(239, 68, 68, 0.5)", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        line1.setData(validRefTimes.map((t) => ({ time: t, value: 1.0 })));

        const line05 = chart.addLineSeries({ color: "rgba(100, 116, 139, 0.5)", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        line05.setData(validRefTimes.map((t) => ({ time: t, value: 0.5 })));

        const line0 = chart.addLineSeries({ color: "rgba(16, 185, 129, 0.5)", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        line0.setData(validRefTimes.map((t) => ({ time: t, value: 0.0 })));
      }
    } catch (e) {
      console.warn("[BBPulseChart] Error setting reference lines:", e.message);
    }

    // BB%B line (use passed lineColor)
    let bbrSeries = null;
    try {
      bbrSeries = chart.addLineSeries({ color: lineColor, lineWidth: 2, crosshairMarkerVisible: true, crosshairMarkerRadius: 3 });
      const bbrData = [];
      for (let i = 0; i < bbr.length && i < chartTimes.length; i++) {
        const t = chartTimes[i];
        const v = bbr[i];
        if (t && t > 0 && v !== null && v !== undefined && isFinite(v)) {
          bbrData.push({ time: t, value: v });
        }
      }
      if (bbrData.length > 0) bbrSeries.setData(bbrData);
    } catch (e) {
      console.warn("[BBPulseChart] Error setting BB%B data:", e.message);
    }

    // Pulse line
    try {
      if (pulse.length > 0) {
        const pulseSeries = chart.addLineSeries({ color: "rgba(251, 191, 36, 0.7)", lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        const pulseOffset = (period - 1) + (pulseNLen - 1);
        const pulseTimes = inputTimes.slice(pulseOffset).filter((t) => t && t > 0);
        const pulseData = [];
        for (let i = 0; i < pulse.length && i < pulseTimes.length; i++) {
          const t = pulseTimes[i];
          const v = pulse[i];
          if (t && t > 0 && v !== null && v !== undefined && isFinite(v)) {
            pulseData.push({ time: t, value: v });
          }
        }
        if (pulseData.length > 0) pulseSeries.setData(pulseData);
      }
    } catch (e) {
      console.warn("[BBPulseChart] Error setting pulse data:", e.message);
    }

    // Signals
    try {
      if (bbrSeries && bbr.length > 0) {
        const bbrHigh = calcHighest(bbr, period);
        const bbrLow = calcLowest(bbr, period);
        const markers = [];
        const sigOffset = period - 1;

        for (let i = sigOffset; i < bbr.length && i < chartTimes.length; i++) {
          const t = chartTimes[i];
          if (!t || t <= 0) continue;
          
          const phIdx = i - sigOffset;
          if (phIdx < bbrHigh.length && phIdx < bbrLow.length) {
            const val = bbr[i];
            const atTop = val >= bbrHigh[phIdx];
            const atBottom = val <= bbrLow[phIdx];
            if (atTop) markers.push({ time: t, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "▼" });
            if (atBottom) markers.push({ time: t, position: "belowBar", color: "#10b981", shape: "arrowUp", text: "▲" });
          }
        }
        if (markers.length > 0) bbrSeries.setMarkers(markers);
      }
    } catch (e) {
      console.warn("[BBPulseChart] Error setting markers:", e.message);
    }

    chart.timeScale().fitContent();
    return { chart, bbrSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Book Depth Chart - Shows historic bid/ask depth as dual histogram
  // ═══════════════════════════════════════════════════════════════
  function createBookDepthChart(container, records) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.45 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.55, bottom: 0.05 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price bars on right scale (upper pane)
    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    
    const candleData = records.map((r) => ({
      time: r.time, open: r.candle.open, high: r.candle.high, low: r.candle.low, close: r.candle.close,
    })).filter((c) => c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
    
    if (candleData.length > 0) barSeries.setData(candleData);

    // Bid depth histogram (positive, green) on left scale (lower pane)
    const bidSeries = chart.addHistogramSeries({
      priceScaleId: "left",
      color: "rgba(16, 185, 129, 0.65)",
      base: 0,
    });
    
    const bidData = records
      .filter((r) => r.metrics && isFinite(r.metrics.depthBid))
      .map((r) => ({ time: r.time, value: r.metrics.depthBid, color: "rgba(16, 185, 129, 0.65)" }));
    if (bidData.length > 0) bidSeries.setData(bidData);

    // Ask depth histogram (negative, red) on left scale (lower pane)
    const askSeries = chart.addHistogramSeries({
      priceScaleId: "left",
      color: "rgba(239, 68, 68, 0.65)",
      base: 0,
    });
    
    const askData = records
      .filter((r) => r.metrics && isFinite(r.metrics.depthAsk))
      .map((r) => ({ time: r.time, value: -r.metrics.depthAsk, color: "rgba(239, 68, 68, 0.65)" }));
    if (askData.length > 0) askSeries.setData(askData);

    chart.timeScale().fitContent();
    return { chart, barSeries, bidSeries, askSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Near Liquidity Chart - Shows bid/ask within 1% of price
  // ═══════════════════════════════════════════════════════════════
  function createNearLiquidityChart(container, records) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.45 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.55, bottom: 0.05 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price bars on right scale (upper pane)
    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    
    const candleData = records.map((r) => ({
      time: r.time, open: r.candle.open, high: r.candle.high, low: r.candle.low, close: r.candle.close,
    })).filter((c) => c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
    
    if (candleData.length > 0) barSeries.setData(candleData);

    // Near bid area (green)
    const nearBidSeries = chart.addAreaSeries({
      priceScaleId: "left",
      topColor: "rgba(16, 185, 129, 0.4)",
      bottomColor: "rgba(16, 185, 129, 0.0)",
      lineColor: "rgba(16, 185, 129, 0.8)",
      lineWidth: 1,
    });
    
    const nearBidData = records
      .filter((r) => r.metrics && isFinite(r.metrics.nearBid))
      .map((r) => ({ time: r.time, value: r.metrics.nearBid }));
    if (nearBidData.length > 0) nearBidSeries.setData(nearBidData);

    // Near ask area (red, shown as negative for visual separation)
    const nearAskSeries = chart.addAreaSeries({
      priceScaleId: "left",
      topColor: "rgba(239, 68, 68, 0.0)",
      bottomColor: "rgba(239, 68, 68, 0.4)",
      lineColor: "rgba(239, 68, 68, 0.8)",
      lineWidth: 1,
      invertFilledArea: true,
    });
    
    const nearAskData = records
      .filter((r) => r.metrics && isFinite(r.metrics.nearAsk))
      .map((r) => ({ time: r.time, value: -r.metrics.nearAsk }));
    if (nearAskData.length > 0) nearAskSeries.setData(nearAskData);

    chart.timeScale().fitContent();
    return { chart, barSeries, nearBidSeries, nearAskSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Wall Proximity Chart - Shows how close price is to significant walls
  // ═══════════════════════════════════════════════════════════════
  function createWallProximityChart(container, candleData, records) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.1, bottom: 0.1 }, autoScale: true, minimum: 0, maximum: 100 },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.4 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price bars in top portion
    const barSeries = chart.addBarSeries({
      priceScaleId: "left", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    barSeries.setData(candleData.filter(c => c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)));

    // Bid Wall Proximity (green area)
    const bidProxSeries = chart.addAreaSeries({
      priceScaleId: "right",
      topColor: "rgba(16, 185, 129, 0.6)",
      bottomColor: "rgba(16, 185, 129, 0.05)",
      lineColor: "rgba(16, 185, 129, 0.9)",
      lineWidth: 2,
    });
    
    // Ask Wall Proximity (red area)
    const askProxSeries = chart.addAreaSeries({
      priceScaleId: "right",
      topColor: "rgba(239, 68, 68, 0.6)",
      bottomColor: "rgba(239, 68, 68, 0.05)",
      lineColor: "rgba(239, 68, 68, 0.9)",
      lineWidth: 2,
    });

    const bidData = [];
    const askData = [];
    const markers = [];
    
    for (const r of records) {
      if (!r.metrics) continue;
      const time = r.time;
      const bidProx = r.metrics.bidWallProximity || 0;
      const askProx = r.metrics.askWallProximity || 0;
      
      if (isFinite(bidProx)) bidData.push({ time, value: bidProx });
      if (isFinite(askProx)) askData.push({ time, value: askProx });
      
      // Add markers for high proximity signals
      if (bidProx >= 70) {
        markers.push({
          time,
          position: "belowBar",
          color: "#10b981",
          shape: "arrowUp",
          text: `Bid Wall (${bidProx})`,
          size: 1.2,
        });
      }
      if (askProx >= 70) {
        markers.push({
          time,
          position: "aboveBar",
          color: "#ef4444",
          shape: "arrowDown",
          text: `Ask Wall (${askProx})`,
          size: 1.2,
        });
      }
    }
    
    if (bidData.length > 0) bidProxSeries.setData(bidData);
    if (askData.length > 0) askProxSeries.setData(askData);
    if (markers.length > 0) barSeries.setMarkers(markers);

    chart.timeScale().fitContent();
    return { chart, barSeries, bidProxSeries, askProxSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Wall Prices Chart - Shows wall price levels vs current price
  // ═══════════════════════════════════════════════════════════════
  function createWallPricesChart(container, candleData, records) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price bars (yellow/orange)
    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#fbbf24", downColor: "#f97316", openVisible: true, thinBars: true,
    });
    barSeries.setData(candleData.filter(c => c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)));

    // Bid Wall Price (green line - support)
    const bidWallSeries = chart.addLineSeries({
      priceScaleId: "right",
      color: "rgba(16, 185, 129, 0.9)",
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      crosshairMarkerVisible: true,
      lastValueVisible: true,
      priceLineVisible: false,
    });
    
    // Ask Wall Price (red line - resistance)
    const askWallSeries = chart.addLineSeries({
      priceScaleId: "right",
      color: "rgba(239, 68, 68, 0.9)",
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      crosshairMarkerVisible: true,
      lastValueVisible: true,
      priceLineVisible: false,
    });

    const bidWallData = [];
    const askWallData = [];
    const markers = [];
    
    for (const r of records) {
      if (!r.metrics) continue;
      const time = r.time;
      const bidWallPrice = r.metrics.bidWallPrice;
      const askWallPrice = r.metrics.askWallPrice;
      const price = r.candle.close;
      const bidMult = r.metrics.bidWallMultiple || 0;
      const askMult = r.metrics.askWallMultiple || 0;
      
      // Only show wall prices if there's actually a wall
      if (bidWallPrice > 0 && bidMult >= 1.8 && isFinite(bidWallPrice)) {
        bidWallData.push({ time, value: bidWallPrice });
        
        // Mark when price touches bid wall (bounce signal)
        if (r.candle.low <= bidWallPrice * 1.001) {
          markers.push({
            time,
            position: "belowBar",
            color: "#10b981",
            shape: "arrowUp",
            text: `⬆️ ${bidMult.toFixed(1)}x`,
            size: 1.5,
          });
        }
      }
      
      if (askWallPrice > 0 && askMult >= 1.8 && isFinite(askWallPrice)) {
        askWallData.push({ time, value: askWallPrice });
        
        // Mark when price touches ask wall (bounce signal)
        if (r.candle.high >= askWallPrice * 0.999) {
          markers.push({
            time,
            position: "aboveBar",
            color: "#ef4444",
            shape: "arrowDown",
            text: `⬇️ ${askMult.toFixed(1)}x`,
            size: 1.5,
          });
        }
      }
    }
    
    if (bidWallData.length > 0) bidWallSeries.setData(bidWallData);
    if (askWallData.length > 0) askWallSeries.setData(askWallData);
    if (markers.length > 0) barSeries.setMarkers(markers);

    chart.timeScale().fitContent();
    return { chart, barSeries, bidWallSeries, askWallSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Book Levels Chart - Shows actual bid/ask price levels over time
  // Shows 10 levels on each side with volume-weighted opacity
  // ═══════════════════════════════════════════════════════════════
  function createBookLevelsChart(container, records, snapshots) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.02, bottom: 0.02 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price line (close price) - bright yellow, thicker
    const priceSeries = chart.addLineSeries({
      priceScaleId: "right",
      color: "#fbbf24",
      lineWidth: 3,
      title: "Price",
    });
    
    const priceData = snapshots
      .filter((s) => s.time && s.candle && isFinite(s.candle.c))
      .map((s) => ({ time: s.time, value: s.candle.c }));
    if (priceData.length > 0) priceSeries.setData(priceData);

    // Create level series - 10 on each side
    const numLevels = 10;
    const bidLevelSeries = [];
    const askLevelSeries = [];
    
    for (let i = 0; i < numLevels; i++) {
      // Opacity decreases with depth, but still visible
      const opacity = Math.max(0.15, 0.8 - (i * 0.07));
      const lineWidth = i === 0 ? 2 : 1;
      
      bidLevelSeries.push(chart.addLineSeries({
        priceScaleId: "right",
        color: `rgba(34, 197, 94, ${opacity})`, // Brighter green
        lineWidth: lineWidth,
        lineStyle: LightweightCharts.LineStyle.Solid,
        crosshairMarkerVisible: false,
        lastValueVisible: i === 0,
        priceLineVisible: false,
      }));
      
      askLevelSeries.push(chart.addLineSeries({
        priceScaleId: "right",
        color: `rgba(248, 113, 113, ${opacity})`, // Brighter red
        lineWidth: lineWidth,
        lineStyle: LightweightCharts.LineStyle.Solid,
        crosshairMarkerVisible: false,
        lastValueVisible: i === 0,
        priceLineVisible: false,
      }));
    }

    // Extract level data from snapshots
    const bidLevelData = Array.from({ length: numLevels }, () => []);
    const askLevelData = Array.from({ length: numLevels }, () => []);
    
    for (const snap of snapshots) {
      if (!snap.book || !snap.book.bids || !snap.book.asks) continue;
      if (snap.book.bids.length === 0 || snap.book.asks.length === 0) continue;
      
      const time = snap.time;
      
      // Extract all levels
      for (let i = 0; i < numLevels; i++) {
        if (snap.book.bids[i] && isFinite(snap.book.bids[i][0])) {
          bidLevelData[i].push({ time, value: snap.book.bids[i][0] });
        }
        if (snap.book.asks[i] && isFinite(snap.book.asks[i][0])) {
          askLevelData[i].push({ time, value: snap.book.asks[i][0] });
        }
      }
    }
    
    // Set data for all series
    for (let i = 0; i < numLevels; i++) {
      if (bidLevelData[i].length > 0) bidLevelSeries[i].setData(bidLevelData[i]);
      if (askLevelData[i].length > 0) askLevelSeries[i].setData(askLevelData[i]);
    }

    chart.timeScale().fitContent();
    return { chart, priceSeries, bidLevelSeries, askLevelSeries };
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Book Depth Profile - Shows cumulative depth at each level
  // Creates a "mountain" view of the order book over time
  // ═══════════════════════════════════════════════════════════════
  function createBookDepthProfileChart(container, snapshots) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Create stacked area series for bid depth at different price distances
    // Level 1 = within 0.1% of best, Level 2 = 0.1-0.2%, etc.
    const numBands = 5;
    const bandPct = 0.001; // 0.1% per band
    
    const bidBandSeries = [];
    const askBandSeries = [];
    
    for (let i = 0; i < numBands; i++) {
      const opacity = 0.7 - (i * 0.12);
      
      bidBandSeries.push(chart.addHistogramSeries({
        priceScaleId: "right",
        color: `rgba(34, 197, 94, ${opacity})`,
      }));
      
      askBandSeries.push(chart.addHistogramSeries({
        priceScaleId: "right",
        color: `rgba(248, 113, 113, ${opacity})`,
      }));
    }

    // Calculate cumulative depth in each band for each snapshot
    const bidBandData = Array.from({ length: numBands }, () => []);
    const askBandData = Array.from({ length: numBands }, () => []);
    
    for (const snap of snapshots) {
      if (!snap.book || !snap.book.bids || !snap.book.asks) continue;
      if (snap.book.bids.length === 0 || snap.book.asks.length === 0) continue;
      
      const time = snap.time;
      const bestBid = snap.book.bids[0][0];
      const bestAsk = snap.book.asks[0][0];
      const mid = (bestBid + bestAsk) / 2;
      
      // Initialize band volumes
      const bidBandVol = new Array(numBands).fill(0);
      const askBandVol = new Array(numBands).fill(0);
      
      // Categorize each bid level into bands
      for (const [price, size] of snap.book.bids) {
        const pctFromMid = (mid - price) / mid;
        const band = Math.min(numBands - 1, Math.floor(pctFromMid / bandPct));
        if (band >= 0) bidBandVol[band] += size;
      }
      
      // Categorize each ask level into bands
      for (const [price, size] of snap.book.asks) {
        const pctFromMid = (price - mid) / mid;
        const band = Math.min(numBands - 1, Math.floor(pctFromMid / bandPct));
        if (band >= 0) askBandVol[band] += size;
      }
      
      // Add cumulative data (stack the bands)
      let bidCum = 0;
      let askCum = 0;
      for (let i = 0; i < numBands; i++) {
        bidCum += bidBandVol[i];
        askCum += askBandVol[i];
        bidBandData[i].push({ time, value: bidCum, color: `rgba(34, 197, 94, ${0.7 - i * 0.12})` });
        askBandData[i].push({ time, value: -askCum, color: `rgba(248, 113, 113, ${0.7 - i * 0.12})` });
      }
    }
    
    // Set data (in reverse order so outer bands are behind inner)
    for (let i = numBands - 1; i >= 0; i--) {
      if (bidBandData[i].length > 0) bidBandSeries[i].setData(bidBandData[i]);
      if (askBandData[i].length > 0) askBandSeries[i].setData(askBandData[i]);
    }

    chart.timeScale().fitContent();
    return { chart, bidBandSeries, askBandSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Book Spread Chart - Shows bid-ask spread and spread band
  // ═══════════════════════════════════════════════════════════════
  function createBookSpreadChart(container, snapshots) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Spread in basis points
    const spreadSeries = chart.addHistogramSeries({
      priceScaleId: "right",
      color: "rgba(234, 179, 8, 0.75)",
    });
    
    const spreadData = [];
    for (const snap of snapshots) {
      if (!snap.book || !snap.book.bids || !snap.book.asks) continue;
      if (snap.book.bids.length === 0 || snap.book.asks.length === 0) continue;
      
      const bestBid = snap.book.bids[0][0];
      const bestAsk = snap.book.asks[0][0];
      const mid = (bestBid + bestAsk) / 2;
      const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0;
      
      if (isFinite(spreadBps)) {
        // Color based on spread tightness
        let color = "rgba(234, 179, 8, 0.75)"; // Yellow default
        if (spreadBps < 5) color = "rgba(16, 185, 129, 0.75)"; // Tight = green
        else if (spreadBps > 15) color = "rgba(239, 68, 68, 0.75)"; // Wide = red
        
        spreadData.push({ time: snap.time, value: spreadBps, color });
      }
    }
    
    if (spreadData.length > 0) spreadSeries.setData(spreadData);

    chart.timeScale().fitContent();
    return { chart, spreadSeries };
  }

  // ═══════════════════════════════════════════════════════════════
  // Book Volume Profile - Shows volume at each price level
  // ═══════════════════════════════════════════════════════════════
  function createBookVolumeChart(container, records, snapshots) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.45 }, autoScale: true },
      leftPriceScale: { visible: true, borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.55, bottom: 0.05 } },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    // Price line on right scale
    const priceSeries = chart.addLineSeries({
      priceScaleId: "right",
      color: "#f59e0b",
      lineWidth: 2,
    });
    
    const priceData = snapshots
      .filter((s) => s.time && s.candle && isFinite(s.candle.c))
      .map((s) => ({ time: s.time, value: s.candle.c }));
    if (priceData.length > 0) priceSeries.setData(priceData);

    // Top bid volume (level 1)
    const topBidVolSeries = chart.addHistogramSeries({
      priceScaleId: "left",
      color: "rgba(16, 185, 129, 0.8)",
    });
    
    // Top ask volume (level 1) - negative
    const topAskVolSeries = chart.addHistogramSeries({
      priceScaleId: "left",
      color: "rgba(239, 68, 68, 0.8)",
    });
    
    const topBidVolData = [];
    const topAskVolData = [];
    
    for (const snap of snapshots) {
      if (!snap.book || !snap.book.bids || !snap.book.asks) continue;
      if (snap.book.bids.length === 0 || snap.book.asks.length === 0) continue;
      
      const bidVol = snap.book.bids[0][1]; // Volume at best bid
      const askVol = snap.book.asks[0][1]; // Volume at best ask
      
      if (isFinite(bidVol)) topBidVolData.push({ time: snap.time, value: bidVol, color: "rgba(16, 185, 129, 0.8)" });
      if (isFinite(askVol)) topAskVolData.push({ time: snap.time, value: -askVol, color: "rgba(239, 68, 68, 0.8)" });
    }
    
    if (topBidVolData.length > 0) topBidVolSeries.setData(topBidVolData);
    if (topAskVolData.length > 0) topAskVolSeries.setData(topAskVolData);

    chart.timeScale().fitContent();
    return { chart, priceSeries, topBidVolSeries, topAskVolSeries };
  }

  // Chart with price-based metric as line overlay (for VWMP, IFV, Mid) with optional grid
  function createPriceOverlayChart(container, candleData, metricData, lineColor, gridSpacing = 0) {
    const chart = LightweightCharts.createChart(container, {
      layout: { background: { type: "solid", color: "#0a0e17" }, textColor: "#94a3b8" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: "rgba(30,41,59,0.9)", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
      timeScale: timeScaleConfig,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    });

    const barSeries = chart.addBarSeries({
      priceScaleId: "right", upColor: "#10b981", downColor: "#ef4444", openVisible: true, thinBars: true,
    });
    
    // Validate candle data
    const validCandleData = candleData.filter((c) => 
      c.time && isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close)
    );
    
    try {
      if (validCandleData.length > 0) {
        barSeries.setData(validCandleData);
      }
    } catch (e) {
      console.warn("[PriceOverlayChart] Error setting bar data:", e.message);
    }

    // Filter out null/undefined/NaN values before setting data
    const lineData = metricData
      .filter((d) => d.time && d.value !== null && d.value !== undefined && isFinite(d.value))
      .map((d) => ({ time: d.time, value: d.value }));
    
    if (lineData.length === 0) {
      chart.timeScale().fitContent();
      return { chart, barSeries };
    }

    const lineSeries = chart.addLineSeries({
      priceScaleId: "right",
      color: lineColor,
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
    });
    lineSeries.setData(lineData);

    // Store grid line series for cleanup
    const gridLines = [];
    const markers = [];
    const maxLines = 10;

    // Draw grid lines and calculate signals if spacing > 0
    if (gridSpacing > 0 && lineData.length > 0) {
      const baseColor = extractRGB(lineColor);

      for (let i = 1; i <= maxLines; i++) {
        const opacity = Math.max(0.1, 0.4 - (i * 0.03));
        const gridColor = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${opacity})`;

        // Above: multiply by (1 + spacing * i)
        const aboveMultiplier = 1 + (gridSpacing * i);
        const aboveData = lineData
          .map((p) => ({ time: p.time, value: p.value * aboveMultiplier }))
          .filter((d) => isFinite(d.value));
        if (aboveData.length > 0) {
          const aboveSeries = chart.addLineSeries({
            priceScaleId: "right",
            color: gridColor,
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
          });
          aboveSeries.setData(aboveData);
          gridLines.push(aboveSeries);
        }

        // Below: multiply by (1 - spacing * i)
        const belowMultiplier = 1 - (gridSpacing * i);
        if (belowMultiplier > 0) {
          const belowData = lineData
            .map((p) => ({ time: p.time, value: p.value * belowMultiplier }))
            .filter((d) => isFinite(d.value));
          if (belowData.length > 0) {
            const belowSeries = chart.addLineSeries({
              priceScaleId: "right",
              color: gridColor,
              lineWidth: 1,
              lineStyle: LightweightCharts.LineStyle.Dotted,
              crosshairMarkerVisible: false,
              lastValueVisible: false,
              priceLineVisible: false,
            });
            belowSeries.setData(belowData);
            gridLines.push(belowSeries);
          }
        }
      }

      // Calculate arrow signals when price touches outermost grid lines
      // Create a map of metric values by time for quick lookup
      const metricByTime = new Map();
      for (const d of lineData) {
        metricByTime.set(d.time, d.value);
      }

      for (const candle of validCandleData) {
        if (!candle.time || candle.time <= 0) continue;
        const metricValue = metricByTime.get(candle.time);
        if (metricValue === undefined || metricValue === null || !isFinite(metricValue)) continue;

        // Calculate outermost grid lines
        const highestGrid = metricValue * (1 + (maxLines * gridSpacing));
        const lowestGrid = metricValue * (1 - (maxLines * gridSpacing));

        // Down arrow when bar HIGH touches or exceeds HIGHEST grid line (overbought)
        if (candle.high >= highestGrid) {
          markers.push({
            time: candle.time,
            position: "aboveBar",
            color: lineColor,
            shape: "arrowDown",
            text: "▼",
          });
        }

        // Up arrow when bar LOW touches or goes below LOWEST grid line (oversold)
        if (candle.low <= lowestGrid) {
          markers.push({
            time: candle.time,
            position: "belowBar",
            color: lineColor,
            shape: "arrowUp",
            text: "▲",
          });
        }
      }

      // Set markers on the bar series
      try {
        if (markers.length > 0) {
          barSeries.setMarkers(markers);
        }
      } catch (e) {
        console.warn("[PriceOverlayChart] Error setting markers:", e.message);
      }
    }

    chart.timeScale().fitContent();
    return { chart, barSeries, metricSeries: lineSeries, gridLines, markers };
  }

  function signedColor(v) {
    if (v > 0) return "rgba(16, 185, 129, 0.75)";
    if (v < 0) return "rgba(239, 68, 68, 0.75)";
    return "rgba(148, 163, 184, 0.5)";
  }

  function alphaColor(v) {
    if (v >= 70) return "rgba(16, 185, 129, 0.75)";
    if (v <= 30) return "rgba(239, 68, 68, 0.75)";
    return "rgba(234, 179, 8, 0.75)";
  }

  function bprColor(v) {
    return v >= 1 ? "rgba(16, 185, 129, 0.75)" : "rgba(239, 68, 68, 0.75)";
  }

  // Grid spacing settings (stored in localStorage) - default 0.00008 = 0.008%
  const gridSettings = {
    priceZema: parseFloat(localStorage.getItem("replay_gridPriceZema") || "0.00008"),
    vwmp: parseFloat(localStorage.getItem("replay_gridVwmp") || "0.00008"),
    ifv: parseFloat(localStorage.getItem("replay_gridIfv") || "0.00008"),
    mid: parseFloat(localStorage.getItem("replay_gridMid") || "0.00008"),
  };

  // ─────────────────────────────────────────────────────────────
  // Section Descriptions - Newbie-friendly explanations
  // ─────────────────────────────────────────────────────────────
  const SECTION_DESCRIPTIONS = {
    "Trading Performance": {
      icon: "💰",
      title: "Your Trading Results",
      description: "This shows your hypothetical trades based on the signals. Green arrows = BUY entries, Red arrows = SELL entries. Watch the cumulative P&L line to see if the strategy is profitable over time.",
      action: "✅ Follow signals with certainty ≥80 • Exit on opposite signal or certainty drop"
    },
    "Entry Signals": {
      icon: "🎯",
      title: "When to Enter Trades",
      description: "These scores tell you how confident the system is about a trade. 80+ means overwhelming confluence - multiple indicators all agree. Below 80 = wait for a better setup.",
      action: "✅ LONG when green ≥80 & red <30 • SHORT when red ≥80 & green <30 • WAIT otherwise"
    },
    "Momentum / Delta": {
      icon: "⚡",
      title: "Is the Trend Accelerating?",
      description: "Delta metrics show CHANGE from the previous bar. Rising values mean the trend is gaining strength. Falling values mean momentum is fading.",
      action: "✅ Positive & rising = trend continues • Negative & falling = reversal building"
    },
    "Spread Analysis": {
      icon: "📏",
      title: "Market Consensus",
      description: "Spread is the gap between best bid and ask. Tight spread = traders agree on price (good for entries). Wide spread = uncertainty (avoid trading).",
      action: "✅ Trade when spread is TIGHT • Avoid when spread is WIDE or WIDENING"
    },
    "Fair Value Divergence": {
      icon: "⚖️",
      title: "Is Price Too High or Low?",
      description: "Compares current price to 'fair value' calculated from the order book. Negative = price is cheap (bullish). Positive = price is expensive (bearish).",
      action: "✅ Buy when price is BELOW fair value • Sell when price is ABOVE fair value"
    },
    "Liquidity Vacuum": {
      icon: "🌪️",
      title: "Where Will Price Move Next?",
      description: "Shows which side of the book is 'thin' (fewer orders). Price tends to move toward thin areas to find liquidity. This is pure market physics.",
      action: "✅ Asks thin (<0.3) = price moves UP • Bids thin (<0.3) = price moves DOWN"
    },
    "Price Reference": {
      icon: "📊",
      title: "Traditional Price Analysis",
      description: "Classic technical analysis tools for comparison. ZEMA is a zero-lag moving average. BB Pulse detects overbought/oversold extremes.",
      action: "✅ Use grid lines as support/resistance • Arrows show reversal signals"
    },
    "Fair Value": {
      icon: "💎",
      title: "True Price from Order Book",
      description: "These lines show where price 'should be' based on order book analysis. VWMP = volume-weighted. IFV = imbalance-weighted. Mid = simple midpoint.",
      action: "✅ Price below line = undervalued (buy) • Price above line = overvalued (sell)"
    },
    "Order Flow": {
      icon: "🌊",
      title: "Who's in Control - Buyers or Sellers?",
      description: "BPR above 1 = more buyers. Below 1 = more sellers. LD% shows the percentage imbalance. Higher absolute values = stronger conviction.",
      action: "✅ BPR >1.5 = buyers winning • BPR <0.67 = sellers winning • LD% shows strength"
    },
    "Alpha Scores": {
      icon: "🧠",
      title: "AI Confidence by Trading Style",
      description: "Three different perspectives: MM (fast scalps), Swing (medium holds), HTF (longer positions). Each uses different inputs from the order book.",
      action: "✅ Use MM for 1-5 min trades • Swing for 15-60 min • HTF for 1hr+ positions"
    },
    "Market Consensus": {
      icon: "🤝",
      title: "What Do All Signals Say Together?",
      description: "MCS combines all three alpha scores into one view. Individual biases show which timeframe is most bullish or bearish right now.",
      action: "✅ Trade in direction of MCS • Strongest bias shows dominant timeframe"
    },
    "Regime Engine": {
      icon: "🔄",
      title: "Accumulation or Distribution?",
      description: "Detects whether smart money is buying (accumulation) or selling (distribution). Near pressure shows immediate intent, far pressure shows positioning.",
      action: "✅ Accumulation = look for longs • Distribution = look for shorts"
    },
    "Predictive Signals": {
      icon: "🔮",
      title: "What Happens Next?",
      description: "Probability of the next regime being bullish. Combines momentum, fair value, and spread signals to predict near-term direction.",
      action: "✅ >60 = high probability of up move • <40 = high probability of down move"
    },
    "Wall Signals": {
      icon: "🧱",
      title: "WALL DETECTION — Price Bounce Signals",
      description: "Walls are large orders that act like barriers. When price approaches a wall, it often BOUNCES. Bid Wall = support below (green) — price approaching = expect bounce UP (LONG). Ask Wall = resistance above (red) — price approaching = expect bounce DOWN (SHORT). Wall Proximity score 0-100: higher = closer to wall.",
      action: "✅ LONG when: Bid Wall Proximity > 60 (price near support wall) • SHORT when: Ask Wall Proximity > 60 (price near resistance wall) • Arrows mark wall touches"
    },
    "Order Book Levels": {
      icon: "📊",
      title: "Order Book Structure Over Time",
      description: "Price Levels: Shows 10 bid levels (green lines) and 10 ask levels (red lines) at each 1-min bar. Yellow = price. Watch how levels stack up and move. Depth Profile: Shows cumulative volume at different distances from mid-price (0.1%, 0.2%, etc). Stacked bands show total depth.",
      action: "✅ Green levels above price = resistance breaking • Red levels below price = support breaking • Thick bands = strong support/resistance"
    },
    "Level Signals": {
      icon: "🛡️",
      title: "Support/Resistance from Order Book Levels",
      description: "Uses ACTUAL order book price levels to detect support/resistance. Bid Support Score: How strong is support below (0-100). Ask Resistance Score: How strong is resistance above (0-100). Wall Detection: Large orders at best bid/ask (>2x average = wall). Level Imbalance: Which side has more volume stacked.",
      action: "✅ LONG when: Support Score > 70, price near bid wall, ask vacuum above • SHORT when: Resistance Score > 70, price near ask wall, bid vacuum below"
    },
    "Order Book Depth": {
      icon: "📊",
      title: "Aggregated Order Book Volume",
      description: "Total volume at all bid/ask levels. Near = within 1% of price (immediate liquidity). Far = deeper in the book.",
      action: "✅ Near bid >> Near ask = immediate buying pressure = bullish"
    },
    "Market Structure": {
      icon: "🏗️",
      title: "Current Market Conditions",
      description: "Spread shows market liquidity and trading costs. Tighter spread = more liquid = better fills. Wider spread = less liquid = more slippage.",
      action: "✅ Tighter spread = safer to trade • Wider spread = increase position size caution"
    }
  };

  const METRICS = [
    // ═══════════════════════════════════════════════════════════════
    // TRADING PERFORMANCE - Shows actual trade results
    // ═══════════════════════════════════════════════════════════════
    { id: "tradingPerformance", label: "💰 Trading Performance (Entry/Exit/P&L)", section: "Trading Performance", chartType: "tradingPerformance" },
    
    // ═══════════════════════════════════════════════════════════════
    // ENTRY SIGNALS (Certainty Scores) - TOP PRIORITY
    // ═══════════════════════════════════════════════════════════════
    { id: "longCertainty", label: "🎯 LONG Certainty Score (0-100)", get: (m) => m.longCertainty, 
      color: (v) => v >= 80 ? "rgba(16, 185, 129, 1)" : v >= 60 ? "rgba(16, 185, 129, 0.7)" : v >= 40 ? "rgba(16, 185, 129, 0.4)" : "rgba(16, 185, 129, 0.2)", 
      section: "Entry Signals", isSignal: true },
    { id: "shortCertainty", label: "🎯 SHORT Certainty Score (0-100)", get: (m) => m.shortCertainty, 
      color: (v) => v >= 80 ? "rgba(239, 68, 68, 1)" : v >= 60 ? "rgba(239, 68, 68, 0.7)" : v >= 40 ? "rgba(239, 68, 68, 0.4)" : "rgba(239, 68, 68, 0.2)", 
      section: "Entry Signals", isSignal: true },
    { id: "entrySignalChart", label: "📊 Entry Signal History (with Price)", section: "Entry Signals", chartType: "signalChart" },
    
    // ═══════════════════════════════════════════════════════════════
    // DELTA METRICS (Bar-over-Bar Changes / Momentum)
    // ═══════════════════════════════════════════════════════════════
    { id: "ldDeltaChange", label: "⚡ LD% Change (Momentum)", get: (m) => m.ldDeltaChange, color: signedColor, section: "Momentum / Delta" },
    { id: "bprDelta", label: "⚡ BPR Change", get: (m) => m.bprDelta, color: signedColor, section: "Momentum / Delta" },
    { id: "nearPressureDeltaChange", label: "⚡ Near Pressure Change", get: (m) => m.nearPressureDeltaChange, color: signedColor, section: "Momentum / Delta" },
    
    // ═══════════════════════════════════════════════════════════════
    // SPREAD ANALYSIS (Market Consensus Indicator)
    // ═══════════════════════════════════════════════════════════════
    { id: "spreadBps", label: "Spread (Basis Points)", get: (m) => m.spreadBps, color: (v) => v < 5 ? "rgba(16, 185, 129, 0.75)" : v > 15 ? "rgba(239, 68, 68, 0.75)" : "rgba(234, 179, 8, 0.75)", section: "Spread Analysis" },
    { id: "spreadDeltaChange", label: "Spread Delta (Tightening/Widening)", get: (m) => m.spreadDeltaChange * 10000, color: (v) => v < 0 ? "rgba(16, 185, 129, 0.75)" : v > 0 ? "rgba(239, 68, 68, 0.75)" : "rgba(234, 179, 8, 0.75)", section: "Spread Analysis" },
    
    // ═══════════════════════════════════════════════════════════════
    // FAIR VALUE DIVERGENCE (Price vs Book-Derived Values)
    // ═══════════════════════════════════════════════════════════════
    { id: "ifvDivPct", label: "IFV Divergence (Price - IFV %)", get: (m) => m.ifvDivPct * 100, color: (v) => v < -0.5 ? "rgba(16, 185, 129, 0.85)" : v > 0.5 ? "rgba(239, 68, 68, 0.85)" : "rgba(234, 179, 8, 0.75)", section: "Fair Value Divergence" },
    { id: "vwmpDivPct", label: "VWMP Divergence (Price - VWMP %)", get: (m) => m.vwmpDivPct * 100, color: (v) => v < -0.5 ? "rgba(16, 185, 129, 0.85)" : v > 0.5 ? "rgba(239, 68, 68, 0.85)" : "rgba(234, 179, 8, 0.75)", section: "Fair Value Divergence" },
    
    // ═══════════════════════════════════════════════════════════════
    // LIQUIDITY VACUUM DETECTION
    // ═══════════════════════════════════════════════════════════════
    { id: "askThinRatio", label: "Ask Thin Ratio (<0.3 = Bullish Vacuum)", get: (m) => m.askThinRatio, color: (v) => v < 0.3 ? "rgba(16, 185, 129, 0.85)" : v > 0.7 ? "rgba(239, 68, 68, 0.85)" : "rgba(234, 179, 8, 0.75)", section: "Liquidity Vacuum" },
    { id: "bidThinRatio", label: "Bid Thin Ratio (<0.3 = Bearish Vacuum)", get: (m) => m.bidThinRatio, color: (v) => v < 0.3 ? "rgba(239, 68, 68, 0.85)" : v > 0.7 ? "rgba(16, 185, 129, 0.85)" : "rgba(234, 179, 8, 0.75)", section: "Liquidity Vacuum" },
    { id: "nearPressureImbalance", label: "Near Pressure Imbalance % (Top of Book)", get: (m) => m.nearPressureImbalance, color: signedColor, section: "Liquidity Vacuum" },
    
    // ═══════════════════════════════════════════════════════════════
    // Price Reference (traditional TA for comparison)
    // ═══════════════════════════════════════════════════════════════
    { id: "priceZema", label: "Price + ZEMA(30) Grid", section: "Price Reference", chartType: "priceZema", hasGrid: true },
    { id: "bbPulse", label: "BB Pulse Lighting", section: "Price Reference", chartType: "bbPulse" },
    
    // Fair Value (price lines with grid + BB Pulse)
    { id: "vwmp", label: "VWMP (Volume-Weighted Mid Price)", get: (m) => m.vwmp, color: () => "rgba(52, 211, 153, 0.75)", section: "Fair Value", isPriceLine: true, lineColor: "#34d399", hasGrid: true },
    { id: "vwmpPulse", label: "BB Pulse on VWMP", section: "Fair Value", chartType: "bbPulseMetric", metricId: "vwmp", lineColor: "#34d399" },
    { id: "ifv", label: "IFV (Imbalance Fair Value)", get: (m) => m.ifv, color: () => "rgba(167, 139, 250, 0.75)", section: "Fair Value", isPriceLine: true, lineColor: "#a78bfa", hasGrid: true },
    { id: "ifvPulse", label: "BB Pulse on IFV", section: "Fair Value", chartType: "bbPulseMetric", metricId: "ifv", lineColor: "#a78bfa" },
    { id: "mid", label: "Mid Price", get: (m) => m.mid, color: () => "rgba(148, 163, 184, 0.6)", section: "Fair Value", isPriceLine: true, lineColor: "#94a3b8", hasGrid: true },
    { id: "midPulse", label: "BB Pulse on Mid Price", section: "Fair Value", chartType: "bbPulseMetric", metricId: "mid", lineColor: "#94a3b8" },
    
    // Order Flow
    { id: "bpr", label: "BPR (Bid/Ask Pressure Ratio)", get: (m) => m.bpr, color: bprColor, section: "Order Flow" },
    { id: "ldDelta", label: "LD Delta (Liquidity Delta)", get: (m) => m.ldDelta, color: signedColor, section: "Order Flow" },
    { id: "ldPct", label: "LD % (Liquidity Imbalance)", get: (m) => m.ldPct, color: signedColor, section: "Order Flow" },
    { id: "ldNearDelta", label: "LD Near Delta (within 1%)", get: (m) => m.ldNearDelta, color: signedColor, section: "Order Flow" },
    { id: "ldFarDelta", label: "LD Far Delta (beyond 1%)", get: (m) => m.ldFarDelta, color: signedColor, section: "Order Flow" },
    
    // Alpha Scores - ALL THREE with individual settings
    { id: "alphaMM", label: "Alpha MM ⚡ (Market Maker)", get: (m) => m.alphaMM, color: alphaColor, section: "Alpha Scores", settingsId: "MM" },
    { id: "alphaSwing", label: "Alpha Swing 📊 (Swing Trader)", get: (m) => m.alphaSwing, color: alphaColor, section: "Alpha Scores", settingsId: "Swing" },
    { id: "alphaHTF", label: "Alpha HTF 🏦 (Investor)", get: (m) => m.alphaHTF, color: alphaColor, section: "Alpha Scores", settingsId: "HTF" },
    
    // Market Consensus
    { id: "mcs", label: "MCS (Market Consensus Score)", get: (m) => m.mcs, color: signedColor, section: "Market Consensus" },
    { id: "mmBias", label: "MM Bias", get: (m) => m.mmBias, color: signedColor, section: "Market Consensus" },
    { id: "swingBias", label: "Swing Bias", get: (m) => m.swingBias, color: signedColor, section: "Market Consensus" },
    { id: "htfBias", label: "HTF Bias", get: (m) => m.htfBias, color: signedColor, section: "Market Consensus" },
    
    // Regime Engine
    { id: "regimeScore", label: "Regime Score (Accum/Distrib)", get: (m) => m.regimeScore, color: signedColor, section: "Regime Engine" },
    { id: "ldStrength", label: "LD Strength (Abs)", get: (m) => m.ldStrength, color: () => "rgba(234, 179, 8, 0.75)", section: "Regime Engine" },
    { id: "nearPressure", label: "Near Pressure (within 1%)", get: (m) => m.nearPressure, color: signedColor, section: "Regime Engine" },
    { id: "farPressure", label: "Far Pressure (beyond 1%)", get: (m) => m.farPressure, color: signedColor, section: "Regime Engine" },
    { id: "pressureImbalance", label: "Near Pressure Imbalance %", get: (m) => m.pressureImbalance, color: signedColor, section: "Regime Engine" },
    
    // Predictive Signals
    { id: "nextRegimeProb", label: "Next Regime Probability 🔮 (>50 = Bullish)", get: (m) => m.nextRegimeProb, color: (v) => v > 60 ? "rgba(16, 185, 129, 0.85)" : v < 40 ? "rgba(239, 68, 68, 0.85)" : "rgba(234, 179, 8, 0.75)", section: "Predictive Signals" },
    
    // ═══════════════════════════════════════════════════════════════
    // WALL SIGNALS (Price approaching significant walls = BOUNCE!)
    // ═══════════════════════════════════════════════════════════════
    { id: "wallProximity", label: "🧱 Wall Proximity (0-100)", section: "Wall Signals", chartType: "wallProximity" },
    { id: "wallPrices", label: "🧱 Wall Prices vs Price", section: "Wall Signals", chartType: "wallPrices" },
    { id: "bidWallProximity", label: "Bid Wall Proximity (0-100)", get: (m) => m.bidWallProximity, 
      color: (v) => v >= 70 ? "rgba(16, 185, 129, 1)" : v >= 50 ? "rgba(16, 185, 129, 0.7)" : v >= 30 ? "rgba(16, 185, 129, 0.4)" : "rgba(16, 185, 129, 0.2)", 
      section: "Wall Signals" },
    { id: "askWallProximity", label: "Ask Wall Proximity (0-100)", get: (m) => m.askWallProximity, 
      color: (v) => v >= 70 ? "rgba(239, 68, 68, 1)" : v >= 50 ? "rgba(239, 68, 68, 0.7)" : v >= 30 ? "rgba(239, 68, 68, 0.4)" : "rgba(239, 68, 68, 0.2)", 
      section: "Wall Signals" },
    { id: "bidWallDistPct", label: "Distance to Bid Wall (%)", get: (m) => m.bidWallDistPct, 
      color: (v) => v < 0.1 ? "rgba(16, 185, 129, 0.9)" : v < 0.3 ? "rgba(16, 185, 129, 0.5)" : "rgba(100, 116, 139, 0.4)", 
      section: "Wall Signals" },
    { id: "askWallDistPct", label: "Distance to Ask Wall (%)", get: (m) => m.askWallDistPct, 
      color: (v) => v < 0.1 ? "rgba(239, 68, 68, 0.9)" : v < 0.3 ? "rgba(239, 68, 68, 0.5)" : "rgba(100, 116, 139, 0.4)", 
      section: "Wall Signals" },
    
    // ═══════════════════════════════════════════════════════════════
    // ORDER BOOK LEVELS (Historic Book Structure)
    // ═══════════════════════════════════════════════════════════════
    { id: "bookLevels", label: "📊 Price Levels (10 Bids/Asks over time)", section: "Order Book Levels", chartType: "bookLevels" },
    { id: "bookDepthProfile", label: "📊 Depth Profile (Cumulative by Distance)", section: "Order Book Levels", chartType: "bookDepthProfile" },
    { id: "bookVolume", label: "📊 Top-of-Book Volume (Best Bid/Ask Size)", section: "Order Book Levels", chartType: "bookVolume" },
    { id: "bookSpread", label: "📊 Spread (Basis Points)", section: "Order Book Levels", chartType: "bookSpread" },
    
    // ═══════════════════════════════════════════════════════════════
    // LEVEL-BASED SIGNALS (Support/Resistance from actual levels)
    // ═══════════════════════════════════════════════════════════════
    { id: "bidSupportScore", label: "🛡️ Bid Support Score (0-100)", get: (m) => m.bidSupportScore, 
      color: (v) => v >= 70 ? "rgba(16, 185, 129, 1)" : v >= 50 ? "rgba(16, 185, 129, 0.7)" : v >= 30 ? "rgba(16, 185, 129, 0.4)" : "rgba(16, 185, 129, 0.2)", 
      section: "Level Signals" },
    { id: "askResistanceScore", label: "🛡️ Ask Resistance Score (0-100)", get: (m) => m.askResistanceScore, 
      color: (v) => v >= 70 ? "rgba(239, 68, 68, 1)" : v >= 50 ? "rgba(239, 68, 68, 0.7)" : v >= 30 ? "rgba(239, 68, 68, 0.4)" : "rgba(239, 68, 68, 0.2)", 
      section: "Level Signals" },
    { id: "levelImbalancePct", label: "Level Imbalance % (Bid vs Ask strength)", get: (m) => m.levelImbalancePct, color: signedColor, section: "Level Signals" },
    { id: "bidWallMultiple", label: "Bid Wall (>2 = wall)", get: (m) => m.bidWallMultiple, 
      color: (v) => v > 2 ? "rgba(16, 185, 129, 0.9)" : v > 1.5 ? "rgba(16, 185, 129, 0.6)" : "rgba(100, 116, 139, 0.4)", 
      section: "Level Signals" },
    { id: "askWallMultiple", label: "Ask Wall (>2 = wall)", get: (m) => m.askWallMultiple, 
      color: (v) => v > 2 ? "rgba(239, 68, 68, 0.9)" : v > 1.5 ? "rgba(239, 68, 68, 0.6)" : "rgba(100, 116, 139, 0.4)", 
      section: "Level Signals" },
    { id: "priceToBidPct", label: "Price to Best Bid (%)", get: (m) => m.priceToBidPct, 
      color: (v) => v < 0.02 ? "rgba(16, 185, 129, 0.9)" : "rgba(100, 116, 139, 0.5)", 
      section: "Level Signals" },
    { id: "priceToAskPct", label: "Price to Best Ask (%)", get: (m) => m.priceToAskPct, 
      color: (v) => v < 0.02 ? "rgba(239, 68, 68, 0.9)" : "rgba(100, 116, 139, 0.5)", 
      section: "Level Signals" },
    
    // ═══════════════════════════════════════════════════════════════
    // ORDER BOOK DEPTH (Aggregated volumes)
    // ═══════════════════════════════════════════════════════════════
    { id: "bookDepth", label: "📊 Total Depth (Bid vs Ask)", section: "Order Book Depth", chartType: "bookDepth" },
    { id: "nearLiquidity", label: "📊 Near Liquidity (within 1%)", section: "Order Book Depth", chartType: "nearLiquidity" },
    { id: "depthBid", label: "Depth: Bid Volume", get: (m) => m.depthBid, color: () => "rgba(16, 185, 129, 0.75)", section: "Order Book Depth" },
    { id: "depthAsk", label: "Depth: Ask Volume", get: (m) => m.depthAsk, color: () => "rgba(239, 68, 68, 0.75)", section: "Order Book Depth" },
    { id: "depthImbalancePct", label: "Depth Imbalance %", get: (m) => m.depthImbalancePct, color: signedColor, section: "Order Book Depth" },
    { id: "nearBid", label: "Near Bid (within 1%)", get: (m) => m.nearBid, color: () => "rgba(16, 185, 129, 0.75)", section: "Order Book Depth" },
    { id: "nearAsk", label: "Near Ask (within 1%)", get: (m) => m.nearAsk, color: () => "rgba(239, 68, 68, 0.75)", section: "Order Book Depth" },
    
    // Market Structure
    { id: "spread", label: "Spread", get: (m) => m.spread, color: () => "rgba(234, 179, 8, 0.75)", section: "Market Structure" },
  ];

  function renderCharts(records) {
    clearChartElements();

    const candleData = records.map((r) => ({
      time: r.time, open: r.candle.open, high: r.candle.high, low: r.candle.low, close: r.candle.close,
    }));

    const validRecords = records.filter((r) => r.metrics);
    if (validRecords.length === 0) {
      setStatus("No valid metrics computed - check book data", true);
      return;
    }

    const settings = getSettings();
    const symbol = symbolInput.value.toUpperCase();
    const timeframe = timeframeSelect ? timeframeSelect.value : "1m";
    const meta = `${symbol} • ${timeframe} • ${validRecords.length} bars`;

    const sections = {};
    METRICS.forEach((m) => {
      if (!sections[m.section]) sections[m.section] = [];
      sections[m.section].push(m);
    });
    
    let chartCount = 0;
    for (const [section, metrics] of Object.entries(sections)) {
      // Section header
      const sectionHeader = document.createElement("div");
      sectionHeader.className = "section-header";
      sectionHeader.style.cssText = "font-size:13px;font-weight:600;color:#94a3b8;margin:20px 0 6px;padding-left:4px;border-left:3px solid #3b82f6;";
      
      // Get section description
      const sectionInfo = SECTION_DESCRIPTIONS[section];
      if (sectionInfo) {
        sectionHeader.innerHTML = `<span style="margin-right:6px;">${sectionInfo.icon}</span>${section}`;
      } else {
      sectionHeader.textContent = section;
      }
      chartsContainer.appendChild(sectionHeader);
      
      // Section description box
      if (sectionInfo) {
        const descBox = document.createElement("div");
        descBox.style.cssText = "margin:0 0 12px 0; padding:10px 12px; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.2); border-radius:8px; font-size:11px;";
        descBox.innerHTML = `
          <div style="color:#e2e8f0; font-weight:600; margin-bottom:4px;">${sectionInfo.title}</div>
          <div style="color:#94a3b8; line-height:1.5; margin-bottom:6px;">${sectionInfo.description}</div>
          <div style="color:#10b981; font-weight:500;">${sectionInfo.action}</div>
        `;
        chartsContainer.appendChild(descBox);
      }

      for (const metric of metrics) {
        // Handle special chart types
        if (metric.chartType) {
          const card = document.createElement("div");
          card.className = "metric-card";
          
          let inlineSettings = "";
          if (metric.chartType === "priceZema" && metric.hasGrid) {
            const gridVal = gridSettings[metric.id] || 0.00008;
            inlineSettings = `
              <div class="grid-inline-settings" style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:8px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);border-radius:8px;">
                <span style="font-size:11px;color:#94a3b8;white-space:nowrap;">ZEMA Grid Spacing:</span>
                <input type="number" class="grid-spacing-input" data-metric="${metric.id}" min="0" max="0.1" step="0.00001" value="${gridVal}" style="width:90px;padding:4px 8px;font-size:12px;border-radius:4px;border:1px solid rgba(30,41,59,0.9);background:rgba(2,6,23,0.8);color:#e2e8f0;text-align:center;"/>
                <span style="font-size:11px;color:#64748b;">(0 = off)</span>
                <button class="grid-reset-btn" data-metric="${metric.id}" style="padding:4px 8px;font-size:10px;border-radius:4px;border:1px solid rgba(148,163,184,0.3);background:rgba(148,163,184,0.1);color:#94a3b8;cursor:pointer;" title="Reset to 0.00008">↺</button>
              </div>
            `;
          }
          
          const isHalfHeight = metric.chartType === "bbPulse" || metric.chartType === "bbPulseMetric";
          const isTallChart = metric.chartType === "tradingPerformance";
          
          let heightClass = "";
          if (isHalfHeight) heightClass = " half-height";
          else if (isTallChart) heightClass = " tall-height";
          
          card.innerHTML = `
            ${inlineSettings}
            <div class="metric-card-header">
              <div class="metric-card-title">${metric.label}</div>
              <div class="metric-card-meta">${meta}</div>
            </div>
            <div class="metric-card-body${heightClass}" id="chart-${metric.id}"></div>
          `;
          chartsContainer.appendChild(card);
          
          // Attach grid settings for priceZema
          if (metric.chartType === "priceZema" && metric.hasGrid) {
            const gridInput = card.querySelector(".grid-spacing-input");
            const gridResetBtn = card.querySelector(".grid-reset-btn");
            if (gridInput) {
              gridInput.addEventListener("change", () => {
                const val = parseFloat(gridInput.value) || 0;
                gridSettings[metric.id] = val;
                localStorage.setItem(`replay_gridPriceZema`, val);
                recomputeAndRender();
              });
            }
            if (gridResetBtn) {
              gridResetBtn.addEventListener("click", () => {
                gridInput.value = 0.00008;
                gridSettings[metric.id] = 0.00008;
                localStorage.setItem(`replay_gridPriceZema`, 0.00008);
                recomputeAndRender();
              });
            }
          }
          
          const chartContainer = card.querySelector(".metric-card-body");
          let chartObj;
          if (metric.chartType === "priceZema") {
            const gridSpacing = gridSettings[metric.id] || 0.00008;
            chartObj = createPriceZemaChart(chartContainer, candleData, gridSpacing);
          } else if (metric.chartType === "bbPulse") {
            chartObj = createBBPulseChart(chartContainer, candleData, "#3b82f6", null);
          } else if (metric.chartType === "bbPulseMetric") {
            // BB Pulse on a computed metric (VWMP, IFV, Mid)
            const sourceMetric = METRICS.find((m) => m.id === metric.metricId);
            if (sourceMetric && sourceMetric.get) {
              const metricValues = validRecords.map((r) => {
                const v = sourceMetric.get(r.metrics);
                return { time: r.time, value: v === null || v === undefined || !isFinite(v) ? 0 : v };
              });
              chartObj = createBBPulseChart(chartContainer, candleData, metric.lineColor || "#3b82f6", metricValues);
            }
          } else if (metric.chartType === "signalChart") {
            // Entry Signal History Chart with LONG/SHORT arrows on price
            chartObj = { chart: createSignalChart(chartContainer, records) };
          } else if (metric.chartType === "tradingPerformance") {
            // Trading Performance Chart with P&L tracking
            // Create stats container below the chart
            const statsDiv = document.createElement("div");
            statsDiv.id = "tradingStats";
            card.appendChild(statsDiv);
            chartObj = createTradingPerformanceChart(chartContainer, records, statsDiv);
          } else if (metric.chartType === "bookDepth") {
            // Book Depth Chart showing bid vs ask depth
            chartObj = createBookDepthChart(chartContainer, records);
          } else if (metric.chartType === "nearLiquidity") {
            // Near Liquidity Chart showing bid/ask within 1%
            chartObj = createNearLiquidityChart(chartContainer, records);
          } else if (metric.chartType === "wallProximity") {
            // Wall Proximity Chart showing distance to walls
            chartObj = createWallProximityChart(chartContainer, candleData, records);
          } else if (metric.chartType === "wallPrices") {
            // Wall Prices Chart showing wall price levels
            chartObj = createWallPricesChart(chartContainer, candleData, records);
          } else if (metric.chartType === "bookLevels") {
            // Book Levels Chart showing actual price levels
            chartObj = createBookLevelsChart(chartContainer, records, snapshots);
          } else if (metric.chartType === "bookDepthProfile") {
            // Book Depth Profile showing cumulative depth by distance
            chartObj = createBookDepthProfileChart(chartContainer, snapshots);
          } else if (metric.chartType === "bookSpread") {
            // Book Spread Chart showing spread in basis points
            chartObj = createBookSpreadChart(chartContainer, snapshots);
          } else if (metric.chartType === "bookVolume") {
            // Book Volume Chart showing top-of-book volume
            chartObj = createBookVolumeChart(chartContainer, records, snapshots);
          }
          if (chartObj) {
            charts.push({ chart: chartObj.chart, barSeries: chartObj.barSeries, id: metric.id });
          }
          chartCount++;
          continue;
        }
        
        const metricData = validRecords.map((r) => {
          const v = metric.get(r.metrics);
          return { time: r.time, value: v === null || v === undefined || !isFinite(v) ? 0 : v };
        });

        const values = metricData.map((d) => d.value);
        const min = Math.min(...values);
        const max = Math.max(...values);

        const card = document.createElement("div");
        card.className = "metric-card";
        
        // Add inline settings for alpha metrics
        let inlineSettings = "";
        if (metric.settingsId) {
          const sensVal = settings[`alphaSens${metric.settingsId}`] || 50;
          const displayMult = (sensVal / 50).toFixed(1);
          inlineSettings = `
            <div class="alpha-inline-settings" style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:8px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;">
              <span style="font-size:11px;color:#94a3b8;white-space:nowrap;">Sensitivity:</span>
              <span style="font-size:14px;" title="Slower">🐢</span>
              <input type="range" class="alpha-sens-slider" data-mode="${metric.settingsId}" min="0" max="100" value="${sensVal}" step="1" style="flex:1;accent-color:#3b82f6;max-width:180px;"/>
              <span style="font-size:14px;" title="Faster">⚡</span>
              <span class="alpha-sens-value" style="font-size:12px;font-weight:700;color:#e2e8f0;min-width:36px;text-align:center;">${displayMult}x</span>
              <button class="alpha-reset-btn" data-mode="${metric.settingsId}" style="padding:4px 8px;font-size:10px;border-radius:4px;border:1px solid rgba(148,163,184,0.3);background:rgba(148,163,184,0.1);color:#94a3b8;cursor:pointer;" title="Reset to 1.0x">↺</button>
            </div>
          `;
        }
        
        // Add inline settings for grid on price line metrics
        if (metric.hasGrid && metric.isPriceLine) {
          const gridVal = gridSettings[metric.id] || 0.00008;
          inlineSettings = `
            <div class="grid-inline-settings" style="display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:8px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);border-radius:8px;">
              <span style="font-size:11px;color:#94a3b8;white-space:nowrap;">Grid Spacing:</span>
              <input type="number" class="grid-spacing-input" data-metric="${metric.id}" min="0" max="0.1" step="0.00001" value="${gridVal}" style="width:90px;padding:4px 8px;font-size:12px;border-radius:4px;border:1px solid rgba(30,41,59,0.9);background:rgba(2,6,23,0.8);color:#e2e8f0;text-align:center;"/>
              <span style="font-size:11px;color:#64748b;">(0 = off)</span>
              <button class="grid-reset-btn" data-metric="${metric.id}" style="padding:4px 8px;font-size:10px;border-radius:4px;border:1px solid rgba(148,163,184,0.3);background:rgba(148,163,184,0.1);color:#94a3b8;cursor:pointer;" title="Reset to 0.00008">↺</button>
            </div>
          `;
        }
        
        card.innerHTML = `
          ${inlineSettings}
          <div class="metric-card-header">
            <div class="metric-card-title">${metric.label}${metric.isPriceLine ? " (line overlay)" : ""}</div>
            <div class="metric-card-meta">${meta} | Range: ${min.toFixed(2)} – ${max.toFixed(2)}</div>
          </div>
          <div class="metric-card-body" id="chart-${metric.id}"></div>
        `;
        chartsContainer.appendChild(card);
        
        // Attach slider event for alpha metrics
        if (metric.settingsId) {
          const slider = card.querySelector(".alpha-sens-slider");
          const valueSpan = card.querySelector(".alpha-sens-value");
          const resetBtn = card.querySelector(".alpha-reset-btn");
          
          if (slider) {
            slider.addEventListener("input", () => {
              const v = parseInt(slider.value, 10);
              valueSpan.textContent = `${(v / 50).toFixed(1)}x`;
              // Update hidden input
              const hiddenInput = document.getElementById(`alphaSensitivity${metric.settingsId}`);
              if (hiddenInput) hiddenInput.value = v;
              localStorage.setItem(`replay_alphaSens${metric.settingsId}`, v);
            });
            slider.addEventListener("change", () => {
              recomputeAndRender();
            });
          }
          
          // Reset button
          if (resetBtn) {
            resetBtn.addEventListener("click", () => {
              slider.value = 50; // Default = 1.0x
              valueSpan.textContent = "1.0x";
              const hiddenInput = document.getElementById(`alphaSensitivity${metric.settingsId}`);
              if (hiddenInput) hiddenInput.value = 50;
              localStorage.setItem(`replay_alphaSens${metric.settingsId}`, 50);
              recomputeAndRender();
            });
          }
        }
        
        // Attach event listeners for grid settings
        if (metric.hasGrid) {
          const gridInput = card.querySelector(".grid-spacing-input");
          const gridResetBtn = card.querySelector(".grid-reset-btn");
          
          if (gridInput) {
            gridInput.addEventListener("change", () => {
              const val = parseFloat(gridInput.value) || 0;
              gridSettings[metric.id] = val;
              localStorage.setItem(`replay_grid${metric.id.charAt(0).toUpperCase() + metric.id.slice(1)}`, val);
              recomputeAndRender();
            });
          }
          
          if (gridResetBtn) {
            gridResetBtn.addEventListener("click", () => {
              gridInput.value = 0.00008;
              gridSettings[metric.id] = 0.00008;
              localStorage.setItem(`replay_grid${metric.id.charAt(0).toUpperCase() + metric.id.slice(1)}`, 0.00008);
              recomputeAndRender();
            });
          }
        }

        const chartContainer = card.querySelector(".metric-card-body");
        let chartObj;
        if (metric.isPriceLine) {
          const gridSpacing = metric.hasGrid ? (gridSettings[metric.id] || 0) : 0;
          chartObj = createPriceOverlayChart(chartContainer, candleData, metricData, metric.lineColor, gridSpacing);
        } else {
          chartObj = createDualPaneChart(chartContainer, candleData, metricData, metric.color);
        }
        charts.push({ chart: chartObj.chart, barSeries: chartObj.barSeries, metricSeries: chartObj.metricSeries, id: metric.id });
        chartCount++;
      }
    }

    setStatus(`${validRecords.length} bars • ${chartCount} metrics • MM:${settings.alphaSensMM}% Swing:${settings.alphaSensSwing}% HTF:${settings.alphaSensHTF}%`);
    
    // Update Entry Signals panel with the last bar's metrics
    if (validRecords.length > 0) {
      const lastRecord = validRecords[validRecords.length - 1];
      if (lastRecord && lastRecord.metrics) {
        updateEntrySignalsPanel(lastRecord.metrics);
        lastBarTime = lastRecord.time;
      }
    }
    
    // Count signals for logging
    const longSignals = validRecords.filter((r) => r.metrics && r.metrics.entrySignal === "LONG").length;
    const shortSignals = validRecords.filter((r) => r.metrics && r.metrics.entrySignal === "SHORT").length;
    console.log(`[Entry Signals] ${longSignals} LONG, ${shortSignals} SHORT signals detected`);
  }

  function recomputeAndRender() {
    if (snapshots.length === 0) return;
    
    // Save scroll position
    const scrollY = window.scrollY;
    
    const computed = computeAllMetrics();
    renderCharts(computed);
    
    // Restore scroll position after render
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Main Load Handler - Unified approach (no separate modes)
  // ─────────────────────────────────────────────────────────────
  async function handleLoad() {
    // Stop any existing live stream
    disconnectLive();
    clearCharts();

    const symbol = (symbolInput ? symbolInput.value : "").trim().toUpperCase() || "BTC";
    const timeframe = timeframeSelect ? timeframeSelect.value : "1m";
    
    currentSymbol = symbol;
    currentTimeframe = timeframe || "1m";
    isStreaming = true;
    
    if (liveBadge) {
      liveBadge.style.display = "inline-block";
      liveBadge.textContent = "🔴 LIVE";
    }
    
    loadBtn.disabled = true;
    setStatus(`Connecting to live ${currentSymbol}...`);
    updateSystemStatus();
    
    try {
      connectLive(currentSymbol);
      startCountdown();
    } catch (e) {
      isStreaming = false;
      setStatus("Live init error: " + (e?.message || String(e)), true);
    } finally {
      loadBtn.disabled = false;
      updateSystemStatus();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────
  async function init() {
    loadSettingsFromStorage();
    bindSettingsEvents();
    
    loadBtn.addEventListener("click", handleLoad);
    
    // Timeframe changes: re-aggregate and re-render using existing raw 1m bars
    if (timeframeSelect) {
      timeframeSelect.addEventListener("change", () => {
        currentTimeframe = timeframeSelect.value || "1m";
        if (rawSnapshots.length > 0) {
          snapshots = aggregateSnapshots(rawSnapshots, currentTimeframe);
          recomputeAndRender();
          scrollChartsToLatest();
        }
        if (isStreaming) startCountdown();
      });
    }
    
    if (symbolInput) {
      symbolInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleLoad();
      });
    }
    
    updateSystemStatus();
    setStatus("Starting live stream...");
    await handleLoad();
  }
  
  // Cleanup on page unload
  window.addEventListener("beforeunload", () => {
    disconnectLive();
  });

  init().catch((e) => {
    setStatus("Init error: " + e.message, true);
    console.error(e);
  });
})();
