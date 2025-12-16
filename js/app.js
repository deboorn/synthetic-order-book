/**
 * Synthetic Order Book - App Controller
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Main controller for the synthetic order book visualization
 */

/**
 * Smart price formatter that adapts decimal places based on price magnitude
 * Works for any crypto from BTC (~$90k) to SHIB (~$0.00002)
 */
function formatSmartPrice(price, options = {}) {
    if (!price || isNaN(price)) return '$--';
    
    const { prefix = '$', compact = false, showSign = false } = options;
    const absPrice = Math.abs(price);
    
    // Determine appropriate decimal places based on magnitude
    let decimals;
    if (absPrice >= 1000) {
        decimals = compact ? 0 : 2;
    } else if (absPrice >= 100) {
        decimals = 2;
    } else if (absPrice >= 10) {
        decimals = 3;
    } else if (absPrice >= 1) {
        decimals = 4;
    } else if (absPrice >= 0.01) {
        decimals = 5;
    } else if (absPrice >= 0.0001) {
        decimals = 6;
    } else {
        decimals = 8; // For very small prices like SHIB
    }
    
    const sign = showSign && price > 0 ? '+' : '';
    const formatted = absPrice.toLocaleString('en-US', {
        minimumFractionDigits: Math.min(decimals, 2),
        maximumFractionDigits: decimals
    });
    
    return sign + prefix + (price < 0 ? '-' : '') + formatted;
}

/**
 * Format volume with appropriate units (K, M, B) and precision based on coin
 */
function formatSmartVolume(volume, symbol = 'BTC') {
    if (!volume || isNaN(volume)) return '--';
    
    // For very large volumes, use K/M/B notation
    if (volume >= 1000000000) {
        return (volume / 1000000000).toFixed(2) + 'B ' + symbol;
    } else if (volume >= 1000000) {
        return (volume / 1000000).toFixed(2) + 'M ' + symbol;
    } else if (volume >= 1000) {
        return (volume / 1000).toFixed(2) + 'K ' + symbol;
    } else if (volume >= 1) {
        return volume.toFixed(2) + ' ' + symbol;
    } else {
        // For fractional volumes, show more decimals
        return volume.toFixed(4) + ' ' + symbol;
    }
}

// Bundled WAV sounds (served from /sounds/)
const ALERT_SOUND_FILES = [
    'mixkit-arcade-bonus-alert-767.wav',
    'mixkit-arcade-game-explosion-1699.wav',
    'mixkit-arcade-game-explosion-echo-1698.wav',
    'mixkit-arcade-race-game-countdown-1952.wav',
    'mixkit-arcade-retro-game-over-213.wav',
    'mixkit-arcade-retro-run-sound-220.wav',
    'mixkit-arcade-slot-machine-wheel-1933.wav',
    'mixkit-fairy-arcade-sparkle-866.wav',
    'mixkit-repeating-arcade-beep-1084.wav',
    'mixkit-retro-arcade-casino-notification-211.wav',
    'mixkit-retro-arcade-game-over-470.wav',
    'mixkit-retro-arcade-lose-2027.wav',
    'mixkit-retro-game-notification-212.wav',
    'mixkit-retro-video-game-bubble-laser-277.wav',
    'mixkit-synthetic-sci-fi-wobble-278.wav',
    'mixkit-unlock-game-notification-253.wav'
];

function formatAlertSoundLabel(filename) {
    if (!filename) return 'Sound';
    let base = String(filename).replace(/\.[^.]+$/, '');
    base = base.replace(/^mixkit-/, '');
    let code = '';
    const m = base.match(/-(\d+)$/);
    if (m) {
        code = m[1];
        base = base.slice(0, -(m[0].length));
    }
    base = base.replace(/-/g, ' ').trim();
    base = base.replace(/\b\w/g, (c) => c.toUpperCase());
    return code ? `${base} (${code})` : base;
}

