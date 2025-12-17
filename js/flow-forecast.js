/**
 * Synthetic Order Book - Flow Forecast
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Predictive signal based on order flow + depth analysis
 * Generates per-bar predictions for next bar direction
 */

class FlowForecast {
    constructor() {
        this.symbol = 'BTC';
        this.interval = '1m';
        this.debug = localStorage.getItem('flowForecastDebug') === 'true'; // enable verbose logging for 1m
        
        // Bar stats history: barTime => BarStats
        this.barStats = new Map();
        
        // Predictions: barTime => Prediction (prediction FOR that bar, generated from prior bar)
        this.predictions = new Map();
        
        // Rolling baselines for normalization (per symbol/interval)
        this.baselines = {
            avgVolume: 0,
            avgBidDepth: 0,
            avgAskDepth: 0,
            samples: 0
        };
        
        // Configuration
        this.config = {
            nearBandPct: 0.005,      // ±0.5% for near depth
            minScore: 0,             // Always show predictions
            uncertainThreshold: 30,  // Below this = yellow/uncertain
            maxBars: 500,            // Max bars to store
            baselineWindow: 100,     // Bars for rolling baseline
            weights: {
                dcr: 0.40,           // Depth Consumption Rate
                velocity: 0.25,      // Flow acceleration
                refill: 0.20,        // Book refill rate
                priceLag: 0.15       // Unrealized price pressure
            }
        };
        
        // Current bar tracking (for refill calculation)
        this.currentBarOpenDepth = null;
        this.currentBarTime = null;
        
        // Callbacks
        this.onPrediction = null;
        
        // Load from storage
        this.loadFromStorage();
    }
    
    /**
     * Set symbol and reload data
     */
    setSymbol(symbol) {
        if (this.symbol !== symbol) {
            this.saveToStorage();
            this.symbol = symbol;
            this.clear();
            this.loadFromStorage();
        }
    }
    
    /**
     * Set interval and reload data
     */
    setInterval(interval) {
        if (this.interval !== interval) {
            this.saveToStorage();
            this.interval = interval;
            this.clear();
            this.loadFromStorage();
        }
    }

    /**
     * Enable/disable debug logging
     */
    setDebug(enabled) {
        this.debug = !!enabled;
        localStorage.setItem('flowForecastDebug', this.debug);
    }
    
    /**
     * Capture depth snapshot at bar open
     * Called when a new bar starts forming
     */
    captureBarOpen(barTime) {
        if (typeof orderBookWS === 'undefined' || !orderBookWS.hasData()) {
            return;
        }
        
        const book = orderBookWS.getAggregatedBook();
        const price = book.price;
        
        if (!price || price <= 0) return;
        
        // Calculate near-band depth (within ±0.5% of price)
        const nearDepth = this.calculateNearDepth(book, price);
        
        this.currentBarOpenDepth = {
            bidDepth: nearDepth.bidDepth,
            askDepth: nearDepth.askDepth,
            price: price,
            timestamp: Date.now()
        };
        this.currentBarTime = barTime;
    }
    
