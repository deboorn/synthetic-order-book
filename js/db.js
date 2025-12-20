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
        this.version = 4; // Bump version to add signalMarkers, tradePanelTrades, tradeFootprint stores
        this.db = null;
        this.symbol = 'BTC';
        this.stores = {
            levels: 'levels',
            klines: 'klines',
            depth: 'depth',
            snapshots: 'snapshots',
            historicalLevels: 'historicalLevels',
            signalMarkers: 'signalMarkers',
            tradePanelTrades: 'tradePanelTrades',
            tradeFootprint: 'tradeFootprint'
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
                
                // Signal markers store - for live/cluster proximity, drift, bulls bears markers
                const signalMarkersStore = db.createObjectStore(this.stores.signalMarkers, { keyPath: 'key' });
                signalMarkersStore.createIndex('type', 'type');
                signalMarkersStore.createIndex('timestamp', 'timestamp');
                
                // Trade panel trades store - for trade history per simulator
                const tradePanelStore = db.createObjectStore(this.stores.tradePanelTrades, { keyPath: 'key' });
                tradePanelStore.createIndex('instanceId', 'instanceId');
                tradePanelStore.createIndex('timestamp', 'timestamp');
                
                // Trade footprint store - for volume delta footprint data
                const tradeFootprintStore = db.createObjectStore(this.stores.tradeFootprint, { keyPath: 'key' });
                tradeFootprintStore.createIndex('symbol', 'symbol');
                tradeFootprintStore.createIndex('timestamp', 'timestamp');
            };
        });
    }

    // Generic get
    async get(storeName, key) {
        if (!this.db) {
            console.warn('[DB] Database not initialized, skipping get');
            return null;
        }
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
        if (!this.db) {
            console.warn('[DB] Database not initialized, skipping put');
            return null;
        }
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
        if (!this.db) {
            console.warn('[DB] Database not initialized, skipping clear');
            return;
        }
        return new Promise((resolve, reject) => {
            try {
                const tx = this.db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                const request = store.clear();
                request.onsuccess = () => {
                    console.log(`[DB] Cleared store: ${storeName}`);
                    resolve();
                };
                request.onerror = () => reject(request.error);
            } catch (e) {
                console.warn(`[DB] Failed to clear store ${storeName}:`, e);
                resolve(); // Don't fail the whole operation
            }
        });
    }

    // Clear all stores
    async clearAll() {
        console.log('[DB] Clearing all stores...');
        const storeNames = Object.values(this.stores);
        for (const storeName of storeNames) {
            try {
                await this.clear(storeName);
            } catch (e) {
                console.warn(`[DB] Error clearing ${storeName}:`, e);
            }
        }
        console.log(`[DB] Cleared ${storeNames.length} stores`);
    }
    
    // Delete entire database (for complete reset)
    async deleteDatabase() {
        console.log('[DB] Deleting database...');
        
        // Close existing connection
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(this.dbName);
            request.onsuccess = () => {
                console.log('[DB] Database deleted successfully');
                resolve(true);
            };
            request.onerror = () => {
                console.warn('[DB] Failed to delete database:', request.error);
                reject(request.error);
            };
            request.onblocked = () => {
                console.warn('[DB] Database delete blocked - other connections may be open');
                resolve(false);
            };
        });
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
    
    // ========================================
    // Signal Markers Methods (migrated from localStorage)
    // ========================================
    
    /**
     * Save signal markers for a specific type
     * @param {string} type - Marker type (bullsBears, clusterProximity, clusterDrift, liveProximity, liveDrift)
     * @param {Array} markers - Array of marker objects
     */
    async saveSignalMarkers(type, markers) {
        try {
            const data = {
                key: `markers_${this.symbol}_${type}`,
                symbol: this.symbol,
                type: type,
                markers: markers,
                timestamp: Date.now()
            };
            return await this.put(this.stores.signalMarkers, data);
        } catch (e) {
            console.warn(`[DB] Failed to save ${type} markers:`, e);
        }
    }
    
    /**
     * Get signal markers for a specific type
     * @param {string} type - Marker type
     * @returns {Array} Array of marker objects or empty array
     */
    async getSignalMarkers(type) {
        try {
            const result = await this.get(this.stores.signalMarkers, `markers_${this.symbol}_${type}`);
            return result?.markers || [];
        } catch (e) {
            console.warn(`[DB] Failed to get ${type} markers:`, e);
            return [];
        }
    }
    
    /**
     * Clear all signal markers for current symbol
     */
    async clearSignalMarkers() {
        const types = ['bullsBears', 'clusterProximity', 'clusterDrift', 'liveProximity', 'liveDrift', 'lvSignal'];
        for (const type of types) {
            try {
                const tx = this.db.transaction(this.stores.signalMarkers, 'readwrite');
                const store = tx.objectStore(this.stores.signalMarkers);
                store.delete(`markers_${this.symbol}_${type}`);
            } catch (e) {
                // Ignore errors
            }
        }
    }
    
    // ========================================
    // Trade Panel Trades Methods (migrated from localStorage)
    // ========================================
    
    /**
     * Save trades for a trade panel instance
     * @param {string} instanceId - Trade panel instance ID (e.g., '1', '2', etc.)
     * @param {Array} trades - Array of trade objects
     */
    async saveTradePanelTrades(instanceId, trades) {
        try {
            const data = {
                key: `trades_${instanceId}`,
                instanceId: instanceId,
                trades: trades,
                timestamp: Date.now()
            };
            return await this.put(this.stores.tradePanelTrades, data);
        } catch (e) {
            console.warn(`[DB] Failed to save trades for panel ${instanceId}:`, e);
        }
    }
    
    /**
     * Get trades for a trade panel instance
     * @param {string} instanceId - Trade panel instance ID
     * @returns {Array} Array of trade objects or empty array
     */
    async getTradePanelTrades(instanceId) {
        try {
            const result = await this.get(this.stores.tradePanelTrades, `trades_${instanceId}`);
            return result?.trades || [];
        } catch (e) {
            console.warn(`[DB] Failed to get trades for panel ${instanceId}:`, e);
            return [];
        }
    }
    
    /**
     * Clear trades for a specific trade panel
     * @param {string} instanceId - Trade panel instance ID
     */
    async clearTradePanelTrades(instanceId) {
        try {
            const tx = this.db.transaction(this.stores.tradePanelTrades, 'readwrite');
            const store = tx.objectStore(this.stores.tradePanelTrades);
            store.delete(`trades_${instanceId}`);
        } catch (e) {
            console.warn(`[DB] Failed to clear trades for panel ${instanceId}:`, e);
        }
    }
    
    // ========================================
    // Trade Footprint Methods (migrated from localStorage)
    // ========================================
    
    /**
     * Save trade footprint data
     * @param {string} interval - Chart interval (e.g., '1m', '5m')
     * @param {Object} data - Footprint data object (bars map serialized)
     */
    async saveTradeFootprint(interval, data) {
        try {
            const record = {
                key: `footprint_${this.symbol}_${interval}`,
                symbol: this.symbol,
                interval: interval,
                data: data,
                timestamp: Date.now()
            };
            return await this.put(this.stores.tradeFootprint, record);
        } catch (e) {
            console.warn(`[DB] Failed to save trade footprint for ${this.symbol}_${interval}:`, e);
        }
    }
    
    /**
     * Get trade footprint data
     * @param {string} interval - Chart interval
     * @returns {Object} Footprint data or null
     */
    async getTradeFootprint(interval) {
        try {
            const result = await this.get(this.stores.tradeFootprint, `footprint_${this.symbol}_${interval}`);
            return result?.data || null;
        } catch (e) {
            console.warn(`[DB] Failed to get trade footprint for ${this.symbol}_${interval}:`, e);
            return null;
        }
    }
    
    /**
     * Clear trade footprint for current symbol and interval
     * @param {string} interval - Chart interval
     */
    async clearTradeFootprint(interval) {
        try {
            const tx = this.db.transaction(this.stores.tradeFootprint, 'readwrite');
            const store = tx.objectStore(this.stores.tradeFootprint);
            store.delete(`footprint_${this.symbol}_${interval}`);
        } catch (e) {
            console.warn(`[DB] Failed to clear trade footprint:`, e);
        }
    }
    
    // ========================================
    // Migration from localStorage
    // ========================================
    
    /**
     * Migrate data from localStorage to IndexedDB (one-time)
     * Call this after init() on app startup
     */
    async migrateFromLocalStorage() {
        const migrationKey = 'indexeddb_migration_v4';
        if (localStorage.getItem(migrationKey) === 'done') {
            return; // Already migrated
        }
        
        console.log('[DB] Starting migration from localStorage to IndexedDB...');
        let migratedCount = 0;
        
        try {
            // Migrate signal markers
            const markerTypes = [
                { key: 'bullsBearsMarkers', type: 'bullsBears' },
                { key: 'clusterProximityMarkers', type: 'clusterProximity' },
                { key: 'clusterDriftMarkers', type: 'clusterDrift' },
                { key: 'liveProximityMarkers', type: 'liveProximity' },
                { key: 'liveDriftMarkers', type: 'liveDrift' }
            ];
            
            for (const { key, type } of markerTypes) {
                const saved = localStorage.getItem(key);
                if (saved) {
                    try {
                        const markers = JSON.parse(saved);
                        if (markers && markers.length > 0) {
                            await this.saveSignalMarkers(type, markers);
                            localStorage.removeItem(key);
                            migratedCount++;
                            console.log(`[DB] Migrated ${markers.length} ${type} markers`);
                        }
                    } catch (e) {
                        console.warn(`[DB] Failed to migrate ${key}:`, e);
                    }
                }
            }
            
            // Migrate trade panel trades (8 panels)
            for (let i = 1; i <= 8; i++) {
                const key = `tradeSim${i}Trades`;
                const saved = localStorage.getItem(key);
                if (saved) {
                    try {
                        const trades = JSON.parse(saved);
                        if (trades && trades.length > 0) {
                            await this.saveTradePanelTrades(String(i), trades);
                            localStorage.removeItem(key);
                            migratedCount++;
                            console.log(`[DB] Migrated ${trades.length} trades for panel ${i}`);
                        }
                    } catch (e) {
                        console.warn(`[DB] Failed to migrate trades for panel ${i}:`, e);
                    }
                }
            }
            
            // Migrate trade footprint data
            const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI'];
            const intervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
            const originalSymbol = this.symbol; // Save original symbol
            
            for (const symbol of symbols) {
                for (const interval of intervals) {
                    const key = `tradeFootprint_${symbol}_${interval}`;
                    const saved = localStorage.getItem(key);
                    if (saved) {
                        try {
                            const data = JSON.parse(saved);
                            if (data && Object.keys(data).length > 0) {
                                this.setSymbol(symbol);
                                await this.saveTradeFootprint(interval, data);
                                localStorage.removeItem(key);
                                migratedCount++;
                                console.log(`[DB] Migrated footprint for ${symbol}_${interval}`);
                            }
                        } catch (e) {
                            console.warn(`[DB] Failed to migrate footprint ${key}:`, e);
                        }
                    }
                }
            }
            
            // Restore original symbol
            this.setSymbol(originalSymbol);
            
            // Mark migration as complete
            localStorage.setItem(migrationKey, 'done');
            console.log(`[DB] Migration complete. Migrated ${migratedCount} items.`);
            
        } catch (e) {
            console.error('[DB] Migration failed:', e);
        }
    }
    
    // ========================================
    // Storage Usage Monitoring
    // ========================================
    
    /**
     * Get localStorage usage in bytes
     */
    getLocalStorageUsage() {
        let total = 0;
        try {
            for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                    total += (localStorage[key].length + key.length) * 2; // UTF-16 = 2 bytes per char
                }
            }
        } catch (e) {
            console.warn('[DB] Failed to calculate localStorage usage:', e);
        }
        return total;
    }
    
    /**
     * Get IndexedDB usage in bytes (approximate)
     */
    async getIndexedDBUsage() {
        let total = 0;
        
        if (!this.db) return 0;
        
        try {
            // Use Storage API if available (more accurate)
            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                return estimate.usage || 0;
            }
            
            // Fallback: estimate by reading all data
            for (const storeName of Object.values(this.stores)) {
                try {
                    const records = await this.getAll(storeName);
                    if (records && records.length > 0) {
                        total += JSON.stringify(records).length * 2;
                    }
                } catch (e) {
                    // Ignore errors for individual stores
                }
            }
        } catch (e) {
            console.warn('[DB] Failed to calculate IndexedDB usage:', e);
        }
        
        return total;
    }
    
    /**
     * Get total storage usage and quota
     * @returns {Object} { used, quota, localStorageUsed, indexedDBUsed, percentage }
     */
    async getStorageUsage() {
        const localStorageUsed = this.getLocalStorageUsage();
        let indexedDBUsed = 0;
        let quota = 50 * 1024 * 1024; // Default 50MB estimate
        
        try {
            // Try to get accurate quota from Storage API
            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                indexedDBUsed = estimate.usage || 0;
                quota = estimate.quota || quota;
            } else {
                indexedDBUsed = await this.getIndexedDBUsage();
            }
        } catch (e) {
            console.warn('[DB] Storage estimate failed:', e);
        }
        
        // localStorage has its own 5MB limit, separate from IndexedDB
        const localStorageQuota = 5 * 1024 * 1024;
        const totalUsed = localStorageUsed + indexedDBUsed;
        const totalQuota = localStorageQuota + quota;
        
        return {
            used: totalUsed,
            quota: totalQuota,
            localStorageUsed,
            localStorageQuota,
            indexedDBUsed,
            indexedDBQuota: quota,
            percentage: Math.min(100, (totalUsed / totalQuota) * 100)
        };
    }
    
    /**
     * Format bytes to human readable string
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    /**
     * Check if storage is near full (>80%)
     */
    async isStorageNearFull() {
        const usage = await this.getStorageUsage();
        return usage.percentage > 80;
    }
    
    /**
     * Check if storage is critical (>95%)
     */
    async isStorageCritical() {
        const usage = await this.getStorageUsage();
        return usage.percentage > 95;
    }
    
    /**
     * Update the footer storage meter
     */
    async updateStorageMeter() {
        try {
            const usage = await this.getStorageUsage();
            
            const fillEl = document.getElementById('storageMeterFill');
            const textEl = document.getElementById('storageText');
            const containerEl = document.getElementById('footerStorage');
            
            if (!fillEl || !textEl) return usage;
            
            // Update fill width
            fillEl.style.width = `${Math.min(100, usage.percentage)}%`;
            
            // Update fill color based on usage
            fillEl.classList.remove('warning', 'danger');
            textEl.classList.remove('warning', 'danger');
            
            if (usage.percentage > 95) {
                fillEl.classList.add('danger');
                textEl.classList.add('danger');
            } else if (usage.percentage > 80) {
                fillEl.classList.add('warning');
                textEl.classList.add('warning');
            }
            
            // Update text
            const usedStr = this.formatBytes(usage.used);
            textEl.textContent = `${usedStr}`;
            
            // Update tooltip
            if (containerEl) {
                containerEl.title = `Storage: ${usedStr} / ${this.formatBytes(usage.quota)} (${usage.percentage.toFixed(1)}%)\n` +
                    `localStorage: ${this.formatBytes(usage.localStorageUsed)} / ${this.formatBytes(usage.localStorageQuota)}\n` +
                    `IndexedDB: ${this.formatBytes(usage.indexedDBUsed)} / ${this.formatBytes(usage.indexedDBQuota)}`;
            }
            
            return usage;
        } catch (e) {
            console.warn('[DB] Failed to update storage meter:', e);
            return null;
        }
    }
}

// Global instance
const db = new OrderBookDB();
