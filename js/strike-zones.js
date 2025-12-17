/**
 * Synthetic Order Book - Strike Zones
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Entry/Exit Zone Calculator
 * Provides clear trade levels based on order book analysis
 */

class StrikeZones {
    constructor() {
        // Current mode
        this.mode = localStorage.getItem('alphaStrikeMode') || 'htf';
        
        // Mode configurations
        this.modeConfig = {
            mm: {
                stopRange: [0.2, 0.5],    // % from entry
                tp1Ratio: 1.5,            // R:R ratio for TP1
                tp2Ratio: 2.5,            // R:R ratio for TP2
                entrySpread: 0.1,         // % spread for entry zone
                description: 'Tight stops (0.2-0.5%)'
            },
            swing: {
                stopRange: [1.0, 2.0],
                tp1Ratio: 2.0,
                tp2Ratio: 3.5,
                entrySpread: 0.3,
                description: 'Medium stops (1-2%)'
            },
            htf: {
                stopRange: [3.0, 5.0],
                tp1Ratio: 2.5,
                tp2Ratio: 5.0,
                entrySpread: 0.5,
                description: 'Wide stops (3-5%)'
            }
        };
        
        // Current position
        this.position = null; // 'long' or 'short'
        
        // Current zones
        this.zones = {
            direction: null,
            entry: { low: 0, high: 0 },
            stop: 0,
            stopPct: 0,
            tp1: 0,
            tp1Pct: 0,
            tp2: 0,
            tp2Pct: 0,
            rr: 0,
            riskSize: 0
        };
        
        // Market data
        this.currentPrice = 0;
        this.symbol = 'BTC';
        
        // DOM elements
        this.elements = null;
        
        // Initialize
        this.init();
    }
    
    /**
     * Initialize
     */
    init() {
        this.cacheElements();
        this.setupPositionButtons();
        this.setupCopyButton();
        this.updateModeUI();
    }
    
    /**
     * Cache DOM elements
     */
    cacheElements() {
        this.elements = {
            panel: document.getElementById('strikeZonesPanel'),
            container: document.getElementById('strikeZones'),
            directionBadge: document.getElementById('zonesDirectionBadge'),
            positionLong: document.getElementById('positionLong'),
            positionShort: document.getElementById('positionShort'),
            entry: document.getElementById('zoneEntry'),
            stop: document.getElementById('zoneStop'),
            stopPct: document.getElementById('zoneStopPct'),
            tp1: document.getElementById('zoneTP1'),
            tp1Pct: document.getElementById('zoneTP1Pct'),
            tp2: document.getElementById('zoneTP2'),
            tp2Pct: document.getElementById('zoneTP2Pct'),
            rr: document.getElementById('zonesRR'),
            riskSize: document.getElementById('zonesRiskSize'),
            copyBtn: document.getElementById('zonesCopyBtn'),
            showOnChart: document.getElementById('showTradeOnChart'),
            modeValue: document.getElementById('zonesMode'),
            modeDesc: document.getElementById('zonesModeDesc')
        };
        
        // Debug: log what we found
        if (!this.elements.panel) {
            console.log('[Strike Zones] Panel not found - element IDs may not match HTML');
        }
    }
    
    /**
     * Setup position selector buttons
     */
    setupPositionButtons() {
        if (this.elements.positionLong) {
            this.elements.positionLong.addEventListener('click', () => {
                this.setPosition('long');
            });
        }
        
        if (this.elements.positionShort) {
            this.elements.positionShort.addEventListener('click', () => {
                this.setPosition('short');
            });
        }
    }
    
    /**
     * Setup copy button
     */
    setupCopyButton() {
        if (this.elements.copyBtn) {
            this.elements.copyBtn.addEventListener('click', () => {
                this.copyLevels();
            });
        }
    }
    
    /**
     * Set trading mode
     */
    setMode(mode) {
        if (!this.modeConfig[mode]) return;
        
        this.mode = mode;
        this.updateModeUI();
        this.recalculate();
    }
    
    /**
     * Update mode UI
     */
    updateModeUI() {
        const config = this.modeConfig[this.mode];
        
        if (this.elements.modeValue) {
            this.elements.modeValue.textContent = this.mode.toUpperCase();
        }
        
        if (this.elements.modeDesc) {
            this.elements.modeDesc.textContent = config.description;
        }
    }
    
    /**
     * Set current position (long/short)
     */
    setPosition(position) {
        // Toggle if same position clicked
        if (this.position === position) {
            this.position = null;
        } else {
            this.position = position;
        }
        
        // Update button states
        if (this.elements.positionLong) {
            this.elements.positionLong.classList.toggle('active', this.position === 'long');
        }
        if (this.elements.positionShort) {
            this.elements.positionShort.classList.toggle('active', this.position === 'short');
        }
        
        // Recalculate zones
        this.recalculate();
        
        // Sync with chart if available
        if (window.app && window.app.chart) {
            window.app.chart.setUserPosition(this.position ? this.position.toUpperCase() : null);
        }
    }
    
