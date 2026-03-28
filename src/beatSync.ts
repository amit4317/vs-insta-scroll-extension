/**
 * beatSync.ts
 *
 * Makes VS Code pulse visually to the audio beat of the playing reel.
 *
 * Architecture — why CDP binding instead of polling:
 *
 *   POLLING approach (bad):
 *     Extension host calls Runtime.evaluate every 16ms → gets frequency data →
 *     processes beats → applies decorations. Round-trip latency is 15–30ms per
 *     poll. At 16ms intervals that's a constant 50% CPU overhead just to detect
 *     beats. And it will still be late.
 *
 *   BINDING approach (this file):
 *     1. Runtime.addBinding('__beatPulse') registers a native CDP channel.
 *        Chrome creates a real function window.__beatPulse(data) inside the page.
 *     2. Our injected script runs requestAnimationFrame inside Chrome,
 *        doing beat detection entirely in Chrome's JS engine (zero IPC cost).
 *     3. When a beat fires, it calls window.__beatPulse(data) — which fires
 *        a Runtime.bindingCalled CDP event that arrives in the extension host
 *        with < 1ms latency. No polling. Pure event push.
 *     4. Extension host receives the beat, runs VS Code decoration for ~180ms,
 *        then fades it out.
 *
 * Beat detection algorithm — energy-based with adaptive threshold:
 *
 *   The Web Audio AnalyserNode gives us a 128-bin FFT at each animation frame.
 *   We focus on bass frequencies (bins 0–10, roughly 0–1700 Hz) because kick
 *   drums and bass hits are what humans feel as "the beat."
 *
 *   We keep a rolling history of the last 43 frames (~700ms at 60fps).
 *   A beat fires when:
 *     current_energy > BEAT_THRESHOLD × average(history)
 *   and a minimum 250ms has passed since the last beat (prevents double-triggers
 *   on the same transient).
 *
 *   BEAT_THRESHOLD = 1.5 means "50% louder than recent average." This adapts
 *   to both quiet acoustic reels and loud club tracks automatically.
 *
 * VS Code effects:
 *   - Status bar background flashes (most visible, always on screen)
 *   - Active editor line gets a background highlight
 *   - Both fade after PULSE_DURATION_MS via a clearTimeout guard
 */

import * as vscode from 'vscode';
import { CdpSession } from './reelsCdp';

// ── Tuning constants ─────────────────────────────────────────────────────────
const BEAT_THRESHOLD    = 1.05;   // energy multiplier over rolling average
const HISTORY_FRAMES    = 30;    // ~700 ms at 60 fps — rolling energy window
const MIN_BEAT_GAP_MS   = 120;   // minimum ms between beats (anti-double-trigger)
const PULSE_DURATION_MS = 100;   // how long the VS Code flash lasts

// ── Beat detection + binding script injected into Chrome ────────────────────
//
// This runs entirely inside Chrome's JS engine.
// It finds the playing video, taps its audio via Web Audio API,
// and calls window.__beatPulse() when a beat is detected.
//
// Re-arms itself every 2 seconds in case Instagram swaps the video element
// (which it does when advancing to the next reel).
const BEAT_DETECTION_SCRIPT = `
(function() {
  if (window.__beatSyncRunning) { return; }
  window.__beatSyncRunning = true;

  const THRESHOLD   = ${BEAT_THRESHOLD};
  const HISTORY_LEN = ${HISTORY_FRAMES};
  const MIN_GAP_MS  = ${MIN_BEAT_GAP_MS};

  let ctx       = null;
  let analyser  = null;
  let source    = null;
  let history   = [];
  let lastBeat  = 0;
  let lastVideo = null;

  function connectVideo(video) {
    if (video === lastVideo) { return; }
    lastVideo = video;

    try {
      if (!ctx) {
        ctx      = new (window.AudioContext || window.webkitAudioContext)();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.connect(ctx.destination);
      }
      if (source) { try { source.disconnect(); } catch(e) {} }
      source = ctx.createMediaElementSource(video);
      source.connect(analyser);
      history = [];
    } catch(e) {
      lastVideo = null;
    }
  }

  function getBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) { return null; }
    let best = null, bestVis = 0;
    for (const v of videos) {
      if (v.paused || v.muted) { continue; }
      const r   = v.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (vis > bestVis) { bestVis = vis; best = v; }
    }
    return best || videos[0] || null;
  }

  function tick() {
    const rafId = requestAnimationFrame(tick);
    // Expose rafId globally so stop() can cancel it
    (window as any).__beatRafId = rafId;

    const video = getBestVideo();
    if (!video) { return; }
    connectVideo(video);
    if (!analyser) { return; }

    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    // Focus on bass bins (0–10 ≈ 0–1700 Hz) — kick and bass transients
    let energy = 0;
    for (let i = 0; i <= 20; i++) { energy += data[i] * data[i]; }
    energy = Math.sqrt(energy / 11);

    history.push(energy);
    if (history.length > HISTORY_LEN) { history.shift(); }
    if (history.length < 5) { return; }

    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const now = performance.now();

    if (energy > THRESHOLD * avg && avg > 10 && (now - lastBeat) > MIN_GAP_MS) {
      lastBeat = now;
      const intensity = Math.min(1, (energy - avg) / (avg + 1));
      try {
        window.__beatPulse(JSON.stringify({
          intensity: +intensity.toFixed(3),
          energy:    +energy.toFixed(1),
          avg:       +avg.toFixed(1),
        }));
      } catch(e) {}
    }
  }

  tick();

  // Re-connect if the video element is swapped (next reel loads)
  setInterval(() => {
    const v = getBestVideo();
    if (v && v !== lastVideo) { connectVideo(v); }
  }, 2000);
})();
`;

