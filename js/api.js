/**
 * Synthetic Order Book - API Layer
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * API Layer for Order Book Backend
 * Hybrid: WebSocket (real-time) with PHP fallback
 */
class OrderBookAPI {
    constructor(baseUrl = '/api/orderbook.php') {
        this.baseUrl = baseUrl;
        this.symbol = 'BTC';
        
        // WebSocket integration
        this.useWebSocket = localStorage.getItem('useWebSocket') !== 'false';
        this.wsConnected = false;
        this.wsData = null;
        this.wsLastUpdate = 0;
        
        // Aggregator settings
        this.aggregatorSettings = {
            clusterPct: 0.15,
            maxLevels: 50,
            minVolume: 0,
            priceRangePct: 100
        };
        
        // Track data source for UI
        this.dataSource = 'php';
        
        // Setup WebSocket event listeners
        this.setupWebSocketListeners();
    }
    
    /**
     * Setup listeners for WebSocket order book events
     */
    setupWebSocketListeners() {
        // Listen for WebSocket updates
        window.addEventListener('orderBookWSUpdate', (e) => {
            this.wsData = e.detail;
            this.wsLastUpdate = Date.now();
        });
        
        // Listen for connection status changes
        window.addEventListener('orderBookWSConnect', (e) => {
            const status = e.detail.status;
            this.wsConnected = status.anyConnected;
            if (this.wsConnected) {
                this.dataSource = 'websocket';
                console.warn('[API] Switched to WebSocket data source');
            }
        });
        
        window.addEventListener('orderBookWSDisconnect', (e) => {
            const status = e.detail.status;
            this.wsConnected = status.anyConnected;
            if (!this.wsConnected) {
                this.dataSource = 'php';
                console.warn('[API] Falling back to PHP data source');
            }
        });
    }
    
    /**
     * Enable/disable WebSocket mode
     */
    setWebSocketEnabled(enabled) {
        this.useWebSocket = enabled;
        localStorage.setItem('useWebSocket', enabled);
        
        if (enabled && typeof orderBookWS !== 'undefined') {
            orderBookWS.setSymbol(this.symbol);
            orderBookWS.connect();
        } else if (!enabled && typeof orderBookWS !== 'undefined') {
            orderBookWS.disconnect();
            this.wsConnected = false;
            this.dataSource = 'php';
        }
    }
    
    /**
     * Check if WebSocket is available and has data
     */
    isWebSocketReady() {
        return this.useWebSocket && 
               this.wsConnected && 
               this.wsData && 
               (Date.now() - this.wsLastUpdate < 10000); // Data less than 10 sec old
    }
    
    /**
     * Get current data source
     */
    getDataSource() {
        return this.dataSource;
    }

    setSymbol(symbol) {
        this.symbol = symbol.toUpperCase();
        
        // Update WebSocket symbol if connected
        if (typeof orderBookWS !== 'undefined') {
            orderBookWS.setSymbol(this.symbol);
        }
    }
    
    /**
     * Update aggregator settings
     */
    setAggregatorSettings(settings) {
        Object.assign(this.aggregatorSettings, settings);
        
        if (typeof orderBookAggregator !== 'undefined') {
            orderBookAggregator.setSettings(this.aggregatorSettings);
        }
    }