    /**
     * Update with market data
     * @param {Object} data - { currentPrice, levels, forecast, signal }
     */
    update(data) {
        if (!data) return;
        
        this.currentPrice = data.currentPrice || this.currentPrice;
        this.symbol = data.symbol || this.symbol;
        this.marketData = data;
        
        // Auto-set position from Alpha Strike if none selected
        if (data.signal && !this.position) {
            if (data.signal.direction === 'long' || data.signal.direction === 'short') {
                this.autoPosition = data.signal.direction;
            } else {
                this.autoPosition = null;
            }
        }
        
        // Update direction badge
        this.updateDirectionBadge();
        
        // Recalculate with position or auto-position
        this.recalculate();
    }
    
    /**
     * Update recommendation display
     */
    updateRecommendation(signal) {
        if (!this.elements.recommendedDirection) return;
        
        if (signal.direction === 'long') {
            this.elements.recommendedDirection.textContent = 'LONG';
            this.elements.recommendedDirection.className = 'rec-value long';
        } else if (signal.direction === 'short') {
            this.elements.recommendedDirection.textContent = 'SHORT';
            this.elements.recommendedDirection.className = 'rec-value short';
        } else {
            this.elements.recommendedDirection.textContent = 'WAIT';
            this.elements.recommendedDirection.className = 'rec-value';
        }
    }
    
    /**
     * Update direction badge
     */
    updateDirectionBadge() {
        const badge = this.elements.directionBadge;
        if (!badge) return;
        
        const dir = this.position || this.autoPosition;
        if (dir === 'long') {
            badge.textContent = 'LONG';
            badge.className = 'sz-dir long';
        } else if (dir === 'short') {
            badge.textContent = 'SHORT';
            badge.className = 'sz-dir short';
        } else {
            badge.textContent = '--';
            badge.className = 'sz-dir';
        }
    }
    
    /**
     * Recalculate zones based on current data
     */
    recalculate() {
        const activePosition = this.position || this.autoPosition;
        
        if (!this.currentPrice || !activePosition) {
            this.clearZones();
            return;
        }
        
        const config = this.modeConfig[this.mode];
        const price = this.currentPrice;
        
        // Calculate entry zone
        const entrySpread = price * (config.entrySpread / 100);
        
        // Get support/resistance from market data if available
        let support = null;
        let resistance = null;
        
        if (this.marketData && this.marketData.forecast) {
            const fc = this.marketData.forecast;
            if (fc.short) {
                support = fc.short.support ? fc.short.support.price : null;
                resistance = fc.short.resistance ? fc.short.resistance.price : null;
            }
        }
        
        if (activePosition === 'long') {
            // Long position zones
            this.zones.direction = 'long';
            
            // Entry zone - slightly below current price or at support
            const entryBase = support && support < price ? 
                Math.max(support, price * (1 - config.stopRange[0] / 100)) : price;
            this.zones.entry = {
                low: entryBase - entrySpread,
                high: entryBase + entrySpread
            };
            
            // Stop loss - below entry
            const stopPct = (config.stopRange[0] + config.stopRange[1]) / 2;
            this.zones.stop = entryBase * (1 - stopPct / 100);
            this.zones.stopPct = -stopPct;
            
            // Calculate risk (entry to stop)
            const riskAmount = entryBase - this.zones.stop;
            
            // Take profits
            this.zones.tp1 = entryBase + (riskAmount * config.tp1Ratio);
            this.zones.tp1Pct = ((this.zones.tp1 - entryBase) / entryBase) * 100;
            
            this.zones.tp2 = entryBase + (riskAmount * config.tp2Ratio);
            this.zones.tp2Pct = ((this.zones.tp2 - entryBase) / entryBase) * 100;
            
            // Risk/Reward
            this.zones.rr = config.tp1Ratio;
            
        } else if (activePosition === 'short') {
            // Short position zones
            this.zones.direction = 'short';
            
            // Entry zone - slightly above current price or at resistance
            const entryBase = resistance && resistance > price ?
                Math.min(resistance, price * (1 + config.stopRange[0] / 100)) : price;
            this.zones.entry = {
                low: entryBase - entrySpread,
                high: entryBase + entrySpread
            };
            
            // Stop loss - above entry
            const stopPct = (config.stopRange[0] + config.stopRange[1]) / 2;
            this.zones.stop = entryBase * (1 + stopPct / 100);
            this.zones.stopPct = stopPct;
            
            // Calculate risk (stop to entry)
            const riskAmount = this.zones.stop - entryBase;
            
            // Take profits
            this.zones.tp1 = entryBase - (riskAmount * config.tp1Ratio);
            this.zones.tp1Pct = -((entryBase - this.zones.tp1) / entryBase) * 100;
            
            this.zones.tp2 = entryBase - (riskAmount * config.tp2Ratio);
            this.zones.tp2Pct = -((entryBase - this.zones.tp2) / entryBase) * 100;
            
            // Risk/Reward
            this.zones.rr = config.tp1Ratio;
        }
        
        // Calculate position size for 1% risk
        // Assuming 1% of $10,000 account = $100 risk
        const riskDollars = 100; // 1% of $10k
        const stopDistance = Math.abs(this.currentPrice - this.zones.stop);
        this.zones.riskSize = stopDistance > 0 ? riskDollars / stopDistance : 0;
        
        // Render
        this.render();
    }
    
