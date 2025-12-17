/**
 * Synthetic Order Book - Trade Aggregator
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Aggregates real-time trades from multiple exchanges into price-level buckets
 * for Volume Delta Footprint visualization
 */

class TradeAggregator {
    constructor() {
        // barTime => { priceLevels: Map<bucketPrice, {buyVol, sellVol}>, totalBuyVol, totalSellVol }
        this.bars = new Map();
        this.currentBarTime = null;
        this.bucketSize = parseInt(localStorage.getItem('tradeFootprintBucketSize') || '10');
        this.maxBars = 200;
        this.symbol = 'BTC';
        this.interval = '1m';
        
        // Callbacks
        this.onUpdate = null;
        this.onBarFinalized = null;
        
        // Stats for current bar
        this.currentBarStats = {
            tradeCount: 0,
            totalVolume: 0,
            netDelta: 0
        };
    }
    
    /**
     * Set the trading symbol
     */
    setSymbol(symbol) {
        if (this.symbol !== symbol) {
            this.symbol = symbol;
            this.clear();
            this.loadFromStorage();
        }
    }
    
    /**
     * Set the chart interval
     */
    setInterval(interval) {
        if (this.interval !== interval) {
            this.interval = interval;
            this.clear();
            this.loadFromStorage();
        }
    }
    
    /**
     * Set bucket size in USD
     */
    setBucketSize(size) {
        this.bucketSize = parseInt(size) || 10;
        localStorage.setItem('tradeFootprintBucketSize', this.bucketSize);
    }
    
    /**
     * Get the bucket price for a given trade price
     */
    getBucketPrice(price) {
        return Math.floor(price / this.bucketSize) * this.bucketSize;
    }
    
    /**
     * Get the bar time for a given timestamp
     */
    getBarTime(timestamp) {
        const intervalSeconds = this.getIntervalSeconds();
        return Math.floor(timestamp / intervalSeconds) * intervalSeconds;
    }
    
    /**
     * Convert interval string to seconds
     */
    getIntervalSeconds() {
        const map = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        return map[this.interval] || 60;
    }
    
    /**
     * Add a trade to the aggregator
     * @param {Object} trade - { price, volume, side: 'buy'|'sell', exchange, timestamp }
     */
    addTrade(trade) {
        if (!trade || !trade.price || !trade.volume) return;
        
        const timestamp = trade.timestamp || Math.floor(Date.now() / 1000);
        const barTime = this.getBarTime(timestamp);
        const bucketPrice = this.getBucketPrice(trade.price);
        
        // Check if we've moved to a new bar
        if (this.currentBarTime !== null && barTime !== this.currentBarTime) {
            this.finalizeBar(this.currentBarTime);
        }
        this.currentBarTime = barTime;
        
        // Get or create bar data
        if (!this.bars.has(barTime)) {
            this.bars.set(barTime, {
                priceLevels: new Map(),
                totalBuyVol: 0,
                totalSellVol: 0,
                tradeCount: 0
            });
        }
        
        const barData = this.bars.get(barTime);
        
        // Get or create price level
        if (!barData.priceLevels.has(bucketPrice)) {
            barData.priceLevels.set(bucketPrice, {
                buyVol: 0,
                sellVol: 0,
                tradeCount: 0
            });
        }
        
        const level = barData.priceLevels.get(bucketPrice);
        const volume = parseFloat(trade.volume) || 0;
        
        // Add volume to appropriate side
        if (trade.side === 'buy') {
            level.buyVol += volume;
            barData.totalBuyVol += volume;
        } else {
            level.sellVol += volume;
            barData.totalSellVol += volume;
        }
        
        level.tradeCount++;
        barData.tradeCount++;
        
        // Update current bar stats
        this.currentBarStats.tradeCount = barData.tradeCount;
        this.currentBarStats.totalVolume = barData.totalBuyVol + barData.totalSellVol;
        this.currentBarStats.netDelta = barData.totalBuyVol - barData.totalSellVol;
        
        // Notify listeners
        if (this.onUpdate) {
            this.onUpdate(barTime, this.getFootprintData(barTime));
        }
    }
    
    /**
     * Finalize a bar (called when bar closes)
     */
    finalizeBar(barTime) {
        if (!this.bars.has(barTime)) return;
        
        // Trim old bars if needed
        this.trimOldBars();
        
        // Save to storage
        this.saveToStorage();
        
        // Notify listeners
        if (this.onBarFinalized) {
            this.onBarFinalized(barTime, this.getFootprintData(barTime));
        }
        
        // Reset current bar stats
        this.currentBarStats = {
            tradeCount: 0,
            totalVolume: 0,
            netDelta: 0
        };
    }
    
