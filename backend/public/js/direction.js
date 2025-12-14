/**
 * Synthetic Order Book - Directional Analysis
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Directional Analysis Module
 * Multi-Timeframe Forecast: Short (±5%), Medium (±15%), Long (±30%)
 */

class DirectionalAnalysis {
    constructor() {
        this.currentPrice = 0;
        this.levels = [];
        this.symbol = 'BTC';
        
        // Timeframe ranges
        this.timeframes = {
            short: { range: 5, label: 'SHORT' },
            medium: { range: 15, label: 'MEDIUM' },
            long: { range: 30, label: 'LONG' }
        };
        
        // Thresholds for determining "strong" levels
        this.strongVolumeThreshold = 50; // BTC
        
        // DOM Elements (cached on first use)
        this.elements = null;
        
        // Store calculated analysis for external access
        this.lastAnalysis = {
            short: null,
            medium: null,
            long: null,
            overallBias: null,
            confidence: null
        };
    }
    
    /**
     * Cache DOM elements for the new forecast panel
     */
    cacheElements() {
        if (this.elements) return;
        
        this.elements = {
            // Short term
            shortArrow: document.getElementById('shortArrow'),
            shortResPrice: document.getElementById('shortResPrice'),
            shortResVol: document.getElementById('shortResVol'),
            shortSupPrice: document.getElementById('shortSupPrice'),
            shortSupVol: document.getElementById('shortSupVol'),
            shortGaugeBid: document.getElementById('shortGaugeBid'),
            shortGaugeAsk: document.getElementById('shortGaugeAsk'),
            shortGaugeValue: document.getElementById('shortGaugeValue'),
            
            // Medium term
            mediumArrow: document.getElementById('mediumArrow'),
            mediumResPrice: document.getElementById('mediumResPrice'),
            mediumResVol: document.getElementById('mediumResVol'),
            mediumSupPrice: document.getElementById('mediumSupPrice'),
            mediumSupVol: document.getElementById('mediumSupVol'),
            mediumGaugeBid: document.getElementById('mediumGaugeBid'),
            mediumGaugeAsk: document.getElementById('mediumGaugeAsk'),
            mediumGaugeValue: document.getElementById('mediumGaugeValue'),
            
            // Long term
            longArrow: document.getElementById('longArrow'),
            longResPrice: document.getElementById('longResPrice'),
            longResVol: document.getElementById('longResVol'),
            longSupPrice: document.getElementById('longSupPrice'),
            longSupVol: document.getElementById('longSupVol'),
            longGaugeBid: document.getElementById('longGaugeBid'),
            longGaugeAsk: document.getElementById('longGaugeAsk'),
            longGaugeValue: document.getElementById('longGaugeValue'),
            
            // Summary
            overallBias: document.getElementById('overallBias'),
            overallConfidence: document.getElementById('overallConfidence')
        };
        
        // Track confidence display mode
        this.showConfidence = false;
    }
    
    /**
     * Toggle confidence display
     */
    setShowConfidence(show) {
        this.showConfidence = show;
    }
    
    /**
     * Update analysis with new data - Multi-Timeframe
     */
    update(levels, currentPrice, symbol = 'BTC') {
        this.cacheElements();
        
        if (!levels || levels.length === 0 || !currentPrice) {
            this.showLoading();
            return null;
        }
        
        this.levels = levels;
        this.currentPrice = currentPrice;
        this.symbol = symbol;
        
        // Calculate for each timeframe
        const shortAnalysis = this.analyzeTimeframe(5);   // ±5%
        const mediumAnalysis = this.analyzeTimeframe(15); // ±15%
        const longAnalysis = this.analyzeTimeframe(30);   // ±30%
        
        // Calculate overall bias and confidence
        const overallBias = this.calculateOverallBias(shortAnalysis, mediumAnalysis, longAnalysis);
        const confidence = this.calculateOverallConfidence(shortAnalysis, mediumAnalysis, longAnalysis);
        
        // Store for external access
        this.lastAnalysis = {
            short: shortAnalysis,
            medium: mediumAnalysis,
            long: longAnalysis,
            overallBias,
            confidence
        };
        
        // Update UI
        this.updateForecastCard('short', shortAnalysis);
        this.updateForecastCard('medium', mediumAnalysis);
        this.updateForecastCard('long', longAnalysis);
        this.updateSummary(overallBias, confidence);
        
        return this.lastAnalysis;
    }
    
