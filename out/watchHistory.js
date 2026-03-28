"use strict";
/**
 * watchHistory.ts
 *
 * Tracks watch history and enables resume functionality.
 * Features:
 *   - Store last watched position
 *   - Continue watching from where you left off
 *   - Track recently watched reels
 *   - Persistent storage using VS Code globalState
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WatchHistory = void 0;
class WatchHistory {
    constructor(context) {
        this.history = [];
        this.currentReel = null;
        this.context = context;
        this.loadHistory();
    }
    loadHistory() {
        const stored = this.context.globalState.get(WatchHistory.HISTORY_KEY);
        if (stored && Array.isArray(stored)) {
            this.history = stored;
        }
    }
    saveHistory() {
        void this.context.globalState.update(WatchHistory.HISTORY_KEY, this.history);
    }
    startTrackingReel(url, platform) {
        // Save previous reel if exists
        if (this.currentReel) {
            this.saveCurrentReel();
        }
        // Check if this URL exists in history
        const existing = this.history.find(r => r.url === url);
        this.currentReel = {
            id: this.generateId(url),
            url,
            platform,
            timestamp: Date.now(),
            position: existing?.position || 0,
            duration: 0,
            thumbnail: undefined,
        };
        // Start periodic updates
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }
        this.updateTimer = setInterval(() => {
            this.updatePosition();
        }, 2000);
    }
    updatePosition() {
        if (!this.currentReel)
            return;
        // Update position from CDP
        void this.getPositionFromCDP().then(position => {
            if (this.currentReel && position !== null) {
                this.currentReel.position = position;
            }
        });
    }
    async getPositionFromCDP() {
        // This will be called from extension with CDP access
        // Placeholder - actual implementation requires CDP session
        return null;
    }
    setPosition(position, duration) {
        if (this.currentReel) {
            this.currentReel.position = position;
            this.currentReel.duration = duration;
        }
    }
    saveCurrentReel() {
        if (!this.currentReel)
            return;
        // Remove existing entry with same URL
        this.history = this.history.filter(r => r.url !== this.currentReel.url);
        // Add to front of history
        this.history.unshift(this.currentReel);
        // Trim to max size
        if (this.history.length > WatchHistory.MAX_HISTORY) {
            this.history = this.history.slice(0, WatchHistory.MAX_HISTORY);
        }
        this.saveHistory();
        this.currentReel = null;
    }
    stopTracking() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
        }
        this.saveCurrentReel();
    }
    getHistory() {
        return [...this.history];
    }
    getLastWatched() {
        return this.history.length > 0 ? this.history[0] : null;
    }
    async resumeLastWatched() {
        const last = this.getLastWatched();
        if (last && last.position > 10) {
            // Could trigger auto-resume or show prompt
            return last;
        }
        return null;
    }
    clearHistory() {
        this.history = [];
        this.saveHistory();
    }
    removeFromHistory(url) {
        this.history = this.history.filter(r => r.url !== url);
        this.saveHistory();
    }
    generateId(url) {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(url).digest('hex');
    }
    dispose() {
        this.stopTracking();
    }
}
exports.WatchHistory = WatchHistory;
WatchHistory.HISTORY_KEY = 'reels_watch_history';
WatchHistory.MAX_HISTORY = 50;
//# sourceMappingURL=watchHistory.js.map