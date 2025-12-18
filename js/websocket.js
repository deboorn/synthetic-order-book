/**
 * Synthetic Order Book - WebSocket Manager
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * WebSocket Manager for Real-time Exchange Data
 * Supports price streaming and OHLC/Kline streaming from multiple exchanges
 */
class WebSocketManager {
    constructor() {
        this.connections = {};
        this.prices = {};  // { exchange: { price, timestamp } }
        this.ohlcPrice = 0;  // Primary price from OHLC stream
        this.symbol = 'BTC';
        this.interval = '1m';
        this.onPriceUpdate = null;
        this.onOHLCUpdate = null;
        this.onError = null;
        this.reconnectDelay = 5000;
        this.isConnected = false;
        this.ohlcConnected = false;
        
        // Enabled exchanges for price display (synced from app)
        this.enabledExchanges = ['coinbase', 'kraken', 'bitstamp'];
        
        // Last broadcast price (kept for fallback)
        this.lastPrice = 0;
        this.lastPriceExchange = null;
        
        // Kraken OHLC interval mapping (in minutes)
        // Kraken supported: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
        this.krakenIntervalMap = {
            '1m': 1,
            '3m': 1,     // Use 1m (closest smaller)
            '5m': 5,
            '15m': 15,
            '30m': 30,
            '1h': 60,
            '2h': 60,    // Use 1h (closest smaller)
            '4h': 240,
            '6h': 240,   // Use 4h (6h not supported, 240 is closest smaller)
            '12h': 240,  // Use 4h (12h not supported, 240 is closest smaller)
            '1d': 1440,
            '3d': 1440,  // Use 1d (closest smaller)
            '1w': 10080
        };
        
        // Symbol mappings for each exchange
        this.symbolMaps = {
            coinbase: {
                BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD',
                DOGE: 'DOGE-USD', ADA: 'ADA-USD', AVAX: 'AVAX-USD', DOT: 'DOT-USD',
                LINK: 'LINK-USD', LTC: 'LTC-USD', MATIC: 'MATIC-USD', UNI: 'UNI-USD',
                ATOM: 'ATOM-USD', FIL: 'FIL-USD', APT: 'APT-USD', ARB: 'ARB-USD',
                OP: 'OP-USD', NEAR: 'NEAR-USD', SHIB: 'SHIB-USD', BCH: 'BCH-USD',
                SUI: 'SUI-USD'
            },
            kraken: {
                BTC: 'XBT/USD', ETH: 'ETH/USD', SOL: 'SOL/USD', XRP: 'XRP/USD',
                DOGE: 'DOGE/USD', ADA: 'ADA/USD', AVAX: 'AVAX/USD', DOT: 'DOT/USD',
                LINK: 'LINK/USD', LTC: 'LTC/USD', MATIC: 'MATIC/USD', UNI: 'UNI/USD',
                ATOM: 'ATOM/USD', FIL: 'FIL/USD', APT: 'APT/USD', ARB: 'ARB/USD',
                OP: 'OP/USD', NEAR: 'NEAR/USD', SHIB: 'SHIB/USD', BCH: 'BCH/USD',
                SUI: 'SUI/USD'
            },
            bitstamp: {
                BTC: 'btcusd', ETH: 'ethusd', SOL: 'solusd', XRP: 'xrpusd',
                DOGE: 'dogeusd', ADA: 'adausd', AVAX: 'avaxusd', DOT: 'dotusd',
                LINK: 'linkusd', LTC: 'ltcusd', MATIC: 'maticusd', UNI: 'uniusd',
                ATOM: 'atomusd', FIL: 'filusd', APT: 'aptusd', ARB: 'arbusd',
                OP: 'opusd', NEAR: 'nearusd', SHIB: 'shibusd', BCH: 'bchusd',
                SUI: 'suiusd'
            }
        };
    }

