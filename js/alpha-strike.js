/**
 * Synthetic Order Book - Alpha Strike Signal
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Pure Alpha Directional Signal Panel
 * Synthesizes all indicators into clear LONG/SHORT/FLAT signals
 */

class AlphaStrike {
    constructor() {
        // Current mode: 'mm', 'swing', 'htf'
        this.mode = localStorage.getItem('alphaStrikeMode') || 'htf';
        
        // Mode configurations
        this.modeConfig = {
            mm: {
                label: 'MM',
                confluenceRequired: 3,
                signalCooldown: 1,      // bars
                sensitivity: 'high',
                description: 'Fast signals for scalping'
            },
            swing: {
                label: 'Swing',
                confluenceRequired: 4,
                signalCooldown: 3,
                sensitivity: 'medium',
                description: 'Balanced for swing trading'
            },
            htf: {
                label: 'HTF',
                confluenceRequired: 5,
                signalCooldown: 6,
                sensitivity: 'low',
                description: 'Conservative for position trading'
            }
        };
        
        // Current state
        this.currentSignal = {
            direction: 'neutral',   // 'long', 'short', 'neutral'
            strength: 0,            // 0-100
            action: 'wait',         // 'entry', 'exit', 'hold', 'wait'
            confluence: {
                mcs: 'neutral',
                alpha: 'neutral',
                ld: 'neutral',
                bbp: 'neutral',
                forecast: 'neutral'
            },
            reasoning: '',
            timestamp: Date.now()
        };
        
        // Signal history for cooldown
        this.signalHistory = [];
        this.lastSignalChange = 0;
        
        // DOM elements (cached)
        this.elements = null;
        
        // Callbacks
        this.onSignalChange = null;
        
        // Initialize
        this.init();
    }
    
    /**
     * Initialize the panel
     */
    init() {
        this.cacheElements();
        this.setupModeSelector();
        this.updateModeUI();
    }
    
    /**
     * Cache DOM elements
     */
    cacheElements() {
        this.elements = {
            panel: document.getElementById('alphaStrikePanel'),
            direction: document.getElementById('strikeDirection'),
            arrow: document.getElementById('strikeArrow'),
            label: document.getElementById('strikeLabel'),
            strength: document.getElementById('strikeStrength'),
            meterFill: document.getElementById('strikeMeterFill'),
            actionBadge: document.getElementById('strikeActionBadge'),
            countdown: document.getElementById('strikeCountdown'),
            confluence: document.getElementById('strikeConfluence'),
            confluenceScore: document.getElementById('confluenceScore'),
            reasoning: document.getElementById('strikeReasoning'),
            modeSelector: document.getElementById('strikeModeSelector')
        };
    }
    