    /**
     * Capture bar close and generate prediction
     * Called when a bar finalizes
     */
    captureBarClose(barTime, tradeData) {
        if (typeof orderBookWS === 'undefined' || !orderBookWS.hasData()) {
            return null;
        }
        
        const book = orderBookWS.getAggregatedBook();
        const price = book.price;
        
        if (!price || price <= 0) return null;
        
        // Get trade stats from trade aggregator
        let buyVol = 0, sellVol = 0, tradeCount = 0;
        
        if (tradeData) {
            tradeData.forEach(level => {
                buyVol += level.buyVol || 0;
                sellVol += level.sellVol || 0;
                tradeCount += level.tradeCount || 0;
            });
        }
        
        // Calculate near-band depth at close
        const nearDepth = this.calculateNearDepth(book, price);
        
        // Get open depth (use current if available, otherwise estimate from close)
        const openDepth = this.currentBarOpenDepth || {
            bidDepth: nearDepth.bidDepth,
            askDepth: nearDepth.askDepth,
            price: price
        };
        
        // Get candle data if available
        let barOpen = price, barClose = price, barHigh = price, barLow = price;
        if (typeof app !== 'undefined' && app.chart) {
            const candles = app.chart.getCandles();
            if (candles && candles.length > 0) {
                const lastCandle = candles[candles.length - 1];
                if (lastCandle.time === barTime || Math.abs(lastCandle.time - barTime) < 60) {
                    barOpen = lastCandle.open;
                    barClose = lastCandle.close;
                    barHigh = lastCandle.high;
                    barLow = lastCandle.low;
                }
            }
        }
        
        // Create BarStats
        const barStats = {
            time: barTime,
            // Trade data
            buyVol: buyVol,
            sellVol: sellVol,
            totalVol: buyVol + sellVol,
            netFlow: buyVol - sellVol,
            tradeCount: tradeCount,
            // Depth at open
            openBidDepth: openDepth.bidDepth,
            openAskDepth: openDepth.askDepth,
            // Depth at close
            closeBidDepth: nearDepth.bidDepth,
            closeAskDepth: nearDepth.askDepth,
            // Price data
            open: barOpen,
            close: barClose,
            high: barHigh,
            low: barLow,
            priceChange: barClose - barOpen,
            range: barHigh - barLow,
            // Timestamp
            capturedAt: Date.now()
        };
        
        // Store bar stats
        this.barStats.set(barTime, barStats);
        
        // Update baselines
        this.updateBaselines(barStats);
        
        // Generate prediction for NEXT bar
        const prediction = this.computePrediction(barTime);
        
        if (prediction) {
            // Store prediction keyed by the bar it predicts
            const nextBarTime = barTime + this.getIntervalSeconds();
            this.predictions.set(nextBarTime, {
                ...prediction,
                sourceBar: barTime,
                targetBar: nextBarTime,
                generatedAt: Date.now()
            });
            
            // Debug log for 1m interval
            if (this.debug && this.interval === '1m') {
                this.logBarAndPrediction(barStats, prediction);
            }

            // Notify listeners
            if (this.onPrediction) {
                this.onPrediction(nextBarTime, prediction);
            }

            // Auto-diagnostics for 1m when debug enabled
            if (this.debug && this.interval === '1m') {
                this.logBarAndPrediction(barStats, prediction);
                this.logDiagnostics();
            }
        }
        
        // Trim old data
        this.trimOldData();
        
        // Save to storage
        this.saveToStorage();
        
        // Reset current bar tracking
        this.currentBarOpenDepth = null;
        this.currentBarTime = null;
        
        return prediction;
    }
    
    /**
     * Debug logger for 1m bars
     */
    logBarAndPrediction(stats, prediction) {
        const accuracy = typeof app !== 'undefined' && app.chart
            ? this.checkAccuracy(stats.time)
            : null;

        console.groupCollapsed(
            `%c[FlowForecast][1m]%c bar ${stats.time} pred → ${prediction.direction.toUpperCase()} ${prediction.score}`,
            'color:#22d3ee;font-weight:bold;',
            'color:#cbd5e1;'
        );
        console.table({
            price: {
                open: stats.open,
                close: stats.close,
                high: stats.high,
                low: stats.low,
                change: stats.priceChange
            },
            flow: {
                buyVol: stats.buyVol,
                sellVol: stats.sellVol,
                netFlow: stats.netFlow,
                totalVol: stats.totalVol,
                tradeCount: stats.tradeCount
            },
            depthOpen: {
                bid: stats.openBidDepth,
                ask: stats.openAskDepth
            },
            depthClose: {
                bid: stats.closeBidDepth,
                ask: stats.closeAskDepth
            },
            components: prediction.components,
            prediction: {
                direction: prediction.direction,
                score: prediction.score,
                confidence: prediction.confidence,
                absorption: prediction.absorption
            },
            accuracy: accuracy || 'n/a'
        });
        console.groupEnd();
    }

