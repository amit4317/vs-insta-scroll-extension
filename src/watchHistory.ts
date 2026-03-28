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

import * as vscode from 'vscode';

export interface WatchedReel {
  id: string;
  url: string;
  platform: string;
  timestamp: number;
  position: number;
  duration: number;
  thumbnail?: string;
}

export class WatchHistory {
  private static readonly HISTORY_KEY = 'reels_watch_history';
  private static readonly MAX_HISTORY = 50;
  private context: vscode.ExtensionContext;
  private history: WatchedReel[] = [];
  private currentReel: WatchedReel | null = null;
  private updateTimer: NodeJS.Timeout | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadHistory();
  }

  private loadHistory(): void {
    const stored = this.context.globalState.get<WatchedReel[]>(WatchHistory.HISTORY_KEY);
    if (stored && Array.isArray(stored)) {
      this.history = stored;
    }
  }

  private saveHistory(): void {
    void this.context.globalState.update(WatchHistory.HISTORY_KEY, this.history);
  }

  startTrackingReel(url: string, platform: string): void {
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

  private updatePosition(): void {
    if (!this.currentReel) return;
    
    // Update position from CDP
    void this.getPositionFromCDP().then(position => {
      if (this.currentReel && position !== null) {
        this.currentReel.position = position;
      }
    });
  }

  private async getPositionFromCDP(): Promise<number | null> {
    // This will be called from extension with CDP access
    // Placeholder - actual implementation requires CDP session
    return null;
  }

  setPosition(position: number, duration: number): void {
    if (this.currentReel) {
      this.currentReel.position = position;
      this.currentReel.duration = duration;
    }
  }

  private saveCurrentReel(): void {
    if (!this.currentReel) return;

    // Remove existing entry with same URL
    this.history = this.history.filter(r => r.url !== this.currentReel!.url);
    
    // Add to front of history
    this.history.unshift(this.currentReel);
    
    // Trim to max size
    if (this.history.length > WatchHistory.MAX_HISTORY) {
      this.history = this.history.slice(0, WatchHistory.MAX_HISTORY);
    }

    this.saveHistory();
    this.currentReel = null;
  }

  stopTracking(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.saveCurrentReel();
  }

  getHistory(): WatchedReel[] {
    return [...this.history];
  }

  getLastWatched(): WatchedReel | null {
    return this.history.length > 0 ? this.history[0] : null;
  }

  async resumeLastWatched(): Promise<WatchedReel | null> {
    const last = this.getLastWatched();
    if (last && last.position > 10) {
      // Could trigger auto-resume or show prompt
      return last;
    }
    return null;
  }

  clearHistory(): void {
    this.history = [];
    this.saveHistory();
  }

  removeFromHistory(url: string): void {
    this.history = this.history.filter(r => r.url !== url);
    this.saveHistory();
  }

  private generateId(url: string): string {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(url).digest('hex');
  }

  dispose(): void {
    this.stopTracking();
  }
}
