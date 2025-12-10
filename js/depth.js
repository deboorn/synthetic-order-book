/**
 * Synthetic Order Book - Depth Chart
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 *          For commercial licensing, contact daniel.boorn@gmail.com
 * 
 * Depth Chart Visualization
 * Shows cumulative bid/ask volume
 */
class DepthChart {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.canvas = null;
        this.ctx = null;
        this.data = { bids: [], asks: [], price: 0 };
        this.animationFrame = null;
        this.resizeObserver = null;
        this.resizeTimeout = null;
        
        this.colors = {
            bidLine: '#10b981',
            bidFill: 'rgba(16, 185, 129, 0.2)',
            askLine: '#ef4444',
            askFill: 'rgba(239, 68, 68, 0.2)',
            grid: 'rgba(30, 41, 59, 0.5)',
            text: '#64748b',
            priceLine: 'rgba(59, 130, 246, 0.8)'
        };
        
        this.padding = { top: 10, right: 50, bottom: 25, left: 10 };
    }

    init() {
        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'depth-canvas';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // Handle resize with ResizeObserver for container changes
        this.setupResizeHandling();
        
        // Initial resize
        this.resize();

        return this;
    }
    
    setupResizeHandling() {
        // Debounced resize handler
        const debouncedResize = () => {
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = setTimeout(() => {
                this.resize();
            }, 50);
        };
        
        // Use ResizeObserver for container size changes
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver((entries) => {
                debouncedResize();
            });
            this.resizeObserver.observe(this.container);
        }
        
        // Also listen to window resize as fallback
        this.windowResizeHandler = debouncedResize;
        window.addEventListener('resize', this.windowResizeHandler);
    }

    resize() {
        if (!this.container || !this.canvas) return;
        
        const rect = this.container.getBoundingClientRect();
        
        // Skip if container has no size yet
        if (rect.width <= 0 || rect.height <= 0) return;
        
        const dpr = window.devicePixelRatio || 1;
        
        // Only resize if dimensions actually changed
        const newWidth = Math.floor(rect.width);
        const newHeight = Math.floor(rect.height);
        
        if (this.width === newWidth && this.height === newHeight) {
            return;
        }
        
        this.width = newWidth;
        this.height = newHeight;
        
        this.canvas.width = newWidth * dpr;
        this.canvas.height = newHeight * dpr;
        this.canvas.style.width = newWidth + 'px';
        this.canvas.style.height = newHeight + 'px';
        
        this.ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
        this.ctx.scale(dpr, dpr);
        
        if (this.data.bids.length || this.data.asks.length) {
            this.render();
        }
    }

    setData(data) {
        this.data = data;
        this.render();
    }

    render() {
        if (!this.ctx) return;
        
        const { bids, asks, price } = this.data;
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.width, this.height);
        
        // Show "waiting" message if no data
        if (!bids.length && !asks.length) {
            this.ctx.fillStyle = this.colors.text;
            this.ctx.font = '12px JetBrains Mono, monospace';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Connecting to exchanges...', this.width / 2, this.height / 2);
            return;
        }

        const chartWidth = this.width - this.padding.left - this.padding.right;
        const chartHeight = this.height - this.padding.top - this.padding.bottom;

        // Calculate ranges
        const allPrices = [...bids.map(b => b.price), ...asks.map(a => a.price)];
        const allVolumes = [...bids.map(b => b.cumulative), ...asks.map(a => a.cumulative)];
        
        const minPrice = Math.min(...allPrices);
        const maxPrice = Math.max(...allPrices);
        const maxVolume = Math.max(...allVolumes);
        
        const priceRange = maxPrice - minPrice;

        // Helper functions
        const priceToX = (p) => {
            return this.padding.left + ((p - minPrice) / priceRange) * chartWidth;
        };

        const volToY = (v) => {
            return this.padding.top + chartHeight - (v / maxVolume) * chartHeight;
        };

        // Draw grid
        this.drawGrid(chartWidth, chartHeight, minPrice, maxPrice, maxVolume);

        // Draw bids (left side, green)
        if (bids.length) {
            this.drawArea(bids, priceToX, volToY, this.colors.bidLine, this.colors.bidFill, true);
        }

        // Draw asks (right side, red)
        if (asks.length) {
            this.drawArea(asks, priceToX, volToY, this.colors.askLine, this.colors.askFill, false);
        }

        // Draw current price line
        if (price > 0 && price >= minPrice && price <= maxPrice) {
            const x = priceToX(price);
            this.ctx.beginPath();
            this.ctx.strokeStyle = this.colors.priceLine;
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([4, 4]);
            this.ctx.moveTo(x, this.padding.top);
            this.ctx.lineTo(x, this.height - this.padding.bottom);
            this.ctx.stroke();
            this.ctx.setLineDash([]);

            // Price label
            this.ctx.fillStyle = this.colors.priceLine;
            this.ctx.font = '10px JetBrains Mono, monospace';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(this.formatPrice(price), x, this.height - 5);
        }
    }

    drawGrid(chartWidth, chartHeight, minPrice, maxPrice, maxVolume) {
        const { ctx, padding } = this;
        
        ctx.strokeStyle = this.colors.grid;
        ctx.lineWidth = 1;

        // Horizontal grid lines (volume)
        const volSteps = 4;
        for (let i = 0; i <= volSteps; i++) {
            const y = padding.top + (chartHeight / volSteps) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(this.width - padding.right, y);
            ctx.stroke();

            // Volume labels
            const vol = maxVolume * (1 - i / volSteps);
            ctx.fillStyle = this.colors.text;
            ctx.font = '9px JetBrains Mono, monospace';
            ctx.textAlign = 'left';
            ctx.fillText(this.formatVolume(vol), this.width - padding.right + 5, y + 3);
        }

        // Price axis labels
        ctx.fillStyle = this.colors.text;
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        
        const priceSteps = 5;
        const priceRange = maxPrice - minPrice;
        for (let i = 0; i <= priceSteps; i++) {
            const price = minPrice + (priceRange / priceSteps) * i;
            const x = padding.left + (chartWidth / priceSteps) * i;
            ctx.fillText(this.formatPrice(price), x, this.height - 5);
        }
    }

    drawArea(data, priceToX, volToY, lineColor, fillColor, isLeft) {
        const { ctx } = this;
        
        // Sort data
        const sorted = [...data].sort((a, b) => isLeft ? b.price - a.price : a.price - b.price);
        
        if (sorted.length < 2) return;

        // Draw filled area
        ctx.beginPath();
        ctx.moveTo(priceToX(sorted[0].price), this.height - this.padding.bottom);
        
        sorted.forEach((point, i) => {
            const x = priceToX(point.price);
            const y = volToY(point.cumulative);
            
            if (i === 0) {
                ctx.lineTo(x, y);
            } else {
                // Step line
                ctx.lineTo(x, volToY(sorted[i - 1].cumulative));
                ctx.lineTo(x, y);
            }
        });

        ctx.lineTo(priceToX(sorted[sorted.length - 1].price), this.height - this.padding.bottom);
        ctx.closePath();
        
        ctx.fillStyle = fillColor;
        ctx.fill();

        // Draw line
        ctx.beginPath();
        sorted.forEach((point, i) => {
            const x = priceToX(point.price);
            const y = volToY(point.cumulative);
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, volToY(sorted[i - 1].cumulative));
                ctx.lineTo(x, y);
            }
        });
        
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    formatPrice(price) {
        if (price >= 1000) {
            return (price / 1000).toFixed(1) + 'K';
        }
        return price.toFixed(0);
    }

    formatVolume(vol) {
        if (vol >= 1000) {
            return (vol / 1000).toFixed(1) + 'K';
        }
        if (vol >= 1) {
            return vol.toFixed(1);
        }
        return vol.toFixed(2);
    }

    destroy() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }
        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.windowResizeHandler) {
            window.removeEventListener('resize', this.windowResizeHandler);
        }
        if (this.canvas && this.container) {
            this.container.removeChild(this.canvas);
        }
    }
}

