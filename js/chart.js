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
        // DEPRECATED: Now handled by unified levelHistory system
        this.historicalFairValue = {
            enabled: false, // Disabled - levelHistory now handles FV tracking
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
        
        // BB %B Direction - shows momentum direction based on BB%B rising/falling
        this.bbPercentBDirection = {
            enabled: localStorage.getItem('showBBPercentBDirection') === 'true', // Default OFF
            markers: [],     // Historical direction markers (yellow triangles)
            lastDirection: null  // 'up', 'down', or 'flat'
        };
        
        // Bulls vs Bears Signal - order book pressure direction (Support/Resistance Levels)
        this.bullsBears = {
            enabled: localStorage.getItem('showBullsBears') !== 'false', // Default ON
            method: localStorage.getItem('bullsBearsMethod') || 'firstLevel', // 'firstLevel' | 'percentRange'
            percentRange: 20,         // For percentRange method (20% above/below)
            markers: [],              // Historical frozen markers
            liveMarker: null,         // Current bar's live marker  
            lastRatio: null,          // For display/debugging
            lastBarTime: null,        // Track which bar we're on
            // Level lines (for First Level method)
            resistanceSeries: null,   // Line series for resistance levels
            supportSeries: null,      // Line series for support levels
            resistanceData: [],       // Historical resistance level points {time, value}
            supportData: [],          // Historical support level points {time, value}
            liveResistance: null,     // Current bar's resistance level
            liveSupport: null         // Current bar's support level
        };
        
        // Cluster Proximity Signal - fires when bar opens near closest cluster
        this.clusterProximity = {
            enabled: localStorage.getItem('showClusterProximity') === 'true', // Default OFF
            threshold: parseFloat(localStorage.getItem('clusterProximityThreshold') || '0.20'), // 20% default
            lockTime: parseInt(localStorage.getItem('clusterProximityLockTime') || '5'), // 5 seconds default
            markers: [],              // Historical frozen markers
            liveMarker: null,         // Current bar's live marker
            lastBarTime: null,        // Track which bar we're on
            barStartTimestamp: null,  // When the current bar started (for lock timing)
            isLocked: false,          // Whether the signal is locked for this bar
            isLateJoin: false,        // True if we joined mid-bar after lock time (show yellow)
            lastSignal: null,         // Last signal for display (used by alert system)
            // Majority voting tracking
            buyTicks: 0,              // Count of times closest cluster was support (buy)
            sellTicks: 0              // Count of times closest cluster was resistance (sell)
        };
        
        // Cluster Drift Signal - measures directional movement of closest clusters
        this.clusterDrift = {
            enabled: localStorage.getItem('showClusterDrift') === 'true', // Default OFF
            lockTime: parseInt(localStorage.getItem('clusterDriftLockTime') || '5'), // 5 seconds default
            markers: [],              // Historical frozen markers
            liveMarker: null,         // Current bar's live marker
            lastBarTime: null,        // Track which bar we're on
            barStartTimestamp: null,  // When the current bar started (for lock timing)
            isLocked: false,          // Whether the signal is locked for this bar
            isLateJoin: false,        // True if we joined mid-bar after lock time (show yellow)
            lastSignal: null,         // Last signal for display
            // Drift tracking
            upTicks: 0,               // Count of upward movements
            downTicks: 0,             // Count of downward movements
            lastResistancePrice: null, // Previous closest resistance price
            lastSupportPrice: null     // Previous closest support price
        };
        
        // Live Proximity Signal - dynamic, no locking, saves history per bar
        this.liveProximity = {
            enabled: localStorage.getItem('showLiveProximity') === 'true', // Default OFF
            threshold: parseFloat(localStorage.getItem('liveProximityThreshold') || '0.20'), // 20% default
            markers: [],              // Historical markers (one per bar)
            liveMarker: null,         // Current marker (always live)
            lastSignal: null,         // Last signal for display
            lastBarTime: null         // Track which bar we're on
        };
        
        // Live Drift Signal - dynamic, no locking, saves history per bar
        this.liveDrift = {
            enabled: localStorage.getItem('showLiveDrift') === 'true', // Default OFF
            markers: [],              // Historical markers (one per bar)
            liveMarker: null,         // Current marker (always live)
            lastSignal: null,         // Last signal for display
            lastBarTime: null,        // Track which bar we're on
            // Drift tracking (resets each bar)
            upTicks: 0,
            downTicks: 0,
            lastResistancePrice: null,
            lastSupportPrice: null,
            lastBarTime: null
        };
        
        // LV (Liquidity Vacuum) Signal - shows where liquidity is thin (path of least resistance)
        this.lvSignal = {
            enabled: localStorage.getItem('showLVSignal') === 'true', // Default OFF
            markers: [],              // Historical markers (one per bar)
            liveMarker: null,         // Current marker (always live)
            lastSignal: null,         // Last computed signal
            lastBarTime: null,        // Track which bar we're on
            // Signal confirmation tracking for chart markers
            pendingSignal: null,      // Signal waiting for confirmation
            pendingStartTime: null,   // When pending signal started
            confirmedSignal: 'flat',  // Last confirmed signal for chart
            // Signal History Circles - track both buy and sell occurrences per bar
            historyEnabled: localStorage.getItem('showLVSignalHistory') === 'true', // Default OFF
            historyMarkers: [],       // Circle markers showing both buy/sell per bar (historical)
            liveHistoryMarkers: [],   // Circle markers for current bar (real-time)
            buyTriggeredThisBar: false,   // Did BUY fire at any point this bar?
            sellTriggeredThisBar: false,  // Did SELL fire at any point this bar?
            buyPeakRatio: null,       // Peak ratio when BUY was active
            sellMinRatio: null        // Min ratio when SELL was active
        };
        
        // LV Ratio Threshold - configurable signal sensitivity (default 1.01 = 50.2%)
        this.lvRatioThreshold = parseFloat(localStorage.getItem('lvRatioThreshold')) || 1.01;
        
        // LV Confirmation Time - seconds signal must stay stable before showing on chart (default 5s)
        this.lvConfirmTime = parseInt(localStorage.getItem('lvConfirmTime')) || 30;
        
        // Alpha Lead Score Threshold - distance from 50 needed for signal (default 10 means BUY at 60+, SELL at 40-)
        this.alphaLeadScoreThreshold = parseInt(localStorage.getItem('alphaLeadScoreThreshold')) || 1;
        
        // Alpha Lead Confirmation Time - seconds signal must stay stable before confirming (default 6s)
        this.alphaLeadConfirmTime = parseInt(localStorage.getItem('alphaLeadConfirmTime')) || 10;
        
        // Alpha Lead Signal - leading indicator combining LV + momentum
        this.alphaLeadSignal = {
            enabled: localStorage.getItem('showAlphaLeadSignal') === 'true', // Default OFF
            markers: [],              // Historical markers (one per bar)
            liveMarker: null,         // Current marker (always live)
            lastSignal: null,         // Last computed signal ('buy', 'sell', 'neutral')
            lastBarTime: null,        // Track which bar we're on
            peakScore: null,          // Highest score this bar (for BUY signals)
            minScore: null,           // Lowest score this bar (for SELL signals)
            // Signal History Circles - track both buy and sell occurrences per bar
            historyEnabled: localStorage.getItem('showALSignalHistory') === 'true', // Default OFF
            historyMarkers: [],       // Circle markers showing both buy/sell per bar (historical)
            liveHistoryMarkers: [],   // Circle markers for current bar (real-time)
            buyTriggeredThisBar: false,   // Did BUY fire at any point this bar?
            sellTriggeredThisBar: false,  // Did SELL fire at any point this bar?
            buyPeakScore: null,       // Peak score when BUY was active
            sellMinScore: null        // Min score when SELL was active
        };
        
        // Cluster Strike Panel - Separate visualization of current bar walls
        this.clusterStrike = {
            canvas: null,
            ctx: null,
            priceRange: 0.20, // ±20% of current price (will show walls within this range)
            initialized: false,
            lastRenderTime: 0,
            renderThrottleMs: 100 // Throttle renders to 10fps for performance
        };
        
        // Trade Footprint Heatmap - shows delta at each price level per bar
        this.tradeFootprint = {
            enabled: localStorage.getItem('showTradeFootprint') === 'true', // Default OFF (tracks in background via tradeAggregator)
            bucketSize: parseInt(localStorage.getItem('tradeFootprintBucketSize') || '10'),
            canvas: null,             // Canvas overlay element
            ctx: null,                // Canvas 2D context
            maxBars: 200,             // Max bars to render
            brightness: parseFloat(localStorage.getItem('tradeHeatmapBrightness') || '2') // Brightness multiplier (default 2.0x)
        };
        
        // Flow Forecast - predictive arrows based on order flow + depth
        this.flowForecast = {
            enabled: localStorage.getItem('showFlowForecast') === 'true', // Default OFF (hidden feature)
            canvas: null,
            ctx: null,
            showAccuracy: localStorage.getItem('showFlowForecastAccuracy') === 'true'
        };
        
        // Level History - unified tracking of all order book levels + fair value indicators
        // Heatmap for clusters, lines for Mid/IFV/VWMP - always on by default
        this.levelHistory = {
            enabled: true,                    // Always enabled for background caching
            showHeatmap: localStorage.getItem('showLevelHistoryHeatmap') !== 'false', // Display toggle (default ON)
            maxBars: 500,                     // History limit
            data: new Map(),                  // barTime => { clusters, mid, ifv, vwmp } OR { buckets, mid, ifv, vwmp } in channel mode
            // Heatmap canvas for order book clusters
            canvas: null,
            ctx: null,
            // Line series removed - now using bucket heatmaps
            midSeries: null,
            ifvSeries: null,
            vwmpSeries: null,
            // Data arrays for line series (legacy, kept for compatibility)
            midData: [],
            ifvData: [],
            vwmpData: [],
            // Tracking
            lastBarTime: null,
            symbol: 'BTC',
            interval: '1m',
            initialized: false,
            // Channel Mode - accumulates wall positions throughout bar instead of single snapshot
            channelMode: localStorage.getItem('levelHeatmapChannelMode') !== 'false', // Default ON
            bucketSize: parseInt(localStorage.getItem('levelHeatmapBucketSize') || '50'), // $50 default bucket size
            currentBarAccumulator: new Map(), // bucketPrice => {bidHits, askHits, maxBidVol, maxAskVol}
            currentBarSampleCount: 0,         // Track number of samples for normalization
            brightness: parseFloat(localStorage.getItem('levelHeatmapBrightness') || '0.4'), // Brightness multiplier (default 0.4x)
            // Fair Value Bucket Accumulators - track where mid/ifv/vwmp spent time during bar
            midBuckets: new Map(),            // bucketPrice => hits
            ifvBuckets: new Map(),            // bucketPrice => hits  
            vwmpBuckets: new Map(),           // bucketPrice => hits
            fvSampleCount: 0                  // Fair value samples this bar
        };
        
        this.dbsc = {
            enabled: localStorage.getItem('showDBSC') === 'true', // Default OFF
            showSetup: localStorage.getItem('dbscShowSetup') !== 'false', // Default ON
            showTDST: localStorage.getItem('dbscShowTDST') !== 'false', // Default ON
            showSequential: localStorage.getItem('dbscShowSequential') !== 'false', // Default ON
            showCombo: localStorage.getItem('dbscShowCombo') === 'true', // Default OFF
            cleanMode: localStorage.getItem('dbscCleanMode') === 'true', // Default OFF
            showAllCounts: localStorage.getItem('dbscShowAllCounts') === 'true', // Default OFF
            markers: [],              // Historical markers for setup/countdown counts
            tdstLines: [],            // TDST price lines (isolated from this.priceLines)
            riskLines: [],            // Risk level price lines (isolated)
            lastBarTime: null,        // Track which bar we're on
            calculator: null,         // DBSCIndicator instance (created on first use)
            lastResult: null,         // Cached calculation result
            // MTF (Multi-Timeframe) support
            mtfTimeframe: localStorage.getItem('dbscMtfTimeframe') || '', // '' = same as chart
            mtfCandles: [],           // Candles fetched for MTF timeframe
            mtfResult: null,          // Calculation result from MTF candles
            mtfLastFetch: null,       // Timestamp of last MTF fetch
            mtfFetching: false        // Flag to prevent concurrent fetches
        };

        // Alert markers (plotted when alerts fire)
        this.alertMarkers = [];
        this.alertMarkersMax = 200;
        
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
        
        // Sync trade aggregator with new symbol
        if (this.tradeFootprint.enabled && typeof tradeAggregator !== 'undefined') {
            tradeAggregator.setSymbol(symbol);
            this.renderTradeFootprint();
        }
        
        // Sync level history with new symbol
        if (this.levelHistory && this.levelHistory.enabled) {
            this.onLevelHistorySymbolChange(symbol);
        }
        
        // Reset DB SC state for new symbol
        if (this.dbsc) {
            this.resetDBSCState();
        }
    }

    /**
     * Scroll chart to show the latest bar
     */
    scrollToLatest() {
        if (!this.chart) return;
        this.chart.timeScale().scrollToRealTime();
    }
    
    /**
     * Zoom chart to show recent bars and frame price nicely
     * @param {number} barsToShow - Number of bars to display (default 50)
     * @param {number} barsForPriceRange - Number of bars to use for price range (default 6)
     */
    zoomToRecent(barsToShow = 50, barsForPriceRange = 6) {
        if (!this.chart || !this.candleData || this.candleData.length === 0) return;
        
        const dataLength = this.candleData.length;
        
        // Set visible logical range to show last N bars
        const fromBar = Math.max(0, dataLength - barsToShow);
        this.chart.timeScale().setVisibleLogicalRange({
            from: fromBar,
            to: dataLength + 5 // Add some padding on the right
        });
        
        // Calculate price range from last N bars for proper framing
        const recentBars = this.candleData.slice(-barsForPriceRange);
        if (recentBars.length > 0) {
            let minPrice = Infinity;
            let maxPrice = -Infinity;
            
            recentBars.forEach(bar => {
                if (bar.low < minPrice) minPrice = bar.low;
                if (bar.high > maxPrice) maxPrice = bar.high;
            });
            
            // Add 1% padding to the price range
            const padding = (maxPrice - minPrice) * 0.01;
            minPrice -= padding;
            maxPrice += padding;
            
            // Apply the price range to auto-scale
            this.candleSeries.priceScale().applyOptions({
                autoScale: true
            });
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
        }
        this.currentInterval = interval;

        // Reload interval-scoped historical fair value (VWMP/IFV history plot)
        if (this.historicalFairValue.enabled) {
            this.loadHistoricalFairValue();
        }
        
        // Sync trade aggregator with new interval
        if (this.tradeFootprint.enabled && typeof tradeAggregator !== 'undefined') {
            tradeAggregator.setInterval(interval);
            this.renderTradeFootprint();
        }
        
        // Sync level history with new interval
        if (this.levelHistory && this.levelHistory.enabled) {
            this.onLevelHistoryIntervalChange(interval);
        }
        
        // Reset DB SC state for new interval
        if (this.dbsc) {
            this.resetDBSCState();
        }
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
        
        // View persistence disabled - chart always shows current price on load
        // this.setupViewPersistence();
        
        // Load historical levels (async, non-blocking)
        this.loadHistoricalLevels();
        
        // Load historical fair values (VWMP, IFV, targets)
        this.loadHistoricalFairValue();
        
        // Initialize Level History (always-on unified tracking)
        this.initLevelHistory();
        
        // Initialize Flow Forecast (predictive arrows)
        if (this.flowForecast.enabled) {
            this.initFlowForecastCanvas();
            this._initFlowForecastLegend();
        }
        
        // Listen for new bar events to finalize signals
        window.addEventListener('newBarOpened', (e) => {
            if (this.bullsBears && this.bullsBears.enabled) {
                this.finalizeBullsBearsSignal();
            }
            // Notify trade aggregator of new bar
            if (this.tradeFootprint && this.tradeFootprint.enabled && typeof tradeAggregator !== 'undefined') {
                tradeAggregator.onNewBarOpened(e.detail?.time);
                this.renderTradeFootprint();
            }
            // Snapshot level history on bar close (capture previous bar's data)
            // Always cache data regardless of display setting
            if (this.levelHistory) {
                this.snapshotLevelHistory(e.detail?.time);
            }
            // Update DB SC on new bar (always calculate for panel, markers depend on enabled)
            if (this.dbsc) {
                this.updateDBSCSignals();
            }
        });

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
                
                // Resize trade footprint canvas
                if (this.tradeFootprint.canvas && this.container) {
                    const rect = this.container.getBoundingClientRect();
                    this.tradeFootprint.canvas.width = rect.width * window.devicePixelRatio;
                    this.tradeFootprint.canvas.height = rect.height * window.devicePixelRatio;
                    this.tradeFootprint.ctx = this.tradeFootprint.canvas.getContext('2d');
                    this.tradeFootprint.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                    if (this.tradeFootprint.enabled) {
                        this.renderTradeFootprint();
                    }
                }
                
                // Resize level history canvas
                if (this.levelHistory.canvas && this.container) {
                    const rect = this.container.getBoundingClientRect();
                    this.levelHistory.canvas.width = rect.width * window.devicePixelRatio;
                    this.levelHistory.canvas.height = rect.height * window.devicePixelRatio;
                    this.levelHistory.ctx = this.levelHistory.canvas.getContext('2d');
                    this.levelHistory.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
                    if (this.levelHistory.enabled) {
                        this.renderLevelHistoryHeatmap();
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

        // Zoom to recent bars on first load (shows last 50 bars, frames last 6 bars' price range)
        // We no longer restore saved views - always start fresh at the latest data
        this.zoomToRecent(50, 6);
        
        // Re-render level history heatmap now that chart has price data
        // (initial load may have failed if candles weren't loaded yet)
        if (this.levelHistory.showHeatmap && this.levelHistory.data.size > 0) {
            this.scheduleLevelHistoryRender();
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
        const updateLocalHistory = (candle) => {
            if (!this.localCandles) return;
            this.localCandles.set(candle.time, {
                ...candle,
                volume: candle.volume ?? 0
            });
        };
        
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
            updateLocalHistory(this.lastCandle);
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
            updateLocalHistory(this.lastCandle);
            
            // Create new bar
            this.lastCandle = {
                time: currentBarTime,
                open: price,
                high: price,
                low: price,
                close: price
            };
            
            this.candleSeries.update(this.lastCandle);
            updateLocalHistory(this.lastCandle);
            
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
                detail: { time: currentBarTime, interval: this.currentInterval }
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
            updateLocalHistory(this.lastCandle);
        }
        
        this.currentPrice = price;
        this.updatePriceLine(price);
        
        // Keep indicator signals in sync with live price updates (throttled)
        const nowMs = Date.now();
        if (!this._lastSignalUpdate) this._lastSignalUpdate = 0;
        const signalThrottle = 2000;
        if ((nowMs - this._lastSignalUpdate) >= signalThrottle) {
            this._lastSignalUpdate = nowMs;
            
            if (this.bbPulse && this.bbPulse.enabled) {
                this.updateBBPulse(false);
            }
            
            if (this.bbPercentBDirection && this.bbPercentBDirection.enabled) {
                this.updateBBPercentBDirection(false);
            }
            
            this.updateAllSignalMarkers();
        }
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
                detail: { time: candleTime, interval: this.currentInterval, source: 'ohlc_stream' }
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
            
            // Update BB %B Direction markers if enabled
            if (this.bbPercentBDirection && this.bbPercentBDirection.enabled) {
                this.updateBBPercentBDirection(false);
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
        
        // Update DB SC signals now that candles are loaded (always for panel)
        if (this.dbsc) {
            this.updateDBSCSignals();
        }
        
        // View restoration disabled - chart always shows current price on load
        // if (!this._viewRestored) {
        //     this._viewRestored = true;
        //     this.restoreSavedView();
        // }
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
        
        // Store levels for fair value and level history calculations
        if (levels && levels.length > 0) {
            this.fairValueIndicators.currentLevels = levels;
        }

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
        
        // Add BB Pulse signals if enabled
        if (this.bbPulse && this.bbPulse.enabled && this.bbPulse.markers) {
            allMarkers = allMarkers.concat(this.bbPulse.markers);
        }
        
        // Add BB %B Direction markers if enabled
        if (this.bbPercentBDirection && this.bbPercentBDirection.enabled && this.bbPercentBDirection.markers) {
            allMarkers = allMarkers.concat(this.bbPercentBDirection.markers);
        }
        
        // Add Bulls vs Bears signals if enabled
        if (this.bullsBears && this.bullsBears.enabled) {
            // Add historical frozen markers
            if (this.bullsBears.markers && this.bullsBears.markers.length > 0) {
                allMarkers = allMarkers.concat(this.bullsBears.markers);
            }
            // Add live marker for current bar
            if (this.bullsBears.liveMarker) {
                allMarkers.push(this.bullsBears.liveMarker);
            }
        }
        
        // Add Cluster Proximity signals if enabled
        if (this.clusterProximity && this.clusterProximity.enabled) {
            // Add historical frozen markers
            if (this.clusterProximity.markers && this.clusterProximity.markers.length > 0) {
                allMarkers = allMarkers.concat(this.clusterProximity.markers);
            }
            // Add live marker for current bar
            if (this.clusterProximity.liveMarker) {
                allMarkers.push(this.clusterProximity.liveMarker);
            }
        }
        
        // Add Cluster Drift signals if enabled
        if (this.clusterDrift && this.clusterDrift.enabled) {
            // Add historical frozen markers
            if (this.clusterDrift.markers && this.clusterDrift.markers.length > 0) {
                allMarkers = allMarkers.concat(this.clusterDrift.markers);
            }
            // Add live marker for current bar
            if (this.clusterDrift.liveMarker) {
                allMarkers.push(this.clusterDrift.liveMarker);
            }
        }
        
        // Add Live Proximity signal if enabled (with history)
        if (this.liveProximity && this.liveProximity.enabled) {
            // Add historical markers
            if (this.liveProximity.markers && this.liveProximity.markers.length > 0) {
                allMarkers = allMarkers.concat(this.liveProximity.markers);
            }
            // Add live marker for current bar
            if (this.liveProximity.liveMarker) {
                allMarkers.push(this.liveProximity.liveMarker);
            }
        }
        
        // Add Live Drift signal if enabled (with history)
        if (this.liveDrift && this.liveDrift.enabled) {
            // Add historical markers
            if (this.liveDrift.markers && this.liveDrift.markers.length > 0) {
                allMarkers = allMarkers.concat(this.liveDrift.markers);
            }
            // Add live marker for current bar
            if (this.liveDrift.liveMarker) {
                allMarkers.push(this.liveDrift.liveMarker);
            }
        }
        
        // Add LV (Liquidity Vacuum) signal if enabled (with history)
        if (this.lvSignal && this.lvSignal.enabled) {
            // Add historical markers
            if (this.lvSignal.markers && this.lvSignal.markers.length > 0) {
                allMarkers = allMarkers.concat(this.lvSignal.markers);
            }
            // Add live marker for current bar
            if (this.lvSignal.liveMarker) {
                allMarkers.push(this.lvSignal.liveMarker);
            }
        }
        
        // Add LV Signal History circles if enabled (shows both buy AND sell occurrences per bar)
        if (this.lvSignal && this.lvSignal.historyEnabled) {
            // Historical markers from completed bars
            if (this.lvSignal.historyMarkers && this.lvSignal.historyMarkers.length > 0) {
                allMarkers = allMarkers.concat(this.lvSignal.historyMarkers);
            }
            // Live markers for current bar (real-time)
            if (this.lvSignal.liveHistoryMarkers && this.lvSignal.liveHistoryMarkers.length > 0) {
                allMarkers = allMarkers.concat(this.lvSignal.liveHistoryMarkers);
            }
        }
        
        // Add Alpha Lead signal if enabled (with history)
        if (this.alphaLeadSignal && this.alphaLeadSignal.enabled) {
            // Add historical markers
            if (this.alphaLeadSignal.markers && this.alphaLeadSignal.markers.length > 0) {
                allMarkers = allMarkers.concat(this.alphaLeadSignal.markers);
            }
            // Add live marker for current bar
            if (this.alphaLeadSignal.liveMarker) {
                allMarkers.push(this.alphaLeadSignal.liveMarker);
            }
        }
        
        // Add Alpha Lead Signal History circles if enabled (shows both buy AND sell occurrences per bar)
        if (this.alphaLeadSignal && this.alphaLeadSignal.historyEnabled) {
            // Historical markers from completed bars
            if (this.alphaLeadSignal.historyMarkers && this.alphaLeadSignal.historyMarkers.length > 0) {
                allMarkers = allMarkers.concat(this.alphaLeadSignal.historyMarkers);
            }
            // Live markers for current bar (real-time)
            if (this.alphaLeadSignal.liveHistoryMarkers && this.alphaLeadSignal.liveHistoryMarkers.length > 0) {
                allMarkers = allMarkers.concat(this.alphaLeadSignal.liveHistoryMarkers);
            }
        }
        
        // Add DB SC markers if enabled
        if (this.dbsc && this.dbsc.enabled && this.dbsc.markers && this.dbsc.markers.length > 0) {
            allMarkers = allMarkers.concat(this.dbsc.markers);
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
        
        // Update Cluster panel UI
        this.updateClusterPanelUI();
    }
    
    /**
     * Update the Cluster signals panel UI with current values
     * Note: Panel always shows signals regardless of chart display settings
     */
    updateClusterPanelUI() {
        // Get signal directions (null = no signal, 'up' = bullish, 'down' = bearish)
        // Panel always computes from internal state, independent of 'enabled' flag
        let proxDir = null;
        let driftDir = null;
        let liveProxDir = null;
        let liveDriftDir = null;
        
        // Update Cluster Proximity (prox) - uses UP/DOWN
        // Always show in panel regardless of this.clusterProximity.enabled
        const proxValueEl = document.getElementById('clusterProxValue');
        if (proxValueEl) {
            if (this.clusterProximity.isLocked && this.clusterProximity.lastSignal) {
                proxDir = this.clusterProximity.lastSignal.direction === 'buy' ? 'up' : 'down';
                const isLate = this.clusterProximity.isLateJoin;
                proxValueEl.textContent = proxDir === 'up' ? '▲' : '▼';
                proxValueEl.className = 'mini-value ' + (isLate ? 'late' : proxDir);
            } else if (this.clusterProximity.buyTicks > 0 || this.clusterProximity.sellTicks > 0) {
                const dir = this.clusterProximity.buyTicks > this.clusterProximity.sellTicks ? 'up' : 
                           (this.clusterProximity.sellTicks > this.clusterProximity.buyTicks ? 'down' : null);
                if (dir) {
                    proxValueEl.textContent = dir === 'up' ? '▲' : '▼';
                    proxValueEl.className = 'mini-value waiting';
                } else {
                    proxValueEl.textContent = '⏳';
                    proxValueEl.className = 'mini-value waiting';
                }
            } else {
                proxValueEl.textContent = '—';
                proxValueEl.className = 'mini-value';
            }
        }
        
        // Update Cluster Drift (drift) - uses UP/DOWN
        // Always show in panel regardless of this.clusterDrift.enabled
        const driftValueEl = document.getElementById('clusterDriftValue');
        if (driftValueEl) {
            if (this.clusterDrift.isLocked && this.clusterDrift.lastSignal) {
                driftDir = this.clusterDrift.lastSignal.direction === 'buy' ? 'up' : 'down';
                const isLate = this.clusterDrift.isLateJoin;
                driftValueEl.textContent = driftDir === 'up' ? '▲' : '▼';
                driftValueEl.className = 'mini-value ' + (isLate ? 'late' : driftDir);
            } else if (this.clusterDrift.upTicks > 0 || this.clusterDrift.downTicks > 0) {
                const dir = this.clusterDrift.upTicks > this.clusterDrift.downTicks ? 'up' : 
                           (this.clusterDrift.downTicks > this.clusterDrift.upTicks ? 'down' : null);
                if (dir) {
                    driftValueEl.textContent = dir === 'up' ? '▲' : '▼';
                    driftValueEl.className = 'mini-value waiting';
                } else {
                    driftValueEl.textContent = '⏳';
                    driftValueEl.className = 'mini-value waiting';
                }
            } else {
                driftValueEl.textContent = '—';
                driftValueEl.className = 'mini-value';
            }
        }
        
        // Update Live Proximity (l-prox)
        // Always show in panel regardless of this.liveProximity.enabled
        const liveProxValueEl = document.getElementById('liveProxValue');
        if (liveProxValueEl) {
            if (this.liveProximity.liveMarker && this.liveProximity.lastSignal) {
                liveProxDir = this.liveProximity.lastSignal.direction === 'buy' ? 'up' : 'down';
                liveProxValueEl.textContent = liveProxDir === 'up' ? '▲' : '▼';
                liveProxValueEl.className = 'mini-value ' + liveProxDir;
            } else {
                liveProxValueEl.textContent = '—';
                liveProxValueEl.className = 'mini-value';
            }
        }
        
        // Update Live Drift (l-drift)
        // Always show in panel regardless of this.liveDrift.enabled
        const liveDriftValueEl = document.getElementById('liveDriftValue');
        if (liveDriftValueEl) {
            if (this.liveDrift.liveMarker && this.liveDrift.lastSignal) {
                liveDriftDir = this.liveDrift.lastSignal.direction === 'buy' ? 'up' : 'down';
                liveDriftValueEl.textContent = liveDriftDir === 'up' ? '▲' : '▼';
                liveDriftValueEl.className = 'mini-value ' + liveDriftDir;
            } else {
                liveDriftValueEl.textContent = '—';
                liveDriftValueEl.className = 'mini-value';
            }
        }
        
        // Compute Locked Combo: prox + drift
        // UP + UP = UP, DOWN + DOWN = DOWN, otherwise FLAT
        let lockedCombo = null;
        if (proxDir && driftDir) {
            if (proxDir === 'up' && driftDir === 'up') {
                lockedCombo = 'up';
            } else if (proxDir === 'down' && driftDir === 'down') {
                lockedCombo = 'down';
            } else {
                lockedCombo = 'flat';
            }
        }
        
        // Compute Live Combo: l-prox + l-drift
        let liveCombo = null;
        if (liveProxDir && liveDriftDir) {
            if (liveProxDir === 'up' && liveDriftDir === 'up') {
                liveCombo = 'up';
            } else if (liveProxDir === 'down' && liveDriftDir === 'down') {
                liveCombo = 'down';
            } else {
                liveCombo = 'flat';
            }
        }
        
        // Compute Final Combo: Locked + Live
        // UP + UP = UP, DOWN + DOWN = DOWN, otherwise FLAT
        let finalCombo = null;
        if (lockedCombo && liveCombo) {
            if (lockedCombo === 'up' && liveCombo === 'up') {
                finalCombo = 'up';
            } else if (lockedCombo === 'down' && liveCombo === 'down') {
                finalCombo = 'down';
            } else {
                finalCombo = 'flat';
            }
        } else if (lockedCombo) {
            finalCombo = lockedCombo;
        } else if (liveCombo) {
            finalCombo = liveCombo;
        }
        
        // Update Locked Combo display
        const lockedComboEl = document.getElementById('clusterComboLocked');
        if (lockedComboEl) {
            if (lockedCombo) {
                lockedComboEl.textContent = lockedCombo === 'up' ? '▲ Up' : (lockedCombo === 'down' ? '▼ Dn' : '— Flat');
                lockedComboEl.className = 'combo-part ' + lockedCombo;
            } else {
                lockedComboEl.textContent = '—';
                lockedComboEl.className = 'combo-part';
            }
        }
        
        // Update Live Combo display
        const liveComboEl = document.getElementById('clusterComboLive');
        if (liveComboEl) {
            if (liveCombo) {
                liveComboEl.textContent = liveCombo === 'up' ? '▲ L-Up' : (liveCombo === 'down' ? '▼ L-Dn' : '— L-Flat');
                liveComboEl.className = 'combo-part ' + liveCombo;
            } else {
                liveComboEl.textContent = '—';
                liveComboEl.className = 'combo-part';
            }
        }
        
        // Update Final Combo display (hero)
        const finalComboEl = document.getElementById('clusterComboFinal');
        if (finalComboEl) {
            const valueEl = finalComboEl.querySelector('.combo-value');
            if (valueEl) {
                if (finalCombo) {
                    valueEl.textContent = finalCombo === 'up' ? '▲ UP' : (finalCombo === 'down' ? '▼ DOWN' : '— FLAT');
                    valueEl.className = 'combo-value ' + finalCombo;
                } else {
                    valueEl.textContent = '—';
                    valueEl.className = 'combo-value';
                }
            }
        }
        
        // Update header badge with signal
        const clusterBadge = document.querySelector('#clusterSignalsPanel .panel-badge');
        if (clusterBadge) {
            clusterBadge.classList.remove('bullish', 'bearish', 'neutral');
            if (finalCombo === 'up') {
                clusterBadge.textContent = 'UP';
                clusterBadge.classList.add('bullish');
            } else if (finalCombo === 'down') {
                clusterBadge.textContent = 'DOWN';
                clusterBadge.classList.add('bearish');
            } else {
                clusterBadge.textContent = 'FLAT';
                clusterBadge.classList.add('neutral');
            }
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
        
        // Store latest BB Pulse signal state for panel display
        // IMPORTANT: Only use lBuySignal1 and lSellSignal1 - these are the only ones drawn on chart
        const signals = data.signals;
        const lastIdx = signals.lBuySignal1.length - 1;
        if (lastIdx >= 0) {
            this.lastBBPulseSignal = {
                buySignal: signals.lBuySignal1[lastIdx],   // Only signal 1 (period low)
                sellSignal: signals.lSellSignal1[lastIdx]  // Only signal 1 (period high)
            };
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
    // BB %B Direction Indicators (Yellow Triangles)
    // ==========================================
    
    /**
     * Toggle BB %B Direction markers (yellow triangles showing momentum direction)
     */
    toggleBBPercentBDirection(show) {
        this.bbPercentBDirection.enabled = show;
        console.log('[Chart] toggleBBPercentBDirection:', show);
        
        if (show) {
            this.updateBBPercentBDirection();
        } else {
            this.clearBBPercentBDirection();
        }
        
        localStorage.setItem('showBBPercentBDirection', show);
    }
    
    /**
     * Update BB %B Direction markers
     * Shows yellow up/down triangles based on BB%B momentum
     * BB%B > BB%B[1] = rising (up triangle), BB%B < BB%B[1] = falling (down triangle)
     */
    updateBBPercentBDirection(updateCombinedMarkers = true) {
        if (!this.bbPercentBDirection.enabled || !this.chart || !this.candleSeries) {
            return;
        }
        if (typeof bbPulseLighting === 'undefined') {
            console.log('[Chart] updateBBPercentBDirection skipped - bbPulseLighting not loaded');
            return;
        }
        
        const candles = this.getCandles();
        if (!candles || candles.length < 200) {
            return;
        }
        
        // Calculate indicator using BB Pulse (which uses OPEN prices - no repaint!)
        const data = bbPulseLighting.calculate(candles);
        if (!data || !data.bbb || !data.bbb.bbr) {
            return;
        }
        
        const bbr = data.bbb.bbr; // BB %B values
        const markers = [];
        
        // BB%B array starts at candle index (bbbLen - 1)
        const bbrStartIdx = bbPulseLighting.bbbLen - 1;
        
        // Need at least 2 BB%B values to compare direction
        for (let i = 1; i < bbr.length; i++) {
            const candleIdx = bbrStartIdx + i;
            if (candleIdx >= candles.length) break;
            
            const currentBBR = bbr[i];
            const prevBBR = bbr[i - 1];
            const time = candles[candleIdx].time;
            
            // Determine direction with small threshold to avoid noise
            const threshold = 0.005; // 0.5% minimum change
            const diff = currentBBR - prevBBR;
            
            if (diff > threshold) {
                // Rising - bullish momentum
                markers.push({
                    time: time,
                    position: 'belowBar',
                    color: 'rgba(251, 191, 36, 0.5)', // Yellow 50% transparent
                    shape: 'arrowUp',
                    text: ''
                });
            } else if (diff < -threshold) {
                // Falling - bearish momentum
                markers.push({
                    time: time,
                    position: 'aboveBar',
                    color: 'rgba(251, 191, 36, 0.5)', // Yellow 50% transparent
                    shape: 'arrowDown',
                    text: ''
                });
            }
            // If flat (within threshold), no marker
        }
        
        // Store markers
        this.bbPercentBDirection.markers = markers;
        
        // Update last direction for trade panel use
        if (bbr.length >= 2) {
            const lastDiff = bbr[bbr.length - 1] - bbr[bbr.length - 2];
            if (lastDiff > 0.005) {
                this.bbPercentBDirection.lastDirection = 'up';
            } else if (lastDiff < -0.005) {
                this.bbPercentBDirection.lastDirection = 'down';
            } else {
                this.bbPercentBDirection.lastDirection = 'flat';
            }
        }
        
        console.log('[Chart] BB %B Direction:', this.bbPercentBDirection.lastDirection, '| Markers:', markers.length);
        
        // Update all signal markers
        if (updateCombinedMarkers) {
            this.updateAllSignalMarkers();
        }
    }
    
    /**
     * Clear BB %B Direction markers
     */
    clearBBPercentBDirection() {
        this.bbPercentBDirection.markers = [];
        this.bbPercentBDirection.lastDirection = null;
        this.updateAllSignalMarkers();
    }
    
    /**
     * Get combined BB%B & Lighting signal state
     * Determines allowed trade direction based on BB%B momentum + Pulse signals
     * Always computes BB%B direction regardless of chart display setting
     * @returns {Object} { mode: 'long'|'short'|'both'|'flat', bbDirection: string, lighting: string }
     */
    getBBLightingState() {
        // Always compute BB%B direction from candle data (independent of display setting)
        let bbDirection = 'flat';
        
        if (typeof bbPulseLighting !== 'undefined') {
            const candles = this.getCandles();
            if (candles && candles.length >= 200) {
                // Use bbPulseLighting.calculate() to get BBR values
                const data = bbPulseLighting.calculate(candles);
                if (data && data.bbb && data.bbb.bbr) {
                    const bbr = data.bbb.bbr;
                    if (bbr.length >= 2) {
                        const lastDiff = bbr[bbr.length - 1] - bbr[bbr.length - 2];
                        if (lastDiff > 0.005) {
                            bbDirection = 'up';
                        } else if (lastDiff < -0.005) {
                            bbDirection = 'down';
                        } else {
                            bbDirection = 'flat';
                        }
                    }
                }
            }
        }
        
        // Get latest BB Pulse signal
        let lighting = 'none';
        if (this.lastBBPulseSignal) {
            if (this.lastBBPulseSignal.buySignal) {
                lighting = 'buy';
            } else if (this.lastBBPulseSignal.sellSignal) {
                lighting = 'sell';
            }
        }
        
        // Determine allowed trade mode
        let mode = 'flat';
        
        if (bbDirection === 'up' && lighting === 'buy') {
            // Confluence: Both bullish - long only
            mode = 'long';
        } else if (bbDirection === 'down' && lighting === 'sell') {
            // Confluence: Both bearish - short only
            mode = 'short';
        } else if (bbDirection === 'up' && lighting === 'sell') {
            // Conflict: Direction up but sell signal - allow both (potential reversal)
            mode = 'both';
        } else if (bbDirection === 'down' && lighting === 'buy') {
            // Conflict: Direction down but buy signal - allow both (potential reversal)
            mode = 'both';
        } else if (bbDirection === 'flat') {
            // No clear direction - flat
            mode = 'flat';
        } else if (lighting === 'none') {
            // No lighting signal - follow direction only
            if (bbDirection === 'up') {
                mode = 'long';
            } else if (bbDirection === 'down') {
                mode = 'short';
            }
        }
        
        return {
            mode: mode,
            bbDirection: bbDirection,
            lighting: lighting
        };
    }
    /**
     * Toggle DB SC Indicator
     */
    setDBSCEnabled(enabled) {
        this.dbsc.enabled = enabled;
        localStorage.setItem('showDBSC', enabled);
        console.log('[Chart] setDBSCEnabled:', enabled);
        
        if (enabled) {
            this.updateDBSCSignals(); // Calculate and draw markers
        } else {
            this.clearDBSCSignals(); // Clear markers from chart
            // Panel continues to show data via updateDBSCSignals calls
        }
    }
    
    /**
     * Set DB SC sub-setting (display flags)
     */
    setDBSCSetting(key, value) {
        console.log('[Chart] setDBSCSetting:', key, '=', value);
        
        if (this.dbsc.hasOwnProperty(key)) {
            this.dbsc[key] = value;
            const storageKey = `dbsc${key.charAt(0).toUpperCase() + key.slice(1)}`;
            localStorage.setItem(storageKey, value);
            console.log('[Chart] Saved to localStorage:', storageKey, '=', value);
            
            // Always recalculate (panel always shows data)
            console.log('[Chart] DB SC setting changed, calling updateDBSCSignals');
            this.updateDBSCSignals();
        } else {
            console.warn('[Chart] setDBSCSetting: key not found in this.dbsc:', key);
        }
    }
    
    /**
     * Set DB SC calculator setting (affects calculation logic)
     */
    setDBSCCalculatorSetting(key, value) {
        // Update localStorage
        localStorage.setItem(`dbscCalc${key.charAt(0).toUpperCase() + key.slice(1)}`, value);
        
        // Update calculator if exists
        if (this.dbsc.calculator && this.dbsc.calculator.settings.hasOwnProperty(key)) {
            this.dbsc.calculator.settings[key] = value;
            
            // Always recalculate (panel always shows data)
            this.updateDBSCSignals();
        }
    }
    
    /**
     * Set DB SC MTF (Multi-Timeframe) timeframe
     * @param {string} timeframe - Timeframe string (e.g., '1d', '4h') or '' for same as chart
     */
    setDBSCMTFTimeframe(timeframe) {
        this.dbsc.mtfTimeframe = timeframe;
        localStorage.setItem('dbscMtfTimeframe', timeframe);
        console.log('[Chart] DB SC MTF timeframe set to:', timeframe || 'Same as Chart');
        
        // Clear MTF cache
        this.dbsc.mtfCandles = [];
        this.dbsc.mtfResult = null;
        this.dbsc.mtfLastFetch = null;
        
        // Always fetch and recalculate (panel always shows data)
        if (timeframe) {
            this.fetchDBSCMTFCandles().then(() => {
                this.updateDBSCSignals();
            });
        } else {
            this.updateDBSCSignals();
        }
    }
    
    /**
     * Fetch candles for DB SC MTF calculation
     * @returns {Promise<void>}
     */
    async fetchDBSCMTFCandles() {
        // Skip if no MTF timeframe set or already fetching
        if (!this.dbsc.mtfTimeframe || this.dbsc.mtfFetching) {
            return;
        }
        
        // Check if we have recent data (cache for 1 minute)
        const now = Date.now();
        if (this.dbsc.mtfLastFetch && (now - this.dbsc.mtfLastFetch) < 60000 && this.dbsc.mtfCandles.length > 0) {
            return;
        }
        
        this.dbsc.mtfFetching = true;
        
        try {
            const symbol = this.symbol + 'USDT';
            const interval = this.dbsc.mtfTimeframe;
            // Use Binance Vision API (CORS-friendly, no API key needed)
            const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=500`;
            
            console.log(`[Chart] Fetching MTF candles: ${symbol} @ ${interval}`);
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const data = await response.json();
            
            // Convert Binance kline format to our candle format
            this.dbsc.mtfCandles = data.map(k => ({
                time: Math.floor(k[0] / 1000), // Convert ms to seconds
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            
            this.dbsc.mtfLastFetch = now;
            console.log(`[Chart] Fetched ${this.dbsc.mtfCandles.length} MTF candles for ${interval}`);
            
        } catch (error) {
            console.error('[Chart] Failed to fetch MTF candles:', error);
            this.dbsc.mtfCandles = [];
        } finally {
            this.dbsc.mtfFetching = false;
        }
    }
    
    /**
     * Get MTF timeframe label for display
     * @param {string} tf - Timeframe string
     * @returns {string} - Short label (e.g., 'D', '4H', 'W')
     */
    getMTFLabel(tf) {
        const labels = {
            '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
            '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
            '1d': 'D', '3d': '3D', '1w': 'W'
        };
        return labels[tf] || tf.toUpperCase();
    }
    
    /**
     * Get interval in seconds for a timeframe
     * @param {string} tf - Timeframe string
     * @returns {number} - Interval in seconds
     */
    getIntervalSeconds(tf) {
        const intervals = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        return intervals[tf] || 3600;
    }
    
    /**
     * Map MTF signals to chart bar timestamps
     * Places each MTF signal at the first chart bar that falls within the MTF bar period
     * @param {Array} mtfSignals - Signals from MTF calculation
     * @param {Array} chartCandles - Current chart candles
     * @param {string} mtfTimeframe - MTF timeframe string
     * @returns {Array} - Signals with timestamps mapped to chart bars
     */
    mapMTFSignalsToChart(mtfSignals, chartCandles, mtfTimeframe) {
        if (!mtfSignals || !chartCandles || chartCandles.length === 0) {
            return [];
        }
        
        const mtfIntervalSecs = this.getIntervalSeconds(mtfTimeframe);
        const mappedSignals = [];
        
        // Create a map of chart bar times for quick lookup
        const chartBarTimes = new Set(chartCandles.map(c => c.time));
        const sortedChartTimes = chartCandles.map(c => c.time).sort((a, b) => a - b);
        
        for (const mtfSignal of mtfSignals) {
            const mtfBarStart = mtfSignal.time;
            const mtfBarEnd = mtfBarStart + mtfIntervalSecs;
            
            // Find the first chart bar that falls within this MTF bar period
            let targetChartTime = null;
            for (const chartTime of sortedChartTimes) {
                if (chartTime >= mtfBarStart && chartTime < mtfBarEnd) {
                    targetChartTime = chartTime;
                    break;
                }
            }
            
            // If no chart bar found in the MTF period, try to find the closest one after
            if (targetChartTime === null) {
                for (const chartTime of sortedChartTimes) {
                    if (chartTime >= mtfBarStart) {
                        targetChartTime = chartTime;
                        break;
                    }
                }
            }
            
            // Only add signal if we found a valid chart bar
            if (targetChartTime !== null && chartBarTimes.has(targetChartTime)) {
                mappedSignals.push({
                    time: targetChartTime,
                    signals: mtfSignal.signals,
                    mtfTime: mtfBarStart, // Keep original MTF time for reference
                    index: mtfSignal.index
                });
            }
        }
        
        return mappedSignals;
    }
    
    /**
     * Update DB SC Signals - calculate and render markers
     * Always calculates for panel display, markers only shown when enabled
     */
    updateDBSCSignals() {
        if (!this.chart || !this.candleSeries) {
            return;
        }
        
        // Check if DBSCIndicator class is loaded
        if (typeof DBSCIndicator === 'undefined') {
            console.log('[Chart] updateDBSCSignals skipped - DBSCIndicator not loaded');
            return;
        }
        
        const chartCandles = this.getCandles();
        if (!chartCandles || chartCandles.length < 10) {
            return;
        }
        
        // Create calculator instance if not exists
        if (!this.dbsc.calculator) {
            this.dbsc.calculator = new DBSCIndicator();
        }
        
        // Determine if using MTF mode
        const useMTF = this.dbsc.mtfTimeframe && this.dbsc.mtfCandles.length > 0;
        const mtfLabel = useMTF ? this.getMTFLabel(this.dbsc.mtfTimeframe) + ':' : '';
        
        // Get candles to use for calculation
        const candles = useMTF ? this.dbsc.mtfCandles : chartCandles;
        
        // Calculate all signals
        const result = this.dbsc.calculator.calculate(candles);
        
        // Store result (in appropriate location for MTF vs local)
        if (useMTF) {
            this.dbsc.mtfResult = result;
            this.dbsc.lastResult = result; // Also update lastResult for panel
        } else {
            this.dbsc.lastResult = result;
        }
        
        // Always update panel with latest data
        this.updateDBSCPanel();
        
        // Only build markers if indicator is enabled (chart display)
        if (!this.dbsc.enabled) {
            return;
        }
        
        // Build markers from signals
        const markers = [];
        const { barsToSetup, barsToCountdown } = this.dbsc.calculator.settings;
        
        // For MTF mode, map signals to chart bar timestamps
        const signalsToProcess = useMTF 
            ? this.mapMTFSignalsToChart(result.signals, chartCandles, this.dbsc.mtfTimeframe)
            : result.signals;
        
        for (const item of signalsToProcess) {
            const { time, signals } = item;
            
            // Determine which counts to show based on settings
            const showCount = (count, isSetup) => {
                if (this.dbsc.cleanMode) {
                    // Clean mode: only 9/13 completions
                    if (isSetup) {
                        return count === barsToSetup;
                    } else {
                        return count === barsToCountdown || count === 'R' || 
                               (typeof count === 'string' && count.startsWith('+'));
                    }
                } else if (this.dbsc.showAllCounts) {
                    return true;
                } else {
                    // Key counts only: 1-3, 7-9 for setup; 1-3, 8, 13 for countdown
                    if (isSetup) {
                        return count <= 3 || count >= barsToSetup - 2;
                    } else {
                        const numCount = typeof count === 'number' ? count : 
                                        (count === 'R' ? barsToCountdown : parseInt(count));
                        return numCount <= 3 || numCount === 8 || numCount >= barsToCountdown ||
                               (typeof count === 'string' && count.startsWith('+'));
                    }
                }
            };
            
            // Track markers per position to handle overlap
            let belowBarSetup = null;
            let belowBarCountdown = null;
            let aboveBarSetup = null;
            let aboveBarCountdown = null;
            
            // Collect Buy Setup (below bar)
            if (this.dbsc.showSetup && signals.buySetup && showCount(signals.buySetup.count, true)) {
                const count = signals.buySetup.count;
                const isPerfected = signals.buySetup.perfected && count === barsToSetup;
                const isCompletion = count === barsToSetup;
                const baseText = isPerfected ? '9+' : String(count);
                belowBarSetup = {
                    text: mtfLabel + baseText,
                    color: isCompletion ? '#14b8a6' : 'rgba(20, 184, 166, 0.8)',
                    isCompletion
                };
            }
            
            // Collect Sell Setup (above bar)
            if (this.dbsc.showSetup && signals.sellSetup && showCount(signals.sellSetup.count, true)) {
                const count = signals.sellSetup.count;
                const isPerfected = signals.sellSetup.perfected && count === barsToSetup;
                const isCompletion = count === barsToSetup;
                const baseText = isPerfected ? '9+' : String(count);
                aboveBarSetup = {
                    text: mtfLabel + baseText,
                    color: isCompletion ? '#ef4444' : 'rgba(239, 68, 68, 0.8)',
                    isCompletion
                };
            }
            
            // Collect Buy Countdown (below bar)
            if (this.dbsc.showSequential && signals.buyCountdown) {
                const count = signals.buyCountdown.count;
                const isCompletion = count === barsToCountdown || signals.buyCountdown.completed;
                const isRecycled = count === 'R' || signals.buyCountdown.recycled;
                
                if (showCount(count, false)) {
                    const baseText = isRecycled ? 'R' : String(count);
                    belowBarCountdown = {
                        text: mtfLabel + baseText,
                        color: isCompletion ? '#00ffff' : 'rgba(0, 255, 255, 0.7)',
                        isCompletion
                    };
                }
            }
            
            // Collect Sell Countdown (above bar)
            if (this.dbsc.showSequential && signals.sellCountdown) {
                const count = signals.sellCountdown.count;
                const isCompletion = count === barsToCountdown || signals.sellCountdown.completed;
                const isRecycled = count === 'R' || signals.sellCountdown.recycled;
                
                if (showCount(count, false)) {
                    const baseText = isRecycled ? 'R' : String(count);
                    aboveBarCountdown = {
                        text: mtfLabel + baseText,
                        color: isCompletion ? '#ff00ff' : 'rgba(255, 0, 255, 0.7)',
                        isCompletion
                    };
                }
            }
            
            // Handle below bar markers (setup and countdown may overlap)
            if (belowBarSetup && belowBarCountdown) {
                // Both exist - combine into one marker with format "setup/countdown"
                const isAnyCompletion = belowBarSetup.isCompletion || belowBarCountdown.isCompletion;
                markers.push({
                    time: time,
                    position: 'belowBar',
                    color: belowBarCountdown.isCompletion ? '#00ffff' : belowBarSetup.color,
                    shape: isAnyCompletion ? 'arrowUp' : 'text',
                    text: `${belowBarSetup.text}/${belowBarCountdown.text}`
                });
            } else if (belowBarSetup) {
                markers.push({
                    time: time,
                    position: 'belowBar',
                    color: belowBarSetup.color,
                    shape: belowBarSetup.isCompletion ? 'arrowUp' : 'text',
                    text: belowBarSetup.text
                });
            } else if (belowBarCountdown) {
                markers.push({
                    time: time,
                    position: 'belowBar',
                    color: belowBarCountdown.color,
                    shape: belowBarCountdown.isCompletion ? 'arrowUp' : 'text',
                    text: belowBarCountdown.text
                });
            }
            
            // Handle above bar markers (setup and countdown may overlap)
            if (aboveBarSetup && aboveBarCountdown) {
                // Both exist - combine into one marker with format "setup/countdown"
                const isAnyCompletion = aboveBarSetup.isCompletion || aboveBarCountdown.isCompletion;
                markers.push({
                    time: time,
                    position: 'aboveBar',
                    color: aboveBarCountdown.isCompletion ? '#ff00ff' : aboveBarSetup.color,
                    shape: isAnyCompletion ? 'arrowDown' : 'text',
                    text: `${aboveBarSetup.text}/${aboveBarCountdown.text}`
                });
            } else if (aboveBarSetup) {
                markers.push({
                    time: time,
                    position: 'aboveBar',
                    color: aboveBarSetup.color,
                    shape: aboveBarSetup.isCompletion ? 'arrowDown' : 'text',
                    text: aboveBarSetup.text
                });
            } else if (aboveBarCountdown) {
                markers.push({
                    time: time,
                    position: 'aboveBar',
                    color: aboveBarCountdown.color,
                    shape: aboveBarCountdown.isCompletion ? 'arrowDown' : 'text',
                    text: aboveBarCountdown.text
                });
            }
            
            // Combo markers (separate - usually don't overlap with Sequential)
            // Combo Buy markers (below bar) - use inBar position to avoid overlap
            if (this.dbsc.showCombo && signals.comboBuy) {
                const count = signals.comboBuy.count;
                const isCompletion = count >= barsToCountdown || signals.comboBuy.completed;
                
                if (showCount(count, false)) {
                    markers.push({
                        time: time,
                        position: 'inBar',
                        color: isCompletion ? '#00d4aa' : 'rgba(0, 212, 170, 0.7)',
                        shape: 'text',
                        text: `${mtfLabel}C${count}`
                    });
                }
            }
            
            // Combo Sell markers (above bar) - prefix with 'C' to distinguish
            if (this.dbsc.showCombo && signals.comboSell) {
                const count = signals.comboSell.count;
                const isCompletion = count >= barsToCountdown || signals.comboSell.completed;
                
                if (showCount(count, false)) {
                    markers.push({
                        time: time,
                        position: 'inBar',
                        color: isCompletion ? '#ff6b6b' : 'rgba(255, 107, 107, 0.7)',
                        shape: 'text',
                        text: `${mtfLabel}C${count}`
                    });
                }
            }
        }
        
        // Store markers
        this.dbsc.markers = markers;
        console.log('[Chart] DB SC markers:', markers.length, useMTF ? `(MTF: ${this.dbsc.mtfTimeframe})` : '(Local)');
        
        // Draw TDST lines if enabled
        if (this.dbsc.showTDST) {
            this.drawDBSCTDSTLines(result);
        }
        
        // Update combined markers
        this.updateAllSignalMarkers();
    }
    
    /**
     * Draw TDST price lines
     */
    drawDBSCTDSTLines(result) {
        // Clear existing TDST lines
        this.clearDBSCLines();
        
        if (!this.candleSeries || !result) return;
        
        // Buy TDST (resistance line from buy setup)
        if (result.buySetupTDST !== null) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.buySetupTDST,
                    color: result.buyTDSTQualified ? '#14b8a6' : 'rgba(20, 184, 166, 0.6)',
                    lineWidth: 2,
                    lineStyle: result.buyTDSTQualified ? 
                        LightweightCharts.LineStyle.Solid : 
                        LightweightCharts.LineStyle.Dashed,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.tdstLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create buy TDST line:', e);
            }
        }
        
        // Sell TDST (support line from sell setup)
        if (result.sellSetupTDST !== null) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.sellSetupTDST,
                    color: result.sellTDSTQualified ? '#ef4444' : 'rgba(239, 68, 68, 0.6)',
                    lineWidth: 2,
                    lineStyle: result.sellTDSTQualified ? 
                        LightweightCharts.LineStyle.Solid : 
                        LightweightCharts.LineStyle.Dashed,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.tdstLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create sell TDST line:', e);
            }
        }
        
        // Buy Countdown Risk Level
        if (result.buyCountdownRisk !== null) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.buyCountdownRisk,
                    color: 'rgba(0, 255, 255, 0.4)',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.riskLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create buy countdown risk line:', e);
            }
        }
        
        // Sell Countdown Risk Level
        if (result.sellCountdownRisk !== null) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.sellCountdownRisk,
                    color: 'rgba(255, 0, 255, 0.4)',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.riskLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create sell countdown risk line:', e);
            }
        }
        
        // Buy Setup Risk Level (stop level below price for buy signal)
        if (result.buySetupRisk !== null && result.buySetupRisk !== result.buyCountdownRisk) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.buySetupRisk,
                    color: 'rgba(20, 184, 166, 0.35)',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.riskLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create buy setup risk line:', e);
            }
        }
        
        // Sell Setup Risk Level (stop level above price for sell signal)
        if (result.sellSetupRisk !== null && result.sellSetupRisk !== result.sellCountdownRisk) {
            try {
                const line = this.candleSeries.createPriceLine({
                    price: result.sellSetupRisk,
                    color: 'rgba(239, 68, 68, 0.35)',
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Dotted,
                    axisLabelVisible: false,
                    title: ''
                });
                this.dbsc.riskLines.push(line);
            } catch (e) {
                console.warn('[Chart] Failed to create sell setup risk line:', e);
            }
        }
    }
    
    /**
     * Clear all DB SC lines from chart
     */
    clearDBSCLines() {
        if (!this.candleSeries) return;
        
        // Remove TDST lines
        for (const line of this.dbsc.tdstLines) {
            try {
                this.candleSeries.removePriceLine(line);
            } catch (e) {
                // Line may already be removed
            }
        }
        this.dbsc.tdstLines = [];
        
        // Remove risk lines
        for (const line of this.dbsc.riskLines) {
            try {
                this.candleSeries.removePriceLine(line);
            } catch (e) {
                // Line may already be removed
            }
        }
        this.dbsc.riskLines = [];
    }
    
    /**
     * Clear DB SC signals (markers and lines)
     */
    clearDBSCSignals() {
        this.dbsc.markers = [];
        this.clearDBSCLines();
        
        // Reset calculator if exists
        if (this.dbsc.calculator) {
            this.dbsc.calculator.reset();
        }
        this.dbsc.lastResult = null;
        this.dbsc.lastBarTime = null;
        
        // Update combined markers
        this.updateAllSignalMarkers();
    }
    
    /**
     * Reset DB SC state (for symbol/interval changes)
     */
    resetDBSCState() {
        this.clearDBSCSignals();
        this.updateDBSCPanel(); // Reset panel display
        console.log('[Chart] DB SC state reset');
    }
    
    /**
     * Update DB SC Panel with current indicator state
     */
    updateDBSCPanel() {
        // Get DOM elements
        const panel = document.getElementById('dbscPanel');
        if (!panel) return;
        
        const badge = document.getElementById('dbscBadge');
        const signalMain = document.getElementById('dbscSignalMain');
        const signalDesc = document.getElementById('dbscSignalDesc');
        const interpSection = document.getElementById('dbscInterpretation');
        const interpText = document.getElementById('dbscInterpText');
        
        // Progress elements
        const buySetupCount = document.getElementById('dbscBuySetupCount');
        const sellSetupCount = document.getElementById('dbscSellSetupCount');
        const buySetupFill = document.getElementById('dbscBuySetupFill');
        const sellSetupFill = document.getElementById('dbscSellSetupFill');
        const buyCountdownCount = document.getElementById('dbscBuyCountdownCount');
        const sellCountdownCount = document.getElementById('dbscSellCountdownCount');
        const buyCountdownFill = document.getElementById('dbscBuyCountdownFill');
        const sellCountdownFill = document.getElementById('dbscSellCountdownFill');
        
        // TDST elements
        const buyTDSTEl = document.getElementById('dbscBuyTDST');
        const sellTDSTEl = document.getElementById('dbscSellTDST');
        const buyTDSTValue = document.getElementById('dbscBuyTDSTValue');
        const sellTDSTValue = document.getElementById('dbscSellTDSTValue');
        
        // Panel always shows data - indicator enabled/disabled only controls chart markers
        // If no dbsc object, initialize it
        if (!this.dbsc) {
            return;
        }
        
        // Check if using MTF mode
        const useMTF = this.dbsc.mtfTimeframe && this.dbsc.mtfCandles.length > 0;
        const mtfLabel = useMTF ? this.getMTFLabel(this.dbsc.mtfTimeframe) : '';
        
        // Get current state from calculator
        const result = this.dbsc.lastResult;
        const state = result ? result.state : null;
        
        if (!state) {
            // No data yet
            if (badge) {
                badge.textContent = useMTF ? `${mtfLabel}:Loading` : 'Loading';
                badge.className = 'panel-badge active';
            }
            return;
        }
        
        // Extract counts
        const buySetup = state.buySetup.count || 0;
        const sellSetup = state.sellSetup.count || 0;
        const buyCountdown = state.buyCountdown.count || 0;
        const sellCountdown = state.sellCountdown.count || 0;
        const buyCountdownActive = state.buyCountdown.active;
        const sellCountdownActive = state.sellCountdown.active;
        
        // Determine exhaustion signal
        let exhaustionSignal = 'neutral';
        let signalArrow = '―';
        let signalLabel = 'NEUTRAL';
        let signalDescText = 'No active exhaustion signals';
        let interpClass = '';
        let interpretation = 'Trend may continue. Watch for setup or countdown completions.';
        
        // Check for buy exhaustion (completed buy setup or countdown = potential bottom)
        const buySetupComplete = buySetup >= 9;
        const buyCountdownComplete = buyCountdown >= 13;
        const sellSetupComplete = sellSetup >= 9;
        const sellCountdownComplete = sellCountdown >= 13;
        
        if (buyCountdownComplete) {
            exhaustionSignal = 'buy-exhaustion';
            signalArrow = '▲';
            signalLabel = 'BUY EXHAUSTION';
            signalDescText = 'Countdown 13 complete!';
            interpClass = 'buy';
            interpretation = '🎯 HIGH PROBABILITY reversal zone! Downtrend exhaustion confirmed. Look for long entry opportunities.';
        } else if (sellCountdownComplete) {
            exhaustionSignal = 'sell-exhaustion';
            signalArrow = '▼';
            signalLabel = 'SELL EXHAUSTION';
            signalDescText = 'Countdown 13 complete!';
            interpClass = 'sell';
            interpretation = '🎯 HIGH PROBABILITY reversal zone! Uptrend exhaustion confirmed. Look for short entry opportunities.';
        } else if (buySetupComplete) {
            exhaustionSignal = 'buy-exhaustion';
            signalArrow = '▲';
            signalLabel = 'BUY SETUP';
            signalDescText = 'Setup 9 complete' + (state.buySetup.perfected ? '+' : '');
            interpClass = 'buy';
            interpretation = '⚠️ Downtrend may be weakening. Setup complete' + (state.buySetup.perfected ? ' (perfected)' : '') + '. Watch for countdown confirmation.';
        } else if (sellSetupComplete) {
            exhaustionSignal = 'sell-exhaustion';
            signalArrow = '▼';
            signalLabel = 'SELL SETUP';
            signalDescText = 'Setup 9 complete' + (state.sellSetup.perfected ? '+' : '');
            interpClass = 'sell';
            interpretation = '⚠️ Uptrend may be weakening. Setup complete' + (state.sellSetup.perfected ? ' (perfected)' : '') + '. Watch for countdown confirmation.';
        } else if (buyCountdownActive && buyCountdown >= 8) {
            exhaustionSignal = 'buy-exhaustion';
            signalArrow = '▲';
            signalLabel = 'COUNTDOWN';
            signalDescText = `Buy countdown ${buyCountdown}/13`;
            interpClass = 'buy';
            interpretation = `📊 Buy countdown progressing (${buyCountdown}/13). Downtrend exhaustion building.`;
        } else if (sellCountdownActive && sellCountdown >= 8) {
            exhaustionSignal = 'sell-exhaustion';
            signalArrow = '▼';
            signalLabel = 'COUNTDOWN';
            signalDescText = `Sell countdown ${sellCountdown}/13`;
            interpClass = 'sell';
            interpretation = `📊 Sell countdown progressing (${sellCountdown}/13). Uptrend exhaustion building.`;
        } else if (buySetup >= 7) {
            signalDescText = `Buy setup building (${buySetup}/9)`;
            interpretation = `Building buy setup (${buySetup}/9). Downtrend may be losing steam.`;
        } else if (sellSetup >= 7) {
            signalDescText = `Sell setup building (${sellSetup}/9)`;
            interpretation = `Building sell setup (${sellSetup}/9). Uptrend may be losing steam.`;
        } else if (buyCountdownActive) {
            signalDescText = `Buy countdown active (${buyCountdown}/13)`;
            interpretation = `Buy countdown in progress. Watching for exhaustion signal.`;
        } else if (sellCountdownActive) {
            signalDescText = `Sell countdown active (${sellCountdown}/13)`;
            interpretation = `Sell countdown in progress. Watching for exhaustion signal.`;
        }
        
        // Update badge (include MTF prefix if enabled, show chart status)
        if (badge) {
            const badgePrefix = useMTF ? `${mtfLabel}:` : '';
            const chartOff = !this.dbsc.enabled;
            
            if (exhaustionSignal === 'buy-exhaustion') {
                badge.textContent = badgePrefix + 'BUY' + (chartOff ? ' ⊘' : '');
                badge.className = 'panel-badge signal-buy';
            } else if (exhaustionSignal === 'sell-exhaustion') {
                badge.textContent = badgePrefix + 'SELL' + (chartOff ? ' ⊘' : '');
                badge.className = 'panel-badge signal-sell';
            } else {
                badge.textContent = (useMTF ? mtfLabel : 'Active') + (chartOff ? ' ⊘' : '');
                badge.className = 'panel-badge active';
            }
        }
        
        // Update signal hero
        if (signalMain) {
            signalMain.className = `dbsc-signal-main ${exhaustionSignal}`;
            signalMain.querySelector('.dbsc-arrow').textContent = signalArrow;
            signalMain.querySelector('.dbsc-label').textContent = signalLabel;
        }
        
        if (signalDesc) {
            const mtfIndicator = useMTF ? ` [${mtfLabel}]` : '';
            signalDesc.querySelector('.dbsc-desc-text').textContent = signalDescText + mtfIndicator;
        }
        
        // Update interpretation (add MTF context if enabled)
        if (interpSection) {
            interpSection.className = `dbsc-interpretation ${interpClass}`;
        }
        if (interpText) {
            const mtfContext = useMTF ? ` [${mtfLabel} timeframe]` : '';
            interpText.textContent = interpretation + mtfContext;
        }
        
        // Update setup progress
        const setupMax = 9;
        if (buySetupCount) buySetupCount.textContent = `${buySetup}/${setupMax}`;
        if (sellSetupCount) sellSetupCount.textContent = `${sellSetup}/${setupMax}`;
        if (buySetupFill) buySetupFill.style.width = `${(buySetup / setupMax) * 100}%`;
        if (sellSetupFill) sellSetupFill.style.width = `${(sellSetup / setupMax) * 100}%`;
        
        // Add completed class for animation
        const buySetupItem = buySetupFill?.closest('.dbsc-progress-item');
        const sellSetupItem = sellSetupFill?.closest('.dbsc-progress-item');
        if (buySetupItem) buySetupItem.classList.toggle('completed', buySetupComplete);
        if (sellSetupItem) sellSetupItem.classList.toggle('completed', sellSetupComplete);
        
        // Update countdown progress
        const countdownMax = 13;
        if (buyCountdownCount) buyCountdownCount.textContent = `${buyCountdown}/${countdownMax}`;
        if (sellCountdownCount) sellCountdownCount.textContent = `${sellCountdown}/${countdownMax}`;
        if (buyCountdownFill) buyCountdownFill.style.width = `${(buyCountdown / countdownMax) * 100}%`;
        if (sellCountdownFill) sellCountdownFill.style.width = `${(sellCountdown / countdownMax) * 100}%`;
        
        // Add completed class for animation
        const buyCountdownItem = buyCountdownFill?.closest('.dbsc-progress-item');
        const sellCountdownItem = sellCountdownFill?.closest('.dbsc-progress-item');
        if (buyCountdownItem) buyCountdownItem.classList.toggle('completed', buyCountdownComplete);
        if (sellCountdownItem) sellCountdownItem.classList.toggle('completed', sellCountdownComplete);
        
        // Get current price for level calculations
        const currentPrice = this.lastPrice || 0;
        
        // Key Levels Section
        const resistanceLevel = document.getElementById('dbscResistanceLevel');
        const supportLevel = document.getElementById('dbscSupportLevel');
        const resistancePrice = document.getElementById('dbscResistancePrice');
        const supportPrice = document.getElementById('dbscSupportPrice');
        const resistanceDist = document.getElementById('dbscResistanceDist');
        const supportDist = document.getElementById('dbscSupportDist');
        const riskLevels = document.getElementById('dbscRiskLevels');
        const buyRisk = document.getElementById('dbscBuyRisk');
        const sellRisk = document.getElementById('dbscSellRisk');
        const buyRiskValue = document.getElementById('dbscBuyRiskValue');
        const sellRiskValue = document.getElementById('dbscSellRiskValue');
        
        // Action Box
        const actionBox = document.getElementById('dbscActionBox');
        const actionIcon = document.getElementById('dbscActionIcon');
        const actionTitle = document.getElementById('dbscActionTitle');
        const actionText = document.getElementById('dbscActionText');
        
        // Update Resistance (TDST from Buy Setup)
        const hasResistance = result.buySetupTDST !== null && result.buySetupTDST !== undefined;
        if (resistanceLevel) {
            resistanceLevel.style.display = 'flex';
            if (hasResistance) {
                if (resistancePrice) resistancePrice.textContent = result.buySetupTDST.toFixed(2);
                if (resistanceDist && currentPrice > 0) {
                    const distPercent = ((result.buySetupTDST - currentPrice) / currentPrice * 100);
                    const distClass = Math.abs(distPercent) < 0.5 ? 'at' : (Math.abs(distPercent) < 2 ? 'near' : '');
                    resistanceDist.textContent = `${distPercent >= 0 ? '+' : ''}${distPercent.toFixed(2)}%`;
                    resistanceDist.className = `dbsc-level-distance ${distClass}`;
                }
            } else {
                if (resistancePrice) resistancePrice.textContent = '—';
                if (resistanceDist) {
                    resistanceDist.textContent = 'awaiting setup';
                    resistanceDist.className = 'dbsc-level-distance';
                }
            }
        }
        
        // Update Support (TDST from Sell Setup)
        const hasSupport = result.sellSetupTDST !== null && result.sellSetupTDST !== undefined;
        if (supportLevel) {
            supportLevel.style.display = 'flex';
            if (hasSupport) {
                if (supportPrice) supportPrice.textContent = result.sellSetupTDST.toFixed(2);
                if (supportDist && currentPrice > 0) {
                    const distPercent = ((result.sellSetupTDST - currentPrice) / currentPrice * 100);
                    const distClass = Math.abs(distPercent) < 0.5 ? 'at' : (Math.abs(distPercent) < 2 ? 'near' : '');
                    supportDist.textContent = `${distPercent >= 0 ? '+' : ''}${distPercent.toFixed(2)}%`;
                    supportDist.className = `dbsc-level-distance ${distClass}`;
                }
            } else {
                if (supportPrice) supportPrice.textContent = '—';
                if (supportDist) {
                    supportDist.textContent = 'awaiting setup';
                    supportDist.className = 'dbsc-level-distance';
                }
            }
        }
        
        // Update Risk Levels
        const hasBuyRisk = result.buySetupRisk || result.buyCountdownRisk;
        const hasSellRisk = result.sellSetupRisk || result.sellCountdownRisk;
        if (riskLevels) {
            riskLevels.style.display = (hasBuyRisk || hasSellRisk) ? 'flex' : 'none';
        }
        if (buyRisk && buyRiskValue) {
            const riskVal = result.buyCountdownRisk || result.buySetupRisk;
            if (riskVal) {
                buyRisk.style.display = 'flex';
                buyRiskValue.textContent = riskVal.toFixed(2);
            } else {
                buyRisk.style.display = 'none';
            }
        }
        if (sellRisk && sellRiskValue) {
            const riskVal = result.sellCountdownRisk || result.sellSetupRisk;
            if (riskVal) {
                sellRisk.style.display = 'flex';
                sellRiskValue.textContent = riskVal.toFixed(2);
            } else {
                sellRisk.style.display = 'none';
            }
        }
        
        // Generate Actionable Advice
        if (actionBox && actionIcon && actionTitle && actionText) {
            let actionClass = '';
            let icon = '📋';
            let title = 'Action Plan';
            let advice = '';
            
            // Determine action based on signal and levels
            if (buyCountdownComplete) {
                actionClass = 'buy-action';
                icon = '🎯';
                title = 'BUY OPPORTUNITY';
                advice = `<strong>Downtrend exhaustion confirmed!</strong><br>`;
                if (hasSupport) {
                    advice += `• Entry zone near current price<br>`;
                    advice += `• Support at <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> (stop loss below)<br>`;
                }
                if (hasResistance) {
                    advice += `• Target: <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> resistance`;
                } else {
                    advice += `• Watch for resistance on rally`;
                }
            } else if (sellCountdownComplete) {
                actionClass = 'sell-action';
                icon = '🎯';
                title = 'SELL OPPORTUNITY';
                advice = `<strong>Uptrend exhaustion confirmed!</strong><br>`;
                if (hasResistance) {
                    advice += `• Entry zone near current price<br>`;
                    advice += `• Resistance at <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> (stop loss above)<br>`;
                }
                if (hasSupport) {
                    advice += `• Target: <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> support`;
                } else {
                    advice += `• Watch for support on decline`;
                }
            } else if (buySetupComplete) {
                actionClass = 'caution-action';
                icon = '⚠️';
                title = 'WATCH FOR BUY';
                advice = `<strong>Buy setup complete${state.buySetup.perfected ? ' (perfected)' : ''}.</strong><br>`;
                advice += `• Potential bottom forming<br>`;
                if (hasSupport) {
                    advice += `• Key support: <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span><br>`;
                }
                advice += `• Wait for countdown confirmation or test of support`;
            } else if (sellSetupComplete) {
                actionClass = 'caution-action';
                icon = '⚠️';
                title = 'WATCH FOR SELL';
                advice = `<strong>Sell setup complete${state.sellSetup.perfected ? ' (perfected)' : ''}.</strong><br>`;
                advice += `• Potential top forming<br>`;
                if (hasResistance) {
                    advice += `• Key resistance: <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span><br>`;
                }
                advice += `• Wait for countdown confirmation or test of resistance`;
            } else if (currentPrice > 0) {
                // Price-relative advice - check if levels make sense
                const resistanceAbove = hasResistance && result.buySetupTDST > currentPrice;
                const supportBelow = hasSupport && result.sellSetupTDST < currentPrice;
                
                if (resistanceAbove && supportBelow) {
                    // Both levels valid - price is between them
                    const distToResist = (result.buySetupTDST - currentPrice) / currentPrice * 100;
                    const distToSupport = (currentPrice - result.sellSetupTDST) / currentPrice * 100;
                    
                    if (distToResist < 1) {
                        actionClass = 'sell-action';
                        icon = '🚨';
                        title = 'NEAR RESISTANCE';
                        advice = `Price approaching resistance <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> (${distToResist.toFixed(1)}% away)<br>`;
                        advice += `• Watch for rejection or breakout<br>`;
                        advice += `• Support below at <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span>`;
                    } else if (distToSupport < 1) {
                        actionClass = 'buy-action';
                        icon = '🚨';
                        title = 'NEAR SUPPORT';
                        advice = `Price approaching support <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> (${distToSupport.toFixed(1)}% away)<br>`;
                        advice += `• Watch for bounce or breakdown<br>`;
                        advice += `• Resistance above at <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span>`;
                    } else {
                        icon = '📊';
                        title = 'BETWEEN LEVELS';
                        advice = `Trading between TDST levels:<br>`;
                        advice += `• Resistance: <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> (+${distToResist.toFixed(1)}%)<br>`;
                        advice += `• Support: <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> (-${distToSupport.toFixed(1)}%)`;
                    }
                } else if (resistanceAbove) {
                    // Only resistance valid (above price)
                    const distToResist = (result.buySetupTDST - currentPrice) / currentPrice * 100;
                    icon = '📈';
                    title = 'RESISTANCE ABOVE';
                    advice = `TDST Resistance at <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> (+${distToResist.toFixed(1)}%)<br>`;
                    advice += `• Potential ceiling for rallies`;
                } else if (supportBelow) {
                    // Only support valid (below price)
                    const distToSupport = (currentPrice - result.sellSetupTDST) / currentPrice * 100;
                    icon = '📉';
                    title = 'SUPPORT BELOW';
                    advice = `TDST Support at <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> (-${distToSupport.toFixed(1)}%)<br>`;
                    advice += `• Potential floor for pullbacks`;
                } else if (hasResistance || hasSupport) {
                    // Levels exist but are on wrong side of price (invalidated)
                    icon = '⚡';
                    title = 'LEVELS BROKEN';
                    advice = `TDST levels have been broken:<br>`;
                    if (hasResistance && result.buySetupTDST <= currentPrice) {
                        advice += `• Former resistance <span class="sell-level">${result.buySetupTDST.toFixed(2)}</span> broken (now below price)<br>`;
                    }
                    if (hasSupport && result.sellSetupTDST >= currentPrice) {
                        advice += `• Former support <span class="buy-level">${result.sellSetupTDST.toFixed(2)}</span> broken (now above price)`;
                    }
                } else {
                    // No valid levels
                    icon = '👀';
                    title = 'MONITORING';
                    advice = `No valid TDST levels.<br>`;
                    advice += `• Waiting for setup completion (9-count)`;
                }
            } else if (buyCountdownActive || sellCountdownActive) {
                icon = '⏳';
                title = 'COUNTDOWN ACTIVE';
                if (buyCountdownActive) {
                    advice = `Buy countdown in progress (${buyCountdown}/13)<br>`;
                    advice += `• Watching for downtrend exhaustion`;
                } else {
                    advice = `Sell countdown in progress (${sellCountdown}/13)<br>`;
                    advice += `• Watching for uptrend exhaustion`;
                }
            } else {
                icon = '👀';
                title = 'MONITORING';
                advice = `No active signals. Watching for:<br>`;
                advice += `• Setup formation (9-count)<br>`;
                advice += `• Countdown completion (13-count)`;
            }
            
            actionBox.className = `dbsc-action-box ${actionClass}`;
            actionIcon.textContent = icon;
            actionTitle.textContent = title;
            actionText.innerHTML = advice;
        }
    }
    
    // ==========================================
    // Bulls vs Bears Signal (Order Book Pressure)
    // ==========================================
    
    /**
     * Toggle Bulls vs Bears Signal
     */
    toggleBullsBears(show) {
        this.bullsBears.enabled = show;
        console.log('[Chart] toggleBullsBears signals:', show);
        
        if (show) {
            // NOTE: Level tracking now handled by unified levelHistory system
            // Bulls vs Bears now only provides signal arrows (not level lines)
            // Load saved markers history from localStorage
            this.loadBullsBearsHistory();
        } else {
            this.clearBullsBearsSignals();
        }
        
        // Initialize Cluster Proximity signal
        if (this.clusterProximity.enabled) {
            this.loadClusterProximityHistory();
        } else {
            this.clearClusterProximitySignals();
        }
        
        localStorage.setItem('showBullsBears', show);
        this.updateAllSignalMarkers();
    }
    
    /**
     * Create line series for Bulls vs Bears level tracking
     */
    createBullsBearsLineSeries() {
        if (!this.chart) return;
        
        // Remove existing series first
        this.removeBullsBearsLineSeries();
        
        // Resistance line (above price) - magenta
        this.bullsBears.resistanceSeries = this.chart.addLineSeries({
            color: 'rgba(255, 0, 110, 0.7)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        });
        
        // Support line (below price) - cyan
        this.bullsBears.supportSeries = this.chart.addLineSeries({
            color: 'rgba(0, 217, 255, 0.7)',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
        });
    }
    
    /**
     * Remove Bulls vs Bears line series
     */
    removeBullsBearsLineSeries() {
        if (this.bullsBears.resistanceSeries && this.chart) {
            try {
                this.chart.removeSeries(this.bullsBears.resistanceSeries);
            } catch (e) { /* ignore */ }
            this.bullsBears.resistanceSeries = null;
        }
        if (this.bullsBears.supportSeries && this.chart) {
            try {
                this.chart.removeSeries(this.bullsBears.supportSeries);
            } catch (e) { /* ignore */ }
            this.bullsBears.supportSeries = null;
        }
    }
    
    /**
     * Load Bulls vs Bears history from IndexedDB
     * NOTE: Level tracking now handled by levelHistory system - only loading markers here
     */
    async loadBullsBearsHistory() {
        try {
            // Load markers from IndexedDB
            const markers = await db.getSignalMarkers('bullsBears');
            if (markers && markers.length > 0) {
                this.bullsBears.markers = markers;
                console.log('[Chart] Loaded', this.bullsBears.markers.length, 'Bulls vs Bears markers from IndexedDB');
            }
        } catch (e) {
            console.warn('[Chart] Error loading Bulls vs Bears history:', e);
        }
    }
    
    /**
     * Save Bulls vs Bears history to IndexedDB
     * NOTE: Level tracking now handled by levelHistory system - only saving markers here
     */
    saveBullsBearsHistory() {
        try {
            db.saveSignalMarkers('bullsBears', this.bullsBears.markers);
        } catch (e) {
            console.warn('[Chart] Error saving Bulls vs Bears history:', e);
        }
    }
    
    /**
     * Set Bulls vs Bears calculation method
     * @param {string} method - 'firstLevel' or 'percentRange'
     */
    setBullsBearsMethod(method) {
        this.bullsBears.method = method;
        localStorage.setItem('bullsBearsMethod', method);
        console.log('[Chart] Bulls vs Bears method set to:', method);
    }
    
    /**
     * Calculate Bulls vs Bears signal from order book levels
     * @param {Array} levels - Array of {price, volume, type: 'support'|'resistance'}
     * @param {number} currentPrice - Current market price
     * @returns {Object} {ratio, direction: 'bull'|'bear'|'neutral', resistanceVol, supportVol}
     */
    calculateBullsBearsSignal(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return { ratio: 1, direction: 'neutral', resistanceVol: 0, supportVol: 0, resistancePrice: null, supportPrice: null };
        }
        
        const method = this.bullsBears.method;
        let resistanceVol = 0;
        let supportVol = 0;
        let resistancePrice = null;
        let supportPrice = null;
        
        if (method === 'firstLevel') {
            // First Level Method: Compare closest levels on each side
            const resistanceLevels = levels
                .filter(l => l.type === 'resistance' && l.price > currentPrice)
                .sort((a, b) => a.price - b.price); // Closest first
                
            const supportLevels = levels
                .filter(l => l.type === 'support' && l.price < currentPrice)
                .sort((a, b) => b.price - a.price); // Closest first
            
            if (resistanceLevels.length > 0) {
                resistanceVol = resistanceLevels[0].volume;
                resistancePrice = resistanceLevels[0].price;
            }
            if (supportLevels.length > 0) {
                supportVol = supportLevels[0].volume;
                supportPrice = supportLevels[0].price;
            }
            
        } else {
            // Percent Range Method: Sum all levels within X% of price
            const rangePct = this.bullsBears.percentRange / 100;
            const upperBound = currentPrice * (1 + rangePct);
            const lowerBound = currentPrice * (1 - rangePct);
            
            for (const level of levels) {
                if (level.type === 'resistance' && level.price > currentPrice && level.price <= upperBound) {
                    resistanceVol += level.volume;
                } else if (level.type === 'support' && level.price < currentPrice && level.price >= lowerBound) {
                    supportVol += level.volume;
                }
            }
            // For percent range method, no single price level to track
        }
        
        // Calculate ratio
        if (supportVol === 0 && resistanceVol === 0) {
            return { ratio: 1, direction: 'neutral', resistanceVol: 0, supportVol: 0, resistancePrice: null, supportPrice: null };
        }
        
        // Avoid division by zero
        // Ratio = support/resistance (bids/asks): >1 = more bids = bullish
        const ratio = resistanceVol > 0 ? supportVol / resistanceVol : (supportVol > 0 ? Infinity : 1);
        
        // Determine direction
        let direction = 'neutral';
        if (ratio > 1) {
            direction = 'bull'; // More support than resistance = bulls winning
        } else if (ratio < 1) {
            direction = 'bear'; // More resistance than support = bears winning
        }
        
        return { ratio, direction, resistanceVol, supportVol, resistancePrice, supportPrice };
    }
    
    /**
     * Update Bulls vs Bears marker on current bar
     * Called when order book levels update
     * @param {Array} levels - Current order book levels
     * @param {number} currentPrice - Current market price
     */
    updateBullsBearsMarker(levels, currentPrice) {
        if (!this.bullsBears.enabled || !this.lastCandle) {
            return;
        }
        
        const signal = this.calculateBullsBearsSignal(levels, currentPrice);
        this.bullsBears.lastRatio = signal.ratio;
        
        const currentBarTime = this.lastCandle.time;
        
        // Check if bar changed - finalize previous bar's signal
        if (this.bullsBears.lastBarTime && this.bullsBears.lastBarTime !== currentBarTime) {
            this.finalizeBullsBearsSignal();
        }
        
        this.bullsBears.lastBarTime = currentBarTime;
        
        // Create live marker for current bar - numbers only, positioned above high / below low
        if (signal.direction === 'neutral') {
            this.bullsBears.liveMarker = null;
        } else {
            const ratioText = signal.ratio === Infinity ? '∞' : signal.ratio.toFixed(2);
            this.bullsBears.liveMarker = {
                time: currentBarTime,
                position: signal.direction === 'bull' ? 'belowBar' : 'aboveBar',
                color: signal.direction === 'bull' ? '#10b981' : '#ef4444',
                shape: 'square',
                text: ratioText,
                size: 0
            };
        }
        
        // NOTE: Level tracking now handled by unified levelHistory system
        // Bulls vs Bears now only provides signal arrows
        
        // Update chart markers
        this.updateAllSignalMarkers();
    }
    
    /**
     * Update Bulls vs Bears line series with live data point
     */
    updateBullsBearsLiveLines(time) {
        if (!this.bullsBears.resistanceSeries || !this.bullsBears.supportSeries) {
            return;
        }
        
        // Update resistance line with live point
        if (this.bullsBears.liveResistance !== null) {
            const resistanceData = [...this.bullsBears.resistanceData];
            // Remove any existing point at this time
            const existingIdx = resistanceData.findIndex(p => p.time === time);
            if (existingIdx >= 0) {
                resistanceData[existingIdx] = { time, value: this.bullsBears.liveResistance };
            } else {
                resistanceData.push({ time, value: this.bullsBears.liveResistance });
            }
            resistanceData.sort((a, b) => a.time - b.time);
            try {
                this.bullsBears.resistanceSeries.setData(resistanceData);
            } catch (e) { /* ignore */ }
        }
        
        // Update support line with live point
        if (this.bullsBears.liveSupport !== null) {
            const supportData = [...this.bullsBears.supportData];
            // Remove any existing point at this time
            const existingIdx = supportData.findIndex(p => p.time === time);
            if (existingIdx >= 0) {
                supportData[existingIdx] = { time, value: this.bullsBears.liveSupport };
            } else {
                supportData.push({ time, value: this.bullsBears.liveSupport });
            }
            supportData.sort((a, b) => a.time - b.time);
            try {
                this.bullsBears.supportSeries.setData(supportData);
            } catch (e) { /* ignore */ }
        }
    }
    
    /**
     * Finalize Bulls vs Bears signal when bar closes
     * Freezes the current signal as a historical marker
     */
    finalizeBullsBearsSignal() {
        if (this.bullsBears.liveMarker) {
            // Add to historical markers
            this.bullsBears.markers.push({ ...this.bullsBears.liveMarker });
            
            // Cap historical markers (keep last 500)
            if (this.bullsBears.markers.length > 500) {
                this.bullsBears.markers = this.bullsBears.markers.slice(-500);
            }
            
            console.log('[Chart] Bulls vs Bears signal finalized:', this.bullsBears.liveMarker);
        }
        
        // NOTE: Level tracking now handled by unified levelHistory system
        
        // Save markers to localStorage
        this.saveBullsBearsHistory();
        
        // Clear live data for next bar
        this.bullsBears.liveMarker = null;
        this.bullsBears.liveResistance = null;
        this.bullsBears.liveSupport = null;
    }
    
    /**
     * Clear all Bulls vs Bears signals
     */
    clearBullsBearsSignals() {
        this.bullsBears.markers = [];
        this.bullsBears.liveMarker = null;
        this.bullsBears.lastRatio = null;
        this.bullsBears.lastBarTime = null;
        this.bullsBears.resistanceData = [];
        this.bullsBears.supportData = [];
        this.bullsBears.liveResistance = null;
        this.bullsBears.liveSupport = null;
        
        // Clear localStorage
        localStorage.removeItem('bullsBearsMarkers');
        localStorage.removeItem('bullsBearsResistanceData');
        localStorage.removeItem('bullsBearsSupportData');
        
        // Clear line series data
        if (this.bullsBears.resistanceSeries) {
            try { this.bullsBears.resistanceSeries.setData([]); } catch (e) { /* ignore */ }
        }
        if (this.bullsBears.supportSeries) {
            try { this.bullsBears.supportSeries.setData([]); } catch (e) { /* ignore */ }
        }
        
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Cluster Proximity Signal
    // ==========================================
    
    /**
     * Toggle Cluster Proximity Signal
     * Fires when bar opens within threshold of strongest cluster
     */
    toggleClusterProximity(show) {
        this.clusterProximity.enabled = show;
        console.log('[Chart] toggleClusterProximity:', show);
        localStorage.setItem('showClusterProximity', show);
        
        if (!show) {
            this.clusterProximity.liveMarker = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Set Cluster Proximity threshold (0.2 = 20%)
     */
    setClusterProximityThreshold(threshold) {
        this.clusterProximity.threshold = parseFloat(threshold) || 0.2;
        localStorage.setItem('clusterProximityThreshold', this.clusterProximity.threshold);
        console.log('[Chart] setClusterProximityThreshold:', this.clusterProximity.threshold);
    }
    
    /**
     * Set Cluster Proximity lock time in seconds
     */
    setClusterProximityLockTime(seconds) {
        this.clusterProximity.lockTime = parseInt(seconds) || 5;
        localStorage.setItem('clusterProximityLockTime', this.clusterProximity.lockTime);
        console.log('[Chart] setClusterProximityLockTime:', this.clusterProximity.lockTime, 'seconds');
    }
    
    /**
     * Update Cluster Proximity signal on bar open
     * Called when new bar starts or levels change
     * @param {Array} levels - Order book levels [{price, volume, type}, ...]
     * @param {number} barOpenPrice - The open price of the current bar
     * @param {number} barTime - The timestamp of the current bar
     */
    updateClusterProximitySignal(levels, barOpenPrice, barTime) {
        // Always compute signals for the panel, even if chart display is disabled
        if (!levels || levels.length === 0 || !barOpenPrice || !barTime) {
            return;
        }
        
        const now = Date.now();
        const lockTimeMs = this.clusterProximity.lockTime * 1000;
        // Calculate actual time since bar opened (barTime is in seconds)
        const actualBarStartMs = barTime * 1000;
        const actualTimeSinceBarStart = now - actualBarStartMs;
        
        // Check if bar changed - finalize previous bar's signal and reset
        if (this.clusterProximity.lastBarTime && this.clusterProximity.lastBarTime !== barTime) {
            this.finalizeClusterProximitySignal();
            // Reset for new bar
            this.clusterProximity.barStartTimestamp = now;
            this.clusterProximity.isLocked = false;
            this.clusterProximity.isLateJoin = false;
            this.clusterProximity.buyTicks = 0;
            this.clusterProximity.sellTicks = 0;
        } else if (!this.clusterProximity.lastBarTime) {
            // First time - check if we're joining late (after lock time has passed)
            this.clusterProximity.barStartTimestamp = now;
            this.clusterProximity.isLocked = false;
            this.clusterProximity.buyTicks = 0;
            this.clusterProximity.sellTicks = 0;
            
            // Detect late join - if actual bar is already past lock time
            if (actualTimeSinceBarStart >= lockTimeMs) {
                this.clusterProximity.isLateJoin = true;
                console.log(`[ClusterProximity] Late join detected - bar is ${(actualTimeSinceBarStart / 1000).toFixed(1)}s old, lock time is ${this.clusterProximity.lockTime}s`);
            } else {
                this.clusterProximity.isLateJoin = false;
            }
        }
        
        this.clusterProximity.lastBarTime = barTime;
        
        // Check if we should lock the signal
        const timeSinceBarStart = now - this.clusterProximity.barStartTimestamp;
        
        if (timeSinceBarStart >= lockTimeMs && !this.clusterProximity.isLocked) {
            // Lock the signal based on majority
            this.clusterProximity.isLocked = true;
            
            // Determine final signal based on tick counts
            if (this.clusterProximity.buyTicks > this.clusterProximity.sellTicks) {
                this.clusterProximity.lastSignal = { direction: 'buy' };
                console.log(`[ClusterProximity] Signal LOCKED: BUY (${this.clusterProximity.buyTicks} buy vs ${this.clusterProximity.sellTicks} sell)${this.clusterProximity.isLateJoin ? ' [LATE]' : ''}`);
            } else if (this.clusterProximity.sellTicks > this.clusterProximity.buyTicks) {
                this.clusterProximity.lastSignal = { direction: 'sell' };
                console.log(`[ClusterProximity] Signal LOCKED: SELL (${this.clusterProximity.sellTicks} sell vs ${this.clusterProximity.buyTicks} buy)${this.clusterProximity.isLateJoin ? ' [LATE]' : ''}`);
            } else {
                this.clusterProximity.lastSignal = null; // Tie - no signal
                console.log(`[ClusterProximity] Signal LOCKED: TIE (${this.clusterProximity.buyTicks} buy vs ${this.clusterProximity.sellTicks} sell)${this.clusterProximity.isLateJoin ? ' [LATE]' : ''}`);
            }
            
            // Update marker color to final color (yellow if late join)
            if (this.clusterProximity.liveMarker && this.clusterProximity.lastSignal) {
                if (this.clusterProximity.isLateJoin) {
                    this.clusterProximity.liveMarker.color = '#fbbf24'; // Yellow for late signal
                } else {
                    this.clusterProximity.liveMarker.color = this.clusterProximity.lastSignal.direction === 'buy' ? '#22c55e' : '#ef4444';
                }
            }
        }
        
        // If signal is locked, just update display
        if (this.clusterProximity.isLocked) {
            this.updateAllSignalMarkers();
            return;
        }
        
        // Find the CLOSEST cluster to bar open price
        let closestCluster = null;
        let closestDistance = Infinity;
        
        for (const level of levels) {
            const price = parseFloat(level.price) || 0;
            const volume = parseFloat(level.volume) || 0;
            
            // Skip garbage entries (invalid prices, no volume)
            if (price < 100 || price > 10000000) continue;
            if (volume <= 0) continue;
            
            // Calculate distance from bar open price
            const distance = Math.abs(barOpenPrice - price);
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestCluster = level;
            }
        }
        
        if (!closestCluster) {
            // No valid cluster found - no tick counted
            this.updateAllSignalMarkers();
            return;
        }
        
        const threshold = this.clusterProximity.threshold;
        
        // Calculate distance as percentage of bar open price
        const distancePercent = closestDistance / barOpenPrice;
        
        // Check if within threshold
        if (distancePercent <= threshold) {
            // Increment tick based on cluster type
            const isSellWall = closestCluster.type === 'resistance';
            if (isSellWall) {
                this.clusterProximity.sellTicks++;
            } else {
                this.clusterProximity.buyTicks++;
            }
            
            // Determine preliminary direction based on current majority
            let prelimDirection = null;
            if (this.clusterProximity.buyTicks > this.clusterProximity.sellTicks) {
                prelimDirection = 'buy';
            } else if (this.clusterProximity.sellTicks > this.clusterProximity.buyTicks) {
                prelimDirection = 'sell';
            }
            
            // Create/update live marker (gray while measuring)
            if (prelimDirection) {
                this.clusterProximity.liveMarker = {
                    time: barTime,
                    position: prelimDirection === 'buy' ? 'belowBar' : 'aboveBar',
                    color: '#9ca3af', // Gray while measuring
                    shape: prelimDirection === 'buy' ? 'arrowUp' : 'arrowDown',
                    text: 'prox',
                    size: 2
                };
                this.clusterProximity.lastSignal = { direction: prelimDirection };
            } else {
                // Tie - no marker yet
                this.clusterProximity.liveMarker = null;
                this.clusterProximity.lastSignal = null;
            }
        }
        // If not within threshold, no tick counted this sample
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Finalize Cluster Proximity signal for completed bar
     */
    finalizeClusterProximitySignal() {
        if (this.clusterProximity.liveMarker && this.clusterProximity.lastSignal) {
            // Set final color based on direction
            this.clusterProximity.liveMarker.color = this.clusterProximity.lastSignal.direction === 'buy' ? '#22c55e' : '#ef4444';
            
            // Add to historical markers
            this.clusterProximity.markers.push({ ...this.clusterProximity.liveMarker });
            
            // Cap historical markers (keep last 500)
            if (this.clusterProximity.markers.length > 500) {
                this.clusterProximity.markers = this.clusterProximity.markers.slice(-500);
            }
            
            console.log('[Chart] Cluster Proximity signal finalized:', this.clusterProximity.lastSignal);
            
            // Save markers
            this.saveClusterProximityHistory();
        }
        
        // Clear live data for next bar
        this.clusterProximity.liveMarker = null;
        this.clusterProximity.lastSignal = null;
    }
    
    /**
     * Save Cluster Proximity markers to IndexedDB
     */
    saveClusterProximityHistory() {
        try {
            db.saveSignalMarkers('clusterProximity', this.clusterProximity.markers);
        } catch (e) {
            console.warn('[Chart] Error saving Cluster Proximity history:', e);
        }
    }
    
    /**
     * Load Cluster Proximity markers from IndexedDB
     */
    async loadClusterProximityHistory() {
        try {
            const markers = await db.getSignalMarkers('clusterProximity');
            if (markers && markers.length > 0) {
                this.clusterProximity.markers = markers;
                console.log('[Chart] Loaded', this.clusterProximity.markers.length, 'Cluster Proximity markers from IndexedDB');
            }
        } catch (e) {
            console.warn('[Chart] Error loading Cluster Proximity history:', e);
        }
    }
    
    /**
     * Clear all Cluster Proximity signals
     */
    clearClusterProximitySignals() {
        this.clusterProximity.markers = [];
        this.clusterProximity.liveMarker = null;
        this.clusterProximity.lastSignal = null;
        this.clusterProximity.lastBarTime = null;
        this.clusterProximity.buyTicks = 0;
        this.clusterProximity.sellTicks = 0;
        this.clusterProximity.isLateJoin = false;
        
        localStorage.removeItem('clusterProximityMarkers');
        
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Cluster Drift Signal
    // Measures directional movement of closest clusters
    // ==========================================
    
    /**
     * Toggle Cluster Drift signal
     */
    toggleClusterDrift(show) {
        this.clusterDrift.enabled = show;
        console.log('[Chart] toggleClusterDrift:', show);
        
        if (show) {
            this.loadClusterDriftHistory();
        } else {
            this.clearClusterDriftSignals();
        }
        
        localStorage.setItem('showClusterDrift', show);
        this.updateAllSignalMarkers();
    }
    
    /**
     * Set Cluster Drift lock time
     */
    setClusterDriftLockTime(seconds) {
        this.clusterDrift.lockTime = parseInt(seconds) || 5;
        localStorage.setItem('clusterDriftLockTime', this.clusterDrift.lockTime);
        console.log('[Chart] setClusterDriftLockTime:', this.clusterDrift.lockTime, 'seconds');
    }
    
    /**
     * Update Cluster Drift signal - measures cluster movement direction
     * Called on each order book update
     */
    updateClusterDriftSignal(levels, currentPrice, barTime) {
        // Always compute signals for the panel, even if chart display is disabled
        if (!levels || levels.length === 0 || !currentPrice || !barTime) {
            return;
        }
        
        const now = Date.now();
        const lockTimeMs = this.clusterDrift.lockTime * 1000;
        // Calculate actual time since bar opened (barTime is in seconds)
        const actualBarStartMs = barTime * 1000;
        const actualTimeSinceBarStart = now - actualBarStartMs;
        
        // Check if bar changed - finalize previous bar's signal
        if (this.clusterDrift.lastBarTime && this.clusterDrift.lastBarTime !== barTime) {
            this.finalizeClusterDriftSignal();
            // Reset for new bar
            this.clusterDrift.barStartTimestamp = now;
            this.clusterDrift.isLocked = false;
            this.clusterDrift.isLateJoin = false;
            this.clusterDrift.upTicks = 0;
            this.clusterDrift.downTicks = 0;
            this.clusterDrift.lastResistancePrice = null;
            this.clusterDrift.lastSupportPrice = null;
        } else if (!this.clusterDrift.lastBarTime) {
            // First time - check if we're joining late (after lock time has passed)
            this.clusterDrift.barStartTimestamp = now;
            this.clusterDrift.isLocked = false;
            this.clusterDrift.upTicks = 0;
            this.clusterDrift.downTicks = 0;
            this.clusterDrift.lastResistancePrice = null;
            this.clusterDrift.lastSupportPrice = null;
            
            // Detect late join - if actual bar is already past lock time
            if (actualTimeSinceBarStart >= lockTimeMs) {
                this.clusterDrift.isLateJoin = true;
                console.log(`[ClusterDrift] Late join detected - bar is ${(actualTimeSinceBarStart / 1000).toFixed(1)}s old, lock time is ${this.clusterDrift.lockTime}s`);
            } else {
                this.clusterDrift.isLateJoin = false;
            }
        }
        
        this.clusterDrift.lastBarTime = barTime;
        
        // Check if we should lock the signal
        const timeSinceBarStart = now - this.clusterDrift.barStartTimestamp;
        
        if (timeSinceBarStart >= lockTimeMs && !this.clusterDrift.isLocked) {
            // Lock the signal
            this.clusterDrift.isLocked = true;
            
            // Determine final signal based on tick counts
            if (this.clusterDrift.upTicks > this.clusterDrift.downTicks) {
                this.clusterDrift.lastSignal = { direction: 'buy' };
                console.log(`[ClusterDrift] Signal LOCKED: UP (${this.clusterDrift.upTicks} up vs ${this.clusterDrift.downTicks} down)${this.clusterDrift.isLateJoin ? ' [LATE]' : ''}`);
            } else if (this.clusterDrift.downTicks > this.clusterDrift.upTicks) {
                this.clusterDrift.lastSignal = { direction: 'sell' };
                console.log(`[ClusterDrift] Signal LOCKED: DOWN (${this.clusterDrift.downTicks} down vs ${this.clusterDrift.upTicks} up)${this.clusterDrift.isLateJoin ? ' [LATE]' : ''}`);
            } else {
                this.clusterDrift.lastSignal = null; // Tie - no signal
                console.log(`[ClusterDrift] Signal LOCKED: TIE (${this.clusterDrift.upTicks} up vs ${this.clusterDrift.downTicks} down)${this.clusterDrift.isLateJoin ? ' [LATE]' : ''}`);
            }
            
            // Update marker color - cyan for buy, magenta for sell (yellow if late join)
            if (this.clusterDrift.liveMarker && this.clusterDrift.lastSignal) {
                if (this.clusterDrift.isLateJoin) {
                    this.clusterDrift.liveMarker.color = '#fbbf24'; // Yellow for late signal
                } else {
                    this.clusterDrift.liveMarker.color = this.clusterDrift.lastSignal.direction === 'buy' ? '#00d9ff' : '#ff006e';
                }
            }
        }
        
        // If locked, just update display
        if (this.clusterDrift.isLocked) {
            this.updateAllSignalMarkers();
            return;
        }
        
        // Find closest resistance (above price) and support (below price)
        let closestResistance = null;
        let closestSupport = null;
        let minResistanceDistance = Infinity;
        let minSupportDistance = Infinity;
        
        for (const level of levels) {
            const price = parseFloat(level.price) || 0;
            if (price <= 0 || isNaN(price)) continue;
            
            if (level.type === 'resistance' && price > currentPrice) {
                const distance = price - currentPrice;
                if (distance < minResistanceDistance) {
                    minResistanceDistance = distance;
                    closestResistance = price;
                }
            } else if (level.type === 'support' && price < currentPrice) {
                const distance = currentPrice - price;
                if (distance < minSupportDistance) {
                    minSupportDistance = distance;
                    closestSupport = price;
                }
            }
        }
        
        // Track drift - compare to previous positions
        if (this.clusterDrift.lastResistancePrice !== null && closestResistance !== null) {
            if (closestResistance > this.clusterDrift.lastResistancePrice) {
                this.clusterDrift.upTicks++;
            } else if (closestResistance < this.clusterDrift.lastResistancePrice) {
                this.clusterDrift.downTicks++;
            }
        }
        
        if (this.clusterDrift.lastSupportPrice !== null && closestSupport !== null) {
            if (closestSupport > this.clusterDrift.lastSupportPrice) {
                this.clusterDrift.upTicks++;
            } else if (closestSupport < this.clusterDrift.lastSupportPrice) {
                this.clusterDrift.downTicks++;
            }
        }
        
        // Store current positions for next comparison
        this.clusterDrift.lastResistancePrice = closestResistance;
        this.clusterDrift.lastSupportPrice = closestSupport;
        
        // Determine preliminary direction for display
        let prelimDirection = null;
        if (this.clusterDrift.upTicks > this.clusterDrift.downTicks) {
            prelimDirection = 'buy';
        } else if (this.clusterDrift.downTicks > this.clusterDrift.upTicks) {
            prelimDirection = 'sell';
        }
        
        // Create/update live marker (gray while measuring, cyan/magenta when locked)
        if (prelimDirection) {
            this.clusterDrift.liveMarker = {
                time: barTime,
                position: prelimDirection === 'buy' ? 'belowBar' : 'aboveBar',
                color: '#6b7280', // Darker gray while measuring (different from proximity)
                shape: prelimDirection === 'buy' ? 'arrowUp' : 'arrowDown',
                text: 'drift',
                size: 2
            };
            this.clusterDrift.lastSignal = { direction: prelimDirection };
        } else {
            this.clusterDrift.liveMarker = null;
            this.clusterDrift.lastSignal = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Finalize Cluster Drift signal when bar closes
     */
    finalizeClusterDriftSignal() {
        if (this.clusterDrift.liveMarker && this.clusterDrift.lastSignal) {
            // Set final color based on direction - cyan for buy, magenta for sell
            this.clusterDrift.liveMarker.color = this.clusterDrift.lastSignal.direction === 'buy' ? '#00d9ff' : '#ff006e';
            
            // Add to historical markers
            this.clusterDrift.markers.push({ ...this.clusterDrift.liveMarker });
            
            // Keep only last 500 markers
            if (this.clusterDrift.markers.length > 500) {
                this.clusterDrift.markers = this.clusterDrift.markers.slice(-500);
            }
            
            // Save to localStorage
            this.saveClusterDriftHistory();
            
            console.log('[Chart] Cluster Drift signal finalized:', this.clusterDrift.lastSignal);
        }
        
        // Clear live marker
        this.clusterDrift.liveMarker = null;
    }
    
    /**
     * Load Cluster Drift history from IndexedDB
     */
    async loadClusterDriftHistory() {
        try {
            const markers = await db.getSignalMarkers('clusterDrift');
            if (markers && markers.length > 0) {
                this.clusterDrift.markers = markers;
                console.log('[Chart] Loaded', this.clusterDrift.markers.length, 'Cluster Drift markers from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading Cluster Drift history:', e);
            this.clusterDrift.markers = [];
        }
    }
    
    /**
     * Save Cluster Drift history to IndexedDB
     */
    saveClusterDriftHistory() {
        try {
            db.saveSignalMarkers('clusterDrift', this.clusterDrift.markers);
        } catch (e) {
            console.error('[Chart] Error saving Cluster Drift history:', e);
        }
    }
    
    /**
     * Clear all Cluster Drift signals
     */
    clearClusterDriftSignals() {
        this.clusterDrift.markers = [];
        this.clusterDrift.liveMarker = null;
        this.clusterDrift.lastSignal = null;
        this.clusterDrift.lastBarTime = null;
        this.clusterDrift.upTicks = 0;
        this.clusterDrift.downTicks = 0;
        this.clusterDrift.lastResistancePrice = null;
        this.clusterDrift.lastSupportPrice = null;
        this.clusterDrift.isLateJoin = false;
        
        localStorage.removeItem('clusterDriftMarkers');
        
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Live Proximity Signal
    // Dynamic signal, no locking - always shows current state
    // ==========================================
    
    /**
     * Toggle Live Proximity signal
     */
    toggleLiveProximity(show) {
        this.liveProximity.enabled = show;
        localStorage.setItem('showLiveProximity', show);
        console.log('[Chart] toggleLiveProximity:', show);
        
        if (!show) {
            this.liveProximity.liveMarker = null;
            this.liveProximity.lastSignal = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Set Live Proximity threshold
     */
    setLiveProximityThreshold(threshold) {
        this.liveProximity.threshold = threshold;
        localStorage.setItem('liveProximityThreshold', threshold);
        console.log('[Chart] setLiveProximityThreshold:', threshold);
    }
    
    /**
     * Update Live Proximity signal - dynamic, no locking, saves history per bar
     */
    updateLiveProximitySignal(levels, barOpenPrice, barTime) {
        // Always compute signals for the panel, even if chart display is disabled
        if (!levels || levels.length === 0 || !barOpenPrice || !barTime) {
            return;
        }
        
        // Check if bar changed - save previous bar's final marker to history
        if (this.liveProximity.lastBarTime && this.liveProximity.lastBarTime !== barTime) {
            if (this.liveProximity.liveMarker) {
                // Save to history
                this.liveProximity.markers.push({ ...this.liveProximity.liveMarker });
                // Cap history
                if (this.liveProximity.markers.length > 500) {
                    this.liveProximity.markers = this.liveProximity.markers.slice(-500);
                }
                this.saveLiveProximityHistory();
            }
        }
        this.liveProximity.lastBarTime = barTime;
        
        // Find the CLOSEST cluster to bar open price
        let closestCluster = null;
        let closestDistance = Infinity;
        
        for (const level of levels) {
            const price = parseFloat(level.price) || 0;
            const volume = parseFloat(level.volume) || 0;
            
            if (price < 100 || price > 10000000) continue;
            if (volume <= 0) continue;
            
            const distance = Math.abs(barOpenPrice - price);
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestCluster = level;
            }
        }
        
        if (!closestCluster) {
            this.liveProximity.liveMarker = null;
            this.liveProximity.lastSignal = null;
            this.updateAllSignalMarkers();
            return;
        }
        
        const threshold = this.liveProximity.threshold;
        const distancePercent = closestDistance / barOpenPrice;
        
        if (distancePercent <= threshold) {
            const isSellWall = closestCluster.type === 'resistance';
            const direction = isSellWall ? 'sell' : 'buy';
            
            this.liveProximity.lastSignal = { direction: direction };
            
            // More transparent colors for live signals
            this.liveProximity.liveMarker = {
                time: barTime,
                position: direction === 'buy' ? 'belowBar' : 'aboveBar',
                color: direction === 'buy' ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)', // Green/Red with 50% opacity
                shape: direction === 'buy' ? 'arrowUp' : 'arrowDown',
                text: 'l-prox',
                size: 2
            };
        } else {
            this.liveProximity.liveMarker = null;
            this.liveProximity.lastSignal = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Save Live Proximity markers to IndexedDB
     */
    saveLiveProximityHistory() {
        try {
            db.saveSignalMarkers('liveProximity', this.liveProximity.markers);
        } catch (e) {
            console.error('[Chart] Error saving Live Proximity history:', e);
        }
    }
    
    /**
     * Load Live Proximity markers from IndexedDB
     */
    async loadLiveProximityHistory() {
        try {
            const markers = await db.getSignalMarkers('liveProximity');
            if (markers && markers.length > 0) {
                this.liveProximity.markers = markers;
                console.log('[Chart] Loaded', this.liveProximity.markers.length, 'Live Proximity markers from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading Live Proximity history:', e);
            this.liveProximity.markers = [];
        }
    }
    
    /**
     * Clear Live Proximity signals
     */
    clearLiveProximitySignals() {
        this.liveProximity.markers = [];
        this.liveProximity.liveMarker = null;
        this.liveProximity.lastSignal = null;
        this.liveProximity.lastBarTime = null;
        localStorage.removeItem('liveProximityMarkers');
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Live Drift Signal
    // Dynamic signal, no locking - always shows current state
    // ==========================================
    
    /**
     * Toggle Live Drift signal
     */
    toggleLiveDrift(show) {
        this.liveDrift.enabled = show;
        localStorage.setItem('showLiveDrift', show);
        console.log('[Chart] toggleLiveDrift:', show);
        
        if (!show) {
            this.liveDrift.liveMarker = null;
            this.liveDrift.lastSignal = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Update Live Drift signal - dynamic, no locking, saves history per bar
     */
    updateLiveDriftSignal(levels, currentPrice, barTime) {
        // Always compute signals for the panel, even if chart display is disabled
        if (!levels || levels.length === 0 || !currentPrice || !barTime) {
            return;
        }
        
        // Check if bar changed - save previous bar's final marker to history and reset
        if (this.liveDrift.lastBarTime && this.liveDrift.lastBarTime !== barTime) {
            if (this.liveDrift.liveMarker) {
                // Save to history
                this.liveDrift.markers.push({ ...this.liveDrift.liveMarker });
                // Cap history
                if (this.liveDrift.markers.length > 500) {
                    this.liveDrift.markers = this.liveDrift.markers.slice(-500);
                }
                this.saveLiveDriftHistory();
            }
            // Reset for new bar
            this.liveDrift.upTicks = 0;
            this.liveDrift.downTicks = 0;
            this.liveDrift.lastResistancePrice = null;
            this.liveDrift.lastSupportPrice = null;
        }
        this.liveDrift.lastBarTime = barTime;
        
        // Find closest resistance (above price) and support (below price)
        let closestResistance = null;
        let closestSupport = null;
        let minResistanceDistance = Infinity;
        let minSupportDistance = Infinity;
        
        for (const level of levels) {
            const price = parseFloat(level.price) || 0;
            if (price <= 0 || isNaN(price)) continue;
            
            if (level.type === 'resistance' && price > currentPrice) {
                const distance = price - currentPrice;
                if (distance < minResistanceDistance) {
                    minResistanceDistance = distance;
                    closestResistance = price;
                }
            } else if (level.type === 'support' && price < currentPrice) {
                const distance = currentPrice - price;
                if (distance < minSupportDistance) {
                    minSupportDistance = distance;
                    closestSupport = price;
                }
            }
        }
        
        // Track drift
        if (this.liveDrift.lastResistancePrice !== null && closestResistance !== null) {
            if (closestResistance > this.liveDrift.lastResistancePrice) {
                this.liveDrift.upTicks++;
            } else if (closestResistance < this.liveDrift.lastResistancePrice) {
                this.liveDrift.downTicks++;
            }
        }
        
        if (this.liveDrift.lastSupportPrice !== null && closestSupport !== null) {
            if (closestSupport > this.liveDrift.lastSupportPrice) {
                this.liveDrift.upTicks++;
            } else if (closestSupport < this.liveDrift.lastSupportPrice) {
                this.liveDrift.downTicks++;
            }
        }
        
        this.liveDrift.lastResistancePrice = closestResistance;
        this.liveDrift.lastSupportPrice = closestSupport;
        
        // Determine direction based on current ticks
        let direction = null;
        if (this.liveDrift.upTicks > this.liveDrift.downTicks) {
            direction = 'buy';
        } else if (this.liveDrift.downTicks > this.liveDrift.upTicks) {
            direction = 'sell';
        }
        
        if (direction) {
            this.liveDrift.lastSignal = { direction: direction };
            
            // More transparent colors for live signals
            this.liveDrift.liveMarker = {
                time: barTime,
                position: direction === 'buy' ? 'belowBar' : 'aboveBar',
                color: direction === 'buy' ? 'rgba(0, 217, 255, 0.5)' : 'rgba(255, 0, 110, 0.5)', // Cyan/Magenta with 50% opacity
                shape: direction === 'buy' ? 'arrowUp' : 'arrowDown',
                text: 'l-drift',
                size: 2
            };
        } else {
            this.liveDrift.liveMarker = null;
            this.liveDrift.lastSignal = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Save Live Drift markers to IndexedDB
     */
    saveLiveDriftHistory() {
        try {
            db.saveSignalMarkers('liveDrift', this.liveDrift.markers);
        } catch (e) {
            console.error('[Chart] Error saving Live Drift history:', e);
        }
    }
    
    /**
     * Load Live Drift markers from IndexedDB
     */
    async loadLiveDriftHistory() {
        try {
            const markers = await db.getSignalMarkers('liveDrift');
            if (markers && markers.length > 0) {
                this.liveDrift.markers = markers;
                console.log('[Chart] Loaded', this.liveDrift.markers.length, 'Live Drift markers from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading Live Drift history:', e);
            this.liveDrift.markers = [];
        }
    }
    
    /**
     * Clear Live Drift signals
     */
    clearLiveDriftSignals() {
        this.liveDrift.markers = [];
        this.liveDrift.liveMarker = null;
        this.liveDrift.lastSignal = null;
        this.liveDrift.lastBarTime = null;
        this.liveDrift.upTicks = 0;
        this.liveDrift.downTicks = 0;
        this.liveDrift.lastResistancePrice = null;
        this.liveDrift.lastSupportPrice = null;
        localStorage.removeItem('liveDriftMarkers');
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // LV (Liquidity Vacuum) Signal
    // Dynamic signal showing where liquidity is thin
    // ==========================================
    
    /**
     * Toggle LV Signal display on chart
     * Note: LV always tracks in background - this only controls chart display
     */
    toggleLVSignal(show) {
        this.lvSignal.enabled = show;
        localStorage.setItem('showLVSignal', show);
        console.log('[Chart] toggleLVSignal:', show);
        
        // Don't clear liveMarker/lastSignal - we want to keep tracking in background
        // The enabled flag only controls whether markers appear on chart
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Toggle LV Signal History circles on chart
     * Shows both buy AND sell occurrences per bar (circles with ratios)
     */
    toggleLVSignalHistory(show) {
        this.lvSignal.historyEnabled = show;
        localStorage.setItem('showLVSignalHistory', show);
        console.log('[Chart] toggleLVSignalHistory:', show);
        this.updateAllSignalMarkers();
    }
    
    /**
     * Update LV Signal - creates marker based on liquidity vacuum analysis
     * Called from updateLVPanel in app.js
     * Uses confirmation time setting - signal must be stable before showing on chart
     */
    updateLVSignal(lvData, barTime) {
        if (!lvData || !barTime) return;
        
        // Check if bar changed - save previous bar's final marker to history
        if (this.lvSignal.lastBarTime && this.lvSignal.lastBarTime !== barTime) {
            if (this.lvSignal.liveMarker) {
                // Save to history with peak ratio
                const historyMarker = { ...this.lvSignal.liveMarker };
                // Use peak ratio for historical marker
                if (this.lvSignal.peakRatio) {
                    historyMarker.text = `LV\n${this.lvSignal.peakRatio.toFixed(2)}`;
                }
                this.lvSignal.markers.push(historyMarker);
                // Cap history
                if (this.lvSignal.markers.length > 500) {
                    this.lvSignal.markers = this.lvSignal.markers.slice(-500);
                }
                this.saveLVSignalHistory();
            }
            
            // Save history circle markers for previous bar (track both buy AND sell occurrences)
            const prevBarTime = this.lvSignal.lastBarTime;
            if (this.lvSignal.buyTriggeredThisBar && this.lvSignal.buyPeakRatio !== null) {
                this.lvSignal.historyMarkers.push({
                    time: prevBarTime,
                    position: 'belowBar', // BUY = below bar (matches arrows)
                    color: '#14b8a6', // Teal
                    shape: 'circle',
                    text: `LV ${this.lvSignal.buyPeakRatio.toFixed(2)}`,
                    size: 1
                });
            }
            if (this.lvSignal.sellTriggeredThisBar && this.lvSignal.sellMinRatio !== null) {
                this.lvSignal.historyMarkers.push({
                    time: prevBarTime,
                    position: 'aboveBar', // SELL = above bar (matches arrows)
                    color: '#ef4444', // Red
                    shape: 'circle',
                    text: `LV ${this.lvSignal.sellMinRatio.toFixed(2)}`,
                    size: 1
                });
            }
            // Cap history markers
            if (this.lvSignal.historyMarkers.length > 1000) {
                this.lvSignal.historyMarkers = this.lvSignal.historyMarkers.slice(-1000);
            }
            // Save history circles to IndexedDB
            this.saveLVSignalHistoryCircles();
            
            // Reset tracking for new bar
            this.lvSignal.peakRatio = null;
            this.lvSignal.buyTriggeredThisBar = false;
            this.lvSignal.sellTriggeredThisBar = false;
            this.lvSignal.buyPeakRatio = null;
            this.lvSignal.sellMinRatio = null;
        }
        this.lvSignal.lastBarTime = barTime;
        
        // Store signal regardless of enabled state (for panel)
        this.lvSignal.lastSignal = lvData;
        
        // Use the signal directly from lvData (already confirmed by app.js)
        // This ensures the chart matches the panel display exactly
        const displaySignal = lvData.signal;
        
        // Legacy: Keep tracking for backwards compatibility but don't use for display
        const confirmTime = parseInt(localStorage.getItem('lvConfirmTime')) || 0;
        const now = Date.now();
        
        if (confirmTime > 0 && lvData.signal !== this.lvSignal.pendingSignal) {
            this.lvSignal.pendingSignal = lvData.signal;
            this.lvSignal.pendingStartTime = now;
        }
        
        // Check if confirmed (for tracking purposes only - display already uses confirmed signal from app.js)
        if (confirmTime > 0 && this.lvSignal.pendingStartTime) {
            const elapsed = (now - this.lvSignal.pendingStartTime) / 1000;
            if (elapsed >= confirmTime) {
                this.lvSignal.confirmedSignal = lvData.signal;
            }
        }
        
        // Calculate ratio for display (larger / smaller)
        const above = lvData.aboveLiq || 0;
        const below = lvData.belowLiq || 0;
        const larger = Math.max(above, below);
        const smaller = Math.min(above, below) || 0.001;
        const currentRatio = larger / smaller;
        
        // Track peak ratio for this bar
        if (!this.lvSignal.peakRatio || currentRatio > this.lvSignal.peakRatio) {
            this.lvSignal.peakRatio = currentRatio;
        }
        
        // Track signal history - capture when buy/sell triggers (use raw signal, not confirmed)
        // This tracks every moment a signal triggers, not just the final confirmed state
        if (lvData.signal === 'buy') {
            this.lvSignal.buyTriggeredThisBar = true;
            // Track peak ratio while buy is active
            if (this.lvSignal.buyPeakRatio === null || currentRatio > this.lvSignal.buyPeakRatio) {
                this.lvSignal.buyPeakRatio = currentRatio;
            }
        } else if (lvData.signal === 'sell') {
            this.lvSignal.sellTriggeredThisBar = true;
            // Track min ratio while sell is active (actually track peak - strongest signal)
            if (this.lvSignal.sellMinRatio === null || currentRatio > this.lvSignal.sellMinRatio) {
                this.lvSignal.sellMinRatio = currentRatio;
            }
        }
        
        // Create live history circle markers for current bar (real-time display)
        this.lvSignal.liveHistoryMarkers = [];
        if (this.lvSignal.buyTriggeredThisBar && this.lvSignal.buyPeakRatio !== null) {
            this.lvSignal.liveHistoryMarkers.push({
                time: barTime,
                position: 'belowBar', // BUY = below bar (matches arrows)
                color: '#14b8a6', // Teal
                shape: 'circle',
                text: `LV ${this.lvSignal.buyPeakRatio.toFixed(2)}`,
                size: 1
            });
        }
        if (this.lvSignal.sellTriggeredThisBar && this.lvSignal.sellMinRatio !== null) {
            this.lvSignal.liveHistoryMarkers.push({
                time: barTime,
                position: 'aboveBar', // SELL = above bar (matches arrows)
                color: '#ef4444', // Red
                shape: 'circle',
                text: `LV ${this.lvSignal.sellMinRatio.toFixed(2)}`,
                size: 1
            });
        }
        
        // Only create marker if confirmed signal has direction
        if (displaySignal === 'buy' || displaySignal === 'sell') {
            const direction = displaySignal;
            // Display peak ratio (more useful historically)
            const displayRatio = this.lvSignal.peakRatio.toFixed(2);
            
            this.lvSignal.liveMarker = {
                time: barTime,
                position: direction === 'buy' ? 'belowBar' : 'aboveBar',
                color: direction === 'buy' ? 'rgba(34, 197, 94, 0.6)' : 'rgba(239, 68, 68, 0.6)',
                shape: direction === 'buy' ? 'arrowUp' : 'arrowDown',
                text: `LV\n${displayRatio}`,
                size: 2
            };
        } else {
            this.lvSignal.liveMarker = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Save LV Signal markers to IndexedDB
     */
    saveLVSignalHistory() {
        try {
            db.saveSignalMarkers('lvSignal', this.lvSignal.markers);
        } catch (e) {
            console.error('[Chart] Error saving LV Signal history:', e);
        }
    }
    
    /**
     * Load LV Signal markers from IndexedDB
     */
    async loadLVSignalHistory() {
        try {
            const markers = await db.getSignalMarkers('lvSignal');
            if (markers && markers.length > 0) {
                this.lvSignal.markers = markers;
                console.log('[Chart] Loaded', this.lvSignal.markers.length, 'LV Signal markers from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading LV Signal history:', e);
            this.lvSignal.markers = [];
        }
    }
    
    /**
     * Save LV Signal History Circles to IndexedDB
     */
    saveLVSignalHistoryCircles() {
        try {
            db.saveSignalMarkers('lvSignalHistoryCircles', this.lvSignal.historyMarkers);
        } catch (e) {
            console.error('[Chart] Error saving LV Signal history circles:', e);
        }
    }
    
    /**
     * Load LV Signal History Circles from IndexedDB
     */
    async loadLVSignalHistoryCircles() {
        try {
            const markers = await db.getSignalMarkers('lvSignalHistoryCircles');
            if (markers && markers.length > 0) {
                this.lvSignal.historyMarkers = markers;
                console.log('[Chart] Loaded', this.lvSignal.historyMarkers.length, 'LV Signal history circles from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading LV Signal history circles:', e);
            this.lvSignal.historyMarkers = [];
        }
    }
    
    /**
     * Clear LV Signal markers
     */
    clearLVSignals() {
        this.lvSignal.markers = [];
        this.lvSignal.historyMarkers = [];
        this.lvSignal.liveHistoryMarkers = [];
        this.lvSignal.liveMarker = null;
        this.lvSignal.lastSignal = null;
        this.lvSignal.lastBarTime = null;
        this.lvSignal.buyTriggeredThisBar = false;
        this.lvSignal.sellTriggeredThisBar = false;
        this.lvSignal.buyPeakRatio = null;
        this.lvSignal.sellMinRatio = null;
        localStorage.removeItem('lvSignalMarkers');
        db.saveSignalMarkers('lvSignalHistoryCircles', []);
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Alpha Lead Signal (chart arrows)
    // Leading indicator combining LV + momentum
    // ==========================================
    
    /**
     * Toggle Alpha Lead Signal display on chart
     * Note: Alpha Lead always tracks in background - this only controls chart display
     */
    toggleAlphaLeadSignal(show) {
        this.alphaLeadSignal.enabled = show;
        localStorage.setItem('showAlphaLeadSignal', show);
        console.log('[Chart] toggleAlphaLeadSignal:', show);
        
        // Don't clear liveMarker/lastSignal - we want to keep tracking in background
        // The enabled flag only controls whether markers appear on chart
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Toggle Alpha Lead Signal History circles on chart
     * Shows both buy AND sell occurrences per bar (circles with scores)
     */
    toggleALSignalHistory(show) {
        this.alphaLeadSignal.historyEnabled = show;
        localStorage.setItem('showALSignalHistory', show);
        console.log('[Chart] toggleALSignalHistory:', show);
        this.updateAllSignalMarkers();
    }
    
    /**
     * Update Alpha Lead Signal - creates marker based on alpha lead analysis
     * Called from app.js after calculating alpha lead
     */
    updateAlphaLeadSignal(alphaLeadData, barTime) {
        if (!alphaLeadData || !barTime) return;
        
        // Check if bar changed - save previous bar's final marker to history
        if (this.alphaLeadSignal.lastBarTime && this.alphaLeadSignal.lastBarTime !== barTime) {
            if (this.alphaLeadSignal.liveMarker) {
                // Update marker text with peak/min score before saving
                const peakScore = this.alphaLeadSignal.peakScore;
                const minScore = this.alphaLeadSignal.minScore;
                if (this.alphaLeadSignal.liveMarker.shape === 'arrowUp' && peakScore !== null) {
                    this.alphaLeadSignal.liveMarker.text = `αL ${peakScore}`;
                } else if (this.alphaLeadSignal.liveMarker.shape === 'arrowDown' && minScore !== null) {
                    this.alphaLeadSignal.liveMarker.text = `αL ${minScore}`;
                }
                
                // Save to history
                this.alphaLeadSignal.markers.push({ ...this.alphaLeadSignal.liveMarker });
                // Cap history
                if (this.alphaLeadSignal.markers.length > 500) {
                    this.alphaLeadSignal.markers = this.alphaLeadSignal.markers.slice(-500);
                }
                // Save to IndexedDB
                this.saveAlphaLeadSignalHistory();
            }
            
            // Save history circle markers for previous bar (track both buy AND sell occurrences)
            const prevBarTime = this.alphaLeadSignal.lastBarTime;
            if (this.alphaLeadSignal.buyTriggeredThisBar && this.alphaLeadSignal.buyPeakScore !== null) {
                this.alphaLeadSignal.historyMarkers.push({
                    time: prevBarTime,
                    position: 'belowBar', // BUY = below bar (matches arrows)
                    color: '#3b82f6', // Blue (match AL buy color)
                    shape: 'circle',
                    text: `αL ${this.alphaLeadSignal.buyPeakScore}`,
                    size: 1
                });
            }
            if (this.alphaLeadSignal.sellTriggeredThisBar && this.alphaLeadSignal.sellMinScore !== null) {
                this.alphaLeadSignal.historyMarkers.push({
                    time: prevBarTime,
                    position: 'aboveBar', // SELL = above bar (matches arrows)
                    color: '#ec4899', // Pink (match AL sell color)
                    shape: 'circle',
                    text: `αL ${this.alphaLeadSignal.sellMinScore}`,
                    size: 1
                });
            }
            // Cap history markers
            if (this.alphaLeadSignal.historyMarkers.length > 1000) {
                this.alphaLeadSignal.historyMarkers = this.alphaLeadSignal.historyMarkers.slice(-1000);
            }
            // Save history circles to IndexedDB
            this.saveALSignalHistoryCircles();
            
            // Reset tracking for new bar
            this.alphaLeadSignal.peakScore = null;
            this.alphaLeadSignal.minScore = null;
            this.alphaLeadSignal.buyTriggeredThisBar = false;
            this.alphaLeadSignal.sellTriggeredThisBar = false;
            this.alphaLeadSignal.buyPeakScore = null;
            this.alphaLeadSignal.sellMinScore = null;
        }
        this.alphaLeadSignal.lastBarTime = barTime;
        
        // Track peak (for buy) and min (for sell) scores
        const score = alphaLeadData.score;
        if (this.alphaLeadSignal.peakScore === null || score > this.alphaLeadSignal.peakScore) {
            this.alphaLeadSignal.peakScore = score;
        }
        if (this.alphaLeadSignal.minScore === null || score < this.alphaLeadSignal.minScore) {
            this.alphaLeadSignal.minScore = score;
        }
        
        // Track signal history - capture when buy/sell triggers
        if (alphaLeadData.signal === 'buy') {
            this.alphaLeadSignal.buyTriggeredThisBar = true;
            // Track peak score while buy is active
            if (this.alphaLeadSignal.buyPeakScore === null || score > this.alphaLeadSignal.buyPeakScore) {
                this.alphaLeadSignal.buyPeakScore = score;
            }
        } else if (alphaLeadData.signal === 'sell') {
            this.alphaLeadSignal.sellTriggeredThisBar = true;
            // Track min score while sell is active
            if (this.alphaLeadSignal.sellMinScore === null || score < this.alphaLeadSignal.sellMinScore) {
                this.alphaLeadSignal.sellMinScore = score;
            }
        }
        
        // Create live history circle markers for current bar (real-time display)
        this.alphaLeadSignal.liveHistoryMarkers = [];
        if (this.alphaLeadSignal.buyTriggeredThisBar && this.alphaLeadSignal.buyPeakScore !== null) {
            this.alphaLeadSignal.liveHistoryMarkers.push({
                time: barTime,
                position: 'belowBar', // BUY = below bar (matches arrows)
                color: '#3b82f6', // Blue (match AL buy color)
                shape: 'circle',
                text: `αL ${this.alphaLeadSignal.buyPeakScore}`,
                size: 1
            });
        }
        if (this.alphaLeadSignal.sellTriggeredThisBar && this.alphaLeadSignal.sellMinScore !== null) {
            this.alphaLeadSignal.liveHistoryMarkers.push({
                time: barTime,
                position: 'aboveBar', // SELL = above bar (matches arrows)
                color: '#ec4899', // Pink (match AL sell color)
                shape: 'circle',
                text: `αL ${this.alphaLeadSignal.sellMinScore}`,
                size: 1
            });
        }
        
        // Store signal regardless of enabled state (for panel)
        this.alphaLeadSignal.lastSignal = alphaLeadData;
        
        // Only create marker if signal has direction
        if (alphaLeadData.signal === 'buy' || alphaLeadData.signal === 'sell') {
            const direction = alphaLeadData.signal;
            // Show peak score for buy (highest), min score for sell (lowest)
            const displayScore = direction === 'buy' ? this.alphaLeadSignal.peakScore : this.alphaLeadSignal.minScore;
            this.alphaLeadSignal.liveMarker = {
                time: barTime,
                position: direction === 'buy' ? 'belowBar' : 'aboveBar',
                color: direction === 'buy' ? 'rgba(59, 130, 246, 0.7)' : 'rgba(236, 72, 153, 0.7)', // Blue for buy, pink for sell
                shape: direction === 'buy' ? 'arrowUp' : 'arrowDown',
                text: `αL ${displayScore}`,
                size: 2
            };
        } else {
            this.alphaLeadSignal.liveMarker = null;
        }
        
        this.updateAllSignalMarkers();
    }
    
    /**
     * Save Alpha Lead Signal markers to IndexedDB
     */
    saveAlphaLeadSignalHistory() {
        try {
            db.saveSignalMarkers('alphaLeadSignal', this.alphaLeadSignal.markers);
        } catch (e) {
            console.error('[Chart] Error saving Alpha Lead Signal history:', e);
        }
    }
    
    /**
     * Load Alpha Lead Signal markers from IndexedDB
     */
    async loadAlphaLeadSignalHistory() {
        try {
            const markers = await db.getSignalMarkers('alphaLeadSignal');
            if (markers && markers.length > 0) {
                this.alphaLeadSignal.markers = markers;
                console.log('[Chart] Loaded', this.alphaLeadSignal.markers.length, 'Alpha Lead Signal markers from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading Alpha Lead Signal history:', e);
            this.alphaLeadSignal.markers = [];
        }
    }
    
    /**
     * Save Alpha Lead Signal History Circles to IndexedDB
     */
    saveALSignalHistoryCircles() {
        try {
            db.saveSignalMarkers('alphaLeadSignalHistoryCircles', this.alphaLeadSignal.historyMarkers);
        } catch (e) {
            console.error('[Chart] Error saving Alpha Lead Signal history circles:', e);
        }
    }
    
    /**
     * Load Alpha Lead Signal History Circles from IndexedDB
     */
    async loadALSignalHistoryCircles() {
        try {
            const markers = await db.getSignalMarkers('alphaLeadSignalHistoryCircles');
            if (markers && markers.length > 0) {
                this.alphaLeadSignal.historyMarkers = markers;
                console.log('[Chart] Loaded', this.alphaLeadSignal.historyMarkers.length, 'Alpha Lead Signal history circles from IndexedDB');
            }
        } catch (e) {
            console.error('[Chart] Error loading Alpha Lead Signal history circles:', e);
            this.alphaLeadSignal.historyMarkers = [];
        }
    }
    
    /**
     * Clear Alpha Lead Signal markers
     */
    clearAlphaLeadSignals() {
        this.alphaLeadSignal.markers = [];
        this.alphaLeadSignal.historyMarkers = [];
        this.alphaLeadSignal.liveHistoryMarkers = [];
        this.alphaLeadSignal.liveMarker = null;
        this.alphaLeadSignal.lastSignal = null;
        this.alphaLeadSignal.lastBarTime = null;
        this.alphaLeadSignal.peakScore = null;
        this.alphaLeadSignal.minScore = null;
        this.alphaLeadSignal.buyTriggeredThisBar = false;
        this.alphaLeadSignal.sellTriggeredThisBar = false;
        this.alphaLeadSignal.buyPeakScore = null;
        this.alphaLeadSignal.sellMinScore = null;
        localStorage.removeItem('alphaLeadSignalMarkers');
        db.saveSignalMarkers('alphaLeadSignalHistoryCircles', []);
        this.updateAllSignalMarkers();
    }
    
    // ==========================================
    // Cluster Strike Panel
    // Separate visualization of current bar walls
    // ==========================================
    
    /**
     * Initialize Cluster Strike panel canvas
     */
    initClusterStrike() {
        const canvas = document.getElementById('clusterStrikeCanvas');
        if (!canvas) {
            console.warn('[ClusterStrike] Canvas not found');
            return;
        }
        
        this.clusterStrike.canvas = canvas;
        this.clusterStrike.ctx = canvas.getContext('2d');
        
        // Set canvas size based on container
        this.updateClusterStrikeCanvasSize();
        
        // Handle resize
        const resizeObserver = new ResizeObserver(() => {
            this.updateClusterStrikeCanvasSize();
            this.renderClusterStrike();
        });
        resizeObserver.observe(canvas.parentElement);
        
        this.clusterStrike.initialized = true;
        console.log('[ClusterStrike] Initialized');
    }
    
    /**
     * Update Cluster Strike canvas size for high DPI displays
     */
    updateClusterStrikeCanvasSize() {
        const canvas = this.clusterStrike.canvas;
        if (!canvas) return;
        
        const container = canvas.parentElement;
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        const ctx = this.clusterStrike.ctx;
        if (ctx) {
            ctx.scale(dpr, dpr);
        }
    }
    
    /**
     * Render Cluster Strike panel - shows current bar wall heatmap
     * Matches the channel mode heatmap visual style (blue bids, pink asks)
     * Called from accumulateLevelBucket when data updates
     */
    renderClusterStrike() {
        if (!this.clusterStrike.initialized || !this.clusterStrike.ctx) return;
        
        // Throttle renders
        const now = Date.now();
        if (now - this.clusterStrike.lastRenderTime < this.clusterStrike.renderThrottleMs) {
            return;
        }
        this.clusterStrike.lastRenderTime = now;
        
        const canvas = this.clusterStrike.canvas;
        const ctx = this.clusterStrike.ctx;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.width / dpr;
        const height = canvas.height / dpr;
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Get current price
        const currentPrice = this.currentPrice;
        if (!currentPrice) return;
        
        // Update price label
        const priceLabel = document.getElementById('clusterStrikePriceLabel');
        if (priceLabel) {
            priceLabel.textContent = '$' + Math.round(currentPrice).toLocaleString();
        }
        
        // Get current bar accumulator data
        const accumulator = this.levelHistory.currentBarAccumulator;
        if (!accumulator || accumulator.size === 0) return;
        
        // Define price range (±20% of current price)
        const priceRange = this.clusterStrike.priceRange;
        const minPrice = currentPrice * (1 - priceRange);
        const maxPrice = currentPrice * (1 + priceRange);
        const priceSpan = maxPrice - minPrice;
        
        // Filter buckets within price range and find max hits for normalization
        const visibleBuckets = [];
        let maxHits = 0;
        
        accumulator.forEach((data, bucketPrice) => {
            if (bucketPrice >= minPrice && bucketPrice <= maxPrice) {
                const totalHits = (data.bidHits || 0) + (data.askHits || 0);
                visibleBuckets.push({ price: bucketPrice, ...data, totalHits });
                maxHits = Math.max(maxHits, totalHits);
            }
        });
        
        if (visibleBuckets.length === 0 || maxHits === 0) return;
        
        const bucketSize = this.levelHistory.bucketSize || 50;
        
        // Calculate bucket height in pixels
        const bucketHeightPx = Math.max(2, (height / priceSpan) * bucketSize);
        
        // Draw dark background
        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
        ctx.fillRect(0, 0, width, height);
        
        // Draw each bucket as a full-width bar (like the channel mode heatmap)
        for (const bucket of visibleBuckets) {
            const { price, bidHits, askHits, totalHits } = bucket;
            
            // Calculate Y position (inverted - higher prices at top)
            const priceRatio = (price - minPrice) / priceSpan;
            const y = height - (priceRatio * height) - (bucketHeightPx / 2);
            
            // Skip if outside visible area
            if (y < -bucketHeightPx || y > height + bucketHeightPx) continue;
            
            // Calculate intensity based on total hits
            const intensity = Math.min(1, totalHits / maxHits);
            const alpha = 0.15 + intensity * 0.7;
            
            // Color by dominant side: more bids = cyan, more asks = magenta
            // Matching channel mode heatmap colors exactly
            const isBidDominant = bidHits >= askHits;
            ctx.fillStyle = isBidDominant
                ? `rgba(0, 217, 255, ${alpha})`   // cyan for bid-dominant (support)
                : `rgba(255, 0, 110, ${alpha})`; // magenta for ask-dominant (resistance)
            
            // Draw full-width bucket rectangle
            ctx.fillRect(0, y, width, Math.max(2, bucketHeightPx));
        }
        
        // Draw current price line (horizontal, gold/yellow)
        const priceY = height - ((currentPrice - minPrice) / priceSpan * height);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, priceY);
        ctx.lineTo(width, priceY);
        ctx.stroke();
        
        // Draw price axis labels
        ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        
        // Top price (maxPrice)
        ctx.fillText('$' + Math.round(maxPrice).toLocaleString(), width - 4, 12);
        
        // Bottom price (minPrice) 
        ctx.fillText('$' + Math.round(minPrice).toLocaleString(), width - 4, height - 4);
    }
    
    /**
     * Schedule Cluster Strike render (called from accumulateLevelBucket)
     */
    scheduleClusterStrikeRender() {
        if (!this.clusterStrike.initialized) return;
        
        // Use requestAnimationFrame for smooth updates
        if (!this.clusterStrike._renderScheduled) {
            this.clusterStrike._renderScheduled = true;
            requestAnimationFrame(() => {
                this.clusterStrike._renderScheduled = false;
                this.renderClusterStrike();
            });
        }
    }
    
    // ==========================================
    // Trade Footprint Heatmap
    // ==========================================
    
    /**
     * Toggle Trade Footprint heatmap overlay
     */
    toggleTradeFootprint(show) {
        this.tradeFootprint.enabled = show;
        console.log('[Chart] toggleTradeFootprint:', show);
        
        if (show) {
            this.initTradeFootprintCanvas();
            // Sync with trade aggregator
            if (typeof tradeAggregator !== 'undefined') {
                tradeAggregator.setSymbol(this.symbol);
                tradeAggregator.setInterval(this.currentInterval);
                tradeAggregator.loadFromStorage();
            }
            this.renderTradeFootprint();
        } else {
            this.clearTradeFootprintCanvas();
        }
        
        localStorage.setItem('showTradeFootprint', show);
        
        // Sync with WebSocket
        if (typeof orderBookWS !== 'undefined') {
            orderBookWS.setTradesEnabled(show);
        }
    }
    
    /**
     * Set trade footprint bucket size
     */
    setTradeFootprintBucketSize(size) {
        this.tradeFootprint.bucketSize = parseInt(size) || 10;
        localStorage.setItem('tradeFootprintBucketSize', this.tradeFootprint.bucketSize);
        
        if (typeof tradeAggregator !== 'undefined') {
            tradeAggregator.setBucketSize(this.tradeFootprint.bucketSize);
        }
        
        // Re-render with new bucket size
        if (this.tradeFootprint.enabled) {
            this.renderTradeFootprint();
        }
    }
    
    /**
     * Initialize trade footprint canvas overlay
     */
    initTradeFootprintCanvas() {
        if (this.tradeFootprint.canvas) return;
        
        // Create canvas element
        const canvas = document.createElement('canvas');
        canvas.id = 'tradeFootprintCanvas';
        canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 11;
        `;
        
        // Insert canvas into chart container
        if (this.container) {
            this.container.style.position = 'relative';
            this.container.appendChild(canvas);
            
            // Size canvas to match container and cache dimensions
            this.updateFootprintCanvasSize();
            
            this.tradeFootprint.canvas = canvas;
            this.tradeFootprint.ctx = canvas.getContext('2d');
            this.tradeFootprint.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            
            // Initialize render state for rAF throttling
            this.tradeFootprint._needsRender = false;
            this.tradeFootprint._rafId = null;
            
            // Subscribe to chart changes with rAF throttling
            if (this.chart) {
                // Time scale changes (horizontal drag/zoom)
                this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
                    if (this.tradeFootprint.enabled) {
                        this.scheduleFootprintRender();
                    }
                });
            }
            
            // Handle price scale drags by rendering continuously during mouse drag
            this._setupFootprintDragTracking();
            
            // Update cached dimensions on resize
            this._footprintResizeObserver = new ResizeObserver(() => {
                this.updateFootprintCanvasSize();
                if (this.tradeFootprint.enabled) {
                    this.scheduleFootprintRender();
                }
            });
            this._footprintResizeObserver.observe(this.container);
        }
    }
    
    /**
     * Update footprint canvas size and cache dimensions
     */
    updateFootprintCanvasSize() {
        if (!this.container) return;
        
        const rect = this.container.getBoundingClientRect();
        this.tradeFootprint._cachedWidth = rect.width;
        this.tradeFootprint._cachedHeight = rect.height;
        
        if (this.tradeFootprint.canvas) {
            this.tradeFootprint.canvas.width = rect.width * window.devicePixelRatio;
            this.tradeFootprint.canvas.height = rect.height * window.devicePixelRatio;
            
            // Re-scale context after resize
            if (this.tradeFootprint.ctx) {
                this.tradeFootprint.ctx.setTransform(1, 0, 0, 1, 0, 0);
                this.tradeFootprint.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            }
        }
    }
    
    /**
     * Schedule footprint render on next animation frame (coalesces multiple calls)
     */
    scheduleFootprintRender() {
        if (this.tradeFootprint._needsRender) return; // Already scheduled
        
        this.tradeFootprint._needsRender = true;
        this.tradeFootprint._rafId = requestAnimationFrame(() => {
            this.tradeFootprint._needsRender = false;
            this.renderTradeFootprint();
        });
    }
    
    /**
     * Setup drag tracking for footprint canvas
     * Renders continuously during mouse drag to handle price scale changes
     */
    _setupFootprintDragTracking() {
        if (!this.container || this.tradeFootprint._dragTrackingSetup) return;
        this.tradeFootprint._dragTrackingSetup = true;
        
        let isDragging = false;
        let renderLoop = null;
        
        const startDragRender = () => {
            if (renderLoop) return;
            renderLoop = () => {
                if (isDragging && this.tradeFootprint.enabled) {
                    this.renderTradeFootprint();
                    requestAnimationFrame(renderLoop);
                } else {
                    renderLoop = null;
                }
            };
            requestAnimationFrame(renderLoop);
        };
        
        this.container.addEventListener('mousedown', () => {
            isDragging = true;
            startDragRender();
        });
        
        window.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Also handle touch for mobile
        this.container.addEventListener('touchstart', () => {
            isDragging = true;
            startDragRender();
        }, { passive: true });
        
        window.addEventListener('touchend', () => {
            isDragging = false;
        });
    }
    
    /**
     * Clear trade footprint canvas
     */
    clearTradeFootprintCanvas() {
        if (this.tradeFootprint.canvas && this.tradeFootprint.ctx) {
            const width = this.tradeFootprint._cachedWidth || this.container.getBoundingClientRect().width;
            const height = this.tradeFootprint._cachedHeight || this.container.getBoundingClientRect().height;
            this.tradeFootprint.ctx.clearRect(0, 0, width, height);
        }
    }
    
    /**
     * Remove trade footprint canvas from DOM
     */
    removeTradeFootprintCanvas() {
        // Cancel any pending render
        if (this.tradeFootprint._rafId) {
            cancelAnimationFrame(this.tradeFootprint._rafId);
            this.tradeFootprint._rafId = null;
        }
        this.tradeFootprint._needsRender = false;
        
        // Disconnect resize observer
        if (this._footprintResizeObserver) {
            this._footprintResizeObserver.disconnect();
            this._footprintResizeObserver = null;
        }
        
        if (this.tradeFootprint.canvas) {
            this.tradeFootprint.canvas.remove();
            this.tradeFootprint.canvas = null;
            this.tradeFootprint.ctx = null;
        }
    }
    
    /**
     * Render trade footprint heatmap
     * Optimized: filters to visible bars, uses cached dimensions, rAF throttled
     */
    renderTradeFootprint() {
        if (!this.tradeFootprint.enabled || !this.chart || !this.tradeFootprint.ctx) {
            return;
        }
        
        // Get trade data from aggregator
        if (typeof tradeAggregator === 'undefined') return;
        
        const allData = tradeAggregator.getAllFootprintData();
        if (allData.size === 0) return;
        
        const ctx = this.tradeFootprint.ctx;
        const width = this.tradeFootprint._cachedWidth || this.container.getBoundingClientRect().width;
        const height = this.tradeFootprint._cachedHeight || this.container.getBoundingClientRect().height;
        const timeScale = this.chart.timeScale();
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Get visible time range for filtering
        const visibleTimeRange = timeScale.getVisibleRange();
        if (!visibleTimeRange) return;
        
        // Calculate bar width in pixels
        const candles = this.getCandles();
        if (!candles || candles.length < 2) return;
        
        // Get interval in seconds for bar width calculation (cached for performance)
        const intervalMap = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        const intervalSec = intervalMap[this.currentInterval] || 60;
        
        // Add buffer to visible range to include partially visible bars
        const bufferTime = intervalSec * 2;
        const visibleFrom = visibleTimeRange.from - bufferTime;
        const visibleTo = visibleTimeRange.to + bufferTime;
        
        // Filter to visible bars only and find max values in single pass
        const visibleBars = [];
        let maxDelta = 0;
        let maxVolume = 0;
        
        allData.forEach((footprint, barTime) => {
            // Skip bars outside visible range
            if (barTime < visibleFrom || barTime > visibleTo) return;
            
            visibleBars.push({ barTime, footprint });
            
            // Find max values for normalization
            footprint.forEach(level => {
                maxDelta = Math.max(maxDelta, Math.abs(level.delta));
                maxVolume = Math.max(maxVolume, level.totalVol);
            });
        });
        
        if (maxDelta === 0 || visibleBars.length === 0) return;
        
        // Pre-calculate bar width once (same for all bars at this zoom level)
        const sampleX = timeScale.timeToCoordinate(visibleBars[0].barTime);
        const sampleNextX = timeScale.timeToCoordinate(visibleBars[0].barTime + intervalSec);
        const barWidth = (sampleX !== null && sampleNextX !== null) 
            ? Math.max(2, (sampleNextX - sampleX) * 0.8) 
            : 8;
        
        const bucketSize = this.tradeFootprint.bucketSize;
        
        // Draw footprint for each visible bar
        for (const { barTime, footprint } of visibleBars) {
            // Convert bar time to x coordinate
            const x = timeScale.timeToCoordinate(barTime);
            if (x === null || x < -barWidth || x > width + barWidth) continue;
            
            // Draw each price level
            for (const level of footprint) {
                // Convert price to y coordinate
                const y = this.candleSeries.priceToCoordinate(level.price);
                if (y === null || y < -10 || y > height + 10) continue;
                
                // Calculate color based on delta
                const delta = level.delta;
                const intensity = Math.min(1, Math.abs(delta) / maxDelta);
                const volumeScale = Math.min(1, level.totalVol / maxVolume);
                
                // Determine color (green for buying, red for selling)
                const brightness = this.tradeFootprint.brightness || 1;
                let color;
                if (delta > 0) {
                    // Buying pressure - green
                    const alpha = Math.min(1, (0.3 + intensity * 0.6) * brightness);
                    color = `rgba(16, 185, 129, ${alpha})`;
                } else if (delta < 0) {
                    // Selling pressure - red
                    const alpha = Math.min(1, (0.3 + intensity * 0.6) * brightness);
                    color = `rgba(239, 68, 68, ${alpha})`;
                } else {
                    // Neutral - dim
                    const alpha = Math.min(1, 0.2 * brightness);
                    color = `rgba(148, 163, 184, ${alpha})`;
                }
                
                // Calculate rectangle height (based on bucket size relative to price scale)
                const yTop = this.candleSeries.priceToCoordinate(level.price + bucketSize);
                const rectHeight = yTop !== null ? Math.max(2, Math.abs(y - yTop)) : 4;
                
                // Draw rectangle
                ctx.fillStyle = color;
                ctx.fillRect(
                    x - barWidth / 2,
                    y - rectHeight / 2,
                    barWidth,
                    rectHeight
                );
                
                // For high-volume levels, add a border
                if (volumeScale > 0.5) {
                    ctx.strokeStyle = delta > 0 ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(
                        x - barWidth / 2,
                        y - rectHeight / 2,
                        barWidth,
                        rectHeight
                    );
                }
            }
        }
    }
    
    /**
     * Update trade footprint on new trade data
     */
    onTradeFootprintUpdate(barTime, footprint) {
        if (this.tradeFootprint.enabled) {
            // Use rAF-based scheduling for smooth updates
            this.scheduleFootprintRender();
        }
    }
    
    /**
     * Clear all trade footprint data
     */
    clearTradeFootprint() {
        if (typeof tradeAggregator !== 'undefined') {
            tradeAggregator.clear();
        }
        this.clearTradeFootprintCanvas();
        
        // Clear from localStorage
        const key = `tradeFootprint_${this.symbol}_${this.currentInterval}`;
        localStorage.removeItem(key);
    }
    
    // ==========================================
    // Flow Forecast - Predictive Arrows
    // Shows predicted direction for next bar based on order flow
    // ==========================================
    
    /**
     * Toggle Flow Forecast display
     */
    toggleFlowForecast(show) {
        this.flowForecast.enabled = show;
        localStorage.setItem('showFlowForecast', show);
        
        if (show) {
            this.initFlowForecastCanvas();
            
            // Render immediately
            this.renderFlowForecast();
            
            // Also render after a short delay to catch any async initialization
            setTimeout(() => {
                if (this.flowForecast.enabled) {
                    this.renderFlowForecast();
                }
            }, 100);
            
            // And again after chart may have updated
            setTimeout(() => {
                if (this.flowForecast.enabled) {
                    this.renderFlowForecast();
                }
            }, 500);
        } else {
            this.clearFlowForecastCanvas();
        }
    }
    
    /**
     * Initialize flow forecast canvas
     */
    initFlowForecastCanvas() {
        if (this.flowForecast.canvas) {
            console.log('[FlowForecast] Canvas already exists');
            return;
        }
        
        // Check for existing canvas
        const existingCanvas = document.getElementById('flowForecastCanvas');
        if (existingCanvas) {
            this.flowForecast.canvas = existingCanvas;
            this.flowForecast.ctx = existingCanvas.getContext('2d');
            return;
        }
        
        const canvas = document.createElement('canvas');
        canvas.id = 'flowForecastCanvas';
        
        if (this.container) {
            const rect = this.container.getBoundingClientRect();
            
            // Append to body and position absolutely over the chart
            canvas.style.cssText = `
                position: fixed;
                top: ${rect.top}px;
                left: ${rect.left}px;
                width: ${rect.width}px;
                height: ${rect.height}px;
                pointer-events: none;
                z-index: 10;
            `;
            document.body.appendChild(canvas);
            
            canvas.width = rect.width * window.devicePixelRatio;
            canvas.height = rect.height * window.devicePixelRatio;
            
            this.flowForecast.canvas = canvas;
            this.flowForecast.ctx = canvas.getContext('2d');
            this.flowForecast.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            this.flowForecast._cachedWidth = rect.width;
            this.flowForecast._cachedHeight = rect.height;
            
            // Subscribe to time scale changes
            if (this.chart) {
                this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
                    if (this.flowForecast.enabled) {
                        this.scheduleFlowForecastRender();
                    }
                });
            }
            
            // Resize observer
            if (!this._flowForecastResizeObserver) {
                this._flowForecastResizeObserver = new ResizeObserver(() => {
                    this.updateFlowForecastCanvasSize();
                    if (this.flowForecast.enabled) {
                        this.scheduleFlowForecastRender();
                    }
                });
                this._flowForecastResizeObserver.observe(this.container);
            }
            
            // Setup drag tracking for price scale changes
            this._setupFlowForecastDragTracking();
        }
    }

    /**
     * Init small legend for Flow Forecast
     */
    _initFlowForecastLegend() {
        if (this._flowForecastLegend || !this.container) return;

        const legend = document.createElement('div');
        legend.id = 'flowForecastLegend';
        legend.style.cssText = `
            position: absolute;
            bottom: 6px;
            right: 6px;
            padding: 6px 8px;
            background: rgba(15, 23, 42, 0.7);
            color: #cbd5e1;
            font: 10px "JetBrains Mono", monospace;
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 4px;
            pointer-events: none;
            z-index: 12;
        `;

        legend.innerHTML = `
            <div style="display:flex;gap:8px;align-items:center;white-space:nowrap;">
                <span style="color:#10b981;">▲</span> Bull
                <span style="color:#ef4444;">▼</span> Bear
                <span style="color:#fbbf24;">◎</span> Low conf
                <span style="color:#f59e0b;">A</span> Absorption
                <span style="color:#10b981;">✓</span>/<span style="color:#ef4444;">✗</span> Accuracy
            </div>
        `;

        this.container.appendChild(legend);
        this._flowForecastLegend = legend;
    }
    
    /**
     * Setup drag tracking for flow forecast canvas
     */
    _setupFlowForecastDragTracking() {
        if (!this.container || this.flowForecast._dragTrackingSetup) return;
        this.flowForecast._dragTrackingSetup = true;
        
        let isDragging = false;
        let renderLoop = null;
        
        const startDragRender = () => {
            if (renderLoop) return;
            renderLoop = () => {
                if (isDragging && this.flowForecast.enabled) {
                    this.renderFlowForecast();
                    requestAnimationFrame(renderLoop);
                } else {
                    renderLoop = null;
                }
            };
            requestAnimationFrame(renderLoop);
        };
        
        this.container.addEventListener('mousedown', () => {
            isDragging = true;
            startDragRender();
        });
        
        window.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }
    
    /**
     * Update flow forecast canvas size
     */
    updateFlowForecastCanvasSize() {
        if (!this.container || !this.flowForecast.canvas) return;
        
        const rect = this.container.getBoundingClientRect();
        this.flowForecast._cachedWidth = rect.width;
        this.flowForecast._cachedHeight = rect.height;
        
        // Update fixed position
        this.flowForecast.canvas.style.top = `${rect.top}px`;
        this.flowForecast.canvas.style.left = `${rect.left}px`;
        this.flowForecast.canvas.style.width = `${rect.width}px`;
        this.flowForecast.canvas.style.height = `${rect.height}px`;
        
        this.flowForecast.canvas.width = rect.width * window.devicePixelRatio;
        this.flowForecast.canvas.height = rect.height * window.devicePixelRatio;
        
        if (this.flowForecast.ctx) {
            this.flowForecast.ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.flowForecast.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        }
    }
    
    /**
     * Schedule flow forecast render (rAF throttled)
     */
    scheduleFlowForecastRender() {
        if (this.flowForecast._needsRender) return;
        
        this.flowForecast._needsRender = true;
        this.flowForecast._rafId = requestAnimationFrame(() => {
            this.flowForecast._needsRender = false;
            this.renderFlowForecast();
        });
    }
    
    /**
     * Clear flow forecast canvas
     */
    clearFlowForecastCanvas() {
        if (this.flowForecast.canvas && this.flowForecast.ctx) {
            const width = this.flowForecast._cachedWidth || this.container.getBoundingClientRect().width;
            const height = this.flowForecast._cachedHeight || this.container.getBoundingClientRect().height;
            this.flowForecast.ctx.clearRect(0, 0, width, height);
        }
    }
    
    /**
     * Render flow forecast arrows on chart
     */
    renderFlowForecast() {
        if (!this.flowForecast.enabled || !this.chart) {
            return;
        }
        
        // Initialize canvas if needed
        if (!this.flowForecast.canvas || !this.flowForecast.ctx) {
            this.initFlowForecastCanvas();
            if (!this.flowForecast.ctx) {
                console.warn('[FlowForecast] Canvas context not available');
                return;
            }
        }
        
        // Get predictions
        if (typeof flowForecast === 'undefined') {
            console.warn('[FlowForecast] flowForecast global not defined');
            return;
        }
        
        const predictions = flowForecast.getAllPredictions();
        if (predictions.size === 0) {
            // Don't spam console, only log once per minute
            const now = Date.now();
            if (!this._lastNoPredsLog || now - this._lastNoPredsLog > 60000) {
                console.log('[FlowForecast] No predictions to render yet');
                this._lastNoPredsLog = now;
            }
            return;
        }
        
        // Debug: log rendering
        if (this.flowForecast._lastRenderCount !== predictions.size) {
            console.log(`[FlowForecast] Rendering ${predictions.size} predictions`);
            this.flowForecast._lastRenderCount = predictions.size;
        }
        
        const ctx = this.flowForecast.ctx;
        const width = this.flowForecast._cachedWidth || this.container.getBoundingClientRect().width;
        const height = this.flowForecast._cachedHeight || this.container.getBoundingClientRect().height;
        const timeScale = this.chart.timeScale();
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Get visible time range
        const visibleRange = timeScale.getVisibleRange();
        if (!visibleRange) return;
        
        // Get candles for price data
        const candles = this.getCandles();
        if (!candles || candles.length === 0) return;
        
        // Create candle lookup
        const candleMap = new Map();
        candles.forEach(c => candleMap.set(c.time, c));
        
        // Get interval for positioning
        const intervalSec = flowForecast.getIntervalSeconds();
        
        // Draw predictions
        predictions.forEach((prediction, barTime) => {
            // Skip bars outside visible range (with buffer)
            if (barTime < visibleRange.from - intervalSec * 2 || barTime > visibleRange.to + intervalSec * 2) {
                return;
            }
            
            // Always show predictions (no threshold filtering)
            
            // Get x coordinate
            const x = timeScale.timeToCoordinate(barTime);
            if (x === null || x < -20 || x > width + 20) return;
            
            // Get candle for y positioning
            const candle = candleMap.get(barTime);
            if (!candle) return;
            
            // Determine y position: UP arrow below bar (at low), DOWN arrow above bar (at high)
            const isUp = prediction.direction === 'up';
            const yPrice = isUp ? candle.low : candle.high;
            const y = this.candleSeries.priceToCoordinate(yPrice);
            if (y === null) return;
            
            // Check accuracy if bar is closed
            let accuracy = null;
            if (this.flowForecast.showAccuracy) {
                accuracy = flowForecast.checkAccuracy(barTime);
            }
            
            // Draw arrow
            this.drawFlowForecastArrow(ctx, x, y, prediction, accuracy, isUp);
        });
        
        // Draw live prediction (next bar) in future space
        const latestPrediction = flowForecast.getLatestPrediction();
        if (latestPrediction) {
            const targetBarTime = latestPrediction.targetBar;
            
            // Check if this bar is in the future (not yet closed)
            const lastCandle = candles[candles.length - 1];
            if (targetBarTime > lastCandle.time) {
                // Draw in future space
                const x = timeScale.timeToCoordinate(targetBarTime);
                if (x !== null && x > 0 && x < width + 50) {
                    // Use last candle's price as reference: UP below (at low), DOWN above (at high)
                    const yPrice = latestPrediction.direction === 'up' ? lastCandle.low : lastCandle.high;
                    const y = this.candleSeries.priceToCoordinate(yPrice);
                    if (y !== null) {
                        this.drawFlowForecastArrow(ctx, x, y, latestPrediction, null, latestPrediction.direction === 'up', true);
                    }
                }
            }
        }
    }
    
    /**
     * Draw a single flow forecast arrow with confidence number
     * UP arrows below the bar (pointing up), DOWN arrows above the bar (pointing down)
     * Triangles always green/red, text shows additional context
     */
    drawFlowForecastArrow(ctx, x, y, prediction, accuracy, isUp, isLive = false) {
        const confidence = Math.abs(prediction.score);
        const arrowSize = 8;
        
        // UP arrows go BELOW the candle, DOWN arrows go ABOVE
        // y is already at high (for down) or low (for up) from the caller
        const padding = 12;
        const arrowY = isUp ? y + padding : y - padding;
        
        // Check for signal types (for text coloring)
        const bbSignal = prediction.bbSignal || 'normal';
        const bbPulseSignal = prediction.bbPulseSignal;
        const isBBPulseBuy = bbPulseSignal === 'buy1' || bbPulseSignal === 'buy1_wait';
        const isBBPulseSell = bbPulseSignal === 'sell1' || bbPulseSignal === 'sell1_wait';
        const isBBPulseCaution = bbPulseSignal?.includes('caution');
        const isStrong = bbSignal === 'strong_long' || bbSignal === 'strong_short' || 
                        bbSignal === 'price_low_buy' || bbSignal === 'price_high_sell' ||
                        isBBPulseBuy || isBBPulseSell;
        const isCaution = bbSignal === 'caution_long' || bbSignal === 'caution_short' || isBBPulseCaution;
        
        // Determine confidence level
        const uncertainThreshold = flowForecast?.config?.uncertainThreshold || 30;
        const isUncertain = confidence < uncertainThreshold;
        
        // TRIANGLES: Always simple green or red based on direction
        const arrowColor = isUp ? 'rgba(34, 197, 94, 1)' : 'rgba(239, 68, 68, 1)';
        
        // TEXT color varies based on signal type
        let textColor;
        if (prediction.absorption) {
            textColor = 'rgba(249, 115, 22, 1)'; // orange
        } else if (isBBPulseBuy) {
            textColor = 'rgba(6, 182, 212, 1)'; // cyan
        } else if (isBBPulseSell) {
            textColor = 'rgba(236, 72, 153, 1)'; // pink
        } else if (isCaution || isUncertain) {
            textColor = 'rgba(251, 191, 36, 1)'; // yellow
        } else {
            textColor = arrowColor; // match arrow
        }
        
        // Live prediction styling
        if (isLive) {
            ctx.setLineDash([3, 3]);
            ctx.globalAlpha = 0.7;
        } else {
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }
        
        // Draw simple triangle (no shadow/halo)
        ctx.fillStyle = arrowColor;
        
        const drawArrow = (offsetY, alpha = 1) => {
            ctx.globalAlpha = isLive ? 0.7 * alpha : alpha;
            ctx.beginPath();
            if (isUp) {
                // Up arrow pointing up, positioned below candle
                ctx.moveTo(x, arrowY - arrowSize + offsetY);
                ctx.lineTo(x - arrowSize * 0.6, arrowY + offsetY);
                ctx.lineTo(x + arrowSize * 0.6, arrowY + offsetY);
            } else {
                // Down arrow pointing down, positioned above candle
                ctx.moveTo(x, arrowY + arrowSize + offsetY);
                ctx.lineTo(x - arrowSize * 0.6, arrowY + offsetY);
                ctx.lineTo(x + arrowSize * 0.6, arrowY + offsetY);
            }
            ctx.closePath();
            ctx.fill();
        };
        
        // Draw arrows (1, 2, or 3 based on strength)
        const arrowCount = isStrong ? (isBBPulseBuy || isBBPulseSell ? 3 : 2) : 1;
        
        drawArrow(0, 1);
        if (arrowCount >= 2) {
            const offset2 = isUp ? 6 : -6;
            drawArrow(offset2, 0.7);
        }
        if (arrowCount >= 3) {
            const offset3 = isUp ? 12 : -12;
            drawArrow(offset3, 0.5);
        }
        
        ctx.globalAlpha = 1;
        
        // Draw confidence number
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        
        // Text position: further from arrow based on arrow count
        const textOffset = arrowCount * 6 + 4;
        const textY = isUp ? arrowY + textOffset + 2 : arrowY - textOffset - 2;
        ctx.textBaseline = isUp ? 'top' : 'bottom';
        
        // Draw text background
        const text = confidence.toString();
        const textWidth = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(10, 14, 23, 0.85)';
        ctx.fillRect(x - textWidth / 2 - 2, textY - (isUp ? 0 : 10), textWidth + 4, 10);
        
        // Draw confidence text
        ctx.fillStyle = textColor;
        ctx.fillText(text, x, textY);
        
        // Draw context label (BB Pulse, etc.)
        if (prediction.components) {
            let bbLabel = '';
            let labelColor = 'rgba(156, 163, 175, 0.9)'; // gray default
            
            if (prediction.components.atBBPeriodLow) {
                bbLabel = 'L20';
                labelColor = 'rgba(6, 182, 212, 1)'; // cyan
            } else if (prediction.components.atBBPeriodHigh) {
                bbLabel = 'H20';
                labelColor = 'rgba(236, 72, 153, 1)'; // pink
            } else if (prediction.components.atPriceLow20) {
                bbLabel = 'PL';
                labelColor = 'rgba(34, 197, 94, 0.9)';
            } else if (prediction.components.atPriceHigh20) {
                bbLabel = 'PH';
                labelColor = 'rgba(239, 68, 68, 0.9)';
            } else if (prediction.components.percentB < 20) {
                bbLabel = 'OS';
                labelColor = 'rgba(34, 197, 94, 0.9)';
            } else if (prediction.components.percentB > 80) {
                bbLabel = 'OB';
                labelColor = 'rgba(239, 68, 68, 0.9)';
            }
            
            if (bbLabel) {
                ctx.font = 'bold 7px JetBrains Mono, monospace';
                ctx.fillStyle = labelColor;
                const labelY = isUp ? textY + 10 : textY - 10;
                ctx.fillText(bbLabel, x, labelY);
            }
        }
        
        // Draw absorption indicator
        if (prediction.absorption) {
            ctx.font = 'bold 8px JetBrains Mono, monospace';
            ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
            const aY = isUp ? textY - 12 : textY + 12;
            ctx.fillText('A', x, aY);
        }
        
        // Draw accuracy indicator (✓ or ✗) if enabled
        if (accuracy !== null) {
            ctx.font = 'bold 10px Arial';
            ctx.fillStyle = accuracy.correct ? 'rgba(16, 185, 129, 1)' : 'rgba(239, 68, 68, 1)';
            const accSymbol = accuracy.correct ? '✓' : '✗';
            const accX = x + arrowSize + 5;
            const accY = isUp ? arrowY - 2 : arrowY + 2;
            ctx.fillText(accSymbol, accX, accY);
        }
        
        // Reset
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }
    
    // ==========================================
    // Level History - Unified Order Book + Fair Value Tracking
    // Heatmap for clusters, Lines for Mid/IFV/VWMP
    // ==========================================
    
    /**
     * Initialize Level History system
     * Creates canvas for cluster heatmap + line series for fair value indicators
     */
    initLevelHistory() {
        if (!this.chart || !this.container || this.levelHistory.initialized) return;
        
        // Set tracking info
        this.levelHistory.symbol = this.symbol;
        this.levelHistory.interval = this.currentInterval;
        
        // Initialize render state for rAF throttling
        this.levelHistory._needsRender = false;
        this.levelHistory._rafId = null;
        
        // Create canvas for cluster heatmap
        this.initLevelHistoryCanvas();
        
        // Note: Fair value line series removed - now using heatmap buckets instead
        
        // Load saved history from localStorage
        this.loadLevelHistory();
        
        // Load Cluster Proximity signal history
        if (this.clusterProximity.enabled) {
            this.loadClusterProximityHistory();
        }
        
        // Load Cluster Drift signal history
        if (this.clusterDrift.enabled) {
            this.loadClusterDriftHistory();
        }
        
        // Load Live Proximity signal history
        if (this.liveProximity.enabled) {
            this.loadLiveProximityHistory();
        }
        
        // Load Live Drift signal history
        if (this.liveDrift.enabled) {
            this.loadLiveDriftHistory();
        }
        
        // Load LV Signal history (always load - tracks in background even if display disabled)
        this.loadLVSignalHistory();
        this.loadLVSignalHistoryCircles();
        
        // Load Alpha Lead Signal history (always load - tracks in background even if display disabled)
        this.loadAlphaLeadSignalHistory();
        this.loadALSignalHistoryCircles();
        
        // Subscribe to chart changes with rAF throttling
        if (this.chart) {
            // Time scale changes (horizontal drag/zoom)
            this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
                if (this.levelHistory.showHeatmap) {
                    this.scheduleLevelHistoryRender();
                }
            });
        }
        
        // Handle price scale drags by rendering continuously during mouse drag
        this._setupLevelHistoryDragTracking();
        
        // Setup persistence handlers for page refresh/close
        this._setupLevelHistoryPersistence();
        
        this.levelHistory.initialized = true;
        console.log('[Chart] Level History initialized');
    }
    
    /**
     * Setup persistence handlers to save level history on page unload/visibility change
     * Ensures data survives page refresh
     */
    _setupLevelHistoryPersistence() {
        // Save before page unload (refresh/close)
        // Skip if cache clear is in progress
        window.addEventListener('beforeunload', () => {
            if (window._skipSaveOnUnload) return;
            this.saveLevelHistory();
        });
        
        // Save when page becomes hidden (tab switch, minimize)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.saveLevelHistory();
            }
        });
        
        // Periodic auto-save every 30 seconds (catches data if bar hasn't closed)
        this.levelHistory._autoSaveInterval = setInterval(() => {
            if (this.levelHistory.data.size > 0) {
                this.saveLevelHistory();
            }
        }, 30000);
    }
    
    /**
     * Schedule level history render on next animation frame (coalesces multiple calls)
     */
    scheduleLevelHistoryRender() {
        if (this.levelHistory._needsRender) return; // Already scheduled
        
        this.levelHistory._needsRender = true;
        this.levelHistory._rafId = requestAnimationFrame(() => {
            this.levelHistory._needsRender = false;
            this.renderLevelHistoryHeatmap();
        });
    }
    
    /**
     * Setup drag tracking for level history canvas
     * Renders continuously during mouse drag to handle price scale changes
     */
    _setupLevelHistoryDragTracking() {
        if (!this.container || this.levelHistory._dragTrackingSetup) return;
        this.levelHistory._dragTrackingSetup = true;
        
        let isDragging = false;
        let renderLoop = null;
        
        const startDragRender = () => {
            if (renderLoop) return;
            renderLoop = () => {
                if (isDragging && this.levelHistory.showHeatmap) {
                    this.renderLevelHistoryHeatmap();
                    requestAnimationFrame(renderLoop);
                } else {
                    renderLoop = null;
                }
            };
            requestAnimationFrame(renderLoop);
        };
        
        this.container.addEventListener('mousedown', () => {
            isDragging = true;
            startDragRender();
        });
        
        window.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Also handle touch for mobile
        this.container.addEventListener('touchstart', () => {
            isDragging = true;
            startDragRender();
        }, { passive: true });
        
        window.addEventListener('touchend', () => {
            isDragging = false;
        });
    }
    
    /**
     * Initialize canvas for Level History heatmap
     */
    initLevelHistoryCanvas() {
        if (this.levelHistory.canvas) return;
        
        const canvas = document.createElement('canvas');
        canvas.id = 'levelHistoryCanvas';
        canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10;
        `;
        
        this.container.style.position = 'relative';
        this.container.appendChild(canvas);
        
        // Cache dimensions and size canvas
        this.updateLevelHistoryCanvasSize();
        
        this.levelHistory.canvas = canvas;
        this.levelHistory.ctx = canvas.getContext('2d');
        this.levelHistory.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        
        // Update cached dimensions on resize
        if (!this._levelHistoryResizeObserver) {
            this._levelHistoryResizeObserver = new ResizeObserver(() => {
                this.updateLevelHistoryCanvasSize();
                if (this.levelHistory.showHeatmap) {
                    this.scheduleLevelHistoryRender();
                }
            });
            this._levelHistoryResizeObserver.observe(this.container);
        }
    }
    
    /**
     * Update level history canvas size and cache dimensions
     */
    updateLevelHistoryCanvasSize() {
        if (!this.container) return;
        
        const rect = this.container.getBoundingClientRect();
        this.levelHistory._cachedWidth = rect.width;
        this.levelHistory._cachedHeight = rect.height;
        
        if (this.levelHistory.canvas) {
            this.levelHistory.canvas.width = rect.width * window.devicePixelRatio;
            this.levelHistory.canvas.height = rect.height * window.devicePixelRatio;
            
            // Re-scale context after resize
            if (this.levelHistory.ctx) {
                this.levelHistory.ctx.setTransform(1, 0, 0, 1, 0, 0);
                this.levelHistory.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            }
        }
    }
    
    /**
     * Initialize line series for Fair Value indicators
     * Note: Line series removed - now using heatmap buckets instead
     */
    initLevelHistoryLineSeries() {
        // Line series removed - fair value indicators now rendered as heatmap buckets
    }
    
    /**
     * Toggle Level History Heatmap display
     * Note: Data is always cached in background regardless of display setting
     */
    toggleLevelHistoryHeatmap(show) {
        this.levelHistory.showHeatmap = show;
        localStorage.setItem('showLevelHistoryHeatmap', show);
        console.log('[Chart] toggleLevelHistoryHeatmap:', show);
        
        if (show) {
            // Initialize canvas if needed
            this.initLevelHistoryCanvas();
            // Re-render with existing cached data
            this.renderLevelHistoryHeatmap();
        } else {
            // Clear canvas when disabled
            if (this.levelHistory.ctx) {
                const width = this.levelHistory._cachedWidth || this.container.getBoundingClientRect().width;
                const height = this.levelHistory._cachedHeight || this.container.getBoundingClientRect().height;
                this.levelHistory.ctx.clearRect(0, 0, width, height);
            }
        }
    }
    
    /**
     * Toggle Level History Channel Mode
     * Channel mode samples walls continuously throughout bar instead of single snapshot
     */
    toggleLevelHistoryChannelMode(enabled) {
        // Save current mode's data before switching
        this.saveLevelHistory();
        
        // Update mode flag
        this.levelHistory.channelMode = enabled;
        localStorage.setItem('levelHeatmapChannelMode', enabled);
        console.log('[Chart] toggleLevelHistoryChannelMode:', enabled);
        
        // Clear in-memory data (will load new mode's data if exists)
        this.levelHistory.data.clear();
        this.levelHistory.midData = [];
        this.levelHistory.ifvData = [];
        this.levelHistory.vwmpData = [];
        this.levelHistory.currentBarAccumulator.clear();
        this.levelHistory.currentBarSampleCount = 0;
        // Clear fair value accumulators
        this.levelHistory.midBuckets.clear();
        this.levelHistory.ifvBuckets.clear();
        this.levelHistory.vwmpBuckets.clear();
        this.levelHistory.fvSampleCount = 0;
        
        // Load data for the new mode (if any exists)
        this.loadLevelHistory();
        
        // Re-render
        if (this.levelHistory.showHeatmap) {
            this.renderLevelHistoryHeatmap();
        }
    }
    
    /**
     * Set Level History bucket size for channel mode
     */
    setLevelHistoryBucketSize(size) {
        this.levelHistory.bucketSize = parseInt(size) || 50;
        localStorage.setItem('levelHeatmapBucketSize', this.levelHistory.bucketSize);
        console.log('[Chart] setLevelHistoryBucketSize:', this.levelHistory.bucketSize);
    }
    
    /**
     * Set level heatmap brightness multiplier
     */
    setLevelHeatmapBrightness(value) {
        this.levelHistory.brightness = parseFloat(value) || 1;
        localStorage.setItem('levelHeatmapBrightness', this.levelHistory.brightness);
        console.log('[Chart] setLevelHeatmapBrightness:', this.levelHistory.brightness);
        if (this.levelHistory.showHeatmap) {
            this.renderLevelHistoryHeatmap();
        }
    }
    
    /**
     * Set trade heatmap brightness multiplier
     */
    setTradeHeatmapBrightness(value) {
        this.tradeFootprint.brightness = parseFloat(value) || 1;
        localStorage.setItem('tradeHeatmapBrightness', this.tradeFootprint.brightness);
        console.log('[Chart] setTradeHeatmapBrightness:', this.tradeFootprint.brightness);
        if (this.tradeFootprint.enabled) {
            this.renderTradeFootprint();
        }
    }
    
    /**
     * Accumulate level positions into buckets (called on every WS update in channel mode)
     * This tracks where walls appear throughout the bar for channel visualization
     * @param {Array} levels - Current order book levels [{price, type, volume}, ...]
     */
    accumulateLevelBucket(levels) {
        if (!this.levelHistory.channelMode || !levels || levels.length === 0) return;
        
        const bucketSize = this.levelHistory.bucketSize;
        const accumulator = this.levelHistory.currentBarAccumulator;
        
        for (const level of levels) {
            const price = parseFloat(level.price);
            if (!price || price <= 0) continue;
            
            // Calculate bucket key
            const bucket = Math.floor(price / bucketSize) * bucketSize;
            
            // Get or create bucket data
            let data = accumulator.get(bucket);
            if (!data) {
                data = { bidHits: 0, askHits: 0, maxBidVol: 0, maxAskVol: 0 };
                accumulator.set(bucket, data);
            }
            
            const volume = parseFloat(level.volume) || 0;
            
            // Accumulate based on side
            if (level.type === 'support') {
                data.bidHits++;
                data.maxBidVol = Math.max(data.maxBidVol, volume);
            } else if (level.type === 'resistance') {
                data.askHits++;
                data.maxAskVol = Math.max(data.maxAskVol, volume);
            }
        }
        
        this.levelHistory.currentBarSampleCount++;
        
        // Schedule throttled re-render to show current bar in real-time
        if (this.levelHistory.showHeatmap) {
            this.scheduleLevelHistoryRender();
        }
    }
    
    /**
     * Accumulate fair value (mid/ifv/vwmp) positions into buckets
     * Called on every WS update to track where fair values spent time during bar
     * Always tracks in background regardless of display setting
     * @param {number} mid - Current mid price
     * @param {number} ifv - Current IFV price
     * @param {number} vwmp - Current VWMP price
     */
    accumulateFairValueBucket(mid, ifv, vwmp) {
        const bucketSize = this.levelHistory.bucketSize;
        
        // Accumulate mid
        if (mid && isFinite(mid) && mid > 0) {
            const bucket = Math.floor(mid / bucketSize) * bucketSize;
            const hits = (this.levelHistory.midBuckets.get(bucket) || 0) + 1;
            this.levelHistory.midBuckets.set(bucket, hits);
        }
        
        // Accumulate IFV
        if (ifv && isFinite(ifv) && ifv > 0) {
            const bucket = Math.floor(ifv / bucketSize) * bucketSize;
            const hits = (this.levelHistory.ifvBuckets.get(bucket) || 0) + 1;
            this.levelHistory.ifvBuckets.set(bucket, hits);
        }
        
        // Accumulate VWMP
        if (vwmp && isFinite(vwmp) && vwmp > 0) {
            const bucket = Math.floor(vwmp / bucketSize) * bucketSize;
            const hits = (this.levelHistory.vwmpBuckets.get(bucket) || 0) + 1;
            this.levelHistory.vwmpBuckets.set(bucket, hits);
        }
        
        this.levelHistory.fvSampleCount++;
        
        // Schedule render if any fair value indicator is enabled
        if (this.fairValueIndicators.showMid || this.fairValueIndicators.showIFV || this.fairValueIndicators.showVWMP) {
            this.scheduleLevelHistoryRender();
        }
    }
    
    /**
     * Snapshot current levels and fair values on bar close
     * Always caches data regardless of display setting so data is ready when enabled
     * @param {number} newBarTime - The time of the NEW bar that just opened
     */
    snapshotLevelHistory(newBarTime) {
        if (!newBarTime) return;
        
        // Get interval in seconds
        const intervalMap = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        const intervalSec = intervalMap[this.currentInterval] || 60;
        
        // Calculate the bar time that just CLOSED (previous bar)
        const closedBarTime = newBarTime - intervalSec;
        
        // Skip if already have this bar
        if (this.levelHistory.data.has(closedBarTime)) return;
        
        // Get current order book levels (clusters)
        const levels = this.fairValueIndicators.currentLevels;
        
        // Get current price for filtering fair value calculations
        const currentPrice = this.lastCandle?.close || this.currentPrice;
        
        // Calculate fair value indicators (with price filtering)
        const mid = levels ? this.calculateMidPrice(levels) : null;
        const ifv = levels ? this.calculateIFV(levels, currentPrice) : null;
        const vwmp = levels ? this.calculateVWMP(levels, currentPrice) : null;
        
        let snapshot;
        
        // Convert fair value buckets to arrays for storage
        const midBuckets = Array.from(this.levelHistory.midBuckets.entries()).map(([price, hits]) => ({ price, hits }));
        const ifvBuckets = Array.from(this.levelHistory.ifvBuckets.entries()).map(([price, hits]) => ({ price, hits }));
        const vwmpBuckets = Array.from(this.levelHistory.vwmpBuckets.entries()).map(([price, hits]) => ({ price, hits }));
        const fvSampleCount = this.levelHistory.fvSampleCount;
        
        if (this.levelHistory.channelMode) {
            // CHANNEL MODE: Save accumulated bucket data
            const accumulator = this.levelHistory.currentBarAccumulator;
            
            if (accumulator.size === 0 && midBuckets.length === 0 && ifvBuckets.length === 0 && vwmpBuckets.length === 0) {
                console.warn('[LevelHistory] Channel mode: No bucket data accumulated for bar');
                return;
            }
            
            // Convert Map to array for storage (Maps don't serialize well)
            const buckets = [];
            accumulator.forEach((data, bucket) => {
                buckets.push({
                    price: bucket,
                    bidHits: data.bidHits,
                    askHits: data.askHits,
                    maxBidVol: data.maxBidVol,
                    maxAskVol: data.maxAskVol
                });
            });
            
            snapshot = {
                buckets: buckets,
                sampleCount: this.levelHistory.currentBarSampleCount,
                mid: mid,
                ifv: ifv,
                vwmp: vwmp,
                midBuckets: midBuckets,
                ifvBuckets: ifvBuckets,
                vwmpBuckets: vwmpBuckets,
                fvSampleCount: fvSampleCount,
                isChannelMode: true
            };
            
            console.log(`[LevelHistory] Channel snapshot bar ${closedBarTime}: ${buckets.length} level buckets, ${midBuckets.length}/${ifvBuckets.length}/${vwmpBuckets.length} fv buckets, ${this.levelHistory.currentBarSampleCount} samples`);
            
            // Reset accumulators for next bar
            this.levelHistory.currentBarAccumulator.clear();
            this.levelHistory.currentBarSampleCount = 0;
            
        } else {
            // STANDARD MODE: Single snapshot at bar close
            if (!levels || levels.length === 0) {
                console.warn('[LevelHistory] No levels available for snapshot');
                return;
            }
            
            // Extract clusters (top levels by volume)
            const clusters = this.extractClustersForHistory(levels);
            
            snapshot = {
                clusters: clusters,
                mid: mid,
                ifv: ifv,
                vwmp: vwmp,
                midBuckets: midBuckets,
                ifvBuckets: ifvBuckets,
                vwmpBuckets: vwmpBuckets,
                fvSampleCount: fvSampleCount
            };
            
            console.log(`[LevelHistory] Snapshot bar ${closedBarTime}: ${clusters.length} clusters, ${midBuckets.length}/${ifvBuckets.length}/${vwmpBuckets.length} fv buckets, price=${currentPrice}`);
        }
        
        // Reset fair value accumulators for next bar
        this.levelHistory.midBuckets.clear();
        this.levelHistory.ifvBuckets.clear();
        this.levelHistory.vwmpBuckets.clear();
        this.levelHistory.fvSampleCount = 0;
        
        this.levelHistory.data.set(closedBarTime, snapshot);
        this.levelHistory.lastBarTime = closedBarTime;
        
        // Add to line series data arrays
        if (mid) this.levelHistory.midData.push({ time: closedBarTime, value: mid });
        if (ifv) this.levelHistory.ifvData.push({ time: closedBarTime, value: ifv });
        if (vwmp) this.levelHistory.vwmpData.push({ time: closedBarTime, value: vwmp });
        
        // Trim old data if exceeds max
        this.trimLevelHistoryData();
        
        // Render updates
        this.renderLevelHistoryHeatmap();
        this.renderLevelHistoryLines();
        
        // Save to localStorage (throttled)
        this.saveLevelHistory();
    }
    
    /**
     * Extract significant clusters from levels for history
     */
    extractClustersForHistory(levels) {
        if (!levels || levels.length === 0) return [];
        
        // Filter to only valid price levels (must be > 100 for BTC, reasonable range)
        // and must have type 'support' or 'resistance'
        const validLevels = levels.filter(level => {
            const price = parseFloat(level.price);
            return price > 100 && // Filter out garbage prices
                   price < 10000000 && // And unrealistically high prices
                   (level.type === 'support' || level.type === 'resistance') &&
                   level.volume > 0;
        });
        
        // Sort by volume and take top clusters (limit to prevent bloat)
        const maxClusters = 30;
        const sorted = [...validLevels].sort((a, b) => b.volume - a.volume);
        
        return sorted.slice(0, maxClusters).map(level => ({
            price: parseFloat(level.price),
            type: level.type, // 'support' or 'resistance'
            volume: Math.round(level.volume * 1000) / 1000 // Round for storage
        }));
    }
    
    /**
     * Trim level history data to max bars
     */
    trimLevelHistoryData() {
        const max = this.levelHistory.maxBars;
        
        if (this.levelHistory.data.size > max) {
            const sortedTimes = Array.from(this.levelHistory.data.keys()).sort((a, b) => a - b);
            const toRemove = sortedTimes.slice(0, this.levelHistory.data.size - max);
            toRemove.forEach(time => this.levelHistory.data.delete(time));
        }
        
        // Trim line data arrays
        if (this.levelHistory.midData.length > max) {
            this.levelHistory.midData = this.levelHistory.midData.slice(-max);
        }
        if (this.levelHistory.ifvData.length > max) {
            this.levelHistory.ifvData = this.levelHistory.ifvData.slice(-max);
        }
        if (this.levelHistory.vwmpData.length > max) {
            this.levelHistory.vwmpData = this.levelHistory.vwmpData.slice(-max);
        }
    }
    
    /**
     * Render cluster heatmap on canvas
     * Supports two modes:
     * - Standard: Individual rectangles at exact cluster prices (single snapshot per bar)
     * - Channel: Bucket bands showing wall movement range (accumulated throughout bar)
     * Optimized: filters to visible bars, uses cached dimensions, rAF throttled
     */
    renderLevelHistoryHeatmap() {
        const width = this.levelHistory._cachedWidth || this.container?.getBoundingClientRect().width || 0;
        const height = this.levelHistory._cachedHeight || this.container?.getBoundingClientRect().height || 0;
        
        if (!this.levelHistory.showHeatmap || !this.levelHistory.ctx || !this.chart) {
            // Clear canvas if heatmap disabled but canvas exists
            if (!this.levelHistory.showHeatmap && this.levelHistory.ctx) {
                this.levelHistory.ctx.clearRect(0, 0, width, height);
            }
            return;
        }
        
        const ctx = this.levelHistory.ctx;
        const timeScale = this.chart.timeScale();
        
        // Clear canvas
        ctx.clearRect(0, 0, width, height);
        
        // Check if we have any data (historical OR current bar accumulator)
        const hasHistoricalData = this.levelHistory.data.size > 0;
        const hasCurrentBarData = this.levelHistory.channelMode && 
            this.levelHistory.currentBarAccumulator && 
            this.levelHistory.currentBarAccumulator.size > 0;
        
        if (!hasHistoricalData && !hasCurrentBarData) {
            // No data yet - waiting for first bar data
            return;
        }
        
        // Get visible time range for filtering
        const visibleTimeRange = timeScale.getVisibleRange();
        if (!visibleTimeRange) return;
        
        // Get interval in seconds
        const intervalMap = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        const intervalSec = intervalMap[this.currentInterval] || 60;
        
        // Add buffer to visible range
        const bufferTime = intervalSec * 2;
        const visibleFrom = visibleTimeRange.from - bufferTime;
        const visibleTo = visibleTimeRange.to + bufferTime;
        
        // Filter to visible bars
        const visibleBars = [];
        this.levelHistory.data.forEach((snapshot, barTime) => {
            if (barTime < visibleFrom || barTime > visibleTo) return;
            visibleBars.push({ barTime, snapshot });
        });
        
        // Check if we're in channel mode (use stored mode or current setting)
        const isChannelMode = this.levelHistory.channelMode || 
            (visibleBars.length > 0 && visibleBars[0]?.snapshot?.isChannelMode === true);
        
        // Allow rendering even with no historical bars if we have current bar data in channel mode
        if (visibleBars.length === 0 && !hasCurrentBarData) return;
        
        console.log(`[LevelHistory Render] ${visibleBars.length} visible bars, channelMode=${isChannelMode}, first bar:`, visibleBars[0]?.snapshot);
        
        if (isChannelMode) {
            this._renderChannelModeHeatmap(ctx, visibleBars, timeScale, intervalSec, width, height);
        } else {
            this._renderStandardModeHeatmap(ctx, visibleBars, timeScale, intervalSec, width, height);
        }
    }
    
    /**
     * Render standard mode heatmap (single snapshot clusters)
     */
    _renderStandardModeHeatmap(ctx, visibleBars, timeScale, intervalSec, width, height) {
        // Find max volume across all visible bars
        let maxVolume = 0;
        for (const { snapshot } of visibleBars) {
            if (!snapshot.clusters) continue;
            for (const cluster of snapshot.clusters) {
                maxVolume = Math.max(maxVolume, cluster.volume);
            }
        }
        
        if (maxVolume === 0) return;
        
        // Pre-calculate bar width once
        let barWidth = 6;
        if (visibleBars.length > 0) {
            const sampleX = timeScale.timeToCoordinate(visibleBars[0].barTime);
            const sampleNextX = timeScale.timeToCoordinate(visibleBars[0].barTime + intervalSec);
            if (sampleX !== null && sampleNextX !== null) {
                barWidth = Math.max(2, (sampleNextX - sampleX) * 0.8);
            }
        }
        
        // Calculate bucket size and height for fair value rendering
        const bucketSize = this.levelHistory.bucketSize;
        const refPrice = this.currentPrice || 100000;
        const refY1 = this.candleSeries.priceToCoordinate(refPrice);
        const refY2 = this.candleSeries.priceToCoordinate(refPrice + bucketSize);
        let bucketHeight = refY1 !== null && refY2 !== null 
            ? Math.abs(refY1 - refY2) 
            : 8;
        bucketHeight = Math.max(4, bucketHeight);
        
        // Draw heatmap for each visible bar
        for (const { barTime, snapshot } of visibleBars) {
            if (!snapshot.clusters) continue;
            
            const x = timeScale.timeToCoordinate(barTime);
            if (x === null || x < -barWidth || x > width + barWidth) continue;
            
            // Draw each cluster
            for (const cluster of snapshot.clusters) {
                const y = this.candleSeries.priceToCoordinate(cluster.price);
                if (y === null || y < -10 || y > height + 10) continue;
                
                const intensity = Math.min(1, cluster.volume / maxVolume);
                const brightness = this.levelHistory.brightness || 1;
                const alpha = Math.min(1, (0.3 + intensity * 0.6) * brightness);
                
                // Color by type: resistance = magenta, support = cyan
                ctx.fillStyle = cluster.type === 'resistance'
                    ? `rgba(255, 0, 110, ${alpha})`
                    : `rgba(0, 217, 255, ${alpha})`;
                
                // Draw rectangle at price level
                const rectHeight = Math.max(4, 6 + intensity * 4);
                ctx.fillRect(x - barWidth / 2, y - rectHeight / 2, barWidth, rectHeight);
            }
        }
        
        // Render fair value buckets on top
        this._renderFairValueBuckets(ctx, visibleBars, timeScale, intervalSec, width, height, bucketSize, barWidth, bucketHeight);
    }
    
    /**
     * Render channel mode heatmap (accumulated bucket bands)
     * Shows where walls traveled throughout the bar as a channel/band
     */
    _renderChannelModeHeatmap(ctx, visibleBars, timeScale, intervalSec, width, height) {
        const bucketSize = this.levelHistory.bucketSize;
        
        // Build current bar's bucket data from the live accumulator
        const now = Math.floor(Date.now() / 1000);
        const currentBarTime = this.getBarTime(now, this.currentInterval);
        let currentBarBuckets = [];
        if (currentBarTime && this.levelHistory.currentBarAccumulator && this.levelHistory.currentBarAccumulator.size > 0) {
            currentBarBuckets = Array.from(this.levelHistory.currentBarAccumulator.entries()).map(([price, data]) => ({
                price,
                bidHits: data.bidHits,
                askHits: data.askHits,
                maxBidVol: data.maxBidVol,
                maxAskVol: data.maxAskVol
            }));
        }
        
        // Find max hits across all visible bars AND current bar for normalization
        let maxHits = 0;
        let totalBuckets = 0;
        for (const { snapshot } of visibleBars) {
            if (!snapshot.buckets) continue;
            totalBuckets += snapshot.buckets.length;
            for (const bucket of snapshot.buckets) {
                const totalHits = bucket.bidHits + bucket.askHits;
                maxHits = Math.max(maxHits, totalHits);
            }
        }
        // Include current bar in max calculation
        for (const bucket of currentBarBuckets) {
            const totalHits = bucket.bidHits + bucket.askHits;
            maxHits = Math.max(maxHits, totalHits);
        }
        totalBuckets += currentBarBuckets.length;
        
        if (maxHits === 0) return;
        
        // Pre-calculate bar width once
        // Try to use historical bar time, or fall back to current bar time
        let barWidth = 6;
        const sampleBarTime = visibleBars.length > 0 ? visibleBars[0].barTime : currentBarTime;
        if (sampleBarTime) {
            const sampleX = timeScale.timeToCoordinate(sampleBarTime);
            const sampleNextX = timeScale.timeToCoordinate(sampleBarTime + intervalSec);
            if (sampleX !== null && sampleNextX !== null) {
                barWidth = Math.max(2, (sampleNextX - sampleX) * 0.8);
            }
        }
        
        // Calculate bucket height in pixels (convert price to y coordinates)
        // Use a reference price to estimate pixel height of one bucket
        const refPrice = this.currentPrice || 100000;
        const refY1 = this.candleSeries.priceToCoordinate(refPrice);
        const refY2 = this.candleSeries.priceToCoordinate(refPrice + bucketSize);
        let bucketHeight = refY1 !== null && refY2 !== null 
            ? Math.abs(refY1 - refY2) 
            : 8; // Fallback height
        
        // Ensure minimum visible height
        bucketHeight = Math.max(4, bucketHeight);
        
        // Count how many buckets we actually draw
        let drawnBuckets = 0;
        
        // Draw heatmap for each visible bar (historical)
        for (const { barTime, snapshot } of visibleBars) {
            if (!snapshot.buckets) continue;
            
            const x = timeScale.timeToCoordinate(barTime);
            if (x === null || x < -barWidth || x > width + barWidth) continue;
            
            // Draw each bucket
            for (const bucket of snapshot.buckets) {
                const y = this.candleSeries.priceToCoordinate(bucket.price + bucketSize / 2); // Center of bucket
                if (y === null || y < -bucketHeight || y > height + bucketHeight) continue;
                
                drawnBuckets++;
                
                const totalHits = bucket.bidHits + bucket.askHits;
                const intensity = Math.min(1, totalHits / maxHits);
                const brightness = this.levelHistory.brightness || 1;
                const alpha = Math.min(1, (0.15 + intensity * 0.65) * brightness);
                
                // Color by dominant side: more bids = cyan, more asks = magenta
                const isBidDominant = bucket.bidHits >= bucket.askHits;
                ctx.fillStyle = isBidDominant
                    ? `rgba(0, 217, 255, ${alpha})`   // cyan for bid-dominant
                    : `rgba(255, 0, 110, ${alpha})`; // magenta for ask-dominant
                
                // Draw bucket rectangle - height based on actual bucket size
                const rectHeight = Math.max(4, bucketHeight);
                ctx.fillRect(x - barWidth / 2, y - rectHeight / 2, barWidth, rectHeight);
            }
        }
        
        // Draw current bar's live accumulated data
        if (currentBarTime && currentBarBuckets.length > 0) {
            const x = timeScale.timeToCoordinate(currentBarTime);
            if (x !== null && x >= -barWidth && x <= width + barWidth) {
                for (const bucket of currentBarBuckets) {
                    const y = this.candleSeries.priceToCoordinate(bucket.price + bucketSize / 2);
                    if (y === null || y < -bucketHeight || y > height + bucketHeight) continue;
                    
                    drawnBuckets++;
                    
                    const totalHits = bucket.bidHits + bucket.askHits;
                    const intensity = Math.min(1, totalHits / maxHits);
                    const brightness = this.levelHistory.brightness || 1;
                    const alpha = Math.min(1, (0.15 + intensity * 0.65) * brightness);
                    
                    const isBidDominant = bucket.bidHits >= bucket.askHits;
                    ctx.fillStyle = isBidDominant
                        ? `rgba(0, 217, 255, ${alpha})`
                        : `rgba(255, 0, 110, ${alpha})`;
                    
                    const rectHeight = Math.max(4, bucketHeight);
                    ctx.fillRect(x - barWidth / 2, y - rectHeight / 2, barWidth, rectHeight);
                }
            }
        }
        
        // Render fair value buckets (mid/ifv/vwmp) on top of level buckets
        this._renderFairValueBuckets(ctx, visibleBars, timeScale, intervalSec, width, height, bucketSize, barWidth, bucketHeight);
    }
    
    /**
     * Render fair value bucket heatmaps (mid, ifv, vwmp)
     * Shows where fair values spent time during each bar
     */
    _renderFairValueBuckets(ctx, visibleBars, timeScale, intervalSec, width, height, bucketSize, barWidth, bucketHeight) {
        const showMid = this.fairValueIndicators.showMid;
        const showIFV = this.fairValueIndicators.showIFV;
        const showVWMP = this.fairValueIndicators.showVWMP;
        
        // Skip if none enabled
        if (!showMid && !showIFV && !showVWMP) return;
        
        // Build current bar's fair value buckets from live accumulators
        const now = Math.floor(Date.now() / 1000);
        const currentBarTime = this.getBarTime(now, this.currentInterval);
        
        const currentMidBuckets = currentBarTime && this.levelHistory.midBuckets.size > 0
            ? Array.from(this.levelHistory.midBuckets.entries()).map(([price, hits]) => ({ price, hits }))
            : [];
        const currentIfvBuckets = currentBarTime && this.levelHistory.ifvBuckets.size > 0
            ? Array.from(this.levelHistory.ifvBuckets.entries()).map(([price, hits]) => ({ price, hits }))
            : [];
        const currentVwmpBuckets = currentBarTime && this.levelHistory.vwmpBuckets.size > 0
            ? Array.from(this.levelHistory.vwmpBuckets.entries()).map(([price, hits]) => ({ price, hits }))
            : [];
        
        // Find max hits for each indicator type across all visible bars
        let maxMidHits = 0, maxIfvHits = 0, maxVwmpHits = 0;
        for (const { snapshot } of visibleBars) {
            if (snapshot.midBuckets) {
                for (const b of snapshot.midBuckets) maxMidHits = Math.max(maxMidHits, b.hits);
            }
            if (snapshot.ifvBuckets) {
                for (const b of snapshot.ifvBuckets) maxIfvHits = Math.max(maxIfvHits, b.hits);
            }
            if (snapshot.vwmpBuckets) {
                for (const b of snapshot.vwmpBuckets) maxVwmpHits = Math.max(maxVwmpHits, b.hits);
            }
        }
        // Include current bar
        for (const b of currentMidBuckets) maxMidHits = Math.max(maxMidHits, b.hits);
        for (const b of currentIfvBuckets) maxIfvHits = Math.max(maxIfvHits, b.hits);
        for (const b of currentVwmpBuckets) maxVwmpHits = Math.max(maxVwmpHits, b.hits);
        
        const brightness = this.levelHistory.brightness || 1;
        const fvBarWidth = Math.max(2, barWidth * 0.5); // Thinner bars for fair value
        const fvBucketHeight = Math.max(3, bucketHeight * 0.6); // Slightly smaller height
        
        // Helper to draw fair value bucket for a bar
        const drawFvBucket = (x, buckets, maxHits, color) => {
            if (!buckets || maxHits === 0) return;
            for (const bucket of buckets) {
                const y = this.candleSeries.priceToCoordinate(bucket.price + bucketSize / 2);
                if (y === null || y < -fvBucketHeight || y > height + fvBucketHeight) continue;
                
                const intensity = Math.min(1, bucket.hits / maxHits);
                const alpha = Math.min(1, (0.2 + intensity * 0.7) * brightness);
                
                ctx.fillStyle = color.replace('ALPHA', alpha.toFixed(2));
                ctx.fillRect(x - fvBarWidth / 2, y - fvBucketHeight / 2, fvBarWidth, fvBucketHeight);
            }
        };
        
        // Draw for each visible bar
        for (const { barTime, snapshot } of visibleBars) {
            const x = timeScale.timeToCoordinate(barTime);
            if (x === null || x < -barWidth || x > width + barWidth) continue;
            
            // Draw in order: Mid (bottom), IFV (middle), VWMP (top)
            if (showMid && snapshot.midBuckets) {
                drawFvBucket(x, snapshot.midBuckets, maxMidHits, 'rgba(148, 163, 184, ALPHA)'); // Gray
            }
            if (showIFV && snapshot.ifvBuckets) {
                drawFvBucket(x, snapshot.ifvBuckets, maxIfvHits, 'rgba(251, 191, 36, ALPHA)'); // Gold
            }
            if (showVWMP && snapshot.vwmpBuckets) {
                drawFvBucket(x, snapshot.vwmpBuckets, maxVwmpHits, 'rgba(52, 211, 153, ALPHA)'); // Green
            }
        }
        
        // Draw current bar's live fair value data
        if (currentBarTime) {
            const x = timeScale.timeToCoordinate(currentBarTime);
            if (x !== null && x >= -barWidth && x <= width + barWidth) {
                if (showMid) drawFvBucket(x, currentMidBuckets, maxMidHits, 'rgba(148, 163, 184, ALPHA)');
                if (showIFV) drawFvBucket(x, currentIfvBuckets, maxIfvHits, 'rgba(251, 191, 36, ALPHA)');
                if (showVWMP) drawFvBucket(x, currentVwmpBuckets, maxVwmpHits, 'rgba(52, 211, 153, ALPHA)');
            }
        }
    }
    
    /**
     * Render fair value indicator lines
     * Only shows lines when their corresponding toggle is enabled
     * Data is still tracked in background regardless of toggle state
     */
    renderLevelHistoryLines() {
        // Line series removed - now using heatmap buckets for fair value indicators
        // This function kept for compatibility but does nothing
    }
    
    /**
     * Get localStorage key for level history
     * Includes mode suffix to prevent standard/channel data conflicts
     */
    getLevelHistoryStorageKey() {
        const mode = this.levelHistory.channelMode ? '_ch' : '';
        return `levelHistory_${this.levelHistory.symbol}_${this.levelHistory.interval}${mode}`;
    }
    
    /**
     * Save level history to localStorage
     * Handles both standard mode (clusters) and channel mode (buckets)
     */
    saveLevelHistory() {
        try {
            const data = {};
            const isChannelMode = this.levelHistory.channelMode;
            
            this.levelHistory.data.forEach((snapshot, barTime) => {
                // Save fair value buckets (if present)
                const fvData = {};
                if (snapshot.midBuckets && snapshot.midBuckets.length > 0) {
                    fvData.mb = snapshot.midBuckets.map(b => ({ p: b.price, h: b.hits }));
                }
                if (snapshot.ifvBuckets && snapshot.ifvBuckets.length > 0) {
                    fvData.ib = snapshot.ifvBuckets.map(b => ({ p: b.price, h: b.hits }));
                }
                if (snapshot.vwmpBuckets && snapshot.vwmpBuckets.length > 0) {
                    fvData.wb = snapshot.vwmpBuckets.map(b => ({ p: b.price, h: b.hits }));
                }
                if (snapshot.fvSampleCount) {
                    fvData.fsc = snapshot.fvSampleCount;
                }
                
                if (snapshot.isChannelMode || snapshot.buckets) {
                    // Channel mode: save buckets
                    data[barTime] = {
                        b: snapshot.buckets.map(b => ({
                            p: b.price,
                            bh: b.bidHits,
                            ah: b.askHits,
                            bv: Math.round(b.maxBidVol * 1000) / 1000,
                            av: Math.round(b.maxAskVol * 1000) / 1000
                        })),
                        sc: snapshot.sampleCount,
                        m: snapshot.mid,
                        i: snapshot.ifv,
                        w: snapshot.vwmp,
                        ch: true, // Channel mode flag
                        ...fvData
                    };
                } else {
                    // Standard mode: save clusters
                    data[barTime] = {
                        c: snapshot.clusters.map(c => ({
                            p: c.price,
                            t: c.type === 'resistance' ? 'r' : 's',
                            v: c.volume
                        })),
                        m: snapshot.mid,
                        i: snapshot.ifv,
                        w: snapshot.vwmp,
                        ...fvData
                    };
                }
            });
            
            localStorage.setItem(this.getLevelHistoryStorageKey(), JSON.stringify(data));
        } catch (e) {
            console.warn('[Chart] Failed to save level history:', e);
        }
    }
    
    /**
     * Load level history from localStorage
     * Handles both standard mode (clusters) and channel mode (buckets)
     */
    loadLevelHistory() {
        try {
            const key = this.getLevelHistoryStorageKey();
            const saved = localStorage.getItem(key);
            if (!saved) return;
            
            const data = JSON.parse(saved);
            this.levelHistory.data.clear();
            this.levelHistory.midData = [];
            this.levelHistory.ifvData = [];
            this.levelHistory.vwmpData = [];
            
            Object.entries(data).forEach(([barTime, snapshot]) => {
                const time = parseInt(barTime);
                
                // Load fair value buckets (if present)
                const midBuckets = snapshot.mb ? snapshot.mb.map(b => ({ price: b.p, hits: b.h })) : [];
                const ifvBuckets = snapshot.ib ? snapshot.ib.map(b => ({ price: b.p, hits: b.h })) : [];
                const vwmpBuckets = snapshot.wb ? snapshot.wb.map(b => ({ price: b.p, hits: b.h })) : [];
                const fvSampleCount = snapshot.fsc || 0;
                
                if (snapshot.ch || snapshot.b) {
                    // Channel mode data
                    const buckets = snapshot.b.map(b => ({
                        price: b.p,
                        bidHits: b.bh,
                        askHits: b.ah,
                        maxBidVol: b.bv,
                        maxAskVol: b.av
                    }));
                    
                    this.levelHistory.data.set(time, {
                        buckets: buckets,
                        sampleCount: snapshot.sc,
                        mid: snapshot.m,
                        ifv: snapshot.i,
                        vwmp: snapshot.w,
                        midBuckets: midBuckets,
                        ifvBuckets: ifvBuckets,
                        vwmpBuckets: vwmpBuckets,
                        fvSampleCount: fvSampleCount,
                        isChannelMode: true
                    });
                } else {
                    // Standard mode data
                    const clusters = snapshot.c.map(c => ({
                        price: c.p,
                        type: c.t === 'r' ? 'resistance' : 'support',
                        volume: c.v
                    }));
                    
                    this.levelHistory.data.set(time, {
                        clusters: clusters,
                        mid: snapshot.m,
                        ifv: snapshot.i,
                        vwmp: snapshot.w,
                        midBuckets: midBuckets,
                        ifvBuckets: ifvBuckets,
                        vwmpBuckets: vwmpBuckets,
                        fvSampleCount: fvSampleCount
                    });
                }
                
                // Build line data arrays (same for both modes) - for legacy line series
                if (snapshot.m) this.levelHistory.midData.push({ time: time, value: snapshot.m });
                if (snapshot.i) this.levelHistory.ifvData.push({ time: time, value: snapshot.i });
                if (snapshot.w) this.levelHistory.vwmpData.push({ time: time, value: snapshot.w });
            });
            
            // Sort line data by time
            this.levelHistory.midData.sort((a, b) => a.time - b.time);
            this.levelHistory.ifvData.sort((a, b) => a.time - b.time);
            this.levelHistory.vwmpData.sort((a, b) => a.time - b.time);
            
            // Render loaded data
            this.renderLevelHistoryHeatmap();
            this.renderLevelHistoryLines();
            
            console.log(`[Chart] Loaded ${this.levelHistory.data.size} bars of level history`);
        } catch (e) {
            console.warn('[Chart] Failed to load level history:', e);
        }
    }
    
    /**
     * Clear level history (called on interval/symbol change)
     */
    clearLevelHistory() {
        // Save current data first
        this.saveLevelHistory();
        
        // Clear in-memory data
        this.levelHistory.data.clear();
        this.levelHistory.midData = [];
        this.levelHistory.ifvData = [];
        this.levelHistory.vwmpData = [];
        this.levelHistory.lastBarTime = null;
        
        // Clear channel mode accumulator
        this.levelHistory.currentBarAccumulator.clear();
        this.levelHistory.currentBarSampleCount = 0;
        
        // Clear fair value bucket accumulators
        this.levelHistory.midBuckets.clear();
        this.levelHistory.ifvBuckets.clear();
        this.levelHistory.vwmpBuckets.clear();
        this.levelHistory.fvSampleCount = 0;
        
        // Clear canvas
        if (this.levelHistory.ctx && this.container) {
            const rect = this.container.getBoundingClientRect();
            this.levelHistory.ctx.clearRect(0, 0, rect.width, rect.height);
        }
        
        // Note: Line series removed - using heatmap buckets instead
    }
    
    /**
     * Handle symbol change for level history
     */
    onLevelHistorySymbolChange(newSymbol) {
        if (this.levelHistory.symbol === newSymbol) return;
        
        // Save current, clear, update, load new
        this.clearLevelHistory();
        this.levelHistory.symbol = newSymbol;
        this.loadLevelHistory();
    }
    
    /**
     * Handle interval change for level history
     */
    onLevelHistoryIntervalChange(newInterval) {
        if (this.levelHistory.interval === newInterval) return;
        
        // Save current, clear, update, load new
        this.clearLevelHistory();
        this.levelHistory.interval = newInterval;
        this.loadLevelHistory();
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
        // Re-render heatmap to show/hide Mid bucket heatmap
        this.renderLevelHistoryHeatmap();
        this.renderLevelHistoryLines();
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
        // Re-render heatmap to show/hide IFV bucket heatmap
        this.renderLevelHistoryHeatmap();
        this.renderLevelHistoryLines();
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
        // Re-render heatmap to show/hide VWMP bucket heatmap
        this.renderLevelHistoryHeatmap();
        this.renderLevelHistoryLines();
    }
    
    /**
     * Store levels for fair value calculations
     */
    setFairValueLevels(levels) {
        this.fairValueIndicators.currentLevels = levels;
        this.updateFairValueIndicators();
    }
    
    /**
     * Calculate Simple Mid Price
     * Average of best bid and best ask
     * @param {Array} levels - Order book levels
     */
    calculateMidPrice(levels) {
        if (!levels || levels.length === 0) return null;
        
        // Find best bid (highest support price)
        const supports = levels.filter(l => l.type === 'support');
        const resistances = levels.filter(l => l.type === 'resistance');
        
        if (supports.length === 0 || resistances.length === 0) return null;
        
        const bestBid = Math.max(...supports.map(l => parseFloat(l.price)));
        const bestAsk = Math.min(...resistances.map(l => parseFloat(l.price)));
        
        if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return null;
        
        return (bestBid + bestAsk) / 2;
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
        
        // Always accumulate fair value buckets for heatmap (tracks in background)
        this.accumulateFairValueBucket(mid, ifv, vwmp);

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
            
            // Single point per bar - creates flowing connected line (like Bulls vs Bears levels)
            if (record.vwmp) {
                vwmpData.push({ time: candleTime, value: record.vwmp });
            }
            
            if (record.ifv) {
                ifvData.push({ time: candleTime, value: record.ifv });
            }
            
            if (record.upsideTarget) {
                upsideData.push({ time: candleTime, value: record.upsideTarget });
            }
            
            if (record.downsideTarget) {
                downsideData.push({ time: candleTime, value: record.downsideTarget });
            }
        });
        
        // Get brightness from settings (0-1), shared with historical levels
        // Keep same base colors as current VWMP/IFV, but with lower opacity for history.
        const baseOpacity = 0.55;
        
        // Note: VWMP and IFV line series removed - now using heatmap buckets instead
        // Only upside/downside targets remain as line series
        
        // Create ghosted upside target series (faded cyan)
        const targetOpacity = baseOpacity * 0.75;
        if (!this.historicalFairValue.upsideSeries) {
            try {
                this.historicalFairValue.upsideSeries = this.chart.addLineSeries({
                    color: `rgba(0, 217, 255, ${targetOpacity})`,  // Cyan
                    lineWidth: 1,
                    lineStyle: LightweightCharts.LineStyle.Solid,
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
                    lineStyle: LightweightCharts.LineStyle.Solid,
                    crosshairMarkerVisible: false,
                    lastValueVisible: false,
                    priceLineVisible: false
                });
                this.historicalFairValue.series.push(this.historicalFairValue.downsideSeries);
            } catch (e) { /* ignore */ }
        } else {
            try { this.historicalFairValue.downsideSeries.applyOptions({ color: `rgba(255, 0, 110, ${targetOpacity})` }); } catch (e) {}
        }
        
        // Note: VWMP/IFV line series removed - using heatmap buckets instead
        
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
        const recommendedDirection = document.getElementById('recommendedDirection');
        const tradeEntry = document.getElementById('tradeEntry');
        const tradeStop = document.getElementById('tradeStop');
        const tradeTarget1 = document.getElementById('tradeTarget1');
        const tradeTarget2 = document.getElementById('tradeTarget2');
        const tradeRR = document.getElementById('tradeRR');
        const tradeReasoning = document.getElementById('tradeReasoning');
        const minGainInput = document.getElementById('minGainPercent');
        
        if (!recommendedDirection || !currentPrice) return;
        
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
        
        // Update DOM - always show recommended direction
        recommendedDirection.textContent = recommendedDir;
        recommendedDirection.className = 'ts-rec-value ' + (recommendedDir === 'LONG' ? 'long' : recommendedDir === 'SHORT' ? 'short' : 'wait');
        
        if (!userPosition) {
            tradeEntry.textContent = '$--';
            tradeStop.textContent = '$--';
            tradeTarget1.textContent = '$--';
            tradeTarget2.textContent = '$--';
            tradeRR.textContent = '--';
        } else {
            tradeEntry.textContent = formatPrice(entry);
            tradeStop.textContent = formatPrice(stop);
            tradeTarget1.textContent = formatPrice(target1) + ` (${potentialGainPercent?.toFixed(1) || 0}%)`;
            tradeTarget2.textContent = formatPrice(target2);
            tradeRR.textContent = riskReward === '--' ? '--' : riskReward + ':1';
        }
        
        // Update R:R styling
        const rrEl = document.getElementById('tradeRR');
        if (rrEl) {
            rrEl.className = 'ts-rr-value ' + (parseFloat(riskReward) >= 2 ? 'good' : parseFloat(riskReward) >= 1 ? 'ok' : 'bad');
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
     * Calculate LV (Liquidity Vacuum) Signal
     * Detects where liquidity is THIN - the path of least resistance
     * 
     * @param {Array} levels - Order book levels
     * @param {number} currentPrice - Current price
     * @returns {Object} { signal: 'buy'|'sell'|'flat', strength: 0-100, aboveLiq: number, belowLiq: number }
     */
    calculateLiquidityVacuum(levels, currentPrice) {
        if (!levels || levels.length === 0 || !currentPrice) {
            return { signal: 'flat', strength: 0, aboveLiq: 0, belowLiq: 0, ratio: 1 };
        }
        
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Calculate liquidity above and below price within a range (e.g., 2% from price)
        const RANGE_PERCENT = 2.0; // Look within 2% of current price
        const upperBound = currentPrice * (1 + RANGE_PERCENT / 100);
        const lowerBound = currentPrice * (1 - RANGE_PERCENT / 100);
        
        let liquidityAbove = 0;  // Ask/resistance liquidity
        let liquidityBelow = 0;  // Bid/support liquidity
        
        validLevels.forEach(level => {
            const price = parseFloat(level.price);
            const volume = parseFloat(level.volume);
            const distancePercent = Math.abs((price - currentPrice) / currentPrice) * 100;
            
            // Weight closer levels more heavily (exponential decay)
            const weight = Math.exp(-distancePercent / 1.5);
            const weightedVolume = volume * weight;
            
            const isAsk = (level.type === 'resistance') || (level.side === 'ask');
            const isBid = (level.type === 'support') || (level.side === 'bid');
            
            if (price > currentPrice && price <= upperBound && isAsk) {
                liquidityAbove += weightedVolume;
            } else if (price < currentPrice && price >= lowerBound && isBid) {
                liquidityBelow += weightedVolume;
            }
        });
        
        // Calculate vacuum ratio
        // If liquidityAbove is LOW compared to liquidityBelow, there's a vacuum above (BUY signal)
        // If liquidityBelow is LOW compared to liquidityAbove, there's a vacuum below (SELL signal)
        
        const total = liquidityAbove + liquidityBelow;
        if (total === 0) {
            return { signal: 'flat', strength: 0, aboveLiq: 0, belowLiq: 0, ratio: 1 };
        }
        
        const abovePercent = (liquidityAbove / total) * 100;
        const belowPercent = (liquidityBelow / total) * 100;
        
        // Ratio: >1 means more below (vacuum above = BUY), <1 means more above (vacuum below = SELL)
        const ratio = liquidityBelow / (liquidityAbove || 0.001);
        
        // Determine signal based on imbalance
        // Use configurable ratio threshold (default 1.22 = 55%)
        const ratioThreshold = this.lvRatioThreshold || 1.22;
        // Convert ratio to percentage: ratio / (1 + ratio) * 100
        const THRESHOLD = (ratioThreshold / (1 + ratioThreshold)) * 100;
        
        let signal = 'flat';
        let strength = 0;
        
        if (belowPercent >= THRESHOLD) {
            // More liquidity below = vacuum is ABOVE = price moves up easier = BUY
            signal = 'buy';
            strength = Math.min(100, Math.round((belowPercent - 50) * 2));
        } else if (abovePercent >= THRESHOLD) {
            // More liquidity above = vacuum is BELOW = price moves down easier = SELL
            signal = 'sell';
            strength = Math.min(100, Math.round((abovePercent - 50) * 2));
        } else {
            // Balanced liquidity = no clear vacuum
            signal = 'flat';
            strength = 0;
        }
        
        // Store for panel access
        this.lastLVSignal = { signal, strength, aboveLiq: liquidityAbove, belowLiq: liquidityBelow, ratio };
        
        return this.lastLVSignal;
    }
    
    /**
     * Calculate Alpha Lead Score (0-100)
     * LEADING indicator that predicts price movement direction
     * Unlike Alpha Score (lagging/confirmatory), this uses:
     * - Liquidity Vacuum (where is it thin?)
     * - LD/BPR momentum (rate of change)
     * - Gap asymmetry (room to run)
     * 
     * @param {Object} lv - Liquidity Vacuum result { signal, strength }
     * @param {Object} signals - Regime engine signals { ld_roc_z, bpr_roc, support_gap, resist_gap }
     * @returns {Object} { score: 0-100, signal: 'buy'|'sell'|'neutral', components }
     */
    calculateAlphaLead(lv, signals) {
        if (!lv || !signals) {
            return { score: 50, signal: 'neutral', components: {} };
        }
        
        // Component 1: LV (Liquidity Vacuum) - 30%
        // Where is liquidity THIN? That's the path of least resistance
        // lv.signal = 'buy' means vacuum above (price moves up easier)
        let lvNorm = 0.5;
        if (lv.signal === 'buy') {
            lvNorm = 0.5 + (lv.strength / 200); // 0.5 to 1.0
        } else if (lv.signal === 'sell') {
            lvNorm = 0.5 - (lv.strength / 200); // 0.0 to 0.5
        }
        
        // Component 2: LD Momentum (ld_roc_z) - 30%
        // Is buying pressure ACCELERATING? Positive = bullish momentum building
        // Z-score typically ranges -3 to +3, normalize to 0-1
        const ldRocZ = signals.ld_roc_z || 0;
        const ldMomNorm = Math.max(0, Math.min(1, (ldRocZ + 2) / 4)); // -2 to +2 maps to 0-1
        
        // Component 3: BPR Momentum (bpr_roc) - 20%
        // Is bid/ask ratio IMPROVING? Positive = bids strengthening
        // bpr_roc typically ranges -0.2 to +0.2
        const bprRoc = signals.bpr_roc || 0;
        const bprMomNorm = Math.max(0, Math.min(1, (bprRoc * 2.5 + 0.5))); // -0.2 to +0.2 maps to 0-1
        
        // Component 4: Gap Asymmetry - 20%
        // More room to run UP (larger resist_gap) = bullish
        // support_gap = distance to nearest support cluster (% from price)
        // resist_gap = distance to nearest resistance cluster (% from price)
        const supportGap = Math.abs(signals.support_gap || 0);
        const resistGap = Math.abs(signals.resist_gap || 0);
        const totalGap = supportGap + resistGap;
        let gapNorm = 0.5; // Default neutral
        if (totalGap > 0.001) { // Only calculate if we have meaningful gaps
            // More resist_gap means more room to run up = bullish
            gapNorm = resistGap / totalGap;
        }
        
        // Weighted combination
        const weights = {
            lv: 0.30,      // Liquidity Vacuum (path of least resistance)
            ldMom: 0.30,   // LD momentum (buying pressure acceleration)
            bprMom: 0.20,  // BPR momentum (bid strength improvement)
            gap: 0.20      // Gap asymmetry (room to run)
        };
        
        const alphaLeadRaw = (
            weights.lv * lvNorm +
            weights.ldMom * ldMomNorm +
            weights.bprMom * bprMomNorm +
            weights.gap * gapNorm
        );
        
        const score = Math.round(Math.max(0, Math.min(100, alphaLeadRaw * 100)));
        
        // Use configurable score threshold (default 10 means BUY at 60+, SELL at 40-)
        const scoreThreshold = this.alphaLeadScoreThreshold || 1;
        const buyThreshold = 50 + scoreThreshold;
        const sellThreshold = 50 - scoreThreshold;
        
        // Determine raw signal based on score
        let rawSignal = 'neutral';
        if (score >= buyThreshold) {
            rawSignal = 'buy';
        } else if (score <= sellThreshold) {
            rawSignal = 'sell';
        }
        
        // Stabilization: Require signal to sustain for configurable time before changing
        const now = Date.now();
        const confirmTime = this.alphaLeadConfirmTime || 10;
        const SIGNAL_LOCK_MS = confirmTime * 1000;
        
        // Initialize tracking
        if (!this._alphaLeadSignalState) {
            this._alphaLeadSignalState = {
                confirmedSignal: 'neutral',
                pendingSignal: null,
                pendingStartTime: null,
                lastChangeTime: 0
            };
        }
        
        const state = this._alphaLeadSignalState;
        let signal = state.confirmedSignal;
        
        // If confirmation time is 0, use raw signal directly (instant confirmation)
        if (SIGNAL_LOCK_MS === 0) {
            if (rawSignal !== state.confirmedSignal) {
                state.confirmedSignal = rawSignal;
                signal = rawSignal;
                console.log('[Alpha Lead] Instant signal:', signal.toUpperCase(), '| Score:', score);
            }
        } else {
            // Check if we need to change signal
            if (rawSignal !== state.confirmedSignal) {
                // New pending signal?
                if (rawSignal !== state.pendingSignal) {
                    // Start tracking this new signal
                    state.pendingSignal = rawSignal;
                    state.pendingStartTime = now;
                    console.log('[Alpha Lead] Pending:', rawSignal.toUpperCase(), '| Score:', score, 
                        '| Need', confirmTime + 's to confirm');
                } else {
                    // Same pending signal - check if it has sustained long enough
                    const sustainedMs = now - state.pendingStartTime;
                    if (sustainedMs >= SIGNAL_LOCK_MS) {
                        // Signal has sustained - confirm it
                        state.confirmedSignal = rawSignal;
                        state.lastChangeTime = now;
                        state.pendingSignal = null;
                        state.pendingStartTime = null;
                        signal = rawSignal;
                        
                        console.log('[Alpha Lead] Signal CONFIRMED:', signal.toUpperCase(), '| Score:', score,
                            '| Sustained for', Math.round(sustainedMs/1000) + 's');
                    }
                }
            } else {
                // Raw signal matches confirmed - clear pending
                if (state.pendingSignal) {
                    console.log('[Alpha Lead] Pending RESET - score returned to confirmed range');
                }
                state.pendingSignal = null;
                state.pendingStartTime = null;
            }
        }
        
        // Store for access
        this.lastAlphaLead = {
            score,
            signal, // Use stabilized signal
            rawSignal, // Include raw for debugging
            buyThreshold,
            sellThreshold,
            pendingSignal: state.pendingSignal,
            pendingStartTime: state.pendingStartTime,
            confirmTimeMs: SIGNAL_LOCK_MS,
            components: {
                lv: Math.round(lvNorm * 100),
                ldMom: Math.round(ldMomNorm * 100),
                bprMom: Math.round(bprMomNorm * 100),
                gap: Math.round(gapNorm * 100)
            },
            raw: {
                lvSignal: lv.signal,
                lvStrength: lv.strength,
                ldRocZ: ldRocZ,
                bprRoc: bprRoc,
                supportGap: supportGap,
                resistGap: resistGap
            }
        };
        
        return this.lastAlphaLead;
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
            return { label: 'FLAT', color: 'neutral', icon: '🟡' };
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
        
        // Update header badge with signal
        const mcsBadge = panel.querySelector('.panel-badge');
        if (mcsBadge) {
            mcsBadge.classList.remove('bullish', 'bearish', 'neutral');
            mcsBadge.textContent = mc.mcsInfo.label;
            mcsBadge.classList.add(mc.mcsInfo.color);
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
        
        // Store LD value for Alpha Strike panel
        this.lastLdValue = ld?.delta || 0;
        
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
     * Uses volume-weighted average distance for more meaningful gap analysis
     */
    calculateLiquidityStructure(levels, currentPrice) {
        const validLevels = levels.filter(l => parseFloat(l.price) > 0);
        
        // Get all supports and resistances (handle both type and side formats)
        const supports = validLevels
            .filter(l => {
                const isBid = l.type === 'support' || l.side === 'bid';
                return isBid && parseFloat(l.price) < currentPrice;
            })
            .map(l => ({ price: parseFloat(l.price), volume: parseFloat(l.volume) }));
            
        const resistances = validLevels
            .filter(l => {
                const isAsk = l.type === 'resistance' || l.side === 'ask';
                return isAsk && parseFloat(l.price) > currentPrice;
            })
            .map(l => ({ price: parseFloat(l.price), volume: parseFloat(l.volume) }));
        
        // Calculate volume-weighted average distance (VWAD)
        // This gives us a sense of where the "center of gravity" of liquidity is
        // rather than just the nearest level
        const totalSupportVol = supports.reduce((sum, s) => sum + s.volume, 0);
        const totalResistVol = resistances.reduce((sum, r) => sum + r.volume, 0);
        
        // VWAD for supports (how far away is the bulk of support?)
        let vwadSupport = currentPrice * 0.05; // Default 5% if no data
        if (totalSupportVol > 0) {
            const weightedSum = supports.reduce((sum, s) => {
                const dist = currentPrice - s.price;
                return sum + (dist * s.volume);
            }, 0);
            vwadSupport = weightedSum / totalSupportVol;
        }
        
        // VWAD for resistances (how far away is the bulk of resistance?)
        let vwadResist = currentPrice * 0.05; // Default 5% if no data
        if (totalResistVol > 0) {
            const weightedSum = resistances.reduce((sum, r) => {
                const dist = r.price - currentPrice;
                return sum + (dist * r.volume);
            }, 0);
            vwadResist = weightedSum / totalResistVol;
        }
        
        // Calculate gaps as percentage (VWAD / currentPrice)
        const supportGap = vwadSupport / currentPrice;
        const resistGap = vwadResist / currentPrice;
        
        // Find nearest for display purposes
        const sortedSupports = [...supports].sort((a, b) => b.price - a.price);
        const sortedResists = [...resistances].sort((a, b) => a.price - b.price);
        const nearestSupport = sortedSupports.length > 0 ? sortedSupports[0].price : currentPrice * 0.95;
        const nearestResist = sortedResists.length > 0 ? sortedResists[0].price : currentPrice * 1.05;
        
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
        
        // Update header badge with regime type
        const regimeStatusBadge = document.getElementById('regimeStatus');
        if (regimeStatusBadge) {
            regimeStatusBadge.classList.remove('bullish', 'bearish', 'neutral', 'live');
            const regimeText = regime.name.toUpperCase();
            regimeStatusBadge.textContent = regimeText;
            if (regime.type.includes('uptrend') || regime.type.includes('accumulation') || regime.type === 'expansion_up') {
                regimeStatusBadge.classList.add('bullish');
            } else if (regime.type.includes('downtrend') || regime.type.includes('distribution') || regime.type === 'expansion_down') {
                regimeStatusBadge.classList.add('bearish');
            } else {
                regimeStatusBadge.classList.add('neutral');
            }
        }
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

