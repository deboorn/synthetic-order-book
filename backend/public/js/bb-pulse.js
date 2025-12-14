/**
 * Synthetic Order Book - BB Pulse Lighting MTF Indicator
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Multi-component indicator combining BBW, BB%B, and Pulse with signal detection
 */
class BBPulseLighting {
    constructor() {
        // BBW Settings
        this.bbwLen = 20;
        this.bbwMult = 2.0;
        this.bbwExpansionLen = 125;
        this.bbwContractionLen = 125;
        this.bbwZemaLen = 7;
        
        // BB%B Settings
        this.bbbLen = 20;
        this.bbbMult = 1.5;
        this.bbbOffset = 0;
        this.bbbZemaLen = 2;
        
        // Pulse Settings
        this.pulseNLen = 20;
        this.pulseTop = 1.5;
        this.pulseBottom = -0.5;
        
        // Signal Settings
        this.sellThreshold = 1.0;
        this.buyThreshold = 0.0;
        this.filterSignals = false;
        
        // Display Settings
        this.showBbw = false;
        this.showBbwZema = false;
        this.showBbb = true;
        this.showBbbZema = false;
        this.showPulse = true;
        this.showPulseSignals = false;
        this.showBbbSignals = false;
        this.showLightingSignals = true;
    }
    