    /**
     * Analyze a specific timeframe with EXCLUSIVE ranges
     */
    analyzeTimeframe(rangePercent) {
        // Determine the inner bound (to make ranges exclusive)
        let innerBound = 0;
        if (rangePercent === 15) innerBound = 5;      // Medium: 5-15%
        else if (rangePercent === 30) innerBound = 15; // Long: 15-30%
        // Short (5%) has innerBound = 0, so it's 0-5%
        
        const imbalance = this.calculateImbalanceExclusive(innerBound, rangePercent);
        const support = this.findStrongestLevelExclusive('support', innerBound, rangePercent);
        const resistance = this.findStrongestLevelExclusive('resistance', innerBound, rangePercent);
        
        // Determine bias for this timeframe
        let bias = 'neutral';
        if (imbalance.ratio > 15) bias = 'bullish';
        else if (imbalance.ratio < -15) bias = 'bearish';
        
        return {
            range: rangePercent,
            innerBound,
            imbalance,
            support,
            resistance,
            bias
        };
    }
    
    /**
     * Find the strongest level within an EXCLUSIVE range (innerPercent to outerPercent)
     * This prevents the same level from appearing in multiple timeframes
     */
    findStrongestLevelExclusive(type, innerPercent, outerPercent) {
        const isSupport = type === 'support';
        
        // For support: below current price
        // For resistance: above current price
        let innerBound, outerBound;
        
        if (isSupport) {
            // Support is below price, so we go from -innerPercent to -outerPercent
            innerBound = this.currentPrice * (1 - innerPercent / 100);  // closer to price
            outerBound = this.currentPrice * (1 - outerPercent / 100);  // further from price
        } else {
            // Resistance is above price, so we go from +innerPercent to +outerPercent
            innerBound = this.currentPrice * (1 + innerPercent / 100);  // closer to price
            outerBound = this.currentPrice * (1 + outerPercent / 100);  // further from price
        }
        
        const relevantLevels = this.levels.filter(level => {
            if (level.type !== type) return false;
            
            if (isSupport) {
                // Support: price should be BELOW innerBound and ABOVE outerBound
                return level.price < innerBound && level.price >= outerBound;
            } else {
                // Resistance: price should be ABOVE innerBound and BELOW outerBound
                return level.price > innerBound && level.price <= outerBound;
            }
        });
        
        if (relevantLevels.length === 0) return null;
        
        // Sort by volume (descending)
        relevantLevels.sort((a, b) => b.volume - a.volume);
        
        const strongest = relevantLevels[0];
        const distance = ((strongest.price - this.currentPrice) / this.currentPrice) * 100;
        
        return {
            price: strongest.price,
            volume: strongest.volume,
            distance: Math.abs(distance)
        };
    }
    
    /**
     * LEGACY: Find the strongest level within a range (still used for projections)
     */
    findStrongestLevel(type, rangePercent) {
        const isSupport = type === 'support';
        const lowerBound = isSupport ? this.currentPrice * (1 - rangePercent / 100) : this.currentPrice;
        const upperBound = isSupport ? this.currentPrice : this.currentPrice * (1 + rangePercent / 100);
        
        const relevantLevels = this.levels.filter(level => {
            if (level.type !== type) return false;
            return level.price >= lowerBound && level.price <= upperBound;
        });
        
        if (relevantLevels.length === 0) return null;
        
        // Sort by volume (descending)
        relevantLevels.sort((a, b) => b.volume - a.volume);
        
        const strongest = relevantLevels[0];
        const distance = ((strongest.price - this.currentPrice) / this.currentPrice) * 100;
        
        return {
            price: strongest.price,
            volume: strongest.volume,
            distance: Math.abs(distance)
        };
    }
    
    /**
     * Calculate overall bias from all timeframes
     */
    calculateOverallBias(short, medium, long) {
        let score = 0;
        
        // Weight: Short 40%, Medium 35%, Long 25%
        if (short.bias === 'bullish') score += 40;
        else if (short.bias === 'bearish') score -= 40;
        
        if (medium.bias === 'bullish') score += 35;
        else if (medium.bias === 'bearish') score -= 35;
        
        if (long.bias === 'bullish') score += 25;
        else if (long.bias === 'bearish') score -= 25;
        
        if (score > 20) return 'bullish';
        if (score < -20) return 'bearish';
        return 'neutral';
    }
    
    /**
     * Calculate overall confidence
     */
    calculateOverallConfidence(short, medium, long) {
        // Check how aligned the timeframes are
        const biases = [short.bias, medium.bias, long.bias];
        const bullishCount = biases.filter(b => b === 'bullish').length;
        const bearishCount = biases.filter(b => b === 'bearish').length;
        
        // All aligned = high, 2/3 aligned = medium, mixed = low
        if (bullishCount === 3 || bearishCount === 3) return 'high';
        if (bullishCount >= 2 || bearishCount >= 2) return 'medium';
        return 'low';
    }
    