    /**
     * Lightweight backtest over stored barStats
     * @param {number} lookback number of bars to test (default 200)
     */
    runBacktest(lookback = 200) {
        const times = Array.from(this.barStats.keys()).sort((a, b) => a - b);
        if (times.length < 5) {
            console.warn('[FlowForecast] Not enough data to backtest.');
            return null;
        }
        const slice = times.slice(-lookback - 1); // need prev bar

        let total = 0, correct = 0, uncertain = 0;
        const rows = [];

        for (let i = 1; i < slice.length; i++) {
            const t = slice[i - 1];
            const target = t + this.getIntervalSeconds();
            const pred = this.computePrediction(t);
            if (!pred) continue;

            // Actual candle
            const candle = (typeof app !== 'undefined' && app.chart)
                ? app.chart.getCandles()?.find(c => c.time === target)
                : null;
            if (!candle) continue;

            const actualDir = candle.close > candle.open ? 'up' :
                              candle.close < candle.open ? 'down' : 'neutral';
            const predictedDir = pred.direction;
            const isCorrect = predictedDir === actualDir ||
                              predictedDir === 'neutral' ||
                              actualDir === 'neutral';

            total++;
            if (isCorrect) correct++;
            if (Math.abs(pred.score) < this.config.uncertainThreshold) uncertain++;

            rows.push({
                bar: t,
                target,
                predicted: predictedDir,
                score: pred.score,
                actual: actualDir,
                correct: isCorrect
            });
        }

        const accuracy = total ? (correct / total * 100) : 0;
        console.groupCollapsed(`[FlowForecast][Backtest] ${total} bars, accuracy ${accuracy.toFixed(1)}%`);
        console.table(rows.slice(-50)); // show last 50 rows
        console.log({
            total,
            correct,
            accuracy: `${accuracy.toFixed(1)}%`,
            uncertain: `${uncertain} (${total ? (uncertain / total * 100).toFixed(1) : 0}%)`
        });
        console.groupEnd();

        return { total, correct, accuracy, uncertain, rows };
    }

    /**
     * Compute accuracy summary over recent predictions
     */
    computeAccuracySummary(lookback = 200) {
        if (typeof app === 'undefined' || !app.chart) return null;
        const candles = app.chart.getCandles();
        if (!candles || candles.length === 0) return null;

        const preds = Array.from(this.predictions.entries())
            .sort((a, b) => b[0] - a[0])
            .slice(0, lookback);

        let total = 0, correct = 0, uncertain = 0;
        const threshold = this.config.uncertainThreshold;

        preds.forEach(([t, pred]) => {
            const candle = candles.find(c => c.time === t);
            if (!candle) return;
            const actual = candle.close > candle.open ? 'up' :
                           candle.close < candle.open ? 'down' : 'neutral';
            const ok = pred.direction === actual || pred.direction === 'neutral' || actual === 'neutral';
            total++;
            if (ok) correct++;
            if (Math.abs(pred.score) < threshold) uncertain++;
        });

        return {
            total,
            correct,
            accuracy: total ? +(correct / total * 100).toFixed(1) : 0,
            uncertain,
            uncertainPct: total ? +(uncertain / total * 100).toFixed(1) : 0
        };
    }

    /**
     * Log diagnostics (accuracy + component means) for quick tuning
     */
    logDiagnostics(lookback = 200) {
        const summary = this.computeAccuracySummary(lookback);
        if (!summary) return;

        // Component averages from last N predictions
        const preds = Array.from(this.predictions.values())
            .slice(-lookback);
        const accum = { dcr: 0, velocity: 0, refill: 0, priceLag: 0 };
        let count = 0;
        preds.forEach(p => {
            if (!p.components) return;
            accum.dcr += p.components.dcr || 0;
            accum.velocity += p.components.velocity || 0;
            accum.refill += p.components.refill || 0;
            accum.priceLag += p.components.priceLag || 0;
            count++;
        });
        const means = count ? {
            dcr: +(accum.dcr / count).toFixed(1),
            velocity: +(accum.velocity / count).toFixed(1),
            refill: +(accum.refill / count).toFixed(1),
            priceLag: +(accum.priceLag / count).toFixed(1)
        } : null;

        console.groupCollapsed(
            `%c[FlowForecast][Diag]%c acc ${summary.accuracy}% (n=${summary.total}) | uncertain ${summary.uncertainPct}%`,
            'color:#38bdf8;font-weight:bold;',
            'color:#cbd5e1;'
        );
        console.log('Summary', summary);
        if (means) console.log('Component means (last', count, 'preds)', means);
        console.groupEnd();
    }

    /**
     * Calculate near-band depth (within ±X% of price)
     */
    calculateNearDepth(book, price) {
        const threshold = price * this.config.nearBandPct;
        let bidDepth = 0, askDepth = 0;
        
        for (const bid of book.bids) {
            if (price - bid.price <= threshold) {
                bidDepth += bid.volume;
            }
        }
        
        for (const ask of book.asks) {
            if (ask.price - price <= threshold) {
                askDepth += ask.volume;
            }
        }
        
        return { bidDepth, askDepth };
    }
    
