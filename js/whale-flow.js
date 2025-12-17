/**
 * Synthetic Order Book - Whale Flow Tape
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Real-time large trade detection and visualization
 * Tracks whale activity to confirm or warn against signals
 */

class WhaleFlow {
    constructor() {
        // Current symbol
        this.symbol = (localStorage.getItem('selectedSymbol') || 'BTC').toUpperCase();
        
        // Current mode
        this.mode = localStorage.getItem('alphaStrikeMode') || 'htf';
        
        // Mode-based thresholds - symbol-aware (values in base currency units)
        // Thresholds are adjusted based on typical trade sizes for each symbol
        this.thresholds = this.getSymbolThresholds(this.symbol);
        
        // Custom threshold override (null = use mode default)
        this.customThreshold = parseFloat(localStorage.getItem('whaleCustomThreshold')) || null;
        
        // Trade history
        this.trades = [];
        this.maxTrades = 50;
        
        // CVD (Cumulative Volume Delta)
        this.cvd = 0;
        this.cvdHistory = [];
        this.cvdWindowMs = 300000; // 5 minutes
        
        // Stats
        this.stats = {
            buyVolume: 0,
            sellVolume: 0,
            buyCount: 0,
            sellCount: 0,
            lastUpdate: Date.now()
        };
        
        // Smart money detection
        this.smartMoneyAlert = null;
        
        // DOM elements
        this.elements = null;
        
        // Callbacks
        this.onWhaleDetected = null;
        this.onSmartMoneyAlert = null;
        
        // Initialize
        this.init();
    }
    
    /**
     * Get symbol-specific thresholds
     * Returns thresholds adjusted for typical trade sizes per symbol
     */
    getSymbolThresholds(symbol) {
        const baseThresholds = {
            mm: { notable: 0.05, large: 0.2, whale: 0.5 },
            swing: { notable: 0.1, large: 0.5, whale: 2.0 },
            htf: { notable: 0.5, large: 2.0, whale: 5.0 }
        };
        
        // Symbol multipliers based on typical price ranges and trade sizes
        // Higher value coins (BTC, ETH) use base thresholds
        // Lower value coins (DOGE, SHIB) need higher thresholds
        const multipliers = {
            'BTC': 1.0,
            'ETH': 1.0,
            'SOL': 1.0,
            'XRP': 10.0,
            'DOGE': 100.0,
            'ADA': 10.0,
            'AVAX': 1.0,
            'DOT': 1.0,
            'LINK': 1.0,
            'LTC': 1.0,
            'MATIC': 10.0,
            'UNI': 1.0,
            'ATOM': 1.0,
            'FIL': 1.0,
            'APT': 1.0,
            'ARB': 10.0,
            'OP': 1.0,
            'NEAR': 1.0,
            'SHIB': 1000.0,
            'BCH': 1.0,
            'SUI': 1.0
        };
        
        const multiplier = multipliers[symbol] || 1.0;
        
        // Apply multiplier to all thresholds
        const thresholds = {};
        for (const mode in baseThresholds) {
            thresholds[mode] = {};
            for (const tier in baseThresholds[mode]) {
                thresholds[mode][tier] = baseThresholds[mode][tier] * multiplier;
            }
        }
        
        return thresholds;
    }
    
    /**
     * Initialize
     */
    init() {
        this.cacheElements();
        this.setupThresholdInput();
        this.updateThresholdUI();
    }
    
    /**
     * Cache DOM elements
     */
    cacheElements() {
        this.elements = {
            panel: document.getElementById('whaleFlowPanel'),
            threshold: document.getElementById('whaleThreshold'),
            thresholdUnit: document.getElementById('whaleThresholdUnit'),
            cvdBuy: document.getElementById('whaleCvdBuy'),
            cvdSell: document.getElementById('whaleCvdSell'),
            cvdValue: document.getElementById('whaleCvdValue'),
            tape: document.getElementById('whaleTape'),
            dominantSide: document.getElementById('whaleDominantSide'),
            dominantPct: document.getElementById('whaleDominantPct'),
            alert: document.getElementById('whaleAlert'),
            status: document.getElementById('whaleFlowStatus')
        };
    }
    