    /**
     * Clear zones display
     */
    clearZones() {
        this.zones = {
            direction: null,
            entry: { low: 0, high: 0 },
            stop: 0,
            stopPct: 0,
            tp1: 0,
            tp1Pct: 0,
            tp2: 0,
            tp2Pct: 0,
            rr: 0,
            riskSize: 0
        };
        this.render();
    }
    
    /**
     * Render zones to UI
     */
    render() {
        // Entry - show midpoint for compactness
        if (this.elements.entry) {
            if (this.zones.entry.low && this.zones.entry.high) {
                const mid = (this.zones.entry.low + this.zones.entry.high) / 2;
                this.elements.entry.textContent = `$${this.formatPrice(mid)}`;
            } else {
                this.elements.entry.textContent = '$--';
            }
        }
        
        // Stop loss
        if (this.elements.stop) {
            this.elements.stop.textContent = this.zones.stop ? 
                `$${this.formatPrice(this.zones.stop)}` : '$--';
        }
        if (this.elements.stopPct) {
            this.elements.stopPct.textContent = this.zones.stopPct ? 
                `${this.zones.stopPct.toFixed(1)}%` : '--%';
        }
        
        // Take Profit 1
        if (this.elements.tp1) {
            this.elements.tp1.textContent = this.zones.tp1 ? 
                `$${this.formatPrice(this.zones.tp1)}` : '$--';
        }
        if (this.elements.tp1Pct) {
            this.elements.tp1Pct.textContent = this.zones.tp1Pct ? 
                `+${Math.abs(this.zones.tp1Pct).toFixed(1)}%` : '+%';
        }
        
        // Take Profit 2
        if (this.elements.tp2) {
            this.elements.tp2.textContent = this.zones.tp2 ? 
                `$${this.formatPrice(this.zones.tp2)}` : '$--';
        }
        if (this.elements.tp2Pct) {
            this.elements.tp2Pct.textContent = this.zones.tp2Pct ? 
                `+${Math.abs(this.zones.tp2Pct).toFixed(1)}%` : '+%';
        }
        
        // Risk/Reward
        if (this.elements.rr) {
            this.elements.rr.textContent = this.zones.rr ? 
                `1:${this.zones.rr.toFixed(1)}` : '1:--';
        }
        
        // Risk size
        if (this.elements.riskSize) {
            this.elements.riskSize.textContent = this.zones.riskSize ? 
                `${this.zones.riskSize.toFixed(4)} ${this.symbol}` : `-- ${this.symbol}`;
        }
    }
    
    /**
     * Copy levels to clipboard
     */
    copyLevels() {
        if (!this.zones.direction) {
            this.showCopyFeedback(false);
            return;
        }
        
        const text = [
            `${this.zones.direction.toUpperCase()} ${this.symbol}`,
            `Entry: $${this.formatPrice(this.zones.entry.low)} - $${this.formatPrice(this.zones.entry.high)}`,
            `Stop: $${this.formatPrice(this.zones.stop)} (${this.zones.stopPct.toFixed(1)}%)`,
            `TP1: $${this.formatPrice(this.zones.tp1)} (+${Math.abs(this.zones.tp1Pct).toFixed(1)}%)`,
            `TP2: $${this.formatPrice(this.zones.tp2)} (+${Math.abs(this.zones.tp2Pct).toFixed(1)}%)`,
            `R:R 1:${this.zones.rr.toFixed(1)}`,
            `Mode: ${this.mode.toUpperCase()}`
        ].join('\n');
        
        navigator.clipboard.writeText(text).then(() => {
            this.showCopyFeedback(true);
        }).catch(() => {
            this.showCopyFeedback(false);
        });
    }
    
    /**
     * Show copy feedback
     */
    showCopyFeedback(success) {
        if (!this.elements.copyBtn) return;
        
        const btn = this.elements.copyBtn;
        const originalText = btn.innerHTML;
        
        if (success) {
            btn.classList.add('copied');
            btn.innerHTML = '<span class="copy-icon">✓</span><span class="copy-text">COPIED!</span>';
        } else {
            btn.innerHTML = '<span class="copy-icon">✗</span><span class="copy-text">SELECT POSITION</span>';
        }
        
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = originalText;
        }, 2000);
    }
    
    /**
     * Format price for display
     */
    formatPrice(price) {
        if (!price) return '--';
        if (price >= 1000) {
            return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
        }
        return price.toFixed(2);
    }
    
    /**
     * Get current zones for external use
     */
    getZones() {
        return { ...this.zones };
    }
    
    /**
     * Get current position
     */
    getPosition() {
        return this.position;
    }
}

// Global instance
const strikeZones = new StrikeZones();