    // Fetch from PHP backend
    async fetchPHP(action, params = {}) {
        const url = new URL(this.baseUrl, window.location.origin);
        url.searchParams.set('action', action);
        url.searchParams.set('symbol', this.symbol);
        
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || 'Unknown API error');
        }
        
        return data;
    }

    // Get calculated support/resistance levels - WebSocket only
    async getLevels(exchanges = null, settings = null) {
        // WebSocket only - no PHP fallback
        if (!this.isWebSocketReady() || typeof orderBookAggregator === 'undefined') {
            // Return empty while waiting for WebSocket
            return {
                success: true,
                levels: [],
                price: 0,
                bidVolume: 0,
                askVolume: 0,
                imbalance: '0.0',
                sources: [],
                dataSource: 'waiting',
                message: 'Connecting to exchanges...'
            };
        }
        
        try {
            // Update aggregator settings
            const aggSettings = { ...this.aggregatorSettings };
            if (settings) {
                if (settings.clusterPct !== undefined) aggSettings.clusterPct = settings.clusterPct;
                if (settings.maxLevels !== undefined) aggSettings.maxLevels = settings.maxLevels;
                if (settings.minVolume !== undefined) aggSettings.minVolume = settings.minVolume;
                if (settings.priceRange !== undefined) aggSettings.priceRangePct = settings.priceRange;
            }
            orderBookAggregator.setSettings(aggSettings);
            
            // Process WebSocket data
            const result = orderBookAggregator.process(this.wsData);
            
            if (result && result.levels) {
                this.dataSource = 'websocket';
                return {
                    success: true,
                    ...result,
                    dataSource: 'websocket'
                };
            }
            
            // If processing returns null, return empty
            return {
                success: true,
                levels: [],
                price: 0,
                dataSource: 'websocket'
            };
        } catch (e) {
            console.error('[API] WebSocket processing failed:', e);
            return {
                success: false,
                error: e.message,
                levels: [],
                dataSource: 'error'
            };
        }
    }
    
    // Get ALL levels without filters (for analytics) - WebSocket only
    async getAllLevels(exchanges = null, settings = null) {
        // WebSocket only - no PHP fallback
        if (!this.isWebSocketReady() || typeof orderBookAggregator === 'undefined') {
            return {
                success: true,
                levels: [],
                price: 0,
                dataSource: 'waiting'
            };
        }
        
        try {
            // Use full book (no clustering for analytics)
            const result = orderBookAggregator.processFullBook(this.wsData);
            
            if (result && result.levels) {
                return {
                    success: true,
                    ...result,
                    dataSource: 'websocket'
                };
            }
            
            return {
                success: true,
                levels: [],
                price: 0,
                dataSource: 'websocket'
            };
        } catch (e) {
            console.error('[API] WebSocket full book processing failed:', e);
            return {
                success: false,
                error: e.message,
                levels: [],
                dataSource: 'error'
            };
        }
    }

    // Get price history (klines) - from Binance Vision API
    async getKlines(interval = '1h', limit = 500) {
        try {
            // Map symbol to Binance format (BTC -> BTCUSDT)
            const binanceSymbol = this.getBinanceSymbol(this.symbol);
            
            // Map interval format (already compatible: 1m, 5m, 1h, 4h, 1d, 1w)
            const binanceInterval = this.mapInterval(interval);
            
            // Fetch from Binance Vision API (CORS-friendly, no API key needed)
            const url = `https://data-api.binance.vision/api/v3/klines?symbol=${binanceSymbol}&interval=${binanceInterval}&limit=${limit}`;
            const response = await fetch(url);
            
            if (!response.ok) {
                throw new Error(`Binance API error: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Convert Binance format to our format
            // Binance: [time, open, high, low, close, volume, closeTime, ...]
            const klines = data.map(k => ({
                time: Math.floor(k[0] / 1000), // Convert ms to seconds
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5])
            }));
            
            return {
                success: true,
                data: klines,
                dataSource: 'binance'
            };
        } catch (error) {
            console.error('[API] Failed to fetch klines from Binance:', error);
            throw error;
        }
    }
    
    /**
     * Map our symbol format to Binance format
     */
    getBinanceSymbol(symbol) {
        const symbolMap = {
            'BTC': 'BTCUSDT',
            'ETH': 'ETHUSDT',
            'SOL': 'SOLUSDT',
            'SUI': 'SUIUSDT',
            'DOGE': 'DOGEUSDT'
        };
        
        return symbolMap[symbol] || (symbol + 'USDT');
    }
    
    /**
     * Map interval format (our format is already compatible with Binance)
     */
    mapInterval(interval) {
        // Our format: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, 1w
        // Binance format: same
        return interval.toLowerCase();
    }

    // Get depth chart data - WebSocket only
    async getDepth(exchanges = null) {
        // WebSocket only - no PHP fallback
        if (!this.isWebSocketReady()) {
            return {
                success: true,
                bids: [],
                asks: [],
                price: 0,
                dataSource: 'waiting',
                message: 'Connecting to exchanges...'
            };
        }
        
        const book = this.wsData;
        return {
            success: true,
            bids: book.bids || [],
            asks: book.asks || [],
            price: book.price || 0,
            dataSource: 'websocket'
        };
    }
    
    /**
     * Initialize WebSocket connection
     */
    initWebSocket() {
        if (this.useWebSocket && typeof orderBookWS !== 'undefined') {
            orderBookWS.setSymbol(this.symbol);
            orderBookWS.connect();
        }
    }
}

// Global instance
const api = new OrderBookAPI();
