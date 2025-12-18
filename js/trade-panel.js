/**
 * Trade Panel - Simulated Trading based on Live Signals
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

class TradePanel {
    constructor(app, instanceId = '1') {
        this.app = app;
        this.instanceId = instanceId;
        this.storagePrefix = `tradeSim${instanceId}`;
        
        // State
        this.isRunning = false;
        this.position = null; // null, 'long', or 'short'
        this.entryPrice = null;
        this.entryTime = null;
        
        // Signal tracking for debounce
        this.lastSignalDirection = null;
        this.signalStartTime = null;
        this.signalConfirmed = false;
        
        // Persistent signal state - remains until opposing signal meets threshold
        this.lockedSignal = null; // 'buy' or 'sell' - persists until opposing signal confirmed
        
        // Open trade tracking
        this.openTradeId = null;
        
        // Config
        this.signalSource = 'l-drift'; // 'l-drift' or 'l-prox'
        this.threshold = 2.0; // seconds
        this.tradeMode = 'both'; // 'both', 'long', 'short'
        
        // Trade history
        this.trades = [];
        this.totalPnl = 0;
        this.wins = 0;
        this.losses = 0;
        
        // DOM Elements
        this.elements = {};
        
        // Update interval
        this.updateInterval = null;
        
        this.init();
    }
    
    init() {
        this.cacheElements();
        this.loadState();
        this.bindEvents();
        this.render();
    }
    
    cacheElements() {
        const id = this.instanceId;
        this.elements = {
            status: document.getElementById(`tradeSim${id}Status`),
            signalSelect: document.getElementById(`tradeSim${id}Signal`),
            thresholdInput: document.getElementById(`tradeSim${id}Threshold`),
            modeSelect: document.getElementById(`tradeSim${id}Mode`),
            startBtn: document.getElementById(`tradeSim${id}Start`),
            stopBtn: document.getElementById(`tradeSim${id}Stop`),
            clearBtn: document.getElementById(`tradeSim${id}Clear`),
            lockedSignal: document.getElementById(`tradeSim${id}LockedSignal`),
            positionValue: document.getElementById(`tradeSim${id}PositionValue`),
            entryPrice: document.getElementById(`tradeSim${id}EntryPrice`),
            pnl: document.getElementById(`tradeSim${id}Pnl`),
            wins: document.getElementById(`tradeSim${id}Wins`),
            losses: document.getElementById(`tradeSim${id}Losses`),
            log: document.getElementById(`tradeSim${id}Log`)
        };
    }
    
    loadState() {
        // Migrate old localStorage keys for first instance (backward compatibility)
        if (this.instanceId === '1') {
            this.migrateOldStorage();
        }
        
        // Load config
        const savedSignal = localStorage.getItem(`${this.storagePrefix}Signal`);
        if (savedSignal) {
            this.signalSource = savedSignal;
            if (this.elements.signalSelect) {
                this.elements.signalSelect.value = savedSignal;
            }
        }
        
        const savedThreshold = localStorage.getItem(`${this.storagePrefix}Threshold`);
        if (savedThreshold) {
            this.threshold = parseFloat(savedThreshold);
            if (this.elements.thresholdInput) {
                this.elements.thresholdInput.value = this.threshold;
            }
        }
        
        const savedMode = localStorage.getItem(`${this.storagePrefix}Mode`);
        if (savedMode) {
            this.tradeMode = savedMode;
            if (this.elements.modeSelect) {
                this.elements.modeSelect.value = savedMode;
            }
        }
        
        // Load trade history
        const savedTrades = localStorage.getItem(`${this.storagePrefix}Trades`);
        if (savedTrades) {
            try {
                this.trades = JSON.parse(savedTrades);
                this.recalculateStats();
            } catch (e) {
                this.trades = [];
            }
        }
        
        // Load and restore active position state
        const activeState = this.loadActivePosition();
        if (activeState) {
            this.position = activeState.position;
            this.entryPrice = activeState.entryPrice;
            this.entryTime = activeState.entryTime;
            this.openTradeId = activeState.openTradeId;
            this.lockedSignal = activeState.lockedSignal;
            this.lastSignalDirection = activeState.lastSignalDirection;
            this.signalStartTime = activeState.signalStartTime;
            this.signalConfirmed = activeState.signalConfirmed;
            
            // Auto-resume if simulator was running
            if (activeState.isRunning) {
                // Defer start until after DOM is ready
                setTimeout(() => this.resumeFromSavedState(), 100);
            }
        }
    }
    
    /**
     * Resume simulator from saved state (after page refresh)
     */
    resumeFromSavedState() {
        if (this.isRunning) return; // Already running
        
        this.isRunning = true;
        
        // Update UI to running state
        if (this.elements.startBtn) this.elements.startBtn.disabled = true;
        if (this.elements.stopBtn) this.elements.stopBtn.disabled = false;
        if (this.elements.signalSelect) this.elements.signalSelect.disabled = true;
        if (this.elements.thresholdInput) this.elements.thresholdInput.disabled = true;
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = true;
        if (this.elements.status) {
            this.elements.status.textContent = 'Running';
            this.elements.status.classList.add('running');
        }
        
        // Render current state
        this.renderLockedSignal();
        this.renderPosition();
        this.renderLog();
        
        // Start polling
        this.updateInterval = setInterval(() => this.checkSignal(), 100);
        
        console.log('[TradePanel] Resumed from saved state - position:', this.position || 'none', 'lockedSignal:', this.lockedSignal || 'none');
    }
    
    migrateOldStorage() {
        // Migrate from old 'tradeSim*' keys to new 'tradeSim1*' keys
        const oldKeys = ['tradeSimSignal', 'tradeSimThreshold', 'tradeSimMode', 'tradeSimTrades'];
        const newKeys = ['tradeSim1Signal', 'tradeSim1Threshold', 'tradeSim1Mode', 'tradeSim1Trades'];
        
        for (let i = 0; i < oldKeys.length; i++) {
            const oldValue = localStorage.getItem(oldKeys[i]);
            if (oldValue && !localStorage.getItem(newKeys[i])) {
                localStorage.setItem(newKeys[i], oldValue);
                localStorage.removeItem(oldKeys[i]);
            }
        }
    }
    
    saveState() {
        localStorage.setItem(`${this.storagePrefix}Signal`, this.signalSource);
        localStorage.setItem(`${this.storagePrefix}Threshold`, this.threshold.toString());
        localStorage.setItem(`${this.storagePrefix}Mode`, this.tradeMode);
        // Save all trades including open ones
        localStorage.setItem(`${this.storagePrefix}Trades`, JSON.stringify(this.trades));
    }
    
    /**
     * Save active position state for persistence across page refresh
     */
    saveActivePosition() {
        const activeState = {
            isRunning: this.isRunning,
            position: this.position,
            entryPrice: this.entryPrice,
            entryTime: this.entryTime,
            openTradeId: this.openTradeId,
            lockedSignal: this.lockedSignal,
            lastSignalDirection: this.lastSignalDirection,
            signalStartTime: this.signalStartTime,
            signalConfirmed: this.signalConfirmed
        };
        localStorage.setItem(`${this.storagePrefix}ActivePosition`, JSON.stringify(activeState));
    }
    
    /**
     * Load active position state from localStorage
     */
    loadActivePosition() {
        const saved = localStorage.getItem(`${this.storagePrefix}ActivePosition`);
        if (!saved) return null;
        
        try {
            return JSON.parse(saved);
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Clear active position state from localStorage
     */
    clearActivePosition() {
        localStorage.removeItem(`${this.storagePrefix}ActivePosition`);
    }
    
    bindEvents() {
        // Signal source change
        if (this.elements.signalSelect) {
            this.elements.signalSelect.addEventListener('change', (e) => {
                this.signalSource = e.target.value;
                this.saveState();
            });
        }
        
        // Threshold change
        if (this.elements.thresholdInput) {
            this.elements.thresholdInput.addEventListener('change', (e) => {
                this.threshold = parseFloat(e.target.value) || 2.0;
                if (this.threshold < 0.1) this.threshold = 0.1;
                if (this.threshold > 60) this.threshold = 60;
                e.target.value = this.threshold;
                this.saveState();
            });
        }
        
        // Trade mode change
        if (this.elements.modeSelect) {
            this.elements.modeSelect.addEventListener('change', (e) => {
                this.tradeMode = e.target.value;
                this.saveState();
            });
        }
        
        // Start button
        if (this.elements.startBtn) {
            this.elements.startBtn.addEventListener('click', () => this.start());
        }
        
        // Stop button
        if (this.elements.stopBtn) {
            this.elements.stopBtn.addEventListener('click', () => this.stop());
        }
        
        // Clear button
        if (this.elements.clearBtn) {
            this.elements.clearBtn.addEventListener('click', () => this.clear());
        }
    }
    
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.signalConfirmed = false;
        this.lockedSignal = null;
        
        // Check if there's already a signal - start threshold timer immediately
        const currentSignal = this.getCurrentSignal();
        if (currentSignal) {
            this.lastSignalDirection = currentSignal;
            this.signalStartTime = Date.now();
        } else {
            this.lastSignalDirection = null;
            this.signalStartTime = null;
        }
        
        // Update UI
        this.elements.startBtn.disabled = true;
        this.elements.stopBtn.disabled = false;
        this.elements.signalSelect.disabled = true;
        this.elements.thresholdInput.disabled = true;
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = true;
        this.elements.status.textContent = 'Running';
        this.elements.status.classList.add('running');
        
        // Render locked signal indicator
        this.renderLockedSignal();
        
        // Start polling
        this.updateInterval = setInterval(() => this.checkSignal(), 100);
        
        // Save running state for persistence
        this.saveActivePosition();
        
        console.log('[TradePanel] Started monitoring', this.signalSource, 'mode:', this.tradeMode, 'initial signal:', currentSignal || 'none');
    }
    
    stop() {
        if (!this.isRunning) return;
        
        // Close any open position
        if (this.position) {
            this.closePosition('Stop clicked');
        }
        
        this.isRunning = false;
        
        // Clear interval
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        // Reset signal tracking
        this.signalStartTime = null;
        this.lastSignalDirection = null;
        this.signalConfirmed = false;
        this.lockedSignal = null;
        
        // Update UI
        this.elements.startBtn.disabled = false;
        this.elements.stopBtn.disabled = true;
        this.elements.signalSelect.disabled = false;
        this.elements.thresholdInput.disabled = false;
        if (this.elements.modeSelect) this.elements.modeSelect.disabled = false;
        this.elements.status.textContent = 'Idle';
        this.elements.status.classList.remove('running');
        
        // Clear locked signal indicator
        this.renderLockedSignal();
        
        // Clear saved active position state
        this.clearActivePosition();
        
        console.log('[TradePanel] Stopped');
    }
    
    clear() {
        // Stop if running
        if (this.isRunning) {
            this.stop();
        }
        
        // Clear position
        this.position = null;
        this.entryPrice = null;
        this.entryTime = null;
        this.openTradeId = null;
        
        // Clear history
        this.trades = [];
        this.totalPnl = 0;
        this.wins = 0;
        this.losses = 0;
        
        // Clear active position storage and save
        this.clearActivePosition();
        this.saveState();
        this.render();
        
        console.log('[TradePanel] Cleared all trades');
    }
    
    getCurrentSignal() {
        if (!this.app || !this.app.chart) return null;
        
        const chart = this.app.chart;
        
        // Get individual signal directions
        const lProx = chart.liveProximity?.lastSignal?.direction || null;
        const lDrift = chart.liveDrift?.lastSignal?.direction || null;
        const prox = (chart.clusterProximity?.isLocked && chart.clusterProximity?.lastSignal?.direction) || null;
        const drift = (chart.clusterDrift?.isLocked && chart.clusterDrift?.lastSignal?.direction) || null;
        
        // Helper to convert direction to 'up'/'down'
        const toDir = (d) => d === 'buy' ? 'up' : (d === 'sell' ? 'down' : null);
        
        // Helper to combine two signals (up+up=up, down+down=down, else flat)
        const combine = (a, b) => {
            const dirA = toDir(a);
            const dirB = toDir(b);
            if (!dirA || !dirB) return null;
            if (dirA === dirB) return dirA === 'up' ? 'buy' : 'sell';
            return 'flat'; // Conflicting signals
        };
        
        let result = null;
        
        switch (this.signalSource) {
            case 'l-drift':
                result = lDrift;
                break;
                
            case 'l-prox':
                result = lProx;
                break;
                
            case 'l-combo':
                // l-prox + l-drift combined (flat = no action)
                result = combine(lProx, lDrift);
                break;
                
            case 'prox':
                // Confirmed proximity only
                result = prox;
                break;
                
            case 'drift':
                // Confirmed drift only
                result = drift;
                break;
                
            case 'combo':
                // prox + drift combined (confirmed signals)
                result = combine(prox, drift);
                break;
                
            case '3of4':
                // 3 out of 4 signals must agree
                const signals3of4 = [lProx, lDrift, prox, drift].filter(s => s !== null);
                const buyCount = signals3of4.filter(s => s === 'buy').length;
                const sellCount = signals3of4.filter(s => s === 'sell').length;
                if (buyCount >= 3) result = 'buy';
                else if (sellCount >= 3) result = 'sell';
                break;
                
            case 'all4':
                // All 4 signals must agree
                const all = [lProx, lDrift, prox, drift];
                const validSignals = all.filter(s => s !== null);
                if (validSignals.length === 4) {
                    const allBuy = validSignals.every(s => s === 'buy');
                    const allSell = validSignals.every(s => s === 'sell');
                    if (allBuy) result = 'buy';
                    else if (allSell) result = 'sell';
                    else result = 'flat';
                }
                break;
                
            default:
                result = null;
        }
        
        // Return 'buy', 'sell', or null (flat returns null to avoid action)
        if (result === 'flat') return null;
        return result;
    }
    
    checkSignal() {
        if (!this.isRunning) return;
        
        const currentSignal = this.getCurrentSignal();
        const now = Date.now();
        
        // Update live P&L for open trades
        if (this.openTradeId) {
            this.renderLog();
        }
        
        // No signal - reset tracking but keep locked signal
        if (!currentSignal) {
            this.lastSignalDirection = null;
            this.signalStartTime = null;
            this.signalConfirmed = false;
            return;
        }
        
        // Signal changed - reset timer for potential new lock
        if (currentSignal !== this.lastSignalDirection) {
            this.lastSignalDirection = currentSignal;
            this.signalStartTime = now;
            this.signalConfirmed = false;
            return;
        }
        
        // Same signal - check if threshold met for locking
        if (!this.signalConfirmed && this.signalStartTime) {
            const elapsed = (now - this.signalStartTime) / 1000;
            
            if (elapsed >= this.threshold) {
                this.signalConfirmed = true;
                
                // Only trigger trade if this is a NEW locked signal (different from current lock)
                // This provides signal persistence - signal stays locked until opposing threshold met
                if (this.lockedSignal !== currentSignal) {
                    this.lockedSignal = currentSignal;
                    this.renderLockedSignal();
                    this.saveActivePosition(); // Save signal state changes
                    this.onSignalConfirmed(currentSignal);
                }
            }
        }
    }
    
    onSignalConfirmed(signalDirection) {
        const price = this.app?.currentPrice;
        if (!price) return;
        
        // Determine trade direction from signal
        // 'buy' signal = go long, 'sell' signal = go short
        const tradeDirection = signalDirection === 'buy' ? 'long' : 'short';
        
        // Check if this trade direction is allowed by mode
        const canTrade = this.canTradeDirection(tradeDirection);
        
        if (!this.position) {
            // No position - open one if allowed
            if (canTrade) {
                this.openPosition(tradeDirection, price);
            }
        } else if (this.position !== tradeDirection) {
            // Opposite signal - close current position
            this.closePosition('Signal reversed');
            
            // Open new position if allowed
            if (canTrade) {
                this.openPosition(tradeDirection, price);
            }
        }
        // Same direction - do nothing (already in position)
    }
    
    canTradeDirection(direction) {
        if (this.tradeMode === 'both') return true;
        if (this.tradeMode === 'long' && direction === 'long') return true;
        if (this.tradeMode === 'short' && direction === 'short') return true;
        return false;
    }
    
    openPosition(direction, price) {
        this.position = direction;
        this.entryPrice = price;
        this.entryTime = Date.now();
        
        // Add open trade to log immediately
        const openTrade = {
            id: Date.now(), // Unique ID to find it later
            type: direction,
            entryPrice: price,
            exitPrice: null,
            pnl: null,
            entryTime: this.entryTime,
            exitTime: null,
            isOpen: true
        };
        this.trades.unshift(openTrade);
        this.openTradeId = openTrade.id;
        
        console.log(`[TradePanel] Opened ${direction.toUpperCase()} @ $${price.toFixed(2)}`);
        
        // Save active position state for persistence
        this.saveActivePosition();
        this.saveState();
        
        this.renderPosition();
        this.renderLog();
    }
    
    closePosition(reason = '') {
        if (!this.position || !this.entryPrice) return;
        
        const exitPrice = this.app?.currentPrice || this.entryPrice;
        const exitTime = Date.now();
        
        // Calculate P&L
        let pnl;
        if (this.position === 'long') {
            pnl = exitPrice - this.entryPrice;
        } else {
            pnl = this.entryPrice - exitPrice;
        }
        
        // Calculate P&L percentage
        const pnlPercent = (pnl / this.entryPrice) * 100;
        
        // Calculate duration
        const duration = exitTime - this.entryTime;
        
        // Find and update the open trade entry
        const openTrade = this.trades.find(t => t.id === this.openTradeId);
        if (openTrade) {
            openTrade.exitPrice = exitPrice;
            openTrade.pnl = pnl;
            openTrade.pnlPercent = pnlPercent;
            openTrade.exitTime = exitTime;
            openTrade.duration = duration;
            openTrade.isOpen = false;
        }
        this.openTradeId = null;
        
        // Update stats
        this.totalPnl += pnl;
        if (pnl >= 0) {
            this.wins++;
        } else {
            this.losses++;
        }
        
        console.log(`[TradePanel] Closed ${this.position.toUpperCase()} @ $${exitPrice.toFixed(2)} | P&L: $${pnl.toFixed(2)} | ${reason}`);
        
        // Reset position
        this.position = null;
        this.entryPrice = null;
        this.entryTime = null;
        
        // Save state (including updated active position)
        this.saveActivePosition();
        this.saveState();
        this.render();
    }
    
    recalculateStats() {
        this.totalPnl = 0;
        this.wins = 0;
        this.losses = 0;
        
        for (const trade of this.trades) {
            // Only count closed trades for stats
            if (trade.isOpen || trade.pnl === null) continue;
            
            this.totalPnl += trade.pnl;
            if (trade.pnl >= 0) {
                this.wins++;
            } else {
                this.losses++;
            }
        }
    }
    
    render() {
        this.renderPosition();
        this.renderSummary();
        this.renderLog();
    }
    
    renderPosition() {
        if (!this.elements.positionValue) return;
        
        if (this.position) {
            this.elements.positionValue.textContent = this.position.toUpperCase();
            this.elements.positionValue.className = 'position-value ' + this.position;
            
            if (this.entryPrice) {
                this.elements.entryPrice.textContent = `@ $${this.entryPrice.toFixed(2)}`;
            }
        } else {
            this.elements.positionValue.textContent = 'None';
            this.elements.positionValue.className = 'position-value none';
            this.elements.entryPrice.textContent = '';
        }
    }
    
    renderSummary() {
        if (this.elements.pnl) {
            const sign = this.totalPnl >= 0 ? '+' : '';
            this.elements.pnl.textContent = `${sign}$${this.totalPnl.toFixed(2)}`;
            this.elements.pnl.className = 'stat-value ' + (this.totalPnl >= 0 ? 'positive' : 'negative');
        }
        
        if (this.elements.wins) {
            this.elements.wins.textContent = this.wins.toString();
        }
        
        if (this.elements.losses) {
            this.elements.losses.textContent = this.losses.toString();
        }
    }
    
    renderLog() {
        if (!this.elements.log) return;
        
        if (this.trades.length === 0) {
            this.elements.log.innerHTML = '<div class="trade-log-empty">No trades yet</div>';
            return;
        }
        
        let html = '';
        for (const trade of this.trades.slice(0, 20)) { // Show last 20
            if (trade.isOpen) {
                // Open trade - show live P&L and duration
                const currentPrice = this.app?.currentPrice || trade.entryPrice;
                let livePnl;
                if (trade.type === 'long') {
                    livePnl = currentPrice - trade.entryPrice;
                } else {
                    livePnl = trade.entryPrice - currentPrice;
                }
                const livePnlPercent = (livePnl / trade.entryPrice) * 100;
                const liveDuration = Date.now() - trade.entryTime;
                const pnlClass = livePnl >= 0 ? 'profit' : 'loss';
                const sign = livePnl >= 0 ? '+' : '';
                
                html += `
                    <div class="trade-log-entry open ${pnlClass}" data-trade-id="${trade.id}">
                        <span class="trade-type ${trade.type}">${trade.type.toUpperCase()}</span>
                        <span class="trade-duration">${this.formatDuration(liveDuration)}</span>
                        <span class="trade-pnl-group">
                            <span class="trade-pnl-dollar">${sign}$${livePnl.toFixed(2)}</span>
                            <span class="trade-pnl-percent">${sign}${livePnlPercent.toFixed(2)}%</span>
                        </span>
                    </div>
                `;
            } else {
                // Closed trade
                const pnlClass = trade.pnl >= 0 ? 'profit' : 'loss';
                const sign = trade.pnl >= 0 ? '+' : '';
                const pnlPercent = trade.pnlPercent || (trade.pnl / trade.entryPrice) * 100;
                const duration = trade.duration || (trade.exitTime - trade.entryTime);
                
                html += `
                    <div class="trade-log-entry ${pnlClass}" data-trade-id="${trade.id}">
                        <span class="trade-type ${trade.type}">${trade.type.toUpperCase()}</span>
                        <span class="trade-duration">${this.formatDuration(duration)}</span>
                        <span class="trade-pnl-group">
                            <span class="trade-pnl-dollar">${sign}$${trade.pnl.toFixed(2)}</span>
                            <span class="trade-pnl-percent">${sign}${pnlPercent.toFixed(2)}%</span>
                        </span>
                    </div>
                `;
            }
        }
        
        this.elements.log.innerHTML = html;
        
        // Bind click events for trade details
        this.elements.log.querySelectorAll('.trade-log-entry').forEach(entry => {
            entry.addEventListener('click', () => {
                const tradeId = parseInt(entry.dataset.tradeId);
                this.showTradeDetail(tradeId);
            });
        });
    }
    
    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }
    
    showTradeDetail(tradeId) {
        const trade = this.trades.find(t => t.id === tradeId);
        if (!trade) return;
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'trade-detail-modal';
        
        const entryTime = new Date(trade.entryTime).toLocaleTimeString();
        
        modal.innerHTML = `
            <div class="trade-detail-backdrop"></div>
            <div class="trade-detail-content">
                <div class="trade-detail-header">
                    <span class="trade-detail-type ${trade.type}">${trade.type.toUpperCase()}</span>
                    ${trade.isOpen ? '<span class="trade-detail-status">OPEN</span>' : '<span class="trade-detail-status closed">CLOSED</span>'}
                    <button class="trade-detail-close">&times;</button>
                </div>
                <div class="trade-detail-body">
                    <div class="trade-detail-row">
                        <span class="detail-label">Entry Price</span>
                        <span class="detail-value">$${trade.entryPrice.toFixed(2)}</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">${trade.isOpen ? 'Current Price' : 'Exit Price'}</span>
                        <span class="detail-value" id="modalExitPrice">—</span>
                    </div>
                    <div class="trade-detail-row highlight" id="modalPnlRow">
                        <span class="detail-label">P&L</span>
                        <span class="detail-value" id="modalPnlValue">—</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Duration</span>
                        <span class="detail-value" id="modalDuration">—</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Entry Time</span>
                        <span class="detail-value">${entryTime}</span>
                    </div>
                    <div class="trade-detail-row">
                        <span class="detail-label">Exit Time</span>
                        <span class="detail-value" id="modalExitTime">${trade.isOpen ? 'Active' : new Date(trade.exitTime).toLocaleTimeString()}</span>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Get references to dynamic elements
        const contentEl = modal.querySelector('.trade-detail-content');
        const exitPriceEl = modal.querySelector('#modalExitPrice');
        const pnlRowEl = modal.querySelector('#modalPnlRow');
        const pnlValueEl = modal.querySelector('#modalPnlValue');
        const durationEl = modal.querySelector('#modalDuration');
        
        // Update function for modal values
        const updateModalValues = () => {
            const currentTrade = this.trades.find(t => t.id === tradeId);
            if (!currentTrade) return;
            
            let pnl, pnlPercent, duration, exitPrice;
            
            if (currentTrade.isOpen) {
                // Live values for open trade
                exitPrice = this.app?.currentPrice || currentTrade.entryPrice;
                if (currentTrade.type === 'long') {
                    pnl = exitPrice - currentTrade.entryPrice;
                } else {
                    pnl = currentTrade.entryPrice - exitPrice;
                }
                pnlPercent = (pnl / currentTrade.entryPrice) * 100;
                duration = Date.now() - currentTrade.entryTime;
            } else {
                // Final values for closed trade
                pnl = currentTrade.pnl;
                pnlPercent = currentTrade.pnlPercent || (currentTrade.pnl / currentTrade.entryPrice) * 100;
                duration = currentTrade.duration || (currentTrade.exitTime - currentTrade.entryTime);
                exitPrice = currentTrade.exitPrice;
            }
            
            const pnlClass = pnl >= 0 ? 'profit' : 'loss';
            const sign = pnl >= 0 ? '+' : '';
            
            // Update DOM
            exitPriceEl.textContent = `$${exitPrice.toFixed(2)}`;
            pnlValueEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPercent.toFixed(3)}%)`;
            durationEl.textContent = this.formatDuration(duration);
            
            // Update classes
            contentEl.className = `trade-detail-content ${pnlClass}`;
            pnlRowEl.className = `trade-detail-row highlight ${pnlClass}`;
        };
        
        // Initial update
        updateModalValues();
        
        // Set up live updates for open trades
        let updateInterval = null;
        if (trade.isOpen) {
            updateInterval = setInterval(updateModalValues, 100);
        }
        
        // Close handlers
        const closeModal = () => {
            if (updateInterval) clearInterval(updateInterval);
            modal.remove();
        };
        modal.querySelector('.trade-detail-backdrop').addEventListener('click', closeModal);
        modal.querySelector('.trade-detail-close').addEventListener('click', closeModal);
    }
    
    renderLockedSignal() {
        if (!this.elements.lockedSignal) return;
        
        if (this.lockedSignal && this.isRunning) {
            this.elements.lockedSignal.textContent = this.lockedSignal.toUpperCase();
            this.elements.lockedSignal.className = 'locked-signal-value ' + this.lockedSignal;
        } else {
            this.elements.lockedSignal.textContent = '—';
            this.elements.lockedSignal.className = 'locked-signal-value none';
        }
    }
    
    // Called by app when signals update - can be used for more responsive updates
    onSignalUpdate() {
        // The polling interval handles this, but this method allows
        // direct integration if needed for faster response
    }
}

// Export for use in app.js
window.TradePanel = TradePanel;