    /**
     * Update a forecast card in the UI
     */
    updateForecastCard(timeframe, analysis) {
        if (!this.elements) return;
        
        const prefix = timeframe;
        
        // Update arrow
        const arrow = this.elements[`${prefix}Arrow`];
        if (arrow) {
            arrow.className = `forecast-arrow ${analysis.bias}`;
            if (analysis.bias === 'bullish') arrow.textContent = '↑';
            else if (analysis.bias === 'bearish') arrow.textContent = '↓';
            else arrow.textContent = '→';
        }
        
        // Update resistance level
        if (analysis.resistance) {
            if (this.elements[`${prefix}ResPrice`]) {
                this.elements[`${prefix}ResPrice`].textContent = `$${this.formatPrice(analysis.resistance.price)}`;
            }
            if (this.elements[`${prefix}ResVol`]) {
                this.elements[`${prefix}ResVol`].textContent = `${analysis.resistance.volume.toFixed(0)}`;
            }
        } else {
            if (this.elements[`${prefix}ResPrice`]) this.elements[`${prefix}ResPrice`].textContent = '$--';
            if (this.elements[`${prefix}ResVol`]) this.elements[`${prefix}ResVol`].textContent = '--';
        }
        
        // Update support level
        if (analysis.support) {
            if (this.elements[`${prefix}SupPrice`]) {
                this.elements[`${prefix}SupPrice`].textContent = `$${this.formatPrice(analysis.support.price)}`;
            }
            if (this.elements[`${prefix}SupVol`]) {
                this.elements[`${prefix}SupVol`].textContent = `${analysis.support.volume.toFixed(0)}`;
            }
        } else {
            if (this.elements[`${prefix}SupPrice`]) this.elements[`${prefix}SupPrice`].textContent = '$--';
            if (this.elements[`${prefix}SupVol`]) this.elements[`${prefix}SupVol`].textContent = '--';
        }
        
        // Update gauge
        const imbalance = analysis.imbalance;
        if (imbalance) {
            const total = imbalance.bidVolume + imbalance.askVolume;
            if (total > 0) {
                const bidPercent = (imbalance.bidVolume / total) * 100;
                const askPercent = (imbalance.askVolume / total) * 100;
                
                if (this.elements[`${prefix}GaugeBid`]) {
                    this.elements[`${prefix}GaugeBid`].style.width = `${bidPercent}%`;
                }
                if (this.elements[`${prefix}GaugeAsk`]) {
                    this.elements[`${prefix}GaugeAsk`].style.width = `${askPercent}%`;
                }
                if (this.elements[`${prefix}GaugeValue`]) {
                    const valueEl = this.elements[`${prefix}GaugeValue`];
                    const ratio = imbalance.ratio;
                    valueEl.textContent = `${ratio > 0 ? '+' : ''}${ratio.toFixed(0)}%`;
                    valueEl.className = `mini-gauge-value ${ratio > 10 ? 'bullish' : ratio < -10 ? 'bearish' : 'neutral'}`;
                }
            }
        }
    }
    
    /**
     * Update summary section
     */
    updateSummary(bias, confidence) {
        if (!this.elements) return;
        
        const biasStr = String(bias || 'neutral');
        const confStr = String(confidence || 'low');
        
        if (this.elements.overallBias) {
            this.elements.overallBias.textContent = biasStr.toUpperCase();
            this.elements.overallBias.className = `summary-value ${biasStr}`;
        }
        
        if (this.elements.overallConfidence) {
            this.elements.overallConfidence.textContent = confStr.toUpperCase();
            this.elements.overallConfidence.className = `summary-value ${confStr}`;
        }
    }
    
    /**
     * Show loading state
     */
    showLoading() {
        if (!this.elements) return;
        
        ['short', 'medium', 'long'].forEach(tf => {
            if (this.elements[`${tf}Arrow`]) {
                this.elements[`${tf}Arrow`].className = 'forecast-arrow neutral';
                this.elements[`${tf}Arrow`].textContent = '→';
            }
            if (this.elements[`${tf}ResPrice`]) this.elements[`${tf}ResPrice`].textContent = '$--';
            if (this.elements[`${tf}ResVol`]) this.elements[`${tf}ResVol`].textContent = '--';
            if (this.elements[`${tf}SupPrice`]) this.elements[`${tf}SupPrice`].textContent = '$--';
            if (this.elements[`${tf}SupVol`]) this.elements[`${tf}SupVol`].textContent = '--';
            if (this.elements[`${tf}GaugeValue`]) this.elements[`${tf}GaugeValue`].textContent = '--';
        });
        
        if (this.elements.overallBias) {
            this.elements.overallBias.textContent = '--';
            this.elements.overallBias.className = 'summary-value';
        }
        if (this.elements.overallConfidence) {
            this.elements.overallConfidence.textContent = '--';
            this.elements.overallConfidence.className = 'summary-value';
        }
    }
    
    /**
     * Format price for display
     */
    formatPrice(price) {
        if (price >= 1000) {
            return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
        }
        return price.toFixed(2);
    }
    
