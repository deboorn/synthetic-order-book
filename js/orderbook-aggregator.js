/**
 * Synthetic Order Book - Aggregator
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Client-side clustering, filtering, and formatting of order book data
 * Mirrors the PHP backend logic for seamless fallback
 */
class OrderBookAggregator {
    constructor() {
        this.settings = {
            clusterPct: 0.15,      // Price clustering percentage
            maxLevels: 50,         // Maximum levels to return
            minVolume: 0,          // Minimum volume filter
            priceRangePct: 100     // Price range percentage from mid
        };
    }
    
    /**
     * Update aggregation settings
     */
    setSettings(settings) {
        Object.assign(this.settings, settings);
    }
    
    /**
     * Process raw order book data from WebSocket
     * Returns format identical to PHP API response
     */
    process(rawBook, currentPrice = null) {
        if (!rawBook || (!rawBook.bids.length && !rawBook.asks.length)) {
            return null;
        }
        
        const price = currentPrice || rawBook.price || rawBook.bestBid || 0;
        
        // Step 1: Cluster levels by price
        let bids = this.clusterLevels(rawBook.bids, this.settings.clusterPct, price);
        let asks = this.clusterLevels(rawBook.asks, this.settings.clusterPct, price);
        
        // Step 2: Apply filters
        bids = this.applyFilters(bids, price);
        asks = this.applyFilters(asks, price);
        
        // Step 3: Sort and limit
        bids = bids.sort((a, b) => b.price - a.price).slice(0, this.settings.maxLevels);
        asks = asks.sort((a, b) => a.price - b.price).slice(0, this.settings.maxLevels);
        
        // Step 4: Calculate volumes and stats
        const bidVolume = bids.reduce((sum, b) => sum + b.volume, 0);
        const askVolume = asks.reduce((sum, a) => sum + a.volume, 0);
        const totalVolume = bidVolume + askVolume;
        
        // Step 5: Format levels for chart compatibility
        const levels = this.formatLevels(bids, asks, bidVolume, askVolume, totalVolume);
        
        return {
            levels,
            price,
            bidVolume,
            askVolume,
            imbalance: ((bidVolume - askVolume) / (totalVolume || 1) * 100).toFixed(1),
            sources: rawBook.sources || [],
            timestamp: rawBook.timestamp || Date.now(),
            isWebSocket: true,
            clustered: this.settings.clusterPct > 0
        };
    }
    
    /**
     * Cluster nearby price levels together
     */
    clusterLevels(levels, clusterPct, midPrice) {
        if (clusterPct <= 0 || levels.length === 0) {
            return levels.map(l => ({
                price: l.price,
                volume: l.volume,
                type: l.type,
                sources: l.sources || [],
                count: 1
            }));
        }
        
        const clusters = new Map();
        const clusterSize = midPrice * (clusterPct / 100);
        
        for (const level of levels) {
            // Calculate cluster key (round to nearest cluster)
            const clusterKey = Math.round(level.price / clusterSize) * clusterSize;
            
            if (clusters.has(clusterKey)) {
                const existing = clusters.get(clusterKey);
                // Weighted average price
                const totalVol = existing.volume + level.volume;
                existing.price = (existing.price * existing.volume + level.price * level.volume) / totalVol;
                existing.volume = totalVol;
                existing.count++;
                // Merge sources
                if (level.sources) {
                    for (const src of level.sources) {
                        if (!existing.sources.includes(src)) {
                            existing.sources.push(src);
                        }
                    }
                }
            } else {
                clusters.set(clusterKey, {
                    price: level.price,
                    volume: level.volume,
                    type: level.type,
                    sources: level.sources ? [...level.sources] : [],
                    count: 1
                });
            }
        }
        
        return Array.from(clusters.values());
    }
    
    /**
     * Apply volume and price range filters
     */
    applyFilters(levels, midPrice) {
        return levels.filter(level => {
            // Min volume filter
            if (level.volume < this.settings.minVolume) {
                return false;
            }
            
            // Price range filter
            if (this.settings.priceRangePct < 100 && midPrice > 0) {
                const rangeLimit = midPrice * (this.settings.priceRangePct / 100);
                const priceDiff = Math.abs(level.price - midPrice);
                if (priceDiff > rangeLimit) {
                    return false;
                }
            }
            
            return true;
        });
    }
    
    /**
     * Format levels for chart display
     * Matches PHP API output format exactly
     * Chart expects type: 'support' or 'resistance'
     */
    formatLevels(bids, asks, bidVolume, askVolume, totalVolume) {
        const levels = [];
        const maxVolume = Math.max(
            ...bids.map(b => b.volume),
            ...asks.map(a => a.volume),
            1
        );
        
        // Process bids (support levels)
        for (const bid of bids) {
            levels.push({
                price: bid.price,
                volume: bid.volume,
                type: 'support',  // Chart expects 'support' not 'bid'
                side: 'bid',
                strength: bid.volume / maxVolume,
                percentOfTotal: (bid.volume / totalVolume * 100).toFixed(2),
                sources: bid.sources,
                clustered: bid.count > 1,
                clusterCount: bid.count
            });
        }
        
        // Process asks (resistance levels)
        for (const ask of asks) {
            levels.push({
                price: ask.price,
                volume: ask.volume,
                type: 'resistance',  // Chart expects 'resistance' not 'ask'
                side: 'ask',
                strength: ask.volume / maxVolume,
                percentOfTotal: (ask.volume / totalVolume * 100).toFixed(2),
                sources: ask.sources,
                clustered: ask.count > 1,
                clusterCount: ask.count
            });
        }
        
        return levels;
    }
    
