/**
 * Coinbase Advanced Trade API Client
 * 
 * Client-side API wrapper for Coinbase perpetual futures trading.
 * Uses PHP proxy to avoid CORS issues.
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

class CoinbaseAPI {
    constructor(apiKey, privateKey, debug = true) {
        this.apiKey = apiKey;
        this.privateKey = privateKey;
        this.proxyUrl = 'coinbase-advanced/proxy.php';
        this.portfolioUuid = null;
        this.portfolioType = null; // 'DEFAULT', 'INTX', etc.
        this.contractSizes = {}; // Cache product contract sizes
        this.lastRequestTime = 0;
        this.minRequestInterval = 100; // 100ms between requests (was 500ms - too slow for FOK retries)
        this.debug = debug; // Enable/disable verbose logging
    }
    
    /**
     * Log message if debug is enabled
     */
    log(...args) {
        if (this.debug) {
            console.log('[CoinbaseAPI]', ...args);
        }
    }
    
    /**
     * Log warning
     */
    warn(...args) {
        console.warn('[CoinbaseAPI]', ...args);
    }
    
    /**
     * Log error
     */
    error(...args) {
        console.error('[CoinbaseAPI]', ...args);
    }
    
    /**
     * Check if this is an INTX (international) portfolio
     */
    isINTX() {
        return this.portfolioType === 'INTX';
    }
    
    /**
     * Check if product is a CFM futures contract (US regulated)
     * Format: BIP-20DEC30-CDE, ETP-20DEC30-CDE, etc.
     */
    isCFMFutures(productId) {
        return productId && productId.endsWith('-CDE');
    }
    
    // JWT is now generated server-side in PHP for better EC key support
    
    /**
     * Rate limit enforcement
     */
    async enforceRateLimit() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - elapsed));
        }
        this.lastRequestTime = Date.now();
    }
    
    /**
     * Make API call through PHP proxy
     * JWT is generated server-side in PHP for better EC key support
     */
    async callAPI(method, endpoint, body = null, retryCount = 0) {
        await this.enforceRateLimit();
        
        this.log(`${method} ${endpoint}`, body ? JSON.stringify(body) : '');
        
        const formData = new FormData();
        formData.append('endpoint', endpoint);
        formData.append('method', method);
        formData.append('apiKey', this.apiKey);
        formData.append('privateKey', this.privateKey);
        
        if (body) {
            formData.append('body', JSON.stringify(body));
        }
        
        this.log(`Fetching: ${this.proxyUrl}`);
        
        try {
            const response = await fetch(this.proxyUrl, {
                method: 'POST',
                body: formData
            });
            
            this.log(`Response status: ${response.status}`);
            
            const data = await response.json();
            this.log(`Response data:`, JSON.stringify(data));
            
            // Handle rate limiting with exponential backoff
            if (response.status === 429 && retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                this.warn(`Rate limited, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callAPI(method, endpoint, body, retryCount + 1);
            }
            
            if (!response.ok) {
                this.error(`Error response:`, JSON.stringify(data));
                throw new Error(data.details || data.error || data.message || `HTTP ${response.status}`);
            }
            
            return data;
        } catch (error) {
            this.error('Request failed:', error);
            throw error;
        }
    }
    
    /**
     * Discover portfolio UUID - tries to find the primary/default portfolio
     */
    async discoverPortfolio() {
        console.log('[CoinbaseAPI] Discovering portfolio...');
        
        if (this.portfolioUuid) {
            console.log('[CoinbaseAPI] Using cached portfolio UUID:', this.portfolioUuid);
            return this.portfolioUuid;
        }
        
        // First, get ALL portfolios to see what's available
        const data = await this.callAPI('GET', '/api/v3/brokerage/portfolios');
        
        console.log('[CoinbaseAPI] All portfolios:', data);
        
        if (data.portfolios && data.portfolios.length > 0) {
            // Log all available portfolios
            data.portfolios.forEach((p, i) => {
                console.log(`[CoinbaseAPI] Portfolio ${i}: name="${p.name}" type="${p.type}" uuid="${p.uuid}"`);
            });
            
            // Try to find primary portfolio first, then INTX, then default
            let portfolio = data.portfolios.find(p => p.name?.toLowerCase() === 'primary');
            if (!portfolio) {
                portfolio = data.portfolios.find(p => p.type === 'INTX');
            }
            if (!portfolio) {
                portfolio = data.portfolios.find(p => p.type === 'DEFAULT');
            }
            if (!portfolio) {
                portfolio = data.portfolios[0]; // Fall back to first portfolio
            }
            
            this.portfolioUuid = portfolio.uuid;
            this.portfolioType = portfolio.type;
            console.log(`[CoinbaseAPI] Selected portfolio: "${portfolio.name}" (${portfolio.type}) UUID: ${this.portfolioUuid}`);
            return this.portfolioUuid;
        }
        
        throw new Error('No portfolios found on your Coinbase account.');
    }
    
    /**
     * Validate that a product exists and is tradable
     * Uses same endpoint as Coinbase web UI
     */
    async validateProduct(productId) {
        try {
            const data = await this.callAPI('GET', `/api/v3/brokerage/products/${productId}?get_tradability_status=true`);
            console.log(`[CoinbaseAPI] Product ${productId} details:`, data);
            
            if (data && data.product_id === productId) {
                // Check if tradable
                const isTradable = data.is_disabled !== true && data.trading_disabled !== true;
                console.log(`[CoinbaseAPI] Product ${productId} tradable: ${isTradable}`);
                return isTradable;
            }
            return false;
        } catch (error) {
            console.error('[CoinbaseAPI] Product validation failed:', error);
            return false;
        }
    }
    
    /**
     * Get product details including contract size
     */
    async getProductDetails(productId) {
        if (this.contractSizes[productId]) {
            return this.contractSizes[productId];
        }
        
        const data = await this.callAPI('GET', `/api/v3/brokerage/products/${productId}`);
        
        const details = {
            productId: data.product_id,
            displayName: data.display_name,
            baseIncrement: data.base_increment,
            quoteIncrement: data.quote_increment,
            contractSize: data.future_product_details?.contract_size || '1',
            maxLeverage: data.future_product_details?.perpetual_details?.max_leverage || '10'
        };
        
        this.contractSizes[productId] = details;
        return details;
    }
    
    /**
     * Get CFM Futures Balance Summary (for US regulated futures like BIP-20DEC30-CDE)
     * https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/guides/futures
     */
    async getFuturesBalanceSummary() {
        const data = await this.callAPI('GET', '/api/v3/brokerage/cfm/balance_summary');
        console.log('[CoinbaseAPI] CFM Futures Balance Summary:', data);
        return data;
    }
    
    /**
     * Get portfolio summary (margin, balance, etc.)
     * Uses different endpoints for INTX vs CFM futures vs DEFAULT portfolios
     */
    async getPortfolioSummary() {
        console.log(`[CoinbaseAPI] getPortfolioSummary called, portfolioUuid: ${this.portfolioUuid}, portfolioType: ${this.portfolioType}`);
        
        if (!this.portfolioUuid) {
            await this.discoverPortfolio();
        }
        
        console.log(`[CoinbaseAPI] After discover - portfolioUuid: ${this.portfolioUuid}, portfolioType: ${this.portfolioType}, isINTX: ${this.isINTX()}`);
        
        if (this.isINTX()) {
            // INTX portfolios use /intx/ endpoint
            console.log(`[CoinbaseAPI] Using INTX endpoint for portfolio summary`);
            const data = await this.callAPI('GET', `/api/v3/brokerage/intx/portfolio/${this.portfolioUuid}`);
            return data;
        } else {
            // DEFAULT portfolios with CFM futures - use futures balance summary
            console.log(`[CoinbaseAPI] Using CFM/DEFAULT endpoint for portfolio summary`);
            try {
                const futuresData = await this.getFuturesBalanceSummary();
                console.log(`[CoinbaseAPI] CFM balance summary success`);
                return { 
                    ...futuresData, 
                    portfolioType: 'CFM_FUTURES' 
                };
            } catch (error) {
                console.warn('[CoinbaseAPI] CFM balance summary failed, falling back to accounts:', error);
                // Fallback to accounts endpoint
                const data = await this.callAPI('GET', `/api/v3/brokerage/accounts`);
                return { accounts: data.accounts, portfolioType: 'DEFAULT' };
            }
        }
    }
    
    /**
     * Check if margin is sufficient for a trade
     * For CFM futures: uses futures balance summary
     * For INTX portfolios: checks buying_power
     */
    async checkMargin(requiredMargin) {
        console.log(`[CoinbaseAPI] checkMargin called, required: $${requiredMargin}`);
        const summary = await this.getPortfolioSummary();
        console.log(`[CoinbaseAPI] Portfolio summary received:`, JSON.stringify(summary).substring(0, 500));
        console.log(`[CoinbaseAPI] portfolioType: ${summary.portfolioType}, isINTX: ${this.isINTX()}`);
        
        if (this.isINTX()) {
            const buyingPower = parseFloat(summary.summary?.buying_power?.value || '0');
            console.log(`[CoinbaseAPI] INTX buying power: $${buyingPower}, required: $${requiredMargin}, hasMargin: ${buyingPower >= requiredMargin}`);
            return buyingPower >= requiredMargin;
        } else if (summary.portfolioType === 'CFM_FUTURES') {
            // CFM Futures - check available margin from futures balance summary
            // Response structure: { balance_summary: { available_margin: { value: "..." }, ... } }
            const bs = summary.balance_summary || summary;
            console.log(`[CoinbaseAPI] balance_summary object:`, JSON.stringify(bs).substring(0, 500));
            const availableMargin = parseFloat(bs.available_margin?.value || '0');
            const cfmBalance = parseFloat(bs.cfm_usd_balance?.value || '0');
            const futuresBuyingPower = parseFloat(bs.futures_buying_power?.value || '0');
            const hasMargin = futuresBuyingPower >= requiredMargin || availableMargin >= requiredMargin || cfmBalance >= requiredMargin;
            console.log(`[CoinbaseAPI] CFM MARGIN CHECK: available=$${availableMargin}, cfmBalance=$${cfmBalance}, futuresBuyingPower=$${futuresBuyingPower}, required=$${requiredMargin}, RESULT=${hasMargin}`);
            return hasMargin;
        } else {
            // Fallback - check USD account balance
            const usdAccount = summary.accounts?.find(a => a.currency === 'USD');
            const available = parseFloat(usdAccount?.available_balance?.value || '0');
            console.log(`[CoinbaseAPI] DEFAULT USD available: $${available}, required: $${requiredMargin}, hasMargin: ${available >= requiredMargin}`);
            return available >= requiredMargin;
        }
    }
    
    /**
     * Get CFM futures positions
     * https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/rest-api/futures
     */
    async getCFMPositions() {
        const data = await this.callAPI('GET', '/api/v3/brokerage/cfm/positions');
        console.log('[CoinbaseAPI] CFM Positions:', data);
        return data.positions || [];
    }
    
    /**
     * Get current position for a product
     * Handles INTX perpetuals, CFM futures, and DEFAULT portfolios
     */
    async getPosition(productId) {
        if (!this.portfolioUuid) {
            await this.discoverPortfolio();
        }
        
        try {
            if (this.isINTX()) {
                // INTX portfolios have dedicated position endpoints
                const data = await this.callAPI('GET', `/api/v3/brokerage/intx/positions/${this.portfolioUuid}/${productId}`);
                
                if (data && data.position) {
                    const pos = data.position;
                    return {
                        productId: pos.product_id,
                        side: parseFloat(pos.net_size) > 0 ? 'long' : 'short',
                        size: Math.abs(parseFloat(pos.net_size)),
                        entryPrice: parseFloat(pos.entry_vwap),
                        unrealizedPnl: parseFloat(pos.unrealized_pnl?.value || '0'),
                        leverage: parseFloat(pos.leverage || '1')
                    };
                }
            } else if (this.isCFMFutures(productId)) {
                // CFM Futures (US regulated) - use cfm/positions endpoint
                const positions = await this.getCFMPositions();
                const pos = positions.find(p => p.product_id === productId);
                
                if (pos && parseFloat(pos.number_of_contracts) !== 0) {
                    const contracts = parseFloat(pos.number_of_contracts);
                    return {
                        productId: pos.product_id,
                        side: contracts > 0 ? 'long' : 'short',
                        size: Math.abs(contracts),
                        entryPrice: parseFloat(pos.entry_price || '0'),
                        unrealizedPnl: parseFloat(pos.unrealized_pnl || '0'),
                        leverage: 1 // CFM doesn't report leverage per position
                    };
                }
            } else {
                // DEFAULT spot portfolios - no position tracking
                console.log(`[CoinbaseAPI] DEFAULT portfolio - position tracking not available via API`);
            }
            return null;
        } catch (error) {
            // 404 means no position
            if (error.message && (error.message.includes('404') || error.message.includes('NOT_FOUND'))) {
                return null;
            }
            throw error;
        }
    }
    
    /**
     * List all positions
     */
    async listPositions() {
        if (!this.portfolioUuid) {
            await this.discoverPortfolio();
        }
        
        if (this.isINTX()) {
            const data = await this.callAPI('GET', `/api/v3/brokerage/intx/positions/${this.portfolioUuid}`);
            return data.positions || [];
        } else {
            // Try CFM positions for futures
            try {
                return await this.getCFMPositions();
            } catch (error) {
                console.log(`[CoinbaseAPI] CFM positions not available:`, error.message);
                return [];
            }
        }
    }
    
    /**
     * Round price to valid tick size for a product
     * BIP (nano BTC): $5 increments
     * ETP (nano ETH): $1 increments (assumed)
     * 
     * For FOK orders, we try aggressive pricing first, then relax on retries:
     * - BUY: First try cheaper (round DOWN), retry with higher (round UP)
     * - SELL: First try expensive (round UP), retry with lower (round DOWN)
     * 
     * @param {string} productId - Product ID
     * @param {number|string} price - Price to round
     * @param {string} side - 'BUY' or 'SELL'
     * @param {boolean} aggressive - true = try better price, false = ensure fill
     */
    roundToTickSize(productId, price, side = 'BUY', aggressive = true) {
        const numPrice = parseFloat(price);
        const isBuy = side.toUpperCase() === 'BUY';
        
        // Aggressive: try to get better price (may not fill)
        // Conservative: give worse price to ensure fill
        let roundUp, roundDown;
        
        if (productId.startsWith('BIP')) {
            // Nano BTC: $5 increments
            roundUp = Math.ceil(numPrice / 5) * 5;
            roundDown = Math.floor(numPrice / 5) * 5;
        } else if (productId.startsWith('ETP')) {
            // Nano ETH: $1 increments
            roundUp = Math.ceil(numPrice);
            roundDown = Math.floor(numPrice);
        } else {
            // Default: 2 decimal places
            roundUp = Math.ceil(numPrice * 100) / 100;
            roundDown = Math.floor(numPrice * 100) / 100;
        }
        
        if (isBuy) {
            // BUY: aggressive = cheaper (down), conservative = higher (up)
            return aggressive ? roundDown : roundUp;
        } else {
            // SELL: aggressive = expensive (up), conservative = lower (down)
            return aggressive ? roundUp : roundDown;
        }
    }
    
    /**
     * Create a Limit Fill-or-Kill order with smart retry logic
     * 
     * Retry behavior:
     * - Opening positions: Max 100 retries, then abort with notification
     * - Closing positions: Unlimited retries (must exit position)
     * - FOK no-fill: Fast retry (50ms) to chase price
     * - Server error: Slower retry (500ms) to let server recover
     * 
     * @param {string} productId - e.g., 'BIP-20DEC30-CDE' or 'BTC-PERP-INTX'
     * @param {string} side - 'BUY' or 'SELL'
     * @param {string} size - Number of contracts
     * @param {string} price - Limit price
     * @param {string} leverage - Leverage multiplier (INTX only)
     * @param {function} getPriceCallback - Callback to get current price for retries
     * @param {object} options - Retry options
     * @param {number} options.maxRetries - Max attempts (0 = unlimited for closing)
     * @returns {object} Order result with order_id
     */
    async createLimitFOK(productId, side, size, price, leverage, getPriceCallback = null, options = {}) {
        const maxRetries = options.maxRetries ?? 100; // Default 100 for opens
        const unlimited = maxRetries === 0;
        const isCFM = this.isCFMFutures(productId);
        
        let attempt = 0;
        let lastError = null;
        
        console.log(`[CoinbaseAPI] Starting FOK order: ${side} ${size} ${productId} @ ~$${price} (${unlimited ? 'unlimited' : maxRetries + ' max'} retries)`);
        
        while (unlimited || attempt < maxRetries) {
            attempt++;
            
            // Get fresh price on each attempt (chase the market)
            let currentPrice = getPriceCallback ? getPriceCallback() : price;
            
            // Round to valid tick size for product
            // First attempt: aggressive (try to get better price)
            // Retries: conservative (give worse price to ensure fill)
            const aggressive = attempt === 1;
            const rawPrice = currentPrice;
            currentPrice = this.roundToTickSize(productId, currentPrice, side, aggressive);
            
            // Log first attempt, then every 10th
            if (attempt === 1 || attempt % 10 === 0) {
                console.log(`[CoinbaseAPI] Attempt ${attempt}${unlimited ? '' : '/' + maxRetries}: $${rawPrice} → $${currentPrice} (${side} ${aggressive ? 'aggressive' : 'conservative'})`);
            }
            
            const clientOrderId = `ob-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Build order body
            const orderBody = {
                client_order_id: clientOrderId,
                product_id: productId,
                side: side.toUpperCase(),
                order_configuration: {
                    limit_limit_fok: {
                        base_size: size.toString(),
                        limit_price: currentPrice.toString()
                    }
                }
            };
            
            // INTX perpetuals support leverage/margin in order
            if (!isCFM && leverage) {
                orderBody.leverage = leverage.toString();
                orderBody.margin_type = 'CROSS';
            }
            
            try {
                const data = await this.callAPI('POST', '/api/v3/brokerage/orders', orderBody);
                
                if (data.success) {
                    console.log(`[CoinbaseAPI] ✓ FILLED on attempt ${attempt}:`, data.success_response?.order_id);
                    return {
                        success: true,
                        orderId: data.success_response.order_id,
                        clientOrderId: clientOrderId,
                        fillPrice: currentPrice,
                        attempts: attempt
                    };
                } else {
                    // Order rejected/unfilled
                    const reason = data.failure_reason || data.error_response?.error || 'Unknown';
                    lastError = data.error_response?.message || reason;
                    
                    // Don't retry fatal errors
                    if (['INSUFFICIENT_FUND', 'MARGIN_INSUFFICIENT', 'INVALID_PRODUCT', 'INVALID_ORDER_CONFIG'].includes(reason)) {
                        console.error(`[CoinbaseAPI] ✗ Fatal error:`, reason);
                        return {
                            success: false,
                            error: reason,
                            message: lastError,
                            attempts: attempt
                        };
                    }
                    
                    // FOK didn't fill - fast retry (50ms) to chase price
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            } catch (error) {
                lastError = error.message;
                console.warn(`[CoinbaseAPI] Attempt ${attempt} error:`, error.message);
                
                // Server error - slower retry (500ms)
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        
        console.error(`[CoinbaseAPI] ✗ Failed after ${attempt} attempts. Last error: ${lastError}`);
        return {
            success: false,
            error: 'MAX_RETRIES_EXCEEDED',
            message: `Order could not be filled after ${attempt} attempts. ${lastError || ''}`,
            attempts: attempt
        };
    }
    
    /**
     * Close an existing position
     */
    async closePosition(productId, getPriceCallback = null, defaultLeverage = '1') {
        const position = await this.getPosition(productId);
        
        if (!position) {
            return { success: true, message: 'No position to close' };
        }
        
        // To close, we sell if long, buy if short
        const closeSide = position.side === 'long' ? 'SELL' : 'BUY';
        const currentPrice = getPriceCallback ? getPriceCallback() : null;
        
        if (!currentPrice) {
            throw new Error('Price required to close position');
        }
        
        // Use position leverage if available, otherwise use default
        const leverage = position.leverage > 0 ? position.leverage.toString() : defaultLeverage;
        
        return this.createLimitFOK(
            productId,
            closeSide,
            position.size.toString(),
            currentPrice.toString(),
            leverage,
            getPriceCallback
        );
    }
    
    /**
     * Cancel an order by ID
     * @returns {object} { success: boolean, failureReason?: string }
     */
    async cancelOrder(orderId) {
        console.log(`[CoinbaseAPI] Cancelling order: ${orderId}`);
        const data = await this.callAPI('POST', '/api/v3/brokerage/orders/batch_cancel', {
            order_ids: [orderId]
        });
        console.log(`[CoinbaseAPI] Cancel result:`, data);
        const result = data.results?.[0];
        return {
            success: result?.success || false,
            failureReason: result?.failure_reason || null
        };
    }
    
    /**
     * Get order details by ID
     */
    async getOrder(orderId) {
        const data = await this.callAPI('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
        this.log(`Order details:`, data);
        return data.order;
    }
    
    /**
     * Get order status (simplified for polling)
     * Returns: { status, filled, averageFilledPrice, filledSize }
     */
    async getOrderStatus(orderId) {
        const order = await this.getOrder(orderId);
        
        if (!order) {
            return { status: 'NOT_FOUND', filled: false };
        }
        
        const status = order.status?.toUpperCase();
        const filled = status === 'FILLED';
        
        return {
            status: status,
            filled: filled,
            averageFilledPrice: order.average_filled_price ? parseFloat(order.average_filled_price) : null,
            filledSize: order.filled_size ? parseFloat(order.filled_size) : null,
            order: order
        };
    }
    
    /**
     * Poll order status until it reaches a terminal state
     * Optimized for FOK orders which complete instantly
     * 
     * @param {string} orderId - Order ID to poll
     * @param {number} timeoutMs - Max time to wait (default 2 seconds for FOK)
     * @param {number} intervalMs - Poll interval (default 50ms)
     * @returns {object} Order status result
     */
    async pollOrderUntilComplete(orderId, timeoutMs = 2000, intervalMs = 50) {
        const startTime = Date.now();
        let attempts = 0;
        
        this.log(`Polling order ${orderId} (timeout: ${timeoutMs}ms, interval: ${intervalMs}ms)...`);
        
        while (Date.now() - startTime < timeoutMs) {
            attempts++;
            
            try {
                const result = await this.getOrderStatus(orderId);
                
                // Terminal states
                if (['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(result.status)) {
                    this.log(`Order ${orderId} → ${result.status} (${attempts} polls, ${Date.now() - startTime}ms)`);
                    return {
                        success: result.status === 'FILLED',
                        status: result.status,
                        orderId: orderId,
                        averageFilledPrice: result.averageFilledPrice,
                        filledSize: result.filledSize,
                        attempts: attempts,
                        order: result.order
                    };
                }
                
                // Still pending - wait and retry
                await new Promise(resolve => setTimeout(resolve, intervalMs));
                
            } catch (error) {
                this.warn(`Poll attempt ${attempts} failed:`, error.message);
                // Shorter delay on error for FOK orders
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        
        // Timeout - for FOK this means something is wrong
        this.error(`Order polling timed out after ${attempts} attempts (${Date.now() - startTime}ms)`);
        return {
            success: false,
            status: 'TIMEOUT',
            orderId: orderId,
            message: `Polling timed out after ${timeoutMs}ms`,
            attempts: attempts
        };
    }
    
    /**
     * Get open orders for a product
     * Uses same endpoint as Coinbase web UI
     */
    async getOpenOrders(productId = null) {
        let endpoint = '/api/v3/brokerage/orders/historical/batch?order_status=OPEN';
        if (productId) {
            endpoint += `&product_id=${productId}`;
        }
        
        const data = await this.callAPI('GET', endpoint);
        console.log(`[CoinbaseAPI] Open orders for ${productId || 'all'}:`, data);
        return data.orders || [];
    }
    
    /**
     * Get recent fills for a product
     */
    async getRecentFills(productId = null, limit = 50) {
        let endpoint = `/api/v3/brokerage/orders/historical/fills?limit=${limit}`;
        if (productId) {
            endpoint += `&product_id=${productId}`;
        }
        
        const data = await this.callAPI('GET', endpoint);
        console.log(`[CoinbaseAPI] Recent fills for ${productId || 'all'}:`, data);
        return data.fills || [];
    }
    
    /**
     * Test API connection
     */
    async testConnection() {
        this.log('Testing connection...');
        this.log('API Key (first 8 chars):', this.apiKey?.substring(0, 8) + '...');
        this.log('Private Key present:', !!this.privateKey);
        
        try {
            const data = await this.callAPI('GET', '/api/v3/brokerage/accounts');
            this.log('Connection test successful, accounts:', data.accounts?.length || 0);
            return {
                success: true,
                accounts: data.accounts?.length || 0
            };
        } catch (error) {
            this.error('Connection test failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Export for use in other modules
window.CoinbaseAPI = CoinbaseAPI;