    /**
     * Calculate Bollinger Bands and %B with period highs/lows (like BB Pulse)
     * @param {number} price - Current price to calculate %B for
     * @param {number} period - BB period (default 20)
     * @param {number} stdDev - Standard deviation multiplier (default 1.5 like BB Pulse)
     * @returns {object} { upper, middle, lower, percentB, periodHigh, periodLow, atPeriodHigh, atPeriodLow }
     */
    calculateBB(price, period = 20, stdDev = 1.5) {
        if (typeof app === 'undefined' || !app.chart) return null;
        
        const candles = app.chart.getCandles();
        if (!candles || candles.length < period * 2) return null;
        
        // Use opens like BB Pulse (more stable for signals)
        const opens = candles.map(c => c.open);
        
        // Calculate BB%B for last N bars to get period high/low
        const percentBHistory = [];
        for (let i = period; i <= opens.length; i++) {
            const slice = opens.slice(i - period, i);
            const sma = slice.reduce((a, b) => a + b, 0) / period;
            
            // Standard deviation
            let variance = 0;
            for (const val of slice) {
                variance += Math.pow(val - sma, 2);
            }
            const std = Math.sqrt(variance / period);
            
            const upper = sma + (std * stdDev);
            const lower = sma - (std * stdDev);
            const priceAtIdx = opens[i - 1];
            const bandWidth = upper - lower;
            const pctB = bandWidth > 0 ? (priceAtIdx - lower) / bandWidth : 0.5;
            percentBHistory.push(pctB);
        }
        
        if (percentBHistory.length < period) return null;
        
        // Current %B is last in history
        const currentPercentB = percentBHistory[percentBHistory.length - 1];
        
        // Get period high/low of %B itself (key BB Pulse insight!)
        const recentPercentB = percentBHistory.slice(-period);
        const percentBHigh = Math.max(...recentPercentB);
        const percentBLow = Math.min(...recentPercentB);
        
        // Check if at 20-period high/low of %B
        const atPeriodHigh = currentPercentB >= percentBHigh;
        const atPeriodLow = currentPercentB <= percentBLow;
        
        // Also calculate price high/low
        const recentHighs = candles.slice(-period).map(c => c.high);
        const recentLows = candles.slice(-period).map(c => c.low);
        const priceHigh20 = Math.max(...recentHighs);
        const priceLow20 = Math.min(...recentLows);
        const atPriceHigh20 = price >= priceHigh20 * 0.999; // Within 0.1%
        const atPriceLow20 = price <= priceLow20 * 1.001;
        
        // Current BB values
        const currentSlice = opens.slice(-period);
        const sma = currentSlice.reduce((a, b) => a + b, 0) / period;
        let variance = 0;
        for (const val of currentSlice) {
            variance += Math.pow(val - sma, 2);
        }
        const std = Math.sqrt(variance / period);
        const upper = sma + (std * stdDev);
        const lower = sma - (std * stdDev);
        
        return {
            upper,
            middle: sma,
            lower,
            percentB: currentPercentB,
            bandWidth: upper - lower,
            bandWidthPct: (upper - lower) / sma * 100,
            // BB Pulse style signals
            percentBHigh,
            percentBLow,
            atPeriodHigh,  // %B at 20-bar high = SELL signal
            atPeriodLow,   // %B at 20-bar low = BUY signal
            // Price extremes
            priceHigh20,
            priceLow20,
            atPriceHigh20,
            atPriceLow20
        };
    }
    
