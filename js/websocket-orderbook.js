/**
 * Synthetic Order Book - WebSocket Order Book
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Connects to Kraken, Coinbase, and Bitstamp WebSocket APIs for real-time order book data
 * Maintains local order book state and emits updates
 */
class OrderBookWebSocket {
    constructor() {
        this.connections = {
            kraken: null,
            coinbase: null,
            bitstamp: null
        };
        
        this.orderBooks = {
            kraken: { bids: new Map(), asks: new Map(), connected: false, lastUpdate: 0 },
            coinbase: { bids: new Map(), asks: new Map(), connected: false, lastUpdate: 0 },
            bitstamp: { bids: new Map(), asks: new Map(), connected: false, lastUpdate: 0 }
        };
        
        this.symbol = 'BTC';
        this.enabled = {
            kraken: true,
            coinbase: true,
            bitstamp: true
        };
        
        this.reconnectAttempts = {};
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
        
        this.callbacks = {
            onUpdate: null,
            onConnect: null,
            onDisconnect: null,
            onError: null
        };
        
        // Symbol mappings for each exchange
        this.symbolMap = {
            kraken: {
                'BTC': 'XBT/USD',
                'ETH': 'ETH/USD',
                'SOL': 'SOL/USD',
                'SUI': 'SUI/USD',
                'DOGE': 'XDG/USD'
            },
            coinbase: {
                'BTC': 'BTC-USD',
                'ETH': 'ETH-USD',
                'SOL': 'SOL-USD',
                'SUI': 'SUI-USD',
                'DOGE': 'DOGE-USD'
            },
            bitstamp: {
                'BTC': 'btcusd',
                'ETH': 'ethusd',
                'SOL': 'solusd',
                'SUI': 'suiusd',
                'DOGE': 'dogeusd'
            }
        };
        
        // Throttle updates to prevent overwhelming the UI
        // WebSocket can send 100+ updates/sec - throttle to 2 updates/sec max
        this.updateThrottle = 500; // ms (2 updates per second)
        this.lastEmit = 0;
        this.pendingUpdate = false;
    }
    
    /**
     * Set callback functions
     */
    on(event, callback) {
        if (this.callbacks.hasOwnProperty('on' + event.charAt(0).toUpperCase() + event.slice(1))) {
            this.callbacks['on' + event.charAt(0).toUpperCase() + event.slice(1)] = callback;
        }
        return this;
    }
    
    /**
     * Set the trading symbol
     */
    setSymbol(symbol) {
        const oldSymbol = this.symbol;
        this.symbol = symbol.toUpperCase();
        
        if (oldSymbol !== this.symbol) {
            // Reconnect with new symbol
            this.disconnect();
            this.clearOrderBooks();
            this.connect();
        }
    }
    
    /**
     * Enable/disable specific exchanges
     */
    setExchangeEnabled(exchange, enabled) {
        this.enabled[exchange] = enabled;
        
        if (!enabled && this.connections[exchange]) {
            this.disconnectExchange(exchange);
        } else if (enabled && !this.connections[exchange]) {
            this.connectExchange(exchange);
        }
    }
    
    /**
     * Clear all order book data
     */
    clearOrderBooks() {
        for (const exchange in this.orderBooks) {
            this.orderBooks[exchange].bids.clear();
            this.orderBooks[exchange].asks.clear();
            this.orderBooks[exchange].lastUpdate = 0;
        }
    }
    
    /**
     * Connect to all enabled exchanges
     * Idempotent - won't create duplicate connections
     */
    connect() {
        let newConnections = 0;
        
        for (const exchange in this.enabled) {
            if (this.enabled[exchange] && !this.connections[exchange]) {
                newConnections++;
                this.connectExchange(exchange);
            }
        }
        
        if (newConnections > 0) {
            console.warn(`[OrderBook WS] Connecting to ${newConnections} exchange(s)...`);
        }
    }
    