    /**
     * Calculate SMA (Simple Moving Average)
     */
    sma(data, period) {
        if (data.length < period) return [];
        
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += data[i - j];
            }
            result.push(sum / period);
        }
        return result;
    }
    
    /**
     * Calculate Standard Deviation
     */
    stdev(data, period) {
        if (data.length < period) return [];
        
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += data[i - j];
            }
            const mean = sum / period;
            
            let variance = 0;
            for (let j = 0; j < period; j++) {
                variance += Math.pow(data[i - j] - mean, 2);
            }
            result.push(Math.sqrt(variance / period));
        }
        return result;
    }
    
    /**
     * Calculate EMA (Exponential Moving Average)
     */
    ema(data, period) {
        if (data.length < period) return [];
        
        const multiplier = 2 / (period + 1);
        const result = [];
        
        // Calculate initial SMA
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i];
        }
        let ema = sum / period;
        result.push(ema);
        
        // Calculate EMA for remaining values
        for (let i = period; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
            result.push(ema);
        }
        
        return result;
    }
    
    /**
     * Calculate ZEMA (Zero-lag EMA)
     */
    zeroEMA(data, period) {
        if (data.length < period * 2) return [];
        
        const ema1 = this.ema(data, period);
        if (ema1.length < period) return [];
        
        const ema2 = this.ema(ema1, period);
        if (ema2.length === 0) return [];
        
        const result = [];
        for (let i = 0; i < ema2.length; i++) {
            const idx1 = i + (period - 1);
            if (idx1 < ema1.length) {
                result.push((2 * ema1[idx1]) - ema2[i]);
            }
        }
        
        return result;
    }
    
    /**
     * Find highest value in array over period
     */
    highest(data, period) {
        if (data.length < period) return [];
        
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let max = data[i];
            for (let j = 0; j < period; j++) {
                if (data[i - j] > max) max = data[i - j];
            }
            result.push(max);
        }
        return result;
    }
    
    /**
     * Find lowest value in array over period
     */
    lowest(data, period) {
        if (data.length < period) return [];
        
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let min = data[i];
            for (let j = 0; j < period; j++) {
                if (data[i - j] < min) min = data[i - j];
            }
            result.push(min);
        }
        return result;
    }
    
    /**
     * Normalize values to custom range
     */
    normalize(data, period, top, bottom) {
        if (data.length < period) return [];
        
        const mins = this.lowest(data, period);
        const maxs = this.highest(data, period);
        
        const result = [];
        for (let i = 0; i < mins.length; i++) {
            const min = mins[i];
            const max = maxs[i];
            const range = (max - min) || 1e-10; // Avoid division by zero
            const norm01 = (data[i + period - 1] - min) / range;
            const normCustom = (norm01 * (top - bottom)) + bottom;
            result.push(normCustom);
        }
        
        return result;
    }
    
    /**
     * Calculate BBW (Bollinger Band Width)
     */
    calculateBBW(closes) {
        if (closes.length < this.bbwLen) return null;
        
        const basis = this.sma(closes, this.bbwLen);
        const dev = this.stdev(closes, this.bbwLen);
        
        const bbw = [];
        for (let i = 0; i < basis.length; i++) {
            const upper = basis[i] + (this.bbwMult * dev[i]);
            const lower = basis[i] - (this.bbwMult * dev[i]);
            const width = ((upper - lower) / basis[i]) * 100;
            bbw.push(width * -1); // Inverted
        }
        
        return {
            bbw: bbw,
            bbwZema: this.zeroEMA(bbw, this.bbwZemaLen),
            bbwExpHigh: this.highest(bbw, this.bbwExpansionLen),
            bbwExpLow: this.lowest(bbw, this.bbwContractionLen)
        };
    }
    
    /**
     * Calculate BB%B (Bollinger Band %B)
     */
    calculateBBB(closes) {
        if (closes.length < this.bbbLen) return null;
        
        const basis = this.sma(closes, this.bbbLen);
        const dev = this.stdev(closes, this.bbbLen);
        
        const bbr = [];
        for (let i = 0; i < basis.length; i++) {
            const upper = basis[i] + (this.bbbMult * dev[i]);
            const lower = basis[i] - (this.bbbMult * dev[i]);
            const close = closes[i + this.bbbLen - 1];
            const percentB = (close - lower) / (upper - lower);
            bbr.push(percentB);
        }
        
        return {
            bbr: bbr,
            bbbZema: this.zeroEMA(bbr, this.bbbZemaLen),
            bbbPeriodHigh: this.highest(bbr, this.bbbLen),
            bbbPeriodLow: this.lowest(bbr, this.bbbLen)
        };
    }
    
    /**
     * Calculate Pulse (normalized BBW)
     */
    calculatePulse(bbwData) {
        if (!bbwData || !bbwData.bbw) return null;
        
        const nVal = this.normalize(bbwData.bbw, this.pulseNLen, this.pulseBottom, this.pulseTop);
        
        return {
            nVal: nVal,
            nValPeriodHigh: this.highest(nVal, this.pulseNLen),
            nValPeriodLow: this.lowest(nVal, this.pulseNLen)
        };
    }
    
    /**
     * Detect signals
     * Note: bbrHigh/bbrLow have offset of (bbbLen-1) relative to bbr
     *       nVal has offset of (bbwLen-1)+(pulseNLen-1)-(bbbLen-1) relative to bbr
     */
    detectSignals(bbr, bbrHigh, bbrLow, nVal) {
        if (!bbr || bbr.length === 0) return null;
        
        const signals = {
            bbbTop: [],
            bbbBottom: [],
            pulseFirstUp: [],
            pulseFirstDown: [],
            lGreedyUp: [],
            lBuySignal1: [],
            lBuySignal2: [],
            lBuySignal3: [],
            lSellSignal1: [],
            lSellSignal2: []
        };
        
        // Period high/low arrays are shorter - they start at bbr index (bbbLen-1)
        const periodOffset = this.bbbLen - 1;
        
        // Pulse (nVal) offset relative to bbr:
        // BBW starts at closes[bbwLen-1], Pulse adds (pulseNLen-1), BBB starts at closes[bbbLen-1]
        // pulseOffset = (bbwLen-1) + (pulseNLen-1) - (bbbLen-1) = 19 + 19 - 19 = 19
        const pulseOffset = (this.bbwLen - 1) + (this.pulseNLen - 1) - (this.bbbLen - 1);
        
        // Start at periodOffset so we have valid period high/low data
        for (let i = periodOffset; i < bbr.length; i++) {
            // Index into bbrHigh/bbrLow (they're offset by periodOffset)
            const phIdx = i - periodOffset;
            
            // Index into nVal (offset by pulseOffset from bbr)
            const pulseIdx = i - pulseOffset;
            
            // BB%B signals - compare current bbr to its period high/low
            const atTop = bbr[i] >= bbrHigh[phIdx];
            const atBottom = bbr[i] <= bbrLow[phIdx];
            signals.bbbTop.push(atTop);
            signals.bbbBottom.push(atBottom);
            
            // Pulse signals
            let pulseFirstUp = false;
            let pulseFirstDown = false;
            if (nVal && pulseIdx >= 1 && pulseIdx < nVal.length) {
                const pulseRising = nVal[pulseIdx] > nVal[pulseIdx - 1];
                const pulseFalling = nVal[pulseIdx] < nVal[pulseIdx - 1];
                pulseFirstUp = pulseRising && nVal[pulseIdx - 1] <= this.pulseBottom;
                pulseFirstDown = pulseFalling && nVal[pulseIdx - 1] >= this.pulseTop;
            }
            signals.pulseFirstUp.push(pulseFirstUp);
            signals.pulseFirstDown.push(pulseFirstDown);
            
            // Lighting signals - use aligned period high/low
            const lMid = (bbrHigh[phIdx] + bbrLow[phIdx]) / 2;
            const lDoubleUp = i >= 2 && bbr[i] >= bbr[i - 1] && bbr[i - 1] >= bbr[i - 2];
            
            // Current signal array index (we're building from index 0)
            const sigIdx = signals.bbbTop.length - 1;
            
            signals.lGreedyUp.push(lDoubleUp && bbr[i] > (lMid * 1.05) && !atTop);
            
            // Buy signals
            const lBuySignal1 = atBottom;
            const prevAtBottom = sigIdx >= 1 ? signals.bbbBottom[sigIdx - 1] : false;
            const lBuySignal2 = prevAtBottom && !atBottom;
            const bottom10 = bbrLow[phIdx] + (bbrHigh[phIdx] - bbrLow[phIdx]) * 0.10;
            const lBuySignal3 = bbr[i] <= bottom10 && !atTop && !lBuySignal1 && !lBuySignal2;
            
            signals.lBuySignal1.push(this.filterSignals ? lBuySignal1 && bbr[i] <= this.buyThreshold : lBuySignal1);
            signals.lBuySignal2.push(this.filterSignals ? lBuySignal2 && bbr[i] <= this.buyThreshold : lBuySignal2);
            signals.lBuySignal3.push(this.filterSignals ? lBuySignal3 && bbr[i] <= this.buyThreshold : lBuySignal3);
            
            // Sell signals
            const lSellSignal1 = atTop;
            const prevAtTop = sigIdx >= 1 ? signals.bbbTop[sigIdx - 1] : false;
            const lSellSignal2 = prevAtTop && !atTop;
            
            signals.lSellSignal1.push(this.filterSignals ? lSellSignal1 && bbr[i] >= this.sellThreshold : lSellSignal1);
            signals.lSellSignal2.push(this.filterSignals ? lSellSignal2 && bbr[i] >= this.sellThreshold : lSellSignal2);
        }
        
        return signals;
    }
    
    /**
     * Calculate all indicator components
     * @param {Array} candles - Array of candle objects with {time, open, high, low, close, volume}
     * @returns {Object} - Complete indicator data
     */
    calculate(candles) {
        if (!candles || candles.length < 200) return null;
        
        // Extract close prices (use open as source per indicator)
        const opens = candles.map(c => c.open);
        
        // Calculate BBW
        const bbwData = this.calculateBBW(opens);
        if (!bbwData) return null;
        
        // Calculate BB%B
        const bbbData = this.calculateBBB(opens);
        if (!bbbData) return null;
        
        // Calculate Pulse
        const pulseData = this.calculatePulse(bbwData);
        if (!pulseData) return null;
        
        // Detect signals
        const signals = this.detectSignals(bbbData.bbr, bbbData.bbbPeriodHigh, bbbData.bbbPeriodLow, pulseData.nVal);
        
        // Align all data to same length (use BB%B as base since it starts at bbbLen-1)
        const startIdx = this.bbbLen - 1;
        const times = candles.slice(startIdx).map(c => c.time);
        
        return {
            times: times,
            bbw: bbwData,
            bbb: bbbData,
            pulse: pulseData,
            signals: signals,
            startIdx: startIdx
        };
    }
    
    /**
     * Update settings
     */
    updateSettings(settings) {
        Object.assign(this, settings);
    }
}

// Global instance
const bbPulseLighting = new BBPulseLighting();