    /**
     * Setup mode selector buttons
     */
    setupModeSelector() {
        if (!this.elements.modeSelector) {
            console.warn('[Alpha Strike] Mode selector not found');
            return;
        }
        
        const buttons = this.elements.modeSelector.querySelectorAll('.strike-mode-btn');
        console.log('[Alpha Strike] Found', buttons.length, 'mode buttons');
        
        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const mode = btn.dataset.mode;
                console.log('[Alpha Strike] Mode clicked:', mode);
                this.setMode(mode);
            });
        });
    }
    
    /**
     * Set trading mode
     * @param {boolean} syncOthers - Whether to sync other panels (default true, false during init)
     */
    setMode(mode, syncOthers = true) {
        if (!this.modeConfig[mode]) return;
        
        const config = this.modeConfig[mode];
        console.log(`[Alpha Strike] Mode set to ${mode.toUpperCase()} - needs ${config.confluenceRequired}/5 confluence`);
        
        this.mode = mode;
        localStorage.setItem('alphaStrikeMode', mode);
        this.updateModeUI();
        
        // Recalculate signal with new mode settings
        if (this.lastData) {
            this.update(this.lastData);
        }
        
        // Only sync other panels if requested (avoid errors during early initialization)
        if (syncOthers) {
            // Notify strike zones to update
            if (typeof strikeZones !== 'undefined' && strikeZones.setMode) {
                strikeZones.setMode(mode);
            }
            
            // Notify whale flow to update thresholds
            if (typeof whaleFlow !== 'undefined' && whaleFlow.setMode) {
                whaleFlow.setMode(mode);
            }
        }
    }
    
    /**
     * Update mode selector UI
     */
    updateModeUI() {
        if (!this.elements.modeSelector) return;
        
        const buttons = this.elements.modeSelector.querySelectorAll('.strike-mode-btn');
        buttons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.mode);
        });
    }
    
    /**
     * Update signal with latest indicator data
     * @param {Object} data - Indicator data from app.js
     */
    update(data) {
        if (!data) return;
        
        // Store for recalculation on mode change
        this.lastData = data;
        
        const confluence = this.calculateConfluence(data);
        const direction = this.determineDirection(confluence);
        const strength = this.calculateStrength(confluence, data);
        const action = this.determineAction(direction, strength, data);
        const reasoning = this.generateReasoning(confluence, direction, data);
        
        // Update current signal
        this.currentSignal = {
            direction,
            strength,
            action,
            confluence,
            reasoning,
            timestamp: Date.now()
        };
        
        // Track signal changes
        if (this.lastDirection !== direction) {
            this.lastDirection = direction;
            this.lastSignalChange = Date.now();
            this.signalHistory.push({
                direction,
                strength,
                timestamp: Date.now()
            });
            
            // Trim history
            if (this.signalHistory.length > 50) {
                this.signalHistory = this.signalHistory.slice(-50);
            }
            
            // Trigger callback
            if (this.onSignalChange) {
                this.onSignalChange(this.currentSignal);
            }
        }
        
        // Update UI
        this.render();
    }
    
    /**
     * Calculate confluence from all indicators
     */
    calculateConfluence(data) {
        const confluence = {
            mcs: 'neutral',
            alpha: 'neutral',
            ld: 'neutral',
            bbp: 'neutral',
            forecast: 'neutral'
        };
        
        // MCS (Market Consensus)
        if (data.mcs) {
            if (data.mcs.bias === 'bullish' || data.mcs.signal === 'LONG') {
                confluence.mcs = 'bullish';
            } else if (data.mcs.bias === 'bearish' || data.mcs.signal === 'SHORT') {
                confluence.mcs = 'bearish';
            }
        }
        
        // Alpha Score
        if (data.alpha !== undefined) {
            if (data.alpha >= 60) {
                confluence.alpha = 'bullish';
            } else if (data.alpha <= 40) {
                confluence.alpha = 'bearish';
            }
        }
        
        // Liquidity Delta (LD)
        if (data.ld !== undefined) {
            const ldThreshold = this.mode === 'mm' ? 5 : this.mode === 'swing' ? 15 : 30;
            if (data.ld > ldThreshold) {
                confluence.ld = 'bullish';
            } else if (data.ld < -ldThreshold) {
                confluence.ld = 'bearish';
            }
        }
        
        // BB Pulse signals
        if (data.bbPulse) {
            if (data.bbPulse.buySignal) {
                confluence.bbp = 'bullish';
            } else if (data.bbPulse.sellSignal) {
                confluence.bbp = 'bearish';
            }
        }
        
        // Forecast bias
        if (data.forecast) {
            if (data.forecast.overallBias === 'bullish') {
                confluence.forecast = 'bullish';
            } else if (data.forecast.overallBias === 'bearish') {
                confluence.forecast = 'bearish';
            }
        }
        
        return confluence;
    }
    
    /**
     * Determine overall direction from confluence
     */
    determineDirection(confluence) {
        let bullishCount = 0;
        let bearishCount = 0;
        
        Object.values(confluence).forEach(val => {
            if (val === 'bullish') bullishCount++;
            else if (val === 'bearish') bearishCount++;
        });
        
        const config = this.modeConfig[this.mode];
        const required = config.confluenceRequired;
        
        if (bullishCount >= required) return 'long';
        if (bearishCount >= required) return 'short';
        
        // For less strict modes, allow partial confluence
        if (this.mode === 'mm') {
            if (bullishCount >= 3 && bullishCount > bearishCount) return 'long';
            if (bearishCount >= 3 && bearishCount > bullishCount) return 'short';
        }
        
        return 'neutral';
    }
    
    /**
     * Calculate signal strength (0-100)
     */
    calculateStrength(confluence, data) {
        let strength = 0;
        
        // Base strength from confluence count
        const bullishCount = Object.values(confluence).filter(v => v === 'bullish').length;
        const bearishCount = Object.values(confluence).filter(v => v === 'bearish').length;
        const dominantCount = Math.max(bullishCount, bearishCount);
        
        // 20 points per aligned indicator
        strength = dominantCount * 20;
        
        // Bonus for alpha strength
        if (data.alpha !== undefined) {
            const alphaDeviation = Math.abs(data.alpha - 50);
            strength += alphaDeviation * 0.5; // Up to 25 extra points
        }
        
        // Bonus for strong LD
        if (data.ld !== undefined) {
            const ldStrength = Math.min(Math.abs(data.ld), 100);
            strength += ldStrength * 0.1; // Up to 10 extra points
        }
        
        return Math.min(Math.round(strength), 100);
    }
    
    /**
     * Determine action state
     */
    determineAction(direction, strength, data) {
        const config = this.modeConfig[this.mode];
        
        // Check cooldown
        const cooldownMs = config.signalCooldown * 60000; // Assuming 1 bar = 1 min for simplicity
        const timeSinceChange = Date.now() - this.lastSignalChange;
        
        if (direction === 'neutral') {
            return 'wait';
        }
        
        // Strong signal = entry opportunity
        if (strength >= 70) {
            // Check if we're in an existing signal
            if (this.lastDirection === direction && timeSinceChange > cooldownMs) {
                return 'hold';
            }
            return 'entry';
        }
        
        // Medium signal
        if (strength >= 50) {
            if (this.lastDirection === direction) {
                return 'hold';
            }
            return 'wait';
        }
        
        // Weak signal with direction change = potential exit
        if (this.lastDirection && this.lastDirection !== direction && this.lastDirection !== 'neutral') {
            return 'exit';
        }
        
        return 'wait';
    }
    
    /**
     * Generate reasoning text
     */
    generateReasoning(confluence, direction, data) {
        const parts = [];
        
        // List aligned indicators
        const bullish = [];
        const bearish = [];
        
        if (confluence.mcs === 'bullish') bullish.push('MCS');
        if (confluence.mcs === 'bearish') bearish.push('MCS');
        
        if (confluence.alpha === 'bullish') bullish.push('Alpha');
        if (confluence.alpha === 'bearish') bearish.push('Alpha');
        
        if (confluence.ld === 'bullish') bullish.push('LD');
        if (confluence.ld === 'bearish') bearish.push('LD');
        
        if (confluence.bbp === 'bullish') bullish.push('BBP');
        if (confluence.bbp === 'bearish') bearish.push('BBP');
        
        if (confluence.forecast === 'bullish') bullish.push('FC');
        if (confluence.forecast === 'bearish') bearish.push('FC');
        
        if (direction === 'long' && bullish.length > 0) {
            parts.push(bullish.join(' + ') + ' aligned bullish');
        } else if (direction === 'short' && bearish.length > 0) {
            parts.push(bearish.join(' + ') + ' aligned bearish');
        } else {
            parts.push('Mixed signals, waiting for confluence');
        }
        
        // Add alpha score context
        if (data.alpha !== undefined) {
            if (data.alpha >= 70) {
                parts.push('Strong bullish momentum');
            } else if (data.alpha <= 30) {
                parts.push('Strong bearish momentum');
            }
        }
        
        return parts.join('. ') + '.';
    }
    
    /**
     * Render the panel UI
     */
    render() {
        if (!this.elements.panel) return;
        
        const signal = this.currentSignal;
        
        // Update hero container class
        if (this.elements.direction) {
            this.elements.direction.className = `as-hero ${signal.direction}`;
        }
        
        // Update signal direction block
        if (this.elements.arrow) {
            this.elements.arrow.className = `as-signal ${signal.direction}`;
            
            // Update arrow symbol
            const arrowEl = this.elements.arrow.querySelector('.as-arrow');
            if (arrowEl) {
                if (signal.direction === 'long') {
                    arrowEl.textContent = '▲';
                } else if (signal.direction === 'short') {
                    arrowEl.textContent = '▼';
                } else {
                    arrowEl.textContent = '―';
                }
            }
        }
        
        if (this.elements.label) {
            const labels = {
                long: 'LONG',
                short: 'SHORT',
                neutral: 'FLAT'
            };
            this.elements.label.textContent = labels[signal.direction] || 'FLAT';
        }
        
        if (this.elements.strength) {
            this.elements.strength.textContent = signal.strength + '%';
        }
        
        // Update meter
        if (this.elements.meterFill) {
            this.elements.meterFill.style.width = signal.strength + '%';
        }
        
        // Update action badge
        if (this.elements.actionBadge) {
            this.elements.actionBadge.textContent = signal.action.toUpperCase();
            this.elements.actionBadge.className = `as-badge ${signal.action}`;
        }
        
        // Update countdown (time since last signal)
        if (this.elements.countdown && this.lastSignalChange > 0) {
            const elapsed = Math.floor((Date.now() - this.lastSignalChange) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            this.elements.countdown.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        
        // Update confluence indicators (compact grid format)
        if (this.elements.confluence) {
            const items = this.elements.confluence.querySelectorAll('.as-conf');
            items.forEach(item => {
                const key = item.dataset.indicator;
                const state = signal.confluence[key] || 'neutral';
                item.className = `as-conf ${state}`;
                
                // Update value text
                const valEl = item.querySelector('.as-conf-val');
                if (valEl) {
                    if (state === 'bullish') {
                        valEl.textContent = '▲';
                    } else if (state === 'bearish') {
                        valEl.textContent = '▼';
                    } else {
                        valEl.textContent = '—';
                    }
                }
            });
        }
        
        // Update confluence score
        if (this.elements.confluenceScore) {
            const bullish = Object.values(signal.confluence).filter(v => v === 'bullish').length;
            const bearish = Object.values(signal.confluence).filter(v => v === 'bearish').length;
            const aligned = Math.max(bullish, bearish);
            this.elements.confluenceScore.textContent = `${aligned}/5`;
        }
        
        // Update reasoning
        if (this.elements.reasoning) {
            this.elements.reasoning.textContent = signal.reasoning;
        }
        
        // Update newbie text
        const newbieEl = document.getElementById('strikeNewbieText');
        if (newbieEl) {
            newbieEl.textContent = this.getNewbieText(signal);
        }
    }
    
    /**
     * Generate newbie-friendly text
     */
    getNewbieText(signal) {
        const config = this.modeConfig[this.mode];
        const aligned = Math.max(
            Object.values(signal.confluence).filter(v => v === 'bullish').length,
            Object.values(signal.confluence).filter(v => v === 'bearish').length
        );
        const modeLabel = config.label.toUpperCase();
        
        if (signal.direction === 'neutral') {
            return `${modeLabel} mode needs ${config.confluenceRequired}/5 confluence. Currently ${aligned}/5.`;
        }
        
        if (signal.action === 'entry') {
            const dir = signal.direction === 'long' ? 'BUY' : 'SELL';
            return `🎯 ${dir}! ${aligned}/5 aligned (${modeLabel} needs ${config.confluenceRequired}).`;
        }
        
        if (signal.action === 'hold') {
            return `✅ Hold position. ${aligned}/5 aligned.`;
        }
        
        if (signal.action === 'exit') {
            return `⚠️ Signal weakening. Consider exit.`;
        }
        
        return `${aligned}/5 → ${signal.direction.toUpperCase()}. Need ${config.confluenceRequired} for ${modeLabel}.`;
    }
    
    /**
     * Get current signal for external use
     */
    getSignal() {
        return { ...this.currentSignal };
    }
    
    /**
     * Get current mode
     */
    getMode() {
        return this.mode;
    }
    
    /**
     * Get mode configuration
     */
    getModeConfig() {
        return this.modeConfig[this.mode];
    }
}

// Global instance
const alphaStrike = new AlphaStrike();