    // Get exchange-specific symbol
    getExchangeSymbol(exchange, symbol) {
        const map = this.symbolMaps[exchange];
        return map ? map[symbol.toUpperCase()] : null;
    }
    
    // Set which exchanges are enabled for price display
    setEnabledExchanges(exchanges) {
        this.enabledExchanges = exchanges.map(e => e.toLowerCase());
        // Re-broadcast price with new filter
        this.broadcastPrice();
    }

    // Get Kraken interval value
    getKrakenInterval(interval) {
        return this.krakenIntervalMap[interval] || 1;
    }

    /**
     * Start all WebSocket connections
     * @param {string} symbol - Crypto symbol (BTC, ETH, etc.)
     * @param {string} interval - Chart interval (1m, 5m, 1h, etc.)
     * @param {function} onPriceUpdate - Callback for price updates
     * @param {function} onOHLCUpdate - Callback for OHLC candle updates
     * @param {function} onError - Callback for errors
     */
    connect(symbol, interval, onPriceUpdate, onOHLCUpdate, onError) {
        this.symbol = symbol.toUpperCase();
        this.interval = interval || '1m';
        this.onPriceUpdate = onPriceUpdate;
        this.onOHLCUpdate = onOHLCUpdate;
        this.onError = onError;
        this.prices = {};
        
        // Disconnect existing connections
        this.disconnect();
        
        // Connect to OHLC stream (Kraken) - PRIMARY for chart data
        this.connectKrakenOHLC();
        
        // Connect to price streams (for price display and fallback)
        this.connectCoinbase();
        this.connectKrakenTicker();
        this.connectBitstamp();
    }

    /**
     * Change the chart interval (reconnects OHLC stream)
     */
    setInterval(interval) {
        if (this.interval === interval) return;
        
        this.interval = interval;
        
        // Reconnect Kraken OHLC with new interval
        if (this.connections.krakenOHLC) {
            this.connections.krakenOHLC.close();
            delete this.connections.krakenOHLC;
        }
        
        this.connectKrakenOHLC();
    }

