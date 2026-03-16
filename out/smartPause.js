"use strict";
/**
 * smartPause.ts
 *
 * Auto-pauses the reel the moment the user types in any editor.
 * Resumes automatically after RESUME_DELAY_MS of no typing.
 *
 * Flow:
 *   onDidChangeTextDocument fires
 *     → pause video in Chrome (CDP Runtime.evaluate)
 *     → clear existing resume timer
 *     → arm new resume timer for RESUME_DELAY_MS
 *
 *   Resume timer fires (no typing for RESUME_DELAY_MS)
 *     → resume video in Chrome (CDP Runtime.evaluate)
 *
 * Why Runtime.evaluate instead of a CDP binding?
 *   Pause/resume are one-shot commands we send TO Chrome, not events
 *   Chrome sends to us. Runtime.evaluate is the right primitive — we
 *   call video.pause() / video.play() directly in the page context.
 *   Fire-and-forget (void, no await) so keystrokes never stall.
 *
 * Why no Input.dispatchKeyEvent mute approach?
 *   Instagram intercepts spacebar for like/unlike, not pause.
 *   The only reliable pause is calling video.pause() directly on the
 *   HTMLVideoElement — which only CDP can do from outside the page.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmartPause = void 0;
const vscode = require("vscode");
// How long after the last keystroke before the reel resumes
const RESUME_DELAY_MS = 1500;
// CDP expressions — find the most-visible video and pause/play it
const PAUSE_EXPR = `
(function(){
  const vs = Array.from(document.querySelectorAll('video'));
  let best = null, bv = 0;
  vs.forEach(v => {
    const r = v.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    if (vis > bv) { bv = vis; best = v; }
  });
  if (best && !best.paused) { best.pause(); }
})();
`;
const RESUME_EXPR = `
(function(){
  const vs = Array.from(document.querySelectorAll('video'));
  let best = null, bv = 0;
  vs.forEach(v => {
    const r = v.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    if (vis > bv) { bv = vis; best = v; }
  });
  if (best && best.paused) { best.play().catch(()=>{}); }
})();
`;
class SmartPause {
    constructor(cdp) {
        this.cdp = cdp;
        this.enabled = false;
        this.paused = false; // true = we paused it, we own the resume
    }
    start() {
        if (this.enabled) {
            return;
        }
        this.enabled = true;
        // Subscribe to every text edit in every document
        this.listener = vscode.workspace.onDidChangeTextDocument(() => {
            if (!this.enabled) {
                return;
            }
            this.onTyping();
        });
    }
    stop() {
        if (!this.enabled) {
            return;
        }
        this.enabled = false;
        this.listener?.dispose();
        this.listener = undefined;
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = undefined;
        }
        // If we paused the video, resume it immediately on stop
        if (this.paused) {
            this.paused = false;
            void this.cdp.call('Runtime.evaluate', {
                expression: RESUME_EXPR, awaitPromise: false,
            }).catch(() => { });
        }
    }
    dispose() { this.stop(); }
    onTyping() {
        // Pause immediately on first keystroke
        if (!this.paused) {
            this.paused = true;
            void this.cdp.call('Runtime.evaluate', {
                expression: PAUSE_EXPR, awaitPromise: false,
            }).catch(() => { });
        }
        // Reset resume countdown on every keystroke
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
        }
        this.resumeTimer = setTimeout(() => {
            this.resumeTimer = undefined;
            if (!this.enabled || !this.paused) {
                return;
            }
            this.paused = false;
            void this.cdp.call('Runtime.evaluate', {
                expression: RESUME_EXPR, awaitPromise: false,
            }).catch(() => { });
        }, RESUME_DELAY_MS);
    }
}
exports.SmartPause = SmartPause;
//# sourceMappingURL=smartPause.js.map