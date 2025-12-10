/**
 * Synthetic Order Book - Database Cache
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * IndexedDB Cache Layer for Order Book Data
 * All data is keyed by symbol to prevent mixing
 */
class OrderBookDB {
    constructor() {
        this.dbName = 'OrderBookCache';
        this.version = 3; // Bump version to add historicalLevels store
        this.db = null;
        this.symbol = 'BTC';
        this.stores = {
            levels: 'levels',
            klines: 'klines',
            depth: 'depth',
            snapshots: 'snapshots',
            historicalLevels: 'historicalLevels'
        };
    }

    setSymbol(symbol) {
        this.symbol = symbol.toUpperCase();
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Delete old stores to start fresh
                for (const storeName of db.objectStoreNames) {
                    db.deleteObjectStore(storeName);
                }

                // Levels store - for support/resistance levels
                const levelsStore = db.createObjectStore(this.stores.levels, { keyPath: 'key' });
                levelsStore.createIndex('timestamp', 'timestamp');

                // Klines store - for OHLCV data (keyed by symbol_timeframe)
                const klinesStore = db.createObjectStore(this.stores.klines, { keyPath: 'key' });
                klinesStore.createIndex('timestamp', 'timestamp');

                // Depth store - for order book depth snapshots
                const depthStore = db.createObjectStore(this.stores.depth, { keyPath: 'key' });
                depthStore.createIndex('timestamp', 'timestamp');

                // Snapshots store - for periodic order book snapshots
                const snapshotsStore = db.createObjectStore(this.stores.snapshots, { keyPath: 'id', autoIncrement: true });
                snapshotsStore.createIndex('symbol', 'symbol');
                snapshotsStore.createIndex('timestamp', 'timestamp');
                
                // Historical levels store - for level footprints on chart
                const historicalStore = db.createObjectStore(this.stores.historicalLevels, { keyPath: 'id', autoIncrement: true });
                historicalStore.createIndex('symbol', 'symbol');
                historicalStore.createIndex('candleTime', 'candleTime');
                historicalStore.createIndex('symbol_candleTime', ['symbol', 'candleTime']);
            };
        });
    }

    // Generic get
    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Generic put
    async put(storeName, data) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Generic getAll
    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    // Clear store
    async clear(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Clear all stores
    async clearAll() {
        for (const storeName of Object.values(this.stores)) {
            await this.clear(storeName);
        }
    }

    // Save levels with timestamp - keyed by symbol
    async saveLevels(levels, sources) {
        const data = {
            key: `levels_${this.symbol}`,
            symbol: this.symbol,
            timestamp: Date.now(),
            levels: levels,
            sources: sources
        };
        return this.put(this.stores.levels, data);
    }

    // Get latest levels for current symbol
    async getLatestLevels() {
        return this.get(this.stores.levels, `levels_${this.symbol}`);
    }

    // Save klines - keyed by symbol and timeframe
    async saveKlines(timeframe, klines) {
        const data = {
            key: `klines_${this.symbol}_${timeframe}`,
            symbol: this.symbol,
            timeframe: timeframe,
            timestamp: Date.now(),
            data: klines
        };
        return this.put(this.stores.klines, data);
    }

    // Get klines for current symbol
    async getKlines(timeframe) {
        return this.get(this.stores.klines, `klines_${this.symbol}_${timeframe}`);
    }

    // Save depth snapshot - keyed by symbol
    async saveDepth(depth) {
        const data = {
            key: `depth_${this.symbol}`,
            symbol: this.symbol,
            timestamp: Date.now(),
            ...depth
        };
        return this.put(this.stores.depth, data);
    }

    // Get depth for current symbol
    async getDepth() {
        return this.get(this.stores.depth, `depth_${this.symbol}`);
    }

    // Save order book snapshot for historical analysis
    async saveSnapshot(levels, price) {
        const data = {
            symbol: this.symbol,
            timestamp: Date.now(),
            price: price,
            levels: levels
        };
        await this.put(this.stores.snapshots, data);
    }

    // Get cache stats
    async getStats() {
        const stats = {};
        for (const [name, storeName] of Object.entries(this.stores)) {
            try {
                const records = await this.getAll(storeName);
                stats[name] = {
                    count: records.length,
                    size: JSON.stringify(records).length
                };
            } catch (e) {
                stats[name] = { count: 0, size: 0 };
            }
        }
        return stats;
    }
    
    // ========================================
    // Historical Levels Methods
    // ========================================
    
    /**
     * Save a historical level (when a level disappears or moves)
     * @param {Object} level - The level data {price, volume, type}
     * @param {number} candleTime - The candle timestamp this level belongs to
     */
    async saveHistoricalLevel(level, candleTime) {
        const data = {
            symbol: this.symbol,
            price: parseFloat(level.price),
            volume: parseFloat(level.volume),
            type: level.type, // 'support' or 'resistance'
            candleTime: candleTime,
            recordedAt: Date.now()
        };
        return this.put(this.stores.historicalLevels, data);
    }
    
    /**
     * Save multiple historical levels at once
     * @param {Array} levels - Array of level objects
     * @param {number} candleTime - The candle timestamp
     * @param {string} interval - The chart interval (e.g., '1m', '5m')
     */
    async saveHistoricalLevels(levels, candleTime, interval = '1m') {
        const tx = this.db.transaction(this.stores.historicalLevels, 'readwrite');
        const store = tx.objectStore(this.stores.historicalLevels);
        
        // Use symbol_interval as the key to separate data by timeframe
        const symbolKey = `${this.symbol}_${interval}`;
        
        for (const level of levels) {
            const data = {
                symbol: symbolKey,  // Include interval in symbol key
                price: parseFloat(level.price),
                volume: parseFloat(level.volume),
                type: level.type,
                candleTime: candleTime,
                recordedAt: Date.now()
            };
            store.put(data);
        }
        
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
    
    /**
     * Get all historical levels for current symbol and interval
     * @param {string} interval - The chart interval (e.g., '1m', '5m')
     */
    async getHistoricalLevels(interval = '1m') {
        const symbolKey = `${this.symbol}_${interval}`;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.stores.historicalLevels, 'readonly');
            const store = tx.objectStore(this.stores.historicalLevels);
            const index = store.index('symbol');
            const request = index.getAll(symbolKey);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    
    /**
     * Get historical levels for a specific candle time
     * @param {number} candleTime - The candle timestamp
     */
    async getHistoricalLevelsForCandle(candleTime) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.stores.historicalLevels, 'readonly');
            const store = tx.objectStore(this.stores.historicalLevels);
            const index = store.index('symbol_candleTime');
            const request = index.getAll([this.symbol, candleTime]);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }
    
    /**
     * Clean up historical levels older than specified days
     * @param {number} maxAgeDays - Maximum age in days (default 7)
     */
    async cleanupHistoricalLevels(maxAgeDays = 7) {
        const cutoffTime = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.stores.historicalLevels, 'readwrite');
            const store = tx.objectStore(this.stores.historicalLevels);
            const request = store.openCursor();
            let deletedCount = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (cursor.value.recordedAt < cutoffTime) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                }
            };
            
            tx.oncomplete = () => {
                if (deletedCount > 0) {
                    console.log(`[DB] Cleaned up ${deletedCount} old historical levels`);
                }
                resolve(deletedCount);
            };
            tx.onerror = () => reject(tx.error);
        });
    }
    
    /**
     * Clear all historical levels for current symbol
     */
    async clearHistoricalLevels() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.stores.historicalLevels, 'readwrite');
            const store = tx.objectStore(this.stores.historicalLevels);
            const index = store.index('symbol');
            const request = index.openCursor(IDBKeyRange.only(this.symbol));
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

// Global instance
const db = new OrderBookDB();
