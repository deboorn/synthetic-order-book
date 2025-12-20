/**
 * Trade Panel - Simulated Trading based on Live Signals
 * 
 * Supports simulation mode and live Coinbase perpetual futures trading.
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

class TradePanel {
    constructor(app, instanceId = '1') {
        this.app = app;
        this.instanceId = instanceId;
        this.currentSymbol = app?.currentSymbol || localStorage.getItem('selectedSymbol') || 'BTC';
        this.storagePrefix = `tradeSim${instanceId}_${this.currentSymbol}`;
        
        // State
        this.isRunning = false;
        this.position = null; // null, 'long', or 'short'
        this.entryPrice = null;
        this.entryTime = null;
        this.openPositionContracts = null; // Actual contracts in open position (may differ from config on partial fills)
        
        // Signal tracking for debounce
        this.lastSignalDirection = null;
        this.signalStartTime = null;
        this.signalConfirmed = false;
        
        // Persistent signal state - remains until opposing signal meets threshold
        this.lockedSignal = null; // 'buy' or 'sell' - persists until opposing signal confirmed
        
        // Open trade tracking
        this.openTradeId = null;
        
        // Config
        this.signalSource = 'l-drift'; // 'l-drift' or 'l-prox'
        this.threshold = 5.0; // seconds
        this.tradeMode = 'both'; // 'both', 'long', 'short'
        
        // Trading mode config (NEW)
        this.tradingMode = 'simulation'; // 'simulation' or 'perp-live'
        this.contracts = 1;              // Number of contracts per trade
        this.orderTimeout = 10;          // Seconds to wait for limit order fill
        this.leverage = 3.3;             // Default leverage
        this.maxLoss = 100;              // Max cumulative loss in USD
        this.maxLossTriggered = false;   // Flag when max loss is hit
        
        // Max trades limiter (for dev/testing)
        this.limitMaxTrades = false;     // Enable/disable max trades limit
        this.maxTrades = 1;              // Max number of complete trades
        this.maxTradesTriggered = false; // Flag when max trades is hit
        
        // Only close in profit option
        this.onlyCloseInProfit = false;
        this.minProfitThreshold = 0.10;   // Minimum profit % required (default 0.10% for trading fees)
        this.fundingRatePerHour = 0.02;   // Funding rate % per hour (default 0.02%)
        
        // Take profit option
        this.takeProfitEnabled = false;
        this.takeProfitThreshold = null;   // Default blank - must be set to trigger
        this.takeProfitWaitNextBar = false; // Wait for next bar before re-entry after TP
        
        // Guard flag to prevent re-entry during async close
        this.isClosingPosition = false;
        
        // Take profit wait-for-next-bar guard
        this.waitingForNextBar = false;
        this._newBarHandler = null; // Bound handler for cleanup
        
        // Coinbase API instance (for perp modes)
        this.coinbaseApi = null;
        
        // Coinbase WebSocket for real-time order updates
        this.coinbaseWs = null;
        this.coinbaseStatus = 'disconnected'; // disconnected, connecting, ready, ordering, error
        this.useWebSocket = true; // Toggle WebSocket vs REST polling
        
        // Real-time balance from WebSocket
        this.liveBalanceSummary = null;
        
        // Trade history
        this.trades = [];
        this.totalPnl = 0;
        this.shortPnl = 0;
        this.longPnl = 0;
        this.wins = 0;
        this.losses = 0;
        
        // Session metrics
        this.sessionStartTime = null;    // When trading session started
        this.peakProfit = 0;             // Max profit during session
        this.peakLoss = 0;               // Max loss during session (stored as positive)
        
        // DOM Elements
        this.elements = {};
        
        // Update interval
        this.updateInterval = null;
        
        this.init();
    }
    
    init() {
        this.cacheElements();
        this.loadState();
        this.bindEvents();
        this.render();
        this.setupNewBarListener();
    }
    
    /**
     * Listen for newBarOpened events to clear take-profit wait guard
     */
    setupNewBarListener() {
        this._newBarHandler = () => {
            if (this.waitingForNextBar) {
                console.log(`[TradePanel ${this.instanceId}] New bar - clearing TP wait guard`);
                this.waitingForNextBar = false;
            }
        };
        window.addEventListener('newBarOpened', this._newBarHandler);
    }
    
    cacheElements() {
        const id = this.instanceId;
        this.elements = {
            status: document.getElementById(`tradeSim${id}Status`),
            signalSelect: document.getElementById(`tradeSim${id}Signal`),
            thresholdInput: document.getElementById(`tradeSim${id}Threshold`),
            modeSelect: document.getElementById(`tradeSim${id}Mode`),
            // Perp trading elements (NEW)
            tradingModeSelect: document.getElementById(`tradeSim${id}TradingMode`),
            perpConfig: document.getElementById(`tradeSim${id}PerpConfig`),
            contractsInput: document.getElementById(`tradeSim${id}Contracts`),
            orderTimeoutInput: document.getElementById(`tradeSim${id}OrderTimeout`),
            leverageInput: document.getElementById(`tradeSim${id}Leverage`),
            maxLossInput: document.getElementById(`tradeSim${id}MaxLoss`),
            // Order progress display
            orderProgress: document.getElementById(`tradeSim${id}OrderProgress`),
            orderProgressText: document.getElementById(`tradeSim${id}OrderProgressText`),
            orderProgressCount: document.getElementById(`tradeSim${id}OrderProgressCount`),
            // Max trades limiter
            limitMaxTradesCheckbox: document.getElementById(`tradeSim${id}LimitMaxTrades`),
            maxTradesInput: document.getElementById(`tradeSim${id}MaxTrades`),
            // Only close in profit
            onlyCloseInProfitCheckbox: document.getElementById(`tradeSim${id}OnlyCloseInProfit`),
            minProfitInput: document.getElementById(`tradeSim${id}MinProfitThreshold`),
            fundingRateInput: document.getElementById(`tradeSim${id}FundingRatePerHour`),
            minProfitInputRow: document.getElementById(`tradeSim${id}MinProfitThreshold`)?.closest('.min-profit-input-row'),
            // Take profit
            takeProfitCheckbox: document.getElementById(`tradeSim${id}TakeProfitEnabled`),
            takeProfitInput: document.getElementById(`tradeSim${id}TakeProfitThreshold`),
            takeProfitInputRow: document.getElementById(`tradeSim${id}TakeProfitThreshold`)?.closest('.take-profit-input-row'),
            takeProfitWaitCheckbox: document.getElementById(`tradeSim${id}TakeProfitWaitNextBar`),
            takeProfitWaitRow: document.getElementById(`tradeSim${id}TakeProfitWaitNextBar`)?.closest('.take-profit-wait-row'),
            // Control buttons
            startBtn: document.getElementById(`tradeSim${id}Start`),
            stopBtn: document.getElementById(`tradeSim${id}Stop`),
            clearBtn: document.getElementById(`tradeSim${id}Clear`),
            exportBtn: document.getElementById(`tradeSim${id}Export`),
            lockedSignal: document.getElementById(`tradeSim${id}LockedSignal`),
            positionValue: document.getElementById(`tradeSim${id}PositionValue`),
            entryPrice: document.getElementById(`tradeSim${id}EntryPrice`),
            minProfitRequired: document.getElementById(`tradeSim${id}MinProfitRequired`),
            pnl: document.getElementById(`tradeSim${id}Pnl`),
            shortPnl: document.getElementById(`tradeSim${id}ShortPnl`),
            longPnl: document.getElementById(`tradeSim${id}LongPnl`),
            // Session metrics
            peakProfit: document.getElementById(`tradeSim${id}PeakProfit`),
            peakLoss: document.getElementById(`tradeSim${id}PeakLoss`),
            sessionTime: document.getElementById(`tradeSim${id}SessionTime`),
            avgTradeLength: document.getElementById(`tradeSim${id}AvgTradeLength`),
            pnl30min: document.getElementById(`tradeSim${id}Pnl30min`),
            pnl60min: document.getElementById(`tradeSim${id}Pnl60min`),
            wins: document.getElementById(`tradeSim${id}Wins`),
            losses: document.getElementById(`tradeSim${id}Losses`),
            log: document.getElementById(`tradeSim${id}Log`),
            // Coinbase status indicator
            coinbaseStatus: document.getElementById(`tradeSim${id}CoinbaseStatus`),
            coinbaseStatusText: document.getElementById(`tradeSim${id}CoinbaseStatusText`),
            coinbaseBalance: document.getElementById(`tradeSim${id}CoinbaseBalance`)
        };
    }
    
    loadState() {
        // Migrate old localStorage keys for first instance (backward compatibility)
        if (this.instanceId === '1') {
            this.migrateOldStorage();
        }
        
        // Load config
        const savedSignal = localStorage.getItem(`${this.storagePrefix}Signal`);
        if (savedSignal) {
            this.signalSource = savedSignal;
            if (this.elements.signalSelect) {
                this.elements.signalSelect.value = savedSignal;
            }
        }
        
        const savedThreshold = localStorage.getItem(`${this.storagePrefix}Threshold`);
        if (savedThreshold) {
            this.threshold = parseFloat(savedThreshold);
            if (this.elements.thresholdInput) {
                this.elements.thresholdInput.value = this.threshold;
            }
        }
        
        const savedMode = localStorage.getItem(`${this.storagePrefix}Mode`);
        if (savedMode) {
            this.tradeMode = savedMode;
            if (this.elements.modeSelect) {
                this.elements.modeSelect.value = savedMode;
            }
        }
        
        // Load trading mode (perp config)
        const savedTradingMode = localStorage.getItem(`${this.storagePrefix}TradingMode`);
        if (savedTradingMode) {
            this.tradingMode = savedTradingMode;
            if (this.elements.tradingModeSelect) {
                this.elements.tradingModeSelect.value = savedTradingMode;
            }
        }
        
        const savedContracts = localStorage.getItem(`${this.storagePrefix}Contracts`);
        if (savedContracts) {
            this.contracts = parseInt(savedContracts);
            if (this.elements.contractsInput) {
                this.elements.contractsInput.value = this.contracts;
            }
        }
        
        const savedOrderTimeout = localStorage.getItem(`${this.storagePrefix}OrderTimeout`);
        if (savedOrderTimeout) {
            this.orderTimeout = parseInt(savedOrderTimeout);
            if (this.elements.orderTimeoutInput) {
                this.elements.orderTimeoutInput.value = this.orderTimeout;
            }
        }
        
        const savedLeverage = localStorage.getItem(`${this.storagePrefix}Leverage`);
        if (savedLeverage) {
            this.leverage = parseFloat(savedLeverage);
            if (this.elements.leverageInput) {
                this.elements.leverageInput.value = this.leverage;
            }
        }
        
        const savedMaxLoss = localStorage.getItem(`${this.storagePrefix}MaxLoss`);
        if (savedMaxLoss) {
            this.maxLoss = parseFloat(savedMaxLoss);
            if (this.elements.maxLossInput) {
                this.elements.maxLossInput.value = this.maxLoss;
            }
        }
        
        // Load max trades limiter settings
        const savedLimitMaxTrades = localStorage.getItem(`${this.storagePrefix}LimitMaxTrades`);
        if (savedLimitMaxTrades !== null) {
            this.limitMaxTrades = savedLimitMaxTrades === 'true';
            if (this.elements.limitMaxTradesCheckbox) {
                this.elements.limitMaxTradesCheckbox.checked = this.limitMaxTrades;
            }
        }
        
        const savedMaxTrades = localStorage.getItem(`${this.storagePrefix}MaxTrades`);
        if (savedMaxTrades) {
            this.maxTrades = parseInt(savedMaxTrades);
            if (this.elements.maxTradesInput) {
                this.elements.maxTradesInput.value = this.maxTrades;
            }
        }
        this.updateMaxTradesInputVisibility();
        
        // Load only close in profit setting
        const savedOnlyCloseInProfit = localStorage.getItem(`${this.storagePrefix}OnlyCloseInProfit`);
        if (savedOnlyCloseInProfit !== null) {
            this.onlyCloseInProfit = savedOnlyCloseInProfit === 'true';
            if (this.elements.onlyCloseInProfitCheckbox) {
                this.elements.onlyCloseInProfitCheckbox.checked = this.onlyCloseInProfit;
            }
        }
        const savedMinProfitThreshold = localStorage.getItem(`${this.storagePrefix}MinProfitThreshold`);
        if (savedMinProfitThreshold && savedMinProfitThreshold !== 'null' && savedMinProfitThreshold !== '') {
            const val = parseFloat(savedMinProfitThreshold);
            this.minProfitThreshold = (!isNaN(val) && val >= 0) ? val : 0.10;
        }
        if (this.elements.minProfitInput) {
            this.elements.minProfitInput.value = this.minProfitThreshold;
        }
        
        const savedFundingRate = localStorage.getItem(`${this.storagePrefix}FundingRatePerHour`);
        if (savedFundingRate && savedFundingRate !== 'null' && savedFundingRate !== '') {
            const val = parseFloat(savedFundingRate);
            this.fundingRatePerHour = (!isNaN(val) && val >= 0) ? val : 0.02;
        }
        if (this.elements.fundingRateInput) {
            this.elements.fundingRateInput.value = this.fundingRatePerHour;
        }
        this.updateMinProfitInputVisibility();
        
        // Load take profit settings
        const savedTakeProfitEnabled = localStorage.getItem(`${this.storagePrefix}TakeProfitEnabled`);
        if (savedTakeProfitEnabled !== null) {
            this.takeProfitEnabled = savedTakeProfitEnabled === 'true';
            if (this.elements.takeProfitCheckbox) {
                this.elements.takeProfitCheckbox.checked = this.takeProfitEnabled;
            }
        }
        const savedTakeProfitThreshold = localStorage.getItem(`${this.storagePrefix}TakeProfitThreshold`);
        if (savedTakeProfitThreshold && savedTakeProfitThreshold !== 'null') {
            const val = parseFloat(savedTakeProfitThreshold);
            this.takeProfitThreshold = (!isNaN(val) && val > 0) ? val : null;
            if (this.elements.takeProfitInput) {
                this.elements.takeProfitInput.value = this.takeProfitThreshold ?? '';
            }
        }
        const savedTakeProfitWaitNextBar = localStorage.getItem(`${this.storagePrefix}TakeProfitWaitNextBar`);
        if (savedTakeProfitWaitNextBar !== null) {
            this.takeProfitWaitNextBar = savedTakeProfitWaitNextBar === 'true';
            if (this.elements.takeProfitWaitCheckbox) {
                this.elements.takeProfitWaitCheckbox.checked = this.takeProfitWaitNextBar;
            }
        }
        this.updateTakeProfitInputVisibility();
        
        // Update perp config visibility
        this.updatePerpConfigVisibility();
        
        // Load trade history from IndexedDB (async)
        this.loadTradesFromDB();
        
        // Load and restore active position state
        const activeState = this.loadActivePosition();
        if (activeState) {
            this.position = activeState.position;
            this.entryPrice = activeState.entryPrice;
            this.entryTime = activeState.entryTime;
            this.openTradeId = activeState.openTradeId;
            this.lockedSignal = activeState.lockedSignal;
            this.lastSignalDirection = activeState.lastSignalDirection;
            this.signalStartTime = activeState.signalStartTime;
            this.signalConfirmed = activeState.signalConfirmed;
            
            // Restore perp mode state
            if (activeState.tradingMode) {
                this.tradingMode = activeState.tradingMode;
                if (this.elements.tradingModeSelect) {
                    this.elements.tradingModeSelect.value = activeState.tradingMode;
                }
            }
            if (activeState.contracts) this.contracts = activeState.contracts;
            if (activeState.leverage) this.leverage = activeState.leverage;
            if (activeState.maxLoss) this.maxLoss = activeState.maxLoss;
            if (activeState.maxLossTriggered) this.maxLossTriggered = activeState.maxLossTriggered;
            
            // Restore max trades limiter state
            if (activeState.limitMaxTrades !== undefined) this.limitMaxTrades = activeState.limitMaxTrades;
            if (activeState.maxTrades) this.maxTrades = activeState.maxTrades;
            if (activeState.maxTradesTriggered) this.maxTradesTriggered = activeState.maxTradesTriggered;
            
            // Restore session metrics
            if (activeState.sessionStartTime) this.sessionStartTime = activeState.sessionStartTime;
            if (activeState.peakProfit) this.peakProfit = activeState.peakProfit;
            if (activeState.peakLoss) this.peakLoss = activeState.peakLoss;
            
            // Auto-resume if simulator was running
            if (activeState.isRunning) {
                // Defer start until after DOM is ready
                setTimeout(() => this.resumeFromSavedState(), 100);
            }
        }
    }
    
    /**
     * Resume simulator from saved state (after page refresh)
     */
    async resumeFromSavedState() {
        if (this.isRunning) return; // Already running
        
        // For perp modes, reinitialize API and sync with Coinbase
        if (this.isPerpMode()) {
            try {
                await this.initCoinbaseApi();
                await this.syncWithCoinbase();
            } catch (error) {
                console.error('[TradePanel] Failed to resume perp mode:', error);
                alert(`Failed to resume ${this.tradingMode}: ${error.message}`);
                this.clearActivePosition();
                return;
            }
        }
        
        this.isRunning = true;
        
        // Update UI to running state
        if (this.elements.startBtn) this.elements.startBtn.disabled = true;
        if (this.elements.stopBtn) this.elements.stopBtn.disabled = false;
        if (this.elements.signalSelect) this.elements.signalSelect.disabled = true;
        // Threshold can be adjusted during trading
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = true;
        if (this.elements.tradingModeSelect) this.elements.tradingModeSelect.disabled = true;
        
        // Lock contracts, leverage, and timeout for perp modes
        if (this.isPerpMode()) {
            if (this.elements.contractsInput) this.elements.contractsInput.disabled = true;
            if (this.elements.orderTimeoutInput) this.elements.orderTimeoutInput.disabled = true;
            if (this.elements.leverageInput) this.elements.leverageInput.disabled = true;
        }
        
        if (this.elements.status) {
            this.elements.status.textContent = this.isPerpMode() ? 
                (this.tradingMode === 'perp-live' ? 'LIVE' : 'SANDBOX') : 'Running';
            this.elements.status.classList.add('running');
            if (this.tradingMode === 'perp-live') {
                this.elements.status.classList.add('live-mode');
            }
        }
        
        // Render current state
        this.renderLockedSignal();
        this.renderPosition();
        this.renderLog();
        
        // Start polling (clear any existing interval first to prevent stacking)
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.updateInterval = setInterval(() => this.checkSignal(), 100);
        
        const modeInfo = this.isPerpMode() ? this.tradingMode : 'simulation';
        console.log('[TradePanel] Resumed from saved state -', modeInfo, 'position:', this.position || 'none', 'lockedSignal:', this.lockedSignal || 'none');
    }
    
    /**
     * Sync local state with Coinbase position (for resume after page refresh)
     */
    async syncWithCoinbase() {
        if (!this.coinbaseApi) return;
        
        const productId = this.getProductId();
        const actualPosition = await this.coinbaseApi.getPosition(productId);
        
        if (this.position && !actualPosition) {
            // Local shows position, Coinbase has none (closed/liquidated externally)
            console.warn('[TradePanel] Position desync: local has position, Coinbase has none');
            this.handlePositionDesync('Position closed externally');
        } else if (!this.position && actualPosition) {
            // Coinbase has position we don't know about
            console.warn('[TradePanel] External position detected on Coinbase');
            // Just warn, don't adopt the position
        } else if (this.position && actualPosition) {
            // Both have position - verify direction matches
            if (this.position !== actualPosition.side) {
                console.warn('[TradePanel] Position direction mismatch');
                this.handlePositionDesync('Position direction mismatch');
            }
        }
        // If both null, we're in sync - continue normally
    }
    
    /**
     * Handle position desync between local and Coinbase state
     */
    handlePositionDesync(reason) {
        console.log('[TradePanel] Handling desync:', reason);
        
        // Close local position with the desync reason
        if (this.position) {
            // Find open trade and close it
            const openTrade = this.trades.find(t => t.id === this.openTradeId);
            if (openTrade) {
                const exitPrice = this.app?.currentPrice || openTrade.entryPrice;
                let pnl;
                if (openTrade.type === 'long') {
                    pnl = exitPrice - openTrade.entryPrice;
                } else {
                    pnl = openTrade.entryPrice - exitPrice;
                }
                
                openTrade.exitPrice = exitPrice;
                openTrade.pnl = pnl;
                openTrade.exitTime = Date.now();
                openTrade.isOpen = false;
                openTrade.closeReason = reason;
            }
            
            this.position = null;
            this.entryPrice = null;
            this.entryTime = null;
            this.openTradeId = null;
            this.openPositionContracts = null;
            
            this.recalculateStats();
            this.saveState();
        }
    }
    
    migrateOldStorage() {
        // Migrate from old 'tradeSim*' keys to new 'tradeSim1*' keys
        const oldKeys = ['tradeSimSignal', 'tradeSimThreshold', 'tradeSimMode', 'tradeSimTrades'];
        const newKeys = ['tradeSim1Signal', 'tradeSim1Threshold', 'tradeSim1Mode', 'tradeSim1Trades'];
        
        for (let i = 0; i < oldKeys.length; i++) {
            const oldValue = localStorage.getItem(oldKeys[i]);
            if (oldValue && !localStorage.getItem(newKeys[i])) {
                localStorage.setItem(newKeys[i], oldValue);
                localStorage.removeItem(oldKeys[i]);
            }
        }
    }
    
    saveState() {
        localStorage.setItem(`${this.storagePrefix}Signal`, this.signalSource);
        localStorage.setItem(`${this.storagePrefix}Threshold`, this.threshold.toString());
        localStorage.setItem(`${this.storagePrefix}Mode`, this.tradeMode);
        // Save perp config
        localStorage.setItem(`${this.storagePrefix}TradingMode`, this.tradingMode);
        localStorage.setItem(`${this.storagePrefix}Contracts`, this.contracts.toString());
        localStorage.setItem(`${this.storagePrefix}OrderTimeout`, this.orderTimeout.toString());
        localStorage.setItem(`${this.storagePrefix}Leverage`, this.leverage.toString());
        localStorage.setItem(`${this.storagePrefix}MaxLoss`, this.maxLoss.toString());
        // Save max trades limiter
        localStorage.setItem(`${this.storagePrefix}LimitMaxTrades`, this.limitMaxTrades.toString());
        localStorage.setItem(`${this.storagePrefix}MaxTrades`, this.maxTrades.toString());
        // Save only close in profit setting
        localStorage.setItem(`${this.storagePrefix}OnlyCloseInProfit`, this.onlyCloseInProfit.toString());
        localStorage.setItem(`${this.storagePrefix}MinProfitThreshold`, this.minProfitThreshold.toString());
        localStorage.setItem(`${this.storagePrefix}FundingRatePerHour`, this.fundingRatePerHour.toString());
        // Save take profit settings
        localStorage.setItem(`${this.storagePrefix}TakeProfitEnabled`, this.takeProfitEnabled.toString());
        localStorage.setItem(`${this.storagePrefix}TakeProfitThreshold`, this.takeProfitThreshold !== null ? this.takeProfitThreshold.toString() : '');
        localStorage.setItem(`${this.storagePrefix}TakeProfitWaitNextBar`, this.takeProfitWaitNextBar.toString());
        // Save all trades to IndexedDB (async, fire-and-forget)
        this.saveTradesToDB();
    }
    
    /**
     * Save trades to IndexedDB
     */
    async saveTradesToDB() {
        try {
            await db.saveTradePanelTrades(this.instanceId, this.trades);
        } catch (e) {
            console.warn(`[TradePanel ${this.instanceId}] Failed to save trades to IndexedDB:`, e);
        }
    }
    
    /**
     * Load trades from IndexedDB
     */
    async loadTradesFromDB() {
        try {
            const trades = await db.getTradePanelTrades(this.instanceId);
            if (trades && trades.length > 0) {
                this.trades = trades;
                this.recalculateStats();
                this.renderLog();
                this.renderSummary();
                console.log(`[TradePanel ${this.instanceId}] Loaded ${trades.length} trades from IndexedDB`);
            }
        } catch (e) {
            console.warn(`[TradePanel ${this.instanceId}] Failed to load trades from IndexedDB:`, e);
            this.trades = [];
        }
    }
    
    /**
     * Save active position state for persistence across page refresh
     */
    saveActivePosition() {
        const activeState = {
            isRunning: this.isRunning,
            position: this.position,
            entryPrice: this.entryPrice,
            entryTime: this.entryTime,
            openTradeId: this.openTradeId,
            lockedSignal: this.lockedSignal,
            lastSignalDirection: this.lastSignalDirection,
            signalStartTime: this.signalStartTime,
            signalConfirmed: this.signalConfirmed,
            // Perp mode state
            tradingMode: this.tradingMode,
            contracts: this.contracts,
            leverage: this.leverage,
            maxLoss: this.maxLoss,
            maxLossTriggered: this.maxLossTriggered,
            // Max trades limiter state
            limitMaxTrades: this.limitMaxTrades,
            maxTrades: this.maxTrades,
            maxTradesTriggered: this.maxTradesTriggered,
            // Session metrics
            sessionStartTime: this.sessionStartTime,
            peakProfit: this.peakProfit,
            peakLoss: this.peakLoss
        };
        localStorage.setItem(`${this.storagePrefix}ActivePosition`, JSON.stringify(activeState));
    }
    
    /**
     * Load active position state from localStorage
     */
    loadActivePosition() {
        const saved = localStorage.getItem(`${this.storagePrefix}ActivePosition`);
        if (!saved) return null;
        
        try {
            return JSON.parse(saved);
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Clear active position state from localStorage
     */
    clearActivePosition() {
        localStorage.removeItem(`${this.storagePrefix}ActivePosition`);
    }
    
    bindEvents() {
        // Signal source change
        if (this.elements.signalSelect) {
            this.elements.signalSelect.addEventListener('change', (e) => {
                this.signalSource = e.target.value;
                this.saveState();
            });
        }
        
        // Threshold change
        if (this.elements.thresholdInput) {
            this.elements.thresholdInput.addEventListener('change', (e) => {
                this.threshold = parseFloat(e.target.value) || 5.0;
                if (this.threshold < 0.1) this.threshold = 0.1;
                if (this.threshold > 60) this.threshold = 60;
                e.target.value = this.threshold;
                this.saveState();
            });
        }
        
        // Trade mode change
        if (this.elements.modeSelect) {
            this.elements.modeSelect.addEventListener('change', (e) => {
                this.tradeMode = e.target.value;
                this.saveState();
            });
        }
        
        // Trading mode change (simulation/perp-live)
        if (this.elements.tradingModeSelect) {
            this.elements.tradingModeSelect.addEventListener('change', (e) => {
                this.tradingMode = e.target.value;
                this.updatePerpConfigVisibility();
                this.saveState();
            });
        }
        
        // Contracts change
        if (this.elements.contractsInput) {
            this.elements.contractsInput.addEventListener('change', (e) => {
                this.contracts = Math.max(1, parseInt(e.target.value) || 1);
                e.target.value = this.contracts;
                this.saveState();
            });
        }
        
        // Order timeout change
        if (this.elements.orderTimeoutInput) {
            this.elements.orderTimeoutInput.addEventListener('change', (e) => {
                this.orderTimeout = Math.min(60, Math.max(1, parseInt(e.target.value) || 10));
                e.target.value = this.orderTimeout;
                localStorage.setItem(`${this.storagePrefix}OrderTimeout`, this.orderTimeout);
            });
        }
        
        // Leverage change
        if (this.elements.leverageInput) {
            this.elements.leverageInput.addEventListener('change', (e) => {
                this.leverage = Math.min(10, Math.max(1, parseFloat(e.target.value) || 3.3));
                e.target.value = this.leverage;
                this.saveState();
            });
        }
        
        // Max loss change (can be changed during trading)
        if (this.elements.maxLossInput) {
            this.elements.maxLossInput.addEventListener('change', (e) => {
                this.maxLoss = Math.max(1, parseFloat(e.target.value) || 100);
                e.target.value = this.maxLoss;
                this.saveState();
                // Reset max loss trigger if we increased the limit
                if (this.maxLossTriggered && this.totalPnl > -this.maxLoss) {
                    this.maxLossTriggered = false;
                }
            });
        }
        
        // Max trades limiter checkbox
        if (this.elements.limitMaxTradesCheckbox) {
            this.elements.limitMaxTradesCheckbox.addEventListener('change', (e) => {
                this.limitMaxTrades = e.target.checked;
                this.updateMaxTradesInputVisibility();
                this.saveState();
                // Reset max trades trigger if we disabled the limit
                if (!this.limitMaxTrades) {
                    this.maxTradesTriggered = false;
                }
            });
        }
        
        // Max trades input
        if (this.elements.maxTradesInput) {
            this.elements.maxTradesInput.addEventListener('change', (e) => {
                this.maxTrades = Math.max(1, parseInt(e.target.value) || 1);
                e.target.value = this.maxTrades;
                this.saveState();
                // Reset trigger if we increased the limit
                const completedTrades = this.wins + this.losses;
                if (this.maxTradesTriggered && completedTrades < this.maxTrades) {
                    this.maxTradesTriggered = false;
                }
            });
        }
        
        // Only close in profit checkbox
        if (this.elements.onlyCloseInProfitCheckbox) {
            this.elements.onlyCloseInProfitCheckbox.addEventListener('change', (e) => {
                this.onlyCloseInProfit = e.target.checked;
                this.updateMinProfitInputVisibility();
                this.saveState();
            });
        }
        
        // Min profit threshold input
        if (this.elements.minProfitInput) {
            this.elements.minProfitInput.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value);
                this.minProfitThreshold = (!isNaN(val) && val >= 0) ? val : 0.10;
                e.target.value = this.minProfitThreshold;
                this.saveState();
                this.renderLog();
                this.renderPosition();
            });
        }
        
        // Funding rate per hour input
        if (this.elements.fundingRateInput) {
            this.elements.fundingRateInput.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value);
                this.fundingRatePerHour = (!isNaN(val) && val >= 0) ? val : 0.02;
                e.target.value = this.fundingRatePerHour;
                this.saveState();
                this.renderLog();
                this.renderPosition();
            });
        }
        
        // Take profit checkbox
        if (this.elements.takeProfitCheckbox) {
            this.elements.takeProfitCheckbox.addEventListener('change', (e) => {
                this.takeProfitEnabled = e.target.checked;
                this.updateTakeProfitInputVisibility();
                this.saveState();
            });
        }
        
        // Take profit threshold input
        if (this.elements.takeProfitInput) {
            this.elements.takeProfitInput.addEventListener('change', (e) => {
                const val = parseFloat(e.target.value);
                this.takeProfitThreshold = (!isNaN(val) && val > 0) ? val : null;
                e.target.value = this.takeProfitThreshold ?? '';
                this.saveState();
            });
        }
        
        // Take profit wait next bar checkbox
        if (this.elements.takeProfitWaitCheckbox) {
            this.elements.takeProfitWaitCheckbox.addEventListener('change', (e) => {
                this.takeProfitWaitNextBar = e.target.checked;
                this.saveState();
            });
        }
        
        // Start button
        if (this.elements.startBtn) {
            this.elements.startBtn.addEventListener('click', () => this.start());
        }
        
        // Stop button
        if (this.elements.stopBtn) {
            this.elements.stopBtn.addEventListener('click', () => this.stop());
        }
        
        // Clear button
        if (this.elements.clearBtn) {
            this.elements.clearBtn.addEventListener('click', () => this.clear());
        }
        
        // Export button
        if (this.elements.exportBtn) {
            this.elements.exportBtn.addEventListener('click', () => this.exportTrades());
        }
    }
    
    /**
     * Show/hide perp config section based on trading mode
     */
    updatePerpConfigVisibility() {
        if (!this.elements.perpConfig) return;
        
        const isPerpMode = this.tradingMode === 'perp-live';
        this.elements.perpConfig.style.display = isPerpMode ? 'block' : 'none';
        
        // Update panel styling to indicate mode
        const panel = document.getElementById(`tradeSim${this.instanceId}Panel`);
        if (panel) {
            panel.classList.remove('mode-simulation', 'mode-perp-live');
            panel.classList.add(`mode-${this.tradingMode}`);
        }
    }
    
    /**
     * Show/hide max trades input based on checkbox
     */
    updateMaxTradesInputVisibility() {
        if (this.elements.maxTradesInput) {
            this.elements.maxTradesInput.style.display = this.limitMaxTrades ? 'inline-block' : 'none';
        }
    }
    
    /**
     * Show/hide take profit input row and wait checkbox based on checkbox
     */
    updateTakeProfitInputVisibility() {
        const show = this.takeProfitEnabled ? 'block' : 'none';
        if (this.elements.takeProfitInputRow) {
            this.elements.takeProfitInputRow.style.display = show;
        }
        if (this.elements.takeProfitWaitRow) {
            this.elements.takeProfitWaitRow.style.display = show;
        }
    }
    
    updateMinProfitInputVisibility() {
        if (this.elements.minProfitInputRow) {
            this.elements.minProfitInputRow.style.display = this.onlyCloseInProfit ? 'block' : 'none';
        }
    }
    
    /**
     * Check if perp mode (live trading)
     */
    isPerpMode() {
        return this.tradingMode === 'perp-live';
    }
    
    /**
     * Get product ID for Coinbase API
     */
    getProductId() {
        // Coinbase US perpetual futures product IDs
        // Format: {PREFIX}-{EXPIRY}-CDE (e.g., BIP-20DEC30-CDE for BTC, ETP-20DEC30-CDE for ETH)
        const perpProductIds = {
            'BTC': 'BIP-20DEC30-CDE',
            'ETH': 'ETP-20DEC30-CDE'
        };
        
        const productId = perpProductIds[this.currentSymbol];
        if (!productId) {
            console.warn(`[TradePanel] No perpetual product ID mapped for ${this.currentSymbol}`);
            return null;
        }
        return productId;
    }
    
    /**
     * Get price increment for current product
     * BTC perps: $5 increments
     * ETH perps: $1 increments
     */
    getPriceIncrement() {
        const productId = this.getProductId();
        if (!productId) return 1;
        
        if (productId.startsWith('BIP')) {
            return 5; // BTC: $5 increments
        } else if (productId.startsWith('ETP')) {
            return 1; // ETH: $1 increments
        }
        return 1; // Default
    }
    
    async start() {
        if (this.isRunning) return;
        
        // Check storage usage before starting
        try {
            const storageUsage = await db.getStorageUsage();
            if (storageUsage.percentage > 95) {
                const proceed = confirm(
                    `⚠️ Storage Critical (${storageUsage.percentage.toFixed(1)}% full)\n\n` +
                    `Used: ${db.formatBytes(storageUsage.used)} / ${db.formatBytes(storageUsage.quota)}\n\n` +
                    `Trade data may not be saved properly.\n` +
                    `Consider clearing old data or refreshing the browser cache.\n\n` +
                    `Start trading session anyway?`
                );
                if (!proceed) return;
            } else if (storageUsage.percentage > 80) {
                console.warn(`[TradePanel ${this.instanceId}] Storage warning: ${storageUsage.percentage.toFixed(1)}% full`);
            }
        } catch (e) {
            console.warn('[TradePanel] Failed to check storage:', e);
        }
        
        // Reset max loss trigger on fresh start
        this.maxLossTriggered = false;
        
        // For perp modes, validate and initialize API
        if (this.isPerpMode()) {
            try {
                await this.initCoinbaseApi();
            } catch (error) {
                alert(`Cannot start: ${error.message}`);
                return;
            }
        }
        
        this.isRunning = true;
        this.signalConfirmed = false;
        this.lockedSignal = null;
        
        // Start session timer if not already running
        if (!this.sessionStartTime) {
            this.sessionStartTime = Date.now();
        }
        
        // Check if there's already a signal - start threshold timer immediately
        const currentSignal = this.getCurrentSignal();
        if (currentSignal) {
            this.lastSignalDirection = currentSignal;
            
            // For LV signal source, the signal is already confirmed by the LV panel
            // so we should act immediately (set signalStartTime in the past)
            if (this.signalSource === 'lv') {
                // Set start time far enough in past that threshold is already met
                this.signalStartTime = Date.now() - (this.threshold * 1000) - 100;
                console.log(`[TradePanel ${this.instanceId}] LV signal already confirmed, will act immediately: ${currentSignal}`);
            } else {
                this.signalStartTime = Date.now();
            }
        } else {
            this.lastSignalDirection = null;
            this.signalStartTime = null;
        }
        
        // Update UI
        this.elements.startBtn.disabled = true;
        this.elements.stopBtn.disabled = false;
        this.elements.signalSelect.disabled = true;
        // Threshold can be adjusted during trading
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = true;
        if (this.elements.tradingModeSelect) this.elements.tradingModeSelect.disabled = true;
        
        // Lock contracts, leverage, and timeout for perp modes (max loss can still be changed)
        if (this.isPerpMode()) {
            if (this.elements.contractsInput) this.elements.contractsInput.disabled = true;
            if (this.elements.orderTimeoutInput) this.elements.orderTimeoutInput.disabled = true;
            if (this.elements.leverageInput) this.elements.leverageInput.disabled = true;
        }
        
        // Update status with mode indicator
        this.elements.status.textContent = this.isPerpMode() ? 
            (this.tradingMode === 'perp-live' ? 'LIVE' : 'SANDBOX') : 'Running';
        this.elements.status.classList.add('running');
        if (this.tradingMode === 'perp-live') {
            this.elements.status.classList.add('live-mode');
        }
        
        // Render locked signal indicator
        this.renderLockedSignal();
        
        // Start polling (clear any existing interval first to prevent stacking)
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        this.updateInterval = setInterval(() => this.checkSignal(), 100);
        
        // Save running state for persistence
        this.saveActivePosition();
        
        const modeInfo = this.isPerpMode() ? 
            `${this.tradingMode} (${this.contracts} contracts @ ${this.leverage}x)` : 
            this.tradingMode;
        console.log('[TradePanel] Started monitoring', this.signalSource, 'trading:', modeInfo, 'initial signal:', currentSignal || 'none');
    }
    
    /**
     * Initialize Coinbase API for live trading mode
     */
    async initCoinbaseApi() {
        if (!window.coinbaseSettings) {
            throw new Error('Coinbase settings not available. Please refresh the page.');
        }
        
        // Check credentials exist
        if (!window.coinbaseSettings.hasCredentials(this.tradingMode)) {
            throw new Error('No Live API credentials configured. Click the gear icon to set them up.');
        }
        
        // Update status
        this.setCoinbaseStatus('connecting', 'Initializing...');
        
        // Create API instance
        this.coinbaseApi = window.coinbaseSettings.createAPI(this.tradingMode);
        
        // Discover portfolio
        await this.coinbaseApi.discoverPortfolio();
        console.log(`[TradePanel] Portfolio discovered:`, this.coinbaseApi.portfolioUuid);
        
        // Validate product exists
        const productId = this.getProductId();
        this.setCoinbaseStatus('connecting', 'Validating product...');
        const productValid = await this.coinbaseApi.validateProduct(productId);
        if (!productValid) {
            this.setCoinbaseStatus('error', 'Product not found');
            throw new Error(`Product ${productId} not found on Coinbase. Make sure ${this.currentSymbol} perpetuals are available.`);
        }
        
        // Check for existing position (live mode only)
        const existingPosition = await this.coinbaseApi.getPosition(productId);
        if (existingPosition) {
            const confirmSync = confirm(
                `Warning: You have an existing ${existingPosition.side.toUpperCase()} position for ${productId} on Coinbase.\n\n` +
                `Size: ${existingPosition.size} contracts\n` +
                `Entry: $${existingPosition.entryPrice.toFixed(2)}\n` +
                `Unrealized P&L: $${existingPosition.unrealizedPnl.toFixed(2)}\n\n` +
                `Click OK to continue (trades will add to this position) or Cancel to abort.`
            );
            if (!confirmSync) {
                this.setCoinbaseStatus('disconnected', 'Cancelled');
                throw new Error('User cancelled due to existing position');
            }
        }
        
        // Initialize WebSocket for real-time order updates
        if (this.useWebSocket && window.CoinbaseWebSocket) {
            this.setCoinbaseStatus('connecting', 'Connecting WebSocket...');
            try {
                await this.initCoinbaseWebSocket(productId);
                console.log(`[TradePanel] WebSocket connected for ${productId}`);
            } catch (wsError) {
                console.warn('[TradePanel] WebSocket failed, will use REST polling fallback:', wsError.message);
                this.useWebSocket = false;
                this.setCoinbaseStatus('ready', 'REST Mode');
            }
        } else {
            this.useWebSocket = false;
            this.setCoinbaseStatus('ready', 'REST Mode');
        }
        
        // Log available margin info (but don't block - let Coinbase reject if insufficient)
        try {
            const summary = await this.coinbaseApi.getPortfolioSummary();
            const bs = summary.balance_summary || summary;
            const buyingPower = parseFloat(bs.futures_buying_power?.value || '0');
            console.log(`[TradePanel] Futures buying power: $${buyingPower.toFixed(2)}`);
            this.updateBalanceDisplay(bs);
            
            // Nano BTC perps: 1 contract = 1/100th BTC
            const currentPrice = this.app?.currentPrice || 100000;
            const contractValue = currentPrice / 100; // 1/100th BTC per contract
            const marginPerContract = contractValue / this.leverage;
            console.log(`[TradePanel] Estimated margin per contract: ~$${marginPerContract.toFixed(2)} (at ${this.leverage}x leverage)`);
        } catch (e) {
            console.warn('[TradePanel] Could not fetch margin info:', e.message);
        }
        
        console.log(`[TradePanel] Coinbase API initialized for ${this.tradingMode}`, 
            'portfolio:', this.coinbaseApi.portfolioUuid,
            'websocket:', this.useWebSocket ? 'enabled' : 'disabled (REST fallback)');
    }
    
    /**
     * Initialize Coinbase WebSocket for real-time order updates
     */
    async initCoinbaseWebSocket(productId) {
        const credentials = window.coinbaseSettings.getCredentials();
        
        this.coinbaseWs = new CoinbaseWebSocket(credentials.apiKey, credentials.privateKey, {
            debug: this.coinbaseApi?.debug || false,
            onStatusChange: (status, message) => {
                console.log(`[TradePanel] WebSocket status: ${status} - ${message}`);
                if (status === 'ready') {
                    this.setCoinbaseStatus('ready', 'WS Connected');
                } else if (status === 'error') {
                    this.setCoinbaseStatus('error', message || 'WS Error');
                } else if (status === 'connecting') {
                    this.setCoinbaseStatus('connecting', message || 'Connecting...');
                }
            },
            onOrderUpdate: (order) => {
                console.log(`[TradePanel] Order update received:`, order.order_id, order.status);
            },
            onBalanceUpdate: (balance) => {
                this.liveBalanceSummary = balance;
                this.updateBalanceDisplay(balance);
            }
        });
        
        // Connect and subscribe to product
        await this.coinbaseWs.connect([productId]);
    }
    
    /**
     * Update Coinbase status indicator
     */
    setCoinbaseStatus(status, message = '') {
        this.coinbaseStatus = status;
        
        if (this.elements.coinbaseStatus) {
            // Update status dot color
            this.elements.coinbaseStatus.className = `coinbase-status-dot status-${status}`;
        }
        
        if (this.elements.coinbaseStatusText) {
            this.elements.coinbaseStatusText.textContent = message || status;
        }
    }
    
    /**
     * Update balance display from WebSocket or REST data
     */
    updateBalanceDisplay(balanceSummary) {
        if (!this.elements.coinbaseBalance) return;
        
        const buyingPower = parseFloat(balanceSummary?.futures_buying_power?.value || '0');
        const unrealizedPnl = parseFloat(balanceSummary?.unrealized_pnl?.value || '0');
        
        let html = `$${buyingPower.toFixed(0)}`;
        if (unrealizedPnl !== 0) {
            const pnlClass = unrealizedPnl >= 0 ? 'positive' : 'negative';
            const pnlSign = unrealizedPnl >= 0 ? '+' : '';
            html += ` <span class="${pnlClass}">(${pnlSign}$${unrealizedPnl.toFixed(2)})</span>`;
        }
        
        this.elements.coinbaseBalance.innerHTML = html;
    }
    
    async stop() {
        if (!this.isRunning) return;
        
        // Close any open position (use await for live modes)
        if (this.position) {
            await this.closePosition('Stop clicked');
        }
        
        this.isRunning = false;
        
        // Clear interval
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        // Reset signal tracking
        this.signalStartTime = null;
        this.lastSignalDirection = null;
        this.signalConfirmed = false;
        this.lockedSignal = null;
        this.waitingForNextBar = false;
        
        // Disconnect WebSocket
        if (this.coinbaseWs) {
            this.coinbaseWs.disconnect();
            this.coinbaseWs = null;
        }
        
        // Clear Coinbase API instance
        this.coinbaseApi = null;
        this.setCoinbaseStatus('disconnected', '');
        
        // Update UI
        this.elements.startBtn.disabled = false;
        this.elements.stopBtn.disabled = true;
        this.elements.signalSelect.disabled = false;
        this.elements.thresholdInput.disabled = false;
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = false;
        if (this.elements.tradingModeSelect) this.elements.tradingModeSelect.disabled = false;
        if (this.elements.contractsInput) this.elements.contractsInput.disabled = false;
        if (this.elements.orderTimeoutInput) this.elements.orderTimeoutInput.disabled = false;
        if (this.elements.leverageInput) this.elements.leverageInput.disabled = false;
        
        this.elements.status.textContent = 'Idle';
        this.elements.status.classList.remove('running', 'live-mode');
        
        // Clear locked signal indicator
        this.renderLockedSignal();
        
        // Clear saved active position state
        this.clearActivePosition();
        
        console.log('[TradePanel] Stopped');
    }
    
    clear() {
        // Stop if running
        if (this.isRunning) {
            this.stop();
        }
        
        // Clear position
        this.position = null;
        this.entryPrice = null;
        this.entryTime = null;
        this.openTradeId = null;
        this.openPositionContracts = null;
        
        // Clear history
        this.trades = [];
        this.totalPnl = 0;
        this.shortPnl = 0;
        this.longPnl = 0;
        this.wins = 0;
        this.losses = 0;
        
        // Reset session metrics
        this.sessionStartTime = null;
        this.peakProfit = 0;
        this.peakLoss = 0;
        
        // Reset limiters
        this.maxLossTriggered = false;
        this.maxTradesTriggered = false;
        this.isClosingPosition = false;
        this.waitingForNextBar = false;
        
        // Clear active position storage and save
        this.clearActivePosition();
        this.saveState();
        this.render();
        
        console.log('[TradePanel] Cleared all trades');
    }
    
    /**
     * Export trades as JSON for debugging/analysis
     * Copies to clipboard and logs to console
     */
    exportTrades() {
        const exportData = {
            instanceId: this.instanceId,
            symbol: this.currentSymbol,
            exportTime: new Date().toISOString(),
            config: {
                signalSource: this.signalSource,
                threshold: this.threshold,
                tradeMode: this.tradeMode,
                tradingMode: this.tradingMode,
                contracts: this.contracts,
                leverage: this.leverage,
                maxLoss: this.maxLoss,
                limitMaxTrades: this.limitMaxTrades,
                maxTrades: this.maxTrades,
                onlyCloseInProfit: this.onlyCloseInProfit,
                takeProfitEnabled: this.takeProfitEnabled,
                takeProfitThreshold: this.takeProfitThreshold,
                takeProfitWaitNextBar: this.takeProfitWaitNextBar
            },
            summary: {
                totalPnl: this.totalPnl,
                shortPnl: this.shortPnl,
                longPnl: this.longPnl,
                wins: this.wins,
                losses: this.losses,
                winRate: this.trades.length > 0 ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(1) + '%' : 'N/A',
                peakProfit: this.peakProfit,
                peakLoss: this.peakLoss,
                sessionStartTime: this.sessionStartTime,
                totalTrades: this.trades.length
            },
            trades: this.trades.map(t => ({
                id: t.id,
                type: t.type,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                pnl: t.pnl,
                pnlPercent: t.pnlPercent,
                entryTime: t.entryTime ? new Date(t.entryTime).toISOString() : null,
                exitTime: t.exitTime ? new Date(t.exitTime).toISOString() : null,
                duration: t.duration,
                durationFormatted: t.duration ? this.formatDuration(t.duration) : null,
                isOpen: t.isOpen,
                closeReason: t.closeReason,
                tradingMode: t.tradingMode,
                contracts: t.contracts,
                leverage: t.leverage
            }))
        };
        
        const jsonStr = JSON.stringify(exportData, null, 2);
        
        // Copy to clipboard
        navigator.clipboard.writeText(jsonStr).then(() => {
            console.log(`[TradePanel ${this.instanceId}] Exported ${this.trades.length} trades to clipboard`);
            
            // Show checkmark feedback
            if (this.elements.exportBtn) {
                const originalText = this.elements.exportBtn.textContent;
                this.elements.exportBtn.textContent = '✓';
                this.elements.exportBtn.classList.add('success');
                setTimeout(() => {
                    this.elements.exportBtn.textContent = originalText;
                    this.elements.exportBtn.classList.remove('success');
                }, 1500);
            }
        }).catch(err => {
            console.error('[TradePanel] Failed to copy to clipboard:', err);
        });
        
        // Log to console
        console.log(`[TradePanel ${this.instanceId}] Trade Export:`, exportData);
        
        return exportData;
    }
    
    getCurrentSignal() {
        if (!this.app || !this.app.chart) {
            // Only log this once per 5 seconds to avoid spam
            const now = Date.now();
            if (!this.lastNoChartLog || now - this.lastNoChartLog >= 5000) {
                this.lastNoChartLog = now;
                console.warn(`[TradePanel ${this.instanceId}] getCurrentSignal: app=${!!this.app} chart=${!!this.app?.chart}`);
            }
            return null;
        }
        
        const chart = this.app.chart;
        
        // Get individual signal directions
        const lProx = chart.liveProximity?.lastSignal?.direction || null;
        const lDrift = chart.liveDrift?.lastSignal?.direction || null;
        const prox = (chart.clusterProximity?.isLocked && chart.clusterProximity?.lastSignal?.direction) || null;
        const drift = (chart.clusterDrift?.isLocked && chart.clusterDrift?.lastSignal?.direction) || null;
        
        // Helper to convert direction to 'up'/'down'
        const toDir = (d) => d === 'buy' ? 'up' : (d === 'sell' ? 'down' : null);
        
        // Helper to combine two signals (up+up=up, down+down=down, else flat)
        const combine = (a, b) => {
            const dirA = toDir(a);
            const dirB = toDir(b);
            if (!dirA || !dirB) return null;
            if (dirA === dirB) return dirA === 'up' ? 'buy' : 'sell';
            return 'flat'; // Conflicting signals
        };
        
        let result = null;
        
        switch (this.signalSource) {
            case 'l-drift':
                result = lDrift;
                break;
                
            case 'l-prox':
                result = lProx;
                break;
                
            case 'l-combo':
                // l-prox + l-drift combined (flat = no action)
                result = combine(lProx, lDrift);
                break;
                
            case 'prox':
                // Confirmed proximity only
                result = prox;
                break;
                
            case 'drift':
                // Confirmed drift only
                result = drift;
                break;
                
            case 'combo':
                // prox + drift combined (confirmed signals)
                result = combine(prox, drift);
                break;
                
            case '3of4':
                // 3 out of 4 signals must agree
                const signals3of4 = [lProx, lDrift, prox, drift].filter(s => s !== null);
                const buyCount = signals3of4.filter(s => s === 'buy').length;
                const sellCount = signals3of4.filter(s => s === 'sell').length;
                if (buyCount >= 3) result = 'buy';
                else if (sellCount >= 3) result = 'sell';
                break;
                
            case 'all4':
                // All 4 signals must agree
                const all = [lProx, lDrift, prox, drift];
                const validSignals = all.filter(s => s !== null);
                if (validSignals.length === 4) {
                    const allBuy = validSignals.every(s => s === 'buy');
                    const allSell = validSignals.every(s => s === 'sell');
                    if (allBuy) result = 'buy';
                    else if (allSell) result = 'sell';
                    else result = 'flat';
                }
                break;
                
            case 'lv':
                // Liquidity Vacuum signal - use the displayed hero signal
                // This matches what the user sees in the LV panel
                const lvHero = document.getElementById('lvSignalMain');
                const lvLabel = lvHero?.querySelector('.lv-label')?.textContent?.trim()?.toLowerCase();
                if (lvLabel === 'buy') result = 'buy';
                else if (lvLabel === 'sell') result = 'sell';
                else result = 'flat';
                break;
                
            default:
                result = null;
        }
        
        // Return 'buy', 'sell', or null (flat returns null to avoid action)
        if (result === 'flat') return null;
        return result;
    }
    
    checkSignal() {
        if (!this.isRunning) return;
        
        const currentSignal = this.getCurrentSignal();
        const now = Date.now();
        
        // Debug: Log signal state every 5 seconds
        if (!this.lastSignalDebug || now - this.lastSignalDebug >= 5000) {
            this.lastSignalDebug = now;
            const elapsed = this.signalStartTime ? ((now - this.signalStartTime) / 1000).toFixed(1) : 0;
            const blockers = [];
            if (this.maxLossTriggered) blockers.push('maxLoss');
            if (this.maxTradesTriggered) blockers.push('maxTrades');
            if (this.waitingForNextBar) blockers.push('waitNextBar');
            console.log(`[TradePanel ${this.instanceId}] Signal: ${currentSignal || 'none'} | Locked: ${this.lockedSignal || 'none'} | Confirmed: ${this.signalConfirmed} | Elapsed: ${elapsed}s / ${this.threshold}s | Position: ${this.position || 'none'}${blockers.length ? ' | BLOCKED: ' + blockers.join(',') : ''}`);
        }
        
        // Check if max trades limit hit
        if (this.maxTradesTriggered) {
            return; // Don't process signals if max trades reached
        }
        
        // Check if waiting for next bar after take-profit (only blocks new entries, not current position)
        if (this.waitingForNextBar && !this.position) {
            return; // Wait for next bar before re-entry
        }
        
        // Update live P&L for open trades
        if (this.openTradeId) {
            this.renderLog();
        }
        
        // Check take profit (with guard to prevent re-entry during async close)
        if (this.takeProfitEnabled && this.takeProfitThreshold !== null && this.position && this.entryPrice && !this.isClosingPosition) {
            const currentPrice = this.app?.currentPrice;
            if (currentPrice) {
                const unrealizedPnlGross = this.getUnrealizedPnl(currentPrice);
                
                // Convert fee/funding percentages to a dollar cost against entry
                const hoursInPosition = this.entryTime ? (Date.now() - this.entryTime) / (1000 * 60 * 60) : 0;
                const feePercent = this.minProfitThreshold || 0; // covers both sides as configured
                const fundingPercent = this.fundingRatePerHour * hoursInPosition;
                const totalCostPercent = feePercent + fundingPercent;
                const estimatedCosts = this.entryPrice * (totalCostPercent / 100);
                
                const unrealizedPnlNet = unrealizedPnlGross - estimatedCosts;
                
                if (unrealizedPnlNet >= this.takeProfitThreshold) {
                    console.log(`[TradePanel ${this.instanceId}] TAKE PROFIT triggered! Net P&L: $${unrealizedPnlNet.toFixed(2)} (gross $${unrealizedPnlGross.toFixed(2)} - costs $${estimatedCosts.toFixed(2)}) >= target $${this.takeProfitThreshold}`);
                    this.isClosingPosition = true;
                    
                    // Set wait-for-next-bar guard if option enabled
                    if (this.takeProfitWaitNextBar) {
                        this.waitingForNextBar = true;
                        console.log(`[TradePanel ${this.instanceId}] Waiting for next bar before re-entry`);
                    }
                    
                    this.closePosition('Take profit').finally(() => {
                        this.isClosingPosition = false;
                    });
                    return; // Exit after closing, wait for next signal
                }
            }
        }
        
        // Update session timer and rolling PNL metrics (throttled to ~1Hz)
        if (!this.lastSummaryRender || now - this.lastSummaryRender >= 1000) {
            this.lastSummaryRender = now;
            this.renderSummary();
        }
        
        // Check max loss (for perp modes)
        if (this.isPerpMode() && !this.checkMaxLoss()) {
            return; // Max loss triggered, stop processing
        }
        
        // No signal - reset tracking but keep locked signal
        if (!currentSignal) {
            this.lastSignalDirection = null;
            this.signalStartTime = null;
            this.signalConfirmed = false;
            return;
        }
        
        // Signal changed - reset timer for potential new lock
        if (currentSignal !== this.lastSignalDirection) {
            this.lastSignalDirection = currentSignal;
            this.signalStartTime = now;
            this.signalConfirmed = false;
            
            // For LV signal source, the signal is already confirmed by the LV panel
            // (it has its own 30s confirmation), so act immediately on signal change
            if (this.signalSource === 'lv' && this.lockedSignal !== currentSignal) {
                console.log(`[TradePanel ${this.instanceId}] LV SIGNAL CHANGE! ${this.lockedSignal || 'none'} → ${currentSignal} (acting immediately)`);
                this.signalConfirmed = true;
                this.lockedSignal = currentSignal;
                this.renderLockedSignal();
                this.saveActivePosition();
                this.onSignalConfirmed(currentSignal);
            }
            return;
        }
        
        // Same signal - check if threshold met for locking
        if (!this.signalConfirmed && this.signalStartTime) {
            const elapsed = (now - this.signalStartTime) / 1000;
            
            if (elapsed >= this.threshold) {
                this.signalConfirmed = true;
                
                // Only trigger trade if this is a NEW locked signal (different from current lock)
                // This provides signal persistence - signal stays locked until opposing threshold met
                if (this.lockedSignal !== currentSignal) {
                    console.log(`[TradePanel ${this.instanceId}] THRESHOLD MET! Signal: ${currentSignal} | Previous Lock: ${this.lockedSignal} → New Lock: ${currentSignal}`);
                    this.lockedSignal = currentSignal;
                    this.renderLockedSignal();
                    this.saveActivePosition(); // Save signal state changes
                    this.onSignalConfirmed(currentSignal);
                } else {
                    console.log(`[TradePanel ${this.instanceId}] Threshold met but signal already locked: ${currentSignal}`);
                }
            }
        }
    }
    
    async onSignalConfirmed(signalDirection) {
        const price = this.app?.currentPrice;
        if (!price) {
            console.warn(`[TradePanel ${this.instanceId}] onSignalConfirmed: No price available!`);
            return;
        }
        
        // Determine trade direction from signal
        // 'buy' signal = go long, 'sell' signal = go short
        const tradeDirection = signalDirection === 'buy' ? 'long' : 'short';
        
        // Check if this trade direction is allowed by mode
        const canTrade = this.canTradeDirection(tradeDirection);
        
        console.log(`[TradePanel ${this.instanceId}] onSignalConfirmed: signal=${signalDirection} → trade=${tradeDirection} | canTrade=${canTrade} | currentPosition=${this.position || 'none'} | price=$${price.toFixed(2)}`);
        
        if (!this.position) {
            // No position - open one if allowed
            if (canTrade) {
                console.log(`[TradePanel ${this.instanceId}] Opening ${tradeDirection} position...`);
                await this.openPosition(tradeDirection, price);
            } else {
                console.log(`[TradePanel ${this.instanceId}] Cannot trade ${tradeDirection} - mode restriction`);
            }
        } else if (this.position !== tradeDirection) {
            // Opposite signal - check if we can close
            
            // Check "only close in profit" setting
            if (this.onlyCloseInProfit) {
                const unrealizedPnl = this.getUnrealizedPnl(price);
                const profitPercent = (unrealizedPnl / this.entryPrice) * 100;
                
                // Calculate hours in position for funding cost
                const hoursInPosition = this.entryTime ? (Date.now() - this.entryTime) / (1000 * 60 * 60) : 0;
                const fundingCost = this.fundingRatePerHour * hoursInPosition;
                const minProfitPercent = this.minProfitThreshold + fundingCost;
                
                if (profitPercent < minProfitPercent) {
                    console.log(`[TradePanel ${this.instanceId}] Blocking close - profit ${profitPercent.toFixed(3)}% below min threshold ${minProfitPercent.toFixed(3)}% (base ${this.minProfitThreshold}% + funding ${fundingCost.toFixed(3)}% for ${hoursInPosition.toFixed(1)}h)`);
                    return; // Don't close or flip
                }
            }
            
            // Close current position
            await this.closePosition('Signal reversed');
            
            // Open new position if allowed
            if (canTrade) {
                await this.openPosition(tradeDirection, price);
            }
        }
        // Same direction - do nothing (already in position)
    }
    
    /**
     * Calculate unrealized P&L for current position
     */
    getUnrealizedPnl(currentPrice) {
        if (!this.position || !this.entryPrice) return 0;
        
        const price = currentPrice || this.app?.currentPrice || this.entryPrice;
        if (this.position === 'long') {
            return price - this.entryPrice;
        } else {
            return this.entryPrice - price;
        }
    }
    
    canTradeDirection(direction) {
        if (this.tradeMode === 'both') return true;
        if (this.tradeMode === 'long' && direction === 'long') return true;
        if (this.tradeMode === 'short' && direction === 'short') return true;
        
        // BB%B & Lighting mode - dynamically determined by indicator state
        if (this.tradeMode === 'bbl') {
            const bblState = this.app?.lastBBLightingState;
            if (!bblState || bblState.mode === 'wait') {
                return false; // No trades when waiting
            }
            if (bblState.mode === 'both') {
                return true; // Allow both directions during conflict
            }
            if (bblState.mode === 'long' && direction === 'long') {
                return true;
            }
            if (bblState.mode === 'short' && direction === 'short') {
                return true;
            }
            return false;
        }
        
        return false;
    }
    
    /**
     * Check if we should exit a position in BBL mode
     * In BBL mode, opposite signal closes but doesn't flip
     */
    shouldExitOnlyInBBLMode(signalDirection) {
        if (this.tradeMode !== 'bbl') return false;
        
        const bblState = this.app?.lastBBLightingState;
        if (!bblState) return false;
        
        // In BBL mode with single-direction allowed:
        // If we're in a position and get opposite signal, exit only (don't flip)
        if (bblState.mode === 'long' && this.position === 'long' && signalDirection === 'short') {
            return true; // Exit long on short signal, but don't go short
        }
        if (bblState.mode === 'short' && this.position === 'short' && signalDirection === 'long') {
            return true; // Exit short on long signal, but don't go long
        }
        
        return false;
    }
    
    async openPosition(direction, price) {
        console.log(`[TradePanel ${this.instanceId}] openPosition: direction=${direction} price=${price} isPerpMode=${this.isPerpMode()} hasAPI=${!!this.coinbaseApi}`);
        
        // Track actual filled contracts for this trade (may differ from config on partial fills)
        let actualContracts = this.contracts;
        
        // For perp modes, execute live order
        if (this.isPerpMode() && this.coinbaseApi) {
            console.log(`[TradePanel ${this.instanceId}] openPosition: Executing live order...`);
            try {
                const result = await this.executeLiveOrder(direction, price, 'open');
                console.log(`[TradePanel ${this.instanceId}] openPosition: Live order result:`, result);
                
                if (!result.success) {
                    // Check for partial fill - we have a real position on Coinbase!
                    if (result.partial && result.filledContracts > 0) {
                        console.warn(`[TradePanel] PARTIAL FILL: ${result.filledContracts}/${result.totalContracts} contracts filled`);
                        // Track partial fill for THIS trade only (don't modify config)
                        actualContracts = result.filledContracts;
                        price = result.fillPrice || price;
                        // Alert user but continue with partial position
                        alert(`⚠️ Partial fill: ${result.filledContracts}/${result.totalContracts} contracts opened @ $${price.toFixed(2)}\n\nError: ${result.error}`);
                    } else {
                        console.error('[TradePanel] Live order failed:', result.error);
                        return; // Don't open local position if no contracts filled
                    }
                } else {
                    // Use actual fill price if available
                    price = result.fillPrice || price;
                    actualContracts = result.filledContracts || this.contracts;
                }
            } catch (error) {
                console.error('[TradePanel] Live order error:', error);
                return;
            }
        }
        
        this.position = direction;
        this.entryPrice = price;
        this.entryTime = Date.now();
        this.openPositionContracts = this.isPerpMode() ? actualContracts : null; // Track for closing
        
        // Add open trade to log immediately
        const tradeContracts = this.openPositionContracts;
        
        const openTrade = {
            id: Date.now(), // Unique ID to find it later
            type: direction,
            entryPrice: price,
            exitPrice: null,
            pnl: null,
            entryTime: this.entryTime,
            exitTime: null,
            isOpen: true,
            // Perp mode additions
            tradingMode: this.tradingMode,
            contracts: tradeContracts,
            leverage: this.isPerpMode() ? this.leverage : null
        };
        this.trades.unshift(openTrade);
        this.openTradeId = openTrade.id;
        
        const modeInfo = this.isPerpMode() ? ` [${this.tradingMode}]` : '';
        console.log(`[TradePanel]${modeInfo} Opened ${direction.toUpperCase()} @ $${price.toFixed(2)}`);
        
        // Save active position state for persistence
        this.saveActivePosition();
        this.saveState();
        
        this.renderPosition();
        this.renderLog();
    }
    
    async closePosition(reason = '') {
        if (!this.position || !this.entryPrice) return;
        
        let exitPrice = this.app?.currentPrice || this.entryPrice;
        
        // Calculate minimum acceptable price if "only close in profit" is enabled
        let minAcceptablePrice = null;
        if (this.onlyCloseInProfit) {
            const hoursInPosition = this.entryTime ? (Date.now() - this.entryTime) / (1000 * 60 * 60) : 0;
            const fundingCost = this.fundingRatePerHour * hoursInPosition;
            const minProfitPercent = this.minProfitThreshold + fundingCost;
            
            if (this.position === 'long') {
                // For long: exit price must be above entry + min profit
                minAcceptablePrice = this.entryPrice * (1 + minProfitPercent / 100);
                if (this.isPerpMode()) {
                    // Round UP to price increment for perps (ensures we meet threshold)
                    const increment = this.getPriceIncrement();
                    minAcceptablePrice = Math.ceil(minAcceptablePrice / increment) * increment;
                }
            } else {
                // For short: exit price must be below entry - min profit
                minAcceptablePrice = this.entryPrice * (1 - minProfitPercent / 100);
                if (this.isPerpMode()) {
                    // Round DOWN to price increment for perps (ensures we meet threshold)
                    const increment = this.getPriceIncrement();
                    minAcceptablePrice = Math.floor(minAcceptablePrice / increment) * increment;
                }
            }
            
            console.log(`[TradePanel ${this.instanceId}] Min acceptable price: $${minAcceptablePrice.toFixed(2)} (${this.position}, entry: $${this.entryPrice.toFixed(2)}, min profit: ${minProfitPercent.toFixed(3)}%)`);
        }
        
        // For perp modes, execute live close order
        if (this.isPerpMode() && this.coinbaseApi) {
            // Use actual open position contracts (not config, in case of partial fills)
            const closeContracts = this.openPositionContracts || this.contracts;
            const savedContracts = this.contracts;
            this.contracts = closeContracts; // Temporarily set for executeLiveOrder
            
            try {
                // Use minimum acceptable price as limit if set, otherwise current market
                const limitPrice = minAcceptablePrice || exitPrice;
                const result = await this.executeLiveOrder(this.position, limitPrice, 'close', minAcceptablePrice);
                if (!result.success) {
                    console.error('[TradePanel] Live close order failed:', result.error);
                    // Still close locally but log the failure
                } else if (result.fillPrice) {
                    exitPrice = result.fillPrice;
                    
                    // Verify fill price meets our threshold
                    if (minAcceptablePrice) {
                        const meetsThreshold = this.position === 'long' 
                            ? exitPrice >= minAcceptablePrice 
                            : exitPrice <= minAcceptablePrice;
                        
                        if (!meetsThreshold) {
                            console.warn(`[TradePanel ${this.instanceId}] ⚠️ Fill price $${exitPrice.toFixed(2)} violated min threshold $${minAcceptablePrice.toFixed(2)}!`);
                        }
                    }
                }
            } catch (error) {
                console.error('[TradePanel] Live close order error:', error);
            } finally {
                this.contracts = savedContracts; // Restore config value
            }
        } else if (minAcceptablePrice) {
            // Simulation mode with profit protection - use min acceptable price
            if (this.position === 'long') {
                // For long: ensure exit price is at least min acceptable
                exitPrice = Math.max(exitPrice, minAcceptablePrice);
            } else {
                // For short: ensure exit price is at most min acceptable  
                exitPrice = Math.min(exitPrice, minAcceptablePrice);
            }
            console.log(`[TradePanel ${this.instanceId}] Simulation close with profit protection: exit $${exitPrice.toFixed(2)}`);
        }
        
        const exitTime = Date.now();
        
        // Calculate P&L
        let pnl;
        if (this.position === 'long') {
            pnl = exitPrice - this.entryPrice;
        } else {
            pnl = this.entryPrice - exitPrice;
        }
        
        // Calculate P&L percentage
        const pnlPercent = (pnl / this.entryPrice) * 100;
        
        // Calculate duration
        const duration = exitTime - this.entryTime;
        
        // Find and update the open trade entry
        const openTrade = this.trades.find(t => t.id === this.openTradeId);
        if (openTrade) {
            openTrade.exitPrice = exitPrice;
            openTrade.pnl = pnl;
            openTrade.pnlPercent = pnlPercent;
            openTrade.exitTime = exitTime;
            openTrade.duration = duration;
            openTrade.isOpen = false;
            openTrade.closeReason = reason;
        }
        this.openTradeId = null;
        
        // Update stats
        this.totalPnl += pnl;
        if (this.position === 'short') {
            this.shortPnl += pnl;
        } else {
            this.longPnl += pnl;
        }
        if (pnl >= 0) {
            this.wins++;
        } else {
            this.losses++;
        }
        
        // Track peak profit and loss
        if (this.totalPnl > this.peakProfit) {
            this.peakProfit = this.totalPnl;
        }
        if (this.totalPnl < 0 && Math.abs(this.totalPnl) > this.peakLoss) {
            this.peakLoss = Math.abs(this.totalPnl);
        }
        
        const modeInfo = this.isPerpMode() ? ` [${this.tradingMode}]` : '';
        console.log(`[TradePanel]${modeInfo} Closed ${this.position.toUpperCase()} @ $${exitPrice.toFixed(2)} | P&L: $${pnl.toFixed(2)} | ${reason}`);
        
        // Reset position
        this.position = null;
        this.entryPrice = null;
        this.entryTime = null;
        this.openPositionContracts = null;
        
        // Save state (including updated active position)
        this.saveActivePosition();
        this.saveState();
        this.render();
        
        // Check if max trades limit reached
        if (this.limitMaxTrades && !this.maxTradesTriggered) {
            const completedTrades = this.wins + this.losses;
            if (completedTrades >= this.maxTrades) {
                this.maxTradesTriggered = true;
                console.log(`[TradePanel] MAX TRADES LIMIT (${this.maxTrades}) reached! Stopping.`);
                this.stop();
            }
        }
    }
    
    /**
     * Execute live order on Coinbase (for perp modes)
     * Uses LIMIT orders with timeout and retry for reliable fills.
     * 
     * Flow:
     * 1. Place limit order for full amount
     * 2. Poll status for orderTimeout seconds
     * 3. If filled → done
     * 4. If partial → cancel remaining, retry for unfilled
     * 5. If open → cancel all, retry with fresh price
     * 6. For opens: check signal validity before each retry
     * 7. For closes: always complete (unlimited retries)
     */
    async executeLiveOrder(direction, price, action = 'open', minAcceptablePrice = null) {
        console.log(`[TradePanel ${this.instanceId}] executeLiveOrder: direction=${direction} price=${price} action=${action} minPrice=${minAcceptablePrice}`);
        
        if (!this.coinbaseApi) {
            console.error(`[TradePanel ${this.instanceId}] executeLiveOrder: Coinbase API not initialized!`);
            throw new Error('Coinbase API not initialized');
        }
        
        // Check max loss before opening new positions
        if (action === 'open') {
            if (!this.checkMaxLoss()) {
                console.log(`[TradePanel ${this.instanceId}] executeLiveOrder: MAX_LOSS_EXCEEDED`);
                return { success: false, error: 'MAX_LOSS_EXCEEDED' };
            }
        }
        
        const productId = this.getProductId();
        const totalContracts = this.contracts;
        const timeoutMs = this.orderTimeout * 1000; // Convert to milliseconds
        
        // Determine side for Coinbase API
        let side;
        if (action === 'open') {
            side = direction === 'long' ? 'BUY' : 'SELL';
        } else {
            side = direction === 'long' ? 'SELL' : 'BUY';
        }
        
        // Get price callback - use min acceptable price for closes with profit protection
        const getPriceCallback = () => {
            const currentPrice = this.app?.currentPrice || price;
            
            // For close orders with minimum price protection, use minAcceptablePrice as limit
            // Limit orders automatically fill at best available price up to the limit:
            // - SELL limit fills at limit or HIGHER (protecting our minimum sell price)
            // - BUY limit fills at limit or LOWER (protecting our maximum buy price)
            if (action === 'close' && minAcceptablePrice) {
                return minAcceptablePrice;
            }
            
            return currentPrice;
        };
        
        console.log(`[TradePanel ${this.instanceId}] ${action.toUpperCase()} ${direction}: ${totalContracts} contracts (timeout: ${this.orderTimeout}s)`);
        
        // Show progress
        this.showOrderProgress(action, 0, totalContracts);
        
        let filledContracts = 0;
        let totalAttempts = 0;
        let fillPriceSum = 0;
        let orderIds = [];
        
        try {
            // Loop until all contracts filled
            while (filledContracts < totalContracts) {
                const remaining = totalContracts - filledContracts;
                totalAttempts++;
                
                // For opens: check if signal is still valid before each attempt
                if (action === 'open' && totalAttempts > 1) {
                    if (!this.isSignalStillValid(direction)) {
                        console.log(`[TradePanel ${this.instanceId}] Signal changed - aborting order`);
                        this.hideOrderProgress();
                        
                        // If we have a partial fill, report it
                        if (filledContracts > 0) {
                            const avgFillPrice = fillPriceSum / filledContracts;
                            this.setCoinbaseStatus('ready', `Partial ${filledContracts}/${totalContracts}`);
                            return {
                                success: false,
                                partial: true,
                                filledContracts: filledContracts,
                                totalContracts: totalContracts,
                                fillPrice: avgFillPrice,
                                orderIds: orderIds,
                                error: 'SIGNAL_CHANGED',
                                attempts: totalAttempts
                            };
                        }
                        
                        this.setCoinbaseStatus('ready', 'Signal changed');
                        return { success: false, error: 'SIGNAL_CHANGED', attempts: totalAttempts };
                    }
                }
                
                console.log(`[TradePanel ${this.instanceId}] Attempt ${totalAttempts}: ${remaining} contracts remaining`);
                
                // Execute limit order with timeout
                const orderResult = await this.executeLimitOrderWithTimeout(
                    productId, side, remaining, getPriceCallback, timeoutMs, action
                );
                
                if (orderResult.filledSize > 0) {
                    filledContracts += orderResult.filledSize;
                    fillPriceSum += (orderResult.averageFilledPrice || getPriceCallback()) * orderResult.filledSize;
                    if (orderResult.orderId) orderIds.push(orderResult.orderId);
                    
                    // Update progress
                    this.showOrderProgress(action, filledContracts, totalContracts);
                    console.log(`[TradePanel ${this.instanceId}] ✓ Filled ${orderResult.filledSize} @ $${orderResult.averageFilledPrice} (${filledContracts}/${totalContracts})`);
                }
                
                if (orderResult.fatal) {
                    // Fatal error - stop everything
                    console.error(`[TradePanel ${this.instanceId}] ✗ Fatal error:`, orderResult.error);
                    this.hideOrderProgress();
                    this.setCoinbaseStatus('error', orderResult.error);
                    
                    if (filledContracts > 0) {
                        const avgFillPrice = fillPriceSum / filledContracts;
                        return {
                            success: false,
                            partial: true,
                            filledContracts: filledContracts,
                            totalContracts: totalContracts,
                            fillPrice: avgFillPrice,
                            orderIds: orderIds,
                            error: orderResult.error,
                            attempts: totalAttempts
                        };
                    }
                    
                    return {
                        success: false,
                        error: orderResult.error,
                        message: orderResult.message,
                        attempts: totalAttempts
                    };
                }
                
                // Small delay between retry attempts
                if (filledContracts < totalContracts) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            // All contracts filled!
            const avgFillPrice = fillPriceSum / totalContracts;
            this.hideOrderProgress();
            this.setCoinbaseStatus('ready', `Filled ${totalContracts}@$${avgFillPrice.toFixed(0)}`);
            
            console.log(`[TradePanel ${this.instanceId}] ✓ ALL FILLED: ${totalContracts} contracts @ avg $${avgFillPrice.toFixed(2)} (${totalAttempts} attempts)`);
            
            return {
                success: true,
                orderId: orderIds[orderIds.length - 1],
                orderIds: orderIds,
                fillPrice: avgFillPrice,
                filledContracts: totalContracts,
                attempts: totalAttempts
            };
            
        } catch (orderError) {
            console.error(`[TradePanel ${this.instanceId}] executeLiveOrder error:`, orderError);
            this.hideOrderProgress();
            this.setCoinbaseStatus('error', orderError.message);
            
            if (action === 'open') {
                this.showOrderFailedNotification(direction, { error: orderError.message, attempts: totalAttempts });
            }
            
            return { success: false, error: orderError.message };
        }
    }
    
    /**
     * Execute a single limit order and wait for fill with timeout
     * 
     * @param {string} productId - Product to trade
     * @param {string} side - 'BUY' or 'SELL'
     * @param {number} size - Number of contracts
     * @param {function} getPriceCallback - Get current market price
     * @param {number} timeoutMs - Max time to wait for fill
     * @param {string} action - 'open' or 'close'
     * @returns {object} { filledSize, averageFilledPrice, orderId, fatal?, error? }
     */
    async executeLimitOrderWithTimeout(productId, side, size, getPriceCallback, timeoutMs, action) {
        // Get current price with conservative rounding
        let currentPrice = getPriceCallback();
        currentPrice = this.coinbaseApi.roundToTickSize(productId, currentPrice, side, false);
        
        console.log(`[TradePanel ${this.instanceId}] Placing LIMIT ${side} ${size} @ $${currentPrice} (timeout: ${timeoutMs/1000}s)`);
        this.setCoinbaseStatus('ordering', `Limit ${side}...`);
        
        // Build limit order (GTC - Good Till Cancelled)
        const clientOrderId = `ob-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const orderBody = {
            client_order_id: clientOrderId,
            product_id: productId,
            side: side.toUpperCase(),
            order_configuration: {
                limit_limit_gtc: {
                    base_size: size.toString(),
                    limit_price: currentPrice.toString(),
                    post_only: false
                }
            }
        };
        
        // INTX perpetuals support leverage/margin in order
        if (!this.coinbaseApi.isCFMFutures(productId) && this.leverage) {
            orderBody.leverage = this.leverage.toString();
            orderBody.margin_type = 'CROSS';
        }
        
        let orderId = null;
        
        try {
            // Place the order
            const data = await this.coinbaseApi.callAPI('POST', '/api/v3/brokerage/orders', orderBody);
            
            if (!data.success || !data.success_response?.order_id) {
                const reason = data.failure_reason || data.error_response?.error || 'Unknown';
                const message = data.error_response?.message || reason;
                
                // Fatal errors
                if (['INSUFFICIENT_FUND', 'MARGIN_INSUFFICIENT', 'INVALID_PRODUCT', 'INVALID_ORDER_CONFIG'].includes(reason)) {
                    return { filledSize: 0, fatal: true, error: reason, message: message };
                }
                
                return { filledSize: 0, error: reason, message: message };
            }
            
            orderId = data.success_response.order_id;
            console.log(`[TradePanel ${this.instanceId}] Order placed: ${orderId}`);
            
            // Poll for fill status until timeout
            const startTime = Date.now();
            const pollInterval = 500; // Poll every 500ms
            let lastFilledSize = 0;
            let isFirstPoll = true;
            
            while (Date.now() - startTime < timeoutMs) {
                // First poll is immediate, subsequent polls wait
                if (!isFirstPoll) {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
                isFirstPoll = false;
                
                const status = await this.coinbaseApi.getOrderStatus(orderId);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                
                // Handle NOT_FOUND - order may not be indexed yet, keep polling
                if (status.status === 'NOT_FOUND') {
                    console.log(`[TradePanel ${this.instanceId}] Order not indexed yet, retrying... (${elapsed}s)`);
                    continue;
                }
                
                if (status.status === 'FILLED') {
                    console.log(`[TradePanel ${this.instanceId}] Order FILLED after ${elapsed}s`);
                    return {
                        filledSize: status.filledSize || size,
                        averageFilledPrice: status.averageFilledPrice || currentPrice,
                        orderId: orderId
                    };
                }
                
                // Track partial fills
                if (status.filledSize > lastFilledSize) {
                    lastFilledSize = status.filledSize;
                    console.log(`[TradePanel ${this.instanceId}] Partial fill: ${lastFilledSize}/${size} after ${elapsed}s`);
                    this.setCoinbaseStatus('ordering', `${lastFilledSize}/${size}...`);
                }
                
                // Check if order was cancelled externally
                if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(status.status)) {
                    console.log(`[TradePanel ${this.instanceId}] Order ${status.status} after ${elapsed}s`);
                    return {
                        filledSize: status.filledSize || 0,
                        averageFilledPrice: status.averageFilledPrice,
                        orderId: orderId,
                        error: status.status
                    };
                }
            }
            
            // Timeout reached - cancel unfilled portion
            console.log(`[TradePanel ${this.instanceId}] Timeout reached, cancelling order...`);
            
            // Get status before cancel attempt
            let finalStatus = await this.coinbaseApi.getOrderStatus(orderId);
            
            // Cancel the order if still open (or NOT_FOUND which means not indexed yet)
            if (finalStatus.status === 'OPEN' || finalStatus.status === 'PENDING' || finalStatus.status === 'NOT_FOUND') {
                const cancelResult = await this.coinbaseApi.cancelOrder(orderId);
                
                // Check if order already filled (cancel fails with ORDER_IS_FULLY_FILLED)
                if (!cancelResult.success && cancelResult.failureReason === 'ORDER_IS_FULLY_FILLED') {
                    console.log(`[TradePanel ${this.instanceId}] Order already FILLED (cancel reported ORDER_IS_FULLY_FILLED)`);
                    
                    // Poll until we get accurate fill data (Coinbase indexing delay)
                    for (let retry = 0; retry < 10; retry++) {
                        await new Promise(resolve => setTimeout(resolve, 200));
                        finalStatus = await this.coinbaseApi.getOrderStatus(orderId);
                        if (finalStatus.status === 'FILLED' && finalStatus.filledSize > 0) {
                            break;
                        }
                    }
                    
                    // If still can't get accurate data, assume full fill
                    if (finalStatus.status !== 'FILLED' || !finalStatus.filledSize) {
                        console.log(`[TradePanel ${this.instanceId}] Assuming full fill of ${size} (indexing delay)`);
                        return {
                            filledSize: size,
                            averageFilledPrice: currentPrice,
                            orderId: orderId
                        };
                    }
                } else {
                    // Cancel succeeded or failed for other reason - re-check status
                    finalStatus = await this.coinbaseApi.getOrderStatus(orderId);
                }
            }
            
            const actualFilled = finalStatus.filledSize || 0;
            console.log(`[TradePanel ${this.instanceId}] Order cancelled/completed (final: ${actualFilled}/${size}, status: ${finalStatus.status})`);
            
            return {
                filledSize: actualFilled,
                averageFilledPrice: finalStatus.averageFilledPrice,
                orderId: orderId,
                timedOut: actualFilled < size
            };
            
        } catch (error) {
            console.error(`[TradePanel ${this.instanceId}] Limit order error:`, error.message);
            
            // Try to cancel if we have an order ID and check final fill status
            if (orderId) {
                try {
                    const cancelResult = await this.coinbaseApi.cancelOrder(orderId);
                    
                    // If cancel failed because order filled, recover the fill
                    if (!cancelResult.success && cancelResult.failureReason === 'ORDER_IS_FULLY_FILLED') {
                        console.log(`[TradePanel ${this.instanceId}] Order filled despite error - recovering`);
                        // Poll for accurate fill data
                        for (let retry = 0; retry < 10; retry++) {
                            await new Promise(resolve => setTimeout(resolve, 200));
                            const status = await this.coinbaseApi.getOrderStatus(orderId);
                            if (status.status === 'FILLED' && status.filledSize > 0) {
                                return {
                                    filledSize: status.filledSize,
                                    averageFilledPrice: status.averageFilledPrice,
                                    orderId: orderId
                                };
                            }
                        }
                        // Assume full fill if can't get data
                        return {
                            filledSize: size,
                            averageFilledPrice: currentPrice,
                            orderId: orderId
                        };
                    }
                    
                    // Check if anything was filled before the error
                    const status = await this.coinbaseApi.getOrderStatus(orderId);
                    if (status.filledSize > 0) {
                        console.log(`[TradePanel ${this.instanceId}] Recovered ${status.filledSize} filled contracts after error`);
                        return {
                            filledSize: status.filledSize,
                            averageFilledPrice: status.averageFilledPrice,
                            orderId: orderId,
                            error: error.message
                        };
                    }
                } catch (cancelError) {
                    console.warn(`[TradePanel ${this.instanceId}] Cancel/status check failed:`, cancelError.message);
                }
            }
            
            return { filledSize: 0, error: error.message };
        }
    }
    
    /**
     * Check if the trading signal is still valid for this direction
     * Used to abort orders when signal changes to opposing direction
     * 
     * @param {string} direction - 'long' or 'short'
     * @returns {boolean} - true if signal is still valid (or neutral), false if opposing
     */
    isSignalStillValid(direction) {
        const currentSignal = this.getCurrentSignal();
        const oppositeSignal = direction === 'long' ? 'sell' : 'buy';
        
        // Signal is invalid ONLY if it's the opposing direction
        // null, 'flat', or matching signal = continue with order
        return currentSignal !== oppositeSignal;
    }
    
    /**
     * Show order progress indicator
     */
    showOrderProgress(action, filled, total) {
        if (this.elements.orderProgress) {
            this.elements.orderProgress.style.display = 'flex';
        }
        if (this.elements.orderProgressText) {
            this.elements.orderProgressText.textContent = action === 'open' ? 'Opening...' : 'Closing...';
        }
        if (this.elements.orderProgressCount) {
            this.elements.orderProgressCount.textContent = `${filled}/${total}`;
        }
        this.setCoinbaseStatus('ordering', `${filled}/${total}`);
    }
    
    /**
     * Hide order progress indicator
     */
    hideOrderProgress() {
        if (this.elements.orderProgress) {
            this.elements.orderProgress.style.display = 'none';
        }
    }
    
    /**
     * Confirm order fill status using REST API
     * 
     * FOK orders complete instantly (within milliseconds), so we use REST polling
     * as the primary method. WebSocket is used for real-time balance updates
     * but not for FOK order confirmation due to race conditions.
     * 
     * @param {string} orderId - Order ID to confirm
     * @returns {object} Confirmation result with status and fill details
     */
    async confirmOrderFill(orderId) {
        // FOK orders complete instantly - use REST API for confirmation
        // WebSocket has race conditions for FOK (order done before we can listen)
        
        // Small delay to let Coinbase process the order
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Poll REST API - FOK should be done, so short timeout
        const restResult = await this.coinbaseApi.pollOrderUntilComplete(orderId, 2000, 50);
        
        return {
            success: restResult.status === 'FILLED',
            status: restResult.status,
            averageFilledPrice: restResult.averageFilledPrice,
            filledSize: restResult.filledSize,
            source: 'rest'
        };
    }
    
    /**
     * Show notification when order fails to fill
     */
    showOrderFailedNotification(direction, result) {
        const message = `⚠️ Failed to ${direction.toUpperCase()} after ${result.attempts || 0} attempts.\n\n` +
            `Error: ${result.error || 'Unknown'}\n` +
            `${result.message || ''}\n\n` +
            `The signal may be stale or liquidity low. Trading will continue when next signal triggers.`;
        
        // Show alert and log
        console.error(`[TradePanel ${this.instanceId}] ORDER FAILED:`, message);
        alert(message);
    }
    
    recalculateStats() {
        this.totalPnl = 0;
        this.shortPnl = 0;
        this.longPnl = 0;
        this.wins = 0;
        this.losses = 0;
        this.peakProfit = 0;
        this.peakLoss = 0;
        
        // Sort trades by exit time to simulate running total for peak calculation
        const closedTrades = this.trades
            .filter(t => !t.isOpen && t.pnl !== null && t.exitTime)
            .sort((a, b) => a.exitTime - b.exitTime);
        
        let runningPnl = 0;
        
        for (const trade of closedTrades) {
            runningPnl += trade.pnl;
            
            // Track P&L by trade type
            if (trade.type === 'short') {
                this.shortPnl += trade.pnl;
            } else if (trade.type === 'long') {
                this.longPnl += trade.pnl;
            }
            
            if (trade.pnl >= 0) {
                this.wins++;
            } else {
                this.losses++;
            }
            
            // Track peak profit and loss based on running total
            if (runningPnl > this.peakProfit) {
                this.peakProfit = runningPnl;
            }
            if (runningPnl < 0 && Math.abs(runningPnl) > this.peakLoss) {
                this.peakLoss = Math.abs(runningPnl);
            }
        }
        
        this.totalPnl = runningPnl;
    }
    
    render() {
        this.renderPosition();
        this.renderSummary();
        this.renderLog();
    }
    
    renderPosition() {
        if (!this.elements.positionValue) return;
        
        if (this.position) {
            this.elements.positionValue.textContent = this.position === 'long' ? 'L' : 'S';
            this.elements.positionValue.className = 'position-value ' + this.position;
            
            if (this.entryPrice) {
                this.elements.entryPrice.textContent = `@ $${this.entryPrice.toFixed(2)}`;
            }
            
            // Show min profit required if onlyCloseInProfit is enabled
            if (this.elements.minProfitRequired && this.onlyCloseInProfit) {
                const hoursInPosition = this.entryTime ? (Date.now() - this.entryTime) / (1000 * 60 * 60) : 0;
                const fundingCost = this.fundingRatePerHour * hoursInPosition;
                const minProfitPercent = this.minProfitThreshold + fundingCost;
                this.elements.minProfitRequired.textContent = `min ${minProfitPercent.toFixed(2)}%`;
                this.elements.minProfitRequired.style.display = 'inline';
            } else if (this.elements.minProfitRequired) {
                this.elements.minProfitRequired.style.display = 'none';
            }
        } else {
            this.elements.positionValue.textContent = 'None';
            this.elements.positionValue.className = 'position-value none';
            this.elements.entryPrice.textContent = '';
            if (this.elements.minProfitRequired) {
                this.elements.minProfitRequired.style.display = 'none';
            }
        }
    }
    
    renderSummary() {
        if (this.elements.pnl) {
            const sign = this.totalPnl >= 0 ? '+' : '';
            this.elements.pnl.textContent = `${sign}$${this.totalPnl.toFixed(2)}`;
            this.elements.pnl.className = 'stat-value ' + (this.totalPnl >= 0 ? 'positive' : 'negative');
        }
        
        if (this.elements.shortPnl) {
            const shortSign = this.shortPnl >= 0 ? '+' : '';
            this.elements.shortPnl.textContent = `${shortSign}$${this.shortPnl.toFixed(2)}`;
            this.elements.shortPnl.className = 'stat-value ' + (this.shortPnl >= 0 ? 'positive' : 'negative');
        }
        
        if (this.elements.longPnl) {
            const longSign = this.longPnl >= 0 ? '+' : '';
            this.elements.longPnl.textContent = `${longSign}$${this.longPnl.toFixed(2)}`;
            this.elements.longPnl.className = 'stat-value ' + (this.longPnl >= 0 ? 'positive' : 'negative');
        }
        
        // Peak Profit / Peak Loss
        if (this.elements.peakProfit) {
            this.elements.peakProfit.textContent = `+$${this.peakProfit.toFixed(2)}`;
            this.elements.peakProfit.className = 'stat-value positive';
        }
        
        if (this.elements.peakLoss) {
            this.elements.peakLoss.textContent = `-$${this.peakLoss.toFixed(2)}`;
            this.elements.peakLoss.className = 'stat-value negative';
        }
        
        // Session Time
        if (this.elements.sessionTime) {
            if (this.sessionStartTime) {
                const elapsed = Date.now() - this.sessionStartTime;
                this.elements.sessionTime.textContent = this.formatDuration(elapsed);
            } else {
                this.elements.sessionTime.textContent = '—';
            }
        }
        
        // Average Trade Length
        if (this.elements.avgTradeLength) {
            const closedTrades = this.trades.filter(t => !t.isOpen && t.duration);
            if (closedTrades.length > 0) {
                const totalDuration = closedTrades.reduce((sum, t) => sum + t.duration, 0);
                const avgDuration = totalDuration / closedTrades.length;
                this.elements.avgTradeLength.textContent = this.formatDuration(avgDuration);
            } else {
                this.elements.avgTradeLength.textContent = '—';
            }
        }
        
        // 30 min PNL / 60 min PNL
        if (this.elements.pnl30min) {
            const pnl30 = this.calculateRecentPnl(30);
            const sign30 = pnl30 >= 0 ? '+' : '';
            this.elements.pnl30min.textContent = `${sign30}$${pnl30.toFixed(2)}`;
            this.elements.pnl30min.className = 'stat-value ' + (pnl30 >= 0 ? 'positive' : 'negative');
        }
        
        if (this.elements.pnl60min) {
            const pnl60 = this.calculateRecentPnl(60);
            const sign60 = pnl60 >= 0 ? '+' : '';
            this.elements.pnl60min.textContent = `${sign60}$${pnl60.toFixed(2)}`;
            this.elements.pnl60min.className = 'stat-value ' + (pnl60 >= 0 ? 'positive' : 'negative');
        }
        
        if (this.elements.wins) {
            this.elements.wins.textContent = this.wins.toString();
        }
        
        if (this.elements.losses) {
            this.elements.losses.textContent = this.losses.toString();
        }
    }
    
    /**
     * Calculate PNL for trades closed within the last N minutes
     */
    calculateRecentPnl(minutes) {
        const cutoffTime = Date.now() - (minutes * 60 * 1000);
        let pnl = 0;
        
        for (const trade of this.trades) {
            if (!trade.isOpen && trade.exitTime && trade.exitTime >= cutoffTime) {
                pnl += trade.pnl || 0;
            }
        }
        
        return pnl;
    }
    
    renderLog() {
        if (!this.elements.log) return;
        
        if (this.trades.length === 0) {
            this.elements.log.innerHTML = '<div class="trade-log-empty">No trades yet</div>';
            return;
        }
        
        let html = '';
        for (const trade of this.trades) {
            const typeLabel = trade.type === 'long' ? 'L' : 'S';
            
            if (trade.isOpen) {
                // Open trade - show live P&L and duration
                const currentPrice = this.app?.currentPrice || trade.entryPrice;
                let livePnl;
                if (trade.type === 'long') {
                    livePnl = currentPrice - trade.entryPrice;
                } else {
                    livePnl = trade.entryPrice - currentPrice;
                }
                const livePnlPercent = (livePnl / trade.entryPrice) * 100;
                const liveDuration = Date.now() - trade.entryTime;
                
                // Calculate estimated fees
                const hoursOpen = liveDuration / (1000 * 60 * 60);
                const estFeePercent = this.minProfitThreshold + (this.fundingRatePerHour * hoursOpen);
                const estFeeDollar = (estFeePercent / 100) * trade.entryPrice;
                const netPnl = livePnl - estFeeDollar;
                const netPnlPercent = livePnlPercent - estFeePercent;
                
                const pnlClass = netPnl >= 0 ? 'profit' : 'loss';
                const grossClass = livePnl >= 0 ? 'profit' : 'loss';
                
                html += `
                    <div class="trade-log-entry open ${pnlClass}" data-trade-id="${trade.id}">
                        <div class="trade-row-top">
                            <span class="trade-type ${trade.type}">${typeLabel}</span>
                            <span class="trade-duration">${this.formatDuration(liveDuration)}</span>
                            <span class="trade-gross ${grossClass}">${livePnl >= 0 ? '+' : '-'}$${Math.abs(livePnl).toFixed(2)} <span class="gross-pct">${livePnlPercent >= 0 ? '+' : ''}${livePnlPercent.toFixed(2)}%</span></span>
                        </div>
                        <div class="trade-row-fee">
                            <span class="trade-fee-icon">−</span>
                            <span class="trade-fee-value">$${estFeeDollar.toFixed(2)} fees <span class="fee-pct">(${estFeePercent.toFixed(2)}%)</span></span>
                        </div>
                        <div class="trade-row-net">
                            <span class="trade-net-label">NET</span>
                            <span class="trade-net-dollar ${pnlClass}">${netPnl >= 0 ? '+' : '-'}$${Math.abs(netPnl).toFixed(2)}</span>
                            <span class="trade-net-percent ${pnlClass}">${netPnlPercent >= 0 ? '+' : ''}${netPnlPercent.toFixed(2)}%</span>
                        </div>
                    </div>
                `;
            } else {
                // Closed trade
                const pnlPercent = trade.pnlPercent || (trade.pnl / trade.entryPrice) * 100;
                const duration = trade.duration || (trade.exitTime - trade.entryTime);
                
                // Calculate fees
                const hoursHeld = duration / (1000 * 60 * 60);
                const feePercent = this.minProfitThreshold + (this.fundingRatePerHour * hoursHeld);
                const feeDollar = (feePercent / 100) * trade.entryPrice;
                const netPnl = trade.pnl - feeDollar;
                const netPnlPercent = pnlPercent - feePercent;
                
                const pnlClass = netPnl >= 0 ? 'profit' : 'loss';
                const grossClass = trade.pnl >= 0 ? 'profit' : 'loss';
                
                html += `
                    <div class="trade-log-entry ${pnlClass}" data-trade-id="${trade.id}">
                        <div class="trade-row-top">
                            <span class="trade-type ${trade.type}">${typeLabel}</span>
                            <span class="trade-duration">${this.formatDuration(duration)}</span>
                            <span class="trade-gross ${grossClass}">${trade.pnl >= 0 ? '+' : '-'}$${Math.abs(trade.pnl).toFixed(2)} <span class="gross-pct">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</span></span>
                        </div>
                        <div class="trade-row-fee">
                            <span class="trade-fee-icon">−</span>
                            <span class="trade-fee-value">$${feeDollar.toFixed(2)} fees <span class="fee-pct">(${feePercent.toFixed(2)}%)</span></span>
                        </div>
                        <div class="trade-row-net">
                            <span class="trade-net-label">NET</span>
                            <span class="trade-net-dollar ${pnlClass}">${netPnl >= 0 ? '+' : '-'}$${Math.abs(netPnl).toFixed(2)}</span>
                            <span class="trade-net-percent ${pnlClass}">${netPnlPercent >= 0 ? '+' : ''}${netPnlPercent.toFixed(2)}%</span>
                        </div>
                    </div>
                `;
            }
        }
        
        this.elements.log.innerHTML = html;
        
        // Bind click events for trade details
        this.elements.log.querySelectorAll('.trade-log-entry').forEach(entry => {
            entry.addEventListener('click', () => {
                const tradeId = parseInt(entry.dataset.tradeId);
                this.showTradeDetail(tradeId);
            });
        });
    }
    
    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }
    
    showTradeDetail(tradeId) {
        const trade = this.trades.find(t => t.id === tradeId);
        if (!trade) return;
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'trade-detail-modal';
        
        const entryTime = new Date(trade.entryTime).toLocaleTimeString();
        
        modal.innerHTML = `
            <div class="trade-detail-backdrop"></div>
            <div class="trade-detail-content">
                <div class="trade-detail-header">
                    <span class="trade-detail-type ${trade.type}">${trade.type.toUpperCase()}</span>
                    ${trade.isOpen ? '<span class="trade-detail-status">OPEN</span>' : '<span class="trade-detail-status closed">CLOSED</span>'}
                    <button class="trade-detail-close">&times;</button>
                </div>
                <div class="trade-detail-body">
                    <div class="trade-detail-row">
                        <span class="detail-label">Entry Price</span>
                        <span class="detail-value">$${trade.entryPrice.toFixed(2)}</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">${trade.isOpen ? 'Current Price' : 'Exit Price'}</span>
                        <span class="detail-value" id="modalExitPrice">—</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Duration</span>
                        <span class="detail-value" id="modalDuration">—</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Entry Time</span>
                        <span class="detail-value">${entryTime}</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Exit Time</span>
                        <span class="detail-value" id="modalExitTime">${trade.isOpen ? 'Active' : new Date(trade.exitTime).toLocaleTimeString()}</span>
                    </div>
                    
                    <div class="trade-detail-divider"></div>
                    
                    <div class="trade-detail-row highlight" id="modalGrossRow">
                        <span class="detail-label">Gross P&L</span>
                        <span class="detail-value" id="modalGrossValue">—</span>
                    </div>
                    
                    <div class="trade-detail-section">
                        <div class="trade-detail-section-title">Fee Settings</div>
                        <div class="trade-detail-inputs">
                            <div class="detail-input-group">
                                <label>Fees %</label>
                                <input type="number" id="modalFeesInput" value="${this.minProfitThreshold}" min="0" step="0.01">
                            </div>
                            <div class="detail-input-group">
                                <label>Fund/hr %</label>
                                <input type="number" id="modalFundingInput" value="${this.fundingRatePerHour}" min="0" step="0.01">
                            </div>
                        </div>
                    </div>
                    
                    <div class="trade-detail-row">
                        <span class="detail-label">Est. Fees</span>
                        <span class="detail-value fee-color" id="modalFeesValue">—</span>
                    </div>
                    
                    <div class="trade-detail-row highlight net-row" id="modalNetRow">
                        <span class="detail-label">Net P&L</span>
                        <span class="detail-value" id="modalNetValue">—</span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Get references to dynamic elements
        const contentEl = modal.querySelector('.trade-detail-content');
        const exitPriceEl = modal.querySelector('#modalExitPrice');
        const grossRowEl = modal.querySelector('#modalGrossRow');
        const grossValueEl = modal.querySelector('#modalGrossValue');
        const feesValueEl = modal.querySelector('#modalFeesValue');
        const netRowEl = modal.querySelector('#modalNetRow');
        const netValueEl = modal.querySelector('#modalNetValue');
        const durationEl = modal.querySelector('#modalDuration');
        const feesInputEl = modal.querySelector('#modalFeesInput');
        const fundingInputEl = modal.querySelector('#modalFundingInput');
        
        // Local copies of thresholds for modal editing
        let modalFees = this.minProfitThreshold;
        let modalFunding = this.fundingRatePerHour;
        
        // Update function for modal values
        const updateModalValues = () => {
            const currentTrade = this.trades.find(t => t.id === tradeId);
            if (!currentTrade) return;
            
            let pnl, pnlPercent, duration, exitPrice;
            
            if (currentTrade.isOpen) {
                // Live values for open trade
                exitPrice = this.app?.currentPrice || currentTrade.entryPrice;
                if (currentTrade.type === 'long') {
                    pnl = exitPrice - currentTrade.entryPrice;
                } else {
                    pnl = currentTrade.entryPrice - exitPrice;
                }
                pnlPercent = (pnl / currentTrade.entryPrice) * 100;
                duration = Date.now() - currentTrade.entryTime;
            } else {
                // Final values for closed trade
                pnl = currentTrade.pnl;
                pnlPercent = currentTrade.pnlPercent || (currentTrade.pnl / currentTrade.entryPrice) * 100;
                duration = currentTrade.duration || (currentTrade.exitTime - currentTrade.entryTime);
                exitPrice = currentTrade.exitPrice;
            }
            
            // Calculate fees
            const hoursHeld = duration / (1000 * 60 * 60);
            const feePercent = modalFees + (modalFunding * hoursHeld);
            const feeDollar = (feePercent / 100) * currentTrade.entryPrice;
            const netPnl = pnl - feeDollar;
            const netPnlPercent = pnlPercent - feePercent;
            
            const grossClass = pnl >= 0 ? 'profit' : 'loss';
            const netClass = netPnl >= 0 ? 'profit' : 'loss';
            const grossSign = pnl >= 0 ? '+' : '';
            const netSign = netPnl >= 0 ? '+' : '-';
            
            // Update DOM
            exitPriceEl.textContent = `$${exitPrice.toFixed(2)}`;
            grossValueEl.textContent = `${grossSign}$${Math.abs(pnl).toFixed(2)} (${grossSign}${pnlPercent.toFixed(2)}%)`;
            feesValueEl.textContent = `-$${feeDollar.toFixed(2)} (${feePercent.toFixed(2)}%)`;
            netValueEl.textContent = `${netSign}$${Math.abs(netPnl).toFixed(2)} (${netPnlPercent >= 0 ? '+' : ''}${netPnlPercent.toFixed(2)}%)`;
            durationEl.textContent = this.formatDuration(duration);
            
            // Update classes
            contentEl.className = `trade-detail-content ${netClass}`;
            grossRowEl.className = `trade-detail-row highlight ${grossClass}`;
            netRowEl.className = `trade-detail-row highlight net-row ${netClass}`;
        };
        
        // Fee input handlers
        feesInputEl.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            modalFees = (!isNaN(val) && val >= 0) ? val : 0.10;
            e.target.value = modalFees;
            this.minProfitThreshold = modalFees;
            if (this.elements.minProfitInput) this.elements.minProfitInput.value = modalFees;
            this.saveState();
            this.renderLog();
            this.renderPosition();
            updateModalValues();
        });
        
        fundingInputEl.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            modalFunding = (!isNaN(val) && val >= 0) ? val : 0.02;
            e.target.value = modalFunding;
            this.fundingRatePerHour = modalFunding;
            if (this.elements.fundingRateInput) this.elements.fundingRateInput.value = modalFunding;
            this.saveState();
            this.renderLog();
            this.renderPosition();
            updateModalValues();
        });
        
        // Initial update
        updateModalValues();
        
        // Set up live updates for open trades
        let updateInterval = null;
        if (trade.isOpen) {
            updateInterval = setInterval(updateModalValues, 100);
        }
        
        // Close handlers
        const closeModal = () => {
            if (updateInterval) clearInterval(updateInterval);
            modal.remove();
        };
        modal.querySelector('.trade-detail-backdrop').addEventListener('click', closeModal);
        modal.querySelector('.trade-detail-close').addEventListener('click', closeModal);
    }
    
    renderLockedSignal() {
        if (!this.elements.lockedSignal) return;
        
        if (this.lockedSignal && this.isRunning) {
            this.elements.lockedSignal.textContent = this.lockedSignal.toUpperCase();
            this.elements.lockedSignal.className = 'locked-signal-value ' + this.lockedSignal;
        } else {
            this.elements.lockedSignal.textContent = '—';
            this.elements.lockedSignal.className = 'locked-signal-value none';
        }
    }
    
    // Called by app when signals update - can be used for more responsive updates
    onSignalUpdate() {
        // The polling interval handles this, but this method allows
        // direct integration if needed for faster response
    }
    
    /**
     * Check if this panel has an active trade (running with open position)
     * Used by app to prompt before symbol change
     */
    hasActiveTrade() {
        return this.isRunning && this.position !== null;
    }
    
    /**
     * Get current symbol this panel is tracking
     */
    getSymbol() {
        return this.currentSymbol;
    }
    
    /**
     * Check if max loss has been exceeded
     * Returns true if trading can continue, false if max loss hit
     */
    checkMaxLoss() {
        if (!this.isPerpMode()) return true; // No limit for simulation
        
        // Check cumulative P&L against max loss
        if (this.totalPnl <= -this.maxLoss) {
            if (!this.maxLossTriggered) {
                this.maxLossTriggered = true;
                this.onMaxLossTriggered();
            }
            return false;
        }
        
        return true;
    }
    
    /**
     * Handle max loss being triggered
     */
    async onMaxLossTriggered() {
        console.error('[TradePanel] MAX LOSS HIT:', this.totalPnl, 'limit:', -this.maxLoss);
        
        // Close any open position immediately
        if (this.position) {
            await this.closePosition('MAX LOSS HIT');
        }
        
        // Stop the simulator
        await this.stop();
        
        // Alert user
        alert(`MAX LOSS TRIGGERED!\n\nYour cumulative P&L ($${this.totalPnl.toFixed(2)}) has exceeded your max loss limit ($${this.maxLoss}).\n\nThe simulator has been stopped.`);
        
        // Add max loss event to trade log
        const maxLossEntry = {
            id: Date.now(),
            type: 'system',
            entryPrice: null,
            exitPrice: null,
            pnl: null,
            entryTime: Date.now(),
            exitTime: Date.now(),
            isOpen: false,
            closeReason: `MAX LOSS HIT: $${this.totalPnl.toFixed(2)} exceeded -$${this.maxLoss}`
        };
        this.trades.unshift(maxLossEntry);
        this.saveState();
        this.renderLog();
    }
}

// Export for use in app.js
window.TradePanel = TradePanel;