    /**
     * Get unclustered book (for full book analytics)
     * Applies only minimal filtering, no clustering
     */
    processFullBook(rawBook, currentPrice = null) {
        if (!rawBook || (!rawBook.bids.length && !rawBook.asks.length)) {
            return null;
        }
        
        const price = currentPrice || rawBook.price || rawBook.bestBid || 0;
        
        // No clustering, just convert format
        // Chart expects type: 'support' / 'resistance'
        let bids = rawBook.bids.map(b => ({
            price: b.price,
            volume: b.volume,
            type: 'support',
            sources: b.sources || []
        }));
        
        let asks = rawBook.asks.map(a => ({
            price: a.price,
            volume: a.volume,
            type: 'resistance',
            sources: a.sources || []
        }));
        
        // Sort
        bids = bids.sort((a, b) => b.price - a.price);
        asks = asks.sort((a, b) => a.price - b.price);
        
        // Calculate volumes
        const bidVolume = bids.reduce((sum, b) => sum + b.volume, 0);
        const askVolume = asks.reduce((sum, a) => sum + a.volume, 0);
        const totalVolume = bidVolume + askVolume;
        
        // Format levels
        const levels = this.formatLevels(
            bids.map(b => ({ ...b, count: 1 })),
            asks.map(a => ({ ...a, count: 1 })),
            bidVolume, askVolume, totalVolume
        );
        
        return {
            levels,
            price,
            bidVolume,
            askVolume,
            imbalance: ((bidVolume - askVolume) / (totalVolume || 1) * 100).toFixed(1),
            sources: rawBook.sources || [],
            timestamp: rawBook.timestamp || Date.now(),
            isWebSocket: true,
            clustered: false
        };
    }
    
    /**
     * Process raw order book for depth chart visualization
     * Converts to cumulative format expected by DepthChart
     * 
     * Creates a "valley" shape: cumulative near 0 at mid-price, grows outward
     * - Bids: Start at best bid (high), accumulate as price drops
     * - Asks: Start at best ask (low), accumulate as price rises
     */
    processDepth(rawBook, currentPrice = null) {
        if (!rawBook || (!rawBook.bids?.length && !rawBook.asks?.length)) {
            return {
                bids: [],
                asks: [],
                price: currentPrice || 0
            };
        }
        
        const midPrice = currentPrice || rawBook.price || rawBook.bestBid || 0;
        
        // CRITICAL: Filter outliers to prevent scale distortion
        // Only include orders within ±20% of mid-price
        const priceRangePct = 0.20;
        const minPrice = midPrice * (1 - priceRangePct);
        const maxPrice = midPrice * (1 + priceRangePct);
        
        // Filter and validate bids (must be below mid-price, within range)
        const filteredBids = [...(rawBook.bids || [])]
            .filter(bid => {
                return bid && 
                       typeof bid.price === 'number' && 
                       typeof bid.volume === 'number' &&
                       !isNaN(bid.price) && 
                       !isNaN(bid.volume) &&
                       bid.price > 0 &&
                       bid.volume > 0 &&
                       bid.price >= minPrice &&  // Filter outliers
                       bid.price <= midPrice;    // Bids should be at or below mid
            });
        
        // Filter and validate asks (must be above mid-price, within range)
        const filteredAsks = [...(rawBook.asks || [])]
            .filter(ask => {
                return ask && 
                       typeof ask.price === 'number' && 
                       typeof ask.volume === 'number' &&
                       !isNaN(ask.price) && 
                       !isNaN(ask.volume) &&
                       ask.price > 0 &&
                       ask.volume > 0 &&
                       ask.price <= maxPrice &&  // Filter outliers
                       ask.price >= midPrice;    // Asks should be at or above mid
            });
        
        // BIDS: Sort DESCENDING (high→low) - start at best bid, accumulate downward
        // This creates valley shape: small cumulative near mid, large at edges
        const sortedBids = filteredBids.sort((a, b) => b.price - a.price);
        
        // ASKS: Sort ASCENDING (low→high) - start at best ask, accumulate upward
        // This creates valley shape: small cumulative near mid, large at edges
        const sortedAsks = filteredAsks.sort((a, b) => a.price - b.price);
        
        // Calculate cumulative volumes for bids (from best bid downward)
        let cumulativeBid = 0;
        const bids = sortedBids.map(bid => {
            cumulativeBid += bid.volume;
            return {
                price: bid.price,
                volume: bid.volume,
                cumulative: cumulativeBid
            };
        });
        
        // Calculate cumulative volumes for asks (from best ask upward)
        let cumulativeAsk = 0;
        const asks = sortedAsks.map(ask => {
            cumulativeAsk += ask.volume;
            return {
                price: ask.price,
                volume: ask.volume,
                cumulative: cumulativeAsk
            };
        });
        
        return {
            bids,
            asks,
            price: midPrice
        };
    }
}

// Export singleton instance
const orderBookAggregator = new OrderBookAggregator();

