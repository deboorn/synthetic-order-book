/**
 * Coinbase Advanced Trade WebSocket Client
 * 
 * Provides real-time order status updates and futures balance monitoring.
 * Uses the User Order Data endpoint for authenticated order events.
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

class CoinbaseWebSocket {
    constructor(apiKey, privateKey, options = {}) {
        this.apiKey = apiKey;
        this.privateKey = privateKey;
        
        // WebSocket endpoint for user order data
        this.wsUrl = 'wss://advanced-trade-ws-user.coinbase.com';
        
        // Connection state
        this.ws = null;
        this.isConnected = false;
        this.isSubscribed = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity; // Never give up for trading
        this.reconnectDelay = 1000; // Start with 1 second
        this.maxReconnectDelay = 30000; // Cap at 30 seconds
        
        // Subscriptions
        this.subscribedProducts = new Set();
        this.subscribedChannels = new Set();
        
        // Heartbeat
        this.heartbeatInterval = null;
        this.heartbeatTimeout = options.heartbeatTimeout || 30000; // 30 seconds
        this.lastHeartbeat = null;
        
        // Pending orders waiting for status updates
        this.pendingOrders = new Map(); // orderId -> { resolve, reject, timeout }
        this.orderTimeout = options.orderTimeout || 5000; // 5 seconds before fallback
        
        // Balance state (updated via WebSocket)
        this.balanceSummary = null;
        
        // Event callbacks
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onOrderUpdate = options.onOrderUpdate || (() => {});
        this.onBalanceUpdate = options.onBalanceUpdate || (() => {});
        this.onError = options.onError || ((e) => console.error('[CoinbaseWS] Error:', e));
        
        // Debug mode
        this.debug = options.debug || false;
        
        // Status
        this.status = 'disconnected'; // disconnected, connecting, connected, subscribing, ready, error
    }
    
    log(...args) {
        if (this.debug) {
            console.log('[CoinbaseWS]', ...args);
        }
    }
    
    warn(...args) {
        console.warn('[CoinbaseWS]', ...args);
    }
    
    error(...args) {
        console.error('[CoinbaseWS]', ...args);
    }
    
    /**
     * Update connection status and notify listener
     */
    setStatus(status, message = '') {
        this.status = status;
        this.onStatusChange(status, message);
        this.log('Status:', status, message);
    }
    
    /**
     * Get JWT token from PHP proxy
     */
    async getJWT() {
        const formData = new FormData();
        formData.append('action', 'jwt');
        formData.append('apiKey', this.apiKey);
        formData.append('privateKey', this.privateKey);
        
        const response = await fetch('coinbase-advanced/proxy.php', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (!data.success || !data.jwt) {
            throw new Error(data.error || 'Failed to get JWT');
        }
        
        return data.jwt;
    }
    
    /**
     * Connect to WebSocket and subscribe to channels
     */
    async connect(productIds = []) {
        if (this.isConnected) {
            this.log('Already connected');
            return;
        }
        
        this.setStatus('connecting');
        
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.wsUrl);
                
                this.ws.onopen = async () => {
                    this.log('WebSocket opened');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.reconnectDelay = 1000;
                    
                    this.setStatus('connected');
                    
                    try {
                        // Subscribe to channels
                        await this.subscribe(productIds);
                        
                        // Start heartbeat monitoring
                        this.startHeartbeatMonitor();
                        
                        this.setStatus('ready');
                        resolve();
                    } catch (err) {
                        this.error('Subscription failed:', err);
                        this.setStatus('error', err.message);
                        reject(err);
                    }
                };
                
                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
                
                this.ws.onerror = (event) => {
                    this.error('WebSocket error:', event);
                    this.setStatus('error', 'Connection error');
                };
                
                this.ws.onclose = (event) => {
                    this.log('WebSocket closed:', event.code, event.reason);
                    this.isConnected = false;
                    this.isSubscribed = false;
                    this.stopHeartbeatMonitor();
                    
                    // Reject any pending orders
                    this.rejectAllPendingOrders('WebSocket disconnected');
                    
                    // Attempt reconnect if not intentional close
                    if (event.code !== 1000) {
                        this.attemptReconnect(productIds);
                    } else {
                        this.setStatus('disconnected');
                    }
                };
                
                // Set connection timeout
                setTimeout(() => {
                    if (!this.isConnected) {
                        this.ws.close();
                        reject(new Error('Connection timeout'));
                    }
                }, 10000);
                
            } catch (err) {
                this.error('Failed to create WebSocket:', err);
                this.setStatus('error', err.message);
                reject(err);
            }
        });
    }
    
    /**
     * Subscribe to channels
     */
    async subscribe(productIds = []) {
        if (!this.isConnected) {
            throw new Error('Not connected');
        }
        
        this.setStatus('subscribing');
        
        const jwt = await this.getJWT();
        
        // Subscribe to heartbeats channel (required to keep connection alive)
        await this.sendSubscription('heartbeats', [], jwt);
        
        // Subscribe to user channel for order updates
        await this.sendSubscription('user', productIds, jwt);
        
        // Subscribe to futures_balance_summary for margin updates
        await this.sendSubscription('futures_balance_summary', [], jwt);
        
        // Track subscribed products
        productIds.forEach(p => this.subscribedProducts.add(p));
        
        this.isSubscribed = true;
        this.log('Subscribed to channels:', Array.from(this.subscribedChannels));
    }
    
    /**
     * Send subscription message
     */
    async sendSubscription(channel, productIds, jwt) {
        const message = {
            type: 'subscribe',
            channel: channel,
            jwt: jwt
        };
        
        if (productIds.length > 0) {
            message.product_ids = productIds;
        }
        
        this.ws.send(JSON.stringify(message));
        this.subscribedChannels.add(channel);
        this.log('Sent subscription for channel:', channel);
    }
    
    /**
     * Handle incoming WebSocket message
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            
            // Update last heartbeat time on any message
            this.lastHeartbeat = Date.now();
            
            switch (message.channel) {
                case 'heartbeats':
                    this.handleHeartbeat(message);
                    break;
                    
                case 'user':
                    this.handleUserMessage(message);
                    break;
                    
                case 'futures_balance_summary':
                    this.handleBalanceSummary(message);
                    break;
                    
                case 'subscriptions':
                    this.log('Subscription confirmed:', message);
                    break;
                    
                default:
                    this.log('Unknown channel:', message.channel, message);
            }
        } catch (err) {
            this.warn('Failed to parse message:', err, data);
        }
    }
    
    /**
     * Handle heartbeat message
     */
    handleHeartbeat(message) {
        // Heartbeat keeps connection alive
        this.log('Heartbeat received');
    }
    
    /**
     * Handle user channel message (order updates)
     */
    handleUserMessage(message) {
        if (message.events) {
            for (const event of message.events) {
                if (event.type === 'update' && event.orders) {
                    for (const order of event.orders) {
                        this.handleOrderUpdate(order);
                    }
                }
            }
        }
    }
    
    /**
     * Handle individual order update
     */
    handleOrderUpdate(order) {
        this.log('Order update:', order.order_id, order.status);
        
        // Notify general listener
        this.onOrderUpdate(order);
        
        // Check if this order is being waited on
        const orderId = order.order_id;
        const pending = this.pendingOrders.get(orderId);
        
        if (pending) {
            const status = order.status?.toUpperCase();
            
            if (status === 'FILLED') {
                // Order filled - resolve the promise
                clearTimeout(pending.timeout);
                this.pendingOrders.delete(orderId);
                pending.resolve({
                    success: true,
                    status: 'FILLED',
                    orderId: orderId,
                    filledSize: order.filled_size || order.cumulative_quantity,
                    averageFilledPrice: order.average_filled_price,
                    order: order
                });
            } else if (['EXPIRED', 'CANCELLED', 'FAILED'].includes(status)) {
                // Order not filled - resolve with failure
                clearTimeout(pending.timeout);
                this.pendingOrders.delete(orderId);
                pending.resolve({
                    success: false,
                    status: status,
                    orderId: orderId,
                    order: order
                });
            }
            // For PENDING/OPEN status, keep waiting
        }
    }
    
    /**
     * Handle futures balance summary update
     */
    handleBalanceSummary(message) {
        if (message.events) {
            for (const event of message.events) {
                if (event.fcm_balance_summary) {
                    this.balanceSummary = event.fcm_balance_summary;
                    this.onBalanceUpdate(this.balanceSummary);
                    this.log('Balance updated:', 
                        'buyingPower:', this.balanceSummary.futures_buying_power?.value,
                        'unrealizedPnl:', this.balanceSummary.unrealized_pnl?.value
                    );
                }
            }
        }
    }
    
    /**
     * Wait for order status update via WebSocket
     * Returns a promise that resolves when order is FILLED or EXPIRED
     * Falls back to REST polling on timeout
     */
    waitForOrderStatus(orderId, timeoutMs = null) {
        const timeout = timeoutMs || this.orderTimeout;
        
        return new Promise((resolve) => {
            // Set timeout for fallback
            const timeoutId = setTimeout(() => {
                this.pendingOrders.delete(orderId);
                resolve({
                    success: false,
                    status: 'TIMEOUT',
                    orderId: orderId,
                    message: 'WebSocket timeout - use REST fallback'
                });
            }, timeout);
            
            // Store pending order
            this.pendingOrders.set(orderId, {
                resolve,
                timeout: timeoutId
            });
            
            this.log('Waiting for order status:', orderId);
        });
    }
    
    /**
     * Reject all pending orders (called on disconnect)
     */
    rejectAllPendingOrders(reason) {
        for (const [orderId, pending] of this.pendingOrders) {
            clearTimeout(pending.timeout);
            pending.resolve({
                success: false,
                status: 'DISCONNECTED',
                orderId: orderId,
                message: reason
            });
        }
        this.pendingOrders.clear();
    }
    
    /**
     * Start heartbeat monitor
     */
    startHeartbeatMonitor() {
        this.lastHeartbeat = Date.now();
        
        this.heartbeatInterval = setInterval(() => {
            const elapsed = Date.now() - this.lastHeartbeat;
            
            if (elapsed > this.heartbeatTimeout) {
                this.warn('Heartbeat timeout - reconnecting');
                this.ws.close(4000, 'Heartbeat timeout');
            }
        }, 5000);
    }
    
    /**
     * Stop heartbeat monitor
     */
    stopHeartbeatMonitor() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }
    
    /**
     * Attempt to reconnect with exponential backoff
     */
    attemptReconnect(productIds) {
        if (this.maxReconnectAttempts !== Infinity && this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.error('Max reconnect attempts reached');
            this.setStatus('error', 'Max reconnect attempts reached');
            return;
        }
        
        this.reconnectAttempts++;
        const maxDisplay = this.maxReconnectAttempts === Infinity ? '∞' : this.maxReconnectAttempts;
        this.setStatus('connecting', `Reconnecting (${this.reconnectAttempts}/${maxDisplay})...`);
        
        const currentDelay = this.reconnectDelay;
        setTimeout(() => {
            this.log(`Reconnecting attempt ${this.reconnectAttempts} after ${currentDelay}ms delay`);
            this.connect(productIds).catch(err => {
                this.warn('Reconnect failed:', err);
            });
        }, currentDelay);
        
        // Exponential backoff with cap
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }
    
    /**
     * Add product to subscription
     */
    async addProduct(productId) {
        if (this.subscribedProducts.has(productId)) {
            return; // Already subscribed
        }
        
        if (!this.isConnected) {
            this.subscribedProducts.add(productId);
            return;
        }
        
        try {
            const jwt = await this.getJWT();
            await this.sendSubscription('user', [productId], jwt);
            this.subscribedProducts.add(productId);
        } catch (err) {
            this.error('Failed to add product:', err);
        }
    }
    
    /**
     * Get current balance summary
     */
    getBalanceSummary() {
        return this.balanceSummary;
    }
    
    /**
     * Check if WebSocket is ready for trading
     */
    isReady() {
        return this.isConnected && this.isSubscribed;
    }
    
    /**
     * Disconnect WebSocket
     */
    disconnect() {
        this.log('Disconnecting...');
        this.stopHeartbeatMonitor();
        this.rejectAllPendingOrders('Intentional disconnect');
        
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        
        this.isConnected = false;
        this.isSubscribed = false;
        this.subscribedProducts.clear();
        this.subscribedChannels.clear();
        this.setStatus('disconnected');
    }
}

// Export for use in other modules
window.CoinbaseWebSocket = CoinbaseWebSocket;