    /**
     * Calculate bid/ask volume imbalance within EXCLUSIVE range (innerPercent to outerPercent)
     */
    calculateImbalanceExclusive(innerPercent, outerPercent) {
        // Support: from -innerPercent to -outerPercent (below price)
        const supportInner = this.currentPrice * (1 - innerPercent / 100);
        const supportOuter = this.currentPrice * (1 - outerPercent / 100);
        
        // Resistance: from +innerPercent to +outerPercent (above price)
        const resistanceInner = this.currentPrice * (1 + innerPercent / 100);
        const resistanceOuter = this.currentPrice * (1 + outerPercent / 100);
        
        let bidVolume = 0;
        let askVolume = 0;
        
        this.levels.forEach(level => {
            if (level.type === 'support') {
                // Support must be between inner and outer bounds (below price)
                if (level.price < supportInner && level.price >= supportOuter) {
                    bidVolume += level.volume;
                }
            } else {
                // Resistance must be between inner and outer bounds (above price)
                if (level.price > resistanceInner && level.price <= resistanceOuter) {
                    askVolume += level.volume;
                }
            }
        });
        
        const total = bidVolume + askVolume;
        if (total === 0) {
            return { bidPercent: 50, askPercent: 50, ratio: 0, direction: 'neutral', bidVolume: 0, askVolume: 0 };
        }
        
        const bidPercent = (bidVolume / total) * 100;
        const askPercent = (askVolume / total) * 100;
        const ratio = ((bidVolume - askVolume) / total) * 100; // -100 to +100
        
        let direction = 'neutral';
        if (ratio > 10) direction = 'bullish';
        else if (ratio < -10) direction = 'bearish';
        
        return {
            bidVolume,
            askVolume,
            bidPercent,
            askPercent,
            ratio,
            direction
        };
    }
    
    /**
     * Calculate bid/ask volume imbalance within a price range (legacy, cumulative)
     */
    calculateImbalance(rangePercent) {
        const lowerBound = this.currentPrice * (1 - rangePercent / 100);
        const upperBound = this.currentPrice * (1 + rangePercent / 100);
        
        let bidVolume = 0;
        let askVolume = 0;
        
        this.levels.forEach(level => {
            if (level.price >= lowerBound && level.price <= upperBound) {
                if (level.type === 'support') {
                    bidVolume += level.volume;
                } else {
                    askVolume += level.volume;
                }
            }
        });
        
        const total = bidVolume + askVolume;
        if (total === 0) {
            return { bidPercent: 50, askPercent: 50, ratio: 0, direction: 'neutral', bidVolume: 0, askVolume: 0 };
        }
        
        const bidPercent = (bidVolume / total) * 100;
        const askPercent = (askVolume / total) * 100;
        const ratio = ((bidVolume - askVolume) / total) * 100; // -100 to +100
        
        let direction = 'neutral';
        if (ratio > 10) direction = 'bullish';
        else if (ratio < -10) direction = 'bearish';
        
        return {
            bidVolume,
            askVolume,
            bidPercent,
            askPercent,
            ratio,
            direction
        };
    }
    
    /**
     * Get projection data for chart (updated for multi-timeframe)
     * Returns short, medium, and long targets for all three timeframes
     */
    getProjectionData() {
        if (!this.lastAnalysis) return null;
        
        const short = this.lastAnalysis.short;
        const medium = this.lastAnalysis.medium;
        const long = this.lastAnalysis.long;
        const bias = this.lastAnalysis.overallBias || 'neutral';
        
        // Build targets for each timeframe
        const buildTarget = (analysis, label) => {
            if (!analysis) return { resistance: null, support: null };
            return {
                resistance: analysis.resistance ? {
                    price: analysis.resistance.price,
                    volume: analysis.resistance.volume,
                    distance: analysis.resistance.distance,
                    type: 'resistance',
                    label: label
                } : null,
                support: analysis.support ? {
                    price: analysis.support.price,
                    volume: analysis.support.volume,
                    distance: Math.abs(analysis.support.distance),
                    type: 'support',
                    label: label
                } : null
            };
        };
        
        const shortTargets = buildTarget(short, 'S');
        const mediumTargets = buildTarget(medium, 'M');
        const longTargets = buildTarget(long, 'L');
        
        return {
            currentPrice: this.currentPrice,
            bias: bias,
            biasConfidence: this.lastAnalysis.confidence || 'low',
            // All three timeframes
            short: shortTargets,
            medium: mediumTargets,
            long: longTargets,
            // Legacy compatibility
            upsideTarget: mediumTargets.resistance || longTargets.resistance,
            downsideTarget: mediumTargets.support || longTargets.support
        };
    }
}

// Export singleton instance
const directionAnalysis = new DirectionalAnalysis();