    /**
     * Compute prediction for next bar based on current bar stats
     * Enhanced with BB Pulse Lighting style signals
     */
    computePrediction(barTime) {
        const stats = this.barStats.get(barTime);
        if (!stats) return null;
        
        // Get previous bar for velocity calculation
        const prevBarTime = barTime - this.getIntervalSeconds();
        const prevStats = this.barStats.get(prevBarTime);
        
        // PRIMARY SIGNAL: Direct flow imbalance (most important)
        const flowImbalance = stats.totalVol > 0 
            ? stats.netFlow / stats.totalVol 
            : 0;
        
        // Component 1: DCR (Depth Consumption Rate)
        const dcr = this.computeDCR(stats);
        
        // Component 2: Velocity (Flow Acceleration)
        const velocity = this.computeVelocity(stats, prevStats);
        
        // Component 3: Refill (Book Response)
        const refill = this.computeRefill(stats);
        
        // Component 4: Price Lag (Unrealized Pressure)
        const priceLag = this.computePriceLag(stats);
        
        // BB Pulse Style Analysis (using bar OPEN)
        const bb = this.calculateBB(stats.open);
        const percentB = bb ? bb.percentB : 0.5;
        
        // BB Pulse key signals: 20-period high/low of %B itself
        const atBBPeriodHigh = bb ? bb.atPeriodHigh : false;  // SELL signal
        const atBBPeriodLow = bb ? bb.atPeriodLow : false;    // BUY signal
        
        // Price extremes
        const atPriceHigh20 = bb ? bb.atPriceHigh20 : false;
        const atPriceLow20 = bb ? bb.atPriceLow20 : false;
        
        // Flow direction
        const flowBullish = flowImbalance > 0;
        const flowBearish = flowImbalance < 0;
        
        // Traditional BB zones (for context)
        const oversold = percentB < 0.2;
        const overbought = percentB > 0.8;
        
        // Base score from flow imbalance (scaled to -100 to +100)
        let baseScore = flowImbalance * 200;
        
        // BB Pulse Signal Detection (most powerful signals)
        let bbMultiplier = 1.0;
        let bbSignal = 'neutral';
        let bbPulseSignal = null;
        
        // BB Pulse BUY signals (lBuySignal1 = %B at 20-bar low)
        if (atBBPeriodLow) {
            if (flowBullish) {
                // BB Pulse BUY + Bullish flow = VERY STRONG
                bbMultiplier = 2.5;
                bbSignal = 'bb_pulse_buy';
                bbPulseSignal = 'buy1';
            } else if (!flowBearish || Math.abs(flowImbalance) < 0.1) {
                // BB Pulse BUY + neutral flow = STRONG (mean reversion)
                bbMultiplier = 1.8;
                bbSignal = 'bb_pulse_buy_wait';
                bbPulseSignal = 'buy1_wait';
                // Override direction to up for mean reversion
                if (Math.abs(baseScore) < 20) {
                    baseScore = 30; // Bias toward buy
                }
            } else {
                // BB Pulse BUY but bearish flow = CAUTION
                bbMultiplier = 0.6;
                bbSignal = 'bb_pulse_buy_caution';
                bbPulseSignal = 'buy1_caution';
            }
        }
        // BB Pulse SELL signals (lSellSignal1 = %B at 20-bar high)
        else if (atBBPeriodHigh) {
            if (flowBearish) {
                // BB Pulse SELL + Bearish flow = VERY STRONG
                bbMultiplier = 2.5;
                bbSignal = 'bb_pulse_sell';
                bbPulseSignal = 'sell1';
            } else if (!flowBullish || Math.abs(flowImbalance) < 0.1) {
                // BB Pulse SELL + neutral flow = STRONG (mean reversion)
                bbMultiplier = 1.8;
                bbSignal = 'bb_pulse_sell_wait';
                bbPulseSignal = 'sell1_wait';
                // Override direction to down for mean reversion
                if (Math.abs(baseScore) < 20) {
                    baseScore = -30; // Bias toward sell
                }
            } else {
                // BB Pulse SELL but bullish flow = CAUTION
                bbMultiplier = 0.6;
                bbSignal = 'bb_pulse_sell_caution';
                bbPulseSignal = 'sell1_caution';
            }
        }
        // Price at 20-bar extreme (secondary signals)
        else if (atPriceLow20 && flowBullish) {
            bbMultiplier = 1.5;
            bbSignal = 'price_low_buy';
        } else if (atPriceHigh20 && flowBearish) {
            bbMultiplier = 1.5;
            bbSignal = 'price_high_sell';
        }
        // Traditional oversold/overbought (tertiary signals)
        else if (flowBullish && oversold) {
            bbMultiplier = 1.3;
            bbSignal = 'strong_long';
        } else if (flowBullish && overbought) {
            bbMultiplier = 0.5;
            bbSignal = 'caution_long';
        } else if (flowBearish && overbought) {
            bbMultiplier = 1.3;
            bbSignal = 'strong_short';
        } else if (flowBearish && oversold) {
            bbMultiplier = 0.5;
            bbSignal = 'caution_short';
        }
        
        // Apply BB multiplier to base score
        baseScore *= bbMultiplier;
        
        // Components add/subtract confidence when they agree/disagree
        const w = this.config.weights;
        const componentSum = (dcr * w.dcr) + (velocity * w.velocity) + 
                            (refill * w.refill) + (priceLag * w.priceLag);
        
        // If components agree with flow direction, boost score
        const agreementMultiplier = Math.sign(baseScore) === Math.sign(componentSum) 
            ? 1 + Math.abs(componentSum) * 0.3  // Boost up to 30%
            : 1 - Math.abs(componentSum) * 0.2; // Reduce up to 20%
        
        let score = baseScore * agreementMultiplier;
        
        // Clamp to -100 to +100
        score = Math.max(-100, Math.min(100, score));
        
        // Determine direction and confidence
        const direction = score > 0 ? 'up' : score < 0 ? 'down' : 'neutral';
        const confidence = Math.abs(score);
        const showArrow = confidence >= this.config.minScore;
        
        // Check for absorption (high volume + low range)
        const absorption = this.detectAbsorption(stats);
        
        // Reduce confidence if absorption detected (conflicting signal)
        const adjustedConfidence = absorption ? confidence * 0.6 : confidence;
        const adjustedScore = score > 0 ? adjustedConfidence : -adjustedConfidence;
        
        return {
            score: Math.round(adjustedScore),
            direction: direction,
            confidence: Math.round(adjustedConfidence),
            showArrow: showArrow && !absorption,
            absorption: absorption,
            bbSignal: bbSignal,
            bbPulseSignal: bbPulseSignal,
            components: {
                dcr: Math.round(dcr * 100),
                velocity: Math.round(velocity * 100),
                refill: Math.round(refill * 100),
                priceLag: Math.round(priceLag * 100),
                flowImbalance: Math.round(flowImbalance * 100),
                percentB: bb ? Math.round(percentB * 100) : 50,
                bbMultiplier: Math.round(bbMultiplier * 100),
                // BB Pulse signals
                atBBPeriodHigh: atBBPeriodHigh,
                atBBPeriodLow: atBBPeriodLow,
                atPriceHigh20: atPriceHigh20,
                atPriceLow20: atPriceLow20
            }
        };
    }
    