    /**
     * Disconnect from all exchanges
     */
    disconnect() {
        for (const exchange in this.connections) {
            this.disconnectExchange(exchange);
        }
    }
    
    /**
     * Connect to a specific exchange
     */
    connectExchange(exchange) {
        const symbol = this.symbolMap[exchange][this.symbol];
        
        if (!symbol) {
            console.warn(`[OrderBook WS] ${exchange} does not support ${this.symbol}`);
            return;
        }
        
        this.reconnectAttempts[exchange] = 0;
        
        switch (exchange) {
            case 'kraken':
                this.connectKraken(symbol);
                break;
            case 'coinbase':
                this.connectCoinbase(symbol);
                break;
            case 'bitstamp':
                this.connectBitstamp(symbol);
                break;
        }
    }
    
    /**
     * Disconnect from a specific exchange
     */
    disconnectExchange(exchange) {
        if (this.connections[exchange]) {
            this.connections[exchange].close();
            this.connections[exchange] = null;
        }
        this.orderBooks[exchange].connected = false;
        this.orderBooks[exchange].bids.clear();
        this.orderBooks[exchange].asks.clear();
    }
    
    // ==========================================
    // KRAKEN WebSocket
    // ==========================================
    
    connectKraken(symbol) {
        try {
            const ws = new WebSocket('wss://ws.kraken.com');
            this.connections.kraken = ws;
            
            ws.onopen = () => {
                console.warn(`[Kraken Book] Connected, subscribing to ${symbol}`);
                
                // Subscribe to order book with depth 100
                ws.send(JSON.stringify({
                    event: 'subscribe',
                    pair: [symbol],
                    subscription: {
                        name: 'book',
                        depth: 100
                    }
                }));
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleKrakenMessage(data, symbol);
                } catch (e) {
                    console.error('[Kraken Book] Parse error:', e);
                }
            };
            
            ws.onerror = (error) => {
                console.error('[Kraken Book] Error:', error);
                this.handleError('kraken', error);
            };
            
            ws.onclose = () => {
                console.warn('[Kraken Book] Disconnected');
                this.orderBooks.kraken.connected = false;
                this.handleDisconnect('kraken');
            };
            
        } catch (e) {
            console.error('[Kraken Book] Connection error:', e);
            this.handleError('kraken', e);
        }
    }
    
    handleKrakenMessage(data, symbol) {
        // Handle subscription status
        if (data.event === 'subscriptionStatus') {
            if (data.status === 'subscribed') {
                console.warn(`[Kraken Book] Subscribed to ${data.channelName}`);
                this.orderBooks.kraken.connected = true;
                this.emitConnect('kraken');
            }
            return;
        }
        
        // Handle order book data (array format)
        if (Array.isArray(data) && data.length >= 4) {
            const bookData = data[1];
            const isSnapshot = bookData.as !== undefined || bookData.bs !== undefined;
            
            if (isSnapshot) {
                // Snapshot - full order book
                this.orderBooks.kraken.bids.clear();
                this.orderBooks.kraken.asks.clear();
                
                if (bookData.bs) {
                    for (const [price, volume, timestamp] of bookData.bs) {
                        const p = parseFloat(price);
                        const v = parseFloat(volume);
                        if (v > 0) this.orderBooks.kraken.bids.set(p, v);
                    }
                }
                
                if (bookData.as) {
                    for (const [price, volume, timestamp] of bookData.as) {
                        const p = parseFloat(price);
                        const v = parseFloat(volume);
                        if (v > 0) this.orderBooks.kraken.asks.set(p, v);
                    }
                }
            } else {
                // Delta update
                if (bookData.b) {
                    for (const [price, volume, timestamp] of bookData.b) {
                        const p = parseFloat(price);
                        const v = parseFloat(volume);
                        if (v === 0) {
                            this.orderBooks.kraken.bids.delete(p);
                        } else {
                            this.orderBooks.kraken.bids.set(p, v);
                        }
                    }
                }
                
                if (bookData.a) {
                    for (const [price, volume, timestamp] of bookData.a) {
                        const p = parseFloat(price);
                        const v = parseFloat(volume);
                        if (v === 0) {
                            this.orderBooks.kraken.asks.delete(p);
                        } else {
                            this.orderBooks.kraken.asks.set(p, v);
                        }
                    }
                }
            }
            
            this.orderBooks.kraken.lastUpdate = Date.now();
            this.scheduleUpdate();
        }
    }
    
    // ==========================================
    // COINBASE WebSocket
    // ==========================================
    
    connectCoinbase(symbol) {
        try {
            const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
            this.connections.coinbase = ws;
            
            ws.onopen = () => {
                console.warn(`[Coinbase Book] Connected, subscribing to ${symbol}`);
                
                // Subscribe to level2 order book
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    product_ids: [symbol],
                    channels: ['level2_batch']
                }));
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleCoinbaseMessage(data);
                } catch (e) {
                    console.error('[Coinbase Book] Parse error:', e);
                }
            };
            
            ws.onerror = (error) => {
                console.error('[Coinbase Book] Error:', error);
                this.handleError('coinbase', error);
            };
            
            ws.onclose = () => {
                console.warn('[Coinbase Book] Disconnected');
                this.orderBooks.coinbase.connected = false;
                this.handleDisconnect('coinbase');
            };
            
        } catch (e) {
            console.error('[Coinbase Book] Connection error:', e);
            this.handleError('coinbase', e);
        }
    }
    
    handleCoinbaseMessage(data) {
        if (data.type === 'subscriptions') {
            console.warn('[Coinbase Book] Subscription confirmed');
            return;
        }
        
        if (data.type === 'snapshot') {
            // Full snapshot
            this.orderBooks.coinbase.bids.clear();
            this.orderBooks.coinbase.asks.clear();
            
            for (const [price, size] of data.bids) {
                const p = parseFloat(price);
                const v = parseFloat(size);
                if (v > 0) this.orderBooks.coinbase.bids.set(p, v);
            }
            
            for (const [price, size] of data.asks) {
                const p = parseFloat(price);
                const v = parseFloat(size);
                if (v > 0) this.orderBooks.coinbase.asks.set(p, v);
            }
            
            this.orderBooks.coinbase.connected = true;
            this.orderBooks.coinbase.lastUpdate = Date.now();
            this.emitConnect('coinbase');
            this.scheduleUpdate();
            return;
        }
        
        if (data.type === 'l2update') {
            // Delta update
            for (const [side, price, size] of data.changes) {
                const p = parseFloat(price);
                const v = parseFloat(size);
                const book = side === 'buy' ? this.orderBooks.coinbase.bids : this.orderBooks.coinbase.asks;
                
                if (v === 0) {
                    book.delete(p);
                } else {
                    book.set(p, v);
                }
            }
            
            this.orderBooks.coinbase.lastUpdate = Date.now();
            this.scheduleUpdate();
        }
    }
    
    // ==========================================
    // BITSTAMP WebSocket
    // ==========================================
    
    connectBitstamp(symbol) {
        try {
            const ws = new WebSocket('wss://ws.bitstamp.net');
            this.connections.bitstamp = ws;
            
            ws.onopen = () => {
                console.warn(`[Bitstamp Book] Connected, subscribing to ${symbol}`);
                
                // Subscribe to order book
                ws.send(JSON.stringify({
                    event: 'bts:subscribe',
                    data: {
                        channel: `order_book_${symbol}`
                    }
                }));
            };
            
            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleBitstampMessage(data);
                } catch (e) {
                    console.error('[Bitstamp Book] Parse error:', e);
                }
            };
            
            ws.onerror = (error) => {
                console.error('[Bitstamp Book] Error:', error);
                this.handleError('bitstamp', error);
            };
            
            ws.onclose = () => {
                console.warn('[Bitstamp Book] Disconnected');
                this.orderBooks.bitstamp.connected = false;
                this.handleDisconnect('bitstamp');
            };
            
        } catch (e) {
            console.error('[Bitstamp Book] Connection error:', e);
            this.handleError('bitstamp', e);
        }
    }
    
    handleBitstampMessage(data) {
        if (data.event === 'bts:subscription_succeeded') {
            console.warn(`[Bitstamp Book] Subscribed to ${data.channel}`);
            this.orderBooks.bitstamp.connected = true;
            this.emitConnect('bitstamp');
            return;
        }
        
        if (data.event === 'data' && data.data) {
            // Bitstamp sends full snapshots each time
            this.orderBooks.bitstamp.bids.clear();
            this.orderBooks.bitstamp.asks.clear();
            
            if (data.data.bids) {
                for (const [price, volume] of data.data.bids) {
                    const p = parseFloat(price);
                    const v = parseFloat(volume);
                    if (v > 0) this.orderBooks.bitstamp.bids.set(p, v);
                }
            }
            
            if (data.data.asks) {
                for (const [price, volume] of data.data.asks) {
                    const p = parseFloat(price);
                    const v = parseFloat(volume);
                    if (v > 0) this.orderBooks.bitstamp.asks.set(p, v);
                }
            }
            
            this.orderBooks.bitstamp.lastUpdate = Date.now();
            this.scheduleUpdate();
        }
    }
    
    // ==========================================
    // Event Handling
    // ==========================================
    
    scheduleUpdate() {
        const now = Date.now();
        
        if (now - this.lastEmit >= this.updateThrottle) {
            this.emitUpdate();
        } else if (!this.pendingUpdate) {
            this.pendingUpdate = true;
            setTimeout(() => {
                this.pendingUpdate = false;
                this.emitUpdate();
            }, this.updateThrottle - (now - this.lastEmit));
        }
    }
    
    emitUpdate() {
        this.lastEmit = Date.now();
        
        if (this.callbacks.onUpdate) {
            this.callbacks.onUpdate(this.getAggregatedBook());
        }
        
        // Also dispatch DOM event
        window.dispatchEvent(new CustomEvent('orderBookWSUpdate', {
            detail: this.getAggregatedBook()
        }));
    }
    
    emitConnect(exchange) {
        if (this.callbacks.onConnect) {
            this.callbacks.onConnect(exchange, this.getConnectionStatus());
        }
        
        window.dispatchEvent(new CustomEvent('orderBookWSConnect', {
            detail: { exchange, status: this.getConnectionStatus() }
        }));
    }
    
    handleDisconnect(exchange) {
        if (this.callbacks.onDisconnect) {
            this.callbacks.onDisconnect(exchange, this.getConnectionStatus());
        }
        
        window.dispatchEvent(new CustomEvent('orderBookWSDisconnect', {
            detail: { exchange, status: this.getConnectionStatus() }
        }));
        
        // Attempt reconnect
        this.attemptReconnect(exchange);
    }
    
    handleError(exchange, error) {
        if (this.callbacks.onError) {
            this.callbacks.onError(exchange, error);
        }
        
        window.dispatchEvent(new CustomEvent('orderBookWSError', {
            detail: { exchange, error }
        }));
    }
    
    attemptReconnect(exchange) {
        if (!this.enabled[exchange]) return;
        
        this.reconnectAttempts[exchange] = (this.reconnectAttempts[exchange] || 0) + 1;
        
        if (this.reconnectAttempts[exchange] <= this.maxReconnectAttempts) {
            console.warn(`[OrderBook WS] Reconnecting ${exchange} (attempt ${this.reconnectAttempts[exchange]}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                this.connectExchange(exchange);
            }, this.reconnectDelay * this.reconnectAttempts[exchange]);
        } else {
            console.error(`[OrderBook WS] ${exchange} max reconnect attempts reached`);
        }
    }
    
    // ==========================================
    // Data Access
    // ==========================================
    
    /**
     * Get connection status for all exchanges
     */
    getConnectionStatus() {
        return {
            kraken: this.orderBooks.kraken.connected,
            coinbase: this.orderBooks.coinbase.connected,
            bitstamp: this.orderBooks.bitstamp.connected,
            anyConnected: this.orderBooks.kraken.connected || 
                          this.orderBooks.coinbase.connected || 
                          this.orderBooks.bitstamp.connected,
            allConnected: this.orderBooks.kraken.connected && 
                          this.orderBooks.coinbase.connected && 
                          this.orderBooks.bitstamp.connected
        };
    }
    
    /**
     * Get raw order book for a specific exchange
     */
    getExchangeBook(exchange) {
        const book = this.orderBooks[exchange];
        return {
            bids: Array.from(book.bids.entries()).map(([price, volume]) => ({ price, volume })),
            asks: Array.from(book.asks.entries()).map(([price, volume]) => ({ price, volume })),
            connected: book.connected,
            lastUpdate: book.lastUpdate
        };
    }
    
    /**
     * Get aggregated order book from all connected exchanges
     * Returns format compatible with aggregator API
     */
    getAggregatedBook() {
        const aggregatedBids = new Map();
        const aggregatedAsks = new Map();
        const sources = [];
        
        // Merge all exchange books
        for (const exchange in this.orderBooks) {
            if (!this.orderBooks[exchange].connected) continue;
            
            sources.push(exchange);
            const book = this.orderBooks[exchange];
            
            // Merge bids
            for (const [price, volume] of book.bids) {
                const existing = aggregatedBids.get(price) || { volume: 0, sources: [] };
                existing.volume += volume;
                existing.sources.push(exchange);
                aggregatedBids.set(price, existing);
            }
            
            // Merge asks
            for (const [price, volume] of book.asks) {
                const existing = aggregatedAsks.get(price) || { volume: 0, sources: [] };
                existing.volume += volume;
                existing.sources.push(exchange);
                aggregatedAsks.set(price, existing);
            }
        }
        
        // Convert to arrays and sort
        const bids = Array.from(aggregatedBids.entries())
            .map(([price, data]) => ({
                price,
                volume: data.volume,
                type: 'bid',
                sources: data.sources
            }))
            .sort((a, b) => b.price - a.price); // Descending for bids
        
        const asks = Array.from(aggregatedAsks.entries())
            .map(([price, data]) => ({
                price,
                volume: data.volume,
                type: 'ask',
                sources: data.sources
            }))
            .sort((a, b) => a.price - b.price); // Ascending for asks
        
        // Calculate mid price
        const bestBid = bids.length > 0 ? bids[0].price : 0;
        const bestAsk = asks.length > 0 ? asks[0].price : 0;
        const midPrice = (bestBid + bestAsk) / 2;
        
        // Calculate volumes
        const bidVolume = bids.reduce((sum, b) => sum + b.volume, 0);
        const askVolume = asks.reduce((sum, a) => sum + a.volume, 0);
        
        return {
            bids,
            asks,
            sources,
            price: midPrice,
            bestBid,
            bestAsk,
            bidVolume,
            askVolume,
            imbalance: bidVolume - askVolume,
            timestamp: Date.now(),
            isWebSocket: true
        };
    }
    
    /**
     * Check if we have usable data
     */
    hasData() {
        return this.getConnectionStatus().anyConnected &&
               (this.orderBooks.kraken.bids.size > 0 ||
                this.orderBooks.coinbase.bids.size > 0 ||
                this.orderBooks.bitstamp.bids.size > 0);
    }
}

// Export singleton instance
const orderBookWS = new OrderBookWebSocket();

