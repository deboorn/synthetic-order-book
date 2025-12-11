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

        // Setup event listeners
        this.setupEventListeners();

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
            
            // Reset countdown timer
            this.updateBarCountdown();
            
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
        });
        
        document.getElementById('closeLegend').addEventListener('click', () => {
            document.getElementById('legendModal').classList.remove('open');
        });
        
        document.querySelector('#legendModal .modal-backdrop').addEventListener('click', () => {
            document.getElementById('legendModal').classList.remove('open');
        });

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
        });
        
        document.querySelector('#settingsModal .modal-backdrop').addEventListener('click', () => {
            document.getElementById('settingsModal').classList.remove('open');
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
            }
        });
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
    }

    // Load settings from localStorage
    loadSettings() {
        const defaults = {
            clusterPct: 0.15,
            maxLevels: 500,      // Max levels
            minVolume: 15,       // 15 BTC minimum
            priceRange: 100,     // Default 100% to show full picture
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
            if (typeof directionAnalysis !== 'undefined' && this.levels.length > 0) {
                directionAnalysis.update(this.levels, price, this.currentSymbol);
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
        const modeButtons = document.querySelectorAll('.regime-mode-btn');
        
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
                // Update button states
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
        
        // Choose data source based on toggle
        const analyticsLevels = this.useFullBookForAnalytics 
            ? (this.fullBookLevels.length ? this.fullBookLevels : this.levels)
            : this.levels;
        
        // Update Order Flow indicators (BPR, LD, OBIC, Alpha Score, Regime Engine)
        this.chart.setOrderFlowLevels(analyticsLevels, this.currentPrice);
        
        // Update Price Forecast (directional analysis)
        if (typeof directionAnalysis !== 'undefined') {
            directionAnalysis.update(analyticsLevels, this.currentPrice, this.currentSymbol);
            this.updateProjections();
        }
        
        // Log data source for debugging
        const source = this.useFullBookForAnalytics ? 'Full Book' : 'Visible Only';
        const levelCount = analyticsLevels.length;
        console.log(`[Analytics] Using ${source}: ${levelCount} levels`);
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
            const imbalance = ((totalBid - totalAsk) / total * 100).toFixed(1);
            const imbalanceEl = this.elements.imbalance;
            imbalanceEl.textContent = (imbalance > 0 ? '+' : '') + imbalance + '%';
            imbalanceEl.className = 'stat-value ' + (imbalance > 0 ? 'bid' : 'ask');
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