    /**
     * Component 1: Depth Consumption Rate
     * Measures aggressive volume vs available depth at bar open
     */
    computeDCR(stats) {
        // Avoid division by zero
        const openAsk = stats.openAskDepth || 1;
        const openBid = stats.openBidDepth || 1;
        
        // Buy DCR: how much of the ask depth did buys consume?
        const buyDCR = stats.buyVol / openAsk;
        
        // Sell DCR: how much of the bid depth did sells consume?
        const sellDCR = stats.sellVol / openBid;
        
        // Net DCR: positive = buyers overwhelming, negative = sellers overwhelming
        const netDCR = buyDCR - sellDCR;
        
        // More aggressive scaling: DCR of 0.5 (50% of depth consumed) = full signal
        // Typical values are 0.01-0.2, so scale up
        const scaled = netDCR * 2;
        
        return Math.max(-1, Math.min(1, scaled));
    }
    
    /**
     * Component 2: Flow Velocity (Acceleration)
     * Compares current bar flow to previous bar
     */
    computeVelocity(stats, prevStats) {
        if (!prevStats || prevStats.totalVol === 0) {
            // No previous bar, use current flow direction with reduced weight
            const flowRatio = stats.totalVol > 0 
                ? stats.netFlow / stats.totalVol 
                : 0;
            return flowRatio * 0.5; // Reduce impact without history
        }
        
        // Current flow ratio
        const currentRatio = stats.totalVol > 0 
            ? stats.netFlow / stats.totalVol 
            : 0;
        
        // Previous flow ratio
        const prevRatio = prevStats.totalVol > 0 
            ? prevStats.netFlow / prevStats.totalVol 
            : 0;
        
        // Velocity = change in flow ratio
        // Positive = flow becoming more bullish
        // Negative = flow becoming more bearish
        const velocity = currentRatio - prevRatio;
        
        // Also factor in if flow is accelerating in same direction
        const sameDirection = (currentRatio > 0 && prevRatio > 0) || 
                             (currentRatio < 0 && prevRatio < 0);
        const magnitude = Math.abs(currentRatio);
        
        // Boost if accelerating in same direction
        const boost = sameDirection && magnitude > Math.abs(prevRatio) ? 0.2 : 0;
        
        return Math.max(-1, Math.min(1, velocity + (currentRatio > 0 ? boost : -boost)));
    }
    
    /**
     * Component 3: Refill Rate
     * Is the consumed side thinning or refilling?
     */
    computeRefill(stats) {
        // Compare close depth to open depth on each side
        const bidChange = stats.closeBidDepth - stats.openBidDepth;
        const askChange = stats.closeAskDepth - stats.openAskDepth;
        
        // If net flow was buying (positive), we care about ask side
        // If net flow was selling (negative), we care about bid side
        const netFlow = stats.netFlow;
        
        let refillSignal = 0;
        
        if (netFlow > 0) {
            // Buyers aggressive - check if asks are thinning or refilling
            // Thinning asks = bullish (path clearing)
            // Refilling asks = bearish (resistance forming)
            if (stats.openAskDepth > 0) {
                refillSignal = -askChange / stats.openAskDepth; // Negative change = thinning = positive signal
            }
        } else if (netFlow < 0) {
            // Sellers aggressive - check if bids are thinning or refilling
            // Thinning bids = bearish (support failing)
            // Refilling bids = bullish (support holding)
            if (stats.openBidDepth > 0) {
                refillSignal = bidChange / stats.openBidDepth; // Positive change = refilling = bullish
            }
        }
        
        return Math.max(-1, Math.min(1, refillSignal));
    }
    
