"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyboardShortcuts = void 0;
class KeyboardShortcuts {
    constructor(cdp) {
        this.isMuted = false;
        this.playbackRate = 1.0;
        this.cdp = cdp;
    }
    async handleKey(key) {
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
    async toggleMute() {
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
    async togglePlayPause() {
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
    async rewind(seconds) {
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
    async fastForward(seconds) {
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
    async toggleFullscreen() {
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
    async saveReel() {
        // This would integrate with VS Code's favorites or a custom list
        // For now, just show a notification
        console.log('Save reel functionality - to be implemented with watch history');
    }
    async decreaseSpeed() {
        const rates = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
        const currentIndex = rates.indexOf(this.playbackRate);
        if (currentIndex > 0) {
            this.playbackRate = rates[currentIndex - 1];
            await this.setPlaybackRate(this.playbackRate);
        }
    }
    async increaseSpeed() {
        const rates = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
        const currentIndex = rates.indexOf(this.playbackRate);
        if (currentIndex < rates.length - 1) {
            this.playbackRate = rates[currentIndex + 1];
            await this.setPlaybackRate(this.playbackRate);
        }
    }
    async setPlaybackRate(rate) {
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
    async seekToStart() {
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
    dispose() {
        // Cleanup if needed
    }
}
exports.KeyboardShortcuts = KeyboardShortcuts;
//# sourceMappingURL=keyboardShortcuts.js.map