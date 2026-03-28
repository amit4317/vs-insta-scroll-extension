/**
 * keyboardShortcuts.ts
 *
 * Enhanced keyboard shortcuts for Reels control.
 * Features:
 *   - J/K/L controls (rewind, pause/play, fast forward)
 *   - Mute toggle
 *   - Fullscreen toggle
 *   - Save/bookmark current reel
 *   - Speed control
 */

import { CdpSession } from './reelsCdp';

export class KeyboardShortcuts {
  private cdp: CdpSession;
  private isMuted: boolean = false;
  private playbackRate: number = 1.0;
  
  constructor(cdp: CdpSession) {
    this.cdp = cdp;
  }

  async handleKey(key: string): Promise<boolean> {
    switch (key.toLowerCase()) {
      case 'm':
        await this.toggleMute();
        return true;
      
      case 'k':
        await this.togglePlayPause();
        return true;
      
      case 'j':
        await this.rewind(5);
        return true;
      
      case 'l':
        await this.fastForward(5);
        return true;
      
      case 'f':
        await this.toggleFullscreen();
        return true;
      
      case 's':
        await this.saveReel();
        return true;
      
      case '<':
        await this.decreaseSpeed();
        return true;
      
      case '>':
        await this.increaseSpeed();
        return true;
      
      case '0':
        await this.seekToStart();
        return true;
      
      default:
        return false;
    }
  }

  private async toggleMute(): Promise<void> {
    this.isMuted = !this.isMuted;
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => v.muted = ${this.isMuted});
          return ${this.isMuted};
        })()
      `,
      returnByValue: true,
    });
  }

  private async togglePlayPause(): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          let playing = false;
          videos.forEach(v => {
            if (v.getBoundingClientRect().height > 0) {
              playing = !v.paused;
              if (playing) { v.pause(); } else { v.play(); }
            }
          });
          return playing;
        })()
      `,
      returnByValue: true,
    });
  }

  private async rewind(seconds: number): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.getBoundingClientRect().height > 0) {
              v.currentTime = Math.max(0, v.currentTime - ${seconds});
            }
          });
        })()
      `,
    });
  }

  private async fastForward(seconds: number): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.getBoundingClientRect().height > 0) {
              v.currentTime = Math.min(v.duration, v.currentTime + ${seconds});
            }
          });
        })()
      `,
    });
  }

  private async toggleFullscreen(): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          if (document.fullscreenElement) {
            document.exitFullscreen();
            return false;
          } else {
            document.documentElement.requestFullscreen();
            return true;
          }
        })()
      `,
      returnByValue: true,
    });
  }

  private async saveReel(): Promise<void> {
    // This would integrate with VS Code's favorites or a custom list
    // For now, just show a notification
    console.log('Save reel functionality - to be implemented with watch history');
  }

  private async decreaseSpeed(): Promise<void> {
    const rates = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    const currentIndex = rates.indexOf(this.playbackRate);
    if (currentIndex > 0) {
      this.playbackRate = rates[currentIndex - 1];
      await this.setPlaybackRate(this.playbackRate);
    }
  }

  private async increaseSpeed(): Promise<void> {
    const rates = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    const currentIndex = rates.indexOf(this.playbackRate);
    if (currentIndex < rates.length - 1) {
      this.playbackRate = rates[currentIndex + 1];
      await this.setPlaybackRate(this.playbackRate);
    }
  }

  private async setPlaybackRate(rate: number): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.getBoundingClientRect().height > 0) {
              v.playbackRate = ${rate};
            }
          });
        })()
      `,
    });
  }

  private async seekToStart(): Promise<void> {
    await this.cdp.call('Runtime.evaluate', {
      expression: `
        (function() {
          const videos = document.querySelectorAll('video');
          videos.forEach(v => {
            if (v.getBoundingClientRect().height > 0) {
              v.currentTime = 0;
            }
          });
        })()
      `,
    });
  }

  dispose(): void {
    // Cleanup if needed
  }
}
