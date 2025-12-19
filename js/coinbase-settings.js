/**
 * Coinbase Settings Manager
 * 
 * Modal for managing Coinbase API credentials for live trading.
 * 
 * @copyright 2025 Daniel Boorn <daniel.boorn@gmail.com>
 * @license Personal use only. Not for commercial reproduction.
 */

class CoinbaseSettings {
    constructor() {
        this.modal = null;
        this.isOpen = false;
        
        // Storage keys
        this.STORAGE_KEYS = {
            liveApiKey: 'coinbase_live_api_key',
            livePrivateKey: 'coinbase_live_private_key',
            livePortfolioUuid: 'coinbase_live_portfolio_uuid'
        };
        
        this.init();
    }
    
    init() {
        this.createModal();
        this.bindEvents();
    }
    
    createModal() {
        // Create modal container
        this.modal = document.createElement('div');
        this.modal.className = 'coinbase-settings-modal';
        this.modal.innerHTML = `
            <div class="coinbase-settings-backdrop"></div>
            <div class="coinbase-settings-content">
                <div class="coinbase-settings-header">
                    <h2>Coinbase API Settings</h2>
                    <button class="coinbase-settings-close">&times;</button>
                </div>
                <div class="coinbase-settings-body">
                    <!-- Live Section -->
                    <div class="coinbase-settings-section live">
                        <h3>
                            <span class="section-badge live">LIVE</span>
                            Live Credentials (Real Trading)
                        </h3>
                        <div class="coinbase-settings-live-warning">
                            ⚠️ <strong>CAUTION:</strong> These credentials will execute real trades with real money.
                        </div>
                        <div class="coinbase-settings-field">
                            <label>API Key Name</label>
                            <input type="text" id="coinbaseLiveApiKey" 
                                   placeholder="organizations/{org_id}/apiKeys/{key_id}">
                            <small>From CDP Portal - Production API Key</small>
                        </div>
                        <div class="coinbase-settings-field">
                            <label>Private Key (PEM)</label>
                            <textarea id="coinbaseLivePrivateKey" rows="4" 
                                      placeholder="-----BEGIN EC PRIVATE KEY-----&#10;...&#10;-----END EC PRIVATE KEY-----"></textarea>
                            <small>EC Private Key in PEM format</small>
                        </div>
                        <div class="coinbase-settings-field">
                            <label>Portfolio UUID</label>
                            <input type="text" id="coinbaseLivePortfolioUuid" readonly 
                                   placeholder="Auto-discovered on connection">
                            <small>Automatically discovered when you test connection</small>
                        </div>
                        <div class="coinbase-settings-actions">
                            <button class="coinbase-btn test live" id="coinbaseLiveTest">
                                Test Live Connection
                            </button>
                            <span class="connection-status" id="coinbaseLiveStatus"></span>
                        </div>
                    </div>
                </div>
                <div class="coinbase-settings-footer">
                    <button class="coinbase-btn secondary" id="coinbaseClearAll">Clear All</button>
                    <button class="coinbase-btn primary" id="coinbaseSave">Save Settings</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(this.modal);
    }
    
    bindEvents() {
        // Close button
        this.modal.querySelector('.coinbase-settings-close').addEventListener('click', () => this.close());
        
        // Backdrop click
        this.modal.querySelector('.coinbase-settings-backdrop').addEventListener('click', () => this.close());
        
        // Test button
        this.modal.querySelector('#coinbaseLiveTest').addEventListener('click', () => this.testConnection());
        
        // Save button
        this.modal.querySelector('#coinbaseSave').addEventListener('click', () => this.save());
        
        // Clear button
        this.modal.querySelector('#coinbaseClearAll').addEventListener('click', () => this.clearAll());
        
        // ESC key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }
    
    open() {
        this.loadSettings();
        this.modal.classList.add('open');
        this.isOpen = true;
    }
    
    close() {
        this.modal.classList.remove('open');
        this.isOpen = false;
    }
    
    loadSettings() {
        // Load live settings
        document.getElementById('coinbaseLiveApiKey').value = 
            localStorage.getItem(this.STORAGE_KEYS.liveApiKey) || '';
        document.getElementById('coinbaseLivePrivateKey').value = 
            localStorage.getItem(this.STORAGE_KEYS.livePrivateKey) || '';
        document.getElementById('coinbaseLivePortfolioUuid').value = 
            localStorage.getItem(this.STORAGE_KEYS.livePortfolioUuid) || '';
        
        // Clear status messages
        document.getElementById('coinbaseLiveStatus').textContent = '';
    }
    
    save() {
        // Save live settings
        localStorage.setItem(this.STORAGE_KEYS.liveApiKey, 
            document.getElementById('coinbaseLiveApiKey').value.trim());
        localStorage.setItem(this.STORAGE_KEYS.livePrivateKey, 
            document.getElementById('coinbaseLivePrivateKey').value.trim());
        localStorage.setItem(this.STORAGE_KEYS.livePortfolioUuid, 
            document.getElementById('coinbaseLivePortfolioUuid').value.trim());
        
        // Show confirmation
        this.showNotification('Settings saved successfully');
        this.close();
    }
    
    clearAll() {
        if (!confirm('Are you sure you want to clear all Coinbase API credentials?')) {
            return;
        }
        
        // Clear all stored values
        Object.values(this.STORAGE_KEYS).forEach(key => {
            localStorage.removeItem(key);
        });
        
        // Clear form fields
        this.loadSettings();
        this.showNotification('All credentials cleared');
    }
    
    async testConnection() {
        const statusEl = document.getElementById('coinbaseLiveStatus');
        const buttonEl = document.getElementById('coinbaseLiveTest');
        
        // Show loading state
        buttonEl.disabled = true;
        statusEl.textContent = '⏳ Testing...';
        statusEl.className = 'connection-status';
        
        try {
            // Get credentials from form
            const apiKey = document.getElementById('coinbaseLiveApiKey').value.trim();
            const privateKey = document.getElementById('coinbaseLivePrivateKey').value.trim();
            
            if (!apiKey || !privateKey) {
                statusEl.textContent = '❌ Missing credentials';
                statusEl.className = 'connection-status error';
                buttonEl.disabled = false;
                return;
            }
            
            const api = new CoinbaseAPI(apiKey, privateKey);
            
            // Test connection
            const result = await api.testConnection();
            
            if (result.success) {
                // Try to discover portfolio
                try {
                    const portfolioUuid = await api.discoverPortfolio();
                    document.getElementById('coinbaseLivePortfolioUuid').value = portfolioUuid;
                    statusEl.textContent = `✅ Connected (${result.accounts} accounts)`;
                    statusEl.className = 'connection-status success';
                } catch (portfolioError) {
                    console.error('[CoinbaseSettings] Portfolio discovery failed:', portfolioError);
                    statusEl.textContent = '⚠️ Connected but no portfolio found';
                    statusEl.className = 'connection-status warning';
                }
            } else {
                statusEl.textContent = `❌ ${result.error}`;
                statusEl.className = 'connection-status error';
            }
        } catch (error) {
            statusEl.textContent = `❌ ${error.message}`;
            statusEl.className = 'connection-status error';
        } finally {
            buttonEl.disabled = false;
        }
    }
    
    showNotification(message) {
        // Simple notification using alert for now
        // Could be replaced with a toast notification
        console.log('[CoinbaseSettings]', message);
    }
    
    /**
     * Get credentials
     */
    getCredentials() {
        return {
            apiKey: localStorage.getItem(this.STORAGE_KEYS.liveApiKey) || '',
            privateKey: localStorage.getItem(this.STORAGE_KEYS.livePrivateKey) || '',
            portfolioUuid: localStorage.getItem(this.STORAGE_KEYS.livePortfolioUuid) || ''
        };
    }
    
    /**
     * Check if credentials exist
     */
    hasCredentials(environment) {
        // Only perp-live mode is supported
        if (environment !== 'perp-live') {
            return true; // Simulation mode doesn't need credentials
        }
        
        const creds = this.getCredentials();
        return creds.apiKey && creds.privateKey;
    }
    
    /**
     * Create a CoinbaseAPI instance for live trading
     */
    createAPI(environment) {
        if (environment !== 'perp-live') {
            throw new Error('Only perp-live mode is supported');
        }
        
        const creds = this.getCredentials();
        
        if (!creds.apiKey || !creds.privateKey) {
            throw new Error('No Live API credentials configured. Click the gear icon to set them up.');
        }
        
        const api = new CoinbaseAPI(creds.apiKey, creds.privateKey);
        
        if (creds.portfolioUuid) {
            api.portfolioUuid = creds.portfolioUuid;
        }
        
        return api;
    }
}

// Global instance
window.coinbaseSettings = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.coinbaseSettings = new CoinbaseSettings();
    
    // Bind settings button in header
    const settingsBtn = document.getElementById('coinbaseSettingsBtn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            if (window.coinbaseSettings) {
                window.coinbaseSettings.open();
            }
        });
    }
});