function escapeHtml(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clampString(value, maxLen = 280) {
    const s = value === null || value === undefined ? '' : String(value);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + '…';
}

function renderAlertTemplate(template, ctx) {
    const raw = template === null || template === undefined ? '' : String(template);
    if (!raw.trim()) return '';

    const map = {
        symbol: ctx?.symbol ?? '',
        timeframe: ctx?.timeframe ?? '',
        price: ctx?.price ?? '',
        mid: ctx?.mid ?? '',
        vwmp: ctx?.vwmp ?? '',
        ifv: ctx?.ifv ?? '',
        metric: ctx?.metric ?? '',
        condition: ctx?.condition ?? '',
        value: ctx?.value ?? '',
        compare: ctx?.compare ?? '',
        auto: ctx?.auto ?? ''
    };

    return raw.replace(/\{([a-zA-Z_]+)\}/g, (_m, key) => {
        const k = String(key || '').toLowerCase();
        if (!(k in map)) return `{${key}}`;
        const v = map[k];
        return v === null || v === undefined ? '' : String(v);
    });
}

/**
 * AlertsManager (TradingView-style)
 * - Per-symbol persistence (localStorage)
 * - Active alerts + alert log
 * - Bar-aware throttling (once per bar) via `newBarOpened`
 * - Minute throttling (once per minute)
 *
 * NOTE: Metric registry + evaluation logic are layered in via the app
 * (keeps existing indicator logic untouched).
 */
class AlertsManager {
    constructor(app) {
        this.app = app;
        this.symbol = (app?.currentSymbol || 'BTC').toUpperCase();
        this.alerts = [];
        this.log = [];
        this.currentBarId = null; // candleTime (seconds)
        this.metricRegistry = null; // injected later
    }

    // ---------- Storage ----------
    _alertsKey(symbol) {
        return `alerts.v1.${(symbol || this.symbol).toUpperCase()}`;
    }

    _logKey(symbol) {
        return `alerts.log.v1.${(symbol || this.symbol).toUpperCase()}`;
    }

    load(symbol = null) {
        if (symbol) this.symbol = symbol.toUpperCase();

        try {
            const raw = localStorage.getItem(this._alertsKey());
            this.alerts = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(this.alerts)) this.alerts = [];
        } catch (_) {
            this.alerts = [];
        }

        try {
            const rawLog = localStorage.getItem(this._logKey());
            this.log = rawLog ? JSON.parse(rawLog) : [];
            if (!Array.isArray(this.log)) this.log = [];
        } catch (_) {
            this.log = [];
        }
    }

    save() {
        localStorage.setItem(this._alertsKey(), JSON.stringify(this.alerts));
        localStorage.setItem(this._logKey(), JSON.stringify(this.log));
    }

    setSymbol(symbol) {
        const sym = (symbol || 'BTC').toUpperCase();
        if (sym === this.symbol) return;
        this.symbol = sym;
        this.load(sym);
    }

    setCurrentBarId(barId) {
        // barId = candleTime seconds
        this.currentBarId = barId;
    }

    // ---------- CRUD ----------
    list() {
        return this.alerts || [];
    }

    listEnabled() {
        return (this.alerts || []).filter(a => a && a.enabled);
    }

    getById(id) {
        return (this.alerts || []).find(a => a && a.id === id) || null;
    }

    upsert(alert) {
        if (!alert) return;
        const a = { ...alert };
        if (!a.id) a.id = `a_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        if (!a.symbol) a.symbol = this.symbol;
        if (a.enabled === undefined) a.enabled = true;
        if (!a.createdAt) a.createdAt = Date.now();
        if (!a.frequency) a.frequency = 'one_time';
        if (a.notify === undefined) a.notify = true;
        if (a.sound === undefined) a.sound = true;
        if (!a.soundType) a.soundType = 'alarm';

        const idx = (this.alerts || []).findIndex(x => x && x.id === a.id);
        if (idx >= 0) this.alerts[idx] = { ...this.alerts[idx], ...a };
        else this.alerts.push(a);

        this.save();
    }

    remove(id) {
        this.alerts = (this.alerts || []).filter(a => a && a.id !== id);
        this.save();
    }

    toggle(id, enabled) {
        const a = this.getById(id);
        if (!a) return;
        a.enabled = !!enabled;
        this.save();
    }

    clearLog() {
        this.log = [];
        this.save();
        
        // Log is the source-of-truth for persisted alert markers
        this.app?.chart?.clearAlertMarkers?.();
    }

    appendLog(entry) {
        const e = { ...entry, ts: entry?.ts || Date.now(), symbol: this.symbol };
        this.log.unshift(e);
        // cap size (per symbol)
        if (this.log.length > 200) this.log.length = 200;
        this.save();
    }

    // ---------- Delivery ----------
    isNotificationSupported() {
        return typeof Notification !== 'undefined';
    }

    async ensureNotificationPermission() {
        if (!this.isNotificationSupported()) return 'unsupported';
        if (Notification.permission === 'granted') return 'granted';
        if (Notification.permission === 'denied') return 'denied';
        try {
            const perm = await Notification.requestPermission();
            return perm;
        } catch (_) {
            return Notification.permission;
        }
    }

    async ensureAudioUnlocked() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        if (!this._audioCtx) this._audioCtx = new Ctx();
        if (!this._audioBufferCache) this._audioBufferCache = new Map();
        try {
            if (this._audioCtx.state === 'suspended') {
                await this._audioCtx.resume();
            }
        } catch (_) {}
        return this._audioCtx.state === 'running';
    }

    playBeep() {
        if (!this._audioCtx || this._audioCtx.state !== 'running') return;
        try {
            const ctx = this._audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const now = ctx.currentTime;

            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, now);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.2);
        } catch (_) {}
    }

    playChime() {
        if (!this._audioCtx || this._audioCtx.state !== 'running') return;
        try {
            const ctx = this._audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const now = ctx.currentTime;

            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, now);
            osc.frequency.exponentialRampToValueAtTime(660, now + 0.25);

            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.4);
        } catch (_) {}
    }

    playAlarm() {
        if (!this._audioCtx || this._audioCtx.state !== 'running') return;
        try {
            const ctx = this._audioCtx;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const now = ctx.currentTime;

            // Alarm-clock style: repeating two-tone beeps
            osc.type = 'square';
            gain.gain.setValueAtTime(0.0001, now);

            const beeps = [
                { t: 0.00, f: 880, dur: 0.10 },
                { t: 0.16, f: 990, dur: 0.10 },
                { t: 0.44, f: 880, dur: 0.10 },
                { t: 0.60, f: 990, dur: 0.10 }
            ];

            for (const b of beeps) {
                const t0 = now + b.t;
                osc.frequency.setValueAtTime(b.f, t0);
                gain.gain.setValueAtTime(0.0001, t0);
                gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, t0 + b.dur);
            }

            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + 0.8);
        } catch (_) {}
    }

    playSound(type) {
        const raw = type || 'alarm';
        if (typeof raw === 'string' && raw.startsWith('file:')) {
            const url = raw.slice(5);
            return this.playAudioFile(url);
        }
        const t = String(raw).toLowerCase();
        if (t === 'beep') return this.playBeep();
        if (t === 'chime') return this.playChime();
        return this.playAlarm();
    }

    async _getAudioBuffer(url) {
        if (!this._audioCtx || this._audioCtx.state !== 'running') return null;
        if (!url) return null;
        if (this._audioBufferCache?.has(url)) return this._audioBufferCache.get(url);

        try {
            const res = await fetch(url, { cache: 'force-cache' });
            if (!res.ok) return null;
            const arr = await res.arrayBuffer();
            const ctx = this._audioCtx;

            const buffer = await new Promise((resolve, reject) => {
                try {
                    ctx.decodeAudioData(arr, resolve, reject);
                } catch (e) {
                    reject(e);
                }
            });

            if (buffer) this._audioBufferCache?.set(url, buffer);
            return buffer || null;
        } catch (_) {
            return null;
        }
    }

    _playAudioBuffer(buffer, volume = 0.95) {
        if (!this._audioCtx || this._audioCtx.state !== 'running' || !buffer) return;
        try {
            const ctx = this._audioCtx;
            const src = ctx.createBufferSource();
            const gain = ctx.createGain();
            gain.gain.value = volume;
            src.buffer = buffer;
            src.connect(gain);
            gain.connect(ctx.destination);
            src.start();
        } catch (_) {}
    }

    async playAudioFile(url) {
        const ok = await this.ensureAudioUnlocked();
        if (!ok) return;
        const buffer = await this._getAudioBuffer(url);
        if (!buffer) return this.playAlarm();
        this._playAudioBuffer(buffer, 0.95);
    }

    trigger(alert, metric, value, snapshot, compareMetric = null, compareValue = null) {
        const now = Date.now();
        const formatted = metric?.format ? metric.format(value, snapshot) : String(value);
        const rhsFormatted = compareMetric
            ? (compareMetric.format ? compareMetric.format(compareValue, snapshot) : String(compareValue))
            : null;
        const rhsSuffix = rhsFormatted ? ` vs ${rhsFormatted}` : '';
        const baseMsg = `[${snapshot?.symbol || this.symbol}] ${metric?.label || alert.metricKey} ${this._formatCondition(alert)} (${formatted}${rhsSuffix})`;

        // Context snapshot (for rich log rendering)
        const fv = snapshot?.fairValue || {};
        const ctxPrice = snapshot?.price ?? null;
        const ctxMid = fv?.mid ?? null;
        const ctxVwmp = fv?.vwmp ?? null;
        const ctxIfv = fv?.ifv ?? null;
        const ctxLine = (ctxPrice && (ctxVwmp || ctxIfv))
            ? `P ${formatSmartPrice(ctxPrice)} | Mid ${ctxMid ? formatSmartPrice(ctxMid) : '--'} | VWMP ${ctxVwmp ? formatSmartPrice(ctxVwmp) : '--'} | IFV ${ctxIfv ? formatSmartPrice(ctxIfv) : '--'}`
            : '';

        // Optional custom message (templated)
        const customTemplateRaw = (alert?.customMessage || '').toString();
        const templateCtx = {
            symbol: snapshot?.symbol || this.symbol,
            timeframe: snapshot?.timeframe || '',
            price: ctxPrice ? formatSmartPrice(ctxPrice) : '--',
            mid: ctxMid ? formatSmartPrice(ctxMid) : '--',
            vwmp: ctxVwmp ? formatSmartPrice(ctxVwmp) : '--',
            ifv: ctxIfv ? formatSmartPrice(ctxIfv) : '--',
            metric: metric?.label || alert.metricKey || '',
            condition: this._formatCondition(alert),
            value: formatted || '',
            compare: rhsFormatted || (alert?.compareMetricLabel || alert?.compareMetricKey || alert?.target || alert?.threshold || ''),
            auto: baseMsg
        };

        const customRendered = renderAlertTemplate(customTemplateRaw, templateCtx).trim();
        const mainBody = customRendered
            ? (customTemplateRaw.includes('{auto}') ? customRendered : `${customRendered}\n${baseMsg}`)
            : baseMsg;

        const notifyBody = ctxLine ? `${mainBody}\n${ctxLine}` : mainBody;
        const logMessage = mainBody.replace(/\s*\n\s*/g, ' • ');

        // Optional: chart marker plotting (persisted via log entry marker field)
        let alertMarker = null;
        if (alert.plotOnChart) {
            const chart = this.app?.chart;
            const time = snapshot?.barId || chart?.lastCandle?.time || null;
            if (time) {
                const cond = String(alert.condition || '');
                const isUp = cond.includes('above');
                const isDown = cond.includes('below');
                const dir = isUp ? 'up' : isDown ? 'down' : 'neutral';

                const shape = (alert.plotShape === 'auto' || !alert.plotShape)
                    ? (dir === 'up' ? 'arrowUp' : dir === 'down' ? 'arrowDown' : 'circle')
                    : alert.plotShape;
                const position = (alert.plotPosition === 'auto' || !alert.plotPosition)
                    ? (shape === 'arrowUp' ? 'belowBar' : shape === 'arrowDown' ? 'aboveBar' : 'inBar')
                    : alert.plotPosition;
                const color = alert.plotColor
                    ? alert.plotColor
                    : (dir === 'up' ? '#10b981' : dir === 'down' ? '#ef4444' : '#fbbf24');
                const text = (alert.plotText || '').toString().slice(0, 10);

                alertMarker = { time, position, color, shape, text };
            }
        }

        // Track for UI
        alert._lastTriggeredAt = now;

        // Log
        this.appendLog({
            ts: now,
            section: alert.section,
            metricKey: alert.metricKey,
            message: logMessage,
            baseMessage: baseMsg,
            customMessage: customTemplateRaw || null,
            value,
            frequency: alert.frequency,
            timeframe: snapshot?.timeframe || null,
            barId: snapshot?.barId || null,
            price: ctxPrice,
            mid: ctxMid,
            vwmp: ctxVwmp,
            ifv: ctxIfv,
            marker: alertMarker
        });

        // Notification
        if (alert.notify) {
            if (this.isNotificationSupported() && Notification.permission === 'granted') {
                try {
                    new Notification(`${snapshot?.symbol || this.symbol} Alert`, { body: notifyBody });
                } catch (_) {
                    this.app?.showToast?.(clampString(logMessage, 180), 'info');
                }
            } else {
                // Fallback: toast
                this.app?.showToast?.(clampString(logMessage, 180), 'info');
            }
        } else {
            // Still surface via toast (non-intrusive)
            this.app?.showToast?.(clampString(logMessage, 180), 'info');
        }

        if (alertMarker && this.app?.chart?.addAlertMarker) {
            this.app.chart.addAlertMarker(alertMarker);
        }

        // Sound
        if (alert.sound) {
            this.playSound(alert.soundType);
        }

        // Refresh Alerts modal live (only if open)
        if (document.getElementById('alertsModal')?.classList?.contains('open')) {
            this.app?.renderAlertsModal?.();
        }
    }

    // ---------- Evaluation ----------
    setRegistry(registry) {
        this.metricRegistry = registry;
    }

    evaluate(snapshot) {
        // Registry is injected in metrics-registry step
        if (!this.metricRegistry) return;
        const now = Date.now();
        let shouldSave = false;

        for (const alert of (this.alerts || [])) {
            if (!alert || !alert.enabled) continue;
            if (alert.symbol && alert.symbol.toUpperCase() !== this.symbol) continue;

            const metric = this.metricRegistry.getMetric(alert.section, alert.metricKey);
            if (!metric) continue;

            const value = metric.getValue(snapshot);
            if (value === null || value === undefined || (typeof value === 'number' && isNaN(value))) continue;

            let compareMetric = null;
            let compareValue = null;
            if (alert.compareMetricKey) {
                compareMetric = this.metricRegistry.getMetric(alert.section, alert.compareMetricKey);
                compareValue = compareMetric?.getValue?.(snapshot);
                if (compareValue === null || compareValue === undefined || (typeof compareValue === 'number' && isNaN(compareValue))) {
                    // Still update last value for cross tracking, but skip triggering
                    this.metricRegistry.evaluateCondition(alert, value, null);
                    continue;
                }
            }

            const triggered = this.metricRegistry.evaluateCondition(alert, value, compareValue);
            if (!triggered) continue;

            // Throttle by frequency
            if (alert.frequency === 'once_per_min') {
                const lastTs = alert._lastFiredTs || 0;
                if (now - lastTs < 60_000) continue;
                alert._lastFiredTs = now;
            } else if (alert.frequency === 'once_per_bar') {
                const barId = snapshot?.barId ?? this.currentBarId;
                if (!barId) continue;
                const lastBar = alert._lastFiredBarId || null;
                if (lastBar === barId) continue;
                alert._lastFiredBarId = barId;
            } else {
                // one_time: disable after firing (persist)
                alert.enabled = false;
                shouldSave = true;
            }

            this.metricRegistry.fireAlert(alert, metric, value, snapshot, compareMetric, compareValue);
        }

        if (shouldSave) {
            this.save();
            this.app?.updateAlertIndicators?.();
            if (document.getElementById('alertsModal')?.classList?.contains('open')) {
                this.app?.renderAlertsModal?.();
            }
        }
    }

    countBySection() {
        const map = {};
        for (const a of (this.alerts || [])) {
            if (!a || !a.enabled) continue;
            if (!a.section) continue;
            map[a.section] = (map[a.section] || 0) + 1;
        }
        return map;
    }

    _formatCondition(alert) {
        const cond = alert?.condition || '';
        if (cond === 'above') return 'above ' + alert.threshold;
        if (cond === 'below') return 'below ' + alert.threshold;
        if (cond === 'crosses_above') return 'crosses above ' + alert.threshold;
        if (cond === 'crosses_below') return 'crosses below ' + alert.threshold;
        if (cond === 'above_metric') return 'above ' + (alert.compareMetricLabel || alert.compareMetricKey || 'metric');
        if (cond === 'below_metric') return 'below ' + (alert.compareMetricLabel || alert.compareMetricKey || 'metric');
        if (cond === 'crosses_above_metric') return 'crosses above ' + (alert.compareMetricLabel || alert.compareMetricKey || 'metric');
        if (cond === 'crosses_below_metric') return 'crosses below ' + (alert.compareMetricLabel || alert.compareMetricKey || 'metric');
        if (cond === 'is') return 'is ' + alert.target;
        if (cond === 'changes') return 'changed';
        if (cond === 'changes_to') return 'changes to ' + alert.target;
        return cond;
    }
}

/**
 * AlertMetricRegistry
 * Defines available metrics per section and provides condition evaluation.
 */
class AlertMetricRegistry {
    constructor(app) {
        this.app = app;

        this.sections = [
            { key: 'chart', label: 'Main Chart' },
            { key: 'depth', label: 'Market Depth' },
            { key: 'orderflow', label: 'Order Flow' },
            { key: 'forecast', label: 'Price Forecast' },
            { key: 'fairvalue', label: 'Fair Value' },
            { key: 'mcs', label: 'Market Consensus' },
            { key: 'alpha', label: 'Alpha Score' },
            { key: 'regime', label: 'Regime Engine' },
            { key: 'levels', label: 'Key Levels' }
        ];

        // Metric definitions per section
        this.metrics = {
            chart: {
                'price': {
                    key: 'price',
                    label: 'Price',
                    type: 'number',
                    getValue: (s) => s?.price ?? null,
                    format: (v) => formatSmartPrice(Number(v))
                },
                'mid': {
                    key: 'mid',
                    label: 'Mid',
                    type: 'number',
                    getValue: (s) => s?.fairValue?.mid ?? null,
                    format: (v) => formatSmartPrice(Number(v))
                },
                'vwmp': {
                    key: 'vwmp',
                    label: 'VWMP',
                    type: 'number',
                    getValue: (s) => s?.fairValue?.vwmp ?? null,
                    format: (v) => formatSmartPrice(Number(v))
                },
                'ifv': {
                    key: 'ifv',
                    label: 'IFV',
                    type: 'number',
                    getValue: (s) => s?.fairValue?.ifv ?? null,
                    format: (v) => formatSmartPrice(Number(v))
                },
                'ema': {
                    key: 'ema',
                    label: 'EMA',
                    type: 'number',
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        const existing = chart?.emaGrid?.emaValue;
                        if (existing !== null && existing !== undefined) return existing;
                        const candles = chart?.getCandles?.();
                        const period = chart?.emaGrid?.period || parseInt(localStorage.getItem('emaPeriod') || '20');
                        return chart?.calculateEMA ? chart.calculateEMA(candles, period) : null;
                    },
                    format: (v) => formatSmartPrice(Number(v))
                },
                'zema': {
                    key: 'zema',
                    label: 'ZEMA',
                    type: 'number',
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        const existing = chart?.zemaGrid?.zemaValue;
                        if (existing !== null && existing !== undefined) return existing;
                        const candles = chart?.getCandles?.();
                        const period = chart?.zemaGrid?.period || parseInt(localStorage.getItem('zemaPeriod') || '30');
                        return chart?.calculateZEMA ? chart.calculateZEMA(candles, period) : null;
                    },
                    format: (v) => formatSmartPrice(Number(v))
                },
                'bbPulseSignal': {
                    key: 'bbPulseSignal',
                    label: 'BB Pulse Signal',
                    type: 'enum',
                    options: ['NONE', 'BUY', 'SELL', 'BOTH'],
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        const t = chart?.lastCandle?.time;
                        if (!chart || !t) return 'NONE';
                        if (!chart.bbPulse?.enabled) return 'NONE';
                        const markers = chart.bbPulse?.markers || [];
                        const hasBuy = markers.some(m => m && m.time === t && m.shape === 'arrowUp');
                        const hasSell = markers.some(m => m && m.time === t && m.shape === 'arrowDown');
                        if (hasBuy && hasSell) return 'BOTH';
                        if (hasBuy) return 'BUY';
                        if (hasSell) return 'SELL';
                        return 'NONE';
                    }
                },
                'emaGridSignal': {
                    key: 'emaGridSignal',
                    label: 'EMA Grid Signal',
                    type: 'enum',
                    options: ['NONE', 'ARROW_UP', 'ARROW_DOWN', 'BOTH'],
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        const t = chart?.lastCandle?.time;
                        if (!chart || !t) return 'NONE';
                        if (!chart.emaGrid?.showSignals) return 'NONE';
                        const markers = chart.emaSignalMarkers || [];
                        const hasUp = markers.some(m => m && m.time === t && m.shape === 'arrowUp');
                        const hasDown = markers.some(m => m && m.time === t && m.shape === 'arrowDown');
                        if (hasUp && hasDown) return 'BOTH';
                        if (hasUp) return 'ARROW_UP';
                        if (hasDown) return 'ARROW_DOWN';
                        return 'NONE';
                    }
                },
                'zemaGridSignal': {
                    key: 'zemaGridSignal',
                    label: 'ZEMA Grid Signal',
                    type: 'enum',
                    options: ['NONE', 'ARROW_UP', 'ARROW_DOWN', 'BOTH'],
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        const t = chart?.lastCandle?.time;
                        if (!chart || !t) return 'NONE';
                        if (!chart.zemaGrid?.showSignals) return 'NONE';
                        const markers = chart.zemaSignalMarkers || [];
                        const hasUp = markers.some(m => m && m.time === t && m.shape === 'arrowUp');
                        const hasDown = markers.some(m => m && m.time === t && m.shape === 'arrowDown');
                        if (hasUp && hasDown) return 'BOTH';
                        if (hasUp) return 'ARROW_UP';
                        if (hasDown) return 'ARROW_DOWN';
                        return 'NONE';
                    }
                }
            },
            depth: {
                'imbalancePct': {
                    key: 'imbalancePct',
                    label: 'Imbalance %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => s?.depth?.imbalancePct ?? null,
                    format: (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%'
                },
                'bidVolume': {
                    key: 'bidVolume',
                    label: 'Bid Volume',
                    type: 'number',
                    unit: 'vol',
                    getValue: (s) => s?.depth?.totalBid ?? null,
                    format: (v, s) => formatSmartVolume(Number(v), s?.symbol || 'BTC')
                },
                'askVolume': {
                    key: 'askVolume',
                    label: 'Ask Volume',
                    type: 'number',
                    unit: 'vol',
                    getValue: (s) => s?.depth?.totalAsk ?? null,
                    format: (v, s) => formatSmartVolume(Number(v), s?.symbol || 'BTC')
                }
            },
            orderflow: {
                'bpr': {
                    key: 'bpr',
                    label: 'BPR (Bid/Ask Ratio)',
                    type: 'number',
                    getValue: (s) => {
                        const levels = s?.levels || [];
                        const bpr = this.app?.chart?.calculateBPR ? this.app.chart.calculateBPR(levels) : null;
                        return bpr?.ratio ?? null;
                    },
                    format: (v) => Number(v).toFixed(2)
                },
                'ldDelta': {
                    key: 'ldDelta',
                    label: 'LD (Liquidity Delta)',
                    type: 'number',
                    getValue: (s) => {
                        const levels = s?.levels || [];
                        const price = s?.price || 0;
                        const ld = this.app?.chart?.calculateLiquidityDelta ? this.app.chart.calculateLiquidityDelta(levels, price) : null;
                        return ld?.delta ?? null;
                    },
                    format: (v) => {
                        const n = Number(v);
                        const abs = Math.abs(n);
                        if (abs >= 1000) return (n / 1000).toFixed(1) + 'K';
                        return n >= 0 ? '+' + n.toFixed(0) : n.toFixed(0);
                    }
                }
            },
            forecast: {
                'overallBias': {
                    key: 'overallBias',
                    label: 'Overall Bias',
                    type: 'enum',
                    options: ['bullish', 'neutral', 'bearish'],
                    getValue: (s) => s?.direction?.overallBias ?? null,
                    format: (v) => String(v || '').toUpperCase()
                },
                'confidence': {
                    key: 'confidence',
                    label: 'Confidence',
                    type: 'enum',
                    options: ['high', 'medium', 'low'],
                    getValue: (s) => s?.direction?.confidence ?? null,
                    format: (v) => String(v || '').toUpperCase()
                },
                'shortBias': {
                    key: 'shortBias',
                    label: 'Short Bias',
                    type: 'enum',
                    options: ['bullish', 'neutral', 'bearish'],
                    getValue: (s) => s?.direction?.short?.bias ?? null,
                    format: (v) => String(v || '').toUpperCase()
                },
                'mediumBias': {
                    key: 'mediumBias',
                    label: 'Medium Bias',
                    type: 'enum',
                    options: ['bullish', 'neutral', 'bearish'],
                    getValue: (s) => s?.direction?.medium?.bias ?? null,
                    format: (v) => String(v || '').toUpperCase()
                },
                'longBias': {
                    key: 'longBias',
                    label: 'Long Bias',
                    type: 'enum',
                    options: ['bullish', 'neutral', 'bearish'],
                    getValue: (s) => s?.direction?.long?.bias ?? null,
                    format: (v) => String(v || '').toUpperCase()
                }
            },
            fairvalue: {
                'midPct': {
                    key: 'midPct',
                    label: 'Price vs Mid %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => {
                        const mid = s?.fairValue?.mid;
                        const price = s?.price;
                        if (!mid || !price) return null;
                        return ((price - mid) / mid) * 100;
                    },
                    format: (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'
                },
                'vwmpPct': {
                    key: 'vwmpPct',
                    label: 'Price vs VWMP %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => {
                        const vwmp = s?.fairValue?.vwmp;
                        const price = s?.price;
                        if (!vwmp || !price) return null;
                        return ((price - vwmp) / vwmp) * 100;
                    },
                    format: (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'
                },
                'ifvPct': {
                    key: 'ifvPct',
                    label: 'Price vs IFV %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => {
                        const ifv = s?.fairValue?.ifv;
                        const price = s?.price;
                        if (!ifv || !price) return null;
                        return ((price - ifv) / ifv) * 100;
                    },
                    format: (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'
                },
                'suggestedDirection': {
                    key: 'suggestedDirection',
                    label: 'Suggested Direction',
                    type: 'enum',
                    options: ['WAIT', 'LONG', 'SHORT'],
                    getValue: (_s) => {
                        const chart = this.app?.chart;
                        return chart?.tradeSetupRecommendation || 'WAIT';
                    },
                    format: (v) => String(v || '').toUpperCase()
                }
            },
            mcs: {
                'score': {
                    key: 'score',
                    label: 'MCS Score',
                    type: 'number',
                    getValue: (s) => s?.marketConsensus?.mcs ?? null,
                    format: (v) => Number(v).toFixed(0)
                },
                'signal': {
                    key: 'signal',
                    label: 'MCS Signal',
                    type: 'string',
                    getValue: (s) => s?.marketConsensus?.mcsInfo?.label ?? null,
                    format: (v) => String(v || '')
                },
                'mmBias': {
                    key: 'mmBias',
                    label: 'MM Bias',
                    type: 'number',
                    getValue: (s) => s?.marketConsensus?.mmBias ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(0)
                },
                'swingBias': {
                    key: 'swingBias',
                    label: 'Swing Bias',
                    type: 'number',
                    getValue: (s) => s?.marketConsensus?.swingBias ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(0)
                },
                'htfBias': {
                    key: 'htfBias',
                    label: 'HTF Bias',
                    type: 'number',
                    getValue: (s) => s?.marketConsensus?.htfBias ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(0)
                },
                'confidence': {
                    key: 'confidence',
                    label: 'Consensus Confidence',
                    type: 'enum',
                    options: ['HIGH', 'MEDIUM', 'LOW'],
                    getValue: (s) => s?.marketConsensus?.confidence?.level ?? null,
                    format: (v) => String(v || '').toUpperCase()
                }
            },
            alpha: {
                'score': {
                    key: 'score',
                    label: 'Alpha Score',
                    type: 'number',
                    getValue: (s) => s?.alpha ?? null,
                    format: (v) => Number(v).toFixed(0)
                },
                'regime': {
                    key: 'regime',
                    label: 'Alpha Regime',
                    type: 'enum',
                    options: ['bearish', 'neutral', 'bullish'],
                    getValue: (s) => {
                        const a = s?.alpha;
                        if (a === null || a === undefined) return null;
                        if (a <= 30) return 'bearish';
                        if (a >= 70) return 'bullish';
                        return 'neutral';
                    },
                    format: (v) => String(v || '').toUpperCase()
                }
            },
            regime: {
                'type': {
                    key: 'type',
                    label: 'Regime Type',
                    type: 'enum',
                    options: [
                        'neutral',
                        'compression',
                        'mean_reversion',
                        'uptrend',
                        'downtrend',
                        'accumulation',
                        'distribution',
                        'expansion_up',
                        'expansion_down',
                        'vacuum_up',
                        'vacuum_down'
                    ],
                    getValue: (s) => s?.regime?.type ?? null,
                    format: (v) => String(v || '').replace(/_/g, ' ').toUpperCase()
                },
                'ldRoc': {
                    key: 'ldRoc',
                    label: 'LD_ROC',
                    type: 'number',
                    getValue: (s) => s?.regimeSignals?.ld_roc ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2)
                },
                'bprRoc': {
                    key: 'bprRoc',
                    label: 'BPR_ROC',
                    type: 'number',
                    getValue: (s) => s?.regimeSignals?.bpr_roc ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2)
                },
                'alphaRoc': {
                    key: 'alphaRoc',
                    label: 'Alpha_ROC',
                    type: 'number',
                    getValue: (s) => s?.regimeSignals?.alpha_roc ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2)
                },
                'vwmpExt': {
                    key: 'vwmpExt',
                    label: 'VWMP_ext',
                    type: 'number',
                    getValue: (s) => s?.regimeSignals?.vwmp_ext ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + (Number(v) * 100).toFixed(2) + '%'
                },
                'ifvExt': {
                    key: 'ifvExt',
                    label: 'IFV_ext',
                    type: 'number',
                    getValue: (s) => s?.regimeSignals?.ifv_ext ?? null,
                    format: (v) => (Number(v) >= 0 ? '+' : '') + (Number(v) * 100).toFixed(2) + '%'
                }
            },
            levels: {
                'nearestSupportPct': {
                    key: 'nearestSupportPct',
                    label: 'Nearest Support Distance %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => this._nearestLevelDistancePct(s, 'support'),
                    format: (v) => Number(v).toFixed(2) + '%'
                },
                'nearestResistPct': {
                    key: 'nearestResistPct',
                    label: 'Nearest Resistance Distance %',
                    type: 'number',
                    unit: '%',
                    getValue: (s) => this._nearestLevelDistancePct(s, 'resistance'),
                    format: (v) => Number(v).toFixed(2) + '%'
                }
            }
        };
    }

    listSections() {
        return this.sections;
    }

    listMetrics(section) {
        const group = this.metrics?.[section] || {};
        return Object.values(group);
    }

    getMetric(section, metricKey) {
        if (!section || !metricKey) return null;
        const group = this.metrics?.[section] || {};
        return group?.[metricKey] || null;
    }

    getConditionsForMetric(metric) {
        if (!metric) return [];
        if (metric.type === 'number') {
            return [
                { key: 'above', label: 'Above' },
                { key: 'below', label: 'Below' },
                { key: 'crosses_above', label: 'Crosses Above' },
                { key: 'crosses_below', label: 'Crosses Below' },
                { key: 'above_metric', label: 'Above (Metric)' },
                { key: 'below_metric', label: 'Below (Metric)' },
                { key: 'crosses_above_metric', label: 'Crosses Above (Metric)' },
                { key: 'crosses_below_metric', label: 'Crosses Below (Metric)' }
            ];
        }
        if (metric.type === 'enum') {
            return [
                { key: 'changes', label: 'Changes' },
                { key: 'is', label: 'Is' },
                { key: 'changes_to', label: 'Changes To' }
            ];
        }
        // string/event
        return [
            { key: 'changes', label: 'Changes' },
            { key: 'is', label: 'Is' },
            { key: 'changes_to', label: 'Changes To' }
        ];
    }

    evaluateCondition(alert, value, compareValue = null) {
        const metric = this.getMetric(alert.section, alert.metricKey);
        if (!metric) return false;
        const cond = alert.condition || 'above';
        const last = alert._lastValue;

        let triggered = false;

        if (metric.type === 'number') {
            const v = Number(value);
            if (!isFinite(v)) {
                alert._lastValue = value;
                return false;
            }

            if (cond.endsWith('_metric')) {
                if (compareValue === null || compareValue === undefined) {
                    alert._lastValue = v;
                    alert._lastDiff = null;
                    return false;
                }
                const rhs = Number(compareValue);
                if (!isFinite(rhs)) {
                    alert._lastValue = v;
                    alert._lastDiff = null;
                    return false;
                }
                const diff = v - rhs;
                const lastDiff = alert._lastDiff;

                if (cond === 'above_metric') triggered = diff > 0;
                else if (cond === 'below_metric') triggered = diff < 0;
                else if (cond === 'crosses_above_metric') triggered = (lastDiff !== undefined && lastDiff !== null) && lastDiff <= 0 && diff > 0;
                else if (cond === 'crosses_below_metric') triggered = (lastDiff !== undefined && lastDiff !== null) && lastDiff >= 0 && diff < 0;
                else triggered = false;

                alert._lastDiff = diff;
            } else {
                const threshold = Number(alert.threshold);
                if (!isFinite(threshold)) {
                    alert._lastValue = v;
                    return false;
                }

                if (cond === 'above') triggered = v > threshold;
                else if (cond === 'below') triggered = v < threshold;
                else if (cond === 'crosses_above') triggered = (last !== undefined && last !== null) && Number(last) <= threshold && v > threshold;
                else if (cond === 'crosses_below') triggered = (last !== undefined && last !== null) && Number(last) >= threshold && v < threshold;
                else triggered = false;
            }
        } else {
            const v = String(value);
            const target = alert.target !== undefined && alert.target !== null ? String(alert.target) : '';
            if (cond === 'is') triggered = target ? v === target : false;
            else if (cond === 'changes') triggered = (last !== undefined && last !== null) && String(last) !== v;
            else if (cond === 'changes_to') triggered = (last !== undefined && last !== null) && String(last) !== v && target ? v === target : false;
            else triggered = false;
        }

        // Always update last value for cross/change logic
        alert._lastValue = metric.type === 'number' ? Number(value) : value;
        return triggered;
    }

    fireAlert(alert, metric, value, snapshot, compareMetric = null, compareValue = null) {
        // Delegate to AlertsManager delivery (notification + sound + log)
        this.app?.alertsManager?.trigger(alert, metric, value, snapshot, compareMetric, compareValue);
    }

    // ---------- helpers ----------
    _formatCondition(alert) {
        const cond = alert.condition || '';
        if (cond === 'above') return 'above ' + alert.threshold;
        if (cond === 'below') return 'below ' + alert.threshold;
        if (cond === 'crosses_above') return 'crosses above ' + alert.threshold;
        if (cond === 'crosses_below') return 'crosses below ' + alert.threshold;
        if (cond === 'is') return 'is ' + alert.target;
        if (cond === 'changes') return 'changed';
        if (cond === 'changes_to') return 'changes to ' + alert.target;
        return cond;
    }

    _nearestLevelDistancePct(snapshot, type) {
        const price = snapshot?.price || 0;
        if (!price) return null;
        const levels = snapshot?.levels || [];
        const isSupport = type === 'support';
        let best = null;

        for (const l of levels) {
            if (!l || l.type !== type) continue;
            const p = Number(l.price);
            if (!p) continue;
            if (isSupport && p > price) continue;
            if (!isSupport && p < price) continue;
            if (best === null) best = p;
            else {
                if (isSupport) best = Math.max(best, p); // closest below
                else best = Math.min(best, p); // closest above
            }
        }

        if (!best) return null;
        const dist = isSupport ? (price - best) / price * 100 : (best - price) / price * 100;
        return Math.max(0, dist);
    }
}

class OrderBookApp {
    constructor() {
        this.chart = null;
        this.depthChart = null;
        this.currentPrice = 0;
        this.previousPrice = 0;
        this.levels = [];           // Filtered levels (for chart display)
        this.fullBookLevels = [];   // Full order book (for analytics)
        this.useFullBookForAnalytics = true; // Default: use full book for analytics
        this.filter = 'all';
        this.refreshInterval = null;
        this.priceInterval = null;
        this.countdownInterval = null;
        this.isLoading = false;
        this.priceUpdateRate = 500; // ms - 2 price updates per second (respectful)
        this.selectedExchanges = this.loadExchanges();
        this.currentSymbol = localStorage.getItem('selectedSymbol') || 'BTC';
        this.currentTimeframe = localStorage.getItem('selectedTimeframe') || '4h';
        this.lastDirectionUpdate = 0;
        
        // Alerts (per-symbol)
        this.alertsManager = new AlertsManager(this);
        this._alertsEvalInterval = null;
        this._alertsEvalIntervalMs = 10_000;
        
        // Level settings - load from localStorage or use defaults
        this.levelSettings = this.loadSettings();
        
        // DOM elements
        this.elements = {};
    }

    async init() {
        console.log('Initializing Order Book App...');
        
        // Initialize IndexedDB with current symbol
        try {
            await db.init();
            db.setSymbol(this.currentSymbol);
            console.log('IndexedDB initialized for', this.currentSymbol);
            
            // Cleanup old historical levels (>7 days old)
            if (db.cleanupHistoricalLevels) {
                db.cleanupHistoricalLevels(7).catch(err => {
                    console.warn('Failed to cleanup old historical levels:', err);
                });
            }
        } catch (error) {
            console.error('Failed to initialize IndexedDB:', error);
        }

        // Cache DOM elements
        this.cacheElements();

        // Load alerts for current symbol (per-symbol persistence)
        if (this.alertsManager) {
            this.alertsManager.load(this.currentSymbol);
        }

        // Initialize charts with current symbol
        this.chart = new OrderBookChart('chartContainer');
        this.chart.setSymbol(this.currentSymbol);
        this.chart.setColors({
            barUp: this.levelSettings.barUpColor,
            barDown: this.levelSettings.barDownColor,
            levelSupport: this.levelSettings.levelSupportColor,
            levelResistance: this.levelSettings.levelResistanceColor
        });
        this.chart.setLevelAppearance({
            brightness: this.levelSettings.brightness,
            thickness: this.levelSettings.thickness
        });
        this.chart.init();
        
        this.depthChart = new DepthChart('depthChart').init();

        // Alerts metric registry (read-only access to computed state)
        this.alertMetricRegistry = new AlertMetricRegistry(this);
        if (this.alertsManager) {
            this.alertsManager.setRegistry(this.alertMetricRegistry);
        }

        // Setup event listeners
        this.setupEventListeners();
        
        // Paint initial alert badges/dot (based on stored alerts)
        this.updateAlertIndicators();
        
        // Alerts heartbeat (ensures alerts check at least every N seconds)
        this.startAlertsScheduler(this._alertsEvalIntervalMs);
        
        // Restore alert markers from log (persisted until log is cleared)
        this.restoreAlertMarkersFromLog();

        // Set API symbol BEFORE loading data (critical for correct symbol data)
        api.setSymbol(this.currentSymbol);
        
        // Initialize projection toggles from saved state BEFORE loading data
        // This ensures showLevels and other toggles are applied before data renders
        this.initProjectionToggles();

        // Load initial data
        await this.loadData();

        // Setup auto-refresh for full data
        this.setupAutoRefresh();

        // Setup fast price ticker (2x per second)
        this.setupPriceTicker();

        // Initialize exchange selector from saved state
        this.initExchangeCheckboxes();

        // Load price visibility preference
        this.loadPriceVisibility();
        
        // Setup sidebar collapse functionality
        this.setupSidebarCollapse();
        
        // Set initial symbol in UI
        this.elements.symbolInput.value = this.currentSymbol;
        
        // Update all symbol labels
        this.updateSymbolLabels();

        // Update cache status
        this.updateCacheStatus();
        
        // Initialize WebSocket Order Book
        this.initWebSocketOrderBook();

        console.log('Order Book App initialized');
    }

    startAlertsScheduler(intervalMs = 10_000) {
        const ms = Math.max(2000, Number(intervalMs) || 10_000);
        this._alertsEvalIntervalMs = ms;

        if (this._alertsEvalInterval) {
            clearInterval(this._alertsEvalInterval);
            this._alertsEvalInterval = null;
        }

        this._alertsEvalInterval = setInterval(() => {
            this.evaluateAlertsHeartbeat();
        }, ms);
    }

    evaluateAlertsHeartbeat() {
        if (!this.alertsManager) return;
        if (!this.currentPrice) return;
        if (this.alertsManager.listEnabled().length === 0) return;

        const levels = this.getCurrentAnalyticsLevelsForAlerts();
        const snapshot = this.getAlertsSnapshot(levels);
        this.alertsManager.evaluate(snapshot);
    }
    
    /**
     * Initialize WebSocket Order Book connections
     */
    initWebSocketOrderBook() {
        if (typeof orderBookWS === 'undefined') {
            console.warn('[App] WebSocket Order Book not available');
            return;
        }
        
        // Set symbol and connect
        orderBookWS.setSymbol(this.currentSymbol);
        
        // Set exchange enabled states from our checkboxes
        orderBookWS.setExchangeEnabled('kraken', this.selectedExchanges.includes('kraken'));
        orderBookWS.setExchangeEnabled('coinbase', this.selectedExchanges.includes('coinbase'));
        orderBookWS.setExchangeEnabled('bitstamp', this.selectedExchanges.includes('bitstamp'));
        
        // Setup event listeners
        orderBookWS.on('update', (data) => {
            this.handleWebSocketOrderBookUpdate(data);
        });
        
        orderBookWS.on('connect', (exchange, status) => {
            this.updateDataSourceIndicator(status);
            console.warn(`[App] Order Book WS connected: ${exchange}`);
        });
        
        orderBookWS.on('disconnect', (exchange, status) => {
            this.updateDataSourceIndicator(status);
            console.warn(`[App] Order Book WS disconnected: ${exchange}`);
        });
        
        // Connect
        orderBookWS.connect();
    }
    
    /**
     * Handle real-time WebSocket order book updates
     * Throttled to prevent UI overload
     */
    handleWebSocketOrderBookUpdate(rawBook) {
        // Skip if WebSocket is backup only
        if (!api.isWebSocketReady()) return;
        
        // Additional throttle for heavy operations (analytics, UI updates)
        // Chart levels update at 500ms from WS, but analytics only every 2s
        const now = Date.now();
        if (!this._lastAnalyticsUpdate) this._lastAnalyticsUpdate = 0;
        if (!this._lastDepthUpdate) this._lastDepthUpdate = 0;
        const analyticsThrottle = 2000; // 2 seconds for heavy analytics
        const depthThrottle = 1000; // 1 second for depth chart
        const shouldUpdateAnalytics = (now - this._lastAnalyticsUpdate) >= analyticsThrottle;
        const shouldUpdateDepth = (now - this._lastDepthUpdate) >= depthThrottle;
        
        // Process through aggregator
        if (typeof orderBookAggregator === 'undefined') return;
        
        // Update aggregator settings
        orderBookAggregator.setSettings({
            clusterPct: this.levelSettings.clusterPct,
            maxLevels: this.levelSettings.maxLevels,
            minVolume: this.levelSettings.minVolume,
            priceRangePct: this.levelSettings.priceRange
        });
        
        // Process for chart display (with clustering/filtering)
        const processed = orderBookAggregator.process(rawBook, this.currentPrice);
        if (!processed) return;
        
        // Update price from order book if available
        if (rawBook.price && rawBook.price > 0) {
            this.currentPrice = rawBook.price;
        }
        
        // Update levels on chart (fast - OK at 500ms)
        this.levels = processed.levels;
        this.chart.setLevels(this.levels);
        
        // Update depth chart (medium frequency - 1 second)
        if (shouldUpdateDepth && this.depthChart) {
            this._lastDepthUpdate = now;
            
            // Process depth data with cumulative volumes
            const depthData = orderBookAggregator.processDepth(rawBook, this.currentPrice);
            this.depthChart.setData(depthData);
            
            // Update depth stats
            this.updateDepthStats(depthData);
            
            // Update depth sources badge to show Live status
            const sources = rawBook.sources || [];
            this.elements.depthSources.textContent = sources.length + ' exchange' + (sources.length !== 1 ? 's' : '');
            
            // Update badge to show "Live" instead of "Cached"
            const depthBadge = document.querySelector('.depth-panel .panel-badge');
            if (depthBadge) {
                depthBadge.textContent = 'Live';
                depthBadge.classList.remove('cached');
                depthBadge.classList.add('live');
            }
        }
        
        // Heavy operations - only every 2 seconds
        if (shouldUpdateAnalytics) {
            this._lastAnalyticsUpdate = now;
            
            // Process full book for analytics (no clustering)
            const fullBook = orderBookAggregator.processFullBook(rawBook, this.currentPrice);
            if (fullBook) {
                this.fullBookLevels = fullBook.levels;
            }
            
            // Update analytics panels
            this.updateAnalyticsData();
            
            // Update UI list
            this.renderLevelsList();
            
            // Update data source indicator
            this.updateDataSourceIndicator(orderBookWS.getConnectionStatus());
            
            // Update last update time
            const nowDate = new Date();
            this.elements.lastUpdate.textContent = `Last update: ${nowDate.toLocaleTimeString()}`;
        }
    }
    
    /**
     * Update data source indicator in footer
     */
    updateDataSourceIndicator(status) {
        const indicator = document.getElementById('dataSourceIndicator');
        if (!indicator) return;
        
        const label = indicator.querySelector('.source-label');
        
        indicator.classList.remove('websocket', 'disconnected');
        
        if (status && status.anyConnected) {
            indicator.classList.add('websocket');
            const connectedCount = [status.kraken, status.coinbase, status.bitstamp].filter(Boolean).length;
            label.textContent = `WS (${connectedCount}/3)`;
            indicator.title = `WebSocket connected: ${
                [status.kraken && 'Kraken', status.coinbase && 'Coinbase', status.bitstamp && 'Bitstamp']
                    .filter(Boolean).join(', ')
            }`;
        } else {
            indicator.classList.add('disconnected');
            label.textContent = 'Offline';
            indicator.title = 'No data connection';
        }
    }

    setupPriceTicker() {
        // Clear existing interval (fallback polling)
        if (this.priceInterval) {
            clearInterval(this.priceInterval);
        }

        // Use WebSocket for real-time streaming with OHLC support
        wsManager.connect(
            this.currentSymbol,
            this.currentTimeframe,
            // Price update callback (for price display)
            (priceData) => {
                this.previousPrice = this.currentPrice;
                this.currentPrice = priceData.price;
                this.updatePriceDisplay(priceData.price, priceData);
                
                // Update connection status - show if price is from OHLC (accurate) or averaged
                const sourceLabel = priceData.priceSource === 'ohlc' ? 
                    '<span class="ohlc-badge">OHLC</span>' : 
                    `<span class="avg-badge">${priceData.sources}x</span>`;
                this.elements.exchangeStatus.innerHTML = 
                    `<span class="status-dot connected"></span><span>Live ${sourceLabel}</span>`;
            },
            // OHLC update callback (for chart - this is the accurate candle stream!)
            (ohlcData) => {
                // Update chart directly from Kraken OHLC stream
                if (this.chart) {
                    this.chart.updateFromOHLC(ohlcData);
                }
            },
            // Error callback
            (error) => {
                this.showSymbolError(error);
            }
        );

        // Fallback: poll every 5 seconds if WebSocket fails
        this.priceInterval = setInterval(() => {
            if (!wsManager.isConnected) {
                this.updatePriceFallback();
            }
        }, 5000);
    }

    async updatePriceFallback() {
        try {
            const response = await api.getPrice();
            if (response.success && response.data) {
                this.previousPrice = this.currentPrice;
                this.currentPrice = response.data.price;
                this.updatePriceDisplay(response.data.price, response.data);
            }
        } catch (error) {
            // Silently fail - price updates are non-critical
        }
    }

    cacheElements() {
        this.elements = {
            currentPrice: document.getElementById('currentPrice'),
            priceDisplay: document.getElementById('priceDisplay'),
            priceToggle: document.getElementById('priceToggle'),
            symbolInput: document.getElementById('symbolInput'),
            exchangeStatus: document.getElementById('exchangeStatus'),
            showLevels: document.getElementById('showLevels'),
            showNearestClusterWinner: document.getElementById('showNearestClusterWinner'),
            showVolume: document.getElementById('showVolume'),
            showTargets: document.getElementById('showTargets'),
            showRays: document.getElementById('showRays'),
            showConfidence: document.getElementById('showConfidence'),
            showEmaGrid: document.getElementById('showEmaGrid'),
            showZemaGrid: document.getElementById('showZemaGrid'),
            showBBPulse: document.getElementById('showBBPulse'),
            showMid: document.getElementById('showMid'),
            showIFV: document.getElementById('showIFV'),
            showVWMP: document.getElementById('showVWMP'),
            // Historical features disabled - hidden inputs
            useFullBook: document.getElementById('useFullBook'),
            depthSources: document.getElementById('depthSources'),
            totalBidVol: document.getElementById('totalBidVol'),
            totalAskVol: document.getElementById('totalAskVol'),
            imbalance: document.getElementById('imbalance'),
            levelsList: document.getElementById('levelsList'),
            cacheStatus: document.getElementById('cacheStatus'),
            lastUpdate: document.getElementById('lastUpdate'),
            barCountdown: document.getElementById('barCountdown')
        };
    }

    setupEventListeners() {
        // Timeframe selector dropdown
        const tfSelect = document.getElementById('timeframeSelect');
        if (tfSelect) {
            tfSelect.value = this.currentTimeframe;
            tfSelect.addEventListener('change', (e) => {
                this.loadKlines(e.target.value);
            });
        }

        // Listen for new bar opened event - refresh klines to merge with API data
        // Only refresh if NOT from OHLC stream (OHLC stream is already accurate)
        window.addEventListener('newBarOpened', (e) => {
            const source = e.detail?.source;
            const barTime = e.detail?.time;
            if (this.alertsManager && barTime) {
                this.alertsManager.setCurrentBarId(barTime);
            }
            
            // Reset countdown timer
            this.updateBarCountdown();

            // Freeze nearest-cluster winner marker for the bar that just closed
            this.onNearestClusterWinnerBarClosed(e.detail);
            
            // Only fetch API data periodically, not on every OHLC update
            // OHLC stream provides accurate real-time data
            if (source !== 'ohlc_stream') {
                console.log('[App] New bar opened (non-OHLC), refreshing klines...');
                setTimeout(() => {
                    this.refreshKlinesQuietly();
                }, 2000);
            }
        });

        // Start bar countdown timer
        this.startBarCountdown();

        // Toggle switches
        this.elements.showLevels.addEventListener('change', (e) => {
            this.chart.toggleLevels(e.target.checked);
            localStorage.setItem('showLevels', e.target.checked);
            if (e.target.checked && this.levels.length) {
                this.chart.setLevels(this.levels);
            }
        });

        // Nearest cluster winner marker toggle (per-bar arrow + %)
        if (this.elements.showNearestClusterWinner) {
            this.elements.showNearestClusterWinner.addEventListener('change', (e) => {
                if (this.chart && this.chart.toggleNearestClusterWinner) {
                    this.chart.toggleNearestClusterWinner(e.target.checked);
                }
                localStorage.setItem('showNearestClusterWinner', e.target.checked);
            });
        }

        this.elements.showVolume.addEventListener('change', (e) => {
            this.chart.toggleVolume(e.target.checked);
        });
        
        // Historical levels - DISABLED for WebSocket performance
        // Features hidden in UI, kept disabled internally for now
        this.chart.setHistoricalLevelsEnabled(false);
        this.chart.setHistoricalFairValueEnabled(false);
        
        // Update throttle slider
        const throttleSlider = document.getElementById('settingUpdateThrottle');
        const throttleValue = document.getElementById('updateThrottleValue');
        if (throttleSlider) {
            // Load saved value
            const savedThrottle = localStorage.getItem('updateThrottle') || '500';
            throttleSlider.value = savedThrottle;
            if (throttleValue) throttleValue.textContent = savedThrottle + 'ms';
            
            // Apply saved throttle to WebSocket
            if (typeof orderBookWS !== 'undefined') {
                orderBookWS.updateThrottle = parseInt(savedThrottle);
            }
            
            throttleSlider.addEventListener('input', (e) => {
                const val = e.target.value;
                if (throttleValue) throttleValue.textContent = val + 'ms';
                localStorage.setItem('updateThrottle', val);
                
                // Apply to WebSocket order book
                if (typeof orderBookWS !== 'undefined') {
                    orderBookWS.updateThrottle = parseInt(val);
                }
            });
        }
        
        // LD Flow Zones toggle
        document.getElementById('showLDFlowZones')?.addEventListener('change', (e) => {
            this.chart.setLDFlowZonesEnabled(e.target.checked);
        });
        
        // Projection toggles
        this.elements.showTargets.addEventListener('change', (e) => {
            this.chart.toggleTargetLines(e.target.checked);
            localStorage.setItem('showTargets', e.target.checked);
            // Update projection data if enabling
            if (e.target.checked) {
                this.updateProjections();
            }
        });
        
        this.elements.showRays.addEventListener('change', (e) => {
            this.chart.toggleRays(e.target.checked);
            localStorage.setItem('showRays', e.target.checked);
            // Update projection data if enabling
            if (e.target.checked) {
                this.updateProjections();
            }
        });
        
        this.elements.showConfidence.addEventListener('change', (e) => {
            this.chart.toggleConfidence(e.target.checked);
            if (typeof directionAnalysis !== 'undefined') {
                directionAnalysis.setShowConfidence(e.target.checked);
            }
            localStorage.setItem('showConfidence', e.target.checked);
            // Redraw projections with confidence
            this.updateProjections();
        });
        
        // EMA Grid toggle
        this.elements.showEmaGrid.addEventListener('change', (e) => {
            this.chart.toggleEmaGrid(e.target.checked);
            localStorage.setItem('showEmaGrid', e.target.checked);
        });
        
        // ZEMA Grid toggle
        const showZemaGridEl = document.getElementById('showZemaGrid');
        if (showZemaGridEl) {
            showZemaGridEl.addEventListener('change', (e) => {
                this.chart.toggleZemaGrid(e.target.checked);
                localStorage.setItem('showZemaGrid', e.target.checked);
            });
        }
        
        // EMA Signals toggle
        const showEmaSignalsEl = document.getElementById('showEmaSignals');
        if (showEmaSignalsEl) {
            showEmaSignalsEl.addEventListener('change', (e) => {
                this.chart.toggleEmaSignals(e.target.checked);
                localStorage.setItem('showEmaSignals', e.target.checked);
            });
        }
        
        // ZEMA Signals toggle
        const showZemaSignalsEl = document.getElementById('showZemaSignals');
        if (showZemaSignalsEl) {
            showZemaSignalsEl.addEventListener('change', (e) => {
                this.chart.toggleZemaSignals(e.target.checked);
                localStorage.setItem('showZemaSignals', e.target.checked);
            });
        }
        
        // BB Pulse toggle
        const showBBPulseEl = document.getElementById('showBBPulse');
        if (showBBPulseEl) {
            showBBPulseEl.addEventListener('change', (e) => {
                this.chart.toggleBBPulse(e.target.checked);
            });
        }
        
        // Mid (Simple Mid Price) toggle
        this.elements.showMid.addEventListener('change', (e) => {
            this.chart.toggleMid(e.target.checked);
            localStorage.setItem('showMid', e.target.checked);
        });
        
        // IFV (Implied Fair Value) toggle
        this.elements.showIFV.addEventListener('change', (e) => {
            this.chart.toggleIFV(e.target.checked);
            localStorage.setItem('showIFV', e.target.checked);
        });
        
        // VWMP (Volume-Weighted Mid Price) toggle
        this.elements.showVWMP.addEventListener('change', (e) => {
            this.chart.toggleVWMP(e.target.checked);
            localStorage.setItem('showVWMP', e.target.checked);
        });
        
        // Full Book toggle for analytics
        this.elements.useFullBook.addEventListener('change', (e) => {
            this.useFullBookForAnalytics = e.target.checked;
            localStorage.setItem('useFullBook', e.target.checked);
            // Re-run analytics with the appropriate data set
            this.updateAnalyticsData();
        });
        
        // Load saved projection preferences
        const savedShowTargets = localStorage.getItem('showTargets') === 'true';
        const savedShowRays = localStorage.getItem('showRays') === 'true';
        const savedShowConfidence = localStorage.getItem('showConfidence') === 'true';
        const savedShowEmaGrid = localStorage.getItem('showEmaGrid') === 'true';
        const savedShowZemaGrid = localStorage.getItem('showZemaGrid') === 'true';
        const savedShowBBPulse = localStorage.getItem('showBBPulse') === 'true';
        const savedShowMid = localStorage.getItem('showMid') === 'true';
        const savedShowIFV = localStorage.getItem('showIFV') === 'true';
        const savedShowVWMP = localStorage.getItem('showVWMP') === 'true';
        const savedShowNearestClusterWinner = localStorage.getItem('showNearestClusterWinner') === 'true';
        // Historical features disabled - no longer loading these settings
        const savedShowLDFlowZones = localStorage.getItem('showLDFlowZones') !== 'false'; // Default true
        const savedUseFullBook = localStorage.getItem('useFullBook') !== 'false'; // Default true
        this.elements.showTargets.checked = savedShowTargets;
        this.elements.showRays.checked = savedShowRays;
        this.elements.showConfidence.checked = savedShowConfidence;
        const showLDFlowZonesEl = document.getElementById('showLDFlowZones');
        if (showLDFlowZonesEl) {
            showLDFlowZonesEl.checked = savedShowLDFlowZones;
            this.chart.setLDFlowZonesEnabled(savedShowLDFlowZones);
        }
        this.elements.showEmaGrid.checked = savedShowEmaGrid;
        if (this.elements.showZemaGrid) {
            this.elements.showZemaGrid.checked = savedShowZemaGrid;
        }
        if (this.elements.showBBPulse) {
            this.elements.showBBPulse.checked = savedShowBBPulse;
        }
        if (this.elements.showNearestClusterWinner) {
            this.elements.showNearestClusterWinner.checked = savedShowNearestClusterWinner;
            if (this.chart && this.chart.toggleNearestClusterWinner) {
                this.chart.toggleNearestClusterWinner(savedShowNearestClusterWinner);
            }
        }
        this.elements.showMid.checked = savedShowMid;
        this.elements.showIFV.checked = savedShowIFV;
        this.elements.showVWMP.checked = savedShowVWMP;
        this.elements.useFullBook.checked = savedUseFullBook;
        this.useFullBookForAnalytics = savedUseFullBook;

        // Price visibility toggle
        this.elements.priceToggle.addEventListener('click', () => {
            this.togglePriceVisibility();
        });

        // Symbol input - change on Enter or blur
        this.elements.symbolInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.target.blur();
                this.changeSymbol(e.target.value);
            }
        });
        
        this.elements.symbolInput.addEventListener('blur', (e) => {
            this.changeSymbol(e.target.value);
        });

        // Currency quick-switch buttons (mobile)
        document.querySelectorAll('.currency-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const symbol = e.target.dataset.symbol;
                if (symbol && symbol !== this.currentSymbol) {
                    // Update active state
                    document.querySelectorAll('.currency-btn').forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    // Change symbol
                    this.changeSymbol(symbol);
                }
            });
        });

        // Level filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.filter = e.target.dataset.filter;
                this.renderLevelsList();
            });
        });

        // Key Levels panel toggle (click header to expand/collapse)
        const levelsPanel = document.querySelector('.levels-panel');
        // Setup collapsible panels - all panels with .collapsible class
        this.setupCollapsiblePanels();
        
        // Setup LD Trading Guide toggle
        this.chart.initLDTradingGuideToggle();
        
        // Setup Alpha mode selector and sensitivity slider
        this.setupAlphaModeSelector();
        this.setupAlphaSensitivitySlider();
        
        // Setup regime mode selector
        this.setupRegimeModeSelector();
        
        // Setup MCS mode selector
        this.setupMCSModeSelector();

        // Auto-refresh removed - WebSocket streams data in real-time

        // Level highlight from chart
        window.addEventListener('levelHighlight', (e) => {
            this.highlightLevel(e.detail.level);
        });

        // Level item click - scroll chart to level
        this.elements.levelsList.addEventListener('click', (e) => {
            const levelItem = e.target.closest('.level-item');
            if (levelItem) {
                const price = parseFloat(levelItem.dataset.price);
                if (price) {
                    // TODO: Implement scroll to price on chart
                    this.highlightLevelByPrice(price);
                }
            }
        });

        // Exchange selector dropdown
        const depthSources = document.getElementById('depthSources');
        const exchangeDropdown = document.getElementById('exchangeDropdown');
        
        depthSources.addEventListener('click', (e) => {
            e.stopPropagation();
            exchangeDropdown.classList.toggle('open');
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            exchangeDropdown.classList.remove('open');
        });

        exchangeDropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Exchange checkboxes
        ['exKraken', 'exCoinbase', 'exBitstamp'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                this.updateSelectedExchanges();
                this.loadData(); // Refresh data with new selection
            });
        });

        // Legend modal
        document.getElementById('btnLegend').addEventListener('click', () => {
            document.getElementById('legendModal').classList.add('open');
            this.syncModalBodyLock();
        });
        
        document.getElementById('closeLegend').addEventListener('click', () => {
            document.getElementById('legendModal').classList.remove('open');
            this.syncModalBodyLock();
        });
        
        document.querySelector('#legendModal .modal-backdrop').addEventListener('click', () => {
            document.getElementById('legendModal').classList.remove('open');
            this.syncModalBodyLock();
        });

        // Alerts modal (TradingView-style)
        const btnAlerts = document.getElementById('btnAlerts');
        if (btnAlerts) {
            btnAlerts.addEventListener('click', () => {
                if (typeof this.openAlertsModal === 'function') {
                    this.openAlertsModal();
                } else {
                    this.showToast('Alerts loading...', 'info');
                }
            });
        }

        // Quick create: Chart alert (price/mid/ema/zema/vwmp/etc.)
        const btnChartAlert = document.getElementById('btnChartAlert');
        if (btnChartAlert) {
            btnChartAlert.addEventListener('click', () => {
                if (typeof this.openAddAlertModal === 'function') {
                    this.openAddAlertModal('chart');
                }
            });
        }

        // Alerts modal wiring
        const alertsModal = document.getElementById('alertsModal');
        if (alertsModal) {
            document.getElementById('closeAlerts')?.addEventListener('click', () => {
                alertsModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            alertsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
                alertsModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            document.getElementById('btnCreateAlertFromModal')?.addEventListener('click', () => {
                if (typeof this.openAddAlertModal === 'function') {
                    this.openAddAlertModal(null);
                }
            });
            alertsModal.querySelectorAll('.alerts-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    this.switchAlertsTab(tab.dataset.tab);
                });
            });
            document.getElementById('clearAlertsLog')?.addEventListener('click', () => {
                if (this.alertsManager && typeof this.alertsManager.clearLog === 'function') {
                    this.alertsManager.clearLog();
                    this.renderAlertsModal?.();
                }
            });

            // Active alerts list interactions (toggle/edit/delete)
            const activeList = document.getElementById('activeAlertsList');
            activeList?.addEventListener('click', (e) => {
                const row = e.target.closest?.('.alert-row');
                if (!row) return;
                const id = row.dataset.alertId;
                if (!id) return;
                if (e.target.closest?.('.alert-edit-btn')) {
                    this.openEditAlertModal(id);
                } else if (e.target.closest?.('.alert-delete-btn')) {
                    this.alertsManager?.remove(id);
                    this.updateAlertIndicators();
                    this.renderAlertsModal();
                }
            });
            activeList?.addEventListener('change', (e) => {
                if (!e.target.classList?.contains('alert-enabled-toggle')) return;
                const row = e.target.closest?.('.alert-row');
                const id = row?.dataset?.alertId;
                if (!id) return;
                this.alertsManager?.toggle(id, e.target.checked);
                this.updateAlertIndicators();
                this.renderAlertsModal();
            });
        }

        const alertEditModal = document.getElementById('alertEditModal');
        if (alertEditModal) {
            document.getElementById('closeAlertEdit')?.addEventListener('click', () => {
                alertEditModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            document.getElementById('cancelAlertEdit')?.addEventListener('click', () => {
                alertEditModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            alertEditModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
                alertEditModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            document.getElementById('alertForm')?.addEventListener('submit', (e) => {
                e.preventDefault();
                if (typeof this.handleAlertFormSubmit === 'function') {
                    this.handleAlertFormSubmit();
                } else {
                    this.showToast('Alerts loading...', 'info');
                }
            });

            // Reactive editor UI
            document.getElementById('alertSection')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertMetric')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertCondition')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertCompareMetric')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertTarget')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertCustomMessage')?.addEventListener('input', () => this.populateAlertEditorUI());
            document.getElementById('alertSound')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertSoundType')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('previewAlertSound')?.addEventListener('click', () => this.previewSelectedAlertSound());
            document.getElementById('alertPlotOnChart')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertPlotShape')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertPlotPosition')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertPlotColor')?.addEventListener('change', () => this.populateAlertEditorUI());
            document.getElementById('alertPlotText')?.addEventListener('input', () => this.populateAlertEditorUI());
        }

        const alertsDisclaimerModal = document.getElementById('alertsDisclaimerModal');
        if (alertsDisclaimerModal) {
            const chk = document.getElementById('alertsDisclaimerCheck');
            const btnContinue = document.getElementById('alertsDisclaimerContinue');
            const setContinueEnabled = () => {
                if (btnContinue) btnContinue.disabled = !chk?.checked;
            };
            chk?.addEventListener('change', setContinueEnabled);
            setContinueEnabled();

            document.getElementById('closeAlertsDisclaimer')?.addEventListener('click', () => {
                this._pendingAlertSave = null;
                alertsDisclaimerModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            document.getElementById('alertsDisclaimerCancel')?.addEventListener('click', () => {
                this._pendingAlertSave = null;
                alertsDisclaimerModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            alertsDisclaimerModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
                this._pendingAlertSave = null;
                alertsDisclaimerModal.classList.remove('open');
                this.syncModalBodyLock();
            });
            document.getElementById('alertsDisclaimerContinue')?.addEventListener('click', () => {
                if (!chk?.checked) return;
                if (typeof this.confirmAlertsDisclaimer === 'function') {
                    this.confirmAlertsDisclaimer();
                } else {
                    alertsDisclaimerModal.classList.remove('open');
                    this.syncModalBodyLock();
                }
            });
        }

        // Fullscreen chart toggle (mobile/tablet)
        const btnFullscreen = document.getElementById('btnFullscreen');
        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', () => {
                this.toggleChartFullscreen();
            });
        }

        // Settings modal
        document.getElementById('btnLevelSettings').addEventListener('click', () => {
            this.openSettingsModal();
        });
        
        document.getElementById('closeSettings').addEventListener('click', () => {
            document.getElementById('settingsModal').classList.remove('open');
            this.syncModalBodyLock();
        });
        
        document.querySelector('#settingsModal .modal-backdrop').addEventListener('click', () => {
            document.getElementById('settingsModal').classList.remove('open');
            this.syncModalBodyLock();
        });

        // Panel alert buttons (prevent panel collapse toggle)
        document.querySelectorAll('.panel-alert-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const section = btn.dataset.alertSection || 'unknown';
                if (typeof this.openAddAlertModal === 'function') {
                    this.openAddAlertModal(section);
                } else {
                    this.showToast('Alerts loading...', 'info');
                }
            });
        });

        // Settings inputs - cluster is now a number input (no display update needed)
        
        document.getElementById('settingMaxLevels').addEventListener('input', (e) => {
            document.getElementById('maxLevelsValue').textContent = e.target.value;
        });
        
        document.getElementById('settingMinVol').addEventListener('input', (e) => {
            document.getElementById('minVolValue').textContent = e.target.value + ' ' + this.currentSymbol;
        });
        
        document.getElementById('settingPriceRange').addEventListener('input', (e) => {
            document.getElementById('priceRangeValue').textContent = '±' + e.target.value + '%';
        });
        
        document.getElementById('settingFairValueRange').addEventListener('input', (e) => {
            document.getElementById('fairValueRangeValue').textContent = '±' + e.target.value + '%';
        });
        
        document.getElementById('settingBrightness').addEventListener('input', (e) => {
            document.getElementById('brightnessValue').textContent = e.target.value + '%';
        });
        
        document.getElementById('settingThickness').addEventListener('input', (e) => {
            document.getElementById('thicknessValue').textContent = e.target.value;
        });
        
        // LD mode + window (settings modal)
        const ldModeEl = document.getElementById('settingLDMode');
        const ldRangeEl = document.getElementById('settingLDRange');
        const ldRangeValueEl = document.getElementById('ldRangeValue');
        const ldRangeGroup = document.getElementById('settingLDRangeGroup');
        
        if (ldRangeEl && ldRangeValueEl) {
            ldRangeEl.addEventListener('input', (e) => {
                ldRangeValueEl.textContent = '±' + e.target.value + '%';
            });
        }
        
        if (ldModeEl && ldRangeGroup) {
            ldModeEl.addEventListener('change', (e) => {
                ldRangeGroup.style.display = (e.target.value === 'signal') ? '' : 'none';
            });
        }


        // Settings buttons
        document.getElementById('resetSettings').addEventListener('click', () => {
            this.resetLevelSettings();
        });
        
        document.getElementById('applySettings').addEventListener('click', () => {
            this.applyLevelSettings();
        });

        // Close modals on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.getElementById('legendModal').classList.remove('open');
                document.getElementById('settingsModal').classList.remove('open');
                document.getElementById('alertsModal')?.classList.remove('open');
                document.getElementById('alertEditModal')?.classList.remove('open');
                const dm = document.getElementById('alertsDisclaimerModal');
                if (dm?.classList?.contains('open')) {
                    this._pendingAlertSave = null;
                }
                dm?.classList.remove('open');
                this.syncModalBodyLock();
            }
        });
    }

    syncModalBodyLock() {
        const anyOpen = !!document.querySelector('.modal.open');
        document.body.classList.toggle('modal-open', anyOpen);
    }

    openSettingsModal() {
        // Set current values
        document.getElementById('settingCluster').value = this.levelSettings.clusterPct;
        
        document.getElementById('settingMaxLevels').value = this.levelSettings.maxLevels;
        document.getElementById('maxLevelsValue').textContent = this.levelSettings.maxLevels;
        
        document.getElementById('settingMinVol').value = this.levelSettings.minVolume;
        document.getElementById('minVolValue').textContent = this.levelSettings.minVolume + ' ' + this.currentSymbol;
        
        document.getElementById('settingPriceRange').value = this.levelSettings.priceRange;
        document.getElementById('priceRangeValue').textContent = '±' + this.levelSettings.priceRange + '%';
        
        // LD settings (mode + window)
        const ldModeEl = document.getElementById('settingLDMode');
        const ldRangeEl = document.getElementById('settingLDRange');
        const ldRangeValueEl = document.getElementById('ldRangeValue');
        const ldRangeGroup = document.getElementById('settingLDRangeGroup');
        
        if (ldModeEl) {
            ldModeEl.value = this.levelSettings.ldMode || 'signal';
        }
        if (ldRangeEl) {
            const r = parseInt(this.levelSettings.ldRange, 10);
            ldRangeEl.value = Number.isFinite(r) ? r : 10;
        }
        if (ldRangeValueEl && ldRangeEl) {
            ldRangeValueEl.textContent = '±' + ldRangeEl.value + '%';
        }
        if (ldRangeGroup && ldModeEl) {
            ldRangeGroup.style.display = (ldModeEl.value === 'signal') ? '' : 'none';
        }
        
        // Fair Value Range (stored separately for chart.js)
        const fairValueRange = parseInt(localStorage.getItem('fairValueRange') || '15');
        document.getElementById('settingFairValueRange').value = fairValueRange;
        document.getElementById('fairValueRangeValue').textContent = '±' + fairValueRange + '%';
        
        // Color settings
        document.getElementById('colorBarUp').value = this.levelSettings.barUpColor;
        document.getElementById('colorBarDown').value = this.levelSettings.barDownColor;
        document.getElementById('colorLevelSupport').value = this.levelSettings.levelSupportColor;
        document.getElementById('colorLevelResistance').value = this.levelSettings.levelResistanceColor;
        
        // EMA/ZEMA colors
        const emaColor = localStorage.getItem('emaColor') || '#9ca3af';
        document.getElementById('colorEmaLine').value = emaColor;
        
        const zemaColor = localStorage.getItem('zemaColor') || '#8b5cf6';
        document.getElementById('colorZemaLine').value = zemaColor;
        
        // Level appearance settings
        document.getElementById('settingBrightness').value = this.levelSettings.brightness;
        document.getElementById('brightnessValue').textContent = this.levelSettings.brightness + '%';
        
        document.getElementById('settingThickness').value = this.levelSettings.thickness;
        document.getElementById('thicknessValue').textContent = this.levelSettings.thickness;
        
        // EMA Grid settings
        const emaPeriod = parseInt(localStorage.getItem('emaPeriod')) || 20;
        document.getElementById('settingEmaPeriod').value = emaPeriod;
        
        const emaGridSpacing = parseFloat(localStorage.getItem('emaGridSpacing')) || 0.003;
        document.getElementById('settingEmaGridSpacing').value = emaGridSpacing;
        
        // ZEMA Grid settings
        const zemaPeriod = parseInt(localStorage.getItem('zemaPeriod')) || 30;
        document.getElementById('settingZemaPeriod').value = zemaPeriod;
        
        const zemaGridSpacing = parseFloat(localStorage.getItem('zemaGridSpacing')) || 0.003;
        document.getElementById('settingZemaGridSpacing').value = zemaGridSpacing;
        
        document.getElementById('settingsModal').classList.add('open');
        this.syncModalBodyLock();
    }

    // ==============================
    // Alerts UI (wiring; logic in AlertsManager)
    // ==============================
    openAlertsModal() {
        const modal = document.getElementById('alertsModal');
        if (!modal) return;
        modal.classList.add('open');
        this.syncModalBodyLock();
        this.switchAlertsTab('active');
        if (typeof this.renderAlertsModal === 'function') {
            this.renderAlertsModal();
        }
    }

    switchAlertsTab(tab) {
        const modal = document.getElementById('alertsModal');
        if (!modal) return;
        const target = tab || 'active';

        modal.querySelectorAll('.alerts-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === target);
        });
        modal.querySelectorAll('.alerts-tab-content').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.tabContent === target);
        });
    }

    openAddAlertModal(section = null) {
        const modal = document.getElementById('alertEditModal');
        if (!modal) return;

        const titleEl = document.getElementById('alertEditTitle');
        if (titleEl) titleEl.textContent = 'Create Alert';

        const idEl = document.getElementById('alertId');
        if (idEl) idEl.value = '';
        const thresholdEl = document.getElementById('alertThreshold');
        if (thresholdEl) thresholdEl.value = '';
        const targetEl = document.getElementById('alertTarget');
        if (targetEl) targetEl.value = '';
        const targetTextEl = document.getElementById('alertTargetText');
        if (targetTextEl) targetTextEl.value = '';
        const compareEl = document.getElementById('alertCompareMetric');
        if (compareEl) compareEl.value = '';
        const customMsgEl = document.getElementById('alertCustomMessage');
        if (customMsgEl) customMsgEl.value = '';
        
        this.ensureAlertSoundOptions();
        const soundTypeEl = document.getElementById('alertSoundType');
        if (soundTypeEl) soundTypeEl.value = 'alarm';

        // Chart marker defaults
        const plotOnChartEl = document.getElementById('alertPlotOnChart');
        if (plotOnChartEl) plotOnChartEl.checked = section === 'chart';
        const plotShapeEl = document.getElementById('alertPlotShape');
        if (plotShapeEl) plotShapeEl.value = 'auto';
        const plotPosEl = document.getElementById('alertPlotPosition');
        if (plotPosEl) plotPosEl.value = 'auto';
        const plotColorEl = document.getElementById('alertPlotColor');
        if (plotColorEl) plotColorEl.value = '#fbbf24';
        const plotTextEl = document.getElementById('alertPlotText');
        if (plotTextEl) plotTextEl.value = '';

        // Populate section list (registry-driven)
        const sectionSelect = document.getElementById('alertSection');
        const sections = this.alertMetricRegistry?.listSections?.() || [
            { key: 'chart', label: 'Main Chart' },
            { key: 'depth', label: 'Market Depth' },
            { key: 'orderflow', label: 'Order Flow' },
            { key: 'forecast', label: 'Price Forecast' },
            { key: 'fairvalue', label: 'Fair Value' },
            { key: 'mcs', label: 'Market Consensus' },
            { key: 'alpha', label: 'Alpha Score' },
            { key: 'regime', label: 'Regime Engine' },
            { key: 'levels', label: 'Key Levels' }
        ];
        if (sectionSelect) {
            sectionSelect.innerHTML = sections.map(s => `<option value="${s.key}">${s.label}</option>`).join('');
            if (section) {
                sectionSelect.value = section;
                sectionSelect.disabled = true;
            } else {
                sectionSelect.disabled = false;
                sectionSelect.value = sectionSelect.value || 'mcs';
            }
        }

        // Populate metric/condition/value UI from registry
        this.populateAlertEditorUI();

        modal.classList.add('open');
        this.syncModalBodyLock();

        // Prime audio on user gesture (enables sound alerts later)
        this.alertsManager?.ensureAudioUnlocked?.();
    }

    ensureAlertSoundOptions() {
        const select = document.getElementById('alertSoundType');
        if (!select) return;

        const prev = select.value;
        select.innerHTML = '';

        const builtIn = document.createElement('optgroup');
        builtIn.label = 'Built-in';
        builtIn.appendChild(new Option('Alarm (clock)', 'alarm'));
        builtIn.appendChild(new Option('Beep', 'beep'));
        builtIn.appendChild(new Option('Chime', 'chime'));
        select.appendChild(builtIn);

        const files = document.createElement('optgroup');
        files.label = 'Sounds';
        for (const f of (ALERT_SOUND_FILES || [])) {
            files.appendChild(new Option(formatAlertSoundLabel(f), `file:sounds/${f}`));
        }
        select.appendChild(files);

        // Restore selection if possible
        const hasPrev = Array.from(select.options).some(o => o.value === prev);
        if (hasPrev) select.value = prev;
        else select.value = 'alarm';
    }

    previewSelectedAlertSound() {
        if (!this.alertsManager) return;
        this.ensureAlertSoundOptions();
        const soundType = document.getElementById('alertSoundType')?.value || 'alarm';
        this.alertsManager.ensureAudioUnlocked().then(() => {
            this.alertsManager.playSound(soundType);
        });
    }

    getCurrentAnalyticsLevelsForAlerts() {
        return this.useFullBookForAnalytics
            ? (this.fullBookLevels.length ? this.fullBookLevels : this.levels)
            : this.levels;
    }

    populateAlertEditorUI() {
        const sectionSelect = document.getElementById('alertSection');
        const metricSelect = document.getElementById('alertMetric');
        const condSelect = document.getElementById('alertCondition');
        const thresholdWrap = document.getElementById('alertThresholdWrap');
        const compareWrap = document.getElementById('alertCompareMetricWrap');
        const targetWrap = document.getElementById('alertTargetWrap');
        const textTargetWrap = document.getElementById('alertTextTargetWrap');
        const targetSelect = document.getElementById('alertTarget');
        const compareSelect = document.getElementById('alertCompareMetric');
        const targetText = document.getElementById('alertTargetText');
        const thresholdInput = document.getElementById('alertThreshold');
        const currentValEl = document.getElementById('alertCurrentValue');
        const currentHintEl = document.getElementById('alertCurrentHint');
        const soundChk = document.getElementById('alertSound');
        const soundTypeSelect = document.getElementById('alertSoundType');
        const plotChk = document.getElementById('alertPlotOnChart');
        const plotShape = document.getElementById('alertPlotShape');
        const plotPos = document.getElementById('alertPlotPosition');
        const plotColor = document.getElementById('alertPlotColor');
        const plotText = document.getElementById('alertPlotText');
        const plotWarning = document.getElementById('alertPlotWarning');
        const customMsgEl = document.getElementById('alertCustomMessage');
        const messagePreviewEl = document.getElementById('alertMessagePreview');

        const section = sectionSelect?.value;
        if (!this.alertMetricRegistry || !section || !metricSelect || !condSelect) {
            if (metricSelect) metricSelect.innerHTML = `<option value="">Loading...</option>`;
            if (condSelect) condSelect.innerHTML = `<option value="">Loading...</option>`;
            return;
        }

        // Metrics
        const metrics = this.alertMetricRegistry.listMetrics(section) || [];
        const prevMetricKey = metricSelect.value;
        metricSelect.innerHTML = metrics
            .map(m => `<option value="${m.key}">${m.label}</option>`)
            .join('') || `<option value="">No metrics</option>`;
        if (prevMetricKey && metrics.some(m => m.key === prevMetricKey)) {
            metricSelect.value = prevMetricKey;
        }

        const metric = this.alertMetricRegistry.getMetric(section, metricSelect.value);
        if (!metric) {
            condSelect.innerHTML = `<option value="">--</option>`;
            return;
        }

        // Conditions
        const prevCond = condSelect.value;
        const conds = this.alertMetricRegistry.getConditionsForMetric(metric);
        condSelect.innerHTML = conds.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
        if (prevCond && conds.some(c => c.key === prevCond)) {
            condSelect.value = prevCond;
        }

        // Value input mode
        const cond = condSelect.value || '';
        const compareMode = metric.type === 'number' && cond.endsWith('_metric');
        const showThreshold = metric.type === 'number' && !compareMode;
        const showCompareMetric = metric.type === 'number' && compareMode;
        const showEnumTarget = metric.type === 'enum' && cond !== 'changes';
        const showTextTarget = (metric.type !== 'number' && metric.type !== 'enum' && cond !== 'changes');

        if (thresholdWrap) thresholdWrap.style.display = showThreshold ? '' : 'none';
        if (compareWrap) compareWrap.style.display = showCompareMetric ? '' : 'none';
        if (targetWrap) targetWrap.style.display = showEnumTarget ? '' : 'none';
        if (textTargetWrap) textTargetWrap.style.display = showTextTarget ? '' : 'none';

        if (showCompareMetric && compareSelect) {
            const all = this.alertMetricRegistry.listMetrics(section) || [];
            const options = all.filter(m => m && m.type === 'number' && m.key !== metric.key);
            const prev = compareSelect.value;
            compareSelect.innerHTML = options.map(m => `<option value="${m.key}">${m.label}</option>`).join('') || `<option value="">--</option>`;
            if (prev && options.some(m => m.key === prev)) {
                compareSelect.value = prev;
            } else if (options.length) {
                // Default: compare price against EMA when possible
                const preferred = options.find(m => m.key === 'ema') || options.find(m => m.key === 'vwmp') || options[0];
                compareSelect.value = preferred.key;
            }
        } else if (compareSelect) {
            compareSelect.innerHTML = '';
        }

        if (metric.type === 'enum' && targetSelect) {
            const opts = metric.options || [];

            // Preserve selection across re-renders. This function is called often (including on editor changes),
            // so rebuilding the <select> without restoring the value makes it "stick" to the first option.
            const prevValue = targetSelect.value;
            const prevSig = Array.from(targetSelect.options).map(o => o.value).join('|');
            const nextSig = opts.join('|');

            if (prevSig !== nextSig) {
                targetSelect.innerHTML = opts.map(v => `<option value="${v}">${v}</option>`).join('') || `<option value="">--</option>`;
            }

            if (prevValue && opts.includes(prevValue)) {
                targetSelect.value = prevValue;
            }
        }
        if (!showTextTarget && targetText) {
            // Avoid accidental reuse when switching metric types
            targetText.value = '';
        }

        // Preview current value
        const levels = this.getCurrentAnalyticsLevelsForAlerts();
        const snapshot = this.getAlertsSnapshot(levels);
        const val = metric.getValue(snapshot);
        let previewText = '--';
        if (val !== null && val !== undefined) {
            previewText = metric.format ? metric.format(val, snapshot) : String(val);
        }
        if (showCompareMetric && compareSelect?.value) {
            const rhsMetric = this.alertMetricRegistry.getMetric(section, compareSelect.value);
            const rhsVal = rhsMetric?.getValue?.(snapshot);
            const rhsText = (rhsVal !== null && rhsVal !== undefined)
                ? (rhsMetric?.format ? rhsMetric.format(rhsVal, snapshot) : String(rhsVal))
                : '--';
            previewText = `${previewText} vs ${rhsText}`;
        }
        if (currentValEl) currentValEl.textContent = previewText;
        if (currentHintEl) currentHintEl.textContent = metric.unit ? metric.unit : '';

        // Sensible numeric input step
        if (showThreshold && thresholdInput && metric.type === 'number') {
            thresholdInput.step = metric.unit === '%' ? '0.01' : '0.0001';
        }

        // Sound type enabled only when sound is enabled
        if (soundTypeSelect && soundChk) {
            soundTypeSelect.disabled = !soundChk.checked;
        }

        // Chart marker controls
        const plotEnabled = !!plotChk?.checked;
        if (plotWarning) plotWarning.style.display = plotEnabled ? '' : 'none';
        [plotShape, plotPos, plotColor, plotText].forEach(el => {
            if (el) el.disabled = !plotEnabled;
        });

        // Message preview
        if (messagePreviewEl) {
            const symbol = snapshot?.symbol || this.currentSymbol || 'BTC';
            const timeframe = snapshot?.timeframe || this.currentTimeframe || '';
            const fv = snapshot?.fairValue || {};
            const ctx = {
                symbol,
                timeframe,
                price: snapshot?.price ? formatSmartPrice(snapshot.price) : '--',
                mid: fv?.mid ? formatSmartPrice(fv.mid) : '--',
                vwmp: fv?.vwmp ? formatSmartPrice(fv.vwmp) : '--',
                ifv: fv?.ifv ? formatSmartPrice(fv.ifv) : '--',
                metric: metric?.label || metric.key,
                condition: condSelect?.value || '',
                value: (val !== null && val !== undefined) ? (metric.format ? metric.format(val, snapshot) : String(val)) : '--',
                compare: ''
            };

            // Compare/target preview (best-effort)
            if (metric.type === 'number') {
                if ((condSelect?.value || '').endsWith('_metric')) {
                    const rhsMetric = this.alertMetricRegistry.getMetric(section, compareSelect?.value);
                    const rhsVal = rhsMetric?.getValue?.(snapshot);
                    ctx.compare = rhsMetric?.label
                        ? `${rhsMetric.label} (${rhsVal !== null && rhsVal !== undefined ? (rhsMetric.format ? rhsMetric.format(rhsVal, snapshot) : rhsVal) : '--'})`
                        : '';
                } else {
                    const thr = thresholdInput?.value;
                    ctx.compare = thr ? String(thr) : '';
                }
            } else if (metric.type === 'enum') {
                ctx.compare = targetSelect?.value || '';
            } else {
                ctx.compare = targetText?.value || '';
            }

            const baseMsg = `[${symbol}] ${ctx.metric} ${ctx.condition} (${ctx.value})`;
            ctx.auto = baseMsg;
            const customRaw = (customMsgEl?.value || '').replace(/\r\n/g, '\n');
            const rendered = renderAlertTemplate(customRaw, ctx).trim();
            const preview = rendered
                ? (customRaw.includes('{auto}') ? rendered : `${rendered} • ${baseMsg}`)
                : baseMsg;

            messagePreviewEl.textContent = clampString(preview, 220);
        }
    }

    updateAlertIndicators() {
        if (!this.alertsManager) return;
        const counts = this.alertsManager.countBySection();

        document.querySelectorAll('.panel-alert-btn').forEach(btn => {
            const section = btn.dataset.alertSection;
            const count = counts[section] || 0;
            const badge = btn.querySelector('.panel-alert-count');
            if (badge) {
                badge.textContent = count > 0 ? String(count) : '';
                badge.classList.toggle('visible', count > 0);
            }
            btn.classList.toggle('has-alerts', count > 0);
        });

        const enabledCount = this.alertsManager.listEnabled().length;
        const dot = document.getElementById('alertsGlobalDot');
        if (dot) dot.classList.toggle('visible', enabledCount > 0);
    }

    restoreAlertMarkersFromLog() {
        if (!this.alertsManager || !this.chart) return;
        const entries = this.alertsManager.log || [];
        const markers = [];
        
        for (const e of entries) {
            const m = e?.marker;
            if (m && m.time) {
                markers.push({
                    time: m.time,
                    position: m.position || 'inBar',
                    color: m.color || '#fbbf24',
                    shape: m.shape || 'circle',
                    text: m.text || ''
                });
            }
        }
        
        // Keep chronological order for rendering
        markers.sort((a, b) => a.time - b.time);
        
        if (typeof this.chart.setAlertMarkers === 'function') {
            this.chart.setAlertMarkers(markers);
        } else {
            this.chart.alertMarkers = markers;
            this.chart.updateAllSignalMarkers?.();
        }
    }

    async handleAlertFormSubmit() {
        if (!this.alertsManager || !this.alertMetricRegistry) return;

        const section = document.getElementById('alertSection')?.value;
        const metricKey = document.getElementById('alertMetric')?.value;
        const condition = document.getElementById('alertCondition')?.value || '';
        const frequency = document.getElementById('alertFrequency')?.value || 'one_time';
        const notify = !!document.getElementById('alertNotify')?.checked;
        const sound = !!document.getElementById('alertSound')?.checked;
        const rawSoundType = document.getElementById('alertSoundType')?.value || 'alarm';
        const soundType = (typeof rawSoundType === 'string' && rawSoundType.startsWith('file:'))
            ? rawSoundType
            : String(rawSoundType).toLowerCase();
        const plotOnChart = !!document.getElementById('alertPlotOnChart')?.checked;
        const plotShape = document.getElementById('alertPlotShape')?.value || 'auto';
        const plotPosition = document.getElementById('alertPlotPosition')?.value || 'auto';
        const plotColor = document.getElementById('alertPlotColor')?.value || '';
        const plotText = (document.getElementById('alertPlotText')?.value || '').trim();
        const customMessage = (document.getElementById('alertCustomMessage')?.value || '').replace(/\r\n/g, '\n');
        const id = document.getElementById('alertId')?.value || '';

        if (!section || !metricKey) {
            this.showToast('Please select a section and metric.', 'warning');
            return;
        }

        const metric = this.alertMetricRegistry.getMetric(section, metricKey);
        if (!metric) {
            this.showToast('Invalid metric.', 'warning');
            return;
        }

        // Value (threshold or target)
        let threshold = null;
        let target = null;
        let compareMetricKey = null;
        let compareMetricLabel = null;

        if (metric.type === 'number') {
            if (condition.endsWith('_metric')) {
                compareMetricKey = document.getElementById('alertCompareMetric')?.value || '';
                if (!compareMetricKey) {
                    this.showToast('Select a metric to compare against.', 'warning');
                    return;
                }
                const compareMetric = this.alertMetricRegistry.getMetric(section, compareMetricKey);
                compareMetricLabel = compareMetric?.label || compareMetricKey;
            } else {
                threshold = Number(document.getElementById('alertThreshold')?.value);
                if (!isFinite(threshold)) {
                    this.showToast('Enter a valid numeric threshold.', 'warning');
                    return;
                }
            }
        } else if (metric.type === 'enum') {
            target = document.getElementById('alertTarget')?.value || '';
            if (condition === 'changes') {
                target = null; // no target needed
            } else if (!target) {
                this.showToast('Select a target value.', 'warning');
                return;
            }
        } else {
            // string/event
            target = (document.getElementById('alertTargetText')?.value || '').trim();
            if ((condition === 'is' || condition === 'changes_to') && !target) {
                this.showToast('Enter a target value.', 'warning');
                return;
            }
        }

        // Human-readable description (used in lists)
        const sectionLabel = (this.alertMetricRegistry.listSections().find(s => s.key === section)?.label) || section;
        const metricLabel = metric.label || metricKey;
        const condLabel = this.alertMetricRegistry.getConditionsForMetric(metric).find(c => c.key === condition)?.label || condition;
        const rhs = metric.type === 'number'
            ? (compareMetricLabel || threshold)
            : (target || '');
        const description = `${sectionLabel}: ${metricLabel} ${condLabel}${rhs !== '' && rhs !== null && rhs !== undefined ? ' ' + rhs : ''}`;

        const alert = {
            id: id || undefined,
            symbol: this.currentSymbol,
            section,
            metricKey,
            metricLabel,
            condition,
            threshold,
            target,
            compareMetricKey,
            compareMetricLabel,
            frequency,
            notify,
            sound,
            soundType,
            plotOnChart,
            plotShape,
            plotPosition,
            plotColor,
            plotText,
            customMessage: clampString(customMessage, 500),
            enabled: true,
            description
        };

        // One-time disclaimer gate
        const disclaimerSeen = localStorage.getItem('alertsDisclaimerSeen') === 'true';
        if (!disclaimerSeen) {
            this._pendingAlertSave = alert;
            const dm = document.getElementById('alertsDisclaimerModal');
            const chk = document.getElementById('alertsDisclaimerCheck');
            const btn = document.getElementById('alertsDisclaimerContinue');
            if (chk) chk.checked = false;
            if (btn) btn.disabled = true;
            dm?.classList.add('open');
            this.syncModalBodyLock();
            return;
        }

        await this.finalizeAlertSave(alert);
    }

    async finalizeAlertSave(alert) {
        if (!this.alertsManager) return;

        // Permission gating (must be on user gesture)
        if (alert.notify) {
            await this.alertsManager.ensureNotificationPermission();
        }
        if (alert.sound) {
            await this.alertsManager.ensureAudioUnlocked();
        }

        this.alertsManager.upsert(alert);
        this.updateAlertIndicators();

        // Close editor
        document.getElementById('alertEditModal')?.classList.remove('open');
        this.syncModalBodyLock();

        // Refresh modal if open
        if (document.getElementById('alertsModal')?.classList.contains('open')) {
            this.renderAlertsModal?.();
        }

        this.showToast('Alert saved.', 'info');
    }

    confirmAlertsDisclaimer() {
        localStorage.setItem('alertsDisclaimerSeen', 'true');
        document.getElementById('alertsDisclaimerModal')?.classList.remove('open');
        this.syncModalBodyLock();

        const pending = this._pendingAlertSave;
        this._pendingAlertSave = null;
        if (pending) {
            // Continue the save flow (still a user gesture)
            this.finalizeAlertSave(pending);
        }
    }

    renderAlertsModal() {
        if (!this.alertsManager) return;
        const activeList = document.getElementById('activeAlertsList');
        const logList = document.getElementById('alertsLogList');
        if (!activeList || !logList) return;

        const alerts = this.alertsManager.list() || [];
        const formatTime = (ts) => {
            try {
                return new Date(ts).toLocaleTimeString();
            } catch (_) {
                return '';
            }
        };

        // Active alerts
        if (!alerts.length) {
            activeList.innerHTML = `<div class="alerts-empty">No active alerts yet.</div>`;
        } else {
            activeList.innerHTML = alerts.map(a => {
                const enabled = !!a.enabled;
                const freq = a.frequency === 'once_per_bar' ? 'Once per bar' : a.frequency === 'once_per_min' ? 'Once per min' : 'One time';
                const delivery = `${a.notify ? 'Notify' : 'No notify'}${a.sound ? ' + Sound' : ''}`;
                const note = a.customMessage && String(a.customMessage).trim() ? ' • Msg' : '';
                const last = a._lastTriggeredAt ? `Last: ${formatTime(a._lastTriggeredAt)}` : '';
                return `
                    <div class="alert-row" data-alert-id="${a.id}">
                        <label class="alert-toggle">
                            <input type="checkbox" class="alert-enabled-toggle" ${enabled ? 'checked' : ''}>
                        </label>
                        <div class="alert-row-main">
                            <div class="alert-row-title">${escapeHtml(a.description || (a.metricLabel || a.metricKey))}</div>
                            <div class="alert-row-meta">${escapeHtml(freq)} • ${escapeHtml(delivery)}${escapeHtml(note)}${last ? ' • ' + escapeHtml(last) : ''}</div>
                        </div>
                        <div class="alert-row-actions">
                            <button class="btn-secondary btn-small alert-edit-btn" type="button">Edit</button>
                            <button class="btn-secondary btn-small alert-delete-btn" type="button">Delete</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // Log
        const logs = this.alertsManager.log || [];
        if (!logs.length) {
            logList.innerHTML = `<div class="alerts-empty">No alerts fired yet.</div>`;
        } else {
            logList.innerHTML = logs.map(e => {
                const t = formatTime(e.ts);
                const metaParts = [];
                if (e.price) metaParts.push(`P ${formatSmartPrice(e.price)}`);
                if (e.mid) metaParts.push(`Mid ${formatSmartPrice(e.mid)}`);
                if (e.vwmp) metaParts.push(`VWMP ${formatSmartPrice(e.vwmp)}`);
                if (e.ifv) metaParts.push(`IFV ${formatSmartPrice(e.ifv)}`);
                const meta = metaParts.join(' • ');
                return `
                    <div class="alert-log-row">
                        <span class="alert-log-time">${t}</span>
                        <div class="alert-log-main">
                            <div class="alert-log-msg">${escapeHtml(e.message || '')}</div>
                            ${meta ? `<div class="alert-log-meta">${escapeHtml(meta)}</div>` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    openEditAlertModal(alertId) {
        if (!this.alertsManager || !this.alertMetricRegistry) return;
        const alert = this.alertsManager.getById(alertId);
        if (!alert) return;

        const modal = document.getElementById('alertEditModal');
        if (!modal) return;

        const titleEl = document.getElementById('alertEditTitle');
        if (titleEl) titleEl.textContent = 'Edit Alert';

        const idEl = document.getElementById('alertId');
        if (idEl) idEl.value = alert.id;

        // Section selectable on edit
        const sectionSelect = document.getElementById('alertSection');
        if (sectionSelect) {
            sectionSelect.innerHTML = this.alertMetricRegistry.listSections().map(s => `<option value="${s.key}">${s.label}</option>`).join('');
            sectionSelect.disabled = false;
            sectionSelect.value = alert.section;
        }

        // Populate selects based on section
        this.populateAlertEditorUI();

        const metricSelect = document.getElementById('alertMetric');
        if (metricSelect) {
            metricSelect.value = alert.metricKey;
        }
        // Rebuild condition/value inputs for selected metric
        this.populateAlertEditorUI();

        const condSelect = document.getElementById('alertCondition');
        if (condSelect && alert.condition) {
            condSelect.value = alert.condition;
        }
        this.populateAlertEditorUI();

        // Value
        const metric = this.alertMetricRegistry.getMetric(alert.section, alert.metricKey);
        if (metric?.type === 'number') {
            if (alert.compareMetricKey && String(alert.condition || '').endsWith('_metric')) {
                const compareEl = document.getElementById('alertCompareMetric');
                if (compareEl) compareEl.value = String(alert.compareMetricKey);
            } else {
                const thresholdEl = document.getElementById('alertThreshold');
                if (thresholdEl && alert.threshold !== null && alert.threshold !== undefined) {
                    thresholdEl.value = String(alert.threshold);
                }
            }
        } else if (metric?.type === 'enum') {
            const targetEl = document.getElementById('alertTarget');
            if (targetEl && alert.target !== null && alert.target !== undefined) {
                targetEl.value = String(alert.target);
            }
        } else {
            const targetText = document.getElementById('alertTargetText');
            if (targetText && alert.target !== null && alert.target !== undefined) {
                targetText.value = String(alert.target);
            }
        }

        // Frequency + delivery toggles
        const freqEl = document.getElementById('alertFrequency');
        if (freqEl && alert.frequency) freqEl.value = alert.frequency;
        const notifyEl = document.getElementById('alertNotify');
        if (notifyEl) notifyEl.checked = !!alert.notify;
        const soundEl = document.getElementById('alertSound');
        if (soundEl) soundEl.checked = !!alert.sound;
        this.ensureAlertSoundOptions();
        const soundTypeEl = document.getElementById('alertSoundType');
        if (soundTypeEl) {
            const raw = alert.soundType || 'alarm';
            soundTypeEl.value = (typeof raw === 'string' && raw.startsWith('file:')) ? raw : String(raw).toLowerCase();
        }
        
        const customMsgEl = document.getElementById('alertCustomMessage');
        if (customMsgEl) customMsgEl.value = alert.customMessage || '';
        
        const plotOnChartEl = document.getElementById('alertPlotOnChart');
        if (plotOnChartEl) plotOnChartEl.checked = !!alert.plotOnChart;
        const plotShapeEl = document.getElementById('alertPlotShape');
        if (plotShapeEl) plotShapeEl.value = alert.plotShape || 'auto';
        const plotPosEl = document.getElementById('alertPlotPosition');
        if (plotPosEl) plotPosEl.value = alert.plotPosition || 'auto';
        const plotColorEl = document.getElementById('alertPlotColor');
        if (plotColorEl && alert.plotColor) plotColorEl.value = alert.plotColor;
        const plotTextEl = document.getElementById('alertPlotText');
        if (plotTextEl) plotTextEl.value = alert.plotText || '';

        // Refresh UI visibility + preview after setting values
        this.populateAlertEditorUI();

        modal.classList.add('open');
        this.syncModalBodyLock();
        this.alertsManager?.ensureAudioUnlocked?.();
    }

    // Load settings from localStorage
    loadSettings() {
        const defaults = {
            clusterPct: 0.15,
            maxLevels: 500,      // Max levels
            minVolume: 15,       // 15 BTC minimum
            priceRange: 100,     // Default 100% to show full picture
            // LD settings (analytics signal shaping)
            ldMode: 'signal',    // 'signal' | 'context'
            ldRange: 10,         // Signal mode window (±%)
            // Color settings (vibrant cyan/magenta)
            barUpColor: '#10b981',
            barDownColor: '#ef4444',
            levelSupportColor: '#00d9ff',
            levelResistanceColor: '#ff006e',
            // Level appearance - both are signal amplifiers
            brightness: 50, // 50% = balanced, higher = amplify weak signals
            thickness: 5    // Max thickness
        };
        
        try {
            const saved = localStorage.getItem('orderbook_level_settings');
            if (saved) {
                const parsed = JSON.parse(saved);
                return { ...defaults, ...parsed };
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
        
        return defaults;
    }

    // Save settings to localStorage
    saveSettings() {
        try {
            localStorage.setItem('orderbook_level_settings', JSON.stringify(this.levelSettings));
            console.log('Settings saved to localStorage');
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    }

    resetLevelSettings() {
        this.levelSettings = {
            clusterPct: 0.15,
            maxLevels: 500,
            minVolume: 15,
            priceRange: 100,
            ldMode: 'signal',
            ldRange: 10,
            barUpColor: '#10b981',
            barDownColor: '#ef4444',
            levelSupportColor: '#00d9ff',
            levelResistanceColor: '#ff006e',
            brightness: 50, // 50% = balanced signal amplifier
            thickness: 5    // Max thickness amplifier
        };
        // Reset Fair Value Range to default
        localStorage.setItem('fairValueRange', '15');
        this.saveSettings(); // Persist reset
        this.applyChartColors(); // Apply default colors
        this.applyLevelAppearance(); // Apply appearance settings
        this.openSettingsModal(); // Refresh UI
    }

    applyLevelSettings() {
        this.levelSettings = {
            clusterPct: parseFloat(document.getElementById('settingCluster').value),
            maxLevels: parseInt(document.getElementById('settingMaxLevels').value),
            minVolume: parseInt(document.getElementById('settingMinVol').value),
            priceRange: parseInt(document.getElementById('settingPriceRange').value),
            ldMode: (document.getElementById('settingLDMode')?.value || 'signal'),
            ldRange: parseInt(document.getElementById('settingLDRange')?.value || '10', 10),
            barUpColor: document.getElementById('colorBarUp').value,
            barDownColor: document.getElementById('colorBarDown').value,
            levelSupportColor: document.getElementById('colorLevelSupport').value,
            levelResistanceColor: document.getElementById('colorLevelResistance').value,
            brightness: parseInt(document.getElementById('settingBrightness').value),
            thickness: parseFloat(document.getElementById('settingThickness').value)
        };
        
        // Save EMA settings separately
        const emaPeriod = parseInt(document.getElementById('settingEmaPeriod').value);
        localStorage.setItem('emaPeriod', emaPeriod);
        if (this.chart.emaGrid) {
            this.chart.emaGrid.period = emaPeriod;
            if (this.chart.emaGrid.show) {
                this.chart.drawEmaGrid();
            }
        }
        
        const emaGridSpacing = parseFloat(document.getElementById('settingEmaGridSpacing').value);
        localStorage.setItem('emaGridSpacing', emaGridSpacing);
        this.chart.setEmaGridSpacing(emaGridSpacing);
        
        // Save ZEMA settings separately
        const zemaPeriod = parseInt(document.getElementById('settingZemaPeriod').value);
        localStorage.setItem('zemaPeriod', zemaPeriod);
        if (this.chart.setZemaPeriod) {
            this.chart.setZemaPeriod(zemaPeriod);
        }
        
        const zemaGridSpacing = parseFloat(document.getElementById('settingZemaGridSpacing').value);
        localStorage.setItem('zemaGridSpacing', zemaGridSpacing);
        if (this.chart.setZemaGridSpacing) {
            this.chart.setZemaGridSpacing(zemaGridSpacing);
        }
        
        // Save EMA/ZEMA colors
        const emaColor = document.getElementById('colorEmaLine').value;
        localStorage.setItem('emaColor', emaColor);
        if (this.chart.setEmaColor) {
            this.chart.setEmaColor(emaColor);
        }
        
        const zemaColor = document.getElementById('colorZemaLine').value;
        localStorage.setItem('zemaColor', zemaColor);
        if (this.chart.setZemaColor) {
            this.chart.setZemaColor(zemaColor);
        }
        
        // Save Fair Value Range separately (used by chart.js for VWMP/IFV calculation)
        const fairValueRange = parseInt(document.getElementById('settingFairValueRange').value);
        localStorage.setItem('fairValueRange', fairValueRange);
        
        this.saveSettings(); // Persist to localStorage
        this.applyChartColors(); // Apply new colors
        this.applyLevelAppearance(); // Apply appearance settings
        
        // Apply BB Pulse indicator toggle
        const showBBPulse = document.getElementById('showBBPulse').checked;
        localStorage.setItem('showBBPulse', showBBPulse);
        if (this.chart.toggleBBPulse) {
            this.chart.toggleBBPulse(showBBPulse);
        }
        
        document.getElementById('settingsModal').classList.remove('open');
        this.syncModalBodyLock();
        this.loadData(); // Refresh with new settings
    }
    
    applyLevelAppearance() {
        if (this.chart) {
            this.chart.setLevelAppearance({
                brightness: this.levelSettings.brightness,
                thickness: this.levelSettings.thickness
            });
        }
    }

    applyChartColors() {
        if (this.chart) {
            this.chart.setColors({
                barUp: this.levelSettings.barUpColor,
                barDown: this.levelSettings.barDownColor,
                levelSupport: this.levelSettings.levelSupportColor,
                levelResistance: this.levelSettings.levelResistanceColor
            });
        }
    }

    // Load selected exchanges from localStorage
    loadExchanges() {
        const defaults = ['kraken', 'coinbase', 'bitstamp'];
        try {
            const saved = localStorage.getItem('orderbook_exchanges');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to load exchanges:', e);
        }
        return defaults;
    }

    // Initialize exchange checkboxes from saved state
    initExchangeCheckboxes() {
        document.getElementById('exKraken').checked = this.selectedExchanges.includes('kraken');
        document.getElementById('exCoinbase').checked = this.selectedExchanges.includes('coinbase');
        document.getElementById('exBitstamp').checked = this.selectedExchanges.includes('bitstamp');
        this.updateExchangeBadge();
    }

    updateSelectedExchanges() {
        this.selectedExchanges = [];
        if (document.getElementById('exKraken').checked) this.selectedExchanges.push('kraken');
        if (document.getElementById('exCoinbase').checked) this.selectedExchanges.push('coinbase');
        if (document.getElementById('exBitstamp').checked) this.selectedExchanges.push('bitstamp');
        
        // Save to localStorage
        try {
            localStorage.setItem('orderbook_exchanges', JSON.stringify(this.selectedExchanges));
        } catch (e) {
            console.error('Failed to save exchanges:', e);
        }
        
        this.updateExchangeBadge();
        
        // Sync with WebSocket Order Book
        if (typeof orderBookWS !== 'undefined') {
            orderBookWS.setExchangeEnabled('kraken', this.selectedExchanges.includes('kraken'));
            orderBookWS.setExchangeEnabled('coinbase', this.selectedExchanges.includes('coinbase'));
            orderBookWS.setExchangeEnabled('bitstamp', this.selectedExchanges.includes('bitstamp'));
        }
    }

    updateExchangeBadge() {
        const count = this.selectedExchanges.length;
        document.getElementById('depthSources').textContent = count + ' exchange' + (count !== 1 ? 's' : '');
    }

    setupAutoRefresh(interval = null) {
        // Auto-refresh polling removed - WebSocket streams data in real-time
        // Clear any existing interval
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    async loadData() {
        if (this.isLoading) return;
        this.isLoading = true;
        
        this.setLoadingState(true);

        try {
            // Set the interval for live bar creation
            const timeframe = this.currentTimeframe || '4h';
            this.chart.setInterval(timeframe);
            
            // Load klines from Binance Vision API
            const klinesResponse = await api.getKlines(timeframe);

            // Update klines/chart
            if (klinesResponse && klinesResponse.data) {
                this.chart.setData(klinesResponse.data);
                await db.saveKlines(timeframe, klinesResponse.data);
                console.log(`[App] Loaded ${klinesResponse.data.length} klines from Binance`);
                
                // Update BB Pulse indicator if enabled
                if (this.chart.bbPulse && this.chart.bbPulse.enabled) {
                    this.chart.updateBBPulse();
                }
            }

            // Order book data comes from WebSocket only
            // Show "Waiting for data..." message if WebSocket not ready
            if (!api.isWebSocketReady()) {
                console.log('[App] Waiting for WebSocket order book data...');
                this.setConnectionStatus(true, 'Connecting to exchanges...');
                
                // Set placeholders
                this.elements.depthSources.textContent = 'Connecting...';
            } else {
                console.log('[App] WebSocket order book data ready');
            }

            this.updateLastUpdate();

        } catch (error) {
            console.error('Failed to load data:', error);
            this.setConnectionStatus(false, error.message);
            
            // Try to load klines from cache
            await this.loadFromCache();
        }

        this.isLoading = false;
        this.setLoadingState(false);
    }

    async loadFromCache() {
        console.log('Loading from cache...');
        
        try {
            const cachedLevels = await db.getLatestLevels();
            if (cachedLevels) {
                this.levels = cachedLevels.levels;
                this.fullBookLevels = cachedLevels.levels; // Cache doesn't store full book separately
                this.chart.setLevels(this.levels);
                if (this.currentPrice) {
                    this.updateAnalyticsData(); // Use unified analytics update
                }
                this.renderLevelsList();
                this.elements.depthSources.textContent = 'Cached';
            }

            const cachedKlines = await db.getKlines('1h');
            if (cachedKlines) {
                this.chart.setData(cachedKlines.data);
            }
        } catch (error) {
            console.error('Failed to load from cache:', error);
        }
    }

    startBarCountdown() {
        // Clear existing interval
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
        
        // Update immediately
        this.updateBarCountdown();
        
        // Update every second
        this.countdownInterval = setInterval(() => {
            this.updateBarCountdown();
        }, 1000);
    }

    updateBarCountdown() {
        if (!this.elements.barCountdown) return;
        
        const intervals = {
            '1m': 60,
            '3m': 3 * 60,
            '5m': 5 * 60,
            '15m': 15 * 60,
            '30m': 30 * 60,
            '1h': 60 * 60,
            '2h': 2 * 60 * 60,
            '4h': 4 * 60 * 60,
            '6h': 6 * 60 * 60,
            '12h': 12 * 60 * 60,
            '1d': 24 * 60 * 60,
            '3d': 3 * 24 * 60 * 60,
            '1w': 7 * 24 * 60 * 60
        };
        
        const intervalSeconds = intervals[this.currentTimeframe] || intervals['4h'];
        const now = Math.floor(Date.now() / 1000);
        
        // Weekly candles align to Monday 00:00 UTC (not Thursday/epoch)
        let currentBarStart;
        if (this.currentTimeframe === '1w') {
            const REFERENCE_MONDAY = 345600; // Jan 5, 1970 00:00 UTC
            const sinceRef = now - REFERENCE_MONDAY;
            const weeks = Math.floor(sinceRef / intervalSeconds);
            currentBarStart = REFERENCE_MONDAY + (weeks * intervalSeconds);
        } else {
            currentBarStart = Math.floor(now / intervalSeconds) * intervalSeconds;
        }
        
        const nextBarStart = currentBarStart + intervalSeconds;
        const remaining = nextBarStart - now;
        
        // Format the countdown
        let displayText;
        if (remaining >= 86400) {
            // More than a day - show days:hours
            const days = Math.floor(remaining / 86400);
            const hours = Math.floor((remaining % 86400) / 3600);
            displayText = `${days}d ${hours}h`;
        } else if (remaining >= 3600) {
            // More than an hour - show hours:minutes
            const hours = Math.floor(remaining / 3600);
            const mins = Math.floor((remaining % 3600) / 60);
            displayText = `${hours}h ${mins}m`;
        } else if (remaining >= 60) {
            // More than a minute - show minutes:seconds
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            displayText = `${mins}:${secs.toString().padStart(2, '0')}`;
        } else {
            // Less than a minute - show seconds only
            displayText = `0:${remaining.toString().padStart(2, '0')}`;
        }
        
        this.elements.barCountdown.textContent = displayText;
        
        // Update styling based on time remaining
        const el = this.elements.barCountdown;
        el.classList.remove('warning', 'critical');
        
        const percentRemaining = remaining / intervalSeconds;
        if (percentRemaining < 0.05 || remaining < 10) {
            el.classList.add('critical');
        } else if (percentRemaining < 0.15 || remaining < 30) {
            el.classList.add('warning');
        }
    }

    async loadKlines(timeframe) {
        try {
            // Set the interval on chart for live bar updates
            this.chart.setInterval(timeframe);
            this.currentTimeframe = timeframe;
            
            // Save timeframe to localStorage
            localStorage.setItem('selectedTimeframe', timeframe);
            
            // Update WebSocket OHLC stream for new interval
            if (wsManager) {
                wsManager.setInterval(timeframe);
            }
            
            // Update countdown immediately for new timeframe
            this.updateBarCountdown();
            
            const response = await api.getKlines(timeframe);
            if (response.data) {
                this.chart.setData(response.data);
                await db.saveKlines(timeframe, response.data);
            }
        } catch (error) {
            console.error('Failed to load klines:', error);
        }
    }

    // Quietly refresh klines without UI disruption (called on new bar open)
    async refreshKlinesQuietly() {
        try {
            const response = await api.getKlines(this.currentTimeframe);
            if (response.data && response.data.length > 0) {
                // setData with preserveView=true will merge with live data
                this.chart.setData(response.data, true);
                await db.saveKlines(this.currentTimeframe, response.data);
                console.log('[App] Klines refreshed and merged');
            }
        } catch (error) {
            console.error('[App] Failed to refresh klines:', error);
        }
    }

    updatePriceDisplay(price, priceData = null) {
        // Use smart price formatter for any crypto price magnitude
        this.elements.currentPrice.textContent = formatSmartPrice(price);

        // Only update chart from price if OHLC stream is NOT connected
        // (OHLC stream provides much more accurate candle data)
        if (this.chart && price > 0 && priceData && !priceData.ohlcConnected) {
            this.chart.updateLastBar(price);
        }
        
        // Update directional analysis with new price (throttled)
        this.throttledDirectionUpdate(price);
    }
    
    throttledDirectionUpdate(price) {
        // Update direction analysis every 3 seconds max
        const now = Date.now();
        if (!this.lastDirectionUpdate || now - this.lastDirectionUpdate > 3000) {
            // Use the same base level source as analytics (but NOT any LD "signal" windowing).
            // This prevents LONG (15-30%) from flickering when other analytics are using a near-price slice.
            const directionLevels = (this.useFullBookForAnalytics && this.fullBookLevels?.length)
                ? this.fullBookLevels
                : this.levels;
            
            if (typeof directionAnalysis !== 'undefined' && directionLevels.length > 0) {
                directionAnalysis.update(directionLevels, price, this.currentSymbol);
                this.lastDirectionUpdate = now;
                
                // Also update chart projections
                this.updateProjections();
            }
        }
    }
    
    /**
     * Update chart projections from direction analysis
     */
    updateProjections() {
        if (typeof directionAnalysis === 'undefined' || !this.chart) return;
        
        const projectionData = directionAnalysis.getProjectionData();
        if (projectionData) {
            this.chart.setProjectionData(projectionData);
        }
    }
    
    /**
     * Setup collapsible panels with localStorage persistence
     */
    setupCollapsiblePanels() {
        const collapsiblePanels = document.querySelectorAll('.panel.collapsible');
        
        collapsiblePanels.forEach(panel => {
            const panelId = panel.dataset.panel;
            const header = panel.querySelector('.panel-header');
            
            if (!panelId || !header) return;
            
            // Load saved state - default to HTML initial state (has 'expanded' class or not)
            const savedState = localStorage.getItem(`panel_${panelId}_expanded`);
            const htmlDefault = panel.classList.contains('expanded');
            
            if (savedState === 'false') {
                panel.classList.remove('expanded');
            } else if (savedState === 'true') {
                panel.classList.add('expanded');
            }
            // If no saved state, keep the HTML default (don't change class)
            
            // Add click handler
            header.addEventListener('click', (e) => {
                // Don't toggle if clicking on filter buttons or other interactive elements
                if (e.target.closest('.filter-btn') || 
                    e.target.closest('.exchange-selector') || 
                    e.target.closest('.panel-badge') ||
                    e.target.closest('button') ||
                    e.target.closest('input')) {
                    return;
                }
                
                panel.classList.toggle('expanded');
                localStorage.setItem(`panel_${panelId}_expanded`, panel.classList.contains('expanded'));
            });
        });
    }
    
    /**
     * Setup regime mode selector buttons
     */
    setupRegimeModeSelector() {
        // Scope to regime panel only (exclude alpha mode buttons)
        const container = document.querySelector('.regime-panel .regime-mode-selector');
        if (!container) return;
        const modeButtons = container.querySelectorAll('.regime-mode-btn');
        
        // Load saved mode
        const savedMode = localStorage.getItem('regimeMode') || 'investor';
        
        modeButtons.forEach(btn => {
            const mode = btn.dataset.mode;
            
            // Set initial active state
            if (mode === savedMode) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
            
            // Add click handler
            btn.addEventListener('click', () => {
                // Update button states within this container only
                modeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Save mode
                localStorage.setItem('regimeMode', mode);
                
                // Update chart's regime engine mode
                if (this.chart && this.chart.regimeEngine) {
                    this.chart.regimeEngine.currentMode = mode;
                    // Reset tick counter on mode change
                    this.chart.regimeEngine.regimeTickCount = 0;
                    // Clear ROC buffers for fresh start
                    this.chart.regimeEngine.ldBuffer = [];
                    this.chart.regimeEngine.bprBuffer = [];
                    this.chart.regimeEngine.alphaBuffer = [];
                }
                
                // Refresh analytics with new mode
                this.updateAnalyticsData();
            });
        });
    }
    
    /**
     * Setup Alpha mode selector buttons
     */
    setupAlphaModeSelector() {
        // Scope to alpha panel only
        const container = document.querySelector('.alpha-score-panel .alpha-mode-selector');
        if (!container) return;
        const modeButtons = container.querySelectorAll('.alpha-mode-btn');
        const savedMode = localStorage.getItem('alphaMode') || 'investor';
        
        const applyMode = (mode) => {
            localStorage.setItem('alphaMode', mode);
            if (this.chart) {
                this.chart.alphaMode = mode;
                // Reset alpha-related smoothing to avoid cross-mode artifacts
                const re = this.chart.regimeEngine || {};
                if (re) {
                    re.ifvNormEma = null;
                    re.ldNormEma = null;
                    re.bprNormEma = null;
                    re.alphaEma = null;
                    re.lastAlphaDisplay = null;
                    re.lastAlphaRenderTs = 0;
                }
            }
        };
        
        modeButtons.forEach(btn => {
            const mode = btn.dataset.alphaMode;
            // Set initial state
            if (mode === savedMode) btn.classList.add('active');
            else btn.classList.remove('active');
            
            btn.addEventListener('click', () => {
                // Update button states within this container only
                modeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyMode(mode);
            });
        });
        
        applyMode(savedMode);
    }
    
    /**
     * Setup Alpha sensitivity slider
     * Range: 0-100, where 50 = 1.0x (center/default)
     * Left (0): 0.001x, Right (100): 2.0x
     */
    setupAlphaSensitivitySlider() {
        const slider = document.getElementById('alphaSensitivity');
        const valueDisplay = document.getElementById('alphaSensitivityValue');
        const warningDisplay = document.getElementById('alphaSensitivityWarning');
        if (!slider || !valueDisplay) return;
        
        // Convert slider position (0-100) to multiplier (0.001-2.0, with 50=1.0)
        const sliderToMultiplier = (val) => {
            if (val <= 50) {
                // 0→0.001, 50→1.0 (exponential curve)
                const t = val / 50; // 0 to 1
                return 0.001 + (1.0 - 0.001) * (t * t * t); // cubic ease
            } else {
                // 50→1.0, 100→2.0 (linear)
                return 1.0 + (val - 50) / 50;
            }
        };
        
        // Load saved sensitivity (0-100, where 50 = 1.0x)
        const savedValue = parseInt(localStorage.getItem('alphaSensitivity') || '50', 10);
        slider.value = savedValue;
        
        const updateDisplay = (value) => {
            const multiplier = sliderToMultiplier(value);
            valueDisplay.textContent = multiplier < 0.1 ? multiplier.toFixed(3) + 'x' : multiplier.toFixed(2) + 'x';
            
            // Color the value based on direction (neutral colors, no good/bad implication)
            if (value < 50) {
                valueDisplay.style.color = 'rgba(56, 189, 248, 0.95)'; // Cyan for SLOW (calm)
            } else if (value > 50) {
                valueDisplay.style.color = 'rgba(251, 191, 36, 0.95)'; // Amber for FAST (energetic)
            } else {
                valueDisplay.style.color = 'var(--text-secondary)'; // Default
            }
            
            // Show warning for ultra-slow settings (< 0.1x)
            if (warningDisplay) {
                if (multiplier < 0.1) {
                    warningDisplay.classList.add('visible');
                    warningDisplay.title = 'Ultra-slow: May not respond to rapid market changes';
                } else {
                    warningDisplay.classList.remove('visible');
                }
            }
        };
        
        const applyMultiplier = (value) => {
            const multiplier = sliderToMultiplier(value);
            localStorage.setItem('alphaSensitivity', value);
            if (this.chart) {
                this.chart.alphaSensitivityMultiplier = multiplier;
            }
        };
        
        // Initialize
        updateDisplay(savedValue);
        applyMultiplier(savedValue);
        
        // Live update on input
        slider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            updateDisplay(value);
        });
        
        // Apply on change (mouseup/touchend)
        slider.addEventListener('change', (e) => {
            const value = parseInt(e.target.value, 10);
            applyMultiplier(value);
        });
        
        // Double-click slider to reset to default
        slider.addEventListener('dblclick', () => {
            slider.value = 50;
            updateDisplay(50);
            applyMultiplier(50);
        });
        
        // Click on value display to reset to default
        valueDisplay.style.cursor = 'pointer';
        valueDisplay.title = 'Click to reset to default';
        valueDisplay.addEventListener('click', () => {
            slider.value = 50;
            updateDisplay(50);
            applyMultiplier(50);
        });
    }
    
    /**
     * Setup MCS (Market Consensus Signal) mode selector buttons
     */
    setupMCSModeSelector() {
        const modeButtons = document.querySelectorAll('.mcs-mode-btn');
        
        // Load saved mode
        const savedMode = localStorage.getItem('mcsMode') || 'conservative';
        
        modeButtons.forEach(btn => {
            const mode = btn.dataset.mode;
            
            // Set initial active state
            if (mode === savedMode) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
            
            // Add click handler
            btn.addEventListener('click', () => {
                // Update button states
                modeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                // Update chart's MCS mode
                if (this.chart) {
                    this.chart.setMCSMode(mode);
                }
            });
        });
    }
    
    /**
     * Update analytics with appropriate data (full book or filtered)
     * Called when data is loaded or when the Full Book toggle changes
     */
    updateAnalyticsData() {
        if (!this.currentPrice) return;
        
        // Choose base data source based on toggle
        const baseAnalyticsLevels = this.useFullBookForAnalytics 
            ? (this.fullBookLevels.length ? this.fullBookLevels : this.levels)
            : this.levels;
        
        // LD Mode shaping:
        // - signal: focus on near-price liquidity window for clearer bias
        // - context: keep broader book (as selected above)
        let analyticsLevels = baseAnalyticsLevels;
        const ldMode = (this.levelSettings?.ldMode || 'signal');
        const ldRange = Math.max(1, Math.min(50, parseInt(this.levelSettings?.ldRange || 10, 10)));
        
        if (ldMode === 'signal') {
            const sourceLevels = this.fullBookLevels.length ? this.fullBookLevels : baseAnalyticsLevels;
            const price = this.currentPrice;
            const minP = price * (1 - (ldRange / 100));
            const maxP = price * (1 + (ldRange / 100));
            
            const windowed = (sourceLevels || []).filter(l => {
                const p = parseFloat(l.price);
                return p > 0 && p >= minP && p <= maxP;
            });
            
            // Only switch if we have usable data; otherwise keep base levels
            if (windowed.length > 0) {
                analyticsLevels = windowed;
            }
        }
        
        // Update Order Flow indicators (BPR, LD, OBIC, Alpha Score, Regime Engine)
        // VWMP/IFV fair value is ALWAYS computed from the full order book for accuracy
        // (independent of the analytics toggle).
        const fairValueLevels = this.fullBookLevels.length ? this.fullBookLevels : analyticsLevels;
        this.chart.setOrderFlowLevels(analyticsLevels, this.currentPrice, fairValueLevels);
        
        // Update Price Forecast (directional analysis)
        if (typeof directionAnalysis !== 'undefined') {
            // Directional forecast needs the unwindowed base book so LONG (15-30%) doesn't get wiped out.
            // (LD "signal" windowing above is for order-flow metrics only.)
            directionAnalysis.update(baseAnalyticsLevels, this.currentPrice, this.currentSymbol);
            this.lastDirectionUpdate = Date.now();
            this.updateProjections();
        }

        // Evaluate alerts (no effect until metric registry is attached)
        if (this.alertsManager) {
            const snapshot = this.getAlertsSnapshot(analyticsLevels);
            this.alertsManager.evaluate(snapshot);
        }
        
        // Log data source for debugging
        const source = this.useFullBookForAnalytics ? 'Full Book' : 'Visible Only';
        const levelCount = analyticsLevels.length;
        console.log(`[Analytics] Using ${source}: ${levelCount} levels`);
    }

    /**
     * Build a read-only snapshot for alerts evaluation.
     * (Metric registry determines what to read from this.)
     */
    getAlertsSnapshot(analyticsLevels) {
        return {
            ts: Date.now(),
            symbol: (this.currentSymbol || 'BTC').toUpperCase(),
            barId: this.alertsManager?.currentBarId || null,
            timeframe: this.currentTimeframe || null,
            price: this.currentPrice || 0,
            depth: this.lastDepthStats || null,
            levels: analyticsLevels || [],
            fairValue: this.chart?.fairValueIndicators?.lastValues || null,
            alpha: this.chart?.alphaScore ?? null,
            regime: this.chart?.regimeEngine?.currentRegime || null,
            regimeSignals: this.chart?.regimeEngine?.signals || null,
            marketConsensus: this.chart?.marketConsensus || null,
            direction: (typeof directionAnalysis !== 'undefined') ? directionAnalysis.lastAnalysis : null
        };
    }
    
    /**
     * Initialize projection toggles from saved state
     */
    initProjectionToggles() {
        const showTargets = localStorage.getItem('showTargets') === 'true';
        const showRays = localStorage.getItem('showRays') === 'true';
        const showConfidence = localStorage.getItem('showConfidence') === 'true';
        const showEmaGrid = localStorage.getItem('showEmaGrid') === 'true';
        const showMid = localStorage.getItem('showMid') === 'true';
        const showIFV = localStorage.getItem('showIFV') === 'true';
        const showVWMP = localStorage.getItem('showVWMP') === 'true';
        const showNearestClusterWinner = localStorage.getItem('showNearestClusterWinner') === 'true';
        const emaGridSpacing = parseFloat(localStorage.getItem('emaGridSpacing')) || 0.003;
        
        // Load showLevels setting (default TRUE if never set, but honor if disabled)
        const showLevels = localStorage.getItem('showLevels') !== 'false';
        if (this.elements.showLevels) {
            this.elements.showLevels.checked = showLevels;
        }
        // Apply to chart
        this.chart.toggleLevels(showLevels);
        
        // Apply confidence state first (affects how targets/rays are drawn)
        if (showConfidence) {
            this.chart.toggleConfidence(true);
            if (typeof directionAnalysis !== 'undefined') {
                directionAnalysis.setShowConfidence(true);
            }
        }
        
        // Apply saved state to chart
        if (showTargets) {
            this.chart.toggleTargetLines(true);
            this.updateProjections();
        }
        if (showRays) {
            this.chart.toggleRays(true);
            this.updateProjections();
        }
        
        // Apply EMA grid settings
        const emaPeriod = parseInt(localStorage.getItem('emaPeriod')) || 20;
        const emaColor = localStorage.getItem('emaColor') || 'rgba(156, 163, 175, 0.8)';
        if (this.chart.emaGrid) {
            this.chart.emaGrid.period = emaPeriod;
            this.chart.emaGrid.color = emaColor;
        }
        this.chart.setEmaGridSpacing(emaGridSpacing);
        if (showEmaGrid) {
            this.chart.toggleEmaGrid(true);
        }
        
        // Apply ZEMA grid settings
        const showZemaGrid = localStorage.getItem('showZemaGrid') === 'true';
        const zemaPeriod = parseInt(localStorage.getItem('zemaPeriod')) || 30;
        const zemaGridSpacing = parseFloat(localStorage.getItem('zemaGridSpacing')) || 0.003;
        const zemaColor = localStorage.getItem('zemaColor') || 'rgba(139, 92, 246, 0.8)';
        
        if (this.chart.initZemaGrid) {
            this.chart.initZemaGrid();
            this.chart.zemaGrid.period = zemaPeriod;
            this.chart.zemaGrid.color = zemaColor;
            this.chart.setZemaGridSpacing(zemaGridSpacing);
        }
        if (showZemaGrid && this.chart.toggleZemaGrid) {
            this.chart.toggleZemaGrid(true);
        }
        
        // Apply BB Pulse indicator settings  
        const showBBPulse = localStorage.getItem('showBBPulse') === 'true';
        if (this.chart.toggleBBPulse) {
            if (showBBPulse) {
                this.chart.toggleBBPulse(true);
            }
        }
        
        // Apply EMA/ZEMA signal settings
        const showEmaSignals = localStorage.getItem('showEmaSignals') === 'true';
        const showZemaSignals = localStorage.getItem('showZemaSignals') === 'true';
        if (showEmaSignals && this.chart.toggleEmaSignals) {
            this.chart.toggleEmaSignals(true);
        }
        if (showZemaSignals && this.chart.toggleZemaSignals) {
            this.chart.toggleZemaSignals(true);
        }
        
        // Set checkbox states
        const showEmaSignalsEl = document.getElementById('showEmaSignals');
        const showZemaSignalsEl = document.getElementById('showZemaSignals');
        if (showEmaSignalsEl) showEmaSignalsEl.checked = showEmaSignals;
        if (showZemaSignalsEl) showZemaSignalsEl.checked = showZemaSignals;
        
        // Apply fair value indicator settings
        if (showMid) {
            this.chart.toggleMid(true);
        }
        if (showIFV) {
            this.chart.toggleIFV(true);
        }
        if (showVWMP) {
            this.chart.toggleVWMP(true);
        }

        // Apply nearest cluster winner markers toggle
        if (this.elements.showNearestClusterWinner) {
            this.elements.showNearestClusterWinner.checked = showNearestClusterWinner;
        }
        if (this.chart && this.chart.toggleNearestClusterWinner) {
            this.chart.toggleNearestClusterWinner(showNearestClusterWinner);
        }
    }

    onNearestClusterWinnerBarClosed(detail) {
        // Only compute when enabled
        if (localStorage.getItem('showNearestClusterWinner') !== 'true') return;
        if (!this.chart || typeof this.chart.upsertNearestClusterWinnerMarker !== 'function') return;
        if (!Array.isArray(this.levels) || this.levels.length === 0) return;

        const intervalSec = (typeof this.chart.getIntervalSeconds === 'function') ? this.chart.getIntervalSeconds() : 0;
        let closedTime = detail?.closedTime;
        if (!closedTime && detail?.time && intervalSec) {
            closedTime = detail.time - intervalSec;
        }
        if (!closedTime || closedTime <= 0) return;

        let closePrice = detail?.closedClose;
        if ((!closePrice || closePrice <= 0) && this.chart.localCandles && typeof this.chart.localCandles.get === 'function') {
            const c = this.chart.localCandles.get(closedTime);
            closePrice = c?.close;
        }
        if (!closePrice || closePrice <= 0) return;

        // Closest resistance above close
        let above = null;
        let aboveDist = Infinity;
        // Closest support below close
        let below = null;
        let belowDist = Infinity;

        for (const lvl of this.levels) {
            const p = parseFloat(lvl?.price);
            const v = parseFloat(lvl?.volume);
            if (!p || !Number.isFinite(p) || !v || !Number.isFinite(v)) continue;

            if (lvl.type === 'resistance' && p > closePrice) {
                const d = p - closePrice;
                if (d < aboveDist) {
                    aboveDist = d;
                    above = { price: p, volume: v };
                }
            } else if (lvl.type === 'support' && p < closePrice) {
                const d = closePrice - p;
                if (d < belowDist) {
                    belowDist = d;
                    below = { price: p, volume: v };
                }
            }
        }

        if (!above || !below) return;
        const sum = above.volume + below.volume;
        if (!sum || sum <= 0) return;

        const pct = Math.round((Math.abs(above.volume - below.volume) / sum) * 100);
        if (!Number.isFinite(pct) || pct <= 0) return;

        const highWins = above.volume > below.volume;
        const marker = {
            time: closedTime,
            position: highWins ? 'aboveBar' : 'belowBar',
            color: highWins ? (this.levelSettings?.barDownColor || '#ef4444') : (this.levelSettings?.barUpColor || '#10b981'),
            shape: highWins ? 'arrowDown' : 'arrowUp',
            text: pct + '%'
        };

        this.chart.upsertNearestClusterWinnerMarker(marker);
    }

    togglePriceVisibility() {
        const display = this.elements.priceDisplay;
        const toggle = this.elements.priceToggle;
        const headerMetrics = document.querySelector('.header-metrics');
        const isHidden = display.classList.toggle('hidden-price');
        
        // Toggle eye icons
        toggle.querySelector('.eye-open').style.display = isHidden ? 'none' : 'block';
        toggle.querySelector('.eye-closed').style.display = isHidden ? 'block' : 'none';
        
        // Hide/show header metrics (LD Delta, Alpha)
        if (headerMetrics) {
            headerMetrics.style.display = isHidden ? 'none' : 'flex';
        }
        
        // Save preference
        localStorage.setItem('hidePriceDisplay', isHidden);
    }

    loadPriceVisibility() {
        const isHidden = localStorage.getItem('hidePriceDisplay') === 'true';
        const headerMetrics = document.querySelector('.header-metrics');
        
        if (isHidden) {
            this.elements.priceDisplay.classList.add('hidden-price');
            this.elements.priceToggle.querySelector('.eye-open').style.display = 'none';
            this.elements.priceToggle.querySelector('.eye-closed').style.display = 'block';
            
            // Hide header metrics too
            if (headerMetrics) {
                headerMetrics.style.display = 'none';
            }
        }
    }
    
    /**
     * Toggle chart fullscreen mode (mobile/tablet)
     */
    toggleChartFullscreen() {
        const chartSection = document.querySelector('.chart-section');
        const btnFullscreen = document.getElementById('btnFullscreen');
        
        if (!chartSection) return;
        
        const isFullscreen = chartSection.classList.toggle('fullscreen');
        
        // Toggle icon visibility
        if (btnFullscreen) {
            btnFullscreen.querySelector('.fullscreen-expand').style.display = isFullscreen ? 'none' : 'block';
            btnFullscreen.querySelector('.fullscreen-collapse').style.display = isFullscreen ? 'block' : 'none';
        }
        
        // Prevent body scroll when fullscreen
        document.body.style.overflow = isFullscreen ? 'hidden' : '';
        
        // Resize chart to fit new dimensions
        if (this.chart && this.chart.chart) {
            setTimeout(() => {
                this.chart.chart.resize(
                    chartSection.querySelector('.chart-container').clientWidth,
                    chartSection.querySelector('.chart-container').clientHeight
                );
            }, 100);
        }
        
        // Handle escape key to exit fullscreen
        if (isFullscreen) {
            this._fullscreenEscHandler = (e) => {
                if (e.key === 'Escape') {
                    this.toggleChartFullscreen();
                }
            };
            document.addEventListener('keydown', this._fullscreenEscHandler);
        } else {
            if (this._fullscreenEscHandler) {
                document.removeEventListener('keydown', this._fullscreenEscHandler);
                this._fullscreenEscHandler = null;
            }
        }
    }
    
    /**
     * Setup sidebar collapse functionality
     */
    setupSidebarCollapse() {
        const leftSidebar = document.getElementById('sidebarLeft');
        const rightSidebar = document.getElementById('sidebarRight');
        const collapseLeft = document.getElementById('collapseLeftSidebar');
        const collapseRight = document.getElementById('collapseRightSidebar');
        
        // Load saved states
        const leftCollapsed = localStorage.getItem('sidebarLeftCollapsed') === 'true';
        const rightCollapsed = localStorage.getItem('sidebarRightCollapsed') === 'true';
        
        // Apply saved states
        if (leftCollapsed && leftSidebar) {
            leftSidebar.classList.add('collapsed');
        }
        if (rightCollapsed && rightSidebar) {
            rightSidebar.classList.add('collapsed');
        }
        
        // Left sidebar toggle
        if (collapseLeft && leftSidebar) {
            collapseLeft.addEventListener('click', () => {
                leftSidebar.classList.toggle('collapsed');
                const isCollapsed = leftSidebar.classList.contains('collapsed');
                localStorage.setItem('sidebarLeftCollapsed', isCollapsed);
                
                // Trigger chart resize after animation
                setTimeout(() => {
                    if (this.chart && this.chart.chart) {
                        this.chart.chart.resize(
                            this.chart.container.clientWidth,
                            this.chart.container.clientHeight
                        );
                    }
                }, 300);
            });
        }
        
        // Right sidebar toggle
        if (collapseRight && rightSidebar) {
            collapseRight.addEventListener('click', () => {
                rightSidebar.classList.toggle('collapsed');
                const isCollapsed = rightSidebar.classList.contains('collapsed');
                localStorage.setItem('sidebarRightCollapsed', isCollapsed);
                
                // Trigger chart resize after animation
                setTimeout(() => {
                    if (this.chart && this.chart.chart) {
                        this.chart.chart.resize(
                            this.chart.container.clientWidth,
                            this.chart.container.clientHeight
                        );
                    }
                }, 300);
            });
        }
    }

    updateSymbolLabels() {
        const symbol = this.currentSymbol;
        
        // Page title
        document.title = `${symbol} Synthetic Order Book`;
        
        // Header
        document.getElementById('headerSymbol').textContent = symbol;
        
        // Update currency quick-switch buttons active state
        document.querySelectorAll('.currency-btn').forEach(btn => {
            if (btn.dataset.symbol === symbol) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // Min volume label in settings
        const minVolSymbol = document.getElementById('minVolSymbol');
        if (minVolSymbol) minVolSymbol.textContent = symbol;
        
        // Min volume value
        const minVolValue = document.getElementById('minVolValue');
        if (minVolValue) {
            minVolValue.textContent = this.levelSettings.minVolume + ' ' + symbol;
        }
        
        // Legend modal symbols
        document.querySelectorAll('.legend-symbol').forEach(el => {
            el.textContent = symbol;
        });
    }

    async changeSymbol(symbol) {
        symbol = symbol.toUpperCase().trim();
        
        // Validate symbol
        if (!symbol || symbol.length < 2 || symbol.length > 10) {
            this.elements.symbolInput.value = this.currentSymbol;
            return;
        }
        
        // No change
        if (symbol === this.currentSymbol) {
            return;
        }
        
        // Save new symbol and reload page to ensure clean state (no cache mixing)
        localStorage.setItem('selectedSymbol', symbol);
        window.location.reload();
    }

    showSymbolError(error) {
        const exchange = error.exchange || 'Exchange';
        const symbol = error.symbol || this.currentSymbol;
        
        // Show toast notification
        this.showToast(`${symbol} not found on ${exchange}`, 'warning');
    }

    showToast(message, type = 'info') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        // Animate in
        setTimeout(() => toast.classList.add('show'), 10);
        
        // Remove after 4 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    updateDepthStats(depthData) {
        const { bids, asks } = depthData;
        
        // Calculate totals
        const totalBid = bids.length ? bids[bids.length - 1].cumulative : 0;
        const totalAsk = asks.length ? asks[asks.length - 1].cumulative : 0;
        
        this.elements.totalBidVol.textContent = formatSmartVolume(totalBid, this.currentSymbol);
        this.elements.totalAskVol.textContent = formatSmartVolume(totalAsk, this.currentSymbol);
        
        // Calculate imbalance
        const total = totalBid + totalAsk;
        if (total > 0) {
            const imbalanceNum = ((totalBid - totalAsk) / total * 100);
            const imbalance = imbalanceNum.toFixed(1);
            const imbalanceEl = this.elements.imbalance;
            imbalanceEl.textContent = (imbalance > 0 ? '+' : '') + imbalance + '%';
            imbalanceEl.className = 'stat-value ' + (imbalance > 0 ? 'bid' : 'ask');

            // Cache for alerts snapshot
            this.lastDepthStats = {
                totalBid,
                totalAsk,
                imbalancePct: imbalanceNum,
                ts: Date.now()
            };
        }
    }

    renderLevelsList() {
        const container = this.elements.levelsList;
        
        // Preserve sidebar scroll position during updates
        const sidebar = document.querySelector('.sidebar-right');
        const scrollTop = sidebar ? sidebar.scrollTop : 0;
        
        // Filter levels
        let filtered = this.levels;
        if (this.filter !== 'all') {
            filtered = this.levels.filter(l => l.type === this.filter);
        }

        // Calculate max volume for bar scaling
        const maxVol = Math.max(...filtered.map(l => l.volume));

        // Generate HTML
        const html = filtered.map((level, index) => {
            const isSupport = level.type === 'support';
            const volPercent = (level.volume / maxVol * 100).toFixed(0);
            const distancePercent = this.currentPrice > 0 
                ? ((level.price - this.currentPrice) / this.currentPrice * 100).toFixed(2)
                : '0.00';

            return `
                <div class="level-item ${level.type}" data-price="${level.price}" data-index="${index}">
                    <div class="level-info">
                        <div class="level-price">${formatSmartPrice(level.price)}</div>
                        <div class="level-meta">
                            ${isSupport ? '▲ Support' : '▼ Resistance'} • 
                            ${distancePercent > 0 ? '+' : ''}${distancePercent}% • 
                            ${level.orders} orders
                        </div>
                    </div>
                    <div class="level-volume">
                        <div class="level-vol-value">${this.formatVolume(level.volume)} ${this.currentSymbol}</div>
                        <div class="level-vol-bar">
                            <div class="level-vol-fill" style="width: ${volPercent}%"></div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = html || '<div class="loading">No levels found</div>';
        
        // Restore sidebar scroll position after DOM updates
        if (sidebar && scrollTop > 0) {
            sidebar.scrollTop = scrollTop;
        }
    }

    highlightLevel(level) {
        // Remove existing highlights
        document.querySelectorAll('.level-item.highlighted').forEach(el => {
            el.classList.remove('highlighted');
        });

        // Find and highlight matching level
        const levelItems = document.querySelectorAll('.level-item');
        levelItems.forEach(item => {
            const price = parseFloat(item.dataset.price);
            if (Math.abs(price - level.price) < 1) {
                item.classList.add('highlighted');
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });
    }

    highlightLevelByPrice(price) {
        document.querySelectorAll('.level-item').forEach(item => {
            const itemPrice = parseFloat(item.dataset.price);
            item.classList.toggle('highlighted', Math.abs(itemPrice - price) < 1);
        });
    }

    formatVolume(vol) {
        if (vol >= 1000) {
            return (vol / 1000).toFixed(2) + 'K';
        }
        return vol.toFixed(2);
    }

    setConnectionStatus(connected, details = '') {
        const statusEl = this.elements.exchangeStatus;
        const dot = statusEl.querySelector('.status-dot');
        const text = statusEl.querySelector('span:last-child');
        
        dot.className = 'status-dot ' + (connected ? 'connected' : 'error');
        text.textContent = connected ? 'Connected' : 'Error';
        
        if (details) {
            text.title = details;
        }
    }

    setLoadingState(loading) {
        // Loading state - no longer need visual indicator since always live
    }

    updateLastUpdate() {
        const now = new Date();
        this.elements.lastUpdate.textContent = 'Last update: ' + now.toLocaleTimeString();
    }

    async updateCacheStatus() {
        try {
            const stats = await db.getStats();
            const totalSize = Object.values(stats).reduce((sum, s) => sum + s.size, 0);
            const sizeKB = (totalSize / 1024).toFixed(1);
            this.elements.cacheStatus.textContent = `Cache: ${sizeKB} KB`;
        } catch (error) {
            this.elements.cacheStatus.textContent = 'Cache: N/A';
        }
    }

    destroy() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
        }
        if (this.chart) {
            this.chart.destroy();
        }
        if (this.depthChart) {
            this.depthChart.destroy();
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new OrderBookApp();
    window.app.init().catch(console.error);
});

// ============================================
// PWA Install Prompt
// ============================================
(function() {
    let deferredPrompt = null;
    let installBanner = null;
    
    // Check if already installed
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches 
        || window.navigator.standalone === true;
    
    if (isStandalone) return; // Already installed, skip
    
    // Check if user dismissed the banner recently (24 hours)
    const dismissedAt = localStorage.getItem('pwa_install_dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt) < 24 * 60 * 60 * 1000) {
        return;
    }
    
    // Create install banner
    function createInstallBanner() {
        const banner = document.createElement('div');
        banner.id = 'pwaInstallBanner';
        banner.className = 'pwa-install-banner';
        banner.innerHTML = `
            <div class="pwa-install-content">
                <div class="pwa-install-icon">
                    <svg viewBox="0 0 48 48" width="40" height="40">
                        <defs>
                            <linearGradient id="pwa-bg" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#111827"/>
                                <stop offset="100%" stop-color="#0a0e17"/>
                            </linearGradient>
                            <linearGradient id="pwa-green" x1="0%" y1="100%" x2="0%" y2="0%">
                                <stop offset="0%" stop-color="#059669"/>
                                <stop offset="100%" stop-color="#10b981"/>
                            </linearGradient>
                        </defs>
                        <rect fill="url(#pwa-bg)" width="48" height="48" rx="10"/>
                        <rect x="8" y="24" width="5" height="14" rx="1" fill="url(#pwa-green)"/>
                        <rect x="16" y="18" width="5" height="16" rx="1" fill="#ef4444"/>
                        <rect x="24" y="14" width="5" height="18" rx="1" fill="url(#pwa-green)"/>
                        <rect x="32" y="10" width="5" height="20" rx="1" fill="url(#pwa-green)"/>
                        <path d="M6 38 Q18 30 30 24 T44 16" stroke="#3b82f6" stroke-width="2" fill="none" stroke-linecap="round"/>
                    </svg>
                </div>
                <div class="pwa-install-text">
                    <strong>Install Order Book</strong>
                    <span>Quick access from your desktop</span>
                </div>
                <div class="pwa-install-actions">
                    <button class="pwa-install-btn" id="pwaInstallBtn">Install</button>
                    <button class="pwa-dismiss-btn" id="pwaDismissBtn">×</button>
                </div>
            </div>
        `;
        document.body.appendChild(banner);
        
        // Bind events
        document.getElementById('pwaInstallBtn').addEventListener('click', installApp);
        document.getElementById('pwaDismissBtn').addEventListener('click', dismissBanner);
        
        return banner;
    }
    
    // Show the banner with animation
    function showBanner() {
        if (!installBanner) {
            installBanner = createInstallBanner();
        }
        // Small delay for animation
        setTimeout(() => {
            installBanner.classList.add('show');
        }, 2000); // Show after 2 seconds
    }
    
    // Install the app
    async function installApp() {
        if (!deferredPrompt) return;
        
        // Show the install prompt
        deferredPrompt.prompt();
        
        // Wait for user response
        const { outcome } = await deferredPrompt.userChoice;
        
        if (outcome === 'accepted') {
            console.log('PWA installed');
        }
        
        // Clear the prompt
        deferredPrompt = null;
        hideBanner();
    }
    
    // Dismiss the banner
    function dismissBanner() {
        localStorage.setItem('pwa_install_dismissed', Date.now().toString());
        hideBanner();
    }
    
    // Hide the banner
    function hideBanner() {
        if (installBanner) {
            installBanner.classList.remove('show');
            setTimeout(() => {
                installBanner.remove();
                installBanner = null;
            }, 300);
        }
    }
    
    // Listen for the beforeinstallprompt event
    window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent Chrome 67+ from automatically showing the prompt
        e.preventDefault();
        // Save the event for later
        deferredPrompt = e;
        // Show our custom banner
        showBanner();
    });
    
    // Hide banner if app is installed
    window.addEventListener('appinstalled', () => {
        console.log('PWA was installed');
        hideBanner();
        deferredPrompt = null;
    });
})();

