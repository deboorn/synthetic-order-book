/**
 * Synthetic Order Book - Chart Module
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * TradingView Lightweight Charts Integration
 * Candlestick chart with order book levels overlay
 */

/**
 * Smart price formatter that adapts decimal places based on price magnitude
 * (Also defined in app.js but needed here for standalone use)
 */
function formatSmartPriceChart(price, options = {}) {
    if (!price || isNaN(price)) return '$--';
    
    const { prefix = '$', compact = false } = options;
    const absPrice = Math.abs(price);
    
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
        decimals = 8;
    }
    
    return prefix + absPrice.toLocaleString('en-US', {
        minimumFractionDigits: Math.min(decimals, 2),
        maximumFractionDigits: decimals
    });
}

class OrderBookChart {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.chart = null;
        this.candleSeries = null;
        this.volumeSeries = null;
        this.levelLines = [];
        this.priceLines = [];
        this.showLevels = true;
        this.showVolume = false;
        this.currentPrice = 0;
        this.lastCandle = null;
        this.previousCandle = null; // Track previous candle to fill gaps
        this.priceLine = null;
        this.symbol = 'BTC';
        this.currentInterval = '1m'; // Track current timeframe
        this.localCandles = new Map(); // Local candle history (time => candle)
        this.useOHLCStream = false; // Flag when OHLC stream is active
        this._viewRestored = false; // Flag to prevent duplicate view restoration
        this.userSelectedPosition = null; // User's selected trade position (LONG, SHORT, or null)
        
        this.colors = {
            background: '#0a0e17',
            text: '#94a3b8',
            grid: '#1e293b',
            // Bar colors (classic red/green)
            upColor: '#10b981',
            downColor: '#ef4444',
            upWick: '#10b981',
            downWick: '#ef4444',
            volumeUp: 'rgba(16, 185, 129, 0.3)',
            volumeDown: 'rgba(239, 68, 68, 0.3)',
            // Level colors (vibrant cyan/magenta - eye-catching & distinct)
            supportLine: 'rgba(0, 217, 255, 0.9)',    // Electric cyan
            resistanceLine: 'rgba(255, 0, 110, 0.9)', // Hot magenta
            supportBg: 'rgba(0, 217, 255, 0.2)',
            resistanceBg: 'rgba(255, 0, 110, 0.2)'
        };
        
        // Level appearance settings
        this.levelSettings = {
            brightness: 80,    // 30-100%
            thickness: 2       // 1-5x multiplier
        };
        
        // Fair Value indicators
        this.fairValueIndicators = {
            showMid: false,      // Simple Mid Price
            showIFV: false,      // Implied Fair Value
            showVWMP: false,     // Volume-Weighted Mid Price
            midLine: null,       // Mid price line
            ifvLine: null,       // IFV price line
            vwmpLine: null,      // VWMP price line
            currentLevels: null  // Cached levels for calculations
        };
        
        // Historical Levels - footprints of past levels on chart
        this.historicalLevels = {
            enabled: localStorage.getItem('showHistoricalLevels') !== 'false', // Default ON
            brightness: parseFloat(localStorage.getItem('historicalLevelsBrightness') || '50') / 100, // 0-1
            previousLevels: [],           // Last known levels (for diffing)
            levelMarkers: [],             // Lightweight charts markers
            cachedData: new Map(),        // candleTime => [levels]
            moveThreshold: 0.005,         // 0.5% price move = level "moved"
            lastCandleTime: null,         // Last candle timestamp used
            currentInterval: null         // Track which interval data is for
        };
        
        // Historical Fair Value tracking - VWMP/IFV history plot (per-candle)
        this.historicalFairValue = {
            enabled: localStorage.getItem('showHistoricalFairValue') !== 'false', // Default ON
            maxCandles: 500,              // Cap history (lowest timeframe-friendly)
            cachedData: new Map(),        // candleTime => { vwmp, ifv, upsideTarget, downsideTarget }
            series: [],                   // Line series for rendering (managed)
            vwmpSeries: null,
            ifvSeries: null,
            upsideSeries: null,
            downsideSeries: null,
            lastSavedCandleTime: null,
            lastSaveTs: 0
        };
        
        // Order Flow Pressure indicators
        this.orderFlowPressure = {
            levels: null,
            currentPrice: null,
            obicCanvas: null,
            obicCtx: null
        };
        
        // BB Pulse Lighting MTF Indicator
        this.bbPulse = {
            enabled: localStorage.getItem('showBBPulse') === 'true',
            container: null,
            chart: null,
            series: {},     // Store all plot series
            markers: []     // Store signal markers
        };

        // Alert markers (plotted when alerts fire)
        this.alertMarkers = [];
        this.alertMarkersMax = 200;

        // Nearest cluster winner (closest resistance vs support) markers
        this.nearestClusterWinner = {
            enabled: localStorage.getItem('showNearestClusterWinner') === 'true',
            markers: [],
            markerByTime: new Map(),
            maxMarkers: 600
        };
        
        // Signal marker caches (for alerts)
        this.emaSignalMarkers = [];
        this.zemaSignalMarkers = [];
        
        // Trade setup suggestion (for alerts)
        this.tradeSetupRecommendation = 'WAIT';
        
        // Regime Engine - stores previous values for ROC calculations
        this.regimeEngine = {
            // Mode presets - affects sensitivity of regime detection
            // Lower thresholdMult = MORE sensitive (detect weaker signals)
            // Higher thresholdMult = LESS sensitive (only strong signals)
            modePresets: {
                marketMaker: { 
                    name: 'Market Maker',
                    rocWindow: 2, 
                    regimeMinTicks: 1, 
                    thresholdMult: 0.3, // Hyper sensitive - picks up any microstructure shift
                    probMinDelta: 0.02,
                    description: 'Very sensitive — rapid regime changes for scalping'
                },
                swingTrader: { 
                    name: 'Swing Trader',
                    rocWindow: 4, 
                    regimeMinTicks: 3, 
                    thresholdMult: 1.5, // Moderate - filters out noise
                    probMinDelta: 0.07,
                    description: 'Moderate sensitivity — smoother transitions'
                },
                investor: { 
                    name: 'Investor / HTF',
                    rocWindow: 6, 
                    regimeMinTicks: 5, 
                    thresholdMult: 5.0, // Extremely strict - only massive structural moves
                    probMinDelta: 0.12,
                    description: 'Low sensitivity — only major structural shifts'
                }
            },
            currentMode: localStorage.getItem('regimeMode') || 'investor',
            regimeTickCount: 0,
            lastRegime: null,
            // Previous values for rate of change (with smoothing buffers)
            prevLD: null,
            prevBPR: null,
            prevAlpha: null,
            prevVWMP: null,
            prevIFV: null,
            ldBuffer: [],
            bprBuffer: [],
            alphaBuffer: [],
            // Adaptive LD scaling & alpha display gating
            ldSamples: [],
            bprSamples: [],
            lastAlphaDisplay: null,
            lastAlphaRenderTs: 0,
            // EMA smoothing for IFV component (async data arrival noise filter)
            // α = 0.3 gives ~5 sample half-life - responsive but dampens oscillation
            ifvNormEma: null,
            ifvEmaAlpha: 0.3,
            // Alpha smoothing for regime engine ROC stability
            alphaEma: null,
            alphaEmaAlpha: 0.3,
            // Smoothing for LD/BPR norms (post-percentile)
            ldNormEma: null,
            bprNormEma: null,
            normEmaAlpha: 0.25,
            // Z-score normalization for ldRoc (self-calibrating across assets)
            // EMA decay factor: α = 0.1 (~20 sample half-life)
            ldRocZScore: {
                alpha: 0.1,
                emaMean: 0,
                emaVar: 1,       // Start with 1 to avoid div/0
                warmupCount: 0,
                warmupMin: 15    // Need 15 samples for reliable variance
            },
            // Current signals
            signals: {
                ld_roc: 0,
                ld_roc_z: 0,     // Z-score normalized ldRoc
                bpr_roc: 0,
                alpha_roc: 0,
                vwmp_ext: 0,
                ifv_ext: 0,
                support_gap: 0,
                resist_gap: 0,
                support_share: 0.5,
                resist_share: 0.5
            },
            // Current regime
            currentRegime: null
        };
    }

    setSymbol(symbol) {
        this.symbol = symbol;
        this._viewRestored = false; // Reset so new symbol gets its own saved view

        // Clear interval/symbol-scoped markers, then load saved ones for new symbol
        if (this.nearestClusterWinner) {
            this.nearestClusterWinner.markerByTime = new Map();
            this.nearestClusterWinner.markers = [];
        }
        this.loadNearestClusterWinner();
        
        // Reset regime engine to prevent cross-symbol contamination
        // Different coins have vastly different LD scales (BTC ~100 vs DOGE ~100,000)
        this.regimeEngine.prevLD = null;
        this.regimeEngine.prevBPR = null;
        this.regimeEngine.prevAlpha = null;
        this.regimeEngine.prevVWMP = null;
        this.regimeEngine.prevIFV = null;
        this.regimeEngine.ldBuffer = [];
        this.regimeEngine.bprBuffer = [];
        this.regimeEngine.alphaBuffer = [];
        this.regimeEngine.ifvNormEma = null;
        this.regimeEngine.ldSamples = [];
        this.regimeEngine.bprSamples = [];
        this.regimeEngine.lastAlphaDisplay = null;
        this.regimeEngine.lastAlphaRenderTs = 0;
        this.regimeEngine.alphaEma = null;
        this.regimeEngine.ldNormEma = null;
        this.regimeEngine.bprNormEma = null;
        this.regimeEngine.currentRegime = null;
        this.regimeEngine.regimeTickCount = 0;
        this.regimeEngine.lastRegime = null;
        
        // Reset z-score normalization (must recalibrate for new asset's LD scale)
        this.regimeEngine.ldRocZScore.emaMean = 0;
        this.regimeEngine.ldRocZScore.emaVar = 1;
        this.regimeEngine.ldRocZScore.warmupCount = 0;
        
        // Reset LD history for divergence/absorption detection
        if (this.ldHistory) {
            this.ldHistory.prevPrice = null;
            this.ldHistory.prevLD = null;
            this.ldHistory.absorption = null;
        }
        
        // Update LD unit label in sidebar
        const ldUnit = document.getElementById('ldUnit');
        if (ldUnit) {
            ldUnit.textContent = symbol;
        }
    }

    setLevelAppearance(settings) {
        if (settings.brightness !== undefined) {
            this.levelSettings.brightness = settings.brightness;
        }
        if (settings.thickness !== undefined) {
            this.levelSettings.thickness = settings.thickness;
        }
    }

    setColors(colorSettings) {
        if (colorSettings.barUp) {
            this.colors.upColor = colorSettings.barUp;
            this.colors.upWick = colorSettings.barUp;
            this.colors.volumeUp = this.hexToRgba(colorSettings.barUp, 0.3);
        }
        if (colorSettings.barDown) {
            this.colors.downColor = colorSettings.barDown;
            this.colors.downWick = colorSettings.barDown;
            this.colors.volumeDown = this.hexToRgba(colorSettings.barDown, 0.3);
        }
        if (colorSettings.levelSupport) {
            this.colors.supportLine = this.hexToRgba(colorSettings.levelSupport, 0.85);
            this.colors.supportBg = this.hexToRgba(colorSettings.levelSupport, 0.15);
        }
        if (colorSettings.levelResistance) {
            this.colors.resistanceLine = this.hexToRgba(colorSettings.levelResistance, 0.85);
            this.colors.resistanceBg = this.hexToRgba(colorSettings.levelResistance, 0.15);
        }
        
        // Apply to existing series if initialized
        if (this.candleSeries) {
            this.candleSeries.applyOptions({
                upColor: this.colors.upColor,
                downColor: this.colors.downColor
            });
        }
        if (this.volumeSeries) {
            // Volume colors need to be set per-bar, so we'll handle that in setData
        }
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    adjustOpacity(rgbaColor, newOpacity) {
        // Handle both rgba() and hex colors
        if (rgbaColor.startsWith('rgba')) {
            // Extract RGB values from rgba string
            const match = rgbaColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${newOpacity})`;
            }
        } else if (rgbaColor.startsWith('#')) {
            return this.hexToRgba(rgbaColor, newOpacity);
        }
        return rgbaColor; // fallback
    }

    // Calculate bar timestamp for a given time and interval
    getBarTime(timestamp, interval) {
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
        
        const seconds = intervals[interval] || intervals['4h'];
        
        // Weekly candles align to Monday 00:00 UTC (not Thursday/epoch)
        if (interval === '1w') {
            const REFERENCE_MONDAY = 345600; // Jan 5, 1970 00:00 UTC
            const sinceRef = timestamp - REFERENCE_MONDAY;
            const weeks = Math.floor(sinceRef / seconds);
            return REFERENCE_MONDAY + (weeks * seconds);
        }
        
        return Math.floor(timestamp / seconds) * seconds;
    }

    setInterval(interval) {
        if (this.currentInterval !== interval) {
            // Clear local candles when interval changes
            this.localCandles.clear();
            this.lastCandle = null;
            this.previousCandle = null;
            this.useOHLCStream = false;
            this._viewRestored = false; // Reset so new interval gets its own saved view
            
            // Clear and reload historical levels for new interval
            this.historicalLevels.cachedData.clear();
            this.historicalLevels.previousLevels = [];
            this.historicalLevels.currentInterval = interval;
            this.clearHistoricalLevelMarkers();
            
            // Clear and reload historical fair values for new interval
            this.historicalFairValue.cachedData.clear();
            this.historicalFairValue.lastSavedCandleTime = null;
            this.historicalFairValue.lastSaveTs = 0;
            this.clearHistoricalFairValueSeries();
            
            console.log(`[Chart] Interval changed to ${interval}, cleared local candles and historical data`);

            // Clear interval-scoped markers (will be reloaded from storage below)
            this.nearestClusterWinner.markerByTime = new Map();
            this.nearestClusterWinner.markers = [];
        }
        this.currentInterval = interval;

        // Reload interval-scoped historical fair value (VWMP/IFV history plot)
        if (this.historicalFairValue.enabled) {
            this.loadHistoricalFairValue();
        }
        
        // Load saved nearest cluster winner markers for this interval
        this.loadNearestClusterWinner();
    }

    init() {
        // Create chart
        this.chart = LightweightCharts.createChart(this.container, {
            width: this.container.clientWidth,
            height: this.container.clientHeight,
            layout: {
                background: { type: 'solid', color: this.colors.background },
                textColor: this.colors.text,
                fontFamily: "'JetBrains Mono', monospace"
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { visible: false }
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: {
                    width: 1,
                    color: 'rgba(59, 130, 246, 0.5)',
                    style: 2
                },
                horzLine: {
                    width: 1,
                    color: 'rgba(59, 130, 246, 0.5)',
                    style: 2
                }
            },
            rightPriceScale: {
                borderColor: this.colors.grid,
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.2
                },
                mode: LightweightCharts.PriceScaleMode.Logarithmic // Log scale like TradingView
            },
            timeScale: {
                borderColor: this.colors.grid,
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 12,  // Offset from right edge
                barSpacing: 6
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true
            },
            handleScale: {
                axisPressedMouseMove: true,
                mouseWheel: true,
                pinch: true
            }
        });

        // Create bar series
        this.candleSeries = this.chart.addBarSeries({
            upColor: this.colors.upColor,
            downColor: this.colors.downColor,
            thinBars: true,
            priceScaleId: 'right'
        });

        // Create volume series
        this.volumeSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: '',
            scaleMargins: {
                top: 0.85,
                bottom: 0
            }
        });

        // Handle resize with debounce
        this.setupResizeHandling();

        // Crosshair move handler for level highlighting
        this.chart.subscribeCrosshairMove((param) => {
            if (param.point) {
                this.highlightNearestLevel(param.seriesData.get(this.candleSeries));
            }
        });
        
        // Subscribe to time scale changes to persist zoom/pan
        this.setupViewPersistence();
        
        // Load historical levels (async, non-blocking)
        this.loadHistoricalLevels();
        
        // Load historical fair values (VWMP, IFV, targets)
        this.loadHistoricalFairValue();

        return this;
    }
    
    /**
     * Setup persistence for chart zoom and pan levels
     * Saves visible range to localStorage when user changes view
     */
    setupViewPersistence() {
        if (!this.chart) return;
        
        let saveTimeout = null;
        // Store per symbol and interval
        const getStorageKey = () => `chartView_${this.symbol || 'BTC'}_${this.currentInterval || '1m'}`;
        
        // Debounced save function
        const saveView = () => {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                try {
                    const timeScale = this.chart.timeScale();
                    const visibleRange = timeScale.getVisibleRange();
                    const barSpacing = timeScale.options().barSpacing;
                    
                    if (visibleRange) {
                        const viewState = {
                            visibleRange: visibleRange,
                            barSpacing: barSpacing,
                            savedAt: Date.now()
                        };
                        localStorage.setItem(getStorageKey(), JSON.stringify(viewState));
                    }
                } catch (e) {
                    // Silently fail if localStorage unavailable
                }
            }, 500); // Debounce 500ms
        };
        
        // Subscribe to visible time range changes (pan/scroll)
        this.chart.timeScale().subscribeVisibleTimeRangeChange(saveView);
        
        // Subscribe to visible logical range changes (zoom)
        this.chart.timeScale().subscribeVisibleLogicalRangeChange(saveView);
    }
    
    /**
     * Restore saved chart view (zoom/pan) from localStorage
     * Called after chart data is loaded
     */
    restoreSavedView() {
        if (!this.chart) return;
        
        const storageKey = `chartView_${this.symbol || 'BTC'}_${this.currentInterval || '1m'}`;
        
        try {
            const savedView = localStorage.getItem(storageKey);
            if (!savedView) return;
            
            const viewState = JSON.parse(savedView);
            
            // Only restore if saved within last 24 hours
            const maxAge = 24 * 60 * 60 * 1000; // 24 hours
            if (Date.now() - viewState.savedAt > maxAge) {
                localStorage.removeItem(storageKey);
                return;
            }
            
            const timeScale = this.chart.timeScale();
            
            // Restore bar spacing (zoom level)
            if (viewState.barSpacing) {
                timeScale.applyOptions({ barSpacing: viewState.barSpacing });
            }
            
            // Restore visible range (pan position)
            if (viewState.visibleRange && viewState.visibleRange.from && viewState.visibleRange.to) {
                // Slight delay to ensure data is rendered
                setTimeout(() => {
                    timeScale.setVisibleRange(viewState.visibleRange);
                }, 100);
            }
            
            console.log('[Chart] Restored saved view');
        } catch (e) {
            console.warn('[Chart] Could not restore saved view:', e);
        }
    }
    
    /**
     * Setup resize handling with ResizeObserver and debounce
     */
    setupResizeHandling() {
        let resizeTimeout = null;
        
        const handleResize = () => {
            if (resizeTimeout) {
                clearTimeout(resizeTimeout);
            }
            resizeTimeout = setTimeout(() => {
                if (this.chart && this.container) {
                    const width = this.container.clientWidth;
                    const height = this.container.clientHeight;
                    
                    if (width > 0 && height > 0) {
                        this.chart.applyOptions({ width, height });
                    }
                }
                
                // Resize BB Pulse indicator pane
                if (this.bbPulse.chart && this.bbPulse.container) {
                    const width = this.bbPulse.container.clientWidth;
                    const height = this.bbPulse.container.clientHeight;
                    if (width > 0 && height > 0) {
                        this.bbPulse.chart.applyOptions({ width, height });
                    }
                }
            }, 50);
        };
        
        // Use ResizeObserver for container size changes
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver((entries) => {
                handleResize();
            });
            this.resizeObserver.observe(this.container);
            
            // Also observe BB Pulse container
            const bbPulseContainer = document.getElementById('bbPulseContainer');
            if (bbPulseContainer) {
                this.resizeObserver.observe(bbPulseContainer);
            }
        }
        
        // Also listen to window resize as fallback
        this.windowResizeHandler = handleResize;
        window.addEventListener('resize', this.windowResizeHandler);
    }

    // Update candlestick data (from API)
    setData(klines, preserveView = true) {
        if (!klines || !klines.length) return;

        // Save current view position
        let savedRange = null;
        if (preserveView && this.chart) {
            try {
                savedRange = this.chart.timeScale().getVisibleLogicalRange();
            } catch (e) {
                // No range yet
            }
        }

        // If OHLC stream is active, MERGE API data with local candles
        // (API provides history, OHLC provides real-time)
        if (this.useOHLCStream && this.localCandles.size > 0) {
            console.log('[Chart] Merging API data with OHLC stream (keeping local)');
            // Merge API klines into local candles (API won't overwrite newer OHLC data)
            klines.forEach(k => {
                const time = k.time;
                // Only add if we don't have this candle locally, or if it's older than our current bar
                if (!this.localCandles.has(time) && this.lastCandle && time < this.lastCandle.time) {
                    this.localCandles.set(time, {
                        time: time,
                        open: parseFloat(k.open),
                        high: parseFloat(k.high),
                        low: parseFloat(k.low),
                        close: parseFloat(k.close),
                        volume: k.volume || 0
                    });
                }
            });
            // Repaint from merged local data
            this.repaintFromLocal();
        } else {
            // Not using OHLC stream yet - initialize from API
            this.initLocalCandles(klines);

            const candleData = klines.map(k => ({
                time: k.time,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close)
            }));

            const volumeData = klines.map(k => ({
                time: k.time,
                value: k.volume,
                color: k.close >= k.open ? this.colors.volumeUp : this.colors.volumeDown
            }));

            this.candleSeries.setData(candleData);
            
            if (this.showVolume) {
                this.volumeSeries.setData(volumeData);
            }
        }

        // Restore view position or fit content on first load
        if (savedRange && preserveView) {
            this.chart.timeScale().setVisibleLogicalRange(savedRange);
        } else if (!savedRange) {
            this.chart.timeScale().fitContent();
        }

        // Re-apply signal markers after data refresh (setData/repaint can drop markers on some browsers)
        try {
            this.updateAllSignalMarkers();
        } catch (e) {
            // Non-fatal: markers will be re-applied on next throttled repaint
        }
    }

    // Update with new candle (real-time)
    updateCandle(candle) {
        this.candleSeries.update({
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close
        });

        if (this.showVolume) {
            this.volumeSeries.update({
                time: candle.time,
                value: candle.volume,
                color: candle.close >= candle.open ? this.colors.volumeUp : this.colors.volumeDown
            });
        }

        this.currentPrice = candle.close;
    }

    // Update the last bar with live price (called frequently)
    // Also creates new bars when crossing time boundaries
    updateLastBar(price) {
        if (!price || !this.candleSeries || isNaN(price)) return;
        
        price = parseFloat(price);
        if (price <= 0) return;
        
        const now = Math.floor(Date.now() / 1000);
        const currentBarTime = this.getBarTime(now, this.currentInterval);
        
        // Initialize lastCandle if needed
        if (!this.lastCandle) {
            this.lastCandle = {
                time: currentBarTime,
                open: price,
                high: price,
                low: price,
                close: price
            };
            this.candleSeries.update(this.lastCandle);
            this.currentPrice = price;
            this.updatePriceLine(price);
            return;
        }
        
        // Check if we need a new bar
        if (currentBarTime > this.lastCandle.time) {
            // Time boundary crossed - create a new bar
            // First, finalize the previous bar
            this.candleSeries.update(this.lastCandle);
            this.previousCandle = { ...this.lastCandle }; // Store it to fill gaps later
            
            // Create new bar
            this.lastCandle = {
                time: currentBarTime,
                open: price,
                high: price,
                low: price,
                close: price
            };
            
            this.candleSeries.update(this.lastCandle);
            
            // Also update volume for new bar
            if (this.showVolume && this.volumeSeries) {
                this.volumeSeries.update({
                    time: currentBarTime,
                    value: 0,
                    color: this.colors.volumeUp
                });
            }
            
            console.log('[Chart] New bar at', new Date(currentBarTime * 1000).toLocaleTimeString());
            
            // Emit event so app can refresh historical data
            window.dispatchEvent(new CustomEvent('newBarOpened', {
                detail: {
                    time: currentBarTime,
                    interval: this.currentInterval,
                    closedTime: this.previousCandle?.time || null,
                    closedClose: this.previousCandle?.close || null
                }
            }));
        } else {
            // Same bar period - update existing bar's OHLC
            this.lastCandle = {
                time: this.lastCandle.time,
                open: this.lastCandle.open,
                high: Math.max(this.lastCandle.high, price),
                low: Math.min(this.lastCandle.low, price),
                close: price
            };
            
            // Force the chart to update by passing the complete candle
            this.candleSeries.update(this.lastCandle);
        }
        
        this.currentPrice = price;
        this.updatePriceLine(price);
    }
    
    // Update the live price line (separated for performance)
    updatePriceLine(price) {
        const isUp = this.lastCandle ? price >= this.lastCandle.open : true;
        
        // Only recreate if needed (price changed significantly or doesn't exist)
        if (!this.priceLine) {
            this.priceLine = this.candleSeries.createPriceLine({
                price: price,
                color: isUp ? this.colors.upColor : this.colors.downColor,
                lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: ''
            });
        } else {
            // Update existing price line
            this.priceLine.applyOptions({
                price: price,
                color: isUp ? this.colors.upColor : this.colors.downColor
            });
        }
    }
    
    /**
     * Update header metrics (LD Delta and Alpha Score)
     * Called from updateAlphaScore to show key metrics in the header
     */
    updateHeaderMetrics(ldDelta, alpha, regimeClass, isWarmingUp) {
        // console.log('[Alpha Debug] updateHeaderMetrics called:', 'ld=' + ldDelta?.toFixed?.(2), 'alpha=' + alpha, 'class=' + regimeClass, 'from:', new Error().stack.split('\n')[2]?.trim());
        const headerLd = document.getElementById('headerLdDelta');
        const headerAlpha = document.getElementById('headerAlpha');
        
        // Update LD Delta (with K formatting for large values)
        if (headerLd) {
            const absLd = Math.abs(ldDelta);
            let ldFormatted;
            if (absLd >= 1000) {
                ldFormatted = (ldDelta / 1000).toFixed(1) + 'K';
                if (ldDelta > 0) ldFormatted = '+' + ldFormatted;
            } else {
                ldFormatted = ldDelta >= 0 ? `+${ldDelta.toFixed(0)}` : ldDelta.toFixed(0);
            }
            headerLd.textContent = ldFormatted;
            headerLd.classList.remove('bullish', 'bearish', 'neutral');
            if (ldDelta > 20) {
                headerLd.classList.add('bullish');
            } else if (ldDelta < -20) {
                headerLd.classList.add('bearish');
            } else {
                headerLd.classList.add('neutral');
            }
        }
        
        // Update Alpha Score
        if (headerAlpha) {
            if (isWarmingUp) {
                headerAlpha.textContent = '⏳';
                headerAlpha.classList.remove('bullish', 'bearish', 'neutral');
                headerAlpha.classList.add('neutral');
                headerAlpha.title = 'Alpha Score warming up...';
            } else {
            headerAlpha.textContent = alpha;
            headerAlpha.classList.remove('bullish', 'bearish', 'neutral');
            headerAlpha.classList.add(regimeClass);
                headerAlpha.title = 'Alpha Score: ' + alpha;
            }
        }
    }

    /**
     * Update chart from OHLC WebSocket stream (Kraken)
     * This is the PRIMARY method for accurate candle updates
     * Accumulates history locally and repaints the full chart
     * @param {Object} ohlc - OHLC data from Kraken WebSocket
     */
    updateFromOHLC(ohlc) {
        if (!ohlc || !this.candleSeries) return;
        
        const { time, open, high, low, close, volume } = ohlc;
        
        // Validate data
        if (!time || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
            console.warn('[Chart] Invalid OHLC data received:', ohlc);
            return;
        }
        
        this.useOHLCStream = true; // Mark that we're using OHLC stream
        
        // Floor the timestamp to the candle boundary
        const candleTime = this.getBarTime(time, this.currentInterval);
        
        // Create candle object
        const candle = {
            time: candleTime,
            open: open,
            high: high,
            low: low,
            close: close,
            volume: volume || 0
        };
        
        // Check if this is a new bar
        const isNewBar = !this.lastCandle || candleTime > this.lastCandle.time;
        
        if (isNewBar && this.lastCandle) {
            console.log('[Chart] OHLC new bar at', new Date(candleTime * 1000).toLocaleTimeString());
            
            // Emit new bar event (for UI countdown reset, etc.)
            window.dispatchEvent(new CustomEvent('newBarOpened', {
                detail: {
                    time: candleTime,
                    interval: this.currentInterval,
                    source: 'ohlc_stream',
                    closedTime: this.lastCandle?.time || null,
                    closedClose: this.lastCandle?.close || null
                }
            }));
            
            // Force immediate signal update on new bar (bypass throttle)
            this._lastSignalUpdate = 0;
        }
        
        // Store/update in local history
        this.localCandles.set(candleTime, candle);
        
        // Track this candle
        this.lastCandle = { ...candle };
        this.currentPrice = close;
        
        // Repaint the entire chart from local history
        this.repaintFromLocal();
        
        // Update price line
        this.updatePriceLine(close);
    }
    
    /**
     * Repaint chart from local candle history
     * Called on every OHLC update for accuracy
     */
    repaintFromLocal() {
        if (this.localCandles.size === 0) return;
        
        // Save current view position
        let savedRange = null;
        try {
            savedRange = this.chart.timeScale().getVisibleLogicalRange();
        } catch (e) {
            // No range yet
        }
        
        // Convert map to sorted arrays
        const sortedTimes = Array.from(this.localCandles.keys()).sort((a, b) => a - b);
        
        const candleData = sortedTimes.map(t => {
            const c = this.localCandles.get(t);
            return {
                time: c.time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close
            };
        });
        
        const volumeData = sortedTimes.map(t => {
            const c = this.localCandles.get(t);
            return {
                time: c.time,
                value: c.volume || 0,
                color: c.close >= c.open ? this.colors.volumeUp : this.colors.volumeDown
            };
        });
        
        // Repaint
        this.candleSeries.setData(candleData);
        
        if (this.showVolume) {
            this.volumeSeries.setData(volumeData);
        }
        
        // Restore view position
        if (savedRange) {
            this.chart.timeScale().setVisibleLogicalRange(savedRange);
        }
        
        // Update signal markers (throttled to prevent flicker)
        // Signals need to be recalculated when new candle data arrives
        const now = Date.now();
        if (!this._lastSignalUpdate) this._lastSignalUpdate = 0;
        
        const signalThrottle = 2000; // 2 seconds (keeps alerts responsive)
        if ((now - this._lastSignalUpdate) >= signalThrottle) {
            this._lastSignalUpdate = now;
            
            // Update EMA/ZEMA grids if enabled (they depend on candle data)
            if (this.emaGrid && this.emaGrid.show) {
                this.drawEmaGrid();
            }
            if (this.zemaGrid && this.zemaGrid.show) {
                this.drawZemaGrid();
            }
            
            // Update BB Pulse signals if enabled (needs recalculation on live candles)
            if (this.bbPulse && this.bbPulse.enabled) {
                this.updateBBPulse(false);
            }
            
            // Update all signal markers (BB Pulse, EMA signals, ZEMA signals)
            this.updateAllSignalMarkers();
        }
    }
    
    /**
     * Initialize local candle history from API data
     * Called when loading historical klines
     */
    initLocalCandles(klines) {
        if (!klines || !klines.length) return;
        
        // Clear existing local history
        this.localCandles.clear();
        
        // Populate from API klines
        klines.forEach(k => {
            const candle = {
                time: k.time,
                open: parseFloat(k.open),
                high: parseFloat(k.high),
                low: parseFloat(k.low),
                close: parseFloat(k.close),
                volume: k.volume || 0
            };
            this.localCandles.set(k.time, candle);
        });
        
        // Set lastCandle to the most recent
        if (klines.length > 0) {
            const last = klines[klines.length - 1];
            this.lastCandle = {
                time: last.time,
                open: parseFloat(last.open),
                high: parseFloat(last.high),
                low: parseFloat(last.low),
                close: parseFloat(last.close),
                volume: last.volume || 0
            };
            this.currentPrice = this.lastCandle.close;
        }
        
        console.log(`[Chart] Initialized ${this.localCandles.size} candles from API`);
        
        // Restore saved zoom/pan position on first load
        if (!this._viewRestored) {
            this._viewRestored = true;
            this.restoreSavedView();
        }
    }

    // Draw support/resistance levels from order book
    setLevels(levels, preserveView = true) {
        // Save current view position
        let savedRange = null;
        if (preserveView && this.chart) {
            try {
                savedRange = this.chart.timeScale().getVisibleLogicalRange();
            } catch (e) {
                // No range yet
            }
        }

        // Track level changes for historical footprints
        // Throttle heavily when using WebSocket (max once per 10 seconds)
        if (this.historicalLevels.enabled && levels && levels.length > 0) {
            const now = Date.now();
            if (!this._lastHistoricalTrack) this._lastHistoricalTrack = 0;
            const historicalThrottle = 10000; // 10 seconds between history saves
            
            if ((now - this._lastHistoricalTrack) >= historicalThrottle) {
                this._lastHistoricalTrack = now;
                this.trackLevelChanges(levels);
            }
        }

        // Create a signature of current levels for change detection
        // Only redraw if levels have changed significantly
        const createLevelSignature = (lvls) => {
            if (!lvls || lvls.length === 0) return '';
            // Create signature from top 20 levels by volume (most visible)
            const sorted = [...lvls].sort((a, b) => b.volume - a.volume).slice(0, 20);
            return sorted.map(l => `${Math.round(l.price)}:${Math.round(l.volume)}`).join('|');
        };
        
        const newSignature = createLevelSignature(levels);
        const hasSignificantChange = newSignature !== this._lastLevelSignature;
        
        // Skip redraw if no significant change
        if (!hasSignificantChange && this.priceLines.length > 0) {
            // Keep latest levels for interactions (highlighting), but do NOT
            // recalculate fair value (VWMP/IFV) from chart-rendered levels.
            // Fair value is computed from the full order book via analytics.
            if (levels && levels.length > 0) {
                this.levelLines = levels;
            }
            return;
        }
        
        // Store signature for next comparison
        this._lastLevelSignature = newSignature;

        // Remove existing price lines
        this.clearLevels();

        if (!this.showLevels || !levels || !levels.length) {
            // Restore view if needed
            if (savedRange && preserveView) {
                this.chart.timeScale().setVisibleLogicalRange(savedRange);
            }
            return;
        }

        // Use LOG scale for volume to handle wide ranges better
        const volumes = levels.map(l => l.volume);
        const maxVol = Math.max(...volumes);
        const minVol = Math.min(...volumes);
        
        // Log scale makes differences more visible across wide ranges
        const logMin = Math.log(minVol + 1);
        const logMax = Math.log(maxVol + 1);
        const logRange = logMax - logMin || 1;

        // Get appearance settings
        // Both brightness and thickness use gamma curves based on quantity
        const brightnessPercent = this.levelSettings.brightness / 100;
        const thicknessPercent = this.levelSettings.thickness / 5; // thickness is 0.5-5, normalize to 0.1-1
        
        // Gamma curves: high value = amplify weak signals, low value = only strong
        // Map to gamma 2.5 (suppress weak) to 0.3 (amplify weak)
        const brightnessGamma = 2.5 - (brightnessPercent * 2.2);
        const thicknessGamma = 2.5 - (thicknessPercent * 2.2);

        levels.forEach((level, index) => {
            const isSupport = level.type === 'support';
            
            // Calculate raw strength using LOG scale (0-1)
            const logVol = Math.log(level.volume + 1);
            const rawStrength = (logVol - logMin) / logRange;
            
            // Apply separate gamma curves for opacity and thickness
            const opacityStrength = Math.pow(rawStrength, brightnessGamma);
            const thicknessStrength = Math.pow(rawStrength, thicknessGamma);
            
            // Line width: naturally based on quantity (1-10px range)
            // Weak levels = thin (1px), Strong levels = thick (10px)
            const lineWidth = Math.max(1, Math.round(1 + thicknessStrength * 9));
            
            // Opacity: based on brightness-adjusted strength
            const minOpacity = 0.2;
            const maxOpacity = 1.0;
            const opacity = minOpacity + (opacityStrength * (maxOpacity - minOpacity));
            
            const baseColor = isSupport ? this.colors.supportLine : this.colors.resistanceLine;
            const color = this.adjustOpacity(baseColor, opacity);

            // Line style: all solid for better visibility
            let lineStyle = 0;

            const priceLine = this.candleSeries.createPriceLine({
                price: level.price,
                color: color,
                lineWidth: lineWidth,
                lineStyle: lineStyle,
                axisLabelVisible: true,
                title: `${isSupport ? '▲' : '▼'} ${this.formatVolume(level.volume)} ${this.symbol || 'BTC'}`
            });

            this.priceLines.push({
                line: priceLine,
                level: level
            });
        });

        // Store levels for highlighting
        this.levelLines = levels;

        // Restore view position
        if (savedRange && preserveView) {
            this.chart.timeScale().setVisibleLogicalRange(savedRange);
        }
    }

    // Clear all level lines
    clearLevels() {
        this.priceLines.forEach(({ line }) => {
            this.candleSeries.removePriceLine(line);
        });
        this.priceLines = [];
        this.levelLines = [];
    }

    // Highlight level nearest to crosshair
    highlightNearestLevel(candleData) {
        if (!candleData || !this.levelLines.length) return;
        
        const price = candleData.close;
        let nearest = null;
        let minDist = Infinity;

        this.levelLines.forEach(level => {
            const dist = Math.abs(level.price - price);
            if (dist < minDist) {
                minDist = dist;
                nearest = level;
            }
        });

        // Dispatch event for UI update
        if (nearest && minDist < price * 0.005) { // Within 0.5%
            window.dispatchEvent(new CustomEvent('levelHighlight', {
                detail: { level: nearest }
            }));
        }
    }

    // Toggle level visibility
    toggleLevels(show) {
        this.showLevels = show;
        if (!show) {
            this.clearLevels();
        }
    }

    // ========================================
    // Historical Level Footprints
    // ========================================
    
    /**
     * Track level changes and save disappeared/moved levels to history
     * Called each time levels are updated
     */
    trackLevelChanges(newLevels) {
        if (!this.historicalLevels.enabled) return;
        
        // Get current candle timestamp
        const candleTime = this.getCurrentCandleTime();
        if (!candleTime) {
            console.log('[Historical] No candle time available');
            return;
        }
        
        // Filter to only track levels within visible range (near current price)
        const currentPrice = this.currentPrice || 0;
        const trackingRange = 0.10; // 10% from current price
        const filteredNewLevels = currentPrice > 0 
            ? newLevels.filter(l => {
                const priceDiff = Math.abs(parseFloat(l.price) - currentPrice) / currentPrice;
                return priceDiff < trackingRange;
            })
            : newLevels;
        
        // Only track if we have previous levels to compare
        const prevLevels = this.historicalLevels.previousLevels;
        if (prevLevels.length === 0) {
            // First load - just store as previous
            this.historicalLevels.previousLevels = filteredNewLevels.map(l => ({
                price: parseFloat(l.price),
                volume: parseFloat(l.volume),
                type: l.type
            }));
            console.log(`[Historical] Initial levels captured: ${filteredNewLevels.length} (within ${trackingRange*100}% of $${currentPrice.toFixed(0)})`);
            return;
        }
        
        // Find levels that:
        // 1. Disappeared completely
        // 2. Had ANY volume change (>10% change)
        const changedLevels = [];
        const moveThreshold = this.historicalLevels.moveThreshold; // 0.5%
        const volumeChangeThreshold = 0.10; // 10% volume change (more sensitive)
        
        prevLevels.forEach(prevLevel => {
            // Find matching level in new data
            const matchingNew = filteredNewLevels.find(newLevel => {
                const priceDiff = Math.abs(parseFloat(newLevel.price) - prevLevel.price) / prevLevel.price;
                return priceDiff < moveThreshold && newLevel.type === prevLevel.type;
            });
            
            if (!matchingNew) {
                // Level completely disappeared
                changedLevels.push({
                    price: prevLevel.price,
                    volume: prevLevel.volume,
                    type: prevLevel.type,
                    reason: 'disappeared'
                });
            } else {
                // Check for any significant volume change (increase or decrease)
                const volumeChange = Math.abs(prevLevel.volume - parseFloat(matchingNew.volume)) / prevLevel.volume;
                if (volumeChange > volumeChangeThreshold) {
                    // Volume changed significantly - record the OLD level
                    changedLevels.push({
                        price: prevLevel.price,
                        volume: prevLevel.volume,
                        type: prevLevel.type,
                        reason: volumeChange > 0 ? 'volume_changed' : 'volume_changed'
                    });
                }
            }
        });
        
        // Log tracking status periodically (every 10th update)
        if (Math.random() < 0.1) {
            console.log(`[Historical] Tracking: ${filteredNewLevels.length} levels near $${currentPrice.toFixed(0)}, ${changedLevels.length} changes detected`);
        }
        
        // Save changed levels to IndexedDB and cache
        if (changedLevels.length > 0) {
            const reasons = changedLevels.reduce((acc, l) => { acc[l.reason] = (acc[l.reason] || 0) + 1; return acc; }, {});
            console.log(`[Historical] ${changedLevels.length} levels changed at candle ${candleTime} (${Object.entries(reasons).map(([k,v]) => `${k}:${v}`).join(', ')})`);
            console.log(`[Historical] Prices: ${changedLevels.slice(0,5).map(l => '$' + l.price.toFixed(0)).join(', ')}...`);
            this.saveHistoricalLevels(changedLevels, candleTime);
        }
        
        // Update previous levels for next comparison
        this.historicalLevels.previousLevels = filteredNewLevels.map(l => ({
            price: parseFloat(l.price),
            volume: parseFloat(l.volume),
            type: l.type
        }));
        
        // Re-render historical levels
        this.renderHistoricalLevels();
    }
    
    /**
     * Get current candle timestamp (aligned to interval)
     */
    getCurrentCandleTime() {
        if (this.lastCandle && this.lastCandle.time) {
            return this.lastCandle.time;
        }
        // Fallback: align to current interval
        const now = Math.floor(Date.now() / 1000);
        const intervalSeconds = this.getIntervalSeconds();
        return Math.floor(now / intervalSeconds) * intervalSeconds;
    }
    
    /**
     * Get interval in seconds
     */
    getIntervalSeconds() {
        const interval = this.currentInterval || '1m';
        const match = interval.match(/(\d+)([mhdwM])/);
        if (!match) return 60;
        
        const value = parseInt(match[1]);
        const unit = match[2];
        
        switch (unit) {
            case 'm': return value * 60;
            case 'h': return value * 60 * 60;
            case 'd': return value * 24 * 60 * 60;
            case 'w': return value * 7 * 24 * 60 * 60;
            case 'M': return value * 30 * 24 * 60 * 60;
            default: return 60;
        }
    }
    
    /**
     * Save historical levels to IndexedDB and local cache
     * Includes sanity check to prevent storing levels with obviously wrong prices
     */
    async saveHistoricalLevels(levels, candleTime) {
        console.log(`[Historical] Saving ${levels.length} levels for candle ${candleTime}`);
        
        // Sanity check: filter out levels with prices too far from current price
        // This prevents storing levels that won't be visible on chart
        const currentPrice = this.currentPrice || 0;
        const validLevels = currentPrice > 0 
            ? levels.filter(level => {
                const priceDiff = Math.abs(level.price - currentPrice) / currentPrice;
                // Only keep levels within 10% of current price (visible range)
                return priceDiff < 0.10;
            })
            : levels;
        
        if (validLevels.length < levels.length) {
            console.log(`[Historical] Filtered ${levels.length - validLevels.length} invalid levels (too far from current price)`);
        }
        
        if (validLevels.length === 0) {
            return;
        }
        
        // Add to local cache
        if (!this.historicalLevels.cachedData.has(candleTime)) {
            this.historicalLevels.cachedData.set(candleTime, []);
        }
        const existing = this.historicalLevels.cachedData.get(candleTime);
        let addedCount = 0;
        
        validLevels.forEach(level => {
            // Avoid duplicates
            const isDupe = existing.some(e => 
                Math.abs(e.price - level.price) < level.price * 0.001 && e.type === level.type
            );
            if (!isDupe) {
                existing.push({
                    price: level.price,
                    volume: level.volume,
                    type: level.type
                });
                addedCount++;
            }
        });
        
        console.log(`[Historical] Added ${addedCount} new levels to cache (total in candle: ${existing.length})`);
        
        // Save to IndexedDB (async, non-blocking) - include interval for proper timeframe separation
        if (typeof db !== 'undefined' && db.saveHistoricalLevels) {
            db.saveHistoricalLevels(validLevels, candleTime, this.currentInterval).catch(err => {
                console.warn('[Historical] Failed to save to DB:', err);
            });
        }
    }
    
    /**
     * Load historical levels from IndexedDB
     * Called on chart initialization
     * Filters out stale data that's too old or too far from current price
     */
    async loadHistoricalLevels() {
        if (!this.historicalLevels.enabled) {
            console.log('[Historical] Feature disabled, skipping load');
            return;
        }
        
        try {
            if (typeof db !== 'undefined' && db.getHistoricalLevels) {
                console.log(`[Historical] Loading levels from IndexedDB for ${this.currentInterval}...`);
                const levels = await db.getHistoricalLevels(this.currentInterval);
                
                if (!levels || levels.length === 0) {
                    console.log(`[Historical] No historical levels for ${this.currentInterval}`);
                    return;
                }
                
                // Filter: only load levels from the last 24 hours
                const cutoffTime = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
                const recentLevels = levels.filter(l => l.candleTime > cutoffTime);
                
                if (recentLevels.length < levels.length) {
                    console.log(`[Historical] Filtered out ${levels.length - recentLevels.length} stale levels (>24h old)`);
                }
                
                if (recentLevels.length === 0) {
                    console.log('[Historical] No recent historical levels');
                    return;
                }
                
                // Populate local cache grouped by candle time
                const uniqueCandles = new Set();
                recentLevels.forEach(level => {
                    const candleTime = level.candleTime;
                    uniqueCandles.add(candleTime);
                    
                    if (!this.historicalLevels.cachedData.has(candleTime)) {
                        this.historicalLevels.cachedData.set(candleTime, []);
                    }
                    this.historicalLevels.cachedData.get(candleTime).push({
                        price: level.price,
                        volume: level.volume,
                        type: level.type
                    });
                });
                
                console.log(`[Historical] Loaded ${recentLevels.length} levels across ${uniqueCandles.size} candles from database`);
                
                // Render loaded levels
                this.renderHistoricalLevels();
            } else {
                console.log('[Historical] Database not available');
            }
        } catch (err) {
            console.warn('[Historical] Failed to load:', err);
        }
    }
    
    /**
     * Render historical levels as distinct marks on specific candle bars
     * Each level appears as a short horizontal line ONLY at its recorded candle
     */
    renderHistoricalLevels() {
        if (!this.historicalLevels.enabled || !this.chart) return;
        
        // Clear existing historical series
        this.clearHistoricalLevelMarkers();
        
        // Use chart's currentPrice or fallback to last candle close
        let currentPrice = this.currentPrice || 0;
        if (currentPrice === 0 && this.lastCandle) {
            currentPrice = this.lastCandle.close || 0;
        }
        
        const cachedData = this.historicalLevels.cachedData;
        
        if (cachedData.size === 0) {
            return;
        }
        
        // Apply existing filter settings
        const settings = window.orderBookApp?.settings || {};
        const minVolume = parseFloat(settings.minVolume || 0);
        const priceRange = parseFloat(settings.priceRange || 100) / 100;
        
        // If we still don't have a price, don't filter by price (show all)
        const priceMin = currentPrice > 0 ? currentPrice * (1 - priceRange) : 0;
        const priceMax = currentPrice > 0 ? currentPrice * (1 + priceRange) : Infinity;
        
        // Get interval in seconds - determines visual width of each mark
        const intervalSeconds = this.getIntervalSeconds();
        
        // Collect all levels grouped by candle time
        const levelsByCandle = new Map(); // candleTime -> [levels]
        let totalLevels = 0;
        
        cachedData.forEach((levels, candleTime) => {
            const filteredLevels = levels.filter(level => {
                if (level.volume < minVolume) return false;
                if (currentPrice > 0 && (level.price < priceMin || level.price > priceMax)) return false;
                return true;
            });
            
            if (filteredLevels.length > 0) {
                levelsByCandle.set(candleTime, filteredLevels);
                totalLevels += filteredLevels.length;
            }
        });
        
        if (totalLevels === 0) {
            return;
        }
        
        // Limit to most recent candles to avoid performance issues
        const maxCandles = 10;
        const maxLevelsPerCandle = 50;
        const sortedCandles = Array.from(levelsByCandle.keys()).sort((a, b) => b - a);
        const limitedCandles = sortedCandles.slice(0, maxCandles);
        
        console.log(`[Historical] Rendering levels from ${limitedCandles.length} of ${levelsByCandle.size} candles (limited)`);
        
        // Create ONE series per candle per type - this prevents cross-candle connections
        limitedCandles.forEach(candleTime => {
            let levels = levelsByCandle.get(candleTime);
            // Limit levels per candle by volume (keep highest volume)
            if (levels.length > maxLevelsPerCandle) {
                levels = levels.sort((a, b) => b.volume - a.volume).slice(0, maxLevelsPerCandle);
            }
            const supportLevels = levels.filter(l => l.type === 'support');
            const resistLevels = levels.filter(l => l.type === 'resistance');
            
            // Get brightness setting (0-1)
            const brightness = this.historicalLevels.brightness || 0.5;
            const supportOpacity = Math.min(0.9, brightness * 0.9);
            const resistOpacity = Math.min(0.9, brightness * 0.9);
            
            // Support levels for this candle (gray-cyan, brightness controlled)
            if (supportLevels.length > 0) {
                this.createHistoricalLevelSeries(
                    supportLevels, 
                    candleTime, 
                    intervalSeconds,
                    `rgba(120, 180, 180, ${supportOpacity})`
                );
            }
            
            // Resistance levels for this candle (gray-pink, brightness controlled)
            if (resistLevels.length > 0) {
                this.createHistoricalLevelSeries(
                    resistLevels, 
                    candleTime, 
                    intervalSeconds,
                    `rgba(180, 120, 140, ${resistOpacity})`
                );
            }
        });
        
        console.log(`[Historical] Created ${this.historicalLevels.levelMarkers.length} series for ${levelsByCandle.size} candles`);
    }
    
    /**
     * Create line series for historical levels at a specific candle
     * Creates ONE series per level to avoid timestamp conflicts
     */
    createHistoricalLevelSeries(levels, candleTime, intervalSeconds, color) {
        // Create a separate series for EACH level to avoid duplicate timestamp issues
        levels.forEach((level, idx) => {
            try {
                const series = this.chart.addLineSeries({
                    color: color,
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                
                // Each level gets its own horizontal line segment
                const endTime = candleTime + intervalSeconds - 1;
                series.setData([
                    { time: candleTime, value: level.price },
                    { time: endTime, value: level.price }
                ]);
                
                this.historicalLevels.levelMarkers.push(series);
            } catch (e) {
                // Silently skip if series creation fails
            }
        });
    }
    
    /**
     * Clear historical level series from chart
     */
    clearHistoricalLevelMarkers() {
        if (this.chart && this.historicalLevels.levelMarkers) {
            this.historicalLevels.levelMarkers.forEach(series => {
                try {
                    this.chart.removeSeries(series);
                } catch (e) {
                    // Series may already be removed
                }
            });
        }
        this.historicalLevels.levelMarkers = [];
    }
    
    /**
     * Toggle historical levels feature
     */
    setHistoricalLevelsEnabled(enabled) {
        this.historicalLevels.enabled = enabled;
        localStorage.setItem('showHistoricalLevels', enabled);
        
        if (enabled) {
            this.loadHistoricalLevels();
        } else {
            this.clearHistoricalLevelMarkers();
        }
    }
    
    /**
     * Set brightness for historical levels (0-100)
     * Also affects historical fair value lines
     */
    setHistoricalLevelsBrightness(brightness) {
        // Convert from 0-100 to 0-1
        this.historicalLevels.brightness = Math.max(0, Math.min(100, brightness)) / 100;
        localStorage.setItem('historicalLevelsBrightness', brightness);
        
        // Re-render with new brightness
        if (this.historicalLevels.enabled) {
            this.renderHistoricalLevels();
        }
        
        // Also re-render fair value history
        if (this.historicalFairValue.enabled) {
            this.renderHistoricalFairValue();
        }
    }
    
    /**
     * Clear all historical level data (levels + fair values)
     */
    async clearHistoricalLevelData() {
        // Clear historical order book levels
        this.historicalLevels.cachedData.clear();
        this.historicalLevels.previousLevels = [];
        this.clearHistoricalLevelMarkers();
        
        if (typeof db !== 'undefined' && db.clearHistoricalLevels) {
            await db.clearHistoricalLevels();
        }
        
        // Also clear historical fair values (VWMP, IFV, targets)
        this.historicalFairValue.cachedData.clear();
        this.historicalFairValue.lastSavedCandleTime = null;
        this.historicalFairValue.lastSaveTs = 0;
        this.clearHistoricalFairValueSeries();
        
        // Clear from localStorage
        const storageKey = `histFV_${this.symbol}_${this.currentInterval}`;
        localStorage.removeItem(storageKey);
        
        console.log('[Historical] Cleared all historical data (levels + fair values)');
    }

    // Toggle volume visibility
    toggleVolume(show) {
        this.showVolume = show;
        if (show) {
            // Re-enable volume - need to re-set data
        } else {
            this.volumeSeries.setData([]);
        }
    }

    // Format volume for display
    formatVolume(vol) {
        if (vol >= 1000) {
            return (vol / 1000).toFixed(1) + 'K';
        }
        return vol.toFixed(2);
    }

    // Get visible price range
    getVisibleRange() {
        const range = this.chart.timeScale().getVisibleLogicalRange();
        return range;
    }

    // Scroll to current time
    scrollToNow() {
        this.chart.timeScale().scrollToRealTime();
    }

    // Fit content
    fitContent() {
        this.chart.timeScale().fitContent();
    }

    // Destroy chart
    destroy() {
        // Clean up resize handling
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.windowResizeHandler) {
            window.removeEventListener('resize', this.windowResizeHandler);
        }
        
        // Remove chart
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
    }
    
    // ==========================================
    // PROJECTION METHODS
    // ==========================================
    
    /**
     * Initialize projection state
     */
    initProjections() {
        if (!this.projections) {
            this.projections = {
                showTargets: false,
                showRays: false,
                showConfidence: false,
                targetLines: [],      // Horizontal target price lines
                raySeries: null,      // Line series for angled rays
                data: null            // Current projection data
            };
        }
    }
    
    /**
     * Toggle confidence display mode
     */
    toggleConfidence(show) {
        this.initProjections();
        this.projections.showConfidence = show;
        
        // Redraw targets and rays if they're visible
        if (this.projections.showTargets) {
            this.drawTargetLines();
        }
        if (this.projections.showRays) {
            this.drawRays();
        }
    }
    
    /**
     * Set projection data and redraw if enabled
     */
    setProjectionData(data) {
        this.initProjections();
        this.projections.data = data;
        
        // Redraw if projections are enabled
        if (this.projections.showTargets) {
            this.drawTargetLines();
        }
        if (this.projections.showRays) {
            this.drawRays();
        }
    }
    
    /**
     * Toggle horizontal target lines
     */
    toggleTargetLines(show) {
        this.initProjections();
        this.projections.showTargets = show;
        
        if (show && this.projections.data) {
            this.drawTargetLines();
        } else {
            this.clearTargetLines();
        }
    }
    
    /**
     * Toggle angled ray projections
     */
    toggleRays(show) {
        this.initProjections();
        this.projections.showRays = show;
        
        if (show && this.projections.data) {
            this.drawRays();
        } else {
            this.clearRays();
        }
    }
    
    /**
     * Draw horizontal target lines at projected support/resistance
     * Shows SHORT, MEDIUM, and LONG term targets
     */
    drawTargetLines() {
        this.clearTargetLines();
        
        const data = this.projections.data;
        if (!data || !this.candleSeries) return;
        
        const { short, medium, long } = data;
        
        // Colors for each timeframe - warm for resistance, cool for support
        const colors = {
            shortRes: 'rgba(255, 193, 7, 0.9)',    // Amber
            shortSup: 'rgba(0, 188, 212, 0.9)',    // Cyan
            mediumRes: 'rgba(255, 152, 0, 0.8)',   // Orange
            mediumSup: 'rgba(3, 169, 244, 0.8)',   // Light blue
            longRes: 'rgba(255, 87, 34, 0.7)',     // Deep orange
            longSup: 'rgba(33, 150, 243, 0.7)'     // Blue
        };
        
        // Helper to draw a target line
        const drawTarget = (target, color, lineWidth, prefix) => {
            if (!target || !target.price) return;
            
            const isResistance = target.type === 'resistance';
            const arrow = isResistance ? '▲' : '▼';
            const sign = isResistance ? '+' : '-';
            let title = `${prefix}${arrow} ${sign}${target.distance.toFixed(1)}%`;
            
            const line = this.candleSeries.createPriceLine({
                price: target.price,
                color: color,
                lineWidth: lineWidth,
                lineStyle: LightweightCharts.LineStyle.Solid,
                axisLabelVisible: true,
                title: title
            });
            this.projections.targetLines.push(line);
        };
        
        // Draw SHORT-TERM targets (thinnest)
        if (short) {
            drawTarget(short.resistance, colors.shortRes, 1, 'S');
            drawTarget(short.support, colors.shortSup, 1, 'S');
        }
        
        // Draw MEDIUM-TERM targets (medium)
        if (medium) {
            drawTarget(medium.resistance, colors.mediumRes, 2, 'M');
            drawTarget(medium.support, colors.mediumSup, 2, 'M');
        }
        
        // Draw LONG-TERM targets (thickest)
        if (long) {
            drawTarget(long.resistance, colors.longRes, 3, 'L');
            drawTarget(long.support, colors.longSup, 3, 'L');
        }
    }
    
    /**
     * Clear horizontal target lines
     */
    clearTargetLines() {
        this.initProjections();
        
        this.projections.targetLines.forEach(line => {
            if (this.candleSeries) {
                this.candleSeries.removePriceLine(line);
            }
        });
        this.projections.targetLines = [];
    }
    
    /**
     * Draw angled ray projections from current price to targets
     * Shows SHORT, MEDIUM, and LONG term rays for both resistance and support
     */
    drawRays() {
        this.clearRays();
        
        const data = this.projections.data;
        if (!data || !this.chart) return;
        
        const { currentPrice, bias, short, medium, long } = data;
        if (!currentPrice) return;
        
        // Get current time for the ray starting point
        const now = Math.floor(Date.now() / 1000);
        const barTime = this.getBarTime(now, this.currentInterval);
        
        // Calculate future time points (project forward)
        const intervals = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        const barSeconds = intervals[this.currentInterval] || 3600;
        
        // Different bar lengths for each timeframe
        const shortBars = 5;   // Short-term: 5 bars
        const mediumBars = 12; // Medium-term: 12 bars
        const longBars = 20;   // Long-term: 20 bars
        
        // Colors for each timeframe - resistance (up) uses warm colors, support (down) uses cool colors
        const colors = {
            shortRes: 'rgba(255, 193, 7, 0.9)',    // Amber - short resistance
            shortSup: 'rgba(0, 188, 212, 0.9)',    // Cyan - short support
            mediumRes: 'rgba(255, 152, 0, 0.8)',   // Orange - medium resistance
            mediumSup: 'rgba(3, 169, 244, 0.8)',   // Light blue - medium support
            longRes: 'rgba(255, 87, 34, 0.7)',     // Deep orange - long resistance
            longSup: 'rgba(33, 150, 243, 0.7)'     // Blue - long support
        };
        
        // Initialize ray series arrays
        this.projections.raySeries = [];
        
        // Helper to draw a ray
        const drawRay = (target, endBars, color, lineWidth, label) => {
            if (!target || !target.price) return null;
            
            const endTime = barTime + (barSeconds * endBars);
            
            const series = this.chart.addLineSeries({
                color: color,
                lineWidth: lineWidth,
                lineStyle: LightweightCharts.LineStyle.Solid,
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false,
                title: label
            });
            
            series.setData([
                { time: barTime, value: currentPrice },
                { time: endTime, value: target.price }
            ]);
            
            return series;
        };
        
        // Draw SHORT-TERM rays (thinnest, closest)
        if (short) {
            if (short.resistance) {
                const s = drawRay(short.resistance, shortBars, colors.shortRes, 1, 'S↑');
                if (s) this.projections.raySeries.push(s);
            }
            if (short.support) {
                const s = drawRay(short.support, shortBars, colors.shortSup, 1, 'S↓');
                if (s) this.projections.raySeries.push(s);
            }
        }
        
        // Draw MEDIUM-TERM rays (medium thickness)
        if (medium) {
            if (medium.resistance) {
                const s = drawRay(medium.resistance, mediumBars, colors.mediumRes, 2, 'M↑');
                if (s) this.projections.raySeries.push(s);
            }
            if (medium.support) {
                const s = drawRay(medium.support, mediumBars, colors.mediumSup, 2, 'M↓');
                if (s) this.projections.raySeries.push(s);
            }
        }
        
        // Draw LONG-TERM rays (thickest, furthest)
        if (long) {
            if (long.resistance) {
                const s = drawRay(long.resistance, longBars, colors.longRes, 3, 'L↑');
                if (s) this.projections.raySeries.push(s);
            }
            if (long.support) {
                const s = drawRay(long.support, longBars, colors.longSup, 3, 'L↓');
                if (s) this.projections.raySeries.push(s);
            }
        }
        
        // Add direction marker only when there's a clear bias (not neutral)
        if (this.lastCandle && bias !== 'neutral') {
            const markerColor = bias === 'bullish' ? '#ffd700' : '#00bfff';
            const markerShape = bias === 'bullish' ? 'arrowUp' : 'arrowDown';
            
            this.projections.markers = [{
                time: this.lastCandle.time,
                position: bias === 'bullish' ? 'belowBar' : 'aboveBar',
                color: markerColor,
                shape: markerShape,
                text: bias === 'bullish' ? 'BULL' : 'BEAR'
            }];
        } else {
            // Clear markers for neutral bias
            this.projections.markers = null;
        }
        
        // Re-apply combined markers (projections + signals + alerts)
        this.updateAllSignalMarkers();
    }
    
    /**
     * Clear angled ray projections
     */
    clearRays() {
        this.initProjections();
        
        // Clear all ray series
        if (this.projections.raySeries) {
            this.projections.raySeries.forEach(series => {
                if (series && this.chart) {
                    this.chart.removeSeries(series);
                }
            });
            this.projections.raySeries = [];
        }
        
        // Legacy cleanup
        if (this.projections.upsideRaySeries) {
            this.chart.removeSeries(this.projections.upsideRaySeries);
            this.projections.upsideRaySeries = null;
        }
        if (this.projections.downsideRaySeries) {
            this.chart.removeSeries(this.projections.downsideRaySeries);
            this.projections.downsideRaySeries = null;
        }
        if (this.projections.shortRaySeries) {
            this.chart.removeSeries(this.projections.shortRaySeries);
            this.projections.shortRaySeries = null;
        }
        if (this.projections.longRaySeries) {
            this.chart.removeSeries(this.projections.longRaySeries);
            this.projections.longRaySeries = null;
        }
        
        // Clear markers
        if (this.projections && this.projections.markers) {
            this.projections.markers = null;
            this.updateAllSignalMarkers();
        }
    }
    
    /**
     * Clear all projections
     */
    clearAllProjections() {
        this.clearTargetLines();
        this.clearRays();
    }
    
    // ========================================
    // EMA Grid Methods
    // ========================================
    
    /**
     * Initialize EMA grid state
     */
    initEmaGrid() {
        if (!this.emaGrid) {
            this.emaGrid = {
                show: false,
                spacing: 0.1,      // % spacing between grid lines
                emaValue: null,    // Current 20 EMA value
                emaSeries: null,   // The EMA line series
                gridLines: [],     // Grid price lines
                period: 20,        // EMA period
                color: 'rgba(156, 163, 175, 0.8)'  // Default gray color
            };
        }
    }
    
    /**
     * Calculate EMA from candle data
     */
    calculateEMA(candles, period = 20) {
        if (!candles || candles.length < period) return null;
        
        const multiplier = 2 / (period + 1);
        let ema = 0;
        
        // Calculate initial SMA
        for (let i = 0; i < period; i++) {
            ema += candles[i].close;
        }
        ema = ema / period;
        
        // Calculate EMA
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close - ema) * multiplier + ema;
        }
        
        return ema;
    }
    
    /**
     * Calculate full EMA series for chart display
     */
    calculateEMASeries(candles, period = 20) {
        if (!candles || candles.length < period) return [];
        
        const multiplier = 2 / (period + 1);
        const emaData = [];
        
        // Calculate initial SMA for the first EMA point
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += candles[i].close;
        }
        let ema = sum / period;
        
        // Add first EMA point
        emaData.push({
            time: candles[period - 1].time,
            value: ema
        });
        
        // Calculate rest of EMA
        for (let i = period; i < candles.length; i++) {
            ema = (candles[i].close - ema) * multiplier + ema;
            emaData.push({
                time: candles[i].time,
                value: ema
            });
        }
        
        return emaData;
    }
    
    /**
     * Calculate ZEMA (Zero-lag EMA) for current price
     * ZEMA = 2 * EMA(src, length) - EMA(EMA(src, length), length)
     */
    calculateZEMA(candles, period = 30) {
        if (!candles || candles.length < period * 2) return null;
        
        // First EMA
        const ema1 = this.calculateEMA(candles, period);
        if (!ema1) return null;
        
        // Calculate full first EMA series for second EMA calculation
        const ema1Series = this.calculateEMASeries(candles, period);
        if (ema1Series.length < period) return null;
        
        // Create candles object from EMA series for second EMA
        const emaCandles = ema1Series.map(point => ({ close: point.value }));
        
        // Second EMA (EMA of EMA)
        const ema2 = this.calculateEMA(emaCandles, period);
        if (!ema2) return null;
        
        // ZEMA = 2 * EMA1 - EMA2
        return (2 * ema1) - ema2;
    }
    
    /**
     * Calculate ZEMA series for all candles
     */
    calculateZEMASeries(candles, period = 30) {
        if (!candles || candles.length < period * 2) return [];
        
        const zemaData = [];
        
        // Calculate first EMA series
        const ema1Series = this.calculateEMASeries(candles, period);
        if (ema1Series.length < period) return [];
        
        // Create candles from EMA series
        const emaCandles = ema1Series.map(point => ({ close: point.value }));
        
        // Calculate second EMA series (EMA of EMA)
        const ema2Series = this.calculateEMASeries(emaCandles, period);
        if (ema2Series.length === 0) return [];
        
        // Calculate ZEMA = 2 * EMA1 - EMA2
        for (let i = 0; i < ema2Series.length; i++) {
            const ema1Value = ema1Series[i + period - 1].value; // Offset by period
            const ema2Value = ema2Series[i].value;
            const zema = (2 * ema1Value) - ema2Value;
            
            zemaData.push({
                time: ema1Series[i + period - 1].time,
                value: zema
            });
        }
        
        return zemaData;
    }
    
    /**
     * Toggle EMA grid display
     */
    toggleEmaGrid(show) {
        this.initEmaGrid();
        this.emaGrid.show = show;
        
        if (show) {
            this.drawEmaGrid();
        } else {
            this.clearEmaGrid();
        }
    }
    
    /**
     * Set EMA grid spacing
     */
    setEmaGridSpacing(spacing) {
        this.initEmaGrid();
        this.emaGrid.spacing = spacing;
        
        if (this.emaGrid.show) {
            this.drawEmaGrid();
        }
    }
    
    /**
     * Set EMA color
     */
    setEmaColor(color) {
        this.initEmaGrid();
        this.emaGrid.color = color;
        
        if (this.emaGrid.show) {
            this.drawEmaGrid();
        }
    }
    
    /**
     * Draw EMA line and grid
     */
    drawEmaGrid() {
        this.initEmaGrid();
        this.clearEmaGrid();
        
        if (!this.candleSeries || !this.chart) return;
        
        // Get candles from local storage or API data
        const candles = this.getCandles();
        if (!candles || candles.length < this.emaGrid.period) return;
        
        // Calculate EMA
        const currentEma = this.calculateEMA(candles, this.emaGrid.period);
        if (!currentEma) return;
        
        this.emaGrid.emaValue = currentEma;
        
        // Calculate full EMA series for the line
        const emaSeries = this.calculateEMASeries(candles, this.emaGrid.period);
        this.emaGrid.emaSeriesData = emaSeries; // Store for grid lines
        
        // Create EMA line series
        this.emaGrid.emaSeries = this.chart.addLineSeries({
            color: this.emaGrid.color,
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            crosshairMarkerVisible: false,
            lastValueVisible: true,
            priceLineVisible: false,
            title: `EMA(${this.emaGrid.period})`
        });
        
        this.emaGrid.emaSeries.setData(emaSeries);
        
        // Draw curved grid lines if spacing > 0
        if (this.emaGrid.spacing > 0) {
            this.drawEmaGridLines();
        }
    }
    
    /**
     * Draw curved grid lines that follow the EMA shape
     * Lines are at EMA * (1 + spacing), EMA * (1 + 2*spacing), etc.
     * e.g., with spacing 0.1: EMA*1.1, EMA*1.2, EMA*0.9, EMA*0.8
     */
    drawEmaGridLines() {
        if (!this.chart || !this.emaGrid.emaSeriesData || this.emaGrid.emaSeriesData.length === 0) return;
        
        const spacing = this.emaGrid.spacing; // Direct multiplier (0.1 = 10%)
        
        // Extract RGB from EMA color (works with hex or rgba)
        const baseColor = this.extractRGB(this.emaGrid.color);
        
        // Draw curved grid lines above and below EMA (up to 10 lines each direction)
        const maxLines = 10;
        
        for (let i = 1; i <= maxLines; i++) {
            // Fade opacity as lines get further from EMA
            const opacity = Math.max(0.15, 0.5 - (i * 0.04));
            const gridColor = `rgba(${baseColor.join(',')}, ${opacity})`;
            
            // Above EMA: EMA * 1.1, EMA * 1.2, etc.
            const aboveMultiplier = 1 + (spacing * i);
            const aboveData = this.emaGrid.emaSeriesData.map(point => ({
                time: point.time,
                value: point.value * aboveMultiplier
            }));
            
            const aboveSeries = this.chart.addLineSeries({
                color: gridColor,
                lineWidth: 1,
                lineStyle: LightweightCharts.LineStyle.Dotted,
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false
            });
            aboveSeries.setData(aboveData);
            this.emaGrid.gridLines.push(aboveSeries);
            
            // Below EMA: EMA * 0.9, EMA * 0.8, etc.
            const belowMultiplier = 1 - (spacing * i);
            if (belowMultiplier > 0) { // Prevent negative prices
                const belowData = this.emaGrid.emaSeriesData.map(point => ({
                    time: point.time,
                    value: point.value * belowMultiplier
                }));
                
                const belowSeries = this.chart.addLineSeries({
                    color: gridColor,
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                belowSeries.setData(belowData);
                this.emaGrid.gridLines.push(belowSeries);
            }
        }
    }
    
    /**
     * Extract RGB values from color string (hex or rgba)
     */
    extractRGB(color) {
        // If it's already rgba format
        const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbaMatch) {
            return [parseInt(rgbaMatch[1]), parseInt(rgbaMatch[2]), parseInt(rgbaMatch[3])];
        }
        
        // If it's hex format (#rrggbb)
        const hexMatch = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (hexMatch) {
            return [
                parseInt(hexMatch[1], 16),
                parseInt(hexMatch[2], 16),
                parseInt(hexMatch[3], 16)
            ];
        }
        
        // Fallback to gray
        return [156, 163, 175];
    }
    
    /**
     * Get candles array from local storage
     */
    getCandles() {
        if (this.localCandles && this.localCandles.size > 0) {
            return Array.from(this.localCandles.values()).sort((a, b) => a.time - b.time);
        }
        return null;
    }
    
    /**
     * Clear EMA grid
     */
    clearEmaGrid() {
        this.initEmaGrid();
        
        // Remove EMA line series
        if (this.emaGrid.emaSeries && this.chart) {
            this.chart.removeSeries(this.emaGrid.emaSeries);
            this.emaGrid.emaSeries = null;
        }
        
        // Remove curved grid line series
        this.emaGrid.gridLines.forEach(series => {
            if (this.chart) {
                try {
                    this.chart.removeSeries(series);
                } catch (e) {
                    // Series may already be removed
                }
            }
        });
        this.emaGrid.gridLines = [];
        this.emaGrid.emaValue = null;
        this.emaGrid.emaSeriesData = null;
    }
    
    // ========== ZEMA GRID FUNCTIONS ==========
    
    /**
     * Initialize ZEMA grid state
     */
    initZemaGrid() {
        if (!this.zemaGrid) {
            this.zemaGrid = {
                show: false,
                spacing: 0.003,   // % spacing between grid lines (0.3%)
                zemaValue: null,   // Current ZEMA value
                zemaSeries: null,  // The ZEMA line series
                gridLines: [],     // Grid price lines
                period: 30,        // ZEMA period (default 30)
                color: 'rgba(139, 92, 246, 0.8)'  // Default purple color
            };
        }
    }
    
    /**
     * Toggle ZEMA grid display
     */
    toggleZemaGrid(show) {
        this.initZemaGrid();
        this.zemaGrid.show = show;
        
        if (show) {
            this.drawZemaGrid();
        } else {
            this.clearZemaGrid();
        }
    }
    
    /**
     * Set ZEMA grid spacing
     */
    setZemaGridSpacing(spacing) {
        this.initZemaGrid();
        this.zemaGrid.spacing = spacing;
        
        if (this.zemaGrid.show) {
            this.drawZemaGrid();
        }
    }
    
    /**
     * Set ZEMA color
     */
    setZemaColor(color) {
        this.initZemaGrid();
        this.zemaGrid.color = color;
        
        if (this.zemaGrid.show) {
            this.drawZemaGrid();
        }
    }
    
    /**
     * Set ZEMA period
     */
    setZemaPeriod(period) {
        this.initZemaGrid();
        this.zemaGrid.period = period;
        
        if (this.zemaGrid.show) {
            this.drawZemaGrid();
        }
    }
    
    /**
     * Draw ZEMA line and grid
     */
    drawZemaGrid() {
        this.initZemaGrid();
        this.clearZemaGrid();
        
        if (!this.candleSeries || !this.chart) return;
        
        // Get candles from local storage or API data
        const candles = this.getCandles();
        if (!candles || candles.length < this.zemaGrid.period * 2) return;
        
        // Calculate ZEMA
        const currentZema = this.calculateZEMA(candles, this.zemaGrid.period);
        if (!currentZema) return;
        
        this.zemaGrid.zemaValue = currentZema;
        
        // Calculate full ZEMA series for the line
        const zemaSeries = this.calculateZEMASeries(candles, this.zemaGrid.period);
        this.zemaGrid.zemaSeriesData = zemaSeries; // Store for grid lines
        
        // Create ZEMA line series (different color from EMA)
        this.zemaGrid.zemaSeries = this.chart.addLineSeries({
            color: this.zemaGrid.color,
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Solid,
            crosshairMarkerVisible: false,
            lastValueVisible: true,
            priceLineVisible: false,
            title: `ZEMA(${this.zemaGrid.period})`
        });
        
        // Add ZEMA line data
        if (zemaSeries.length > 0) {
            this.zemaGrid.zemaSeries.setData(zemaSeries);
        }
        
        // Draw grid lines at intervals (similar to EMA)
        const spacing = this.zemaGrid.spacing; // e.g. 0.1 = 10%
        
        // Extract RGB from ZEMA color
        const baseColor = this.extractRGB(this.zemaGrid.color);
        
        // Draw curved grid lines above and below ZEMA (up to 10 lines each direction)
        const maxLines = 10;
        
        for (let i = 1; i <= maxLines; i++) {
            // Fade opacity as lines get further from ZEMA
            const opacity = Math.max(0.15, 0.5 - (i * 0.04));
            const gridColor = `rgba(${baseColor.join(',')}, ${opacity})`;
            
            // Above ZEMA
            const aboveMultiplier = 1 + (spacing * i);
            const aboveData = zemaSeries.map(point => ({
                time: point.time,
                value: point.value * aboveMultiplier
            }));
            
            if (aboveData.length > 0) {
                const aboveSeries = this.chart.addLineSeries({
                    color: gridColor,
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                aboveSeries.setData(aboveData);
                this.zemaGrid.gridLines.push(aboveSeries);
            }
            
            // Below ZEMA
            const belowMultiplier = 1 - (spacing * i);
            if (belowMultiplier > 0) {
                const belowData = zemaSeries.map(point => ({
                    time: point.time,
                    value: point.value * belowMultiplier
                }));
                
                if (belowData.length > 0) {
                    const belowSeries = this.chart.addLineSeries({
                        color: gridColor,
                        lineWidth: 1,
                        lineStyle: LightweightCharts.LineStyle.Dotted,
                        crosshairMarkerVisible: false,
                        lastValueVisible: false,
                        priceLineVisible: false
                    });
                    belowSeries.setData(belowData);
                    this.zemaGrid.gridLines.push(belowSeries);
                }
            }
        }
    }
    
    /**
     * Clear ZEMA grid
     */
    clearZemaGrid() {
        this.initZemaGrid();
        
        // Remove ZEMA line series
        if (this.zemaGrid.zemaSeries && this.chart) {
            this.chart.removeSeries(this.zemaGrid.zemaSeries);
            this.zemaGrid.zemaSeries = null;
        }
        
        // Remove curved grid line series
        this.zemaGrid.gridLines.forEach(series => {
            if (this.chart) {
                try {
                    this.chart.removeSeries(series);
                } catch (e) {
                    // Series may already be removed
                }
            }
        });
        this.zemaGrid.gridLines = [];
        this.zemaGrid.zemaValue = null;
        this.zemaGrid.zemaSeriesData = null;
    }
    
    /**
     * Update ZEMA grid when new data arrives
     */
    updateEmaGrid() {
        if (this.emaGrid && this.emaGrid.show) {
            this.drawEmaGrid();
        }
    }
    
    /**
     * Update ZEMA grid when new data arrives
     */
    updateZemaGrid() {
        if (this.zemaGrid && this.zemaGrid.show) {
            this.drawZemaGrid();
        }
    }
    
    // ==========================================
    // EMA/ZEMA Grid Crossing Signals
    // ==========================================
    
    /**
     * Toggle EMA grid crossing signals
     */
    toggleEmaSignals(show) {
        this.initEmaGrid();
        this.emaGrid.showSignals = show;
        this.updateAllSignalMarkers();
        localStorage.setItem('showEmaSignals', show);
    }
    
    /**
     * Toggle ZEMA grid crossing signals
     */
    toggleZemaSignals(show) {
        this.initZemaGrid();
        this.zemaGrid.showSignals = show;
        this.updateAllSignalMarkers();
        localStorage.setItem('showZemaSignals', show);
    }
    
    /**
     * Calculate EMA grid crossing signals
     * Returns markers for when price touches/crosses the OUTERMOST grid lines
     * - Down arrow when bar HIGH >= highest grid line (10th line above EMA)
     * - Up arrow when bar LOW <= lowest grid line (10th line below EMA)
     */
    calculateEmaGridSignals(candles) {
        if (!candles || candles.length < this.emaGrid.period) return [];
        if (!this.emaGrid.spacing || this.emaGrid.spacing <= 0) return [];
        
        const markers = [];
        const emaValues = this.calculateEMASeries(candles, this.emaGrid.period);
        if (!emaValues || emaValues.length === 0) return [];
        
        const spacing = this.emaGrid.spacing;
        const maxLines = 10; // Same as grid drawing
        const startIdx = this.emaGrid.period - 1;
        
        for (let i = 0; i < emaValues.length; i++) {
            const candleIdx = startIdx + i;
            if (candleIdx >= candles.length) break;
            
            const candle = candles[candleIdx];
            const ema = emaValues[i].value;
            // Highest grid line (10th above) and lowest grid line (10th below)
            const highestGrid = ema * (1 + (maxLines * spacing));
            const lowestGrid = ema * (1 - (maxLines * spacing));
            
            // Down arrow when bar HIGH touches or exceeds HIGHEST grid line
            if (candle.high >= highestGrid) {
                markers.push({
                    time: candle.time,
                    position: 'aboveBar',
                    color: this.emaGrid.color || '#9ca3af',
                    shape: 'arrowDown'
                });
            }
            
            // Up arrow when bar LOW touches or goes below LOWEST grid line
            if (candle.low <= lowestGrid) {
                markers.push({
                    time: candle.time,
                    position: 'belowBar',
                    color: this.emaGrid.color || '#9ca3af',
                    shape: 'arrowUp'
                });
            }
        }
        
        return markers;
    }
    
    /**
     * Calculate ZEMA grid crossing signals
     * Returns markers for when price touches/crosses the OUTERMOST grid lines
     * - Down arrow when bar HIGH >= highest grid line (10th line above ZEMA)
     * - Up arrow when bar LOW <= lowest grid line (10th line below ZEMA)
     */
    calculateZemaGridSignals(candles) {
        if (!candles || candles.length < this.zemaGrid.period * 2) return [];
        if (!this.zemaGrid.spacing || this.zemaGrid.spacing <= 0) return [];
        
        const markers = [];
        const zemaValues = this.calculateZEMASeries(candles, this.zemaGrid.period);
        if (!zemaValues || zemaValues.length === 0) return [];
        
        const spacing = this.zemaGrid.spacing;
        const maxLines = 10; // Same as grid drawing
        // ZEMA needs 2 * period - 1 bars to start
        const startIdx = (this.zemaGrid.period * 2) - 2;
        
        for (let i = 0; i < zemaValues.length; i++) {
            const candleIdx = startIdx + i;
            if (candleIdx >= candles.length) break;
            
            const candle = candles[candleIdx];
            const zema = zemaValues[i].value;
            // Highest grid line (10th above) and lowest grid line (10th below)
            const highestGrid = zema * (1 + (maxLines * spacing));
            const lowestGrid = zema * (1 - (maxLines * spacing));
            
            // Down arrow when bar HIGH touches or exceeds HIGHEST grid line
            if (candle.high >= highestGrid) {
                markers.push({
                    time: candle.time,
                    position: 'aboveBar',
                    color: this.zemaGrid.color || '#8b5cf6',
                    shape: 'arrowDown'
                });
            }
            
            // Up arrow when bar LOW touches or goes below LOWEST grid line
            if (candle.low <= lowestGrid) {
                markers.push({
                    time: candle.time,
                    position: 'belowBar',
                    color: this.zemaGrid.color || '#8b5cf6',
                    shape: 'arrowUp'
                });
            }
        }
        
        return markers;
    }
    
    /**
     * Update all signal markers on the candlestick series
     * Combines BB Pulse signals with EMA/ZEMA grid signals
     */
    addAlertMarker(marker) {
        if (!this.candleSeries) return;
        if (!marker || !marker.time) return;
        
        if (!this.alertMarkers) this.alertMarkers = [];
        this.alertMarkers.push(marker);
        
        // Cap size to prevent marker overload
        const max = this.alertMarkersMax || 200;
        if (this.alertMarkers.length > max) {
            this.alertMarkers = this.alertMarkers.slice(-max);
        }
        
        // Re-apply combined markers immediately
        this.updateAllSignalMarkers();
    }
    
    clearAlertMarkers() {
        this.alertMarkers = [];
        this.updateAllSignalMarkers();
    }

    setAlertMarkers(markers) {
        this.alertMarkers = Array.isArray(markers) ? markers : [];
        const max = this.alertMarkersMax || 200;
        if (this.alertMarkers.length > max) {
            this.alertMarkers = this.alertMarkers.slice(-max);
        }
        this.updateAllSignalMarkers();
    }
    
    updateAllSignalMarkers() {
        if (!this.candleSeries) return;
        
        const candles = this.getCandles();
        if (!candles || candles.length === 0) return;
        const canCalcSignals = candles.length >= 50;
        
        let allMarkers = [];
        let emaSignals = [];
        let zemaSignals = [];
        
        // Add alert markers (if any)
        if (this.alertMarkers && this.alertMarkers.length > 0) {
            allMarkers = allMarkers.concat(this.alertMarkers);
        }
        
        // Add projection markers (if any)
        if (this.projections && this.projections.markers && this.projections.markers.length > 0) {
            allMarkers = allMarkers.concat(this.projections.markers);
        }

        // Add nearest cluster winner markers (if enabled)
        if (this.nearestClusterWinner && this.nearestClusterWinner.enabled && this.nearestClusterWinner.markers) {
            allMarkers = allMarkers.concat(this.nearestClusterWinner.markers);
        }
        
        // Add BB Pulse signals if enabled
        if (this.bbPulse && this.bbPulse.enabled && this.bbPulse.markers) {
            allMarkers = allMarkers.concat(this.bbPulse.markers);
        }
        
        // Add EMA grid signals if enabled
        if (canCalcSignals && this.emaGrid && this.emaGrid.showSignals) {
            emaSignals = this.calculateEmaGridSignals(candles);
            allMarkers = allMarkers.concat(emaSignals);
        }
        
        // Add ZEMA grid signals if enabled
        if (canCalcSignals && this.zemaGrid && this.zemaGrid.showSignals) {
            zemaSignals = this.calculateZemaGridSignals(candles);
            allMarkers = allMarkers.concat(zemaSignals);
        }
        
        // Cache for alerts/other consumers (avoid heavy recompute)
        this.emaSignalMarkers = emaSignals;
        this.zemaSignalMarkers = zemaSignals;
        
        // Sort markers by time
        allMarkers.sort((a, b) => a.time - b.time);
        
        // Apply all markers
        this.candleSeries.setMarkers(allMarkers);
    }

    toggleNearestClusterWinner(show) {
        if (!this.nearestClusterWinner) {
            this.nearestClusterWinner = { enabled: false, markers: [], markerByTime: new Map(), maxMarkers: 600 };
        }
        this.nearestClusterWinner.enabled = !!show;
        localStorage.setItem('showNearestClusterWinner', this.nearestClusterWinner.enabled);
        this.updateAllSignalMarkers();
    }

    resetNearestClusterWinnerMarkers() {
        if (!this.nearestClusterWinner) return;
        this.nearestClusterWinner.markerByTime = new Map();
        this.nearestClusterWinner.markers = [];
        this.updateAllSignalMarkers();
    }

    upsertNearestClusterWinnerMarker(marker) {
        if (!marker || !marker.time) return;
        if (!this.nearestClusterWinner) {
            this.nearestClusterWinner = { enabled: false, markers: [], markerByTime: new Map(), maxMarkers: 600 };
        }
        if (!this.nearestClusterWinner.markerByTime) {
            this.nearestClusterWinner.markerByTime = new Map();
        }

        const t = marker.time;
        // Keep existing marker for closed bars (don't overwrite)
        if (this.nearestClusterWinner.markerByTime.has(t)) return;

        this.nearestClusterWinner.markerByTime.set(t, marker);
        const all = Array.from(this.nearestClusterWinner.markerByTime.values());
        all.sort((a, b) => a.time - b.time);
        const max = this.nearestClusterWinner.maxMarkers || 600;
        this.nearestClusterWinner.markers = all.length > max ? all.slice(-max) : all;
        
        // Persist to localStorage
        this.saveNearestClusterWinnerToStorage();
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Save nearest cluster winner markers to localStorage
     * Storage key is scoped by symbol and interval
     */
    saveNearestClusterWinnerToStorage() {
        try {
            if (!this.nearestClusterWinner || !this.nearestClusterWinner.markers) return;
            
            const storageKey = `ncw_${this.symbol}_${this.currentInterval}`;
            const max = this.nearestClusterWinner.maxMarkers || 600;
            
            // Store only essential marker data
            let stored = this.nearestClusterWinner.markers.map(m => ({
                time: m.time,
                position: m.position,
                color: m.color,
                shape: m.shape,
                text: m.text
            }));
            
            if (stored.length > max) {
                stored = stored.slice(-max);
            }
            
            localStorage.setItem(storageKey, JSON.stringify(stored));
        } catch (e) {
            // localStorage might be full, silently fail
        }
    }
    
    /**
     * Load nearest cluster winner markers from localStorage
     * Called after interval is set
     */
    loadNearestClusterWinner() {
        if (!this.nearestClusterWinner) {
            this.nearestClusterWinner = { enabled: false, markers: [], markerByTime: new Map(), maxMarkers: 600 };
        }
        if (!this.currentInterval) return; // Wait for interval to be set
        
        try {
            const storageKey = `ncw_${this.symbol}_${this.currentInterval}`;
            const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
            
            if (!Array.isArray(stored) || stored.length === 0) {
                console.log(`[NCW] No saved markers for ${this.symbol} ${this.currentInterval}`);
                return;
            }
            
            // Populate cache
            this.nearestClusterWinner.markerByTime.clear();
            for (const m of stored) {
                const t = parseInt(m?.time, 10);
                if (!t || isNaN(t)) continue;
                
                this.nearestClusterWinner.markerByTime.set(t, {
                    time: t,
                    position: m.position,
                    color: m.color,
                    shape: m.shape,
                    text: m.text
                });
            }
            
            // Rebuild markers array from map
            const all = Array.from(this.nearestClusterWinner.markerByTime.values());
            all.sort((a, b) => a.time - b.time);
            const max = this.nearestClusterWinner.maxMarkers || 600;
            this.nearestClusterWinner.markers = all.length > max ? all.slice(-max) : all;
            
            console.log(`[NCW] Loaded ${this.nearestClusterWinner.markers.length} markers for ${this.symbol} ${this.currentInterval}`);
            
            if (this.nearestClusterWinner.enabled) {
                this.updateAllSignalMarkers();
            }
        } catch (e) {
            console.warn('[NCW] Failed to load from storage:', e);
        }
    }
    
    // ==========================================
    // DB BB Pulse Lighting Signals
    // ==========================================
    
    /**
     * Toggle BB Pulse Lighting Signals (arrows on main chart)
     */
    toggleBBPulse(show) {
        this.bbPulse.enabled = show;
        console.log('[Chart] toggleBBPulse signals:', show);
        
        if (show) {
            this.updateBBPulse();
        } else {
            this.clearBBPulseSignals();
        }
        
        // Save state
        localStorage.setItem('showBBPulse', show);
    }
    
    /**
     * Update BB Pulse Lighting Signals
     */
    updateBBPulse(updateCombinedMarkers = true) {
        if (!this.bbPulse.enabled || !this.chart || !this.candleSeries) {
            return;
        }
        if (typeof bbPulseLighting === 'undefined') {
            console.log('[Chart] updateBBPulse skipped - bbPulseLighting not loaded');
            return;
        }
        
        const candles = this.getCandles();
        if (!candles || candles.length < 200) {
            return;
        }
        
        // Calculate indicator
        const data = bbPulseLighting.calculate(candles);
        if (!data || !data.signals) {
            return;
        }
        
        console.log('[Chart] Drawing BB Pulse signals');
        this.drawBBPulseSignalsOnCandles(candles, data.signals, data.bbb, updateCombinedMarkers);
    }
    
    /**
     * Draw BB Pulse Lighting signals as markers on the candlestick series
     * Only shows core BB%B signals: period low (buy) and period high (sell)
     * @param {Array} candles - Full candle data
     * @param {Object} signals - Signal arrays from indicator
     * @param {Object} bbb - BB%B data including bbr array
     */
    drawBBPulseSignalsOnCandles(candles, signals, bbb, updateCombinedMarkers = true) {
        if (!signals || !this.candleSeries) return;
        
        const markers = [];
        // Signals start at candle index: (bbbLen-1) for bbr + (bbbLen-1) for period high/low
        const startIdx = (bbPulseLighting.bbbLen - 1) * 2;
        
        // Signal arrays are indexed from 0, corresponding to candles[startIdx]
        for (let i = 0; i < signals.lBuySignal1.length; i++) {
            const candleIdx = startIdx + i;
            if (candleIdx >= candles.length) break;
            
            const time = candles[candleIdx].time;
            
            // Buy Signal 1 - BB%B at period LOW (green arrow up)
            if (signals.lBuySignal1[i]) {
                markers.push({
                    time: time,
                    position: 'belowBar',
                    color: '#10b981',
                    shape: 'arrowUp'
                });
            }
            
            // Sell Signal 1 - BB%B at period HIGH (red arrow down)
            if (signals.lSellSignal1[i]) {
                markers.push({
                    time: time,
                    position: 'aboveBar',
                    color: '#ef4444',
                    shape: 'arrowDown'
                });
            }
        }
        
        // Store markers and update combined markers
        if (markers.length > 0) {
            console.log('[Chart] Adding', markers.length, 'BB Pulse signal markers');
            this.bbPulse.markers = markers;
        } else {
            this.bbPulse.markers = [];
        }
        
        // Update all signal markers (combines with EMA/ZEMA signals)
        if (updateCombinedMarkers) {
            this.updateAllSignalMarkers();
        }
    }
    
    /**
     * Clear BB Pulse signals from chart
     */
    clearBBPulseSignals() {
        this.bbPulse.markers = [];
        // Update combined markers (will still show EMA/ZEMA if enabled)
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Fair Value Indicators (IFV & VWMP)
    // ==========================================
    
    /**
     * Toggle Simple Mid Price line
     */
    toggleMid(show) {
        this.fairValueIndicators.showMid = show;
        this.updateFairValueIndicators();
    }
    
    /**
     * Toggle Implied Fair Value line
     */
    toggleIFV(show) {
        this.fairValueIndicators.showIFV = show;
        this.updateFairValueIndicators();
        if (this.historicalFairValue?.enabled) {
            this.renderHistoricalFairValue();
        }
    }
    
    /**
     * Toggle Volume-Weighted Mid Price line
     */
    toggleVWMP(show) {
        this.fairValueIndicators.showVWMP = show;
        this.updateFairValueIndicators();
        if (this.historicalFairValue?.enabled) {
            this.renderHistoricalFairValue();
        }
    }
    
    /**
     * Store levels for fair value calculations
     */
    setFairValueLevels(levels) {
        this.fairValueIndicators.currentLevels = levels;
        this.updateFairValueIndicators();
    }
    
    /**
     * Calculate Implied Fair Value
     * Volume-weighted center of the strongest support/resistance levels
     * @param {Array} levels - Order book levels
     * @param {number} currentPrice - Current market price (optional, for range filtering)
     */
    calculateIFV(levels, currentPrice = null) {
        if (!levels || levels.length === 0) return null;
        
        // Get fair value range from settings (default 15%)
        const fairValueRange = parseFloat(localStorage.getItem('fairValueRange') || '15') / 100;
        
        // Filter out invalid levels (price must be > 0 and reasonable)
        const validLevels = levels.filter(l => {
            const price = parseFloat(l.price);
            if (price <= 0) return false; // Filter out invalid prices
            
            // If currentPrice provided, filter to within ±fairValueRange%
            if (currentPrice && fairValueRange < 1) {
                const minPrice = currentPrice * (1 - fairValueRange);
                const maxPrice = currentPrice * (1 + fairValueRange);
                if (price < minPrice || price > maxPrice) return false;
            }
            
            return true;
        });
        
        if (validLevels.length === 0) return null;
        
        // Get top N strongest levels by volume (mix of support and resistance)
        const sortedByVolume = [...validLevels].sort((a, b) => b.volume - a.volume);
        const topLevels = sortedByVolume.slice(0, Math.min(10, validLevels.length));
        
        if (topLevels.length === 0) return null;
        
        // Volume-weighted average price of strongest levels
        let totalVolumePrice = 0;
        let totalVolume = 0;
        
        topLevels.forEach(level => {
            const price = parseFloat(level.price);
            const volume = parseFloat(level.volume);
            totalVolumePrice += price * volume;
            totalVolume += volume;
        });
        
        return totalVolume > 0 ? totalVolumePrice / totalVolume : null;
    }
    
    /**
     * Calculate Volume-Weighted Mid Price
     * Weighted average of all bid/ask levels
     * @param {Array} levels - Order book levels
     * @param {number} currentPrice - Current market price (optional, for range filtering)
     */
    calculateVWMP(levels, currentPrice = null) {
        if (!levels || levels.length === 0) return null;
        
        // Get fair value range from settings (default 15%)
        const fairValueRange = parseFloat(localStorage.getItem('fairValueRange') || '15') / 100;
        
        // Filter out invalid levels (price must be > 0 and reasonable)
        const validLevels = levels.filter(l => {
            const price = parseFloat(l.price);
            if (price <= 0) return false; // Filter out invalid prices
            
            // If currentPrice provided, filter to within ±fairValueRange%
            if (currentPrice && fairValueRange < 1) {
                const minPrice = currentPrice * (1 - fairValueRange);
                const maxPrice = currentPrice * (1 + fairValueRange);
                if (price < minPrice || price > maxPrice) return false;
            }
            
            return true;
        });
        
        // Separate support (bids) and resistance (asks)
        const supports = validLevels.filter(l => l.type === 'support');
        const resistances = validLevels.filter(l => l.type === 'resistance');
        
        if (supports.length === 0 || resistances.length === 0) return null;
        
        // Calculate volume-weighted average for each side
        const calcVWAP = (items) => {
            let totalVolumePrice = 0;
            let totalVolume = 0;
            items.forEach(l => {
                const price = parseFloat(l.price);
                const volume = parseFloat(l.volume);
                totalVolumePrice += price * volume;
                totalVolume += volume;
            });
            return totalVolume > 0 ? totalVolumePrice / totalVolume : null;
        };
        
        const bidVWAP = calcVWAP(supports);
        const askVWAP = calcVWAP(resistances);
        
        if (bidVWAP === null || askVWAP === null) return null;
        
        // Total volume on each side for weighting
        const bidVolume = supports.reduce((sum, l) => sum + parseFloat(l.volume), 0);
        const askVolume = resistances.reduce((sum, l) => sum + parseFloat(l.volume), 0);
        const totalVolume = bidVolume + askVolume;
        
        // Volume-weighted mid price (weighted toward side with more volume)
        return (bidVWAP * bidVolume + askVWAP * askVolume) / totalVolume;
    }
    
    /**
     * Calculate Simple Mid Price
     * (Best Bid + Best Ask) / 2
     */
    calculateMid(levels) {
        if (!levels || levels.length === 0) return null;
        
        // Filter out invalid levels (price must be > 0)
        const validLevels = levels.filter(l => {
            const price = parseFloat(l.price);
            return price > 0; // Filter out invalid prices
        });
        
        // Separate support (bids) and resistance (asks)
        const supports = validLevels.filter(l => l.type === 'support');
        const resistances = validLevels.filter(l => l.type === 'resistance');
        
        if (supports.length === 0 || resistances.length === 0) return null;
        
        // Find best bid (highest support) and best ask (lowest resistance)
        const bestBid = Math.max(...supports.map(l => parseFloat(l.price)));
        const bestAsk = Math.min(...resistances.map(l => parseFloat(l.price)));
        
        // Simple mid = (best bid + best ask) / 2
        return (bestBid + bestAsk) / 2;
    }
    
    /**
     * Update fair value indicator lines on chart
     */
    updateFairValueIndicators() {
        if (!this.candleSeries) return;
        
        const levels = this.fairValueIndicators.currentLevels;
        
        // Preserve sidebar scroll position during updates
        const sidebar = document.querySelector('.sidebar-right');
        const scrollTop = sidebar ? sidebar.scrollTop : 0;
        
        // Calculate all values (pass currentPrice for range filtering)
        const mid = this.calculateMid(levels);
        const ifv = this.calculateIFV(levels, this.currentPrice);
        const vwmp = this.calculateVWMP(levels, this.currentPrice);

        // Track VWMP/IFV history plot (per-candle) regardless of redraw threshold
        this.trackHistoricalFairValue(vwmp, ifv);

        // IMPORTANT: Alpha must be computed even if the Fair Value sidebar panel
        // is not present (e.g. replay.html / headless metric engine).
        this.updateAlphaScore(this.currentPrice, mid, vwmp, ifv);
        
        // Check if values have changed significantly (0.05% threshold)
        const threshold = 0.0005;
        const lastVals = this.fairValueIndicators.lastValues || {};
        const hasSignificantChange = (
            !lastVals.mid || Math.abs((mid - lastVals.mid) / lastVals.mid) > threshold ||
            !lastVals.ifv || Math.abs((ifv - lastVals.ifv) / lastVals.ifv) > threshold ||
            !lastVals.vwmp || Math.abs((vwmp - lastVals.vwmp) / lastVals.vwmp) > threshold
        );
        
        // Skip line redraw if no significant change (but still update panel)
        const shouldRedrawLines = hasSignificantChange || 
            !this.fairValueIndicators.midLine && this.fairValueIndicators.showMid ||
            !this.fairValueIndicators.ifvLine && this.fairValueIndicators.showIFV ||
            !this.fairValueIndicators.vwmpLine && this.fairValueIndicators.showVWMP;
        
        if (shouldRedrawLines) {
            // Store values for next comparison
            this.fairValueIndicators.lastValues = { mid, ifv, vwmp };
            
            // Clear existing lines
            this.clearFairValueLines();
        
        // Draw Simple Mid line
        if (this.fairValueIndicators.showMid && mid !== null) {
            this.fairValueIndicators.midLine = this.candleSeries.createPriceLine({
                price: mid,
                color: 'rgba(229, 231, 235, 0.9)', // Light gray
                lineWidth: 2,
                lineStyle: LightweightCharts.LineStyle.Dotted,
                axisLabelVisible: true,
                title: 'Mid'
            });
        }
        
        // Draw IFV line
        if (this.fairValueIndicators.showIFV && ifv !== null) {
            this.fairValueIndicators.ifvLine = this.candleSeries.createPriceLine({
                price: ifv,
                color: 'rgba(167, 139, 250, 0.9)', // Purple
                lineWidth: 3,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'IFV'
            });
        }
        
        // Draw VWMP line
        if (this.fairValueIndicators.showVWMP && vwmp !== null) {
            this.fairValueIndicators.vwmpLine = this.candleSeries.createPriceLine({
                price: vwmp,
                color: 'rgba(52, 211, 153, 0.9)', // Green
                lineWidth: 3,
                lineStyle: LightweightCharts.LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'VWMP'
            });
            }
        }
        
        // Always update Fair Value Panel in sidebar (text updates are fine)
        this.updateFairValuePanel(mid, vwmp, ifv);
        
        // Restore sidebar scroll position after DOM updates
        if (sidebar && scrollTop > 0) {
            sidebar.scrollTop = scrollTop;
        }
    }
    
    /**
     * Update Fair Value Panel in sidebar with analysis
     */
    updateFairValuePanel(mid, vwmp, ifv) {
        const currentPrice = this.currentPrice;
        
        // Get DOM elements
        const fvCurrentPrice = document.getElementById('fvCurrentPrice');
        const fvMidValue = document.getElementById('fvMidValue');
        const fvMidDiff = document.getElementById('fvMidDiff');
        const fvVwmpValue = document.getElementById('fvVwmpValue');
        const fvVwmpDiff = document.getElementById('fvVwmpDiff');
        const fvIfvValue = document.getElementById('fvIfvValue');
        const fvIfvDiff = document.getElementById('fvIfvDiff');
        const fvAnalysisText = document.getElementById('fvAnalysisText');
        
        if (!fvCurrentPrice || !fvAnalysisText) return;
        
        // Format price helper - use smart formatter for any price magnitude
        const formatPrice = (p) => formatSmartPriceChart(p);
        const formatDiff = (current, target) => {
            if (!current || !target) return { text: '--', class: 'neutral' };
            const diff = ((current - target) / target) * 100;
            const sign = diff >= 0 ? '+' : '';
            return {
                text: sign + diff.toFixed(2) + '%',
                class: diff > 0.1 ? 'above' : diff < -0.1 ? 'below' : 'neutral'
            };
        };
        
        // Update values
        fvCurrentPrice.textContent = formatPrice(currentPrice);
        
        if (fvMidValue && mid) {
            fvMidValue.textContent = formatPrice(mid);
            const midDiff = formatDiff(currentPrice, mid);
            fvMidDiff.textContent = midDiff.text;
            fvMidDiff.className = 'fv-diff ' + midDiff.class;
        }
        
        if (fvVwmpValue && vwmp) {
            fvVwmpValue.textContent = formatPrice(vwmp);
            const vwmpDiff = formatDiff(currentPrice, vwmp);
            fvVwmpDiff.textContent = vwmpDiff.text;
            fvVwmpDiff.className = 'fv-diff ' + vwmpDiff.class;
        }
        
        if (fvIfvValue && ifv) {
            fvIfvValue.textContent = formatPrice(ifv);
            const ifvDiff = formatDiff(currentPrice, ifv);
            fvIfvDiff.textContent = ifvDiff.text;
            fvIfvDiff.className = 'fv-diff ' + ifvDiff.class;
        }
        
        // Generate analysis
        if (!currentPrice || !mid || !vwmp || !ifv) {
            fvAnalysisText.innerHTML = 'Waiting for data...';
            return;
        }
        
        let analysis = [];
        let signal = '';
        let signalClass = 'neutral';
        
        // Analyze price position relative to fair values
        const aboveMid = currentPrice > mid;
        const aboveVwmp = currentPrice > vwmp;
        const aboveIfv = currentPrice > ifv;
        const aboveCount = [aboveMid, aboveVwmp, aboveIfv].filter(x => x).length;
        
        // Analyze VWMP vs Mid (shows volume weighting)
        const vwmpVsMid = ((vwmp - mid) / mid) * 100;
        
        // Analyze IFV vs Mid (shows strong level positioning)
        const ifvVsMid = ((ifv - mid) / mid) * 100;
        
        // Price position analysis - simplified
        if (aboveCount === 3) {
            analysis.push('📍 Price is <strong>higher than it "should" be</strong> based on orders.');
            signal = '⚠️ Might drop back down to fair values';
            signalClass = 'bearish';
        } else if (aboveCount === 0) {
            analysis.push('📍 Price is <strong>lower than it "should" be</strong> based on orders.');
            signal = '💡 Could bounce up toward fair values';
            signalClass = 'bullish';
        } else if (aboveCount === 1 || aboveCount === 2) {
            analysis.push('📍 Price is <strong>near fair value</strong> — in the "normal" zone.');
        }
        
        // VWMP vs Mid analysis - simplified
        if (vwmpVsMid < -0.3) {
            analysis.push('💰 Big buyers are waiting at lower prices = safety net below.');
            if (signalClass === 'neutral') {
                signal = '📈 Bullish: Buyers ready to catch any dip';
                signalClass = 'bullish';
            }
        } else if (vwmpVsMid > 0.3) {
            analysis.push('💰 Big sellers are waiting at higher prices = ceiling above.');
            if (signalClass === 'neutral') {
                signal = '📉 Bearish: Sellers ready to push price down';
                signalClass = 'bearish';
            }
        }
        
        // IFV analysis - simplified
        if (Math.abs(ifvVsMid) > 1) {
            if (ifvVsMid < 0) {
                analysis.push('🛡️ Strong support walls exist below current price.');
            } else {
                analysis.push('🧱 Strong resistance walls exist above current price.');
            }
        }
        
        // Convergence/Divergence - simplified
        const spread = Math.max(mid, vwmp, ifv) - Math.min(mid, vwmp, ifv);
        const spreadPercent = (spread / mid) * 100;
        
        if (spreadPercent < 0.5) {
            analysis.push('✅ All indicators agree — <strong>high confidence</strong> in fair value.');
            if (!signal) {
                signal = '🎯 Clear fair value — good reference point';
                signalClass = 'neutral';
            }
        } else if (spreadPercent > 2) {
            analysis.push('⚡ Indicators disagree — market is <strong>uncertain</strong>.');
        }
        
        // Build final HTML
        let html = analysis.join('<br>');
        if (signal) {
            html += `<span class="signal ${signalClass}">${signal}</span>`;
        }
        
        // Only update if content changed (prevents flicker)
        if (fvAnalysisText.innerHTML !== html) {
        fvAnalysisText.innerHTML = html;
        }
        
        // Update Market Consensus Signal
        this.updateMarketConsensus(currentPrice, vwmp, ifv);
        
        // Update trade setup
        this.updateTradeSetup(currentPrice, mid, vwmp, ifv);
    }
    
    // ==========================================
    // HISTORICAL FAIR VALUE TRACKING
    // ==========================================
    
    /**
     * Track historical fair value (VWMP, IFV) at each candle
     * Also tracks projection targets
     */
    trackHistoricalFairValue(vwmp, ifv) {
        if (!this.historicalFairValue.enabled) return;
        
        const now = Date.now();
        const candleTime = this.getCurrentCandleTime();
        if (!candleTime) return;
        
        // Get current projection targets if available
        const targets = this.getProjectionTargets();
        
        // Create current snapshot
        const current = {
            vwmp: (vwmp && isFinite(vwmp)) ? parseFloat(vwmp.toFixed(2)) : null,
            ifv: (ifv && isFinite(ifv)) ? parseFloat(ifv.toFixed(2)) : null,
            upsideTarget: targets?.upside || null,
            downsideTarget: targets?.downside || null,
            timestamp: Date.now()
        };
        
        // Skip if nothing meaningful to record yet
        if (!current.vwmp && !current.ifv && !current.upsideTarget && !current.downsideTarget) return;
        
        // Update the current candle snapshot (one record per candle)
        const prev = this.historicalFairValue.cachedData.get(candleTime) || null;
        const hasChanged = !prev ||
            prev.vwmp !== current.vwmp ||
            prev.ifv !== current.ifv ||
            prev.upsideTarget !== current.upsideTarget ||
            prev.downsideTarget !== current.downsideTarget;
        
        if (!hasChanged) return;
        
        this.historicalFairValue.cachedData.set(candleTime, current);
        
        // Trim to max candles (oldest first)
        const maxCandles = this.historicalFairValue.maxCandles || 500;
        if (this.historicalFairValue.cachedData.size > maxCandles) {
            const keys = Array.from(this.historicalFairValue.cachedData.keys()).sort((a, b) => a - b);
            const removeCount = keys.length - maxCandles;
            for (let i = 0; i < removeCount; i++) {
                this.historicalFairValue.cachedData.delete(keys[i]);
            }
        }
        
        // Re-render plot
        this.renderHistoricalFairValue();
        
        // Persist to localStorage (throttled)
        const lastSaveTs = this.historicalFairValue.lastSaveTs || 0;
        const lastSavedCandleTime = this.historicalFairValue.lastSavedCandleTime;
        const candleRolled = lastSavedCandleTime && candleTime !== lastSavedCandleTime;
        const timeDue = (now - lastSaveTs) >= 15000; // ~4 saves/min max
        const firstSave = lastSaveTs === 0;
        
        if (firstSave || candleRolled || timeDue) {
            this.historicalFairValue.lastSavedCandleTime = candleTime;
            this.saveHistoricalFairValueToStorage();
        }
    }
    
    /**
     * Get current projection targets from the projection system
     */
    getProjectionTargets() {
        if (!this.projectionData) return null;
        
        return {
            upside: this.projectionData.upsideTarget || null,
            downside: this.projectionData.downsideTarget || null
        };
    }
    
    /**
     * Save historical fair value to localStorage (simpler than DB schema changes)
     */
    saveHistoricalFairValueToStorage() {
        try {
            const storageKey = `histFV_${this.symbol}_${this.currentInterval}`;
            const maxCandles = this.historicalFairValue.maxCandles || 500;
            
            let stored = Array.from(this.historicalFairValue.cachedData.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([candleTime, record]) => ({ ...record, candleTime }));
            
            if (stored.length > maxCandles) {
                stored = stored.slice(-maxCandles);
            }
            
            localStorage.setItem(storageKey, JSON.stringify(stored));
            this.historicalFairValue.lastSaveTs = Date.now();
        } catch (e) {
            // localStorage might be full, silently fail
        }
    }
    
    /**
     * Load historical fair values from localStorage
     * Called after interval is set
     */
    loadHistoricalFairValue() {
        if (!this.historicalFairValue.enabled) return;
        if (!this.currentInterval) return; // Wait for interval to be set
        
        try {
            const storageKey = `histFV_${this.symbol}_${this.currentInterval}`;
            const stored = JSON.parse(localStorage.getItem(storageKey) || '[]');
            
            if (!Array.isArray(stored) || stored.length === 0) {
                console.log(`[Historical FV] No data for ${this.symbol} ${this.currentInterval}`);
                return;
            }
            
            // Populate cache
            this.historicalFairValue.cachedData.clear();
            for (const record of stored) {
                const candleTime = parseInt(record?.candleTime, 10);
                if (!candleTime || isNaN(candleTime)) continue;
                
                // Last write wins if duplicates exist (older schema)
                this.historicalFairValue.cachedData.set(candleTime, {
                    vwmp: record.vwmp ?? null,
                    ifv: record.ifv ?? null,
                    upsideTarget: record.upsideTarget ?? null,
                    downsideTarget: record.downsideTarget ?? null,
                    timestamp: record.timestamp ?? null
                });
            }
            
            // Trim to max candles
            const maxCandles = this.historicalFairValue.maxCandles || 500;
            if (this.historicalFairValue.cachedData.size > maxCandles) {
                const keys = Array.from(this.historicalFairValue.cachedData.keys()).sort((a, b) => a - b);
                const removeCount = keys.length - maxCandles;
                for (let i = 0; i < removeCount; i++) {
                    this.historicalFairValue.cachedData.delete(keys[i]);
                }
            }
            
            console.log(`[Historical FV] Loaded ${this.historicalFairValue.cachedData.size} candles for ${this.currentInterval}`);
            this.renderHistoricalFairValue();
        } catch (e) {
            console.warn('[Historical FV] Failed to load from storage:', e);
        }
    }
    
    /**
     * Render historical fair values as VWMP/IFV history plots
     */
    renderHistoricalFairValue() {
        if (!this.historicalFairValue.enabled || !this.chart) return;
        
        const cachedData = this.historicalFairValue.cachedData;
        if (cachedData.size === 0) {
            // Keep series objects, but clear their data
            try { this.historicalFairValue.vwmpSeries?.setData([]); } catch (e) {}
            try { this.historicalFairValue.ifvSeries?.setData([]); } catch (e) {}
            try { this.historicalFairValue.upsideSeries?.setData([]); } catch (e) {}
            try { this.historicalFairValue.downsideSeries?.setData([]); } catch (e) {}
            return;
        }
        
        const intervalSeconds = this.getIntervalSeconds();
        
        // Limit to recent candles for performance (cap = lowest timeframe-friendly)
        const maxCandles = this.historicalFairValue.maxCandles || 500;
        const sortedCandlesAsc = Array.from(cachedData.keys()).sort((a, b) => a - b);
        const limitedCandles = sortedCandlesAsc.slice(-maxCandles);
        
        // Collect all unique values per candle
        const vwmpData = [];
        const ifvData = [];
        const upsideData = [];
        const downsideData = [];
        
        limitedCandles.forEach(candleTime => {
            const record = cachedData.get(candleTime);
            if (!record) return;
            
            if (record.vwmp) {
                vwmpData.push({ time: candleTime, value: record.vwmp });
                vwmpData.push({ time: candleTime + intervalSeconds - 1, value: record.vwmp });
            }
            
            if (record.ifv) {
                ifvData.push({ time: candleTime, value: record.ifv });
                ifvData.push({ time: candleTime + intervalSeconds - 1, value: record.ifv });
            }
            
            if (record.upsideTarget) {
                upsideData.push({ time: candleTime, value: record.upsideTarget });
                upsideData.push({ time: candleTime + intervalSeconds - 1, value: record.upsideTarget });
            }
            
            if (record.downsideTarget) {
                downsideData.push({ time: candleTime, value: record.downsideTarget });
                downsideData.push({ time: candleTime + intervalSeconds - 1, value: record.downsideTarget });
            }
        });
        
        // Get brightness from settings (0-1), shared with historical levels
        // Keep same base colors as current VWMP/IFV, but with lower opacity for history.
        const baseOpacity = 0.55;
        
        // Ensure series exist (create once, then update)
        if (!this.historicalFairValue.vwmpSeries) {
            try {
                this.historicalFairValue.vwmpSeries = this.chart.addLineSeries({
                    color: `rgba(52, 211, 153, ${baseOpacity})`,  // VWMP green (history)
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                this.historicalFairValue.series.push(this.historicalFairValue.vwmpSeries);
            } catch (e) { /* ignore */ }
        } else {
            try { this.historicalFairValue.vwmpSeries.applyOptions({ color: `rgba(52, 211, 153, ${baseOpacity})` }); } catch (e) {}
        }
        
        if (!this.historicalFairValue.ifvSeries) {
            try {
                this.historicalFairValue.ifvSeries = this.chart.addLineSeries({
                    color: `rgba(167, 139, 250, ${baseOpacity})`,  // IFV purple (history)
                    lineWidth: 2,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                this.historicalFairValue.series.push(this.historicalFairValue.ifvSeries);
            } catch (e) { /* ignore */ }
        } else {
            try { this.historicalFairValue.ifvSeries.applyOptions({ color: `rgba(167, 139, 250, ${baseOpacity})` }); } catch (e) {}
        }
        
        // Create ghosted upside target series (faded cyan)
        const targetOpacity = baseOpacity * 0.75;
        if (!this.historicalFairValue.upsideSeries) {
            try {
                this.historicalFairValue.upsideSeries = this.chart.addLineSeries({
                    color: `rgba(0, 217, 255, ${targetOpacity})`,  // Cyan
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                this.historicalFairValue.series.push(this.historicalFairValue.upsideSeries);
            } catch (e) { /* ignore */ }
        } else {
            try { this.historicalFairValue.upsideSeries.applyOptions({ color: `rgba(0, 217, 255, ${targetOpacity})` }); } catch (e) {}
        }
        
        // Create ghosted downside target series (faded pink)
        if (!this.historicalFairValue.downsideSeries) {
            try {
                this.historicalFairValue.downsideSeries = this.chart.addLineSeries({
                    color: `rgba(255, 0, 110, ${targetOpacity})`,  // Pink
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dashed,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                this.historicalFairValue.series.push(this.historicalFairValue.downsideSeries);
            } catch (e) { /* ignore */ }
        } else {
            try { this.historicalFairValue.downsideSeries.applyOptions({ color: `rgba(255, 0, 110, ${targetOpacity})` }); } catch (e) {}
        }
        
        // Apply data (VWMP/IFV history should only show when their current lines are enabled)
        try {
            if (this.historicalFairValue.vwmpSeries) {
                this.historicalFairValue.vwmpSeries.setData(this.fairValueIndicators.showVWMP ? vwmpData : []);
            }
        } catch (e) { /* ignore */ }
        
        try {
            if (this.historicalFairValue.ifvSeries) {
                this.historicalFairValue.ifvSeries.setData(this.fairValueIndicators.showIFV ? ifvData : []);
            }
        } catch (e) { /* ignore */ }
        
        // Targets remain tied to the projection overlay toggle (if present)
        const showTargets = !!this.projections?.showTargets;
        try { this.historicalFairValue.upsideSeries?.setData(showTargets ? upsideData : []); } catch (e) {}
        try { this.historicalFairValue.downsideSeries?.setData(showTargets ? downsideData : []); } catch (e) {}
    }
    
    /**
     * Clear historical fair value series
     */
    clearHistoricalFairValueSeries() {
        if (this.chart && this.historicalFairValue.series) {
            this.historicalFairValue.series.forEach(series => {
                try {
                    this.chart.removeSeries(series);
                } catch (e) { /* already removed */ }
            });
        }
        this.historicalFairValue.series = [];
        this.historicalFairValue.vwmpSeries = null;
        this.historicalFairValue.ifvSeries = null;
        this.historicalFairValue.upsideSeries = null;
        this.historicalFairValue.downsideSeries = null;
    }
    
    /**
     * Toggle historical fair value display
     */
    setHistoricalFairValueEnabled(enabled) {
        this.historicalFairValue.enabled = enabled;
        localStorage.setItem('showHistoricalFairValue', enabled ? 'true' : 'false');
        
        if (enabled) {
            this.loadHistoricalFairValue();
        } else {
            this.clearHistoricalFairValueSeries();
        }
    }
    
    /**
     * Calculate and display Microstructure Alpha Score (0-100)
     * Combines BPR + LD + IFV + VWMP into single institutional-grade signal
     */
    updateAlphaScore(currentPrice, mid, vwmp, ifv) {
        // console.log('[Alpha Debug] updateAlphaScore START:', 'price=' + currentPrice?.toFixed?.(2), 'prevAlpha=' + this.alphaScore);
        
        // Alpha mode presets (MM / Swing / HTF) - base defaults
        const alphaPresetsBase = {
            marketMaker: {
                normEmaAlpha: 0.40,
                normStepMax: 0.12,
                minNorm: 0.15,
                ifvAlphaFactor: 1.2,
                renderMs: 300
            },
            swingTrader: {
                normEmaAlpha: 0.28,
                normStepMax: 0.08,
                minNorm: 0.25,
                ifvAlphaFactor: 0.9,
                renderMs: 600
            },
            investor: {
                normEmaAlpha: 0.18,
                normStepMax: 0.05,
                minNorm: 0.35,
                ifvAlphaFactor: 0.6,
                renderMs: 900
            }
        };
        const alphaMode = this.alphaMode || 'investor';
        const basePreset = alphaPresetsBase[alphaMode] || alphaPresetsBase.investor;
        
        // Apply sensitivity multiplier on top of defaults
        // multiplier > 1 = more responsive, < 1 = more stable
        const sens = this.alphaSensitivityMultiplier || 1.0;
        const alphaPreset = {
            normEmaAlpha: Math.min(0.95, Math.max(0.001, basePreset.normEmaAlpha * sens)),
            normStepMax: Math.min(0.25, Math.max(0.001, basePreset.normStepMax * sens)),
            minNorm: Math.max(0.01, Math.min(0.5, basePreset.minNorm / sens)), // inverse: higher sens = lower floor
            ifvAlphaFactor: Math.min(2.0, Math.max(0.05, basePreset.ifvAlphaFactor * sens)),
            renderMs: Math.max(100, Math.min(5000, basePreset.renderMs / sens)) // inverse: higher sens = faster render
        };
        this.regimeEngine.normEmaAlpha = alphaPreset.normEmaAlpha;
        // Get DOM elements (may be absent in replay/headless mode)
        const alphaValue = document.getElementById('alphaValue');
        const alphaGaugeFill = document.getElementById('alphaGaugeFill');
        const alphaGaugeMarker = document.getElementById('alphaGaugeMarker');
        const alphaRegime = document.getElementById('alphaRegime');
        const alphaInterpretation = document.getElementById('alphaInterpretation');
        const alphaLdFill = document.getElementById('alphaLdFill');
        const alphaBprFill = document.getElementById('alphaBprFill');
        const alphaIfvFill = document.getElementById('alphaIfvFill');
        const alphaVwmpFill = document.getElementById('alphaVwmpFill');

        if (!currentPrice) return;
        
        // Get BPR and LD from order flow
        const bpr = this.orderFlowPressure?.levels ? this.calculateBPR(this.orderFlowPressure.levels) : null;
        const ld = this.orderFlowPressure?.levels ? this.calculateLiquidityDelta(this.orderFlowPressure.levels, currentPrice) : null;
        const ldDelta = ld?.delta || 0;
        const bprRatio = bpr?.ratio || 1;
        
        if (!bpr || !ld || !vwmp || !ifv) {
            // Headless/replay: still clear stored score so consumers don't see stale values.
            this.alphaScore = null;
            if (alphaValue) alphaValue.textContent = '--';
            if (alphaInterpretation) alphaInterpretation.innerHTML = 'Waiting for complete data...';
            return;
        }
        
        // ========================================
        // STEP 1: Normalize each indicator (0-1)
        // ========================================
        
        const percentile = (arr, p) => {
            if (!arr.length) return 0;
            const idx = (arr.length - 1) * p;
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            if (lo === hi) return arr[lo];
            return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
        };
        
        // BPR Normalization: 0.8-1.2 range maps to 0-1
        const bprSamples = this.regimeEngine.bprSamples;
        bprSamples.push(bprRatio);
        if (bprSamples.length > 500) bprSamples.shift();

        let bprNorm;
        if (bprSamples.length >= 20) {
            const sortedBpr = [...bprSamples].sort((a, b) => a - b);
            const lowBpr = percentile(sortedBpr, 0.05);
            const highBpr = percentile(sortedBpr, 0.95);
            // Clamp low/high to IQR fence to avoid collapse on outliers
            const midIdx = Math.floor(sortedBpr.length / 2);
            const medianBpr = sortedBpr[midIdx];
            const q1 = sortedBpr[Math.floor(sortedBpr.length * 0.25)];
            const q3 = sortedBpr[Math.floor(sortedBpr.length * 0.75)];
            const iqr = q3 - q1 || 1e-6;
            const lowClamped = Math.max(lowBpr, medianBpr - 4 * iqr);
            const highClamped = Math.min(highBpr, medianBpr + 4 * iqr);
            const spanBpr = Math.max(highClamped - lowClamped, 1e-6);
            const nBpr = Math.max(0, Math.min(1, (bprRatio - lowClamped) / spanBpr));
            bprNorm = nBpr * nBpr * (3 - 2 * nBpr); // smoothstep
        } else {
            if (bpr.ratio <= 0.8) bprNorm = 0;
            else if (bpr.ratio >= 1.2) bprNorm = 1;
            else bprNorm = (bpr.ratio - 0.8) / (1.2 - 0.8);
        }
        
        // Smooth BPR norm to avoid jumps and rate-limit step size
        const prevBprEma = this.regimeEngine.bprNormEma;
        if (prevBprEma === null || prevBprEma === undefined) {
            this.regimeEngine.bprNormEma = bprNorm;
        } else {
            const a = alphaPreset.normEmaAlpha;
            let next = a * bprNorm + (1 - a) * prevBprEma;
            const step = alphaPreset.normStepMax;
            next = Math.min(Math.max(next, prevBprEma - step), prevBprEma + step);
            if (bprSamples.length >= 20) {
                next = Math.max(next, alphaPreset.minNorm);
            }
            this.regimeEngine.bprNormEma = next;
        }
        bprNorm = this.regimeEngine.bprNormEma !== null ? this.regimeEngine.bprNormEma : bprNorm;
        
        // LD Normalization: adaptive per-symbol using rolling percentiles
        const ldSamples = this.regimeEngine.ldSamples;
        ldSamples.push(ldDelta);
        if (ldSamples.length > 500) ldSamples.shift();

        let ldNorm;
        if (ldSamples.length >= 20) {
            const sorted = [...ldSamples].sort((a, b) => a - b);
            const low = percentile(sorted, 0.05);
            const high = percentile(sorted, 0.95);
            // Clamp low/high using IQR fence to reduce outlier collapse
            const midIdx = Math.floor(sorted.length / 2);
            const median = sorted[midIdx];
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const iqr = q3 - q1 || 1e-6;
            const lowClamped = Math.max(low, median - 4 * iqr);
            const highClamped = Math.min(high, median + 4 * iqr);
            const span = Math.max(highClamped - lowClamped, 1e-6);
            const n = Math.max(0, Math.min(1, (ldDelta - lowClamped) / span));
            // Smoothstep to reduce edge sensitivity
            ldNorm = n * n * (3 - 2 * n);
        } else {
            // Fallback during warmup (legacy scale)
            const ldMax = 100;
            ldNorm = Math.max(0, Math.min(1, (ldDelta + ldMax) / (2 * ldMax)));
        }

        // Smooth LD norm to avoid jumps and rate-limit step size
        const prevLdEma = this.regimeEngine.ldNormEma;
        if (prevLdEma === null || prevLdEma === undefined) {
            this.regimeEngine.ldNormEma = ldNorm;
        } else {
            const a = alphaPreset.normEmaAlpha;
            let next = a * ldNorm + (1 - a) * prevLdEma;
            const step = alphaPreset.normStepMax;
            next = Math.min(Math.max(next, prevLdEma - step), prevLdEma + step);
            if (ldSamples.length >= 20) {
                next = Math.max(next, alphaPreset.minNorm);
            }
            this.regimeEngine.ldNormEma = next;
        }
        ldNorm = this.regimeEngine.ldNormEma !== null ? this.regimeEngine.ldNormEma : ldNorm;
        
        // VWMP Normalization: Price vs VWMP, ±5% band
        // If VWMP > price → bullish (norm higher)
        const vwmpDist = (vwmp - currentPrice) / currentPrice;
        let vwmpNorm = Math.max(0, Math.min(1, (vwmpDist + 0.05) / 0.10));
        
        // IFV Normalization: Price vs IFV, ±10% band (wider because IFV drifts slower)
        // If IFV > price → bullish (norm higher)
        const ifvDist = (ifv - currentPrice) / currentPrice;
        let ifvNormRaw = Math.max(0, Math.min(1, (ifvDist + 0.10) / 0.20));
        
        // Apply EMA smoothing to IFV component (dampens async data arrival noise)
        if (this.regimeEngine.ifvNormEma === null) {
            this.regimeEngine.ifvNormEma = ifvNormRaw; // Initialize on first value
        } else {
            // Adjust smoothing by price scale (proxy for liquidity) and mode
            let a = this.regimeEngine.ifvEmaAlpha;
            if (currentPrice > 10000) a = 0.15;
            else if (currentPrice > 1000) a = 0.20;
            else if (currentPrice > 100) a = 0.25;
            else a = 0.30;
            a = Math.min(0.45, Math.max(0.08, a * alphaPreset.ifvAlphaFactor));
            this.regimeEngine.ifvEmaAlpha = a;
            this.regimeEngine.ifvNormEma = a * ifvNormRaw + (1 - a) * this.regimeEngine.ifvNormEma;
        }
        let ifvNorm = this.regimeEngine.ifvNormEma;
        
        // ========================================
        // STEP 2: Apply institutional weights
        // ========================================
        const weightsBase = {
            ld: 0.40,    // Most predictive
            bpr: 0.25,   // Strong static pressure
            ifv: 0.25,   // Long-term drift anchor
            vwmp: 0.10   // Premium/discount filter
        };

        // Reduce influence of saturated or uncalibrated components, then renormalize
        const weights = { ...weightsBase };
        if (ldSamples.length < 20 || ldNorm < 0.05 || ldNorm > 0.95) {
            weights.ld *= 0.5;
        }
        if (bprSamples.length < 20 || bprNorm < 0.05 || bprNorm > 0.95) {
            weights.bpr *= 0.6;
        }
        // Ensure no component can dominate when others are weak
        const minComponent = 0.15;
        const components = ['ld','bpr','ifv','vwmp'];
        const totalBefore = components.reduce((s,k)=>s+weights[k],0);
        components.forEach(k => weights[k] = Math.max(weights[k], minComponent * totalBefore));
        const wSum = weights.ld + weights.bpr + weights.ifv + weights.vwmp;
        weights.ld /= wSum;
        weights.bpr /= wSum;
        weights.ifv /= wSum;
        weights.vwmp /= wSum;
        
        // ========================================
        // STEP 3: Compute Alpha Score (0-100)
        // ========================================
        const alphaRaw = (
            weights.ld * ldNorm +
            weights.bpr * bprNorm +
            weights.ifv * ifvNorm +
            weights.vwmp * vwmpNorm
        );
        
        const alpha = Math.round(Math.max(0, Math.min(100, alphaRaw * 100)));
        
        // console.log('[Alpha Debug] Calculated alpha:', 'raw=' + alphaRaw.toFixed(4), 'final=' + alpha, '| ld=' + ldNorm.toFixed(2), 'bpr=' + bprNorm.toFixed(2), 'ifv=' + ifvNorm.toFixed(2) + '(raw:' + ifvNormRaw.toFixed(2) + ')', 'vwmp=' + vwmpNorm.toFixed(2));
        
        // Store for other components
        this.alphaScore = alpha;
        
        // ========================================
        // STEP 4: Determine regime
        // ========================================
        let regime, regimeClass;
        if (alpha <= 30) {
            regime = 'BEARISH';
            regimeClass = 'bearish';
        } else if (alpha >= 70) {
            regime = 'BULLISH';
            regimeClass = 'bullish';
        } else {
            regime = 'NEUTRAL';
            regimeClass = 'neutral';
        }
        
        // ========================================
        // STEP 4.5: Gated UI update to reduce flicker
        // ========================================
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const lastAlphaDisplay = this.regimeEngine.lastAlphaDisplay;
        const lastAlphaRenderTs = this.regimeEngine.lastAlphaRenderTs || 0;
        const deltaAlphaDisplay = lastAlphaDisplay === null ? Infinity : Math.abs(alpha - lastAlphaDisplay);
        const canRender = deltaAlphaDisplay >= 1 || (now - lastAlphaRenderTs) >= alphaPreset.renderMs;
        if (!canRender) {
            return;
        }
        
        // ========================================
        // STEP 5: Update UI
        // ========================================
        
        // Check if still warming up (need 20 samples for reliable percentile normalization)
        const isWarmingUp = ldSamples.length < 20 || bprSamples.length < 20;
        
        // Main value display
        if (alphaValue) {
            if (isWarmingUp) {
                const warmupPct = Math.round(Math.min(ldSamples.length, bprSamples.length) / 20 * 100);
                alphaValue.textContent = '⏳';
                alphaValue.className = 'alpha-value neutral warming-up';
                alphaValue.title = 'Warming up: ' + warmupPct + '%';
            } else {
                alphaValue.textContent = alpha;
                alphaValue.className = 'alpha-value ' + regimeClass;
                alphaValue.title = '';
            }
        }
        
        // Update header metrics (LD Delta and Alpha Score)
        this.updateHeaderMetrics(ld.delta, alpha, regimeClass, isWarmingUp);
        
        // Gauge fill and marker
        if (alphaGaugeFill) {
            alphaGaugeFill.style.width = '100%';
        }
        if (alphaGaugeMarker) {
            alphaGaugeMarker.style.left = alpha + '%';
        }
        
        // Regime badge
        if (alphaRegime) {
            alphaRegime.textContent = regime;
            alphaRegime.className = 'alpha-badge ' + regimeClass;
        }
        
        // Component bars
        const updateCompBar = (el, norm) => {
            if (!el) return;
            const pct = Math.round(norm * 100);
            el.style.width = pct + '%';
            if (norm < 0.35) {
                el.className = 'comp-fill bearish';
            } else if (norm > 0.65) {
                el.className = 'comp-fill bullish';
            } else {
                el.className = 'comp-fill neutral';
            }
        };
        
        updateCompBar(alphaLdFill, ldNorm);
        updateCompBar(alphaBprFill, bprNorm);
        updateCompBar(alphaIfvFill, ifvNorm);
        updateCompBar(alphaVwmpFill, vwmpNorm);
        
        // Update Regime Engine with alpha score
        if (this.orderFlowPressure?.levels) {
            this.updateRegimeEngine(this.orderFlowPressure.levels, currentPrice, alpha);
        }
        
        // Interpretation text - super friendly with price levels
        if (alphaInterpretation) {
            let interpretation = '';
            const formatPrice = (p) => formatSmartPriceChart(p);
            
            // Show warmup notice if still calibrating
            if (isWarmingUp) {
                const warmupPct = Math.round(Math.min(ldSamples.length, bprSamples.length) / 20 * 100);
                interpretation = `<strong>⏳ Calibrating... (${warmupPct}%)</strong><br>`;
                interpretation += `Alpha Score is warming up. Collecting orderbook data to calibrate normalization ranges.<br>`;
                interpretation += `<span style="color:#fbbf24">Please wait ~${Math.ceil((20 - Math.min(ldSamples.length, bprSamples.length)) / 2)}s for accurate readings.</span>`;
                if (alphaInterpretation) alphaInterpretation.innerHTML = interpretation;
            } else {
            
            // Calculate average fair value for reference
            const avgFairValue = (vwmp + ifv) / 2;
            const priceDiff = currentPrice - avgFairValue;
            const priceDiffPct = ((priceDiff / avgFairValue) * 100).toFixed(1);
            
            if (alpha <= 30) {
                interpretation = `<strong>🔴 Bearish (Score: ${alpha})</strong><br>`;
                interpretation += `Price at ${formatPrice(currentPrice)} looks <em>too high</em>. `;
                interpretation += `Expect a drop toward ${formatPrice(vwmp)} (VWMP) or ${formatPrice(ifv)} (IFV). `;
                interpretation += `<br><span style="color:#ef4444">⬇️ Sellers in control — short bias.</span>`;
            } else if (alpha >= 70) {
                interpretation = `<strong>🟢 Bullish (Score: ${alpha})</strong><br>`;
                if (currentPrice < avgFairValue) {
                    interpretation += `Price at ${formatPrice(currentPrice)} is <em>discounted</em>. `;
                    interpretation += `Fair value is ${formatPrice(avgFairValue)} — that's ${Math.abs(priceDiffPct)}% higher! `;
                } else {
                    interpretation += `Strong buying pressure at ${formatPrice(currentPrice)}. `;
                    interpretation += `Buyers are aggressive — momentum is up. `;
                }
                interpretation += `<br><span style="color:#10b981">⬆️ Buyers in control — long bias.</span>`;
            } else {
                // Neutral zone - be specific about mean reversion target
                interpretation = `<strong>🟡 Neutral (Score: ${alpha})</strong><br>`;
                
                if (currentPrice > avgFairValue) {
                    const revertTarget = Math.min(vwmp, ifv);
                    interpretation += `Price ${formatPrice(currentPrice)} is ${priceDiffPct}% above fair value. `;
                    interpretation += `May pull back to ${formatPrice(revertTarget)}. `;
                } else if (currentPrice < avgFairValue) {
                    const revertTarget = Math.max(vwmp, ifv);
                    interpretation += `Price ${formatPrice(currentPrice)} is ${Math.abs(priceDiffPct)}% below fair value. `;
                    interpretation += `May bounce to ${formatPrice(revertTarget)}. `;
                } else {
                    interpretation += `Price ${formatPrice(currentPrice)} is at fair value. `;
                    interpretation += `No clear edge — wait for setup. `;
                }
                
                interpretation += `<br><span style="color:#fbbf24">↔️ Mixed signals — wait or scalp only.</span>`;
            }
            
            if (alphaInterpretation) {
                // Only update if content changed (prevents flicker)
                if (alphaInterpretation.innerHTML !== interpretation) {
                    alphaInterpretation.innerHTML = interpretation;
                }
                const newClass = 'alpha-interpretation ' + regimeClass;
                if (alphaInterpretation.className !== newClass) {
                    alphaInterpretation.className = newClass;
                }
            }
            } // end else (not warming up)
        }
        
        // Update Alpha Newbie Summary (collapsible, default hidden)
        const alphaSummary = document.getElementById('alphaNewbieSummary');
        if (alphaSummary) {
            const newbieSummary = this.generateAlphaNewbieSummary(alpha, regime, currentPrice, vwmp, ifv, bpr, ld);
            const isExpanded = localStorage.getItem('alphaNewbieSummaryExpanded') === 'true';
            const newHtml = this.formatAlphaNewbieSummary(newbieSummary, regimeClass, isExpanded);
            // Only update if content changed (prevents flicker)
            if (alphaSummary.innerHTML !== newHtml) {
                alphaSummary.innerHTML = newHtml;
            }
            alphaSummary.style.display = 'block';
            
            // Setup click handler for toggle (only once)
            if (!alphaSummary.dataset.initialized) {
                alphaSummary.dataset.initialized = 'true';
                alphaSummary.addEventListener('click', (e) => {
                    if (e.target.closest('.newbie-toggle')) {
                        const content = alphaSummary.querySelector('.newbie-content');
                        const toggle = alphaSummary.querySelector('.newbie-toggle');
                        const isCurrentlyExpanded = content.style.display !== 'none';
                        
                        content.style.display = isCurrentlyExpanded ? 'none' : 'block';
                        toggle.classList.toggle('expanded', !isCurrentlyExpanded);
                        localStorage.setItem('alphaNewbieSummaryExpanded', !isCurrentlyExpanded);
                    }
                });
            }
        }

        // Track last rendered alpha to gate future updates
        this.regimeEngine.lastAlphaDisplay = alpha;
        this.regimeEngine.lastAlphaRenderTs = now;
    }
    
    /**
     * Generate newbie-friendly summary for Alpha Score
     */
    generateAlphaNewbieSummary(alpha, regime, currentPrice, vwmp, ifv, bpr, ld) {
        const fmt = (price) => price < 10 ? '$' + price.toFixed(4) : '$' + Math.round(price).toLocaleString();
        const avgFairValue = (vwmp + ifv) / 2;
        const priceDiffPct = ((currentPrice - avgFairValue) / avgFairValue * 100).toFixed(1);
        
        if (alpha >= 70) {
            // BULLISH
            return `
🎯 WHAT'S HAPPENING:
The Alpha Score is ${alpha}/100 — that's BULLISH! Big buyers are stepping in and pushing the market up. Think of it like a tug-of-war where the buyers are winning.

⚡ WHAT TO DO:
• Look for opportunities to BUY
• Don't try to short or bet against this move
• If you're already long, hold your position
• Wait for small dips to add more

📍 KEY LEVELS:
• Current price: ${fmt(currentPrice)}
• Fair value zone: ${fmt(vwmp)} to ${fmt(ifv)}
• If price dips to ${fmt(currentPrice * 0.99)}, consider buying more
• Stop loss suggestion: ${fmt(currentPrice * 0.97)}

✅ CONFIDENCE: High — ${alpha >= 80 ? 'Very strong' : 'Strong'} bullish signal`;
        } else if (alpha <= 30) {
            // BEARISH
            return `
🆘 WHAT'S HAPPENING:
The Alpha Score is ${alpha}/100 — that's BEARISH! Sellers are in control and pushing prices down. The market is weak right now.

⚡ WHAT TO DO:
• Avoid buying — wait for the selling to stop
• Consider selling or shorting if experienced
• If you're holding, set tight stop losses
• Wait for Alpha to rise above 40 before buying

📍 KEY LEVELS:
• Current price: ${fmt(currentPrice)}
• Likely to drop toward: ${fmt(Math.min(vwmp, ifv))}
• Don't buy until price reaches: ${fmt(Math.min(vwmp, ifv) * 0.98)}
• If shorting, target: ${fmt(currentPrice * 0.97)}

⚠️ RISK: High — Don't catch falling knives`;
        } else {
            // NEUTRAL
            const isAboveFair = currentPrice > avgFairValue;
            return `
🎯 WHAT'S HAPPENING:
The Alpha Score is ${alpha}/100 — that's NEUTRAL. The market can't decide which way to go. Neither buyers nor sellers have the upper hand.

⚡ WHAT TO DO:
• Be patient — no clear trade right now
• Wait for Alpha to move above 70 (bullish) or below 30 (bearish)
• If you must trade, keep positions small
• ${isAboveFair ? 'Price is above fair value — slight bias to sell' : 'Price is below fair value — slight bias to buy'}

📍 KEY LEVELS:
• Current price: ${fmt(currentPrice)} (${priceDiffPct}% ${isAboveFair ? 'above' : 'below'} fair value)
• Fair value zone: ${fmt(vwmp)} to ${fmt(ifv)}
• Wait for breakout above: ${fmt(currentPrice * 1.02)}
• Or breakdown below: ${fmt(currentPrice * 0.98)}

⏰ PATIENCE: Wait for a clearer signal`;
        }
    }
    
    /**
     * Format Alpha newbie summary with HTML styling
     */
    formatAlphaNewbieSummary(summary, regimeClass, isExpanded = false) {
        let html = summary.trim()
            .replace(/🎯 WHAT'S HAPPENING:/g, '<div class="newbie-section"><span class="newbie-header happening">🎯 WHAT\'S HAPPENING:</span>')
            .replace(/🆘 WHAT'S HAPPENING:/g, '<div class="newbie-section"><span class="newbie-header danger">🆘 WHAT\'S HAPPENING:</span>')
            .replace(/⚡ WHAT TO DO:/g, '</div><div class="newbie-section"><span class="newbie-header action">⚡ WHAT TO DO:</span>')
            .replace(/📍 KEY LEVELS:/g, '</div><div class="newbie-section"><span class="newbie-header levels">📍 KEY LEVELS:</span>')
            .replace(/✅ CONFIDENCE:/g, '</div><div class="newbie-section"><span class="newbie-header confidence">✅ CONFIDENCE:')
            .replace(/⚠️ RISK:/g, '</div><div class="newbie-section"><span class="newbie-header warning">⚠️ RISK:')
            .replace(/⏰ PATIENCE:/g, '</div><div class="newbie-section"><span class="newbie-header patience">⏰ PATIENCE:')
            .replace(/\n• /g, '<br><span class="bullet">•</span> ')
            + '</span></div>';
        
        let containerClass = 'newbie-container ' + regimeClass;
        const displayStyle = isExpanded ? 'block' : 'none';
        const expandedClass = isExpanded ? 'expanded' : '';
        
        return `<div class="${containerClass}">
            <div class="newbie-toggle ${expandedClass}">
                <span class="toggle-icon">▶</span>
                <span class="toggle-label">Trading Guide</span>
            </div>
            <div class="newbie-content" style="display: ${displayStyle};">${html}</div>
        </div>`;
    }
    
    /**
     * Set user's selected trade position
     * @param {string|null} position - 'LONG', 'SHORT', or null to clear
     */
    setUserPosition(position) {
        this.userSelectedPosition = position;
        // Update button states
        const longBtn = document.getElementById('positionLong');
        const shortBtn = document.getElementById('positionShort');
        if (longBtn) longBtn.classList.toggle('active', position === 'LONG');
        if (shortBtn) shortBtn.classList.toggle('active', position === 'SHORT');
        // Save to localStorage
        if (position) {
            localStorage.setItem('tradeSetup_position', position);
        } else {
            localStorage.removeItem('tradeSetup_position');
        }
        // Trigger update
        this.updateFairValueIndicators();
    }
    
    /**
     * Generate trade setup recommendation with timeframe analysis and min gain filter
     */
    updateTradeSetup(currentPrice, mid, vwmp, ifv) {
        // Get DOM elements
        const tradeDirection = document.getElementById('tradeDirection');
        const tradeConfidence = document.getElementById('tradeConfidence');
        const tradeEntry = document.getElementById('tradeEntry');
        const tradeStop = document.getElementById('tradeStop');
        const tradeTarget1 = document.getElementById('tradeTarget1');
        const tradeTarget2 = document.getElementById('tradeTarget2');
        const tradeRR = document.getElementById('tradeRR');
        const tradeReasoning = document.getElementById('tradeReasoning');
        const minGainInput = document.getElementById('minGainPercent');
        const recommendedDirection = document.getElementById('recommendedDirection');
        
        if (!tradeDirection || !currentPrice) return;
        
        // Get user's selected position (LONG, SHORT, or null for auto)
        const userPosition = this.userSelectedPosition || null;
        
        // Get minimum gain threshold (default 1%)
        const minGainPercent = parseFloat(minGainInput?.value) || 1;
        
        // Get order flow indicators
        const bpr = this.orderFlowPressure?.levels ? this.calculateBPR(this.orderFlowPressure.levels) : null;
        const ld = this.orderFlowPressure?.levels ? this.calculateLiquidityDelta(this.orderFlowPressure.levels, currentPrice) : null;
        
        // Get key levels from stored data
        const levels = this.fairValueIndicators?.currentLevels || [];
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Categorize levels by timeframe (distance from current price)
        const categorizeByTimeframe = (levelsList, isSupport) => {
            return levelsList.map(l => {
                const price = parseFloat(l.price);
                const distance = Math.abs((price - currentPrice) / currentPrice) * 100;
                let timeframe = 'short';
                if (distance > 15) timeframe = 'long';
                else if (distance > 5) timeframe = 'medium';
                return { ...l, price, distance, timeframe, volume: parseFloat(l.volume) };
            });
        };
        
        // Find supports and resistances with timeframe info
        const supports = categorizeByTimeframe(
            validLevels.filter(l => l.type === 'support' && parseFloat(l.price) < currentPrice),
            true
        ).sort((a, b) => b.price - a.price);
        
        const resistances = categorizeByTimeframe(
            validLevels.filter(l => l.type === 'resistance' && parseFloat(l.price) > currentPrice),
            false
        ).sort((a, b) => a.price - b.price);
        
        // Get levels by timeframe
        const shortSupports = supports.filter(l => l.timeframe === 'short');
        const mediumSupports = supports.filter(l => l.timeframe === 'medium');
        const longSupports = supports.filter(l => l.timeframe === 'long');
        
        const shortResistances = resistances.filter(l => l.timeframe === 'short');
        const mediumResistances = resistances.filter(l => l.timeframe === 'medium');
        const longResistances = resistances.filter(l => l.timeframe === 'long');
        
        // Find strongest levels in each timeframe
        const findStrongest = (arr) => arr.reduce((s, l) => l.volume > (s?.volume || 0) ? l : s, arr[0]);
        
        const strongShortSupport = findStrongest(shortSupports);
        const strongMediumSupport = findStrongest(mediumSupports);
        const strongLongSupport = findStrongest(longSupports);
        
        const strongShortResistance = findStrongest(shortResistances);
        const strongMediumResistance = findStrongest(mediumResistances);
        const strongLongResistance = findStrongest(longResistances);
        
        // Score the setup (bullish vs bearish signals)
        let bullishScore = 0;
        let bearishScore = 0;
        let reasons = [];
        let timeframeSignals = { short: 0, medium: 0, long: 0 };
        
        // BPR scoring
        if (bpr) {
            if (bpr.ratio > 1.3) { bullishScore += 2; reasons.push('Strong buyer pressure'); }
            else if (bpr.ratio > 1.1) { bullishScore += 1; reasons.push('Buyer edge'); }
            else if (bpr.ratio < 0.77) { bearishScore += 2; reasons.push('Strong seller pressure'); }
            else if (bpr.ratio < 0.9) { bearishScore += 1; reasons.push('Seller edge'); }
        }
        
        // LD scoring
        if (ld) {
            if (ld.delta > 100) { bullishScore += 2; reasons.push('Heavy support below'); }
            else if (ld.delta > 30) { bullishScore += 1; reasons.push('Support nearby'); }
            else if (ld.delta < -100) { bearishScore += 2; reasons.push('Heavy resistance above'); }
            else if (ld.delta < -30) { bearishScore += 1; reasons.push('Resistance nearby'); }
        }
        
        // Timeframe analysis - compare support vs resistance strength in each
        if (shortSupports.length && shortResistances.length) {
            const shortSupportVol = shortSupports.reduce((s, l) => s + l.volume, 0);
            const shortResistanceVol = shortResistances.reduce((s, l) => s + l.volume, 0);
            if (shortSupportVol > shortResistanceVol * 1.2) { 
                timeframeSignals.short = 1; 
                reasons.push('Short-term support > resistance');
            } else if (shortResistanceVol > shortSupportVol * 1.2) {
                timeframeSignals.short = -1;
                reasons.push('Short-term resistance > support');
            }
        }
        
        if (mediumSupports.length && mediumResistances.length) {
            const medSupportVol = mediumSupports.reduce((s, l) => s + l.volume, 0);
            const medResistanceVol = mediumResistances.reduce((s, l) => s + l.volume, 0);
            if (medSupportVol > medResistanceVol * 1.2) {
                timeframeSignals.medium = 1;
            } else if (medResistanceVol > medSupportVol * 1.2) {
                timeframeSignals.medium = -1;
            }
        }
        
        if (longSupports.length && longResistances.length) {
            const longSupportVol = longSupports.reduce((s, l) => s + l.volume, 0);
            const longResistanceVol = longResistances.reduce((s, l) => s + l.volume, 0);
            if (longSupportVol > longResistanceVol * 1.2) {
                timeframeSignals.long = 1;
            } else if (longResistanceVol > longSupportVol * 1.2) {
                timeframeSignals.long = -1;
            }
        }
        
        // Add timeframe alignment bonus
        const tfSum = timeframeSignals.short + timeframeSignals.medium + timeframeSignals.long;
        if (tfSum >= 2) { bullishScore += 2; reasons.push('Multi-timeframe bullish'); }
        else if (tfSum === 1) { bullishScore += 1; }
        else if (tfSum <= -2) { bearishScore += 2; reasons.push('Multi-timeframe bearish'); }
        else if (tfSum === -1) { bearishScore += 1; }
        
        // Fair value scoring
        if (mid && vwmp && ifv) {
            const avgFV = (mid + vwmp + ifv) / 3;
            const priceDiff = ((currentPrice - avgFV) / avgFV) * 100;
            
            if (priceDiff < -2) { bullishScore += 2; reasons.push('Price below fair value'); }
            else if (priceDiff < -0.5) { bullishScore += 1; reasons.push('Slight discount'); }
            else if (priceDiff > 2) { bearishScore += 2; reasons.push('Price above fair value'); }
            else if (priceDiff > 0.5) { bearishScore += 1; reasons.push('Slight premium'); }
            
            if (vwmp < mid * 0.995) { bullishScore += 1; }
            else if (vwmp > mid * 1.005) { bearishScore += 1; }
        }
        
        // Determine recommended direction from analysis
        const netScore = bullishScore - bearishScore;
        let recommendedDir = 'WAIT';
        if (netScore >= 2) recommendedDir = 'LONG';
        else if (netScore <= -2) recommendedDir = 'SHORT';
        
        // Cache for alerts + external consumers
        this.tradeSetupRecommendation = recommendedDir;
        
        // Update recommendation display
        if (recommendedDirection) {
            recommendedDirection.textContent = recommendedDir;
            recommendedDirection.className = 'rec-value ' + 
                (recommendedDir === 'LONG' ? 'bullish' : recommendedDir === 'SHORT' ? 'bearish' : 'neutral');
        }
        
        // Use user's selection if provided, otherwise use recommendation
        let prelimDirection = userPosition || recommendedDir;
        const isUserOverride = userPosition && userPosition !== recommendedDir;
        
        // Calculate potential targets based on position direction
        let entry = currentPrice;
        let stop, target1, target2, potentialGainPercent;
        
        if (prelimDirection === 'LONG') {
            // Stop below nearest strong support
            stop = strongShortSupport?.price * 0.995 || currentPrice * 0.97;
            
            // Targets: use medium and long-term resistance
            target1 = strongMediumResistance?.price || strongShortResistance?.price || currentPrice * 1.03;
            target2 = strongLongResistance?.price || strongMediumResistance?.price || currentPrice * 1.08;
            
            // If short-term target doesn't meet min gain, look for medium/long term
            const shortGain = strongShortResistance ? ((strongShortResistance.price - entry) / entry) * 100 : 0;
            const medGain = strongMediumResistance ? ((strongMediumResistance.price - entry) / entry) * 100 : 0;
            const longGain = strongLongResistance ? ((strongLongResistance.price - entry) / entry) * 100 : 0;
            
            // Use the first target that meets minimum gain
            if (shortGain >= minGainPercent) {
                target1 = strongShortResistance.price;
                potentialGainPercent = shortGain;
            } else if (medGain >= minGainPercent) {
                target1 = strongMediumResistance.price;
                potentialGainPercent = medGain;
            } else if (longGain >= minGainPercent) {
                target1 = strongLongResistance.price;
                potentialGainPercent = longGain;
            } else {
                potentialGainPercent = Math.max(shortGain, medGain, longGain);
            }
            
        } else if (prelimDirection === 'SHORT') {
            stop = strongShortResistance?.price * 1.005 || currentPrice * 1.03;
            
            target1 = strongMediumSupport?.price || strongShortSupport?.price || currentPrice * 0.97;
            target2 = strongLongSupport?.price || strongMediumSupport?.price || currentPrice * 0.92;
            
            const shortGain = strongShortSupport ? ((entry - strongShortSupport.price) / entry) * 100 : 0;
            const medGain = strongMediumSupport ? ((entry - strongMediumSupport.price) / entry) * 100 : 0;
            const longGain = strongLongSupport ? ((entry - strongLongSupport.price) / entry) * 100 : 0;
            
            if (shortGain >= minGainPercent) {
                target1 = strongShortSupport.price;
                potentialGainPercent = shortGain;
            } else if (medGain >= minGainPercent) {
                target1 = strongMediumSupport.price;
                potentialGainPercent = medGain;
            } else if (longGain >= minGainPercent) {
                target1 = strongLongSupport.price;
                potentialGainPercent = longGain;
            } else {
                potentialGainPercent = Math.max(shortGain, medGain, longGain);
            }
        } else {
            stop = currentPrice * 0.97;
            target1 = currentPrice * 1.03;
            target2 = currentPrice * 1.05;
            potentialGainPercent = 0;
        }
        
        // Final direction decision based on min gain filter
        let direction = prelimDirection;
        let confidence = 'LOW';
        let directionClass = 'wait';
        let meetsMinGain = potentialGainPercent >= minGainPercent;
        
        if (direction !== 'WAIT' && !meetsMinGain) {
            // Signals are there but gain doesn't meet threshold
            direction = 'WAIT';
            reasons.unshift(`Gain ${potentialGainPercent.toFixed(1)}% < min ${minGainPercent}%`);
        }
        
        if (direction === 'LONG') {
            directionClass = 'long';
            confidence = netScore >= 4 ? 'HIGH' : 'MEDIUM';
        } else if (direction === 'SHORT') {
            directionClass = 'short';
            confidence = netScore <= -4 ? 'HIGH' : 'MEDIUM';
        } else {
            directionClass = 'wait';
            confidence = 'LOW';
        }
        
        // Calculate risk/reward
        let riskReward = '--';
        const formatPrice = (p) => formatSmartPriceChart(p);
        
        if (direction === 'LONG') {
            const risk = entry - stop;
            const reward = target1 - entry;
            riskReward = risk > 0 ? (reward / risk).toFixed(1) : '0';
        } else if (direction === 'SHORT') {
            const risk = stop - entry;
            const reward = entry - target1;
            riskReward = risk > 0 ? (reward / risk).toFixed(1) : '0';
        }
        
        // Update DOM
        if (!userPosition) {
            tradeDirection.textContent = 'SELECT';
            tradeDirection.className = 'trade-direction select';
            tradeConfidence.textContent = '--';
            tradeConfidence.className = 'trade-confidence';
            tradeEntry.textContent = '$--';
            tradeStop.textContent = '$--';
            tradeTarget1.textContent = '$--';
            tradeTarget2.textContent = '$--';
            tradeRR.textContent = '--';
        } else {
        tradeDirection.textContent = direction;
        tradeDirection.className = 'trade-direction ' + directionClass;
        
        tradeConfidence.textContent = confidence;
        tradeConfidence.className = 'trade-confidence ' + confidence.toLowerCase();
        
        tradeEntry.textContent = formatPrice(entry);
        tradeStop.textContent = formatPrice(stop);
        tradeTarget1.textContent = formatPrice(target1) + ` (${potentialGainPercent?.toFixed(1) || 0}%)`;
        tradeTarget2.textContent = formatPrice(target2);
        
        tradeRR.textContent = riskReward === '--' ? '--' : riskReward + ':1';
        }
        const rrEl = document.getElementById('tradeRR');
        if (rrEl) {
            rrEl.className = 'rr-value ' + (parseFloat(riskReward) >= 2 ? 'good' : parseFloat(riskReward) >= 1 ? 'ok' : 'bad');
        }
        
        // Build reasoning with timeframe info
        let reasoning = '';
        const tfSummary = `[TF: S${timeframeSignals.short > 0 ? '↑' : timeframeSignals.short < 0 ? '↓' : '–'} M${timeframeSignals.medium > 0 ? '↑' : timeframeSignals.medium < 0 ? '↓' : '–'} L${timeframeSignals.long > 0 ? '↑' : timeframeSignals.long < 0 ? '↓' : '–'}]`;
        
        // Check if user selected a position against the recommendation
        const userAgainstRec = isUserOverride && recommendedDir !== 'WAIT';
        const userWithRec = userPosition && userPosition === recommendedDir && recommendedDir !== 'WAIT';
        
        if (!userPosition) {
            // No position selected - prompt user
            reasoning = '👆 <strong>Select LONG or SHORT above</strong> to see trade plan. ';
            reasoning += `Suggested: <strong>${recommendedDir}</strong>. `;
                reasoning += `${tfSummary} `;
                reasoning += reasons.length > 0 ? reasons.slice(0, 2).join(', ') + '.' : '';
        } else if (direction === 'WAIT') {
            // Position selected but doesn't meet min gain
            reasoning = `⏸️ <strong>${prelimDirection} selected</strong> but gain (${potentialGainPercent?.toFixed(1)}%) below ${minGainPercent}% min. `;
            reasoning += `${tfSummary} `;
            reasoning += 'Lower min gain or wait for better entry.';
        } else if (direction === 'LONG') {
            if (userAgainstRec) {
                reasoning = `⚠️ <strong>LONG selected</strong> (against ${recommendedDir} signal). `;
                reasoning += `<em>Caution:</em> ${reasons.slice(0, 2).join(', ')}. `;
                reasoning += `${tfSummary} `;
                reasoning += `If going long anyway: entry ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
            } else if (userWithRec) {
                reasoning = `✅ <strong>LONG confirmed</strong> — aligns with analysis! `;
                reasoning += `${potentialGainPercent?.toFixed(1)}% potential. `;
                reasoning += reasons.slice(0, 2).join(' • ') + '. ';
                reasoning += `${tfSummary} `;
                reasoning += `Entry ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
            } else {
            reasoning = `🟢 <strong>LONG setup (${potentialGainPercent?.toFixed(1)}% potential).</strong> `;
            reasoning += reasons.slice(0, 3).join(' • ') + '. ';
            reasoning += `${tfSummary} `;
            reasoning += `Buy near ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
            }
        } else {
            if (userAgainstRec) {
                reasoning = `⚠️ <strong>SHORT selected</strong> (against ${recommendedDir} signal). `;
                reasoning += `<em>Caution:</em> ${reasons.slice(0, 2).join(', ')}. `;
                reasoning += `${tfSummary} `;
                reasoning += `If going short anyway: entry ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
            } else if (userWithRec) {
                reasoning = `✅ <strong>SHORT confirmed</strong> — aligns with analysis! `;
                reasoning += `${potentialGainPercent?.toFixed(1)}% potential. `;
                reasoning += reasons.slice(0, 2).join(' • ') + '. ';
                reasoning += `${tfSummary} `;
                reasoning += `Entry ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
        } else {
            reasoning = `🔴 <strong>SHORT setup (${potentialGainPercent?.toFixed(1)}% potential).</strong> `;
            reasoning += reasons.slice(0, 3).join(' • ') + '. ';
            reasoning += `${tfSummary} `;
            reasoning += `Sell near ${formatPrice(entry)}, stop ${formatPrice(stop)}.`;
            }
        }
        
        // Only update if content changed (prevents flicker)
        if (tradeReasoning.innerHTML !== reasoning) {
        tradeReasoning.innerHTML = reasoning;
        }
        
        // Draw trade setup on chart if enabled
        this.drawTradeSetupOnChart(direction, entry, stop, target1, target2);
    }
    
    /**
     * Draw trade setup levels on the chart
     */
    drawTradeSetupOnChart(direction, entry, stop, target1, target2) {
        // Check if "Show on Chart" is enabled and a position is selected
        const showTradeOnChart = document.getElementById('showTradeOnChart');
        if (!showTradeOnChart?.checked || direction === 'WAIT' || direction === 'SELECT' || !this.userSelectedPosition) {
            this.clearTradeSetupLines();
            return;
        }
        
        if (!this.candleSeries) return;
        
        // Initialize trade lines storage
        if (!this.tradeSetupLines) {
            this.tradeSetupLines = {};
            this.tradeSetupLastValues = {};
        }
        
        // Check if values have changed significantly (0.1% threshold)
        const threshold = 0.001; // 0.1%
        const lastVals = this.tradeSetupLastValues || {};
        const hasSignificantChange = (
            lastVals.direction !== direction ||
            !lastVals.entry || Math.abs((entry - lastVals.entry) / lastVals.entry) > threshold ||
            !lastVals.stop || Math.abs((stop - lastVals.stop) / lastVals.stop) > threshold ||
            !lastVals.target1 || Math.abs((target1 - lastVals.target1) / lastVals.target1) > threshold ||
            !lastVals.target2 || Math.abs((target2 - lastVals.target2) / lastVals.target2) > threshold
        );
        
        // Skip redraw if no significant change
        if (!hasSignificantChange && this.tradeSetupLines.entry) {
            return;
        }
        
        // Store current values for next comparison
        this.tradeSetupLastValues = { direction, entry, stop, target1, target2 };
        
        // Clear existing trade lines before redrawing
        this.clearTradeSetupLines();
        
        const isLong = direction === 'LONG';
        
        // Entry line (white/yellow)
        this.tradeSetupLines.entry = this.candleSeries.createPriceLine({
            price: entry,
            color: '#fbbf24',
            lineWidth: 2,
            lineStyle: 0, // solid
            axisLabelVisible: true,
            title: 'ENTRY',
            axisLabelColor: '#fbbf24',
            axisLabelTextColor: '#000'
        });
        
        // Stop loss line (red)
        this.tradeSetupLines.stop = this.candleSeries.createPriceLine({
            price: stop,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: 'STOP',
            axisLabelColor: '#ef4444',
            axisLabelTextColor: '#fff'
        });
        
        // Target 1 line (green)
        this.tradeSetupLines.target1 = this.candleSeries.createPriceLine({
            price: target1,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: 0, // solid
            axisLabelVisible: true,
            title: 'TP1',
            axisLabelColor: '#10b981',
            axisLabelTextColor: '#000'
        });
        
        // Target 2 line (lighter green, dashed)
        this.tradeSetupLines.target2 = this.candleSeries.createPriceLine({
            price: target2,
            color: '#34d399',
            lineWidth: 1,
            lineStyle: 2, // dashed
            axisLabelVisible: true,
            title: 'TP2',
            axisLabelColor: '#34d399',
            axisLabelTextColor: '#000'
        });
    }
    
    /**
     * Clear trade setup lines from chart
     */
    clearTradeSetupLines() {
        if (!this.tradeSetupLines || !this.candleSeries) return;
        
        ['entry', 'stop', 'target1', 'target2'].forEach(key => {
            if (this.tradeSetupLines[key]) {
                try {
                    this.candleSeries.removePriceLine(this.tradeSetupLines[key]);
                } catch (e) {}
                this.tradeSetupLines[key] = null;
            }
        });
    }
    
    /**
     * Clear fair value indicator lines
     */
    clearFairValueLines() {
        if (this.fairValueIndicators.midLine && this.candleSeries) {
            try {
                this.candleSeries.removePriceLine(this.fairValueIndicators.midLine);
            } catch (e) {}
            this.fairValueIndicators.midLine = null;
        }
        if (this.fairValueIndicators.ifvLine && this.candleSeries) {
            try {
                this.candleSeries.removePriceLine(this.fairValueIndicators.ifvLine);
            } catch (e) {}
            this.fairValueIndicators.ifvLine = null;
        }
        if (this.fairValueIndicators.vwmpLine && this.candleSeries) {
            try {
                this.candleSeries.removePriceLine(this.fairValueIndicators.vwmpLine);
            } catch (e) {}
            this.fairValueIndicators.vwmpLine = null;
        }
    }
    
    // ==========================================
    // ORDER FLOW PRESSURE INDICATORS
    // ==========================================
    
    /**
     * Initialize order flow pressure tracking
     */
    initOrderFlowPressure() {
        this.orderFlowPressure = {
            levels: null,
            currentPrice: null,
            obicCanvas: null,
            obicCtx: null
        };
    }
    
    /**
     * Set levels for order flow calculations
     */
    setOrderFlowLevels(levels, currentPrice, fairValueLevels = null) {
        if (!this.orderFlowPressure) {
            this.initOrderFlowPressure();
        }
        this.orderFlowPressure.levels = levels;
        this.orderFlowPressure.currentPrice = currentPrice;
        this.updateOrderFlowPressure();
        
        // Also update fair value indicators (which triggers Alpha Score and Market Consensus)
        // VWMP/IFV are computed from the FULL order book for accuracy.
        const fvLevels = (fairValueLevels && fairValueLevels.length) ? fairValueLevels : levels;
        this.fairValueIndicators.currentLevels = fvLevels;
        this.currentPrice = currentPrice;
        this.updateFairValueIndicators();
    }
    
    /**
     * Calculate Book Pressure Ratio (BPR)
     * BPR = Total Bid Volume / Total Ask Volume
     */
    calculateBPR(levels) {
        if (!levels || levels.length === 0) return { ratio: 1, bidVolume: 0, askVolume: 0 };
        
        // Filter valid levels
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        const supports = validLevels.filter(l => l.type === 'support');
        const resistances = validLevels.filter(l => l.type === 'resistance');
        
        const bidVolume = supports.reduce((sum, l) => sum + parseFloat(l.volume), 0);
        const askVolume = resistances.reduce((sum, l) => sum + parseFloat(l.volume), 0);
        
        const ratio = askVolume > 0 ? bidVolume / askVolume : 1;
        
        return { ratio, bidVolume, askVolume };
    }
    
    /**
     * Calculate Liquidity Delta (LD) with Enhanced Metrics
     * LD = Σ(Bid Volume × Weight) - Σ(Ask Volume × Weight)
     * Weight = 1 / (1 + distance%)  — closer levels matter more
     * 
     * Enhanced with:
     * - LD_VEL (Velocity): How strong is the shift from near-price orders
     * - Near vs Far breakdown for spoof detection
     */
    calculateLiquidityDelta(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return { 
                delta: 0, 
                weightedBidVolume: 0, 
                weightedAskVolume: 0,
                velocity: 0,
                nearDelta: 0,
                farDelta: 0,
                velocityType: 'neutral' // 'aggressive_near', 'spoof_far', 'mixed', 'neutral'
            };
        }
        
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        let weightedBidVolume = 0;
        let weightedAskVolume = 0;
        
        // Track near vs far liquidity separately (for velocity calculation)
        // Near = within 1% of price, Far = beyond 1%
        const NEAR_THRESHOLD = 1.0; // 1% from price
        let nearBidVolume = 0;
        let nearAskVolume = 0;
        let farBidVolume = 0;
        let farAskVolume = 0;
        
        validLevels.forEach(level => {
            const price = parseFloat(level.price);
            const volume = parseFloat(level.volume);
            const distancePercent = Math.abs((price - currentPrice) / currentPrice) * 100;
            
            // Weight decays with distance: closer = more important
            const weight = 1 / (1 + distancePercent);
            
            // Velocity weight: exponential decay for near-price emphasis
            const velocityWeight = Math.exp(-distancePercent / 2);
            
            const isNear = distancePercent <= NEAR_THRESHOLD;
            
            const isBid = (level.type === 'support') || (level.side === 'bid');
            if (isBid) {
                weightedBidVolume += volume * weight;
                if (isNear) {
                    nearBidVolume += volume * velocityWeight;
                } else {
                    farBidVolume += volume * velocityWeight * 0.3; // Discount far orders
                }
            } else {
                weightedAskVolume += volume * weight;
                if (isNear) {
                    nearAskVolume += volume * velocityWeight;
                } else {
                    farAskVolume += volume * velocityWeight * 0.3;
                }
            }
        });
        
        const delta = weightedBidVolume - weightedAskVolume;
        
        // Calculate near vs far delta
        const nearDelta = nearBidVolume - nearAskVolume;
        const farDelta = farBidVolume - farAskVolume;
        
        // LD Velocity: How much of the pressure comes from near-price orders
        // High velocity = aggressive near-price pressure (real)
        // Low velocity = pressure from far orders (spoof-likely)
        const totalNear = nearBidVolume + nearAskVolume;
        const totalFar = farBidVolume + farAskVolume;
        const totalAll = totalNear + totalFar;
        
        // Velocity = near contribution scaled by direction
        let velocity = 0;
        if (totalAll > 0) {
            const nearRatio = totalNear / totalAll;
            velocity = nearDelta * nearRatio * 2; // Scale for readability
        }
        
        // Classify velocity type
        let velocityType = 'neutral';
        const absNearDelta = Math.abs(nearDelta);
        const absFarDelta = Math.abs(farDelta);
        
        if (absNearDelta > 10 || absFarDelta > 10) { // Minimum threshold
            if (absNearDelta > absFarDelta * 1.5) {
                velocityType = 'aggressive_near'; // Real pressure, near-price
            } else if (absFarDelta > absNearDelta * 1.5) {
                velocityType = 'spoof_far'; // Likely spoof, far from price
            } else {
                velocityType = 'mixed';
            }
        }
        
        return { 
            delta, 
            weightedBidVolume, 
            weightedAskVolume,
            velocity,
            nearDelta,
            farDelta,
            velocityType,
            nearBidVolume,
            nearAskVolume,
            farBidVolume,
            farAskVolume
        };
    }
    
    /**
     * Initialize LD History tracking for divergence detection
     */
    initLDHistory() {
        if (!this.ldHistory) {
            this.ldHistory = {
                values: [],        // { time, ld, price }
                maxLength: 20,     // Keep last 20 readings
                divergence: null,  // 'bullish', 'bearish', or null
                absorption: null,  // 'absorption', 'displacement', or null
                prevPrice: null,
                prevLD: null,
                projection: []     // 3-bar forecast
            };
        }
    }
    
    /**
     * Update LD History and detect divergences/absorption
     */
    updateLDHistory(ld, currentPrice) {
        this.initLDHistory();
        
        const now = Date.now();
        const history = this.ldHistory;
        
        // Add current reading
        history.values.push({ time: now, ld: ld.delta, price: currentPrice });
        
        // Trim to max length
        if (history.values.length > history.maxLength) {
            history.values.shift();
        }
        
        // Need at least 5 readings for divergence detection
        if (history.values.length >= 5) {
            this.detectLDDivergence();
        }
        
        // Detect absorption vs displacement
        this.detectAbsorptionDisplacement(ld, currentPrice);
        
        // Calculate LD projection (3-bar forecast)
        this.calculateLDProjection(ld);
        
        // Store previous values
        history.prevPrice = currentPrice;
        history.prevLD = ld.delta;
    }
    
    /**
     * Detect LD Divergence (bullish or bearish)
     * Bullish: Price makes lower low, LD makes higher low
     * Bearish: Price makes higher high, LD makes lower high
     */
    detectLDDivergence() {
        const history = this.ldHistory;
        const values = history.values;
        
        if (values.length < 5) {
            history.divergence = null;
            return;
        }
        
        // Get recent window (last 10 values or all if less)
        const window = values.slice(-10);
        
        // Find price highs/lows
        let priceHigh = -Infinity, priceLow = Infinity;
        let ldAtPriceHigh = 0, ldAtPriceLow = 0;
        let priceHighIdx = 0, priceLowIdx = 0;
        
        window.forEach((v, i) => {
            if (v.price > priceHigh) {
                priceHigh = v.price;
                ldAtPriceHigh = v.ld;
                priceHighIdx = i;
            }
            if (v.price < priceLow) {
                priceLow = v.price;
                ldAtPriceLow = v.ld;
                priceLowIdx = i;
            }
        });
        
        // Current values
        const current = window[window.length - 1];
        const recent = window.slice(-3);
        
        // Find recent price low/high
        const recentPriceLow = Math.min(...recent.map(v => v.price));
        const recentPriceHigh = Math.max(...recent.map(v => v.price));
        const recentLDAtLow = recent.find(v => v.price === recentPriceLow)?.ld || current.ld;
        const recentLDAtHigh = recent.find(v => v.price === recentPriceHigh)?.ld || current.ld;
        
        // Bullish Divergence: Price making lower low, LD making higher low
        const priceThreshold = 0.002; // 0.2% price change threshold
        const ldThreshold = 5; // 5 BTC LD threshold
        
        if (recentPriceLow < priceLow * (1 - priceThreshold) && 
            recentLDAtLow > ldAtPriceLow + ldThreshold) {
            history.divergence = 'bullish';
            return;
        }
        
        // Bearish Divergence: Price making higher high, LD making lower high
        if (recentPriceHigh > priceHigh * (1 + priceThreshold) && 
            recentLDAtHigh < ldAtPriceHigh - ldThreshold) {
            history.divergence = 'bearish';
            return;
        }
        
        // Check for simple divergence in recent readings
        if (values.length >= 3) {
            const prev = values[values.length - 3];
            const curr = current;
            
            // Simple bullish: price down but LD up
            if (curr.price < prev.price * 0.998 && curr.ld > prev.ld + ldThreshold) {
                history.divergence = 'bullish';
                return;
            }
            
            // Simple bearish: price up but LD down
            if (curr.price > prev.price * 1.002 && curr.ld < prev.ld - ldThreshold) {
                history.divergence = 'bearish';
                return;
            }
        }
        
        history.divergence = null;
    }
    
    /**
     * Detect Absorption vs Displacement
     * Absorption: LD positive but price not moving up (hidden selling absorbing bids)
     * Displacement: LD positive AND price moves up (real buying pressure)
     */
    detectAbsorptionDisplacement(ld, currentPrice) {
        const history = this.ldHistory;
        
        if (history.prevPrice === null || history.prevLD === null) {
            history.absorption = null;
            return;
        }
        
        const priceChange = (currentPrice - history.prevPrice) / history.prevPrice;
        const ldChange = ld.delta - history.prevLD;
        
        // Thresholds
        const priceThreshold = 0.001; // 0.1% price change
        const ldThreshold = 10; // 10 BTC LD threshold
        
        // Bullish scenarios
        if (ld.delta > ldThreshold) {
            if (priceChange > priceThreshold) {
                // LD positive + price up = Displacement (real buying)
                history.absorption = 'displacement_up';
            } else if (priceChange < -priceThreshold) {
                // LD positive + price down = Absorption (hidden selling)
                history.absorption = 'absorption_sell';
            } else {
                // LD positive + price flat = Absorption (makers absorbing)
                history.absorption = 'absorption_neutral';
            }
        }
        // Bearish scenarios
        else if (ld.delta < -ldThreshold) {
            if (priceChange < -priceThreshold) {
                // LD negative + price down = Displacement (real selling)
                history.absorption = 'displacement_down';
            } else if (priceChange > priceThreshold) {
                // LD negative + price up = Absorption (hidden buying)
                history.absorption = 'absorption_buy';
            } else {
                // LD negative + price flat = Absorption (makers absorbing)
                history.absorption = 'absorption_neutral';
            }
        }
        else {
            history.absorption = null;
        }
    }
    
    /**
     * Calculate LD Projection (3-bar forecast)
     * Uses exponential smoothing of LD_ROC + BPR trend
     */
    calculateLDProjection(ld) {
        const history = this.ldHistory;
        const values = history.values;
        
        if (values.length < 3) {
            history.projection = [ld.delta, ld.delta, ld.delta];
            return;
        }
        
        // Calculate recent LD velocity (rate of change)
        const recent = values.slice(-5);
        let ldRocSum = 0;
        for (let i = 1; i < recent.length; i++) {
            ldRocSum += recent[i].ld - recent[i-1].ld;
        }
        const avgLdRoc = ldRocSum / (recent.length - 1);
        
        // Apply exponential decay to projection
        const decay = 0.7; // Decay factor
        const proj1 = ld.delta + avgLdRoc * decay;
        const proj2 = proj1 + avgLdRoc * decay * decay;
        const proj3 = proj2 + avgLdRoc * decay * decay * decay;
        
        history.projection = [
            Math.round(proj1 * 10) / 10,
            Math.round(proj2 * 10) / 10,
            Math.round(proj3 * 10) / 10
        ];
    }
    
    /**
     * Get LD Intelligence summary
     */
    getLDIntelligence() {
        this.initLDHistory();
        return {
            divergence: this.ldHistory.divergence,
            absorption: this.ldHistory.absorption,
            projection: this.ldHistory.projection,
            mmModel: this.ldHistory.mmModel,
            alerts: this.ldHistory.alerts,
            pressureMap: this.ldHistory.pressureMap,
            clusterStrength: this.ldHistory.clusterStrength,
            footprint: this.ldHistory.footprint
        };
    }
    
    // ==========================================
    // MARKET CONSENSUS SIGNAL (MCS)
    // Combines MM, Swing, HTF into unified signal
    // ==========================================
    
    /**
     * Calculate MM_BIAS (Market Maker / Microstructure) score
     * Range: -100 to +100
     */
    calculateMMBias(ld, bpr, ldRoc, pressBelow, pressAbove) {
        // 2.1 LD core score (-60 to +60)
        const absLD = Math.abs(ld?.delta || 0);
        let ldScore = 0;
        if (absLD >= 60) ldScore = Math.sign(ld.delta) * 60;
        else if (absLD >= 30) ldScore = Math.sign(ld.delta) * 40;
        else if (absLD >= 10) ldScore = Math.sign(ld.delta) * 20;
        
        // 2.2 BPR score (-25 to +25)
        let bprScore = 0;
        const bprRatio = bpr?.ratio || 1;
        if (bprRatio >= 1.40) bprScore = 25;
        else if (bprRatio >= 1.20) bprScore = 15;
        else if (bprRatio > 0.90) bprScore = 5;
        else if (bprRatio > 0.70) bprScore = -15;
        else bprScore = -25;
        
        // 2.3 LD_ROC score (-15 to +15)
        const absROC = Math.abs(ldRoc || 0);
        let rocScore = 0;
        if (absROC >= 15) rocScore = Math.sign(ldRoc) * 15;
        else if (absROC >= 5) rocScore = Math.sign(ldRoc) * 7;
        
        // 2.4 Cluster/Velocity adjustment (-15 to +15)
        const ldClu = ld?.ldCluster || this.ldHistory?.clusterStrength?.ldCluster || 0;
        const ldVel = ld?.velocity || 0;
        let clAdj = 0;
        
        if (ld?.delta * ldClu > 0 && Math.abs(ldClu) > 500) {
            clAdj += Math.sign(ld.delta) * 10; // cluster-backed
        }
        if (ld?.delta * ldVel > 0 && Math.abs(ldVel) > 10) {
            clAdj += Math.sign(ld.delta) * 5; // near-price
        }
        if (ld?.delta * ldClu < 0 && Math.abs(ldClu) > 500) {
            clAdj -= Math.sign(ld.delta) * 10; // opposite cluster = spoof risk
        }
        if (ld?.delta * ldVel < 0 && Math.abs(ldVel) > 10) {
            clAdj -= Math.sign(ld.delta) * 5;
        }
        
        // 2.5 Pressure map adjustment (-10 to +10)
        const pressDiff = (pressBelow || 50) - (pressAbove || 50);
        let pScore = 0;
        if (Math.abs(pressDiff) >= 8) pScore = Math.sign(pressDiff) * 10;
        else if (Math.abs(pressDiff) >= 3) pScore = Math.sign(pressDiff) * 5;
        
        // 2.6 Combine & clamp
        const mmRaw = ldScore + bprScore + rocScore + clAdj + pScore;
        return Math.max(-100, Math.min(100, mmRaw));
    }
    
    /**
     * Calculate SWING_BIAS (Short-term trend) score
     * Range: -100 to +100
     */
    calculateSwingBias(alpha, vwmpExt, ifvExt, currentPrice, breakoutLevel, breakdownLevel) {
        // 3.1 Alpha core score (-60 to +60)
        const alphaDev = (alpha || 50) - 50;
        let alphaScore = 0;
        if (Math.abs(alphaDev) >= 15) alphaScore = Math.sign(alphaDev) * 60;
        else if (Math.abs(alphaDev) >= 5) alphaScore = Math.sign(alphaDev) * 25;
        
        // 3.2 Stretch vs fair value (-25 to +25)
        const ifvExtPct = (ifvExt || 0) * 100; // Convert to percentage
        let fvScore = 0;
        if (ifvExtPct > 12) fvScore = -25;
        else if (ifvExtPct > 6) fvScore = -15;
        else if (ifvExtPct > 2) fvScore = -5;
        else if (ifvExtPct > -2) fvScore = 0;
        else if (ifvExtPct > -6) fvScore = 10;
        else fvScore = 25;
        
        // VWMP tweak
        const vwmpExtPct = (vwmpExt || 0) * 100;
        if (vwmpExtPct > 2) fvScore -= 5;
        if (vwmpExtPct < -2) fvScore += 5;
        fvScore = Math.max(-25, Math.min(25, fvScore));
        
        // 3.3 Structure/breakout score (-20 to +20)
        let structScore = 0;
        if (breakoutLevel && breakdownLevel && currentPrice) {
            const distUp = ((breakoutLevel - currentPrice) / currentPrice) * 100;
            const distDown = ((currentPrice - breakdownLevel) / currentPrice) * 100;
            
            if (distUp < 0) structScore = 20; // Already above breakout
            else if (distUp < 1.0) structScore = 10;
            else if (distDown < 0) structScore = -20; // Already below breakdown
            else if (distDown < 1.0) structScore = -10;
        }
        
        // 3.4 Combine
        const swingRaw = alphaScore + fvScore + structScore;
        return Math.max(-100, Math.min(100, swingRaw));
    }
    
    /**
     * Calculate HTF_BIAS (Higher Timeframe / Structural) score
     * Range: -100 to +100
     */
    calculateHTFBias(regime, ifvExt, ld, bpr) {
        // 4.1 Regime baseline (-60 to +60)
        let regScore = 0;
        const regimeLower = (regime || '').toLowerCase();
        
        if (regimeLower.includes('uptrend')) regScore = 50;
        else if (regimeLower.includes('downtrend')) regScore = -50;
        else if (regimeLower.includes('expansion') && regimeLower.includes('up')) regScore = 60;
        else if (regimeLower.includes('expansion') && regimeLower.includes('down')) regScore = -60;
        else if (regimeLower.includes('mean') || regimeLower.includes('reversion')) regScore = 0;
        else if (regimeLower.includes('compression')) regScore = 0;
        else if (regimeLower.includes('accumulation')) regScore = 20;
        else if (regimeLower.includes('distribution')) regScore = -20;
        else if (regimeLower.includes('vacuum') && regimeLower.includes('down')) regScore = -40;
        else if (regimeLower.includes('vacuum') && regimeLower.includes('up')) regScore = 40;
        
        // 4.2 HTF stretch (-30 to +30)
        const ifvExtPct = (ifvExt || 0) * 100;
        let stretchScore = 0;
        if (ifvExtPct > 15) stretchScore = -30;
        else if (ifvExtPct > 8) stretchScore = -20;
        else if (ifvExtPct > 3) stretchScore = -10;
        else if (ifvExtPct > -3) stretchScore = 0;
        else if (ifvExtPct > -8) stretchScore = 15;
        else stretchScore = 30;
        
        // 4.3 HTF flow tweak (-10 to +10)
        let htfFlowScore = 0;
        const ldVal = ld?.delta || 0;
        const bprVal = bpr?.ratio || 1;
        if (ldVal > 0 && bprVal > 1.2) htfFlowScore = 10;
        else if (ldVal < 0 && bprVal < 0.85) htfFlowScore = -10;
        
        // 4.4 Combine
        const htfRaw = regScore + stretchScore + htfFlowScore;
        return Math.max(-100, Math.min(100, htfRaw));
    }
    
    /**
     * Initialize MCS Mode settings
     */
    initMCSMode() {
        if (!this.mcsMode) {
            this.mcsMode = localStorage.getItem('mcsMode') || 'conservative';
        }
    }
    
    /**
     * Set MCS Mode
     */
    setMCSMode(mode) {
        this.mcsMode = mode;
        localStorage.setItem('mcsMode', mode);
        
        // Recalculate with new mode
        if (this.marketConsensus) {
            const currentPrice = this.currentPrice || this.lastCandle?.close;
            if (currentPrice) {
                const fv = this.getFairValuePrices();
                this.updateMarketConsensus(currentPrice, fv.vwmp, fv.ifv);
            }
        }
    }
    
    /**
     * Get MCS Mode weights
     */
    getMCSWeights() {
        this.initMCSMode();
        
        switch (this.mcsMode) {
            case 'aggressive':
                // Heavy weight on MM (microstructure) for scalping
                return { mm: 0.55, swing: 0.30, htf: 0.15 };
            case 'conservative':
                // Equal weight, require alignment
                return { mm: 0.33, swing: 0.33, htf: 0.34 };
            case 'balanced':
            default:
                return { mm: 0.40, swing: 0.35, htf: 0.25 };
        }
    }
    
    /**
     * Calculate Market Consensus Signal (MCS)
     * Weights depend on mode
     */
    calculateMarketConsensus(mmBias, swingBias, htfBias) {
        const weights = this.getMCSWeights();
        const mcs = (weights.mm * mmBias) + (weights.swing * swingBias) + (weights.htf * htfBias);
        return Math.max(-100, Math.min(100, Math.round(mcs)));
    }
    
    /**
     * Calculate Consensus Confidence (0-100%)
     * Based on alignment between MM, Swing, HTF
     */
    calculateConsensusConfidence(mmBias, swingBias, htfBias) {
        // Calculate standard deviation of the three biases
        const values = [mmBias, swingBias, htfBias];
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        const stdDev = Math.sqrt(variance);
        
        // alignment = 1 - (stdDev / 100), then scale to 0-100
        // Higher stdDev = lower confidence
        const alignment = 1 - (stdDev / 100);
        const confidence = Math.max(0, Math.min(100, Math.round(alignment * 100)));
        
        return {
            confidence,
            stdDev: stdDev.toFixed(1),
            level: confidence >= 70 ? 'HIGH' : confidence >= 40 ? 'MEDIUM' : 'LOW'
        };
    }
    
    /**
     * Get directional dots for each timeframe with strength and disagreement reasoning
     */
    getDirectionalDots(mmBias, swingBias, htfBias) {
        const getDot = (bias) => ({
            color: bias >= 10 ? 'bullish' : bias <= -10 ? 'bearish' : 'neutral',
            icon: bias >= 10 ? '🟢' : bias <= -10 ? '🔴' : '🟡',
            strength: Math.abs(bias), // 0-100
            value: bias
        });
        
        const mm = getDot(mmBias);
        const swing = getDot(swingBias);
        const htf = getDot(htfBias);
        
        // Count alignment
        const bullCount = [mm, swing, htf].filter(d => d.color === 'bullish').length;
        const bearCount = [mm, swing, htf].filter(d => d.color === 'bearish').length;
        
        let alignment, tradeability;
        if (bullCount === 3 || bearCount === 3) {
            alignment = 'ALIGNED';
            tradeability = 'Strong Setup';
        } else if (bullCount === 2 || bearCount === 2) {
            alignment = 'SPLIT';
            tradeability = 'Scalps Only';
        } else {
            alignment = 'FRACTURED';
            tradeability = 'No Trade';
        }
        
        // Generate "Why They Disagree" explanation
        let disagreeReason = '';
        if (alignment !== 'ALIGNED') {
            disagreeReason = this.generateDisagreeReason(mm, swing, htf, mmBias, swingBias, htfBias);
        }
        
        return { mm, swing, htf, bullCount, bearCount, alignment, tradeability, disagreeReason };
    }
    
    /**
     * Generate human-readable explanation for why timeframes disagree
     */
    generateDisagreeReason(mm, swing, htf, mmBias, swingBias, htfBias) {
        const mc = this.marketConsensus || {};
        const biases = [
            { name: 'MM', color: mm.color, value: mmBias, strength: mm.strength },
            { name: 'Swing', color: swing.color, value: swingBias, strength: swing.strength },
            { name: 'HTF', color: htf.color, value: htfBias, strength: htf.strength }
        ];
        
        // Find the outlier (the one that disagrees)
        const bullish = biases.filter(b => b.color === 'bullish');
        const bearish = biases.filter(b => b.color === 'bearish');
        const neutral = biases.filter(b => b.color === 'neutral');
        
        // Determine majority and outlier
        let majority, outliers;
        if (bullish.length >= 2) {
            majority = 'bullish';
            outliers = [...bearish, ...neutral];
        } else if (bearish.length >= 2) {
            majority = 'bearish';
            outliers = [...bullish, ...neutral];
        } else {
            majority = 'mixed';
            outliers = biases;
        }
        
        if (outliers.length === 0) return '';
        
        // Build reason based on the outlier
        const reasons = [];
        
        // MM-specific reasons
        if (mm.color !== majority && mm.color !== 'neutral') {
            if (mm.color === 'bullish') {
                reasons.push(`MM sees strong order flow (LD ${mc.ld >= 0 ? '+' : ''}${(mc.ld || 0).toFixed(0)} ${this.symbol})`);
            } else {
                reasons.push(`MM sees sell pressure (LD ${(mc.ld || 0).toFixed(0)} ${this.symbol})`);
            }
        }
        
        // Swing-specific reasons  
        if (swing.color !== majority && swing.color !== 'neutral') {
            const stretch = Math.abs(mc.ifvExt || 0).toFixed(1);
            if (swing.color === 'bearish') {
                reasons.push(`Swing is short due to ${stretch}% fair value stretch`);
            } else {
                reasons.push(`Swing sees value at current levels`);
            }
        } else if (swing.color === 'neutral' && majority !== 'neutral') {
            reasons.push(`Swing is neutral (Alpha ${mc.alpha || 50})`);
        }
        
        // HTF-specific reasons
        if (htf.color !== majority && htf.color !== 'neutral') {
            const regime = (mc.regime || 'unknown').replace(/_/g, ' ');
            if (htf.color === 'bearish') {
                reasons.push(`HTF shows ${regime} regime`);
            } else {
                reasons.push(`HTF supports via ${regime}`);
            }
        }
        
        // Combine into readable sentence
        if (reasons.length === 0) {
            return 'Mixed signals across timeframes.';
        }
        
        // Find the dominant bullish/bearish TF
        const dominant = biases.sort((a, b) => b.strength - a.strength)[0];
        const dominantDir = dominant.value >= 0 ? 'bullish' : 'bearish';
        
        // Find the opposing TF
        const opposing = biases.find(b => b.color !== dominant.color && b.color !== 'neutral');
        
        if (dominant && opposing) {
            const domLabel = dominant.value >= 0 ? 'bullish' : 'bearish';
            const oppLabel = opposing.value >= 0 ? 'bullish' : 'bearish';
            return `${dominant.name} is ${domLabel}, but ${opposing.name} is ${oppLabel}${reasons.length > 0 ? ' — ' + reasons[0] : ''}.`;
        }
        
        return reasons.join('; ') + '.';
    }
    
    /**
     * Render a single strength bar for the directional meter
     */
    renderStrengthBar(label, bias, dot) {
        const strength = Math.min(100, Math.abs(bias));
        const isPositive = bias >= 0;
        const colorClass = dot.color;
        
        // Create 10 segments for the bar
        const segments = 10;
        const filledSegments = Math.round((strength / 100) * segments);
        
        let barHTML = '';
        for (let i = 0; i < segments; i++) {
            const isFilled = i < filledSegments;
            barHTML += `<span class="strength-segment ${isFilled ? 'filled ' + colorClass : 'empty'}"></span>`;
        }
        
        const sign = bias >= 0 ? '+' : '';
        
        return `
            <div class="strength-bar-row">
                <span class="strength-label">${label}</span>
                <div class="strength-bar-track">${barHTML}</div>
                <span class="strength-value ${colorClass}">(${sign}${bias})</span>
            </div>
        `;
    }
    
    /**
     * Calculate quant summary data
     */
    calculateQuantSummary(mc) {
        // Net flow bias (sum of aligned biases)
        const longPressure = (mc.mmBias > 0 ? mc.mmBias : 0) + (mc.swingBias > 0 ? mc.swingBias : 0) + (mc.htfBias > 0 ? mc.htfBias : 0);
        const shortPressure = Math.abs((mc.mmBias < 0 ? mc.mmBias : 0) + (mc.swingBias < 0 ? mc.swingBias : 0) + (mc.htfBias < 0 ? mc.htfBias : 0));
        const netFlowBias = longPressure - shortPressure;
        
        // Fair value deviation (use IFV as primary)
        const fvDeviation = mc.ifvExt;
        const reversionRisk = Math.abs(fvDeviation) > 10 ? 'HIGH' : Math.abs(fvDeviation) > 5 ? 'MEDIUM' : 'LOW';
        
        // Breakout delta
        const currentPrice = this.currentPrice || this.lastCandle?.close || 0;
        const breakoutUp = currentPrice > 0 ? ((mc.breakoutLevel - currentPrice) / currentPrice * 100) : 0;
        const breakoutDown = currentPrice > 0 ? ((currentPrice - mc.breakdownLevel) / currentPrice * 100) : 0;
        
        return {
            longPressure,
            shortPressure,
            netFlowBias,
            fvDeviation,
            reversionRisk,
            breakoutUp: breakoutUp.toFixed(1),
            breakoutDown: breakoutDown.toFixed(1),
            currentPrice
        };
    }
    
    /**
     * Get MCS Label from score with mode consideration
     */
    getMCSLabel(mcs, confidence) {
        this.initMCSMode();
        
        // In conservative mode, require higher confidence for strong signals
        const confThreshold = this.mcsMode === 'conservative' ? 50 : 30;
        const weakenSignal = confidence && confidence.confidence < confThreshold;
        
        if (mcs >= 70) {
            return { label: weakenSignal ? 'BUY (Low Conf)' : 'STRONG BUY', color: 'strong-bullish', icon: '🟢' };
        }
        if (mcs >= 40) {
            return { label: 'BUY', color: 'bullish', icon: '🟢' };
        }
        if (mcs > -40) {
            return { label: 'WAIT / NEUTRAL', color: 'neutral', icon: '🟡' };
        }
        if (mcs > -70) {
            return { label: 'SELL', color: 'bearish', icon: '🔴' };
        }
        return { label: weakenSignal ? 'SELL (Low Conf)' : 'STRONG SELL', color: 'strong-bearish', icon: '🔴' };
    }
    
    /**
     * Get bias label from score
     */
    getBiasLabel(score) {
        if (score >= 50) return 'Strong Long';
        if (score >= 20) return 'Long';
        if (score > -20) return 'Neutral';
        if (score > -50) return 'Short';
        return 'Strong Short';
    }
    
    /**
     * Update Market Consensus Signal UI
     */
    updateMarketConsensus(currentPrice, vwmp, ifv) {
        // Get all needed data
        const levels = this.orderFlowPressure?.levels || [];
        const bpr = levels.length > 0 ? this.calculateBPR(levels) : { ratio: 1, bidVolume: 0, askVolume: 0 };
        const ld = levels.length > 0 ? this.calculateLiquidityDelta(levels, currentPrice) : { delta: 0, velocity: 0 };
        const intel = this.getLDIntelligence();
        const pressureMap = intel.pressureMap || { bands: [] };
        
        // Calculate pressure percentages
        let pressBelow = 50, pressAbove = 50;
        if (pressureMap.bands && pressureMap.bands.length > 0) {
            const belowBands = pressureMap.bands.filter(b => b.position === 'below');
            const aboveBands = pressureMap.bands.filter(b => b.position === 'above');
            const totalBelow = belowBands.reduce((sum, b) => sum + b.bidVolume, 0);
            const totalAbove = aboveBands.reduce((sum, b) => sum + b.askVolume, 0);
            const total = totalBelow + totalAbove || 1;
            pressBelow = (totalBelow / total) * 100;
            pressAbove = (totalAbove / total) * 100;
        }
        
        // Get regime and alpha
        const regime = this.regimeEngine?.currentRegime?.type || 'neutral';
        const alpha = this.alphaScore || 50;
        
        // Get signals
        const signals = this.regimeEngine?.signals || {};
        const ldRoc = signals.ld_roc || 0;
        const vwmpExt = signals.vwmp_ext || 0;
        const ifvExt = signals.ifv_ext || 0;
        
        // Calculate breakout/breakdown levels (from price forecast)
        const breakoutLevel = currentPrice * 1.02; // Simplified - could use actual levels
        const breakdownLevel = currentPrice * 0.98;
        
        // Get near support/resistance from LD
        const nearSupport = intel.pressureMap?.strongestBid ? 
            currentPrice * (1 - intel.pressureMap.strongestBid.distancePercent / 100) : currentPrice * 0.97;
        const nearResist = intel.pressureMap?.strongestAsk ? 
            currentPrice * (1 + intel.pressureMap.strongestAsk.distancePercent / 100) : currentPrice * 1.03;
        
        // Calculate biases
        const mmBias = this.calculateMMBias(ld, bpr, ldRoc, pressBelow, pressAbove);
        const swingBias = this.calculateSwingBias(alpha, vwmpExt, ifvExt, currentPrice, breakoutLevel, breakdownLevel);
        const htfBias = this.calculateHTFBias(regime, ifvExt, ld, bpr);
        
        // Calculate confidence based on alignment
        const confidence = this.calculateConsensusConfidence(mmBias, swingBias, htfBias);
        
        // Calculate consensus with mode weights
        const mcs = this.calculateMarketConsensus(mmBias, swingBias, htfBias);
        const mcsInfo = this.getMCSLabel(mcs, confidence);
        
        // Get directional dots
        const dots = this.getDirectionalDots(mmBias, swingBias, htfBias);
        
        // Store for other components
        this.marketConsensus = {
            mcs, mmBias, swingBias, htfBias,
            mcsInfo,
            confidence,
            dots,
            mode: this.mcsMode || 'conservative',
            ld: ld.delta,
            bpr: bpr.ratio,
            alpha,
            vwmpExt: vwmpExt * 100,
            ifvExt: ifvExt * 100,
            nearSupport,
            nearResist,
            breakoutLevel,
            breakdownLevel,
            regime,
            pressBelow,
            pressAbove,
            ldVel: ld.velocity,
            ldClu: intel.clusterStrength?.ldCluster || 0,
            vwmp,
            ifv
        };
        
        // Calculate quant summary
        this.marketConsensus.quant = this.calculateQuantSummary(this.marketConsensus);
        
        // Update UI
        this.renderMarketConsensusUI();
    }
    
    /**
     * Render Market Consensus UI
     */
    renderMarketConsensusUI() {
        const mc = this.marketConsensus;
        if (!mc) return;
        
        const panel = document.getElementById('mcsPanel');
        if (!panel) return;
        
        const fmt = (price) => price < 10 ? price.toFixed(4) : '$' + price.toLocaleString(undefined, {maximumFractionDigits: 2});
        const fmtK = (price) => price >= 1000 ? (price/1000).toFixed(0) + 'k' : price.toFixed(0);
        const fmtPct = (pct) => (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        const fmtBias = (score) => (score >= 0 ? '+' : '') + score;
        
        // Stripe: shows MM / Swing / HTF bias colors (must match header stripe)
        const stripeEl = document.getElementById('mcsStripe');
        if (stripeEl) {
            const getStripeColor = (bias) => bias >= 10 ? 'bullish' : bias <= -10 ? 'bearish' : 'neutral';
            stripeEl.innerHTML = `
                <div class="stripe-segment ${getStripeColor(mc.mmBias)}" title="MM: ${fmtBias(mc.mmBias)}"></div>
                <div class="stripe-segment ${getStripeColor(mc.swingBias)}" title="Swing: ${fmtBias(mc.swingBias)}"></div>
                <div class="stripe-segment ${getStripeColor(mc.htfBias)}" title="HTF: ${fmtBias(mc.htfBias)}"></div>
            `;
        }
        
        // Header with confidence & dots
        const headerEl = document.getElementById('mcsHeader');
        if (headerEl) {
            const dots = mc.dots;
            const conf = mc.confidence;
            const confClass = conf.level === 'HIGH' ? 'high' : conf.level === 'MEDIUM' ? 'medium' : 'low';
            
            headerEl.innerHTML = `
                <div class="mcs-main-signal ${mc.mcsInfo.color}">
                    <span class="mcs-icon">${mc.mcsInfo.icon}</span>
                    <span class="mcs-label">${mc.mcsInfo.label}</span>
                    <span class="mcs-score">(${mc.mcs}/100)</span>
                    <span class="mcs-confidence ${confClass}" title="Confidence: ${conf.confidence}% (StdDev: ${conf.stdDev})">
                        <span class="conf-value">${conf.confidence}%</span>
                        <span class="conf-label">${conf.level}</span>
                    </span>
                </div>
                <div class="mcs-alignment">
                    <div class="mcs-dots" title="${dots.alignment}: ${dots.tradeability}">
                        <span class="mcs-dot ${dots.mm.color}" title="MM">${dots.mm.icon}</span>
                        <span class="mcs-dot ${dots.swing.color}" title="Swing">${dots.swing.icon}</span>
                        <span class="mcs-dot ${dots.htf.color}" title="HTF">${dots.htf.icon}</span>
                    </div>
                    <span class="mcs-alignment-label ${dots.alignment.toLowerCase()}">${dots.alignment}</span>
                </div>
                
                <!-- Directional Strength Meter -->
                <div class="mcs-strength-meter">
                    ${this.renderStrengthBar('MM', mc.mmBias, dots.mm)}
                    ${this.renderStrengthBar('Swing', mc.swingBias, dots.swing)}
                    ${this.renderStrengthBar('HTF', mc.htfBias, dots.htf)}
                </div>
                
                <!-- Why They Disagree (only shown when SPLIT or FRACTURED) -->
                ${dots.disagreeReason ? `
                <div class="mcs-disagree-reason">
                    <span class="disagree-icon">💡</span>
                    <span class="disagree-text">${dots.disagreeReason}</span>
                </div>
                ` : ''}
            `;
        }
        
        // Quant Summary (Enhancement #3)
        const quantEl = document.getElementById('mcsQuant');
        if (quantEl && mc.quant) {
            const q = mc.quant;
            const netDir = q.netFlowBias >= 0 ? 'Long' : 'Short';
            const netClass = q.netFlowBias >= 0 ? 'bullish' : 'bearish';
            const revClass = q.reversionRisk === 'HIGH' ? 'high-risk' : q.reversionRisk === 'MEDIUM' ? 'med-risk' : 'low-risk';
            
            quantEl.innerHTML = `
                <div class="quant-row">
                    <span class="quant-label">Bias:</span>
                    <span class="quant-value">
                        <span class="bullish">Long (${q.longPressure > 0 ? '+' : ''}${q.longPressure})</span> vs 
                        <span class="bearish">Short (${q.shortPressure > 0 ? '-' : ''}${q.shortPressure})</span> → 
                        <strong class="${netClass}">Net ${q.netFlowBias >= 0 ? '+' : ''}${q.netFlowBias} ${netDir}</strong>
                    </span>
                </div>
                <div class="quant-row">
                    <span class="quant-label">Stretch:</span>
                    <span class="quant-value">
                        <strong>${fmtPct(q.fvDeviation)}</strong> vs IFV → 
                        <span class="quant-risk ${revClass}">${q.reversionRisk} Reversion Risk</span>
                    </span>
                </div>
                <div class="quant-row">
                    <span class="quant-label">Breakout Δ:</span>
                    <span class="quant-value">
                        <span class="bullish">↑ ${q.breakoutUp}%</span> to ${fmtK(mc.breakoutLevel)} · 
                        <span class="bearish">↓ ${q.breakoutDown}%</span> to ${fmtK(mc.breakdownLevel)}
                    </span>
                </div>
                <div class="quant-row">
                    <span class="quant-label">Range:</span>
                    <span class="quant-value">
                        <span class="support-price">${fmtK(mc.breakdownLevel)}</span> → 
                        <span class="resist-price">${fmtK(mc.breakoutLevel)}</span> until breakout
                    </span>
                </div>
            `;
        }
        
        // MM Row
        const mmRowEl = document.getElementById('mcsMM');
        if (mmRowEl) {
            const mmLabel = this.getBiasLabel(mc.mmBias);
            mmRowEl.innerHTML = `
                <div class="mcs-row-header">
                    <span class="mcs-row-title">⚡ MM (Microstructure)</span>
                    <span class="mcs-row-bias ${mc.mmBias >= 0 ? 'bullish' : 'bearish'}">${mmLabel}</span>
                </div>
                <div class="mcs-row-details">
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Order Flow:</span>
                        <span class="mcs-detail-value">LD <strong class="${mc.ld >= 0 ? 'bullish' : 'bearish'}">${mc.ld >= 0 ? '+' : ''}${mc.ld.toFixed(1)} ${this.symbol}</strong>, BPR <strong>${mc.bpr.toFixed(2)}</strong> (${mc.pressBelow.toFixed(0)}% bids)</span>
                    </div>
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Near Levels:</span>
                        <span class="mcs-detail-value">Support <span class="support-price">${fmt(mc.nearSupport)}</span>, Resist <span class="resist-price">${fmt(mc.nearResist)}</span></span>
                    </div>
                </div>
            `;
        }
        
        // Swing Row
        const swingRowEl = document.getElementById('mcsSwing');
        if (swingRowEl) {
            const swingLabel = this.getBiasLabel(mc.swingBias);
            const stretchPct = mc.ifvExt;
            swingRowEl.innerHTML = `
                <div class="mcs-row-header">
                    <span class="mcs-row-title">📊 Swing (Short-term)</span>
                    <span class="mcs-row-bias ${mc.swingBias >= 0 ? 'bullish' : 'bearish'}">${swingLabel}</span>
                </div>
                <div class="mcs-row-details">
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Alpha:</span>
                        <span class="mcs-detail-value"><strong>${mc.alpha}</strong>/100 (${mc.alpha > 60 ? 'Bullish' : mc.alpha < 40 ? 'Bearish' : 'Neutral'}), price <strong class="${stretchPct > 0 ? 'bearish' : 'bullish'}">${fmtPct(stretchPct)}</strong> vs fair value</span>
                    </div>
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Triggers:</span>
                        <span class="mcs-detail-value">Long above <span class="bullish">${fmt(mc.breakoutLevel)}</span> · Short below <span class="bearish">${fmt(mc.breakdownLevel)}</span></span>
                    </div>
                </div>
            `;
        }
        
        // HTF Row
        const htfRowEl = document.getElementById('mcsHTF');
        if (htfRowEl) {
            const htfLabel = this.getBiasLabel(mc.htfBias);
            const regimeDisplay = mc.regime.replace(/_/g, ' ').toUpperCase();
            htfRowEl.innerHTML = `
                <div class="mcs-row-header">
                    <span class="mcs-row-title">🏦 HTF (Macro)</span>
                    <span class="mcs-row-bias ${mc.htfBias >= 0 ? 'bullish' : 'bearish'}">${htfLabel}</span>
                </div>
                <div class="mcs-row-details">
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Regime:</span>
                        <span class="mcs-detail-value"><strong>${regimeDisplay}</strong></span>
                    </div>
                    <div class="mcs-detail">
                        <span class="mcs-detail-label">Fair Value:</span>
                        <span class="mcs-detail-value">VWMP <span class="mcs-price">${fmt(mc.vwmp || 0)}</span> (${fmtPct(mc.vwmpExt)}), IFV <span class="mcs-price">${fmt(mc.ifv || 0)}</span> (${fmtPct(mc.ifvExt)})</span>
                    </div>
                </div>
            `;
        }
        
        // Trade Plan
        const tradePlanEl = document.getElementById('mcsTradePlan');
        if (tradePlanEl) {
            const plan = this.generateTradePlan(mc);
            tradePlanEl.innerHTML = plan;
        }
        
        // Newbie Takeaway
        const newbieEl = document.getElementById('mcsNewbie');
        if (newbieEl) {
            const newbie = this.generateMCSNewbie(mc);
            newbieEl.innerHTML = newbie;
        }
        
        // Update header MCS (mobile snapshot)
        this.updateHeaderMCS(mc);
    }
    
    /**
     * Update header Market Consensus Signal (mobile snapshot view)
     */
    updateHeaderMCS(mc) {
        const headerMcs = document.getElementById('headerMcs');
        const headerMcsStripe = document.getElementById('headerMcsStripe');
        const headerMcsSignal = document.getElementById('headerMcsSignal');
        const headerMcsScore = document.getElementById('headerMcsScore');
        const headerMcsConfidence = document.getElementById('headerMcsConfidence');
        const headerMcsDot = document.querySelector('.header-mcs .mcs-dot');
        
        if (!headerMcsSignal) return;
        
        // Get signal class (bullish/bearish/neutral)
        const signalClass = mc.mcsInfo.color;
        
        // Update parent container class for 3-color bar indicator
        if (headerMcs) {
            headerMcs.className = 'header-mcs ' + signalClass;
        }

        // Header stripe: MM / Swing / HTF bias colors (matches panel stripe)
        if (headerMcsStripe) {
            const getStripeColor = (bias) => bias >= 10 ? 'bullish' : bias <= -10 ? 'bearish' : 'neutral';
            headerMcsStripe.innerHTML = `
                <div class="stripe-segment ${getStripeColor(mc.mmBias)}" title="MM: ${mc.mmBias >= 0 ? '+' : ''}${mc.mmBias}"></div>
                <div class="stripe-segment ${getStripeColor(mc.swingBias)}" title="Swing: ${mc.swingBias >= 0 ? '+' : ''}${mc.swingBias}"></div>
                <div class="stripe-segment ${getStripeColor(mc.htfBias)}" title="HTF: ${mc.htfBias >= 0 ? '+' : ''}${mc.htfBias}"></div>
            `;
        }
        
        // Update signal text and class
        const newSignal = mc.mcsInfo.label;
        if (headerMcsSignal.textContent !== newSignal) {
            headerMcsSignal.textContent = newSignal;
            headerMcsSignal.className = 'mcs-signal ' + signalClass;
        }
        
        // Update score
        const newScore = `(${mc.mcs}/100)`;
        if (headerMcsScore && headerMcsScore.textContent !== newScore) {
            headerMcsScore.textContent = newScore;
        }
        
        // Update confidence badge
        if (headerMcsConfidence && mc.confidence) {
            const confLevel = mc.confidence.level.toLowerCase();
            const newConf = `${mc.confidence.confidence}% ${mc.confidence.level}`;
            if (headerMcsConfidence.textContent !== newConf) {
                headerMcsConfidence.textContent = newConf;
                headerMcsConfidence.className = 'mcs-confidence ' + confLevel;
            }
        }
        
        // Update dot color
        if (headerMcsDot) {
            headerMcsDot.className = 'mcs-dot ' + signalClass;
        }
    }
    
    /**
     * Generate Trade Plan HTML
     */
    generateTradePlan(mc) {
        const fmt = (price) => price < 10 ? price.toFixed(4) : '$' + price.toLocaleString(undefined, {maximumFractionDigits: 2});
        
        let action, actionClass, why, longPlan, shortPlan, range;
        
        if (mc.mcs >= 40) {
            action = '🟢 LONG BIAS';
            actionClass = 'bullish';
            why = `MM flow is bullish (LD <strong>${mc.ld >= 0 ? '+' : ''}${mc.ld.toFixed(1)} ${this.symbol}</strong>, BPR <strong>${mc.bpr.toFixed(2)}</strong>), ` +
                  `Swing supports (Alpha <strong>${mc.alpha}</strong>), ` +
                  `HTF is ${mc.htfBias >= 0 ? 'supportive' : 'stretched but not critical'}.`;
            longPlan = `
                <div class="plan-section">
                    <strong>Preferred Entry:</strong> <span class="support-price">${fmt(mc.nearSupport)}</span> – <span class="support-price">${fmt(mc.nearSupport * 1.005)}</span><br>
                    <strong>Stop Loss:</strong> Below <span class="bearish">${fmt(mc.breakdownLevel)}</span><br>
                    <strong>Target 1:</strong> <span class="bullish">${fmt(mc.nearResist)}</span> (+${((mc.nearResist / mc.nearSupport - 1) * 100).toFixed(1)}%)
                </div>`;
            shortPlan = `<div class="plan-section muted">Only if breakdown below <span class="bearish">${fmt(mc.breakdownLevel)}</span></div>`;
        } else if (mc.mcs <= -40) {
            action = '🔴 SHORT BIAS';
            actionClass = 'bearish';
            why = `MM flow is bearish (LD <strong>${mc.ld.toFixed(1)} ${this.symbol}</strong>, BPR <strong>${mc.bpr.toFixed(2)}</strong>), ` +
                  `Swing is negative (Alpha <strong>${mc.alpha}</strong>), ` +
                  `HTF shows ${mc.htfBias < 0 ? 'distribution/downtrend' : 'weakness'}.`;
            shortPlan = `
                <div class="plan-section">
                    <strong>Preferred Entry:</strong> <span class="resist-price">${fmt(mc.nearResist)}</span> – <span class="resist-price">${fmt(mc.nearResist * 0.995)}</span><br>
                    <strong>Stop Loss:</strong> Above <span class="bullish">${fmt(mc.breakoutLevel)}</span><br>
                    <strong>Target 1:</strong> <span class="bearish">${fmt(mc.nearSupport)}</span> (${((mc.nearSupport / mc.nearResist - 1) * 100).toFixed(1)}%)
                </div>`;
            longPlan = `<div class="plan-section muted">Only if breakout above <span class="bullish">${fmt(mc.breakoutLevel)}</span></div>`;
        } else {
            action = '🟡 WAIT / SCALP ONLY';
            actionClass = 'neutral';
            why = `MM flow is ${mc.mmBias > 0 ? 'mildly bullish' : mc.mmBias < 0 ? 'mildly bearish' : 'balanced'} (LD <strong>${mc.ld >= 0 ? '+' : ''}${mc.ld.toFixed(1)} ${this.symbol}</strong>, BPR <strong>${mc.bpr.toFixed(2)}</strong>), ` +
                  `Swing is neutral (Alpha <strong>${mc.alpha}</strong>), ` +
                  `HTF says price is <strong>${Math.abs(mc.ifvExt).toFixed(1)}% ${mc.ifvExt > 0 ? 'above' : 'below'} IFV</strong>.`;
            longPlan = `
                <div class="plan-section">
                    <strong>If Long (scalp only):</strong><br>
                    Dip buy zone: <span class="support-price">${fmt(mc.nearSupport)}</span><br>
                    Stop: <span class="bearish">${fmt(mc.breakdownLevel)}</span><br>
                    Target: <span class="bullish">${fmt(mc.nearResist)}</span>
                </div>`;
            shortPlan = `
                <div class="plan-section">
                    <strong>If Short (scalp only):</strong><br>
                    Rally sell zone: <span class="resist-price">${fmt(mc.nearResist)}</span><br>
                    Stop: <span class="bullish">${fmt(mc.breakoutLevel)}</span><br>
                    Target: <span class="bearish">${fmt(mc.nearSupport)}</span>
                </div>`;
        }
        
        range = `<strong>Range to respect:</strong> <span class="support-price">${fmt(mc.breakdownLevel)}</span> → <span class="resist-price">${fmt(mc.breakoutLevel)}</span>`;
        
        return `
            <div class="trade-plan-header">
                <span class="trade-plan-action ${actionClass}">${action}</span>
            </div>
            <div class="trade-plan-why">
                <strong>Why:</strong> ${why}
            </div>
            <div class="trade-plan-entries">
                ${longPlan}
                ${shortPlan}
            </div>
            <div class="trade-plan-range">${range}</div>
        `;
    }
    
    /**
     * Generate MCS Newbie Takeaway
     */
    generateMCSNewbie(mc) {
        const fmt = (price) => price < 10 ? price.toFixed(4) : '$' + Math.round(price / 1000) + 'k';
        const stretchPct = Math.abs(mc.ifvExt).toFixed(0);
        
        let message;
        if (mc.mcs >= 40) {
            message = `"Buyers are winning. Look to buy dips near <strong>${fmt(mc.nearSupport)}</strong>. Don't chase — wait for pullbacks."`;
        } else if (mc.mcs <= -40) {
            message = `"Sellers are winning. Avoid buying. Watch for price to fall toward <strong>${fmt(mc.nearSupport)}</strong>."`;
        } else {
            message = `"Price is <strong>${stretchPct}% ${mc.ifvExt > 0 ? 'above' : 'below'} fair value</strong> and stuck between <strong>${fmt(mc.breakdownLevel)}</strong> and <strong>${fmt(mc.breakoutLevel)}</strong>. Wait for a break of that range before taking a big position."`;
        }
        
        return `<span class="mcs-newbie-text">${message}</span>`;
    }
    
    /**
     * LD_CLUSTER: Calculate LD weighted by cluster density near price
     * A 20 BTC wall inside a big cluster is NOT equal to 20 BTC scattered
     */
    calculateLDCluster(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return { ldCluster: 0, clusterBacked: false, clusterStrength: 0 };
        }
        
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Define cluster detection parameters
        const CLUSTER_RANGE = 0.5; // 0.5% price range for cluster detection
        const MIN_CLUSTER_ORDERS = 3; // Minimum orders to be considered a cluster
        
        // Group levels by proximity
        const clusters = [];
        let currentCluster = [];
        let lastPrice = null;
        
        // Sort by price
        const sortedLevels = [...validLevels].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        
        sortedLevels.forEach(level => {
            const price = parseFloat(level.price);
            
            if (lastPrice === null || Math.abs((price - lastPrice) / lastPrice) * 100 < CLUSTER_RANGE) {
                currentCluster.push(level);
            } else {
                if (currentCluster.length >= MIN_CLUSTER_ORDERS) {
                    clusters.push([...currentCluster]);
                }
                currentCluster = [level];
            }
            lastPrice = price;
        });
        
        // Don't forget the last cluster
        if (currentCluster.length >= MIN_CLUSTER_ORDERS) {
            clusters.push(currentCluster);
        }
        
        // Calculate cluster-weighted LD
        let clusterBidVolume = 0;
        let clusterAskVolume = 0;
        let totalClusterStrength = 0;
        
        clusters.forEach(cluster => {
            const avgPrice = cluster.reduce((sum, l) => sum + parseFloat(l.price), 0) / cluster.length;
            const distancePercent = Math.abs((avgPrice - currentPrice) / currentPrice) * 100;
            const distanceWeight = 1 / (1 + distancePercent);
            
            // Cluster strength = number of orders × total volume
            const clusterVolume = cluster.reduce((sum, l) => sum + parseFloat(l.volume), 0);
            const clusterDensity = cluster.length; // Number of orders in cluster
            const clusterWeight = clusterDensity * distanceWeight;
            
            totalClusterStrength += clusterWeight;
            
            cluster.forEach(level => {
                const volume = parseFloat(level.volume);
                if (level.type === 'support') {
                    clusterBidVolume += volume * clusterWeight;
                } else {
                    clusterAskVolume += volume * clusterWeight;
                }
            });
        });
        
        const ldCluster = clusterBidVolume - clusterAskVolume;
        const clusterBacked = totalClusterStrength > 5; // Threshold for "cluster-backed"
        
        return { 
            ldCluster, 
            clusterBacked, 
            clusterStrength: totalClusterStrength,
            clusterBidVolume,
            clusterAskVolume,
            clusterCount: clusters.length
        };
    }
    
    /**
     * LD_MM: Market Maker Model - Classify LD changes
     * Categories: genuine_buying, genuine_selling, pulling_asks, pulling_bids, 
     *             stacking_bids, stacking_asks, spoof_inflow, spoof_outflow
     */
    classifyLDMarketMaker(ld, currentPrice) {
        this.initLDHistory();
        const history = this.ldHistory;
        
        // Initialize MM tracking if needed
        if (!history.mmPrevLevels) {
            history.mmPrevLevels = {
                nearBid: 0, nearAsk: 0, farBid: 0, farAsk: 0
            };
        }
        
        const prev = history.mmPrevLevels;
        
        // Calculate changes in each category
        const nearBidChange = ld.nearBidVolume - prev.nearBid;
        const nearAskChange = ld.nearAskVolume - prev.nearAsk;
        const farBidChange = ld.farBidVolume - prev.farBid;
        const farAskChange = ld.farAskVolume - prev.farAsk;
        
        // Store for next comparison
        history.mmPrevLevels = {
            nearBid: ld.nearBidVolume,
            nearAsk: ld.nearAskVolume,
            farBid: ld.farBidVolume,
            farAsk: ld.farAskVolume
        };
        
        // Thresholds
        const significantChange = 5; // 5 BTC threshold
        
        let mmModel = {
            type: 'neutral',
            description: 'No significant activity',
            confidence: 0,
            bullish: false,
            bearish: false
        };
        
        // === BULLISH PATTERNS ===
        
        // Genuine Buying: Near bids increasing, price following
        if (nearBidChange > significantChange && ld.delta > 30) {
            mmModel = {
                type: 'genuine_buying',
                description: 'Aggressive bid stacking',
                confidence: Math.min(100, Math.abs(nearBidChange) * 3),
                bullish: true,
                bearish: false
            };
        }
        // Pulling Asks: Asks being removed (bullish)
        else if (nearAskChange < -significantChange && ld.delta > 0) {
            mmModel = {
                type: 'pulling_asks',
                description: 'Ask removal near price — hidden bullish intent',
                confidence: Math.min(100, Math.abs(nearAskChange) * 3),
                bullish: true,
                bearish: false
            };
        }
        // Stacking Bids: Bids being added aggressively
        else if (nearBidChange > significantChange * 2) {
            mmModel = {
                type: 'stacking_bids',
                description: 'Large bid walls appearing',
                confidence: Math.min(100, nearBidChange * 2),
                bullish: true,
                bearish: false
            };
        }
        
        // === BEARISH PATTERNS ===
        
        // Genuine Selling: Near asks increasing, price following
        else if (nearAskChange > significantChange && ld.delta < -30) {
            mmModel = {
                type: 'genuine_selling',
                description: 'Aggressive ask stacking',
                confidence: Math.min(100, Math.abs(nearAskChange) * 3),
                bullish: false,
                bearish: true
            };
        }
        // Pulling Bids: Bids being removed (bearish)
        else if (nearBidChange < -significantChange && ld.delta < 0) {
            mmModel = {
                type: 'pulling_bids',
                description: 'Bid removal near price — hidden bearish intent',
                confidence: Math.min(100, Math.abs(nearBidChange) * 3),
                bullish: false,
                bearish: true
            };
        }
        // Stacking Asks: Asks being added aggressively
        else if (nearAskChange > significantChange * 2) {
            mmModel = {
                type: 'stacking_asks',
                description: 'Large ask walls appearing',
                confidence: Math.min(100, nearAskChange * 2),
                bullish: false,
                bearish: true
            };
        }
        
        // === SPOOF DETECTION ===
        
        // Spoof Inflow: Far orders increasing dramatically
        else if (farBidChange > significantChange * 3 || farAskChange > significantChange * 3) {
            const isBidSpoof = farBidChange > farAskChange;
            mmModel = {
                type: 'spoof_inflow',
                description: `Spoof detected — ${isBidSpoof ? 'thinning bids' : 'flooding asks'} far from price`,
                confidence: Math.min(100, Math.max(farBidChange, farAskChange) * 2),
                bullish: isBidSpoof,
                bearish: !isBidSpoof
            };
        }
        // Spoof Outflow: Far orders disappearing (spoof pulled)
        else if (farBidChange < -significantChange * 3 || farAskChange < -significantChange * 3) {
            mmModel = {
                type: 'spoof_outflow',
                description: 'Spoof walls pulled — fake pressure removed',
                confidence: Math.min(100, Math.abs(Math.min(farBidChange, farAskChange)) * 2),
                bullish: false,
                bearish: false
            };
        }
        
        history.mmModel = mmModel;
        return mmModel;
    }
    
    /**
     * LD_HEATMAP: Calculate pressure distribution above/below price
     * Returns where LD is strongest in bands around current price
     */
    calculateLDPressureMap(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return { bands: [], strongestBid: 0, strongestAsk: 0 };
        }
        
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Create 10 bands: 5 below price, 5 above
        const bands = [];
        const bandPercent = 2; // 2% per band
        
        for (let i = -5; i <= 5; i++) {
            if (i === 0) continue; // Skip current price band
            
            const bandStart = currentPrice * (1 + (i - 0.5) * bandPercent / 100);
            const bandEnd = currentPrice * (1 + (i + 0.5) * bandPercent / 100);
            
            let bidVolume = 0;
            let askVolume = 0;
            
            validLevels.forEach(level => {
                const price = parseFloat(level.price);
                const volume = parseFloat(level.volume);
                
                if (price >= bandStart && price < bandEnd) {
                    if (level.type === 'support') {
                        bidVolume += volume;
                    } else {
                        askVolume += volume;
                    }
                }
            });
            
            bands.push({
                band: i,
                position: i < 0 ? 'below' : 'above',
                distancePercent: Math.abs(i) * bandPercent,
                bidVolume,
                askVolume,
                netPressure: bidVolume - askVolume,
                totalVolume: bidVolume + askVolume
            });
        }
        
        // Find strongest pressure points
        const bidBands = bands.filter(b => b.position === 'below').sort((a, b) => b.bidVolume - a.bidVolume);
        const askBands = bands.filter(b => b.position === 'above').sort((a, b) => b.askVolume - a.askVolume);
        
        const strongestBidBand = bidBands[0] || null;
        const strongestAskBand = askBands[0] || null;
        
        this.initLDHistory();
        this.ldHistory.pressureMap = {
            bands,
            strongestBid: strongestBidBand,
            strongestAsk: strongestAskBand
        };
        
        return this.ldHistory.pressureMap;
    }
    
    /**
     * LD Threshold Alerts: Generate micro-alerts for key conditions
     */
    generateLDAlerts(ld, currentPrice) {
        this.initLDHistory();
        const history = this.ldHistory;
        const signals = this.regimeEngine?.signals || {};
        
        const alerts = [];
        const ldRoc = signals.ld_roc || 0;
        const bpr = this.orderFlowPressure?.levels ? this.calculateBPR(this.orderFlowPressure.levels) : { ratio: 1 };
        
        // === PANIC ALERTS ===
        if (ldRoc < -10) {
            alerts.push({
                type: 'panic_shift',
                icon: '🚨',
                message: 'Panic Shift — LD dropping fast',
                severity: 'high',
                bearish: true
            });
        }
        
        // === BREAKOUT ALERTS ===
        if (ldRoc > 10 && bpr.ratio > 1.2) {
            alerts.push({
                type: 'markup_phase',
                icon: '🚀',
                message: 'Markup Phase — LD surge + strong bids',
                severity: 'high',
                bullish: true
            });
        }
        
        // === BREAKDOWN ALERTS ===
        if (ld.delta < -100 && history.pressureMap?.strongestBid) {
            const supportGap = history.pressureMap.strongestBid.distancePercent;
            if (supportGap > 4) {
                alerts.push({
                    type: 'breakdown_risk',
                    icon: '⚠️',
                    message: `Breakdown Risk — ${supportGap.toFixed(1)}% gap to support`,
                    severity: 'medium',
                    bearish: true
                });
            }
        }
        
        // === REVERSAL ALERTS ===
        if (history.divergence === 'bullish') {
            alerts.push({
                type: 'bull_divergence',
                icon: '🔄',
                message: 'Bull Divergence — reversal likely',
                severity: 'medium',
                bullish: true
            });
        }
        
        if (history.divergence === 'bearish') {
            alerts.push({
                type: 'bear_divergence',
                icon: '🔄',
                message: 'Bear Divergence — reversal likely',
                severity: 'medium',
                bearish: true
            });
        }
        
        // === SPOOF ALERTS ===
        if (ld.velocityType === 'spoof_far') {
            alerts.push({
                type: 'spoof_detected',
                icon: '👻',
                message: 'Spoof Activity — far orders dominating',
                severity: 'low',
                warning: true
            });
        }
        
        // === ABSORPTION ALERTS ===
        if (history.absorption === 'absorption_sell') {
            alerts.push({
                type: 'hidden_selling',
                icon: '🕵️',
                message: 'Hidden Selling — bids being absorbed',
                severity: 'medium',
                bearish: true
            });
        }
        
        if (history.absorption === 'absorption_buy') {
            alerts.push({
                type: 'hidden_buying',
                icon: '🕵️',
                message: 'Hidden Buying — asks being absorbed',
                severity: 'medium',
                bullish: true
            });
        }
        
        // === CLUSTER STRENGTH ALERTS ===
        if (history.clusterStrength?.clusterBacked && ld.delta > 50) {
            alerts.push({
                type: 'cluster_support',
                icon: '🏰',
                message: 'Cluster-Backed Support — strong foundation',
                severity: 'low',
                bullish: true
            });
        }
        
        history.alerts = alerts;
        return alerts;
    }
    
    /**
     * LD Footprint History: Store LD per bar for historical analysis
     */
    updateLDFootprint(ld, candleTime) {
        this.initLDHistory();
        const history = this.ldHistory;
        
        if (!history.footprint) {
            history.footprint = [];
        }
        
        // Store footprint entry
        const entry = {
            time: candleTime || Date.now(),
            ld: ld.delta,
            velocity: ld.velocity,
            nearDelta: ld.nearDelta,
            farDelta: ld.farDelta,
            velocityType: ld.velocityType
        };
        
        history.footprint.push(entry);
        
        // Keep last 50 bars
        if (history.footprint.length > 50) {
            history.footprint.shift();
        }
        
        return history.footprint;
    }
    
    /**
     * Get LD Footprint data for chart rendering
     */
    getLDFootprintData() {
        this.initLDHistory();
        return this.ldHistory.footprint || [];
    }
    
    /**
     * Calculate Order Book Imbalance Curve (OBIC)
     * Returns array of { price, imbalance } points for plotting
     * Imbalance at each price = cumulative bids below - cumulative asks above
     */
    calculateOBIC(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return [];
        }
        
        // CRITICAL: Filter to reasonable price range to prevent scale distortion
        // Only include levels within ±15% of current price
        const priceRangePct = 0.15;
        const minPriceFilter = currentPrice * (1 - priceRangePct);
        const maxPriceFilter = currentPrice * (1 + priceRangePct);
        
        // Filter valid levels with proper type, numeric values, and within price range
        const validLevels = levels.filter(l => {
            if (!l || !l.type || !l.price || !l.volume) return false;
            if (l.type !== 'support' && l.type !== 'resistance') return false;
            
            const price = parseFloat(l.price);
            const volume = parseFloat(l.volume);
            
            if (isNaN(price) || isNaN(volume)) return false;
            if (price <= 0 || volume <= 0) return false;
            
            // Filter outliers - only keep prices within range
            if (price < minPriceFilter || price > maxPriceFilter) return false;
            
            return true;
        });
        
        if (validLevels.length === 0) {
            return [];
        }
        
        // Separate bids (support) and asks (resistance)
        const bids = validLevels
            .filter(l => l.type === 'support')
            .map(l => ({ 
                price: parseFloat(l.price), 
                volume: parseFloat(l.volume) 
            }))
            .sort((a, b) => b.price - a.price); // High to low
        
        const asks = validLevels
            .filter(l => l.type === 'resistance')
            .map(l => ({ 
                price: parseFloat(l.price), 
                volume: parseFloat(l.volume) 
            }))
            .sort((a, b) => a.price - b.price); // Low to high
        
        if (bids.length === 0 || asks.length === 0) {
            return [];
        }
        
        // Price range for OBIC curve (±10% of current price for focused view)
        const minPrice = currentPrice * 0.90;
        const maxPrice = currentPrice * 1.10;
        
        // Create OBIC curve with ~50 data points
        const points = [];
        const steps = 50;
        const priceStep = (maxPrice - minPrice) / steps;
        
        for (let i = 0; i <= steps; i++) {
            const price = minPrice + (i * priceStep);
            
            // Cumulative bid volume at or below this price
            const cumulativeBids = bids
                .filter(b => b.price <= price)
                .reduce((sum, b) => sum + b.volume, 0);
            
            // Cumulative ask volume at or above this price
            const cumulativeAsks = asks
                .filter(a => a.price >= price)
                .reduce((sum, a) => sum + a.volume, 0);
            
            const imbalance = cumulativeBids - cumulativeAsks;
            
            points.push({ price, imbalance });
        }
        
        return points;
    }
    
    /**
     * Update all order flow pressure indicators
     */
    updateOrderFlowPressure() {
        if (!this.orderFlowPressure || !this.orderFlowPressure.levels) return;
        
        const levels = this.orderFlowPressure.levels;
        const currentPrice = this.orderFlowPressure.currentPrice;
        
        // Preserve sidebar scroll position during updates
        const sidebar = document.querySelector('.sidebar-right');
        const scrollTop = sidebar ? sidebar.scrollTop : 0;
        
        // Calculate all indicators
        const bpr = this.calculateBPR(levels);
        const ld = this.calculateLiquidityDelta(levels, currentPrice);
        const obic = this.calculateOBIC(levels, currentPrice);
        
        // Update DOM
        this.updateBPRDisplay(bpr);
        this.updateLDDisplay(ld, currentPrice);
        this.drawOBICChart(obic, currentPrice);
        
        // Update Regime Engine only if we have a real alpha (no arbitrary fallback)
        if (this.alphaScore !== undefined) {
            this.updateRegimeEngine(levels, currentPrice, this.alphaScore);
        }
        
        // Restore sidebar scroll position after DOM updates
        if (sidebar && scrollTop > 0) {
            sidebar.scrollTop = scrollTop;
        }
    }
    
    /**
     * Update BPR display in DOM
     */
    updateBPRDisplay(bpr) {
        const bprValue = document.getElementById('bprValue');
        const bprBarBid = document.getElementById('bprBarBid');
        const bprBarAsk = document.getElementById('bprBarAsk');
        const bprAnalysis = document.getElementById('bprAnalysis');
        
        if (!bprValue || !bprBarBid || !bprBarAsk) return;
        
        // Calculate percentages for gauge
        const total = bpr.bidVolume + bpr.askVolume;
        const bidPercent = total > 0 ? (bpr.bidVolume / total) * 100 : 50;
        const askPercent = 100 - bidPercent;
        
        bprBarBid.style.width = `${bidPercent}%`;
        bprBarAsk.style.width = `${askPercent}%`;
        
        // Update value display
        bprValue.textContent = bpr.ratio.toFixed(2);
        bprValue.classList.remove('bullish', 'bearish', 'neutral');
        
        // Update analysis text
        if (bprAnalysis) {
            bprAnalysis.classList.remove('bullish', 'bearish', 'neutral');
            
            if (bpr.ratio > 1.5) {
                bprAnalysis.textContent = `Buyers are winning big — lots more buy orders waiting`;
                bprAnalysis.classList.add('bullish');
            } else if (bpr.ratio > 1.2) {
                bprAnalysis.textContent = `Buyers have the edge — more people want to buy`;
                bprAnalysis.classList.add('bullish');
            } else if (bpr.ratio > 1.05) {
                bprAnalysis.textContent = `Slightly more buyers — small upward pressure`;
                bprAnalysis.classList.add('bullish');
            } else if (bpr.ratio < 0.67) {
                bprAnalysis.textContent = `Sellers are winning big — lots more sell orders waiting`;
                bprAnalysis.classList.add('bearish');
            } else if (bpr.ratio < 0.83) {
                bprAnalysis.textContent = `Sellers have the edge — more people want to sell`;
                bprAnalysis.classList.add('bearish');
            } else if (bpr.ratio < 0.95) {
                bprAnalysis.textContent = `Slightly more sellers — small downward pressure`;
                bprAnalysis.classList.add('bearish');
            } else {
                bprAnalysis.textContent = `Even match — buyers and sellers are balanced`;
                bprAnalysis.classList.add('neutral');
            }
        }
        
        if (bpr.ratio > 1.05) {
            bprValue.classList.add('bullish');
        } else if (bpr.ratio < 0.95) {
            bprValue.classList.add('bearish');
        } else {
            bprValue.classList.add('neutral');
        }
    }
    
    /**
     * Update Liquidity Delta display in DOM with Enhanced Metrics
     */
    updateLDDisplay(ld, currentPrice) {
        const ldValue = document.getElementById('ldValue');
        const ldArrow = document.getElementById('ldArrow');
        const ldUnit = document.getElementById('ldUnit');
        const ldAnalysis = document.getElementById('ldAnalysis');
        
        // New enhanced elements
        const ldVelocity = document.getElementById('ldVelocity');
        const ldVelocityBar = document.getElementById('ldVelocityBar');
        const ldAbsorption = document.getElementById('ldAbsorption');
        const ldDivergence = document.getElementById('ldDivergence');
        const ldProjection = document.getElementById('ldProjection');
        
        if (!ldValue || !ldArrow) return;
        
        // Update LD history for divergence/absorption detection
        if (currentPrice) {
            this.updateLDHistory(ld, currentPrice);
        }
        
        // Format delta value
        const absDelta = Math.abs(ld.delta);
        let displayValue;
        
        if (absDelta >= 1000) {
            displayValue = (ld.delta / 1000).toFixed(1) + 'K';
        } else if (absDelta >= 1) {
            displayValue = ld.delta.toFixed(1);
        } else {
            displayValue = ld.delta.toFixed(2);
        }
        
        // Add sign
        if (ld.delta > 0) {
            displayValue = '+' + displayValue;
        }
        
        ldValue.textContent = displayValue;
        ldValue.classList.remove('positive', 'negative', 'neutral');
        ldArrow.classList.remove('up', 'down', 'neutral');
        
        // ========================================
        // Update LD Velocity (LD_VEL)
        // ========================================
        if (ldVelocity && ldVelocityBar) {
            const velValue = Math.abs(ld.velocity);
            const velSign = ld.velocity >= 0 ? '+' : '';
            ldVelocity.textContent = velSign + ld.velocity.toFixed(1);
            
            // Color based on velocity type
            ldVelocity.classList.remove('aggressive', 'spoof', 'mixed', 'neutral');
            ldVelocityBar.classList.remove('aggressive', 'spoof', 'mixed', 'neutral');
            
            if (ld.velocityType === 'aggressive_near') {
                ldVelocity.classList.add('aggressive');
                ldVelocityBar.classList.add('aggressive');
            } else if (ld.velocityType === 'spoof_far') {
                ldVelocity.classList.add('spoof');
                ldVelocityBar.classList.add('spoof');
            } else if (ld.velocityType === 'mixed') {
                ldVelocity.classList.add('mixed');
                ldVelocityBar.classList.add('mixed');
            } else {
                ldVelocity.classList.add('neutral');
                ldVelocityBar.classList.add('neutral');
            }
            
            // Bar width (capped at 100%)
            const maxVel = 50; // Max velocity for full bar
            const barWidth = Math.min(100, (velValue / maxVel) * 100);
            ldVelocityBar.style.width = `${barWidth}%`;
        }
        
        // ========================================
        // Update Absorption vs Displacement
        // ========================================
        if (ldAbsorption) {
            const intel = this.getLDIntelligence();
            ldAbsorption.classList.remove('displacement-up', 'displacement-down', 'absorption-sell', 'absorption-buy', 'absorption-neutral', 'hidden');
            
            if (intel.absorption) {
                let absText = '';
                let absClass = '';
                
                switch (intel.absorption) {
                    case 'displacement_up':
                        absText = '↗ Displacement (Real Buying)';
                        absClass = 'displacement-up';
                        break;
                    case 'displacement_down':
                        absText = '↘ Displacement (Real Selling)';
                        absClass = 'displacement-down';
                        break;
                    case 'absorption_sell':
                        absText = '⚡ Absorption (Hidden Selling)';
                        absClass = 'absorption-sell';
                        break;
                    case 'absorption_buy':
                        absText = '⚡ Absorption (Hidden Buying)';
                        absClass = 'absorption-buy';
                        break;
                    case 'absorption_neutral':
                        absText = '◉ Absorption (Maker Control)';
                        absClass = 'absorption-neutral';
                        break;
                }
                
                ldAbsorption.textContent = absText;
                ldAbsorption.classList.add(absClass);
            } else {
                ldAbsorption.textContent = '';
                ldAbsorption.classList.add('hidden');
            }
        }
        
        // ========================================
        // Update Divergence Detector
        // ========================================
        if (ldDivergence) {
            const intel = this.getLDIntelligence();
            ldDivergence.classList.remove('bullish', 'bearish', 'hidden');
            
            if (intel.divergence === 'bullish') {
                ldDivergence.textContent = '🔼 LD Bull Divergence';
                ldDivergence.classList.add('bullish');
            } else if (intel.divergence === 'bearish') {
                ldDivergence.textContent = '🔽 LD Bear Divergence';
                ldDivergence.classList.add('bearish');
            } else {
                ldDivergence.textContent = '';
                ldDivergence.classList.add('hidden');
            }
        }
        
        // ========================================
        // Update LD Projection (3-bar forecast)
        // ========================================
        if (ldProjection) {
            const intel = this.getLDIntelligence();
            const proj = intel.projection || [0, 0, 0];
            
            // Create projection dots
            ldProjection.innerHTML = proj.map((p, i) => {
                const sign = p >= 0 ? '+' : '';
                const colorClass = p > 10 ? 'bullish' : p < -10 ? 'bearish' : 'neutral';
                return `<span class="proj-dot ${colorClass}" title="+${i+1} bar: ${sign}${p.toFixed(1)}">${sign}${Math.round(p)}</span>`;
            }).join('');
        }
        
        // ========================================
        // Calculate and update advanced LD metrics
        // ========================================
        const levels = this.orderFlowPressure?.levels || [];
        
        // LD_CLUSTER: Cluster-weighted LD
        const ldCluster = this.calculateLDCluster(levels, currentPrice);
        this.initLDHistory();
        this.ldHistory.clusterStrength = ldCluster;
        
        // LD_MM: Market Maker Model classification
        const mmModel = this.classifyLDMarketMaker(ld, currentPrice);
        
        // LD_HEATMAP: Pressure distribution
        const pressureMap = this.calculateLDPressureMap(levels, currentPrice);
        
        // LD Alerts
        const alerts = this.generateLDAlerts(ld, currentPrice);
        
        // LD Footprint
        this.updateLDFootprint(ld, this.lastCandleTime);
        
        // ========================================
        // Update LD_CLUSTER display
        // ========================================
        const ldClusterEl = document.getElementById('ldCluster');
        const ldClusterBar = document.getElementById('ldClusterBar');
        if (ldClusterEl) {
            const clusterValue = ldCluster.ldCluster;
            const sign = clusterValue >= 0 ? '+' : '';
            ldClusterEl.textContent = sign + clusterValue.toFixed(1);
            ldClusterEl.classList.remove('cluster-backed', 'unclustered');
            ldClusterEl.classList.add(ldCluster.clusterBacked ? 'cluster-backed' : 'unclustered');
            
            if (ldClusterBar) {
                const maxCluster = 100;
                const barWidth = Math.min(100, (Math.abs(clusterValue) / maxCluster) * 100);
                ldClusterBar.style.width = `${barWidth}%`;
                ldClusterBar.classList.remove('positive', 'negative');
                ldClusterBar.classList.add(clusterValue >= 0 ? 'positive' : 'negative');
            }
        }
        
        // ========================================
        // Update LD_MM (Market Maker Model) display
        // ========================================
        const ldMMEl = document.getElementById('ldMM');
        if (ldMMEl) {
            ldMMEl.classList.remove('bullish', 'bearish', 'neutral', 'warning', 'hidden');
            
            if (mmModel.type !== 'neutral') {
                ldMMEl.innerHTML = `<span class="mm-icon">${this.getMMIcon(mmModel.type)}</span>${mmModel.description}`;
                ldMMEl.classList.add(mmModel.bullish ? 'bullish' : mmModel.bearish ? 'bearish' : 'warning');
            } else {
                ldMMEl.textContent = '';
                ldMMEl.classList.add('hidden');
            }
        }
        
        // ========================================
        // Update LD_HEATMAP (Pressure Map) display
        // ========================================
        const ldHeatmapEl = document.getElementById('ldHeatmap');
        if (ldHeatmapEl && pressureMap.bands.length > 0) {
            this.drawLDHeatmap(ldHeatmapEl, pressureMap);
        }
        
        // ========================================
        // Update LD Alerts display
        // ========================================
        const ldAlertsEl = document.getElementById('ldAlerts');
        if (ldAlertsEl) {
            if (alerts.length > 0) {
                ldAlertsEl.innerHTML = alerts.slice(0, 3).map(alert => {
                    const colorClass = alert.bullish ? 'bullish' : alert.bearish ? 'bearish' : alert.warning ? 'warning' : 'neutral';
                    return `<span class="ld-alert ${colorClass}" title="${alert.message}">${alert.icon}</span>`;
                }).join('');
            } else {
                ldAlertsEl.innerHTML = '';
            }
        }
        
        // ========================================
        // Update Main Analysis text (enhanced)
        // ========================================
        if (ldAnalysis) {
            ldAnalysis.classList.remove('bullish', 'bearish', 'neutral');
            
            // Build enhanced analysis
            let analysis = '';
            const intel = this.getLDIntelligence();
            
            // Base analysis on delta
            if (ld.delta > 200) {
                analysis = `Strong safety net below — big buyers ready to catch dips`;
                ldAnalysis.classList.add('bullish');
            } else if (ld.delta > 100) {
                analysis = `Good support below — buyers waiting at lower prices`;
                ldAnalysis.classList.add('bullish');
            } else if (ld.delta > 30) {
                analysis = `More buyers nearby — price has upward push`;
                ldAnalysis.classList.add('bullish');
            } else if (ld.delta < -200) {
                analysis = `Strong wall above — big sellers blocking price rises`;
                ldAnalysis.classList.add('bearish');
            } else if (ld.delta < -100) {
                analysis = `Resistance above — sellers waiting at higher prices`;
                ldAnalysis.classList.add('bearish');
            } else if (ld.delta < -30) {
                analysis = `More sellers nearby — price has downward pressure`;
                ldAnalysis.classList.add('bearish');
            } else {
                analysis = `Balanced — no strong push in either direction`;
                ldAnalysis.classList.add('neutral');
            }
            
            // Add velocity insight
            if (ld.velocityType === 'aggressive_near') {
                analysis += ' [REAL: Near-price pressure]';
            } else if (ld.velocityType === 'spoof_far') {
                analysis += ' [CAUTION: Far orders, possible spoof]';
            }
            
            ldAnalysis.textContent = analysis;
        }
        
        // Update main value colors
        if (ld.delta > 10) {
            ldValue.classList.add('positive');
            ldArrow.classList.add('up');
            ldArrow.textContent = '↗';
        } else if (ld.delta < -10) {
            ldValue.classList.add('negative');
            ldArrow.classList.add('down');
            ldArrow.textContent = '↘';
        } else {
            ldValue.classList.add('neutral');
            ldArrow.classList.add('neutral');
            ldArrow.textContent = '→';
        }
        
        // ========================================
        // Update LD Trading Guide
        // ========================================
        this.updateLDTradingGuide(ld, currentPrice);
        
        // ========================================
        // Update LD Flow Zones on Chart
        // ========================================
        this.updateLDFlowZonesOnChart(currentPrice);
    }
    
    /**
     * Initialize LD Flow Zones settings
     */
    initLDFlowZones() {
        if (!this.ldFlowZones) {
            this.ldFlowZones = {
                enabled: localStorage.getItem('showLDFlowZones') !== 'false', // Default ON
                supportLine: null,
                resistanceLine: null,
                supportPrice: 0,
                resistancePrice: 0
            };
        }
    }
    
    /**
     * Set LD Flow Zones enabled state
     */
    setLDFlowZonesEnabled(enabled) {
        this.initLDFlowZones();
        this.ldFlowZones.enabled = enabled;
        localStorage.setItem('showLDFlowZones', enabled);
        
        if (!enabled) {
            this.clearLDFlowZones();
        } else {
            // Re-render with current data
            const currentPrice = this.currentPrice || this.lastCandle?.close;
            if (currentPrice) {
                this.updateLDFlowZonesOnChart(currentPrice);
            }
        }
    }
    
    /**
     * Clear LD Flow Zone lines from chart
     */
    clearLDFlowZones() {
        this.initLDFlowZones();
        
        if (this.ldFlowZones.supportLine) {
            this.chart.removeSeries(this.ldFlowZones.supportLine);
            this.ldFlowZones.supportLine = null;
        }
        if (this.ldFlowZones.resistanceLine) {
            this.chart.removeSeries(this.ldFlowZones.resistanceLine);
            this.ldFlowZones.resistanceLine = null;
        }
    }
    
    /**
     * Update LD Flow Zones on Chart
     * Shows support and resistance zones from LD analysis as price labels
     */
    updateLDFlowZonesOnChart(currentPrice) {
        this.initLDFlowZones();
        
        if (!this.ldFlowZones.enabled || !this.chart || !currentPrice) {
            return;
        }
        
        // Get pressure map data
        const intel = this.getLDIntelligence();
        const pressureMap = intel.pressureMap || { strongestBid: null, strongestAsk: null };
        
        // Calculate support and resistance prices
        let supportPrice = pressureMap.strongestBid ? 
            currentPrice * (1 - pressureMap.strongestBid.distancePercent / 100) : null;
        let resistancePrice = pressureMap.strongestAsk ? 
            currentPrice * (1 + pressureMap.strongestAsk.distancePercent / 100) : null;
        
        // Fallback to reasonable defaults if no data
        if (!supportPrice) supportPrice = currentPrice * 0.97;
        if (!resistancePrice) resistancePrice = currentPrice * 1.03;
        
        // Check if prices have changed significantly (>0.1%)
        const supportChanged = Math.abs((supportPrice - this.ldFlowZones.supportPrice) / supportPrice) > 0.001;
        const resistanceChanged = Math.abs((resistancePrice - this.ldFlowZones.resistancePrice) / resistancePrice) > 0.001;
        
        if (!supportChanged && !resistanceChanged && this.ldFlowZones.supportLine && this.ldFlowZones.resistanceLine) {
            return; // No significant change, skip update
        }
        
        // Store new prices
        this.ldFlowZones.supportPrice = supportPrice;
        this.ldFlowZones.resistancePrice = resistancePrice;
        
        // Get time range for the lines
        const timeScale = this.chart.timeScale();
        const visibleRange = timeScale.getVisibleLogicalRange();
        const lastBarTime = this.lastCandleTime || Math.floor(Date.now() / 1000);
        
        // Calculate time points - extend from current bar to the right
        const barDuration = this.getBarDuration();
        const startTime = lastBarTime;
        const endTime = lastBarTime + (barDuration * 5); // Extend 5 bars to the right
        
        // Remove existing lines
        this.clearLDFlowZones();
        
        // Create support zone line (cyan/green)
        this.ldFlowZones.supportLine = this.chart.addLineSeries({
            color: 'rgba(6, 182, 212, 0.8)',
            lineWidth: 2,
            lineStyle: 2, // Dashed
            priceLineVisible: true,
            lastValueVisible: true,
            title: '▼ LD Support',
            priceFormat: {
                type: 'price',
                precision: this.getPricePrecision(),
                minMove: this.getMinMove(),
            },
        });
        
        this.ldFlowZones.supportLine.setData([
            { time: startTime, value: supportPrice },
            { time: endTime, value: supportPrice }
        ]);
        
        // Create resistance zone line (pink/red)
        this.ldFlowZones.resistanceLine = this.chart.addLineSeries({
            color: 'rgba(236, 72, 153, 0.8)',
            lineWidth: 2,
            lineStyle: 2, // Dashed
            priceLineVisible: true,
            lastValueVisible: true,
            title: '▲ LD Resist',
            priceFormat: {
                type: 'price',
                precision: this.getPricePrecision(),
                minMove: this.getMinMove(),
            },
        });
        
        this.ldFlowZones.resistanceLine.setData([
            { time: startTime, value: resistancePrice },
            { time: endTime, value: resistancePrice }
        ]);
    }
    
    /**
     * Get bar duration in seconds based on current interval
     */
    getBarDuration() {
        const interval = this.currentInterval || '1m';
        const durations = {
            '1m': 60,
            '3m': 180,
            '5m': 300,
            '15m': 900,
            '30m': 1800,
            '1h': 3600,
            '2h': 7200,
            '4h': 14400,
            '6h': 21600,
            '12h': 43200,
            '1d': 86400,
            '3d': 259200,
            '1w': 604800
        };
        return durations[interval] || 60;
    }
    
    /**
     * Get price precision based on current price
     */
    getPricePrecision() {
        const price = this.currentPrice || 1000;
        if (price < 1) return 6;
        if (price < 10) return 4;
        if (price < 100) return 3;
        return 2;
    }
    
    /**
     * Get minimum price move based on current price
     */
    getMinMove() {
        const price = this.currentPrice || 1000;
        if (price < 1) return 0.000001;
        if (price < 10) return 0.0001;
        if (price < 100) return 0.001;
        return 0.01;
    }
    
    /**
     * Get icon for Market Maker model type
     */
    getMMIcon(type) {
        const icons = {
            'genuine_buying': '🟢',
            'genuine_selling': '🔴',
            'pulling_asks': '⬆️',
            'pulling_bids': '⬇️',
            'stacking_bids': '🏗️',
            'stacking_asks': '🏗️',
            'spoof_inflow': '👻',
            'spoof_outflow': '💨',
            'neutral': '⚪'
        };
        return icons[type] || '⚪';
    }
    
    /**
     * Generate LD Trading Guide content
     * Converts all LD metrics into human-friendly trading guidance
     */
    generateLDTradingGuide(ld, currentPrice) {
        const intel = this.getLDIntelligence();
        const proj = intel.projection || [0, 0, 0];
        const pressureMap = intel.pressureMap || { bands: [], strongestBid: null, strongestAsk: null };
        const clusterData = intel.clusterStrength || { ldCluster: 0, clusterBacked: false };
        const mmModel = intel.mmModel || { type: 'neutral', description: '' };
        const absorption = intel.absorption;
        
        // Calculate pressure percentages
        let pressBelow = 0, pressAbove = 0;
        if (pressureMap.bands && pressureMap.bands.length > 0) {
            const belowBands = pressureMap.bands.filter(b => b.position === 'below');
            const aboveBands = pressureMap.bands.filter(b => b.position === 'above');
            const totalBelow = belowBands.reduce((sum, b) => sum + b.bidVolume, 0);
            const totalAbove = aboveBands.reduce((sum, b) => sum + b.askVolume, 0);
            const total = totalBelow + totalAbove || 1;
            pressBelow = (totalBelow / total) * 100;
            pressAbove = (totalAbove / total) * 100;
        }
        
        // Determine signal type
        const ldValue = ld?.delta || 0;
        const ldVel = ld?.velocity || 0;
        const ldClu = clusterData.ldCluster || 0;
        const projAllPositive = proj.every(p => p > 0);
        const projAllNegative = proj.every(p => p < 0);
        const projMixed = !projAllPositive && !projAllNegative;
        
        // Format price helper
        const fmt = (price) => price < 10 ? price.toFixed(4) : '$' + price.toLocaleString(undefined, {maximumFractionDigits: 2});
        
        // Calculate key levels
        const nearestSupport = pressureMap.strongestBid ? 
            currentPrice * (1 - pressureMap.strongestBid.distancePercent / 100) : currentPrice * 0.98;
        const nearestResist = pressureMap.strongestAsk ? 
            currentPrice * (1 + pressureMap.strongestAsk.distancePercent / 100) : currentPrice * 1.02;
        
        let guide = {
            happening: '',
            todo: '',
            zones: '',
            newbie: '',
            bias: 'neutral', // 'bullish', 'bearish', 'warning', 'neutral'
        };
        
        // ========================================
        // DECISION ENGINE
        // ========================================
        
        // Check for SPOOF WARNING first (highest priority)
        const isSpoofRisk = Math.abs(ldValue) > 40 && 
                           ((ldVel > 0 && ldClu < 0) || (ldVel < 0 && ldClu > 0)) &&
                           Math.abs(pressBelow - pressAbove) < 20;
        
        if (isSpoofRisk) {
            guide.bias = 'warning';
            
            guide.happening = `⚠️ Showing ${ldValue > 0 ? 'bullish' : 'bearish'} pressure (${ldValue > 0 ? '+' : ''}${ldValue.toFixed(1)} ${this.symbol} LD), ` +
                `but velocity and cluster signals conflict. ` +
                `${ldVel > 0 ? 'Near-price orders bullish' : 'Near-price orders bearish'}, ` +
                `yet ${ldClu > 0 ? 'clusters support bids' : 'clusters support asks'}. ` +
                `This divergence suggests potential spoofing activity.`;
            
            guide.todo = `⚠️ HIGH CAUTION: Pressure may be spoof-driven. ` +
                `Wait for LD_VEL and LD_CLU to align before entering. ` +
                `Don't chase the apparent ${ldValue > 0 ? 'strength' : 'weakness'}.`;
            
            guide.zones = `Uncertain — spoofed levels may not hold. ` +
                `Watch for ${fmt(nearestSupport)} support and ${fmt(nearestResist)} resistance, ` +
                `but expect wicks through both.`;
            
            guide.newbie = `"The numbers look strong but might be fake orders. Wait and see — don't trade yet."`;
        }
        // BULLISH SIGNAL
        else if (ldValue > 20 && projAllPositive && pressBelow > pressAbove) {
            guide.bias = 'bullish';
            
            let happeningParts = [];
            happeningParts.push(`Buyers show active pressure (+${ldValue.toFixed(1)} ${this.symbol} LD)`);
            
            if (ldVel > 10) {
                happeningParts.push(`with strong near-price buying (VEL: +${ldVel.toFixed(1)})`);
            } else if (ldVel > 0) {
                happeningParts.push(`with moderate near-price support`);
            } else if (ldVel < -10) {
                happeningParts.push(`but earlier sell momentum still present (VEL: ${ldVel.toFixed(1)})`);
            }
            
            if (clusterData.clusterBacked && ldClu > 0) {
                happeningParts.push(`Cluster-backed support confirms real buyer interest`);
            }
            
            happeningParts.push(`Projections remain bullish (${proj.map(p => (p > 0 ? '+' : '') + Math.round(p)).join('/')}), suggesting buyer pressure will continue short-term`);
            
            guide.happening = happeningParts.join('. ') + '.';
            
            // What to do
            let todoParts = [];
            if (ldVel > 10 && ldClu > 0) {
                todoParts.push(`Strong bullish setup — look for entry on minor pullbacks`);
            } else if (ldVel < 0) {
                todoParts.push(`Lean bullish for dip buys only`);
            } else {
                todoParts.push(`Bullish bias — favor long positions`);
            }
            
            todoParts.push(`Don't chase into nearby resistance walls`);
            
            if (absorption === 'absorption_sell') {
                todoParts.push(`Note: Some hidden selling detected — size positions conservatively`);
            }
            
            todoParts.push(`Look for price to grind upward unless LD turns negative`);
            
            guide.todo = todoParts.join('. ') + '.';
            
            // Key zones
            guide.zones = `Support flows below: <span class="guide-price">${fmt(nearestSupport)}</span>` +
                `<br>Resistance walls above: <span class="guide-price">${fmt(nearestResist)}</span>` +
                `<br>Expect: Push into overhead walls, then consolidation or breakout.`;
            
            // Newbie
            guide.newbie = `"Buyers have the edge right now, but there's resistance above. Safer to buy dips, not breakouts."`;
        }
        // BEARISH SIGNAL
        else if (ldValue < -20 && projAllNegative && pressAbove > pressBelow) {
            guide.bias = 'bearish';
            
            let happeningParts = [];
            happeningParts.push(`Sellers show active pressure (${ldValue.toFixed(1)} ${this.symbol} LD)`);
            
            if (ldVel < -10) {
                happeningParts.push(`with strong near-price selling (VEL: ${ldVel.toFixed(1)})`);
            } else if (ldVel < 0) {
                happeningParts.push(`with moderate near-price resistance`);
            } else if (ldVel > 10) {
                happeningParts.push(`but some buyer momentum still present (VEL: +${ldVel.toFixed(1)})`);
            }
            
            if (clusterData.clusterBacked && ldClu < 0) {
                happeningParts.push(`Cluster-backed resistance confirms real seller interest`);
            }
            
            happeningParts.push(`Projections remain bearish (${proj.map(p => (p > 0 ? '+' : '') + Math.round(p)).join('/')}), suggesting sell pressure will continue`);
            
            guide.happening = happeningParts.join('. ') + '.';
            
            // What to do
            let todoParts = [];
            if (ldVel < -10 && ldClu < 0) {
                todoParts.push(`Strong bearish setup — look for short entry on bounces`);
            } else if (ldVel > 0) {
                todoParts.push(`Lean bearish but wait for bounces to short`);
            } else {
                todoParts.push(`Bearish bias — favor short positions or stay flat`);
            }
            
            todoParts.push(`Don't try to catch falling knives at support`);
            
            if (absorption === 'absorption_buy') {
                todoParts.push(`Note: Some hidden buying detected — sellers may be exhausting`);
            }
            
            todoParts.push(`Price likely to drift lower unless LD turns positive`);
            
            guide.todo = todoParts.join('. ') + '.';
            
            // Key zones
            guide.zones = `Support zones below: <span class="guide-price">${fmt(nearestSupport)}</span> (may break)` +
                `<br>Resistance walls above: <span class="guide-price">${fmt(nearestResist)}</span>` +
                `<br>Expect: Price to test supports, possibly break through.`;
            
            // Newbie
            guide.newbie = `"Sellers are in control. Don't buy yet — wait for selling to exhaust or prices will keep dropping."`;
        }
        // MIXED / CHOPPY
        else {
            guide.bias = 'neutral';
            
            let happeningParts = [];
            happeningParts.push(`Order flow is balanced (LD: ${ldValue > 0 ? '+' : ''}${ldValue.toFixed(1)} ${this.symbol})`);
            
            if (projMixed) {
                happeningParts.push(`Projections are mixed — no clear directional conviction`);
            }
            
            if (Math.abs(ldVel) < 10 && Math.abs(ldClu) < 10) {
                happeningParts.push(`Both velocity and cluster signals are weak — low conviction environment`);
            } else if ((ldVel > 0 && ldClu < 0) || (ldVel < 0 && ldClu > 0)) {
                happeningParts.push(`Velocity and clusters conflict — unclear who's really in control`);
            }
            
            if (absorption === 'absorption_neutral') {
                happeningParts.push(`Makers appear to be absorbing flow in both directions`);
            }
            
            guide.happening = happeningParts.join('. ') + '.';
            
            // What to do
            guide.todo = `🔄 Chop zone — wait for clarity. ` +
                `Don't force trades in either direction. ` +
                `Scalp only if you must, with tight stops. ` +
                `Watch for LD to break above +30 or below -30 for direction.`;
            
            // Key zones
            guide.zones = `Range support: <span class="guide-price">${fmt(nearestSupport)}</span>` +
                `<br>Range resistance: <span class="guide-price">${fmt(nearestResist)}</span>` +
                `<br>Expect: Sideways chop between these levels until breakout.`;
            
            // Newbie
            guide.newbie = `"Neither buyers nor sellers are winning. Best to wait — don't trade when it's this unclear."`;
        }
        
        // Add MM Model insight if significant
        if (mmModel.type !== 'neutral' && mmModel.description) {
            guide.happening += ` <span class="guide-highlight">[${mmModel.description}]</span>`;
        }
        
        return guide;
    }
    
    /**
     * Update LD Trading Guide UI
     */
    updateLDTradingGuide(ld, currentPrice) {
        const guide = this.generateLDTradingGuide(ld, currentPrice);
        
        const happeningEl = document.getElementById('ldGuideHappening');
        const todoEl = document.getElementById('ldGuideTodo');
        const zonesEl = document.getElementById('ldGuideZones');
        const newbieEl = document.getElementById('ldGuideNewbie');
        const newbieSection = document.querySelector('.ld-trading-guide .newbie-section');
        
        if (happeningEl) {
            happeningEl.innerHTML = guide.happening;
            happeningEl.classList.remove('bullish', 'bearish', 'warning', 'neutral');
            happeningEl.classList.add(guide.bias);
        }
        
        if (todoEl) {
            todoEl.innerHTML = guide.todo;
            todoEl.classList.remove('bullish', 'bearish', 'warning', 'neutral');
            todoEl.classList.add(guide.bias);
        }
        
        if (zonesEl) {
            zonesEl.innerHTML = guide.zones;
        }
        
        if (newbieEl) {
            newbieEl.innerHTML = guide.newbie;
        }
        
        if (newbieSection) {
            newbieSection.classList.remove('bearish-bg', 'warning-bg', 'neutral-bg');
            if (guide.bias === 'bearish') newbieSection.classList.add('bearish-bg');
            else if (guide.bias === 'warning') newbieSection.classList.add('warning-bg');
            else if (guide.bias === 'neutral') newbieSection.classList.add('neutral-bg');
        }
    }
    
    /**
     * Initialize LD Trading Guide toggle
     */
    initLDTradingGuideToggle() {
        const guideEl = document.querySelector('.ld-trading-guide');
        const toggleEl = document.getElementById('ldGuideToggle');
        
        if (!guideEl || !toggleEl) return;
        
        // Load saved state (default expanded)
        const savedState = localStorage.getItem('ldGuideExpanded');
        if (savedState === 'false') {
            guideEl.classList.remove('expanded');
        } else {
            guideEl.classList.add('expanded');
        }
        
        // Toggle handler
        toggleEl.addEventListener('click', () => {
            guideEl.classList.toggle('expanded');
            localStorage.setItem('ldGuideExpanded', guideEl.classList.contains('expanded'));
        });
    }
    
    /**
     * Draw LD Pressure Heatmap (sparkline showing pressure distribution)
     */
    drawLDHeatmap(container, pressureMap) {
        const bands = pressureMap.bands;
        if (!bands || bands.length === 0) return;
        
        // Find max volume for scaling
        const maxVolume = Math.max(...bands.map(b => b.totalVolume)) || 1;
        
        // Create sparkline bars
        let html = '<div class="ld-heatmap-bars">';
        
        bands.forEach(band => {
            const height = Math.max(2, (band.totalVolume / maxVolume) * 20);
            const netPressure = band.netPressure;
            const colorClass = netPressure > 5 ? 'bid-pressure' : netPressure < -5 ? 'ask-pressure' : 'neutral-pressure';
            const position = band.position === 'below' ? 'below' : 'above';
            
            html += `<div class="heatmap-bar ${colorClass} ${position}" 
                         style="height: ${height}px" 
                         title="${band.distancePercent}% ${position}: Bid ${band.bidVolume.toFixed(1)}, Ask ${band.askVolume.toFixed(1)}"></div>`;
        });
        
        html += '</div>';
        
        // Add strongest levels info
        if (pressureMap.strongestBid || pressureMap.strongestAsk) {
            html += '<div class="heatmap-summary">';
            if (pressureMap.strongestBid) {
                html += `<span class="heatmap-strongest bid">↓${pressureMap.strongestBid.distancePercent}%</span>`;
            }
            if (pressureMap.strongestAsk) {
                html += `<span class="heatmap-strongest ask">↑${pressureMap.strongestAsk.distancePercent}%</span>`;
            }
            html += '</div>';
        }
        
        container.innerHTML = html;
    }
    
    /**
     * Draw OBIC chart on canvas
     */
    drawOBICChart(obicData, currentPrice) {
        const canvas = document.getElementById('obicCanvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const rect = canvas.getBoundingClientRect();
        
        // Set canvas resolution
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        
        const width = rect.width;
        const height = rect.height;
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Show "waiting" message if no data
        if (!obicData || obicData.length === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for order book data...', width / 2, height / 2);
            return;
        }
        
        // Find min/max imbalance for scaling
        const imbalances = obicData.map(p => p.imbalance);
        const minImbalance = Math.min(...imbalances);
        const maxImbalance = Math.max(...imbalances);
        const imbalanceRange = maxImbalance - minImbalance || 1;
        
        // Find price range
        const prices = obicData.map(p => p.price);
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const priceRange = maxPrice - minPrice || 1;
        
        // Calculate zero line position
        const zeroY = height - ((-minImbalance) / imbalanceRange) * height;
        
        // Draw zero line
        ctx.strokeStyle = 'rgba(128, 128, 128, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(width, zeroY);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw current price line (vertical)
        if (currentPrice) {
            const currentX = ((currentPrice - minPrice) / priceRange) * width;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.beginPath();
            ctx.moveTo(currentX, 0);
            ctx.lineTo(currentX, height);
            ctx.stroke();
        }
        
        // Draw OBIC curve
        ctx.beginPath();
        ctx.lineWidth = 2;
        
        obicData.forEach((point, i) => {
            const x = (i / (obicData.length - 1)) * width;
            const y = height - ((point.imbalance - minImbalance) / imbalanceRange) * height;
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        // Create gradient for stroke
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.9)'); // Green (support side)
        gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)'); // White (mid)
        gradient.addColorStop(1, 'rgba(239, 68, 68, 0.9)'); // Red (resistance side)
        
        ctx.strokeStyle = gradient;
        ctx.stroke();
        
        // Fill area under/above zero
        ctx.globalAlpha = 0.15;
        
        // Fill positive area (green)
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        obicData.forEach((point, i) => {
            const x = (i / (obicData.length - 1)) * width;
            const y = height - ((point.imbalance - minImbalance) / imbalanceRange) * height;
            if (point.imbalance >= 0) {
                ctx.lineTo(x, y);
            } else {
                ctx.lineTo(x, zeroY);
            }
        });
        ctx.lineTo(width, zeroY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(16, 185, 129, 1)';
        ctx.fill();
        
        // Fill negative area (red)
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        obicData.forEach((point, i) => {
            const x = (i / (obicData.length - 1)) * width;
            const y = height - ((point.imbalance - minImbalance) / imbalanceRange) * height;
            if (point.imbalance <= 0) {
                ctx.lineTo(x, y);
            } else {
                ctx.lineTo(x, zeroY);
            }
        });
        ctx.lineTo(width, zeroY);
        ctx.closePath();
        ctx.fillStyle = 'rgba(239, 68, 68, 1)';
        ctx.fill();
        
        ctx.globalAlpha = 1;
        
        // Update OBIC analysis text
        const obicAnalysis = document.getElementById('obicAnalysis');
        if (obicAnalysis && obicData.length > 0) {
            obicAnalysis.classList.remove('bullish', 'bearish', 'neutral');
            
            // Calculate average imbalance and find dominant side
            const avgImbalance = obicData.reduce((sum, p) => sum + p.imbalance, 0) / obicData.length;
            const positiveArea = obicData.filter(p => p.imbalance > 0).length;
            const negativeArea = obicData.filter(p => p.imbalance < 0).length;
            const totalPoints = obicData.length;
            
            // Find the strongest imbalance point
            const maxPoint = obicData.reduce((max, p) => Math.abs(p.imbalance) > Math.abs(max.imbalance) ? p : max, obicData[0]);
            
            if (positiveArea > totalPoints * 0.65) {
                obicAnalysis.textContent = `More green = buyers control most prices — bullish`;
                obicAnalysis.classList.add('bullish');
            } else if (negativeArea > totalPoints * 0.65) {
                obicAnalysis.textContent = `More red = sellers control most prices — bearish`;
                obicAnalysis.classList.add('bearish');
            } else if (avgImbalance > 50) {
                obicAnalysis.textContent = `Overall more buyers than sellers — slight bullish`;
                obicAnalysis.classList.add('bullish');
            } else if (avgImbalance < -50) {
                obicAnalysis.textContent = `Overall more sellers than buyers — slight bearish`;
                obicAnalysis.classList.add('bearish');
            } else {
                obicAnalysis.textContent = `Even split — no clear winner between buyers/sellers`;
                obicAnalysis.classList.add('neutral');
            }
        }
    }
    
    // ========================================
    // REGIME ENGINE
    // ========================================
    
    /**
     * Update Regime Engine with new data
     * This calculates all regime signals and classifies the current market regime
     */
    updateRegimeEngine(levels, currentPrice, alpha) {
        if (!levels || !currentPrice) return;
        
        // Calculate core indicators (pass currentPrice for range filtering)
        const bpr = this.calculateBPR(levels);
        const ld = this.calculateLiquidityDelta(levels, currentPrice);
        const vwmp = this.calculateVWMP(levels, currentPrice);
        const ifv = this.calculateIFV(levels, currentPrice);
        const ldDelta = ld?.delta || 0;
        const bprRatio = bpr?.ratio || 1;
        // Use same alpha mode presets for regime stability (with sensitivity multiplier)
        const alphaPresetsBase = {
            marketMaker: {
                normEmaAlpha: 0.40,
                normStepMax: 0.12,
                minNorm: 0.15,
                ifvAlphaFactor: 1.2,
                renderMs: 300
            },
            swingTrader: {
                normEmaAlpha: 0.28,
                normStepMax: 0.08,
                minNorm: 0.25,
                ifvAlphaFactor: 0.9,
                renderMs: 600
            },
            investor: {
                normEmaAlpha: 0.18,
                normStepMax: 0.05,
                minNorm: 0.35,
                ifvAlphaFactor: 0.6,
                renderMs: 900
            }
        };
        const alphaMode = this.alphaMode || 'investor';
        const basePreset = alphaPresetsBase[alphaMode] || alphaPresetsBase.investor;
        
        // Apply sensitivity multiplier on top of defaults
        const sens = this.alphaSensitivityMultiplier || 1.0;
        const alphaPreset = {
            normEmaAlpha: Math.min(0.95, Math.max(0.001, basePreset.normEmaAlpha * sens)),
            normStepMax: Math.min(0.25, Math.max(0.001, basePreset.normStepMax * sens)),
            minNorm: Math.max(0.01, Math.min(0.5, basePreset.minNorm / sens)),
            ifvAlphaFactor: Math.min(2.0, Math.max(0.05, basePreset.ifvAlphaFactor * sens)),
            renderMs: Math.max(100, Math.min(5000, basePreset.renderMs / sens))
        };
        
        // Adaptive LD normalization (shared logic with alpha flow)
        const ldSamples = this.regimeEngine.ldSamples;
        ldSamples.push(ldDelta);
        if (ldSamples.length > 500) ldSamples.shift();

        const percentile = (arr, p) => {
            if (!arr.length) return 0;
            const idx = (arr.length - 1) * p;
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            if (lo === hi) return arr[lo];
            return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
        };

        let ldNorm = 0.5;
        if (ldSamples.length >= 20) {
            const sorted = [...ldSamples].sort((a, b) => a - b);
            const low = percentile(sorted, 0.05);
            const high = percentile(sorted, 0.95);
            const span = Math.max(high - low, 1e-6);
            const n = Math.max(0, Math.min(1, (ldDelta - low) / span));
            ldNorm = n * n * (3 - 2 * n); // smoothstep
        } else {
            const ldMax = 100;
            ldNorm = Math.max(0, Math.min(1, (ldDelta + ldMax) / (2 * ldMax)));
        }
        
        // Adaptive BPR normalization for regime use
        const bprSamples = this.regimeEngine.bprSamples;
        bprSamples.push(bprRatio);
        if (bprSamples.length > 500) bprSamples.shift();

        let bprNorm = 0.5;
        if (bprSamples.length >= 20) {
            const sortedBpr = [...bprSamples].sort((a, b) => a - b);
            const lowBpr = percentile(sortedBpr, 0.05);
            const highBpr = percentile(sortedBpr, 0.95);
            const spanBpr = Math.max(highBpr - lowBpr, 1e-6);
            const nBpr = Math.max(0, Math.min(1, (bprRatio - lowBpr) / spanBpr));
            bprNorm = nBpr * nBpr * (3 - 2 * nBpr);
        } else {
            if (bpr.ratio <= 0.8) bprNorm = 0;
            else if (bpr.ratio >= 1.2) bprNorm = 1;
            else bprNorm = (bpr.ratio - 0.8) / (1.2 - 0.8);
        }
        
        // Calculate ROC (Rate of Change) signals with smoothing based on mode
        const signals = this.regimeEngine.signals;
        const mode = this.regimeEngine.currentMode || 'investor';
        const modeSettings = this.regimeEngine.modePresets[mode] || this.regimeEngine.modePresets.marketMaker;
        const rocWindow = modeSettings.rocWindow || 2;
        
        // Helper function to calculate smoothed ROC using buffer
        const calculateSmoothedRoc = (buffer, currentValue, prevValue, windowSize) => {
            if (prevValue === null) return 0;
            
            // Calculate current tick's ROC
            const tickRoc = currentValue - prevValue;
            
            // Add to buffer
            buffer.push(tickRoc);
            
            // Trim buffer to window size
            while (buffer.length > windowSize) {
                buffer.shift();
            }
            
            // Return average ROC over the window
            if (buffer.length === 0) return 0;
            return buffer.reduce((sum, val) => sum + val, 0) / buffer.length;
        };
        
        // LD_ROC - Liquidity Delta Rate of Change (smoothed)
        signals.ld_roc = calculateSmoothedRoc(
            this.regimeEngine.ldBuffer, 
            ld.delta, 
            this.regimeEngine.prevLD, 
            rocWindow
        );
        this.regimeEngine.prevLD = ld.delta;
        
        // Z-Score normalize ldRoc for cross-asset consistency
        // This makes ldRoc comparable between BTC (±50) and SUI (±5000)
        const zs = this.regimeEngine.ldRocZScore;
        const rawLdRoc = signals.ld_roc;
        
        if (rawLdRoc !== 0) {
            // Update EMA of mean and variance
            const delta = rawLdRoc - zs.emaMean;
            zs.emaMean = zs.emaMean + zs.alpha * delta;
            zs.emaVar = (1 - zs.alpha) * zs.emaVar + zs.alpha * delta * delta;
            zs.warmupCount++;
            
            // Calculate z-score (only if warmed up and variance is meaningful)
            const stdDev = Math.sqrt(Math.max(zs.emaVar, 0.0001));
            if (zs.warmupCount >= zs.warmupMin && stdDev > 0) {
                signals.ld_roc_z = rawLdRoc / stdDev;  // Simplified: just scale by stdev
            } else {
                signals.ld_roc_z = 0;  // Not calibrated yet
            }
        } else {
            signals.ld_roc_z = 0;
        }
        
        // BPR_ROC - Book Pressure Rate of Change (smoothed)
        signals.bpr_roc = calculateSmoothedRoc(
            this.regimeEngine.bprBuffer, 
            bpr.ratio, 
            this.regimeEngine.prevBPR, 
            rocWindow
        );
        this.regimeEngine.prevBPR = bpr.ratio;
        
        // Alpha_ROC - Alpha Score Rate of Change (smoothed)
        if (alpha !== null && alpha !== undefined) {
            // Smooth alpha before ROC to reduce jitter-driven flips
            if (this.regimeEngine.alphaEma === null) {
                this.regimeEngine.alphaEma = alpha;
            } else {
                const a = this.regimeEngine.alphaEmaAlpha;
                this.regimeEngine.alphaEma = a * alpha + (1 - a) * this.regimeEngine.alphaEma;
            }
            const alphaSmoothed = this.regimeEngine.alphaEma;
            signals.alpha_roc = calculateSmoothedRoc(
                this.regimeEngine.alphaBuffer, 
                alphaSmoothed, 
                this.regimeEngine.prevAlpha, 
                rocWindow
            );
            this.regimeEngine.prevAlpha = alphaSmoothed;
            signals.alpha_smoothed = alphaSmoothed;
        } else {
            signals.alpha_roc = 0;
        }
        
        // VWMP_ext - Extension from VWMP (premium/discount)
        if (vwmp && vwmp > 0) {
            signals.vwmp_ext = (currentPrice - vwmp) / currentPrice;
        }
        
        // IFV_ext - Extension from IFV (premium/discount)
        if (ifv && ifv > 0) {
            signals.ifv_ext = (currentPrice - ifv) / currentPrice;
        }
        
        // Calculate liquidity structure signals
        const liquidityStructure = this.calculateLiquidityStructure(levels, currentPrice);
        signals.support_gap = liquidityStructure.support_gap;
        signals.resist_gap = liquidityStructure.resist_gap;
        signals.support_share = liquidityStructure.support_share;
        signals.resist_share = liquidityStructure.resist_share;
        signals.nearest_support = liquidityStructure.nearest_support;
        signals.nearest_resist = liquidityStructure.nearest_resist;
        signals.support_levels = liquidityStructure.support_levels;
        signals.resist_levels = liquidityStructure.resist_levels;
        signals.ld_norm = ldNorm;
        signals.bpr_norm = bprNorm;
        
        // Classify regime (potential new regime)
        const newRegime = this.classifyRegime(signals, bpr, ld, alpha, vwmp, ifv, currentPrice);
        
        // Get stabilization settings (mode and modeSettings already defined above)
        const minTicks = modeSettings.regimeMinTicks || 1;
        
        // Regime stabilization logic - prevents flickering
        const lastRegimeType = this.regimeEngine.lastRegime;
        const currentRegimeType = this.regimeEngine.currentRegime?.type;
        
        let regimeToApply = this.regimeEngine.currentRegime || newRegime;
        
        if (newRegime.type !== currentRegimeType) {
            // New regime detected - check if it's consistent with pending change
            if (newRegime.type === lastRegimeType) {
                // Same as pending regime, increment counter
                this.regimeEngine.regimeTickCount++;
            } else {
                // Different regime, reset counter and start tracking new one
                this.regimeEngine.regimeTickCount = 1;
                this.regimeEngine.lastRegime = newRegime.type;
            }
            
            // Only commit regime change after minTicks consecutive detections
            if (this.regimeEngine.regimeTickCount >= minTicks) {
                regimeToApply = newRegime;
                this.regimeEngine.currentRegime = newRegime;
                this.regimeEngine.regimeTickCount = 0;
                this.regimeEngine.lastRegime = newRegime.type;
            }
            // Otherwise keep the current regime (regimeToApply already set)
        } else {
            // Same as current regime - reset pending counter
            this.regimeEngine.regimeTickCount = 0;
            this.regimeEngine.lastRegime = currentRegimeType;
            regimeToApply = this.regimeEngine.currentRegime;
        }
        
        // Update UI with the stabilized regime
        this.updateRegimeUI(signals, regimeToApply, currentPrice);
    }
    
    /**
     * Calculate Liquidity Structure - gaps and volume shares
     */
    calculateLiquidityStructure(levels, currentPrice) {
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Get supports and resistances
        const supports = validLevels
            .filter(l => l.type === 'support' && parseFloat(l.price) < currentPrice)
            .map(l => ({ price: parseFloat(l.price), volume: parseFloat(l.volume) }))
            .sort((a, b) => b.price - a.price); // Nearest first
            
        const resistances = validLevels
            .filter(l => l.type === 'resistance' && parseFloat(l.price) > currentPrice)
            .map(l => ({ price: parseFloat(l.price), volume: parseFloat(l.volume) }))
            .sort((a, b) => a.price - b.price); // Nearest first
        
        // Find nearest support and resistance
        const nearestSupport = supports.length > 0 ? supports[0].price : currentPrice * 0.9;
        const nearestResist = resistances.length > 0 ? resistances[0].price : currentPrice * 1.1;
        
        // Calculate gaps (as percentage)
        const supportGap = (currentPrice - nearestSupport) / currentPrice;
        const resistGap = (nearestResist - currentPrice) / currentPrice;
        
        // Calculate volume shares within a dynamic range (tighter for large caps)
        let rangePercent = 0.20;
        if (currentPrice > 10000) rangePercent = 0.08;
        else if (currentPrice > 1000) rangePercent = 0.10;
        else if (currentPrice > 100) rangePercent = 0.12;
        else if (currentPrice > 10) rangePercent = 0.15;
        // microcaps keep wider band
        const lowerBound = currentPrice * (1 - rangePercent);
        const upperBound = currentPrice * (1 + rangePercent);
        
        const supportVol = supports
            .filter(s => s.price >= lowerBound)
            .reduce((sum, s) => sum + s.volume, 0);
            
        const resistVol = resistances
            .filter(r => r.price <= upperBound)
            .reduce((sum, r) => sum + r.volume, 0);
        
        const totalVol = supportVol + resistVol;
        const supportShare = totalVol > 0 ? supportVol / totalVol : 0.5;
        const resistShare = totalVol > 0 ? resistVol / totalVol : 0.5;
        
        return {
            support_gap: supportGap,
            resist_gap: resistGap,
            support_share: supportShare,
            resist_share: resistShare,
            nearest_support: nearestSupport,
            nearest_resist: nearestResist,
            support_levels: supports.length,
            resist_levels: resistances.length
        };
    }
    
    /**
     * Classify Market Regime based on all signals
     * Optimized Regime Classification Matrix with Newbie-Friendly Summaries
     * Sensitivity adjusted by regime mode (Market Maker / Swing / Investor)
     */
    classifyRegime(signals, bpr, ld, alpha, vwmp, ifv, currentPrice) {
        const regime = {
            type: 'unknown',
            icon: '⏳',
            name: 'Analyzing',
            description: 'Collecting data...',
            interpretation: '',
            newbieSummary: '',
            cssClass: ''
        };
        
        // Get mode settings for threshold adjustment
        const mode = this.regimeEngine.currentMode || 'investor';
        const modeSettings = this.regimeEngine.modePresets[mode] || this.regimeEngine.modePresets.marketMaker;
        const tm = modeSettings.thresholdMult; // Threshold multiplier
        
        // Extract values for easier use
        const alphaValue = signals.alpha_smoothed !== undefined ? signals.alpha_smoothed : (alpha || 50);
        const ldValue = ld?.delta || 0;
        const ldNorm = signals.ld_norm !== undefined ? signals.ld_norm : 0.5;
        const bprValue = bpr?.ratio || 1;
        const bprNorm = signals.bpr_norm !== undefined ? signals.bpr_norm : 0.5;
        const ldRoc = signals.ld_roc || 0;
        const ldRocZ = signals.ld_roc_z || 0;  // Z-score normalized ldRoc
        const bprRoc = signals.bpr_roc || 0;
        const alphaRoc = signals.alpha_roc || 0;
        const vwmpExt = signals.vwmp_ext || 0;
        const ifvExt = signals.ifv_ext || 0;
        const supportShare = (signals.support_share || 0.5) * 100; // Convert to percentage
        const resistShare = (signals.resist_share || 0.5) * 100;
        const supportGap = signals.support_gap || 0;
        const resistGap = signals.resist_gap || 0;
        const supportLevels = signals.support_levels || 0;
        const resistLevels = signals.resist_levels || 0;
        
        // Check if z-score is calibrated (warmup complete)
        const isCalibrated = this.regimeEngine.ldRocZScore.warmupCount >= this.regimeEngine.ldRocZScore.warmupMin;
        
        // Calculate key price levels for suggestions
        const nearestSupport = signals.nearest_support || (currentPrice * 0.97);
        const nearestResist = signals.nearest_resist || (currentPrice * 1.03);
        const fairValue = vwmp || ifv || currentPrice;
        
        // Format price for display
        const fmt = (price) => price < 10 ? price.toFixed(4) : price.toLocaleString(undefined, {maximumFractionDigits: 2});
        
        // ========================================
        // REGIME CLASSIFICATION MATRIX (Priority Order)
        // Thresholds scaled by mode's thresholdMult (tm)
        // ========================================
        
        // ⚠️ 1. VACUUM_DOWN - HIGHEST PRIORITY (Danger Zone)
        // Rule: SupportGap > 0.06 AND VolumeShare_support < 40
        if (supportLevels >= 3 && supportGap > 0.06 && supportShare < 40) {
            regime.type = 'vacuum_down';
            regime.icon = '🚨';
            regime.name = 'VACUUM DOWN';
            regime.cssClass = 'liquidity-vacuum';
            regime.description = 'Thin support below — HIGH crash risk';
            regime.interpretation = `🚨 DANGER ZONE: Only ${supportShare.toFixed(0)}% of nearby orders are bids, with a ${(supportGap * 100).toFixed(1)}% gap to the next support. If sellers step in, price could flash crash.`;
            regime.newbieSummary = `
🆘 WHAT'S HAPPENING: There's almost no one wanting to buy below the current price. It's like standing on thin ice.

⚡ WHAT TO DO:
• DO NOT buy right now
• If you're already long, consider taking profits or setting a tight stop loss at $${fmt(currentPrice * 0.98)}
• Wait for buyers to return before entering

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• Danger zone starts: $${fmt(currentPrice * (1 - supportGap))}
• Safe to buy again: When support share goes above 45%

⚠️ RISK: Very High - Price can drop fast without warning`;
            return regime;
        }
        
        // ⚠️ 2. VACUUM_UP - HIGHEST PRIORITY (Danger Zone)
        // Rule: ResistGap > 0.06 AND VolumeShare_resist < 40
        if (resistLevels >= 3 && resistGap > 0.06 && resistShare < 40) {
            regime.type = 'vacuum_up';
            regime.icon = '🚨';
            regime.name = 'VACUUM UP';
            regime.cssClass = 'liquidity-vacuum';
            regime.description = 'Thin resistance above — HIGH squeeze risk';
            regime.interpretation = `🚨 DANGER ZONE: Only ${resistShare.toFixed(0)}% of nearby orders are asks, with a ${(resistGap * 100).toFixed(1)}% gap to the next resistance. If buyers step in, price could squeeze violently.`;
            regime.newbieSummary = `
🆘 WHAT'S HAPPENING: There's almost no one wanting to sell above the current price. Price can rocket up suddenly.

⚡ WHAT TO DO:
• DO NOT short right now
• If you're already short, consider closing or setting a tight stop loss at $${fmt(currentPrice * 1.02)}
• This could be a buying opportunity if you're quick

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• Squeeze target: $${fmt(currentPrice * (1 + resistGap))}
• Safe to short again: When resistance share goes above 45%

⚠️ RISK: Very High - Price can spike fast without warning`;
            return regime;
        }
        
        // 🚀 3. EXPANSION - Major move in progress
        // Rule: |LD_ROC_Z| > 2.0 (z-score normalized) OR |BPR_ROC| > 0.10*tm OR |Alpha_ROC| > 3*tm
        // Z-score threshold: 2.0 = 2 standard deviations (statistically significant)
        // Only use z-score if calibrated, otherwise skip expansion detection
        const ldRocExpansion = isCalibrated ? Math.abs(ldRocZ) > 2.0 : false;
        const isExpansion = ldRocExpansion || Math.abs(bprRoc) > (0.10 * tm) || Math.abs(alphaRoc) > (3 * tm);
        
        if (isExpansion) {
            // Use z-score sign for direction if calibrated, otherwise fall back to raw
            const isBullish = isCalibrated ? (ldRocZ > 0 || bprRoc > 0 || alphaRoc > 0) : (ldRoc > 0 || bprRoc > 0 || alphaRoc > 0);
            
            if (isBullish) {
                regime.type = 'expansion_up';
                regime.icon = '🚀';
                regime.name = 'EXPANSION UP';
                regime.cssClass = 'expansion';
                regime.description = 'Bullish breakout in progress — momentum surging';
                regime.interpretation = `🚀 BREAKOUT! Massive buying pressure detected. LD_z: +${ldRocZ.toFixed(2)}σ, BPR_ROC: +${bprRoc.toFixed(2)}, Alpha_ROC: +${alphaRoc.toFixed(1)}. This is a momentum move.`;
                regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Big buyers are flooding in! The market is breaking out to the upside with strong momentum.

⚡ WHAT TO DO:
• DO NOT fight this move (no shorting!)
• If you're in, hold and enjoy the ride
• If you're out, wait for a small pullback to enter
• Buy dips toward $${fmt(currentPrice * 0.99)} if you get the chance

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• First target: $${fmt(nearestResist)}
• Stop loss if buying: $${fmt(currentPrice * 0.97)}

✅ CONFIDENCE: High - Momentum is on your side`;
            } else {
                regime.type = 'expansion_down';
                regime.icon = '💥';
                regime.name = 'EXPANSION DOWN';
                regime.cssClass = 'expansion';
                regime.description = 'Bearish breakdown in progress — panic selling';
                regime.interpretation = `💥 BREAKDOWN! Massive selling pressure detected. LD_z: ${ldRocZ.toFixed(2)}σ, BPR_ROC: ${bprRoc.toFixed(2)}, Alpha_ROC: ${alphaRoc.toFixed(1)}. This is a panic move.`;
                regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Big sellers are dumping! The market is breaking down with strong selling momentum.

⚡ WHAT TO DO:
• DO NOT buy this dip — it's not over yet!
• If you're long, consider exiting or set tight stops
• Wait for panic to subside before buying
• Potential short opportunity on bounces toward $${fmt(currentPrice * 1.01)}

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• First target: $${fmt(nearestSupport)}
• Don't buy until stabilization around: $${fmt(nearestSupport * 0.98)}

⚠️ WARNING: Don't catch falling knives`;
            }
            return regime;
        }
        
        // 🔷 4. COMPRESSION - Squeeze building
        // Rule: |VWMP_ext| < 0.02*tm AND SupportGap < 0.02*tm AND ResistGap < 0.02*tm AND |LD_ROC_Z| < 1.5 AND |BPR_ROC| < 0.05*tm
        // Also defaults to compression during warmup period
        // Z-score threshold 1.5 = within 1.5 standard deviations (covers 87% of normal distribution)
        const ldRocQuiet = isCalibrated ? Math.abs(ldRocZ) < 1.5 : true;
        const isCompression = Math.abs(vwmpExt) < (0.02 * tm) && 
                              supportGap < (0.02 * tm) && 
                              resistGap < (0.02 * tm) && 
                              ldRocQuiet && 
                              Math.abs(bprRoc) < (0.05 * tm);
        
        if (isCompression) {
            regime.type = 'compression';
            regime.icon = '🔷';
            regime.name = 'COMPRESSION';
            regime.cssClass = 'compression';
            regime.description = 'Low volatility squeeze — big move coming soon';
            regime.interpretation = `⏳ Price is coiling in a tight range. VWMP_ext: ${(vwmpExt * 100).toFixed(2)}%, Support gap: ${(supportGap * 100).toFixed(1)}%, Resist gap: ${(resistGap * 100).toFixed(1)}%. Energy is building for a breakout.`;
            regime.newbieSummary = `
🎯 WHAT'S HAPPENING: The market is super quiet — like a coiled spring ready to explode. Price is stuck in a tiny range waiting to pick a direction.

⚡ WHAT TO DO:
• Don't trade yet — wait for the breakout!
• Set alerts at $${fmt(currentPrice * 1.02)} (bullish breakout) and $${fmt(currentPrice * 0.98)} (bearish breakdown)
• Once it breaks, follow the direction

📍 KEY LEVELS:
• Current range: $${fmt(currentPrice * 0.98)} to $${fmt(currentPrice * 1.02)}
• Buy if breaks above: $${fmt(currentPrice * 1.02)}
• Sell/Short if breaks below: $${fmt(currentPrice * 0.98)}

⏰ PATIENCE: Big move is coming, just wait for confirmation`;
            return regime;
        }
        
        // 🟣 5. ACCUMULATION - Smart money buying
        // Rule: LD > 0 AND LD_ROC > 0 AND Price < VWMP AND Price < IFV AND VolumeShare_support > 55
        const isAccumulation = ldValue > 0 && 
                               ldRoc > 0 && 
                               currentPrice < (vwmp || currentPrice * 1.1) && 
                               currentPrice < (ifv || currentPrice * 1.1) && 
                               supportShare > 55;
        
        if (isAccumulation) {
            const discount = ((fairValue - currentPrice) / currentPrice * 100).toFixed(1);
            regime.type = 'accumulation';
            regime.icon = '🟣';
            regime.name = 'ACCUMULATION';
            regime.cssClass = 'accumulation';
            regime.description = 'Smart money quietly buying — bullish setup forming';
            regime.interpretation = `🔍 Big players are loading up! LD: +${ldValue.toFixed(0)} (buyers dominating), Support share: ${supportShare.toFixed(0)}%. Price is ${discount}% below fair value. Classic accumulation pattern.`;
            regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Savvy traders are quietly buying while price is low. This often happens before a big move up. The market is "on sale"!

⚡ WHAT TO DO:
• This is a BUYING opportunity
• Start building a position in small chunks (don't go all-in at once)
• Set a stop loss at $${fmt(nearestSupport * 0.98)} just in case

📍 KEY LEVELS:
• Current price: $${fmt(currentPrice)} (${discount}% below fair value!)
• Fair value target: $${fmt(fairValue)}
• Good entry zone: $${fmt(currentPrice)} to $${fmt(currentPrice * 0.99)}
• Stop loss: $${fmt(nearestSupport * 0.98)}

💰 POTENTIAL GAIN: ${discount}% to fair value, possibly more`;
            return regime;
        }
        
        // 🟠 6. DISTRIBUTION - Smart money selling
        // Rule: LD < 0 AND LD_ROC < 0 AND Price > VWMP AND Price > IFV AND VolumeShare_resist > 55
        const isDistribution = ldValue < 0 && 
                               ldRoc < 0 && 
                               currentPrice > (vwmp || currentPrice * 0.9) && 
                               currentPrice > (ifv || currentPrice * 0.9) && 
                               resistShare > 55;
        
        if (isDistribution) {
            const premium = ((currentPrice - fairValue) / currentPrice * 100).toFixed(1);
            regime.type = 'distribution';
            regime.icon = '🟠';
            regime.name = 'DISTRIBUTION';
            regime.cssClass = 'distribution';
            regime.description = 'Smart money quietly selling — bearish setup forming';
            regime.interpretation = `🔍 Big players are unloading! LD: ${ldValue.toFixed(0)} (sellers dominating), Resistance share: ${resistShare.toFixed(0)}%. Price is ${premium}% above fair value. Classic distribution pattern.`;
            regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Savvy traders are quietly selling while price is high. This often happens before a drop. The market is "overpriced"!

⚡ WHAT TO DO:
• This is a SELLING opportunity (or take profits if you're long)
• Consider shorting or at least don't buy here
• If you're holding, set a stop loss at $${fmt(nearestResist * 1.02)}

📍 KEY LEVELS:
• Current price: $${fmt(currentPrice)} (${premium}% ABOVE fair value!)
• Fair value target: $${fmt(fairValue)}
• Resistance ceiling: $${fmt(nearestResist)}
• Take profits above: $${fmt(currentPrice * 1.01)}

⚠️ POTENTIAL DROP: ${premium}% to fair value, possibly more`;
            return regime;
        }
        
        // 🟢 7. UPTREND - Bullish trend
        // Rule: Alpha > 65 AND LD_ROC > 0 AND BPR > 1.1 AND IFV_ext < 0.05
        const isUptrend = alphaValue > 65 && 
                          ldRoc > 0 && 
                          bprValue > 1.1 && 
                          ifvExt < 0.05;
        
        if (isUptrend) {
            const strength = alphaValue > 75 ? 'STRONG' : 'MODERATE';
            regime.type = 'uptrend';
            regime.icon = '🟢';
            regime.name = 'UPTREND';
            regime.cssClass = 'uptrend';
            regime.description = `${strength} uptrend — buy dips, don't short`;
            regime.interpretation = `📈 Uptrend confirmed! Alpha: ${alphaValue}, BPR: ${bprValue.toFixed(2)} (buyers winning), LD rising (+${ldRoc.toFixed(1)}/bar). The trend is your friend.`;
            regime.newbieSummary = `
🎯 WHAT'S HAPPENING: The market is clearly going UP! Buyers are in control and the trend is strong. This is a "follow the crowd" situation.

⚡ WHAT TO DO:
• BUY on dips — every pullback is a buying opportunity
• Don't try to short or bet against this trend
• Hold your longs and let them run

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• Buy zone (dips): $${fmt(nearestSupport)} to $${fmt(currentPrice * 0.99)}
• Stop loss: $${fmt(nearestSupport * 0.97)}
• Let winners run to: $${fmt(nearestResist)} and beyond

✅ TREND STRENGTH: ${strength} (Alpha: ${alphaValue}/100)`;
            return regime;
        }
        
        // 🔴 8. DOWNTREND - Bearish trend
        // Rule: Alpha < 35 AND LD_ROC < 0 AND BPR < 0.9 AND IFV_ext > 0.05
        const isDowntrend = alphaValue < 35 && 
                            ldRoc < 0 && 
                            bprValue < 0.9 && 
                            Math.abs(ifvExt) > 0.05;
        
        if (isDowntrend) {
            const strength = alphaValue < 25 ? 'STRONG' : 'MODERATE';
            regime.type = 'downtrend';
            regime.icon = '🔴';
            regime.name = 'DOWNTREND';
            regime.cssClass = 'downtrend';
            regime.description = `${strength} downtrend — sell rallies, don't buy`;
            regime.interpretation = `📉 Downtrend confirmed! Alpha: ${alphaValue}, BPR: ${bprValue.toFixed(2)} (sellers winning), LD falling (${ldRoc.toFixed(1)}/bar). Don't fight the trend.`;
            regime.newbieSummary = `
🎯 WHAT'S HAPPENING: The market is clearly going DOWN! Sellers are in control and the trend is bearish. Don't try to be a hero.

⚡ WHAT TO DO:
• SELL or SHORT on rallies — every bounce is a selling opportunity  
• Don't try to buy dips — you'll lose money
• If you're holding, consider exiting or setting tight stops

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• Sell zone (rallies): $${fmt(currentPrice * 1.01)} to $${fmt(nearestResist)}
• Stop loss if shorting: $${fmt(nearestResist * 1.03)}
• Downside target: $${fmt(nearestSupport)}

⚠️ TREND STRENGTH: ${strength} (Alpha: ${alphaValue}/100) - Don't fight this`;
            return regime;
        }
        
        // 🟡 9. MEAN REVERSION - Stretched, expect pullback
        // Rule: 40 < Alpha < 60 AND (VWMP_ext > 0.03 OR IFV_ext > 0.06)
        const isMeanReversion = alphaValue > 40 && alphaValue < 60 && 
                                (Math.abs(vwmpExt) > 0.03 || Math.abs(ifvExt) > 0.06);
        
        if (isMeanReversion) {
            const stretched = vwmpExt > 0 || ifvExt > 0 ? 'above' : 'below';
            const extentPct = Math.max(Math.abs(vwmpExt), Math.abs(ifvExt)) * 100;
            
            regime.type = 'mean_reversion';
            regime.icon = '🟡';
            regime.name = 'MEAN REVERSION';
            regime.cssClass = 'mean-reversion';
            regime.description = `Price stretched ${stretched} fair value — expect pullback`;
            regime.interpretation = `🔄 Mean reversion setup! Price is ${extentPct.toFixed(1)}% ${stretched} fair value ($${fmt(fairValue)}). No strong trend (Alpha: ${alphaValue}). Market wants to snap back.`;
            
            if (stretched === 'above') {
                regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Price got too expensive compared to "fair value." It's like a rubber band stretched too far — it wants to snap back down.

⚡ WHAT TO DO:
• Consider SELLING or SHORTING here
• Don't buy at these elevated prices
• Target a move back to fair value

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)} (${extentPct.toFixed(1)}% TOO HIGH)
• Fair value target: $${fmt(fairValue)}
• Short entry: $${fmt(currentPrice)} to $${fmt(currentPrice * 1.01)}
• Stop loss: $${fmt(currentPrice * 1.03)}

💰 EXPECTED MOVE: Down ${extentPct.toFixed(1)}% toward $${fmt(fairValue)}`;
            } else {
                regime.newbieSummary = `
🎯 WHAT'S HAPPENING: Price got too cheap compared to "fair value." It's like a rubber band stretched too far — it wants to snap back up.

⚡ WHAT TO DO:
• Consider BUYING here
• This is a discount opportunity
• Target a move back to fair value

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)} (${extentPct.toFixed(1)}% TOO LOW)
• Fair value target: $${fmt(fairValue)}
• Buy entry: $${fmt(currentPrice * 0.99)} to $${fmt(currentPrice)}
• Stop loss: $${fmt(currentPrice * 0.97)}

💰 EXPECTED MOVE: Up ${extentPct.toFixed(1)}% toward $${fmt(fairValue)}`;
            }
            return regime;
        }
        
        // ⚪ NEUTRAL - No clear setup
        regime.type = 'neutral';
        regime.icon = '⚪';
        regime.name = 'NEUTRAL';
        regime.cssClass = 'neutral';
        regime.description = 'No clear regime — patience required';
        regime.interpretation = `⏸ Market is choppy. Alpha: ${alphaValue} (neutral), BPR: ${bprValue.toFixed(2)} (balanced). No high-probability setup detected.`;
        regime.newbieSummary = `
🎯 WHAT'S HAPPENING: The market can't decide which way to go. It's choppy and directionless — like a coin flip.

⚡ WHAT TO DO:
• DO NOTHING — this is not the time to trade
• Wait for a clear regime to develop
• Set alerts and check back later
• If you must trade, keep positions very small

📍 KEY LEVELS:
• Current: $${fmt(currentPrice)}
• Watch for breakout above: $${fmt(nearestResist)}
• Watch for breakdown below: $${fmt(nearestSupport)}

⏰ PATIENCE: Wait for the market to show its hand`;
        
        return regime;
    }
    
    /**
     * Update Regime Engine UI
     */
    updateRegimeUI(signals, regime, currentPrice) {
        // Update main regime display
        const regimeIcon = document.getElementById('regimeIcon');
        const regimeName = document.getElementById('regimeName');
        const regimeDesc = document.getElementById('regimeDescription');
        const regimeInterp = document.getElementById('regimeInterpretation');
        
        if (regimeIcon) regimeIcon.textContent = regime.icon;
        if (regimeName) {
            regimeName.textContent = regime.name;
            regimeName.className = 'regime-name ' + regime.cssClass;
        }
        if (regimeDesc) regimeDesc.textContent = regime.description;
        if (regimeInterp) {
            regimeInterp.querySelector('.interpretation-text').textContent = regime.interpretation;
            regimeInterp.className = 'regime-interpretation';
            if (regime.type.includes('uptrend') || regime.type.includes('accumulation') || regime.type === 'expansion_up') {
                regimeInterp.classList.add('bullish');
            } else if (regime.type.includes('downtrend') || regime.type.includes('distribution') || regime.type === 'expansion_down') {
                regimeInterp.classList.add('bearish');
            } else if (regime.type.includes('vacuum')) {
                regimeInterp.classList.add('warning');
            } else {
                regimeInterp.classList.add('neutral');
            }
        }
        
        // Update Newbie Summary (collapsible, default hidden)
        const newbieSummary = document.getElementById('regimeNewbieSummary');
        if (newbieSummary && regime.newbieSummary) {
            const isExpanded = localStorage.getItem('newbieSummaryExpanded') === 'true';
            const newHtml = this.formatNewbieSummary(regime.newbieSummary, regime.type, isExpanded);
            // Only update if content changed (prevents flicker)
            if (newbieSummary.innerHTML !== newHtml) {
                newbieSummary.innerHTML = newHtml;
            }
            newbieSummary.style.display = 'block';
            
            // Setup click handler for toggle (only once)
            if (!newbieSummary.dataset.initialized) {
                newbieSummary.dataset.initialized = 'true';
                newbieSummary.addEventListener('click', (e) => {
                    if (e.target.closest('.newbie-toggle')) {
                        const content = newbieSummary.querySelector('.newbie-content');
                        const toggle = newbieSummary.querySelector('.newbie-toggle');
                        const isCurrentlyExpanded = content.style.display !== 'none';
                        
                        content.style.display = isCurrentlyExpanded ? 'none' : 'block';
                        toggle.classList.toggle('expanded', !isCurrentlyExpanded);
                        localStorage.setItem('newbieSummaryExpanded', !isCurrentlyExpanded);
                    }
                });
            }
        } else if (newbieSummary) {
            newbieSummary.style.display = 'none';
        }
        
        // Update Momentum signals
        this.updateRocBar('ldRoc', signals.ld_roc, 50); // LD_ROC max ~50 BTC
        this.updateRocBar('bprRoc', signals.bpr_roc * 100, 20); // BPR_ROC max ~0.2 (scaled to %)
        this.updateRocBar('alphaRoc', signals.alpha_roc, 20); // Alpha_ROC max ~20 points
        
        // Update Extension values
        const vwmpExtEl = document.getElementById('vwmpExtValue');
        const vwmpHint = document.getElementById('vwmpExtHint');
        const ifvExtEl = document.getElementById('ifvExtValue');
        const ifvHint = document.getElementById('ifvExtHint');
        
        if (vwmpExtEl) {
            const vwmpPct = (signals.vwmp_ext * 100);
            vwmpExtEl.textContent = (vwmpPct >= 0 ? '+' : '') + vwmpPct.toFixed(2) + '%';
            vwmpExtEl.className = 'regime-value ext ' + (vwmpPct > 0 ? 'positive' : vwmpPct < 0 ? 'negative' : '');
        }
        if (vwmpHint) {
            const absVwmp = Math.abs(signals.vwmp_ext);
            if (absVwmp < 0.01) {
                vwmpHint.textContent = 'at fair';
                vwmpHint.className = 'regime-hint fair';
            } else if (absVwmp < 0.04) {
                vwmpHint.textContent = signals.vwmp_ext > 0 ? 'mild premium' : 'mild discount';
                vwmpHint.className = 'regime-hint ' + (signals.vwmp_ext > 0 ? 'premium' : 'discount');
            } else {
                vwmpHint.textContent = signals.vwmp_ext > 0 ? 'stretched!' : 'stretched!';
                vwmpHint.className = 'regime-hint stretched';
            }
        }
        
        if (ifvExtEl) {
            const ifvPct = (signals.ifv_ext * 100);
            ifvExtEl.textContent = (ifvPct >= 0 ? '+' : '') + ifvPct.toFixed(2) + '%';
            ifvExtEl.className = 'regime-value ext ' + (ifvPct > 0 ? 'positive' : ifvPct < 0 ? 'negative' : '');
        }
        if (ifvHint) {
            const absIfv = Math.abs(signals.ifv_ext);
            if (absIfv < 0.01) {
                ifvHint.textContent = 'at fair';
                ifvHint.className = 'regime-hint fair';
            } else if (absIfv < 0.04) {
                ifvHint.textContent = signals.ifv_ext > 0 ? 'mild premium' : 'mild discount';
                ifvHint.className = 'regime-hint ' + (signals.ifv_ext > 0 ? 'premium' : 'discount');
            } else {
                ifvHint.textContent = signals.ifv_ext > 0 ? 'stretched!' : 'stretched!';
                ifvHint.className = 'regime-hint stretched';
            }
        }
        
        // Update Liquidity Structure
        const supportGapEl = document.getElementById('supportGapValue');
        const resistGapEl = document.getElementById('resistGapValue');
        
        if (supportGapEl) {
            const gapPct = (signals.support_gap * 100).toFixed(1);
            supportGapEl.textContent = gapPct + '%';
            supportGapEl.className = 'gap-value ' + this.getGapClass(signals.support_gap);
        }
        
        if (resistGapEl) {
            const gapPct = (signals.resist_gap * 100).toFixed(1);
            resistGapEl.textContent = gapPct + '%';
            resistGapEl.className = 'gap-value ' + this.getGapClass(signals.resist_gap);
        }
        
        // Update Volume Share bars
        const supportShareBar = document.getElementById('supportShareBar');
        const resistShareBar = document.getElementById('resistShareBar');
        const supportShareLabel = document.getElementById('supportShareLabel');
        const resistShareLabel = document.getElementById('resistShareLabel');
        
        if (supportShareBar && resistShareBar) {
            const supportPct = signals.support_share * 100;
            const resistPct = signals.resist_share * 100;
            
            supportShareBar.style.width = supportPct + '%';
            resistShareBar.style.width = resistPct + '%';
            
            if (supportShareLabel) supportShareLabel.textContent = supportPct.toFixed(0) + '%';
            if (resistShareLabel) resistShareLabel.textContent = resistPct.toFixed(0) + '%';
        }
        
        // Update Regime Transition Probabilities
        const probabilities = this.computeRegimeProbabilities(signals, regime.type);
        this.updateRegimeTransitionUI(probabilities, signals);
    }
    
    /**
     * Compute probabilities for each potential next regime
     * Based on signal conditions and momentum directions
     * Sensitivity adjusted by regime mode
     */
    computeRegimeProbabilities(signals, currentRegime) {
        // Get mode settings
        const mode = this.regimeEngine.currentMode || 'investor';
        const modeSettings = this.regimeEngine.modePresets[mode] || this.regimeEngine.modePresets.marketMaker;
        const tm = modeSettings.thresholdMult;
        const probMinDelta = modeSettings.probMinDelta;
        
        // Initialize base probabilities (slight bias toward current regime)
        const probs = {
            uptrend: 10,
            downtrend: 10,
            compression: 10,
            accumulation: 10,
            distribution: 10,
            expansion: 10,
            mean_reversion: 10,
            vacuum_up: 5,
            vacuum_down: 5
        };
        
        const ldRoc = signals.ld_roc || 0;
        const bprRoc = signals.bpr_roc || 0;
        const alphaRoc = signals.alpha_roc || 0;
        const vwmpExt = signals.vwmp_ext || 0;
        const ifvExt = signals.ifv_ext || 0;
        const supportGap = signals.support_gap || 0;
        const resistGap = signals.resist_gap || 0;
        
        // Scale signal contributions by inverse of threshold (more sensitive = higher scores)
        const sensitivity = 1 / tm;
        const supportShare = signals.support_share || 0.5;
        const resistShare = signals.resist_share || 0.5;
        
        // ========================================
        // UPTREND signals (scaled by sensitivity)
        // ========================================
        if (ldRoc > 3 / tm) probs.uptrend += Math.round(15 * sensitivity);           // Strong LD momentum up
        if (ldRoc > 0) probs.uptrend += Math.round(8 * sensitivity);                  // LD trending up
        if (bprRoc > 0.05 / tm) probs.uptrend += Math.round(12 * sensitivity);       // BPR increasing
        if (alphaRoc > 2 / tm) probs.uptrend += Math.round(10 * sensitivity);        // Alpha momentum up
        if (ifvExt < -0.02 * tm) probs.uptrend += Math.round(8 * sensitivity);       // Price below IFV
        if (supportShare > 0.6) probs.uptrend += 6;                                   // Strong support below
        
        // ========================================
        // DOWNTREND signals (scaled by sensitivity)
        // ========================================
        if (ldRoc < -3 / tm) probs.downtrend += Math.round(15 * sensitivity);        // Strong LD momentum down
        if (ldRoc < 0) probs.downtrend += Math.round(8 * sensitivity);                // LD trending down
        if (bprRoc < -0.05 / tm) probs.downtrend += Math.round(12 * sensitivity);    // BPR decreasing
        if (alphaRoc < -2 / tm) probs.downtrend += Math.round(10 * sensitivity);     // Alpha momentum down
        if (ifvExt > 0.02 * tm) probs.downtrend += Math.round(8 * sensitivity);      // Price above IFV
        if (resistShare > 0.6) probs.downtrend += 6;                                  // Strong resistance above
        
        // ========================================
        // COMPRESSION signals (scaled by sensitivity)
        // ========================================
        if (Math.abs(vwmpExt) < 0.015 * tm) probs.compression += Math.round(12 * sensitivity);  // Price near VWMP
        if (Math.abs(ifvExt) < 0.02 * tm) probs.compression += Math.round(10 * sensitivity);    // Price near IFV
        if (supportGap < 0.02 * tm && resistGap < 0.02 * tm) probs.compression += Math.round(15 * sensitivity);  // Tight range
        if (Math.abs(ldRoc) < 2 * tm) probs.compression += Math.round(8 * sensitivity);         // Low LD momentum
        if (Math.abs(bprRoc) < 0.03 * tm) probs.compression += Math.round(8 * sensitivity);     // Low BPR momentum
        if (Math.abs(alphaRoc) < 1 * tm) probs.compression += Math.round(6 * sensitivity);      // Stable alpha
        
        // ========================================
        // EXPANSION signals (scaled by sensitivity)
        // ========================================
        if (Math.abs(ldRoc) > 8 / tm) probs.expansion += Math.round(20 * sensitivity);          // High LD momentum
        if (Math.abs(bprRoc) > 0.12 / tm) probs.expansion += Math.round(15 * sensitivity);      // High BPR momentum
        if (Math.abs(alphaRoc) > 4 / tm) probs.expansion += Math.round(12 * sensitivity);       // High alpha momentum
        if (supportGap > 0.04 / tm || resistGap > 0.04 / tm) probs.expansion += Math.round(10 * sensitivity);  // Gaps forming
        // Compression often precedes expansion
        if (currentRegime === 'compression') probs.expansion += 15;
        
        // ========================================
        // ACCUMULATION signals (scaled by sensitivity)
        // ========================================
        if (ldRoc > 0 && vwmpExt < -0.01 * tm) probs.accumulation += Math.round(15 * sensitivity);  // Buying at discount
        if (ldRoc > 2 / tm && ifvExt < -0.02 * tm) probs.accumulation += Math.round(12 * sensitivity);   // Strong buying below fair
        if (supportShare > 0.55) probs.accumulation += 8;                                              // Building support
        if (bprRoc > 0 && vwmpExt < 0) probs.accumulation += Math.round(8 * sensitivity);             // Quiet buying
        
        // ========================================
        // DISTRIBUTION signals (scaled by sensitivity)
        // ========================================
        if (ldRoc < 0 && vwmpExt > 0.01 * tm) probs.distribution += Math.round(15 * sensitivity);   // Selling at premium
        if (ldRoc < -2 / tm && ifvExt > 0.02 * tm) probs.distribution += Math.round(12 * sensitivity);   // Strong selling above fair
        if (resistShare > 0.55) probs.distribution += 8;                                              // Building resistance
        if (bprRoc < 0 && vwmpExt > 0) probs.distribution += Math.round(8 * sensitivity);            // Quiet selling
        
        // ========================================
        // MEAN REVERSION signals (scaled by sensitivity)
        // ========================================
        if (Math.abs(vwmpExt) > 0.03 / tm) probs.mean_reversion += Math.round(12 * sensitivity);    // Extended from VWMP
        if (Math.abs(ifvExt) > 0.05) probs.mean_reversion += 15;     // Extended from IFV
        if (Math.abs(ldRoc) < 3 && Math.abs(vwmpExt) > 0.02) probs.mean_reversion += 10;  // Extended but no momentum
        
        // ========================================
        // VACUUM signals (scaled by sensitivity)
        // ========================================
        if (supportGap > 0.05 / tm) probs.vacuum_down += Math.round(15 * sensitivity);   // Large gap below
        if (supportGap > 0.08 / tm) probs.vacuum_down += Math.round(20 * sensitivity);   // Very large gap below
        if (supportShare < 0.35) probs.vacuum_down += Math.round(12 * sensitivity);      // Thin support
        
        if (resistGap > 0.05 / tm) probs.vacuum_up += Math.round(15 * sensitivity);      // Large gap above
        if (resistGap > 0.08 / tm) probs.vacuum_up += Math.round(20 * sensitivity);      // Very large gap above
        if (resistShare < 0.35) probs.vacuum_up += Math.round(12 * sensitivity);         // Thin resistance
        
        // ========================================
        // Current regime inertia (stronger for slower modes)
        // ========================================
        if (currentRegime && probs[currentRegime] !== undefined) {
            // More inertia for investor mode (less jittery), less for market maker
            const inertiaBonus = Math.round(8 * tm);
            probs[currentRegime] += inertiaBonus;
        }
        
        // ========================================
        // Normalize to 100%
        // ========================================
        const total = Object.values(probs).reduce((a, b) => a + b, 0);
        const normalized = {};
        for (const key in probs) {
            normalized[key] = Math.round((probs[key] / total) * 100);
        }
        
        // Sort by probability descending
        const sorted = Object.entries(normalized)
            .sort((a, b) => b[1] - a[1])
            .reduce((obj, [key, val]) => {
                obj[key] = val;
                return obj;
            }, {});
        
        return sorted;
    }
    
    /**
     * Update Regime Transition Probability UI
     */
    updateRegimeTransitionUI(probabilities, signals) {
        const container = document.getElementById('regimeTransitionProbs');
        if (!container) return;
        
        // Get top regimes
        const topRegimes = Object.entries(probabilities).slice(0, 5);
        const topRegime = topRegimes[0];
        
        // Regime display info
        const regimeInfo = {
            uptrend: { icon: '🟢', label: 'UPTREND', color: '#10b981' },
            downtrend: { icon: '🔴', label: 'DOWNTREND', color: '#ef4444' },
            compression: { icon: '🔷', label: 'COMPRESSION', color: '#6366f1' },
            expansion: { icon: '🚀', label: 'EXPANSION', color: '#f59e0b' },
            accumulation: { icon: '🟣', label: 'ACCUMULATION', color: '#a855f7' },
            distribution: { icon: '🟠', label: 'DISTRIBUTION', color: '#fb923c' },
            mean_reversion: { icon: '🟡', label: 'MEAN REVERT', color: '#fbbf24' },
            vacuum_up: { icon: '⚠️', label: 'VACUUM UP', color: '#ec4899' },
            vacuum_down: { icon: '⚠️', label: 'VACUUM DOWN', color: '#ec4899' }
        };
        
        // Build probability bars HTML
        let html = '<div class="transition-bars">';
        for (const [regime, prob] of topRegimes) {
            const info = regimeInfo[regime] || { icon: '❓', label: regime.toUpperCase(), color: '#64748b' };
            const barWidth = Math.max(prob, 2); // Minimum width for visibility
            html += `
                <div class="transition-bar-row">
                    <span class="transition-label">${info.icon} ${info.label}</span>
                    <div class="transition-bar-track">
                        <div class="transition-bar-fill" style="width: ${barWidth}%; background: ${info.color};"></div>
                    </div>
                    <span class="transition-pct">${prob}%</span>
                </div>
            `;
        }
        html += '</div>';
        
        // Generate prediction sentence
        const prediction = this.generateTransitionPrediction(topRegimes, signals);
        html += `<div class="transition-prediction">${prediction}</div>`;
        
        container.innerHTML = html;
    }
    
    /**
     * Generate human-readable prediction sentence
     */
    generateTransitionPrediction(topRegimes, signals) {
        const [topRegime, topProb] = topRegimes[0];
        const [secondRegime, secondProb] = topRegimes[1] || ['unknown', 0];
        
        const ldRoc = signals.ld_roc || 0;
        const bprRoc = signals.bpr_roc || 0;
        const alphaRoc = signals.alpha_roc || 0;
        const vwmpExt = signals.vwmp_ext || 0;
        const supportGap = signals.support_gap || 0;
        const resistGap = signals.resist_gap || 0;
        
        // Build contextual reasons
        let reasons = [];
        
        if (ldRoc > 3) reasons.push('rising LD pressure');
        if (ldRoc < -3) reasons.push('falling LD pressure');
        if (bprRoc > 0.05) reasons.push('BPR momentum increasing');
        if (bprRoc < -0.05) reasons.push('BPR momentum decreasing');
        if (alphaRoc > 2) reasons.push('alpha trending up');
        if (alphaRoc < -2) reasons.push('alpha trending down');
        if (Math.abs(vwmpExt) > 0.03) reasons.push(`price ${vwmpExt > 0 ? 'extended above' : 'discounted below'} fair value`);
        if (supportGap > 0.05) reasons.push('widening support gap');
        if (resistGap > 0.05) reasons.push('widening resistance gap');
        if (supportGap < 0.02 && resistGap < 0.02) reasons.push('tight price range');
        
        const reasonText = reasons.length > 0 ? reasons.slice(0, 2).join(' and ') : 'current signal alignment';
        
        // Confidence levels
        let confidence = 'possible';
        if (topProb >= 30) confidence = 'likely';
        if (topProb >= 40) confidence = 'high probability';
        if (topProb >= 50) confidence = 'very high probability';
        
        const regimeLabels = {
            uptrend: 'UPTREND',
            downtrend: 'DOWNTREND', 
            compression: 'COMPRESSION',
            expansion: 'EXPANSION',
            accumulation: 'ACCUMULATION',
            distribution: 'DISTRIBUTION',
            mean_reversion: 'MEAN REVERSION',
            vacuum_up: 'VACUUM UP',
            vacuum_down: 'VACUUM DOWN'
        };
        
        const topLabel = regimeLabels[topRegime] || topRegime.toUpperCase();
        const secondLabel = regimeLabels[secondRegime] || secondRegime.toUpperCase();
        
        if (topProb - secondProb < 5) {
            // Close contest
            return `⚖️ Regime uncertain — ${topLabel} (${topProb}%) vs ${secondLabel} (${secondProb}%) are close. ${reasonText.charAt(0).toUpperCase() + reasonText.slice(1)} could tip the balance.`;
        } else if (topProb >= 35) {
            // Clear leader
            return `🎯 ${confidence.charAt(0).toUpperCase() + confidence.slice(1)} shift to ${topLabel} forming. ${reasonText.charAt(0).toUpperCase() + reasonText.slice(1)} increasing transition odds.`;
        } else {
            // No clear signal
            return `📊 No dominant regime forming yet. ${topLabel} leads at ${topProb}%, but ${reasonText} suggests watching for ${secondLabel} development.`;
        }
    }
    
    /**
     * Update ROC bar display
     */
    updateRocBar(prefix, value, maxVal) {
        const posBar = document.getElementById(prefix + 'BarPos');
        const negBar = document.getElementById(prefix + 'BarNeg');
        const valueEl = document.getElementById(prefix + 'Value');
        
        if (!posBar || !negBar || !valueEl) return;
        
        const normalizedValue = Math.max(-1, Math.min(1, value / maxVal));
        
        if (normalizedValue >= 0) {
            posBar.style.width = (normalizedValue * 50) + '%';
            negBar.style.width = '0%';
            valueEl.className = 'regime-value positive';
        } else {
            posBar.style.width = '0%';
            negBar.style.width = (Math.abs(normalizedValue) * 50) + '%';
            valueEl.className = 'regime-value negative';
        }
        
        // Format value
        if (prefix === 'bprRoc') {
            valueEl.textContent = (value >= 0 ? '+' : '') + (value).toFixed(2);
        } else {
            valueEl.textContent = (value >= 0 ? '+' : '') + value.toFixed(1);
        }
    }
    
    /**
     * Get CSS class for gap value
     */
    getGapClass(gap) {
        if (gap < 0.02) return 'tight';
        if (gap < 0.05) return 'normal';
        if (gap < 0.08) return 'wide';
        return 'vacuum';
    }
    
    /**
     * Format newbie summary with HTML styling
     */
    formatNewbieSummary(summary, regimeType, isExpanded = false) {
        // Clean up and format the summary text
        let html = summary.trim()
            // Format section headers with icons
            .replace(/🎯 WHAT'S HAPPENING:/g, '<div class="newbie-section"><span class="newbie-header happening">🎯 WHAT\'S HAPPENING:</span>')
            .replace(/🆘 WHAT'S HAPPENING:/g, '<div class="newbie-section"><span class="newbie-header danger">🆘 WHAT\'S HAPPENING:</span>')
            .replace(/⚡ WHAT TO DO:/g, '</div><div class="newbie-section"><span class="newbie-header action">⚡ WHAT TO DO:</span>')
            .replace(/📍 KEY LEVELS:/g, '</div><div class="newbie-section"><span class="newbie-header levels">📍 KEY LEVELS:</span>')
            .replace(/💰 POTENTIAL GAIN:/g, '</div><div class="newbie-section"><span class="newbie-header gain">💰 POTENTIAL GAIN:')
            .replace(/💰 EXPECTED MOVE:/g, '</div><div class="newbie-section"><span class="newbie-header gain">💰 EXPECTED MOVE:')
            .replace(/⚠️ POTENTIAL DROP:/g, '</div><div class="newbie-section"><span class="newbie-header warning">⚠️ POTENTIAL DROP:')
            .replace(/⚠️ RISK:/g, '</div><div class="newbie-section"><span class="newbie-header warning">⚠️ RISK:')
            .replace(/⚠️ WARNING:/g, '</div><div class="newbie-section"><span class="newbie-header warning">⚠️ WARNING:')
            .replace(/✅ CONFIDENCE:/g, '</div><div class="newbie-section"><span class="newbie-header confidence">✅ CONFIDENCE:')
            .replace(/✅ TREND STRENGTH:/g, '</div><div class="newbie-section"><span class="newbie-header confidence">✅ TREND STRENGTH:')
            .replace(/⏰ PATIENCE:/g, '</div><div class="newbie-section"><span class="newbie-header patience">⏰ PATIENCE:')
            // Format bullet points
            .replace(/\n• /g, '<br><span class="bullet">•</span> ')
            // Close any remaining sections
            + '</span></div>';
        
        // Wrap in container with regime-specific styling
        let containerClass = 'newbie-container';
        if (regimeType.includes('uptrend') || regimeType.includes('accumulation') || regimeType === 'expansion_up') {
            containerClass += ' bullish';
        } else if (regimeType.includes('downtrend') || regimeType.includes('distribution') || regimeType === 'expansion_down') {
            containerClass += ' bearish';
        } else if (regimeType.includes('vacuum')) {
            containerClass += ' danger';
        } else if (regimeType === 'compression') {
            containerClass += ' waiting';
        } else if (regimeType === 'mean_reversion') {
            containerClass += ' reversal';
        }
        
        // Wrap with collapsible toggle header
        const displayStyle = isExpanded ? 'block' : 'none';
        const expandedClass = isExpanded ? 'expanded' : '';
        
        return `<div class="${containerClass}">
            <div class="newbie-toggle ${expandedClass}">
                <span class="toggle-icon">▶</span>
                <span class="toggle-label">Trading Guide</span>
            </div>
            <div class="newbie-content" style="display: ${displayStyle};">${html}</div>
        </div>`;
    }
}