    /**
     * Component 4: Price Lag
     * Did price move less than expected given the flow?
     */
    computePriceLag(stats) {
        if (stats.totalVol === 0 || stats.open === 0) return 0;
        
        // Flow imbalance ratio (-1 to +1)
        const flowRatio = stats.netFlow / stats.totalVol;
        
        // Price move as percentage
        const priceMovePct = stats.priceChange / stats.open;
        
        // Expected direction from flow
        const expectedDirection = flowRatio > 0 ? 1 : flowRatio < 0 ? -1 : 0;
        
        // Actual direction from price
        const actualDirection = priceMovePct > 0 ? 1 : priceMovePct < 0 ? -1 : 0;
        
        // If flow and price agree, no lag
        // If flow is strong but price didn't move much, there's unreleased pressure
        if (expectedDirection === 0) return 0;
        
        // Calculate expected move magnitude (rough heuristic)
        // Strong flow should produce some price movement
        const flowMagnitude = Math.abs(flowRatio);
        const priceMagnitude = Math.abs(priceMovePct) * 1000; // Scale up for comparison
        
        // Lag = flow that hasn't been reflected in price yet
        let lag = 0;
        
        if (expectedDirection === actualDirection) {
            // Same direction - check if price moved enough
            lag = flowMagnitude - Math.min(flowMagnitude, priceMagnitude);
            lag *= expectedDirection; // Keep sign
        } else if (actualDirection === 0) {
            // Price didn't move but flow was one-sided - pressure building
            lag = flowRatio * 0.8; // Strong signal
        } else {
            // Price moved opposite to flow - divergence (could be exhaustion)
            lag = flowRatio * 0.3; // Reduced signal, uncertain
        }
        
        return Math.max(-1, Math.min(1, lag));
    }
    
    /**
     * Detect absorption (high volume, low range)
     */
    detectAbsorption(stats) {
        if (this.baselines.samples < 10) return false;
        
        // High volume threshold (above average)
        const volumeRatio = stats.totalVol / (this.baselines.avgVolume || 1);
        const highVolume = volumeRatio > 1.5;
        
        // Low range threshold (compared to price)
        const rangePct = stats.open > 0 ? stats.range / stats.open : 0;
        const lowRange = rangePct < 0.001; // Less than 0.1% range
        
        return highVolume && lowRange;
    }
    
    /**
     * Update rolling baselines
     */
    updateBaselines(stats) {
        const alpha = 1 / Math.min(this.config.baselineWindow, this.baselines.samples + 1);
        
        this.baselines.avgVolume = this.baselines.avgVolume * (1 - alpha) + stats.totalVol * alpha;
        this.baselines.avgBidDepth = this.baselines.avgBidDepth * (1 - alpha) + stats.closeBidDepth * alpha;
        this.baselines.avgAskDepth = this.baselines.avgAskDepth * (1 - alpha) + stats.closeAskDepth * alpha;
        this.baselines.samples++;
    }
    
    /**
     * Normalize value to range
     */
    normalizeValue(value, min, max) {
        if (value <= min) return -1;
        if (value >= max) return 1;
        return (value - min) / (max - min) * 2 - 1;
    }
    
    /**
     * Get interval in seconds
     */
    getIntervalSeconds() {
        const map = {
            '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
            '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
            '1d': 86400, '3d': 259200, '1w': 604800
        };
        return map[this.interval] || 60;
    }
    
    /**
     * Get prediction for a specific bar
     */
    getPrediction(barTime) {
        return this.predictions.get(barTime) || null;
    }
    
    /**
     * Get all predictions for rendering
     */
    getAllPredictions() {
        return new Map(this.predictions);
    }
    
    /**
     * Get the latest prediction (for next bar)
     */
    getLatestPrediction() {
        if (this.predictions.size === 0) return null;
        
        const sortedTimes = Array.from(this.predictions.keys()).sort((a, b) => b - a);
        return this.predictions.get(sortedTimes[0]);
    }
    