    /**
     * Get footprint data for a bar
     * @returns {Array} Array of { price, buyVol, sellVol, delta, totalVol, intensity }
     */
    getFootprintData(barTime) {
        const barData = this.bars.get(barTime);
        if (!barData) return [];
        
        const result = [];
        let maxDelta = 0;
        let maxVolume = 0;
        
        // First pass: collect data and find max values
        barData.priceLevels.forEach((level, price) => {
            const delta = level.buyVol - level.sellVol;
            const totalVol = level.buyVol + level.sellVol;
            maxDelta = Math.max(maxDelta, Math.abs(delta));
            maxVolume = Math.max(maxVolume, totalVol);
            
            result.push({
                price: price,
                buyVol: level.buyVol,
                sellVol: level.sellVol,
                delta: delta,
                totalVol: totalVol,
                tradeCount: level.tradeCount
            });
        });
        
        // Second pass: calculate intensity (0-1)
        result.forEach(level => {
            // Intensity based on delta magnitude relative to max
            level.deltaIntensity = maxDelta > 0 ? Math.abs(level.delta) / maxDelta : 0;
            // Size based on total volume relative to max
            level.volumeIntensity = maxVolume > 0 ? level.totalVol / maxVolume : 0;
        });
        
        // Sort by price descending (resistance at top)
        result.sort((a, b) => b.price - a.price);
        
        return result;
    }
    
    /**
     * Get all bars data for chart rendering
     * @returns {Map} barTime => footprintData
     */
    getAllFootprintData() {
        const result = new Map();
        this.bars.forEach((_, barTime) => {
            result.set(barTime, this.getFootprintData(barTime));
        });
        return result;
    }
    
    /**
     * Get current bar statistics
     */
    getCurrentBarStats() {
        return { ...this.currentBarStats };
    }
    
    /**
     * Trim old bars to stay within maxBars limit
     */
    trimOldBars() {
        if (this.bars.size <= this.maxBars) return;
        
        // Get sorted bar times
        const sortedTimes = Array.from(this.bars.keys()).sort((a, b) => a - b);
        
        // Remove oldest bars
        const toRemove = sortedTimes.slice(0, this.bars.size - this.maxBars);
        toRemove.forEach(time => this.bars.delete(time));
    }
    
    /**
     * Clear all data
     */
    clear() {
        this.bars.clear();
        this.currentBarTime = null;
        this.currentBarStats = {
            tradeCount: 0,
            totalVolume: 0,
            netDelta: 0
        };
    }
    
    /**
     * Get storage key for persistence
     */
    getStorageKey() {
        return `tradeFootprint_${this.symbol}_${this.interval}`;
    }
    
    /**
     * Save to localStorage
     */
    saveToStorage() {
        try {
            const data = {};
            this.bars.forEach((barData, barTime) => {
                const levels = [];
                barData.priceLevels.forEach((level, price) => {
                    levels.push({
                        p: price,
                        b: Math.round(level.buyVol * 10000) / 10000,
                        s: Math.round(level.sellVol * 10000) / 10000,
                        c: level.tradeCount
                    });
                });
                data[barTime] = {
                    l: levels,
                    tb: Math.round(barData.totalBuyVol * 10000) / 10000,
                    ts: Math.round(barData.totalSellVol * 10000) / 10000,
                    tc: barData.tradeCount
                };
            });
            
            localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
        } catch (e) {
            console.warn('[TradeAggregator] Failed to save to storage:', e);
        }
    }
    
    /**
     * Load from localStorage
     */
    loadFromStorage() {
        try {
            const saved = localStorage.getItem(this.getStorageKey());
            if (!saved) return;
            
            const data = JSON.parse(saved);
            
            Object.entries(data).forEach(([barTime, barData]) => {
                const priceLevels = new Map();
                barData.l.forEach(level => {
                    priceLevels.set(level.p, {
                        buyVol: level.b,
                        sellVol: level.s,
                        tradeCount: level.c
                    });
                });
                
                this.bars.set(parseInt(barTime), {
                    priceLevels: priceLevels,
                    totalBuyVol: barData.tb,
                    totalSellVol: barData.ts,
                    tradeCount: barData.tc
                });
            });
            
            console.log(`[TradeAggregator] Loaded ${this.bars.size} bars from storage`);
        } catch (e) {
            console.warn('[TradeAggregator] Failed to load from storage:', e);
        }
    }
    
    /**
     * Handle new bar opened event
     */
    onNewBarOpened(barTime) {
        if (this.currentBarTime !== null && this.currentBarTime !== barTime) {
            this.finalizeBar(this.currentBarTime);
        }
        this.currentBarTime = barTime;
    }
}

// Global instance
const tradeAggregator = new TradeAggregator();