// ── VS Code decoration types ─────────────────────────────────────────────────

function makeDecorations() {
  // Active line pulse — a soft background wash on the line the cursor is on
  const linePulse = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px',
  });

  return { linePulse };
}

// ── BeatSync class ────────────────────────────────────────────────────────────

export class BeatSync {
  private enabled    = false;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private statusItem: vscode.StatusBarItem;
  private decorations = makeDecorations();
  private originalStatusBg: string | undefined;

  constructor(private readonly cdp: CdpSession) {
    // Create a status bar item we can repaint on every beat
    this.statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      999,
    );
    this.statusItem.text   = '$(music) Beat Sync';
    this.statusItem.tooltip = 'Beat Sync is active — VS Code pulses to the reel audio';
  }

  async start(): Promise<void> {
    if (this.enabled) { return; }
    this.enabled = true;

    // Register the CDP binding that Chrome calls when a beat fires.
    // This creates window.__beatPulse() inside the Chrome page.
    await this.cdp.call('Runtime.addBinding', { name: '__beatPulse' });

    // Listen for beats — Runtime.bindingCalled fires every time Chrome
    // calls window.__beatPulse(data) inside the page.
    this.cdp.on('Runtime.bindingCalled', (params) => {
      if (!this.enabled) { return; }
      if ((params['name'] as string) !== '__beatPulse') { return; }

      try {
        type BeatData = { intensity: number; energy: number; avg: number };
        const data = JSON.parse(params['payload'] as string) as BeatData;
        this.onBeat(data.intensity);
      } catch { /* malformed payload — ignore */ }
    });

    // Inject the beat detection script into Chrome
    await this.cdp.call('Runtime.evaluate', {
      expression:    BEAT_DETECTION_SCRIPT,
      awaitPromise:  false,
    });

    // Show the Beat Sync status item
    this.statusItem.show();
  }

  stop(): void {
    this.enabled = false;
    this.clearPulse();
    this.statusItem.hide();
    this.decorations.linePulse.dispose();
    this.decorations = makeDecorations();

    // Tell the page to stop (clean gc)
    void this.cdp.call('Runtime.evaluate', {
      expression:   'window.__beatSyncRunning = false; if(window.__beatRafId) cancelAnimationFrame(window.__beatRafId);',
      awaitPromise: false,
    }).catch(() => { /* page may be gone */ });
  }

  dispose(): void {
    this.stop();
    this.statusItem.dispose();
    this.decorations.linePulse.dispose();
  }

  private onBeat(intensity: number): void {
    // Cancel the previous clear timer so rapid beats don't flicker off mid-pulse
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }

    this.applyPulse(intensity);

    // Schedule pulse removal
    this.clearTimer = setTimeout(
      () => this.clearPulse(),
      PULSE_DURATION_MS,
    );
  }

  private applyPulse(intensity: number): void {
    // ── Status bar flash ────────────────────────────────────────────────────
    // Map intensity 0..1 to a color spectrum: low = teal, high = purple/pink
    const r = Math.round(80  + intensity * 120);
    const g = Math.round(20  + intensity * 30);
    const b = Math.round(180 + intensity * 70);
    this.statusItem.text    = '$(pulse) Beat';
    this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // ── Active editor line decoration ───────────────────────────────────────
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const line = editor.selection.active.line;
      const range = new vscode.Range(line, 0, line, 0);
      editor.setDecorations(this.decorations.linePulse, [{ range }]);
    }

    // Suppress TS unused variable warning — r,g,b are reserved for
    // future custom theme color implementation
    void r; void g; void b;
  }

  private clearPulse(): void {
    this.statusItem.text            = '$(music) Beat Sync';
    this.statusItem.backgroundColor = undefined;

    // Remove line decoration from all visible editors
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decorations.linePulse, []);
    }
  }
}