    /**
     * Check prediction accuracy for a bar
     */
    checkAccuracy(barTime) {
        const prediction = this.predictions.get(barTime);
        if (!prediction) return null;
        
        // Get actual bar data
        if (typeof app === 'undefined' || !app.chart) return null;
        
        const candles = app.chart.getCandles();
        if (!candles) return null;
        
        const candle = candles.find(c => c.time === barTime);
        if (!candle) return null;
        
        const actualDirection = candle.close > candle.open ? 'up' : 
                               candle.close < candle.open ? 'down' : 'neutral';
        
        const correct = prediction.direction === actualDirection || 
                       prediction.direction === 'neutral' || 
                       actualDirection === 'neutral';
        
        return {
            prediction: prediction.direction,
            actual: actualDirection,
            correct: correct,
            score: prediction.score
        };
    }
    
    /**
     * Trim old data
     */
    trimOldData() {
        if (this.barStats.size <= this.config.maxBars) return;
        
        const sortedTimes = Array.from(this.barStats.keys()).sort((a, b) => a - b);
        const toRemove = sortedTimes.slice(0, this.barStats.size - this.config.maxBars);
        
        toRemove.forEach(time => {
            this.barStats.delete(time);
            this.predictions.delete(time);
        });
    }
    
    /**
     * Clear all data
     */
    clear() {
        this.barStats.clear();
        this.predictions.clear();
        this.baselines = {
            avgVolume: 0,
            avgBidDepth: 0,
            avgAskDepth: 0,
            samples: 0
        };
        this.currentBarOpenDepth = null;
        this.currentBarTime = null;
    }
    
    /**
     * Recalculate all predictions using current algorithm
     * Useful after algorithm changes to re-score existing barStats
     */
    recalculate() {
        const times = Array.from(this.barStats.keys()).sort((a, b) => a - b);
        let count = 0;
        
        // Clear existing predictions
        this.predictions.clear();
        
        // Recalculate for each bar
        times.forEach(barTime => {
            const prediction = this.computePrediction(barTime);
            if (prediction) {
                const nextBarTime = barTime + this.getIntervalSeconds();
                this.predictions.set(nextBarTime, {
                    ...prediction,
                    sourceBar: barTime,
                    targetBar: nextBarTime,
                    generatedAt: Date.now()
                });
                count++;
            }
        });
        
        this.saveToStorage();
        console.log(`[FlowForecast] Recalculated ${count} predictions from ${times.length} bars`);
        
        // Show summary of new scores
        const scores = Array.from(this.predictions.values()).map(p => p.score);
        const avgScore = scores.length ? scores.reduce((a, b) => a + Math.abs(b), 0) / scores.length : 0;
        const highConf = scores.filter(s => Math.abs(s) >= this.config.uncertainThreshold).length;
        console.log(`[FlowForecast] Avg |score|: ${avgScore.toFixed(1)}, High confidence: ${highConf}/${scores.length}`);
        
        return { count, avgScore, highConf, total: scores.length };
    }
    
    /**
     * Storage key
     */
    getStorageKey() {
        return `flowForecast_${this.symbol}_${this.interval}`;
    }
    
    /**
     * Save to localStorage
     */
    saveToStorage() {
        try {
            const data = {
                barStats: {},
                predictions: {},
                baselines: this.baselines
            };
            
            this.barStats.forEach((stats, time) => {
                data.barStats[time] = stats;
            });
            
            this.predictions.forEach((pred, time) => {
                data.predictions[time] = pred;
            });
            
            localStorage.setItem(this.getStorageKey(), JSON.stringify(data));
        } catch (e) {
            console.warn('[FlowForecast] Failed to save:', e);
        }
    }
    
    /**
     * Load from localStorage
     */
    loadFromStorage() {
        try {
            const saved = localStorage.getItem(this.getStorageKey());
            if (!saved) return;
            
            const data = JSON.parse(saved);
            
            if (data.barStats) {
                Object.entries(data.barStats).forEach(([time, stats]) => {
                    this.barStats.set(parseInt(time), stats);
                });
            }
            
            if (data.predictions) {
                Object.entries(data.predictions).forEach(([time, pred]) => {
                    this.predictions.set(parseInt(time), pred);
                });
            }
            
            if (data.baselines) {
                this.baselines = data.baselines;
            }
            
        } catch (e) {
            console.warn('[FlowForecast] Failed to load:', e);
        }
    }
}

// Global instance
const flowForecast = new FlowForecast();

