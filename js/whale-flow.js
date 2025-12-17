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
        // Current mode
        this.mode = localStorage.getItem('alphaStrikeMode') || 'htf';
        
        // Mode-based thresholds (in BTC) - adjusted for real market activity
        this.thresholds = {
            mm: { notable: 0.05, large: 0.2, whale: 0.5 },      // More sensitive for scalping
            swing: { notable: 0.1, large: 0.5, whale: 2.0 },    // Medium trades
            htf: { notable: 0.5, large: 2.0, whale: 5.0 }       // Only big trades matter
        };
        
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
     * Initialize
     */
    init() {
        this.cacheElements();
        this.updateThresholdUI();
    }
    
    /**
     * Cache DOM elements
     */
    cacheElements() {
        this.elements = {
            panel: document.getElementById('whaleFlowPanel'),
            threshold: document.getElementById('whaleThreshold'),
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
        if (this.elements.threshold) {
            const threshold = this.thresholds[this.mode].notable;
            this.elements.threshold.textContent = `>${threshold} BTC`;
        }
    }
    
    /**
     * Filter trades by current threshold
     */
    filterTradesByThreshold() {
        const threshold = this.thresholds[this.mode].notable;
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
        
        const threshold = this.thresholds[this.mode];
        const size = parseFloat(tradeSize);
        
        // Only track trades above notable threshold
        if (size < threshold.notable) return;
        
        // Classify trade
        let tag = 'notable';
        if (size >= threshold.whale) tag = 'whale';
        else if (size >= threshold.large) tag = 'large';
        
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
            <span class="whale-trade-size">${trade.size.toFixed(2)} BTC</span>
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
                <span class="whale-trade-size">${trade.size.toFixed(2)} BTC</span>
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