    /**
     * Kraken OHLC WebSocket - Real candle data stream
     * This is the PRIMARY source for accurate chart updates
     */
    connectKrakenOHLC() {
        const pair = this.getExchangeSymbol('kraken', this.symbol);
        if (!pair) {
            console.warn(`Kraken OHLC: ${this.symbol} not supported`);
            return;
        }

        const krakenInterval = this.getKrakenInterval(this.interval);

        try {
            const ws = new WebSocket('wss://ws.kraken.com');
            
            ws.onopen = () => {
                console.log(`[Kraken OHLC] Connected for ${pair} @ ${this.interval} (interval=${krakenInterval})`);
                
                // Subscribe to OHLC channel
                ws.send(JSON.stringify({
                    event: 'subscribe',
                    pair: [pair],
                    subscription: {
                        name: 'ohlc',
                        interval: krakenInterval
                    }
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Handle subscription status
                    if (data.event === 'subscriptionStatus') {
                        if (data.status === 'subscribed') {
                            console.log(`[Kraken OHLC] Subscribed to ${data.channelName} for ${data.pair}`);
                            this.ohlcConnected = true;
                        } else if (data.status === 'error') {
                            console.error('[Kraken OHLC] Subscription error:', data.errorMessage);
                            if (this.onError) {
                                this.onError({ exchange: 'Kraken OHLC', symbol: this.symbol, message: data.errorMessage });
                            }
                        }
                        return;
                    }
                    
                    // Handle OHLC data
                    // Format: [channelID, [time, etime, open, high, low, close, vwap, volume, count], "ohlc-X", "pair"]
                    if (Array.isArray(data) && data.length >= 4 && typeof data[2] === 'string' && data[2].startsWith('ohlc')) {
                        const ohlcData = data[1];
                        if (Array.isArray(ohlcData) && ohlcData.length >= 8) {
                            const candle = {
                                time: parseInt(ohlcData[0]),      // Start time of candle
                                endTime: parseInt(ohlcData[1]),   // End time of candle
                                open: parseFloat(ohlcData[2]),
                                high: parseFloat(ohlcData[3]),
                                low: parseFloat(ohlcData[4]),
                                close: parseFloat(ohlcData[5]),
                                vwap: parseFloat(ohlcData[6]),
                                volume: parseFloat(ohlcData[7]),
                                count: parseInt(ohlcData[8] || 0),
                                source: 'kraken_ohlc'
                            };
                            
                            // OHLC close is the PRIMARY price source (most accurate)
                            this.ohlcPrice = candle.close;
                            this.broadcastPrice();
                            
                            // Send OHLC update to chart
                            if (this.onOHLCUpdate) {
                                this.onOHLCUpdate(candle);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            ws.onerror = (error) => {
                console.warn('[Kraken OHLC] WebSocket error:', error);
                this.ohlcConnected = false;
            };

            ws.onclose = () => {
                console.log('[Kraken OHLC] WebSocket closed');
                this.ohlcConnected = false;
                delete this.connections.krakenOHLC;
                
                // Auto-reconnect after delay
                setTimeout(() => {
                    if (!this.connections.krakenOHLC) {
                        console.log('[Kraken OHLC] Reconnecting...');
                        this.connectKrakenOHLC();
                    }
                }, this.reconnectDelay);
            };

            this.connections.krakenOHLC = ws;
        } catch (e) {
            console.warn('[Kraken OHLC] Connection failed:', e);
        }
    }

    // Coinbase WebSocket (for price display)
    connectCoinbase() {
        const pair = this.getExchangeSymbol('coinbase', this.symbol);
        if (!pair) {
            console.warn(`Coinbase: ${this.symbol} not supported`);
            return;
        }

        try {
            const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
            
            ws.onopen = () => {
                console.log(`[Coinbase] Connected for ${pair}`);
                ws.send(JSON.stringify({
                    type: 'subscribe',
                    product_ids: [pair],
                    channels: ['ticker']
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'ticker' && data.price) {
                        this.prices.coinbase = {
                            price: parseFloat(data.price),
                            timestamp: Date.now()
                        };
                        this.broadcastPrice();
                    } else if (data.type === 'error') {
                        console.warn('[Coinbase] Error:', data.message);
                        if (this.onError) {
                            this.onError({ exchange: 'Coinbase', symbol: this.symbol, message: data.message });
                        }
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            ws.onerror = (error) => {
                console.warn('[Coinbase] WebSocket error:', error);
            };

            ws.onclose = () => {
                console.log('[Coinbase] WebSocket closed');
                delete this.connections.coinbase;
            };

            this.connections.coinbase = ws;
        } catch (e) {
            console.warn('[Coinbase] Connection failed:', e);
        }
    }

    // Kraken Ticker WebSocket (for price display, separate from OHLC)
    connectKrakenTicker() {
        const pair = this.getExchangeSymbol('kraken', this.symbol);
        if (!pair) {
            return;
        }

        try {
            const ws = new WebSocket('wss://ws.kraken.com');
            
            ws.onopen = () => {
                console.log(`[Kraken Ticker] Connected for ${pair}`);
                ws.send(JSON.stringify({
                    event: 'subscribe',
                    pair: [pair],
                    subscription: { name: 'ticker' }
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // Skip status messages (OHLC connection handles those)
                    if (data.event) return;
                    
                    // Kraken ticker: [channelID, data, "ticker", "pair"]
                    if (Array.isArray(data) && data[2] === 'ticker') {
                        const tickerData = data[1];
                        if (tickerData && tickerData.c && tickerData.c[0]) {
                            // Always update Kraken price (don't skip when OHLC connected)
                            this.prices.kraken = {
                                price: parseFloat(tickerData.c[0]),
                                timestamp: Date.now()
                            };
                            this.broadcastPrice();
                        }
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            ws.onerror = (error) => {
                console.warn('[Kraken Ticker] WebSocket error:', error);
            };

            ws.onclose = () => {
                console.log('[Kraken Ticker] WebSocket closed');
                delete this.connections.krakenTicker;
            };

            this.connections.krakenTicker = ws;
        } catch (e) {
            console.warn('[Kraken Ticker] Connection failed:', e);
        }
    }

    // Bitstamp WebSocket (for price display)
    connectBitstamp() {
        const pair = this.getExchangeSymbol('bitstamp', this.symbol);
        if (!pair) {
            console.warn(`Bitstamp: ${this.symbol} not supported`);
            return;
        }

        try {
            const ws = new WebSocket('wss://ws.bitstamp.net');
            
            ws.onopen = () => {
                console.log(`[Bitstamp] Connected for ${pair}`);
                ws.send(JSON.stringify({
                    event: 'bts:subscribe',
                    data: { channel: `live_trades_${pair}` }
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    if (data.event === 'bts:request_reconnect') {
                        console.warn('[Bitstamp] Reconnect requested');
                        return;
                    }
                    
                    if (data.event === 'trade' && data.data && data.data.price) {
                        this.prices.bitstamp = {
                            price: parseFloat(data.data.price),
                            timestamp: Date.now()
                        };
                        this.broadcastPrice();
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };

            ws.onerror = (error) => {
                console.warn('[Bitstamp] WebSocket error:', error);
            };

            ws.onclose = () => {
                console.log('[Bitstamp] WebSocket closed');
                delete this.connections.bitstamp;
            };

            this.connections.bitstamp = ws;
        } catch (e) {
            console.warn('[Bitstamp] Connection failed:', e);
        }
    }

    // Broadcast price - use most recent price from enabled exchanges
    broadcastPrice() {
        let price = null;
        let sourceExchange = null;
        let latestTimestamp = 0;
        
        // Find the most recent price from enabled exchanges only
        for (const exchange of this.enabledExchanges) {
            const data = this.prices[exchange];
            if (data && data.price > 0 && data.timestamp > latestTimestamp) {
                latestTimestamp = data.timestamp;
                price = data.price;
                sourceExchange = exchange;
            }
        }
        
        // If no price from enabled exchanges, keep last known price
        if (price === null) {
            if (this.lastPrice > 0) {
                price = this.lastPrice;
                sourceExchange = this.lastPriceExchange;
            } else {
                return; // No price available at all
            }
        } else {
            // Store for fallback
            this.lastPrice = price;
            this.lastPriceExchange = sourceExchange;
        }
        
        price = Math.round(price * 100) / 100;
        this.isConnected = true;

        if (this.onPriceUpdate) {
            this.onPriceUpdate({
                price: price,
                prices: this.prices,
                sources: Object.keys(this.prices).length,
                symbol: this.symbol,
                ohlcConnected: this.ohlcConnected,
                priceSource: sourceExchange,
                priceTimestamp: latestTimestamp
            });
        }
    }

    // Get current price (most recent from enabled exchanges)
    getPrice() {
        let latestTimestamp = 0;
        let price = 0;
        
        for (const exchange of this.enabledExchanges) {
            const data = this.prices[exchange];
            if (data && data.price > 0 && data.timestamp > latestTimestamp) {
                latestTimestamp = data.timestamp;
                price = data.price;
            }
        }
        
        return price > 0 ? Math.round(price * 100) / 100 : this.lastPrice;
    }

    // Disconnect all
    disconnect() {
        Object.values(this.connections).forEach(ws => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });
        this.connections = {};
        this.prices = {};
        this.ohlcPrice = 0;
        this.isConnected = false;
        this.ohlcConnected = false;
        // Keep lastPrice for continuity on reconnect
    }
}

// Global instance
const wsManager = new WebSocketManager();