    /**
     * Setup threshold input interactivity
     */
    setupThresholdInput() {
        const input = this.elements.threshold;
        
        if (!input) return;
        
        // Handle input changes (on blur and Enter key)
        input.addEventListener('blur', () => {
            this.handleThresholdInput();
        });
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
        
        // Prevent invalid input
        input.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            if (value < 0) {
                e.target.value = '0';
            }
        });
    }
    
    /**
     * Handle threshold input change
     */
    handleThresholdInput() {
        const input = this.elements.threshold;
        if (!input) return;
        
        const value = parseFloat(input.value);
        if (isNaN(value) || value < 0) {
            // Reset to current threshold if invalid
            this.updateThresholdUI();
            return;
        }
        
        this.setCustomThreshold(value);
    }
    
    /**
     * Set custom threshold override
     */
    setCustomThreshold(value) {
        this.customThreshold = value;
        localStorage.setItem('whaleCustomThreshold', value);
        this.updateThresholdUI();
        this.filterTradesByThreshold();
    }
    
    /**
     * Get current active threshold
     */
    getActiveThreshold() {
        return this.customThreshold !== null 
            ? this.customThreshold 
            : this.thresholds[this.mode].notable;
    }
    
    /**
     * Set symbol and update thresholds
     */
    setSymbol(symbol) {
        const newSymbol = (symbol || 'BTC').toUpperCase();
        if (newSymbol === this.symbol) return;
        
        this.symbol = newSymbol;
        this.thresholds = this.getSymbolThresholds(this.symbol);
        
        // Clear existing trades when symbol changes (different asset, different context)
        this.clear();
        
        this.updateThresholdUI();
    }
    
    /**
     * Set mode and update thresholds
     */
    setMode(mode) {
        if (!this.thresholds[mode]) return;
        
        this.mode = mode;
        this.updateThresholdUI();
        
        // Re-filter existing trades
        this.filterTradesByThreshold();
    }
    
    /**
     * Update threshold display
     */
    updateThresholdUI() {
        const threshold = this.getActiveThreshold();
        
        // Update input value with current threshold
        if (this.elements.threshold) {
            // Format threshold for input (no ">" prefix, just the number)
            let formattedThreshold;
            if (threshold >= 1000) {
                formattedThreshold = threshold.toLocaleString('en-US', { maximumFractionDigits: 0 });
            } else if (threshold >= 1) {
                formattedThreshold = threshold.toFixed(2);
            } else {
                formattedThreshold = threshold.toFixed(4);
            }
            this.elements.threshold.value = formattedThreshold;
        }
        
        // Update unit label with current symbol
        if (this.elements.thresholdUnit) {
            this.elements.thresholdUnit.textContent = this.symbol;
        }
    }
    
    /**
     * Filter trades by current threshold
     */
    filterTradesByThreshold() {
        const threshold = this.getActiveThreshold();
        this.trades = this.trades.filter(t => t.size >= threshold);
        this.renderTape();
    }
    
    /**
     * Add a new trade
     * Called from tradeAggregator or websocket
     * @param {Object} trade - { price, size/volume, side: 'buy'|'sell', exchange, timestamp }
     */
    addTrade(trade) {
        if (!trade || !trade.price) return;
        
        // Handle both 'size' and 'volume' field names
        const tradeSize = trade.size || trade.volume;
        if (!tradeSize) return;
        
        const modeThresholds = this.thresholds[this.mode];
        const activeThreshold = this.getActiveThreshold();
        const size = parseFloat(tradeSize);
        
        // Only track trades above active threshold (custom or mode-based)
        if (size < activeThreshold) return;
        
        // Classify trade based on mode thresholds for tier display
        let tag = 'notable';
        if (size >= modeThresholds.whale) tag = 'whale';
        else if (size >= modeThresholds.large) tag = 'large';
        
        const tradeRecord = {
            id: Date.now() + Math.random(),
            price: trade.price,
            size: size,
            side: trade.side || 'buy',
            exchange: trade.exchange || 'unknown',
            timestamp: trade.timestamp || Date.now(),
            tag: tag
        };
        
        // Add to trades list
        this.trades.unshift(tradeRecord);
        if (this.trades.length > this.maxTrades) {
            this.trades.pop();
        }
        
        // Update CVD
        this.updateCVD(tradeRecord);
        
        // Update stats
        this.updateStats(tradeRecord);
        
        // Check for smart money
        this.checkSmartMoney(tradeRecord);
        
        // Render
        this.renderTrade(tradeRecord);
        this.renderSummary();
        
        // Callbacks
        if (tag === 'whale' && this.onWhaleDetected) {
            this.onWhaleDetected(tradeRecord);
        }
    }
    
    /**
     * Update CVD with new trade
     */
    updateCVD(trade) {
        const delta = trade.side === 'buy' ? trade.size : -trade.size;
        
        // Add to history
        this.cvdHistory.push({
            delta: delta,
            timestamp: trade.timestamp
        });
        
        // Remove old entries
        const cutoff = Date.now() - this.cvdWindowMs;
        this.cvdHistory = this.cvdHistory.filter(h => h.timestamp > cutoff);
        
        // Recalculate CVD
        this.cvd = this.cvdHistory.reduce((sum, h) => sum + h.delta, 0);
    }
    
    /**
     * Update statistics
     */
    updateStats(trade) {
        if (trade.side === 'buy') {
            this.stats.buyVolume += trade.size;
            this.stats.buyCount++;
        } else {
            this.stats.sellVolume += trade.size;
            this.stats.sellCount++;
        }
        this.stats.lastUpdate = Date.now();
    }
    
    /**
     * Check for smart money patterns
     * Detects when whales trade against retail flow
     */
    checkSmartMoney(trade) {
        // Need some history
        if (this.trades.length < 5) return;
        
        const recentTrades = this.trades.slice(0, 10);
        const recentBuys = recentTrades.filter(t => t.side === 'buy');
        const recentSells = recentTrades.filter(t => t.side === 'sell');
        
        // Calculate recent retail bias
        const retailBuyVol = recentBuys.filter(t => t.tag === 'notable').reduce((s, t) => s + t.size, 0);
        const retailSellVol = recentSells.filter(t => t.tag === 'notable').reduce((s, t) => s + t.size, 0);
        const retailBias = retailBuyVol > retailSellVol ? 'buy' : 'sell';
        
        // Check if this whale is going against retail
        if (trade.tag === 'whale' || trade.tag === 'large') {
            if ((retailBias === 'buy' && trade.side === 'sell') ||
                (retailBias === 'sell' && trade.side === 'buy')) {
                
                this.smartMoneyAlert = {
                    side: trade.side,
                    size: trade.size,
                    timestamp: Date.now(),
                    message: `🐋 Whale ${trade.side.toUpperCase()} against retail`
                };
                
                if (this.onSmartMoneyAlert) {
                    this.onSmartMoneyAlert(this.smartMoneyAlert);
                }
            }
        }
        
        // Clear old alerts
        if (this.smartMoneyAlert && Date.now() - this.smartMoneyAlert.timestamp > 30000) {
            this.smartMoneyAlert = null;
        }
    }
    
    /**
     * Render a single trade to the tape
     */
    renderTrade(trade) {
        if (!this.elements.tape) return;
        
        // Remove empty state message
        const empty = this.elements.tape.querySelector('.whale-tape-empty');
        if (empty) empty.remove();
        
        // Create trade element
        const el = document.createElement('div');
        el.className = `whale-trade ${trade.side}`;
        el.dataset.id = trade.id;
        
        // Time ago
        const timeAgo = this.formatTimeAgo(trade.timestamp);
        
        el.innerHTML = `
            <span class="whale-trade-side">${trade.side === 'buy' ? '🟢' : '🔴'} ${trade.side.toUpperCase()}</span>
            <span class="whale-trade-size">${this.formatSize(trade.size)} ${this.symbol}</span>
            <span class="whale-trade-price">$${this.formatPrice(trade.price)}</span>
            <span class="whale-trade-time">${timeAgo}</span>
            ${trade.tag !== 'notable' ? `<span class="whale-trade-tag ${trade.tag}">${trade.tag}</span>` : ''}
        `;
        
        // Insert at top
        this.elements.tape.insertBefore(el, this.elements.tape.firstChild);
        
        // Remove excess elements
        while (this.elements.tape.children.length > this.maxTrades) {
            this.elements.tape.removeChild(this.elements.tape.lastChild);
        }
    }
    
    /**
     * Render full tape (on mode change)
     */
    renderTape() {
        if (!this.elements.tape) return;
        
        // Clear tape
        this.elements.tape.innerHTML = '';
        
        if (this.trades.length === 0) {
            this.elements.tape.innerHTML = '<div class="whale-tape-empty">Waiting for large trades...</div>';
            return;
        }
        
        // Render all trades
        this.trades.forEach(trade => {
            const el = document.createElement('div');
            el.className = `whale-trade ${trade.side}`;
            el.dataset.id = trade.id;
            
            const timeAgo = this.formatTimeAgo(trade.timestamp);
            
            el.innerHTML = `
                <span class="whale-trade-side">${trade.side === 'buy' ? '🟢' : '🔴'} ${trade.side.toUpperCase()}</span>
                <span class="whale-trade-size">${this.formatSize(trade.size)} ${this.symbol}</span>
                <span class="whale-trade-price">$${this.formatPrice(trade.price)}</span>
                <span class="whale-trade-time">${timeAgo}</span>
                ${trade.tag !== 'notable' ? `<span class="whale-trade-tag ${trade.tag}">${trade.tag}</span>` : ''}
            `;
            
            this.elements.tape.appendChild(el);
        });
    }
    
    /**
     * Render summary (CVD, dominant side)
     */
    renderSummary() {
        // CVD gauge
        if (this.elements.cvdBuy && this.elements.cvdSell) {
            const total = this.stats.buyVolume + this.stats.sellVolume;
            if (total > 0) {
                const buyPct = (this.stats.buyVolume / total) * 100;
                const sellPct = (this.stats.sellVolume / total) * 100;
                this.elements.cvdBuy.style.width = buyPct + '%';
                this.elements.cvdSell.style.width = sellPct + '%';
            }
        }
        
        // CVD value
        if (this.elements.cvdValue) {
            const cvdFormatted = this.cvd >= 0 ? `+${this.cvd.toFixed(2)}` : this.cvd.toFixed(2);
            this.elements.cvdValue.textContent = cvdFormatted;
            this.elements.cvdValue.className = `cvd-value ${this.cvd >= 0 ? 'positive' : 'negative'}`;
        }
        
        // Dominant side
        if (this.elements.dominantSide) {
            const total = this.stats.buyVolume + this.stats.sellVolume;
            if (total > 0) {
                const buyPct = (this.stats.buyVolume / total) * 100;
                const sellPct = (this.stats.sellVolume / total) * 100;
                
                if (buyPct > 55) {
                    this.elements.dominantSide.textContent = 'BUYERS';
                    this.elements.dominantSide.className = 'dominant-side buyers';
                    if (this.elements.dominantPct) {
                        this.elements.dominantPct.textContent = `(${buyPct.toFixed(0)}%)`;
                    }
                } else if (sellPct > 55) {
                    this.elements.dominantSide.textContent = 'SELLERS';
                    this.elements.dominantSide.className = 'dominant-side sellers';
                    if (this.elements.dominantPct) {
                        this.elements.dominantPct.textContent = `(${sellPct.toFixed(0)}%)`;
                    }
                } else {
                    this.elements.dominantSide.textContent = 'MIXED';
                    this.elements.dominantSide.className = 'dominant-side neutral';
                    if (this.elements.dominantPct) {
                        this.elements.dominantPct.textContent = '';
                    }
                }
            }
        }
        
        // Smart money alert
        if (this.elements.alert) {
            if (this.smartMoneyAlert) {
                this.elements.alert.textContent = this.smartMoneyAlert.message;
                this.elements.alert.className = 'whale-alert smart-money';
            } else {
                this.elements.alert.textContent = '';
                this.elements.alert.className = 'whale-alert';
            }
        }
    }
    
    /**
     * Format time ago
     */
    formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm';
        const hours = Math.floor(minutes / 60);
        return hours + 'h';
    }
    
    /**
     * Format size (volume) based on magnitude
     */
    formatSize(size) {
        if (size >= 1000) {
            return size.toLocaleString('en-US', { maximumFractionDigits: 0 });
        } else if (size >= 1) {
            return size.toFixed(2);
        } else if (size >= 0.01) {
            return size.toFixed(4);
        } else {
            return size.toFixed(6);
        }
    }
    
    /**
     * Format price
     */
    formatPrice(price) {
        if (price >= 1000) {
            return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
        }
        return price.toFixed(2);
    }
    
    /**
     * Update tape times (call periodically)
     */
    updateTimes() {
        if (!this.elements.tape) return;
        
        const trades = this.elements.tape.querySelectorAll('.whale-trade');
        trades.forEach(el => {
            const id = el.dataset.id;
            const trade = this.trades.find(t => String(t.id) === id);
            if (trade) {
                const timeEl = el.querySelector('.whale-trade-time');
                if (timeEl) {
                    timeEl.textContent = this.formatTimeAgo(trade.timestamp);
                }
            }
        });
    }
    
    /**
     * Get current stats for external use
     */
    getStats() {
        return {
            ...this.stats,
            cvd: this.cvd,
            recentTrades: this.trades.slice(0, 10),
            smartMoneyAlert: this.smartMoneyAlert
        };
    }
    
    /**
     * Clear all data
     */
    clear() {
        this.trades = [];
        this.cvd = 0;
        this.cvdHistory = [];
        this.stats = {
            buyVolume: 0,
            sellVolume: 0,
            buyCount: 0,
            sellCount: 0,
            lastUpdate: Date.now()
        };
        this.smartMoneyAlert = null;
        this.renderTape();
        this.renderSummary();
    }
}

// Global instance
const whaleFlow = new WhaleFlow();

