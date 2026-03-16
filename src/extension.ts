/**
 * extension.ts
 *
 * Renders the Reels canvas directly inside the sidebar WebviewView.
 * No separate editor tab is opened.
 *
 * States:
 *   idle    → sidebar shows "Open Reels" button
 *   playing → sidebar shows the canvas + stream (button UI replaced entirely)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { launchWithWidevine }                          from './widevineLauncher';
import { findChromePath, launchReelsWithCdp,
         WsFrameServer, CdpSession, ReelsSession,
         REELS_URL, REMOTE_W, REMOTE_H, getFreePort,
         sleep }                                      from './reelsCdp';
import { BeatSync }                                   from './beatSync';
import { ChameleonTheme }                             from './chameleon';
import { SmartPause }                                 from './smartPause';

// ── Global session state ─────────────────────────────────────────────────────
let activeSession:  ReelsSession   | undefined;
let activeWsServer: WsFrameServer  | undefined;
let activeBeatSync:   BeatSync        | undefined;
let activeChameleon:  ChameleonTheme  | undefined;
let activeSmartPause: SmartPause      | undefined;

// Cached window.innerHeight read from Chrome via CDP.
// This is the real rendered page height — used for snap scroll distance.
// Falls back to REMOTE_H until the first CDP read completes.
let cachedViewportH: number = REMOTE_H;

// ── Auto-scroll state ────────────────────────────────────────────────────────
let autoScrollEnabled  = false;
let autoScrollTimer:   NodeJS.Timeout | undefined;
let autoScrollWatchId: NodeJS.Timeout | undefined; // polls video progress

// Single reference to the sidebar view — set when VS Code first resolves it.
// Kept so we can push HTML updates from outside the provider.
let sidebarView: vscode.WebviewView | undefined;

// ── Windows Virtual Key codes ────────────────────────────────────────────────
const VK: Record<string, number> = {
  Backspace:8, Tab:9, Enter:13, Escape:27, Space:32,
  PageUp:33, PageDown:34, End:35, Home:36,
  ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40, Delete:46,
  F1:112,F2:113,F3:114,F4:115,F5:116,F6:117,
  F7:118,F8:119,F9:120,F10:121,F11:122,F12:123,
};

// ═══════════════════════════════════════════════════════════════════════════
// HTML: idle state — just the Open button
// ═══════════════════════════════════════════════════════════════════════════

function getIdleHtml(): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Reels</title>
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;width:100%;font-family:var(--vscode-font-family)}
    .w{padding:14px;display:flex;flex-direction:column;gap:9px}
    h3{margin:0 0 2px;font-size:13px;color:var(--vscode-foreground)}
    p{margin:0;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.5}
    .btn{display:block;width:100%;padding:8px 12px;border-radius:4px;cursor:pointer;
         font-size:12px;border:none;text-align:center;margin-top:4px}
    .p{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    .p:hover{background:var(--vscode-button-hoverBackground)}
  </style>
</head>
<body>
  <div class="w">
    <h3>Instagram Reels</h3>
    <p>Streams Chrome directly into this panel.</p>
    <button class="btn p" id="open">▶  Open Reels</button>
  </div>
  <script>
    (function(){
      const api = typeof acquireVsCodeApi==='function' ? acquireVsCodeApi() : null;
      document.getElementById('open').onclick = () => api && api.postMessage({command:'openReels'});
    })();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML: playing state — full canvas + WS client, no buttons
// ═══════════════════════════════════════════════════════════════════════════

function getPlayerHtml(nonce: string, wsPort: number): string {
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src blob:",
    `connect-src ws://127.0.0.1:${wsPort}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Instagram Reels</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{
      width:100%;height:100vh;overflow:hidden;
      background:#000;
      display:flex;flex-direction:column;
      align-items:stretch;
    }

    /* ── Top bar with close + auto-scroll + beat sync buttons ── */
    #bar{
      flex-shrink:0;
      display:flex;align-items:center;justify-content:space-between;
      padding:4px 6px;
      background:#111;
      border-bottom:1px solid #222;
      gap:4px;
    }
    #btn-auto{
      background:transparent;border:1px solid #444;
      color:#888;font-size:11px;cursor:pointer;
      padding:3px 8px;border-radius:3px;line-height:1;
      transition:all .15s;
    }
    #btn-auto.on{
      background:#1a3a1a;border-color:#3a7a3a;color:#6fbe6f;
    }
    #btn-auto:hover{ opacity:.85; }
    #btn-beat{
      background:transparent;border:1px solid #444;
      color:#888;font-size:11px;cursor:pointer;
      padding:3px 8px;border-radius:3px;line-height:1;
      transition:all .2s;
    }
    #btn-beat.on{
      border-color:#534AB7;color:#AFA9EC;
      animation:beatglow 0.6s ease-in-out infinite alternate;
    }
    @keyframes beatglow{
      from{background:transparent}
      to{background:#1a1535}
    }
    #btn-beat:hover{ opacity:.85; }
    #btn-cham{
      background:transparent;border:1px solid #444;
      color:#888;font-size:11px;cursor:pointer;
      padding:3px 8px;border-radius:3px;line-height:1;
      transition:all .2s;
    }
    #btn-cham.on{
      border-color:#1D9E75;color:#9FE1CB;
      animation:chamglow 1.5s ease-in-out infinite alternate;
    }
    @keyframes chamglow{
      from{background:transparent}
      to{background:#0a2018}
    }
    #btn-cham:hover{ opacity:.85; }
    #btn-smart{
      background:transparent;border:1px solid #444;
      color:#888;font-size:11px;cursor:pointer;
      padding:3px 8px;border-radius:3px;line-height:1;
      transition:all .2s;
    }
    #btn-smart.on{
      border-color:#BA7517;color:#FAC775;
    }
    #btn-smart:hover{ opacity:.85; }
    #btn-close{
      background:transparent;border:none;
      color:#888;font-size:16px;cursor:pointer;
      padding:2px 6px;border-radius:3px;line-height:1;
      margin-left:auto;
    }
    #btn-close:hover{color:#ccc;background:#222}

    /* ── Canvas fills remaining height ── */
    #wrap{
      flex:1;overflow:hidden;
      display:flex;align-items:center;justify-content:center;
      background:#000;
    }
    #c{
      display:block;cursor:pointer;
      /* fill height of wrap, keep aspect ratio */
      height:100%;width:auto;max-width:100%;
    }

    #loading{
      position:absolute;inset:0;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
      background:#000;color:#555;font:12px system-ui,sans-serif;pointer-events:none;
    }
    #loading.gone{display:none}
    .spin{width:24px;height:24px;border-radius:50%;
      border:2px solid #1a1a1a;border-top-color:#555;
      animation:sp .85s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div id="bar">
    <button id="btn-auto"  title="Auto-scroll to next reel when video ends">&#8635; Auto</button>
    <button id="btn-beat"  title="Beat Sync — VS Code pulses to the reel audio">&#9835; Beat</button>
    <button id="btn-cham"  title="Chameleon — VS Code colors match the reel">&#9680; Colors</button>
    <button id="btn-smart" title="Smart Pause — reel pauses while you type">&#9646;&#9646; Smart Pause</button>
    <button id="btn-close" title="Close Reels">&#10005;</button>
  </div>
  <div id="wrap">
    <canvas id="c" tabindex="0" width="${REMOTE_W}" height="${REMOTE_H}"></canvas>
    <div id="loading"><div class="spin"></div><span id="st">Connecting…</span></div>
  </div>

  <script nonce="${nonce}">
  (function(){
    const api    = acquireVsCodeApi();
    const canvas = document.getElementById('c');
    const ctx    = canvas.getContext('2d', {alpha:false});
    const load   = document.getElementById('loading');
    const stEl   = document.getElementById('st');

    const RW = ${REMOTE_W};
    const RH = ${REMOTE_H};

    // Close button → tell host to tear down
    document.getElementById('btn-close').onclick = () =>
      api.postMessage({command:'closeReels'});

    // Auto-scroll toggle
    const btnAuto = document.getElementById('btn-auto');
    btnAuto.onclick = () => api.postMessage({command:'toggleAutoScroll'});

    // Beat Sync toggle
    const btnBeat = document.getElementById('btn-beat');
    btnBeat.onclick = () => api.postMessage({command:'toggleBeatSync'});

    // Chameleon theme toggle
    const btnCham = document.getElementById('btn-cham');
    btnCham.onclick = () => api.postMessage({command:'toggleChameleon'});

    // Smart Pause toggle
    const btnSmart = document.getElementById('btn-smart');
    btnSmart.onclick = () => api.postMessage({command:'toggleSmartPause'});

    // ── Producer/consumer JPEG decode pipeline ────────────────────────────
    let pending  = null;
    let decoding = false;

    const img = new Image();
    img.onload = function() {
      ctx.drawImage(img, 0, 0, RW, RH);
      URL.revokeObjectURL(img.src);
      if (pending) { const u=pending; pending=null; img.src=u; }
      else         { decoding=false; }
    };
    img.onerror = function() {
      URL.revokeObjectURL(img.src);
      decoding=false;
      if (pending) { const u=pending; pending=null; img.src=u; decoding=true; }
    };

    // ── WebSocket binary frame relay ──────────────────────────────────────
    let ws=null, alive=true;

    function connect() {
      if (!alive) { return; }
      try { ws = new WebSocket('ws://127.0.0.1:${wsPort}'); }
      catch(e) { setTimeout(connect, 500); return; }

      ws.binaryType = 'arraybuffer';
      ws.onopen  = () => { stEl.textContent='Waiting for first frame…'; };
      ws.onmessage = function(e) {
        if (!(e.data instanceof ArrayBuffer)) { return; }
        // Only steal focus on the very first frame — never again.
        // Calling canvas.focus() on every frame (20fps) was closing
        // every menu the user tried to open.
        if (!load.classList.contains('gone')) {
          load.classList.add('gone');
          canvas.focus();
        }
        const url = URL.createObjectURL(new Blob([e.data], {type:'image/jpeg'}));
        if (!decoding) { decoding=true; img.src=url; }
        else { if (pending) { URL.revokeObjectURL(pending); } pending=url; }
      };
      ws.onclose = ws.onerror = () => { if (alive) { setTimeout(connect, 500); } };
    }
    connect();

    // Control messages (status / die / autoScrollState / beatSyncState)
    window.addEventListener('message', e => {
      if (e.data?.type==='status') { stEl.textContent=e.data.text; }
      if (e.data?.type==='die')    { alive=false; ws?.close(); }
      if (e.data?.type==='autoScrollState') {
        btnAuto.classList.toggle('on', !!e.data.on);
        btnAuto.textContent = e.data.on ? '\u21BA Auto: ON' : '\u21BA Auto Scroll';
      }
      if (e.data?.type==='beatSyncState') {
        btnBeat.classList.toggle('on', !!e.data.on);
        btnBeat.textContent = e.data.on ? '\u266B Beat: ON' : '\u266B Beat Sync';
      }
      if (e.data?.type==='chameleonState') {
        btnCham.classList.toggle('on', !!e.data.on);
        btnCham.textContent = e.data.on ? '\u25D0 Colors: ON' : '\u25D0 Colors';
      }
      if (e.data?.type==='smartPauseState') {
        btnSmart.classList.toggle('on', !!e.data.on);
        btnSmart.textContent = e.data.on ? '\u25AE\u25AE Smart: ON' : '\u25AE\u25AE Smart Pause';
      }
    });

    // ── Coordinates ───────────────────────────────────────────────────────
    function toRemote(e) {
      const r=canvas.getBoundingClientRect();
      return {
        x: Math.round((e.clientX-r.left)/r.width *RW),
        y: Math.round((e.clientY-r.top) /r.height*RH),
      };
    }

    // ── Mouse ─────────────────────────────────────────────────────────────
    canvas.addEventListener('mousedown', e=>{
      e.preventDefault(); canvas.focus();
      const {x,y}=toRemote(e);
      api.postMessage({type:'input',event:'mousedown',x,y,button:e.button});
    });
    canvas.addEventListener('mouseup', e=>{
      const {x,y}=toRemote(e);
      api.postMessage({type:'input',event:'mouseup',x,y,button:e.button});
    });
    canvas.addEventListener('mousemove', e=>{
      if (!e.buttons) { return; }
      const {x,y}=toRemote(e);
      api.postMessage({type:'input',event:'mousemove',x,y});
    });

    // ── Scroll: dual-mode ────────────────────────────────────────────────
    //
    // Touchpad sends many small deltaY ticks.  We want two behaviours:
    //
    //   Slow drift  (browsing the feed, reading)
    //     → forward each tick as Input.dispatchMouseEvent(mouseWheel)
    //       Chrome receives a real scroll event and scrolls smoothly,
    //       pixel by pixel, just like a normal browser.
    //
    //   Fast flick  (switching reels)
    //     → once accumulated delta crosses SNAP_THRESHOLD px AND the
    //       bucket filled in under SNAP_WINDOW ms, fire one full
    //       synthesizeScrollGesture(REMOTE_H) and lock for 1300 ms.
    //
    // The two paths are mutually exclusive: once a snap fires the lock
    // swallows all further ticks until the animation completes.

    let scrollAccum  = 0;
    let scrollLocked = false;
    let firstTickAt  = 0;          // timestamp of first tick in current bucket

    const SNAP_THRESHOLD = 300;    // px accumulated before we consider it a flick
    const SNAP_WINDOW    = 400;    // ms — bucket must fill within this window

    function fireScroll(dir, cx, cy) {
      scrollAccum  = 0;
      firstTickAt  = 0;
      scrollLocked = true;
      setTimeout(()=>{ scrollLocked=false; }, 1300);
      api.postMessage({type:'input',event:'wheel',x:cx,y:cy,direction:dir});
    }

    canvas.addEventListener('wheel', e=>{
      e.preventDefault();
      if (scrollLocked) { scrollAccum=0; firstTickAt=0; return; }

      const now = Date.now();
      if (scrollAccum === 0) { firstTickAt = now; }  // start of new bucket

      scrollAccum += e.deltaY;

      const elapsed = now - firstTickAt;

      // Fast flick detection: large delta arrived quickly
      if (Math.abs(scrollAccum) >= SNAP_THRESHOLD && elapsed <= SNAP_WINDOW) {
        const dir = Math.sign(scrollAccum);
        const {x,y} = toRemote(e);
        fireScroll(dir, x, y);
        return;
      }

      // Bucket expired without crossing threshold → reset accumulator
      // (user paused mid-scroll; treat next tick as a fresh start)
      if (elapsed > SNAP_WINDOW) {
        scrollAccum = e.deltaY;
        firstTickAt = now;
      }

      // Smooth scroll: forward the raw delta directly to Chrome
      // Scale factor 2 makes the scroll feel natural at typical touchpad sensitivity
      const {x,y} = toRemote(e);
      api.postMessage({type:'input',event:'smoothscroll',x,y,deltaY:Math.round(e.deltaY * 2)});
    },{passive:false});

    // ── Keyboard ──────────────────────────────────────────────────────────
    canvas.addEventListener('keydown', e=>{
      e.preventDefault();
      if (e.key==='ArrowDown'||e.key==='ArrowUp') {
        if (scrollLocked) { return; }
        fireScroll(e.key==='ArrowDown'?1:-1, Math.round(RW/2), Math.round(RH/2));
        return;
      }
      const mods=(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
      api.postMessage({type:'input',event:'keydown',key:e.key,code:e.code,modifiers:mods});
      if (e.key.length===1&&!e.ctrlKey&&!e.metaKey) {
        api.postMessage({type:'input',event:'char',text:e.key,modifiers:mods});
      }
    });
    canvas.addEventListener('keyup', e=>{
      if (e.key==='ArrowDown'||e.key==='ArrowUp') { return; }
      const mods=(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
      api.postMessage({type:'input',event:'keyup',key:e.key,code:e.code,modifiers:mods});
    });

  })();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Read window.innerHeight from Chrome — the real snap distance
// ═══════════════════════════════════════════════════════════════════════════

async function refreshViewportHeight(cdp: CdpSession): Promise<void> {
  try {
    const result = await cdp.call('Runtime.evaluate', {
      expression:    'window.innerHeight',
      returnByValue: true,
    });
    const h = (result['result'] as Record<string,unknown>)?.['value'];
    if (typeof h === 'number' && h > 100) {
      cachedViewportH = h;
    }
  } catch { /* keep previous cached value */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-scroll engine
//
// Strategy: poll Chrome every 500 ms via CDP Runtime.evaluate.
// Read the playing video's currentTime and duration.
// When (duration - currentTime) ≤ 0.4 s, fire a snap scroll and wait
// for the new video to load before re-arming the watcher.
//
// Why poll instead of a CDP event?
//   CDP has no "video ended" event that works reliably across Instagram's
//   dynamic React renderer.  A 500 ms poll is cheap (one CDP round-trip)
//   and accurate enough — users won't notice a ≤500 ms delay at reel end.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Auto-scroll engine — fixed
//
// Bugs fixed vs previous version:
//
//  1. Zombie poll: poll() is async. After every await we re-check
//     autoScrollEnabled. If stopAutoScroll() ran during the await,
//     we return immediately instead of calling scheduleNext().
//
//  2. Wrong video element: querySelector('video') picks the first DOM node,
//     which is often a hidden preloaded clip. We now pick the video with the
//     largest visible area in the viewport — always the playing one.
//
//  3. Loop blindness: Instagram loops short reels. When currentTime wraps
//     from near-end back to ~0, remaining shoots back up and we never snap.
//     Fixed by tracking prevCur and detecting the backward jump.
//
//  4. Double-snap: after firing a snap we store snappedKey (src+duration).
//     The next poll won't snap again until the video source changes,
//     preventing double-scroll when the new reel loads slowly.
// ═══════════════════════════════════════════════════════════════════════════

// Finds the video element with the most pixels visible in the viewport.
// This is always the currently playing Reel, never a preloaded background one.
const VIDEO_POLL_EXPR = `
(function() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (!videos.length) { return null; }
  let best = null, bestVis = 0;
  for (const v of videos) {
    const r   = v.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bot = Math.min(r.bottom, window.innerHeight);
    const vis = Math.max(0, bot - top);
    if (vis > bestVis) { bestVis = vis; best = v; }
  }
  if (!best || !isFinite(best.duration) || best.duration <= 0) { return null; }
  return {
    cur:    best.currentTime,
    dur:    best.duration,
    paused: best.paused,
    src:    best.src || best.currentSrc || '',
  };
})()
`;

/**
 * fireTouchSwipe — simulates a real finger swipe via CDP touch events.
 *
 * Why touch events instead of synthesizeScrollGesture?
 *
 *   synthesizeScrollGesture animates a scroll over a fixed distance at a
 *   fixed speed.  When speed is low (≤ 1000 px/s) Instagram's gesture
 *   recogniser treats it as a deliberate slow drag and only scrolls
 *   proportionally — you get 60-70% and the reel sits half-way.
 *
 *   Instagram Reels snaps to the next video based on VELOCITY at touchEnd,
 *   not total distance.  A real finger flick on a phone has velocity
 *   3000–6000 px/s.  dispatchTouchEvent lets us fire that exact velocity
 *   profile:  6 moves spaced 16 ms apart = ~100 ms total swipe at
 *   ~4 000 px/s — well above Instagram's snap threshold every time.
 *
 *   This also makes the bottom-navigation height irrelevant: we are
 *   triggering the velocity snap, not trying to hit an exact pixel position.
 *
 * direction:  1 = swipe up (next reel),  -1 = swipe down (prev reel)
 */
async function fireTouchSwipe(cdp: CdpSession, direction: 1 | -1): Promise<void> {
  const cx = Math.round(REMOTE_W / 2);

  // Start and end positions chosen to give maximum swipe distance while
  // staying well clear of the bottom nav (don't start inside the nav area).
  const startY = direction > 0
    ? Math.round(REMOTE_H * 0.65)   // swipe up:   start 65% down
    : Math.round(REMOTE_H * 0.35);  // swipe down: start 35% down
  const endY = direction > 0
    ? Math.round(REMOTE_H * 0.12)   // swipe up:   end near top
    : Math.round(REMOTE_H * 0.88);  // swipe down: end near bottom

  const STEPS   = 6;
  const STEP_MS = 16;   // ~60 fps — matches real hardware touch sampling rate

  // touchStart
  await cdp.call('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{
      x: cx, y: startY, id: 1,
      radiusX: 10, radiusY: 10, rotationAngle: 0, force: 1,
    }],
  });

  // touchMove — accelerate across the screen
  for (let i = 1; i <= STEPS; i++) {
    await sleep(STEP_MS);
    const y = Math.round(startY + (endY - startY) * (i / STEPS));
    await cdp.call('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: cx, y, id: 1,
        radiusX: 10, radiusY: 10, rotationAngle: 0, force: 1,
      }],
    });
  }

  // touchEnd — release with the finger still moving fast (no pause before release)
  await sleep(8);
  await cdp.call('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

function fireAutoSnap(cdp: CdpSession): void {
  void fireTouchSwipe(cdp, 1);   // 1 = swipe up = advance to next reel
}

function startAutoScroll(cdp: CdpSession): void {
  stopAutoScroll();
  autoScrollEnabled = true;
  updateAutoScrollButton(true);

  // snappedKey: "src:roundedDuration" of the video we most recently snapped from.
  // Prevents double-snapping the same video if the next reel loads slowly.
  let snappedKey = '';

  // prevCur: last observed currentTime.
  // Used to detect backward time jump (loop detection).
  // -1 means "not yet observed".
  let prevCur = -1;

  // scheduleNext: always checks autoScrollEnabled before setting the timeout.
  // This is the guard against zombie polls — if stop was called, we never
  // schedule another tick.
  function scheduleNext(ms: number): void {
    if (!autoScrollEnabled) { return; }
    autoScrollWatchId = setTimeout(() => { void poll(); }, ms);
  }

  async function poll(): Promise<void> {
    // Guard 1: check before doing any work
    if (!autoScrollEnabled) { return; }

    // ── Read video state from Chrome ──────────────────────────────────────
    type VideoState = { cur: number; dur: number; paused: boolean; src: string };
    let val: VideoState | null = null;
    try {
      const res = await cdp.call('Runtime.evaluate', {
        expression:    VIDEO_POLL_EXPR,
        returnByValue: true,
      });

      // Guard 2: check AFTER the await — stopAutoScroll() may have run
      // while we were waiting for CDP to respond.
      if (!autoScrollEnabled) { return; }

      val = (
        (res['result'] as Record<string, unknown>)?.['value'] as VideoState | null
      ) ?? null;

    } catch {
      // Guard 3: check after catch — same race applies
      if (!autoScrollEnabled) { return; }
      scheduleNext(1000);
      return;
    }

    // ── No valid video yet (page loading, navigating) ─────────────────────
    if (!val || !isFinite(val.dur) || val.dur <= 0) {
      prevCur = -1;         // reset tracking — new reel will be a fresh start
      scheduleNext(600);
      return;
    }

    // ── Build a unique key for this specific video ────────────────────────
    // src changes when Instagram swaps to the next reel.
    // dur (×100 rounded) distinguishes different reels with the same src.
    const key = val.src + ':' + Math.round(val.dur * 100);

    // ── Loop detection ────────────────────────────────────────────────────
    // prevCur was near end, now it's near start → the video looped.
    // Treat this exactly like reaching the end normally.
    const looped = prevCur > (val.dur * 0.85) && val.cur < 1.0;

    prevCur = val.cur;   // update for next poll

    const remaining = val.dur - val.cur;

    // ── Decide whether to snap ────────────────────────────────────────────
    // Conditions to snap:
    //   a) Video is within 0.6 s of its end, OR
    //   b) We detected a loop (video restarted)
    // AND we haven't already snapped this exact video.
    // AND video is not paused (user may have manually paused).
    const nearEnd   = remaining <= 0.6;
    const shouldSnap = (nearEnd || looped) && key !== snappedKey && !val.paused;

    if (shouldSnap) {
      snappedKey = key;   // mark as snapped — won't fire again for same video
      prevCur    = -1;    // reset so the incoming new video gets clean tracking

      fireAutoSnap(cdp);

      // Guard 4: check after firing snap (fireAutoSnap is void/fire-and-forget
      // but we still need to check before scheduling)
      if (!autoScrollEnabled) { return; }

      // Wait long enough for:
      //   - scroll animation to complete (~1.2 s)
      //   - Instagram to load and start the next video (~0.8 s extra buffer)
      scheduleNext(2200);
      return;
    }

    // ── Video is paused — check back soon without doing anything ──────────
    if (val.paused) {
      scheduleNext(500);
      return;
    }

    // ── Video is playing normally — wake up just before it ends ──────────
    if (remaining > 0.6) {
      // Sleep until 0.5 s before end. Min 400 ms so we don't busy-wait.
      scheduleNext(Math.max(400, (remaining - 0.5) * 1000));
    } else {
      // remaining ≤ 0.6 but already snapped this video (key === snappedKey).
      // The new reel hasn't appeared yet. Poll quickly until it does.
      scheduleNext(300);
    }
  }

  // First poll after 1.5 s — gives the page time to settle after opening.
  scheduleNext(1500);
}

function stopAutoScroll(): void {
  autoScrollEnabled = false;
  if (autoScrollTimer)   { clearTimeout(autoScrollTimer);   autoScrollTimer   = undefined; }
  if (autoScrollWatchId) { clearTimeout(autoScrollWatchId); autoScrollWatchId = undefined; }
  updateAutoScrollButton(false);
}

function updateAutoScrollButton(on: boolean): void {
  void sidebarView?.webview.postMessage({ type: 'autoScrollState', on });
}

// ── Beat Sync ────────────────────────────────────────────────────────────────

async function toggleBeatSync(): Promise<void> {
  if (!activeSession) { return; }

  if (activeBeatSync) {
    activeBeatSync.dispose();
    activeBeatSync = undefined;
    void sidebarView?.webview.postMessage({ type:'beatSyncState', on:false });
  } else {
    activeBeatSync = new BeatSync(activeSession.cdp);
    await activeBeatSync.start();
    void sidebarView?.webview.postMessage({ type:'beatSyncState', on:true });
  }
}

async function toggleChameleon(): Promise<void> {
  if (!activeSession) { return; }
  if (activeChameleon) {
    activeChameleon.dispose();
    activeChameleon = undefined;
    void sidebarView?.webview.postMessage({ type:'chameleonState', on:false });
  } else {
    activeChameleon = new ChameleonTheme(activeSession.cdp);
    await activeChameleon.start();
    void sidebarView?.webview.postMessage({ type:'chameleonState', on:true });
  }
}

function toggleSmartPause(): void {
  if (!activeSession) { return; }
  if (activeSmartPause) {
    activeSmartPause.dispose();
    activeSmartPause = undefined;
    void sidebarView?.webview.postMessage({ type:'smartPauseState', on:false });
  } else {
    activeSmartPause = new SmartPause(activeSession.cdp);
    activeSmartPause.start();
    void sidebarView?.webview.postMessage({ type:'smartPauseState', on:true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Screencast → WsFrameServer
// ═══════════════════════════════════════════════════════════════════════════

function startScreencast(cdp: CdpSession, wsServer: WsFrameServer): void {
  const params = {
    format:'jpeg', quality:72,
    maxWidth:REMOTE_W, maxHeight:REMOTE_H, everyNthFrame:1,
  };

  void cdp.call('Page.startScreencast', params);

  cdp.on('Page.screencastFrame', (p: Record<string,unknown>) => {
    void cdp.call('Page.screencastFrameAck', { sessionId: p['sessionId'] });
    const b64 = p['data'] as string;
    if (b64) { wsServer.broadcast(Buffer.from(b64, 'base64')); }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Input forwarding — all fire-and-forget
// ═══════════════════════════════════════════════════════════════════════════

const BTN: Record<number,string> = {0:'left',1:'middle',2:'right'};

function forwardInput(cdp: CdpSession, msg: Record<string,unknown>): void {
  const x   = (msg['x']          as number) ?? 0;
  const y   = (msg['y']          as number) ?? 0;
  const mod = (msg['modifiers']  as number) ?? 0;

  switch (msg['event']) {
    case 'mousedown':
      void cdp.call('Input.dispatchMouseEvent', {
        type:'mousePressed', x, y, modifiers:mod,
        button:BTN[(msg['button'] as number)]??'left', clickCount:1,
      }); break;
    case 'mouseup':
      void cdp.call('Input.dispatchMouseEvent', {
        type:'mouseReleased', x, y, modifiers:mod,
        button:BTN[(msg['button'] as number)]??'left', clickCount:1,
      }); break;
    case 'mousemove':
      void cdp.call('Input.dispatchMouseEvent', {
        type:'mouseMoved', x, y, modifiers:mod, button:'none',
      }); break;
    case 'smoothscroll':
      // Forward raw delta as a native mouseWheel — Chrome scrolls smoothly
      void cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x, y,
        deltaX: 0,
        deltaY: (msg['deltaY'] as number) ?? 0,
        modifiers: mod,
      }); break;
    case 'wheel':
      void fireTouchSwipe(cdp, ((msg['direction'] as number) ?? 1) as 1 | -1);
      break;
    case 'keydown': {
      const key=msg['key'] as string, code=msg['code'] as string;
      if (key==='ArrowDown'||key==='ArrowUp') {
        void fireTouchSwipe(cdp, key === 'ArrowDown' ? 1 : -1);
        break;
      }
      const vk=VK[key]??(key.length===1?key.toUpperCase().charCodeAt(0):0);
      void cdp.call('Input.dispatchKeyEvent', {
        type:'rawKeyDown', key, code, modifiers:mod,
        windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk,
      }); break;
    }
    case 'char': {
      const text=msg['text'] as string;
      void cdp.call('Input.dispatchKeyEvent', {
        type:'char', key:text, text, unmodifiedText:text,
        modifiers:mod, windowsVirtualKeyCode:text.toUpperCase().charCodeAt(0),
      }); break;
    }
    case 'keyup': {
      const key=msg['key'] as string, code=msg['code'] as string;
      if (key==='ArrowDown'||key==='ArrowUp') { break; }
      const vk=VK[key]??(key.length===1?key.toUpperCase().charCodeAt(0):0);
      void cdp.call('Input.dispatchKeyEvent', {
        type:'keyUp', key, code, modifiers:mod,
        windowsVirtualKeyCode:vk, nativeVirtualKeyCode:vk,
      }); break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Open / close — both operate directly on sidebarView
// ═══════════════════════════════════════════════════════════════════════════

async function openReels(context: vscode.ExtensionContext): Promise<void> {
  if (activeSession) { return; }   // already running

  if (!findChromePath()) {
    void vscode.window.showErrorMessage(
      'Instagram Reels: Chrome or Edge not found. Install Google Chrome and try again.',
    );
    return;
  }

  const wsPort = await getFreePort();
  activeWsServer = new WsFrameServer(wsPort);

  const nonce = crypto.randomBytes(16).toString('hex');

  // Switch sidebar to player HTML immediately (shows spinner while Chrome loads)
  if (sidebarView) {
    sidebarView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    sidebarView.webview.html = getPlayerHtml(nonce, wsPort);

    // Wire input + close from the player HTML
    sidebarView.webview.onDidReceiveMessage(
      (msg: Record<string,unknown>) => {
        const cmd = (msg as {command?:string})['command'];
        if (cmd === 'closeReels') { closeReels(); return; }
        if (cmd === 'toggleAutoScroll') {
          if (autoScrollEnabled) { stopAutoScroll(); }
          else if (activeSession) { startAutoScroll(activeSession.cdp); }
          return;
        }
        if (cmd === 'toggleBeatSync') {
          void toggleBeatSync();
          return;
        }
        if (cmd === 'toggleChameleon') {
          void toggleChameleon();
          return;
        }
        if (cmd === 'toggleSmartPause') {
          toggleSmartPause();
          return;
        }
        if (msg['type'] === 'input' && activeSession) {
          forwardInput(activeSession.cdp, msg);
        }
      },
      undefined, context.subscriptions,
    );
  }

  const setStatus = (t: string) =>
    void sidebarView?.webview.postMessage({ type:'status', text:t });

  setStatus('Launching Chrome…');

  try {
    activeSession = await launchReelsWithCdp();
    setStatus('Starting stream…');

    // Read the real window.innerHeight from Chrome now and on every navigation.
    // This is the correct snap distance — accounts for Instagram's own nav bars.
    void refreshViewportHeight(activeSession.cdp);
    activeSession.cdp.on('Page.loadEventFired', () => {
      void refreshViewportHeight(activeSession!.cdp);
    });
    activeSession.cdp.on('Page.navigatedWithinDocument', () => {
      void refreshViewportHeight(activeSession!.cdp);
    });

    startScreencast(activeSession.cdp, activeWsServer);
    activeSession.cdp.on('_disconnect', () => {
      void vscode.window.showWarningMessage('Reels: Chrome disconnected.');
      closeReels();
    });
  } catch (err) {
    void vscode.window.showErrorMessage(
      'Instagram Reels: ' + (err instanceof Error ? err.message : String(err)),
    );
    closeReels();
  }
}

function closeReels(): void {
  stopAutoScroll();

  activeBeatSync?.dispose();
  activeBeatSync = undefined;

  activeChameleon?.dispose();
  activeChameleon = undefined;

  activeSmartPause?.dispose();
  activeSmartPause = undefined;

  void sidebarView?.webview.postMessage({ type:'die' });

  activeWsServer?.close(); activeWsServer = undefined;
  activeSession?.kill();   activeSession  = undefined;
  cachedViewportH = REMOTE_H;

  if (sidebarView) {
    sidebarView.webview.html = getIdleHtml();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sidebar provider
// ═══════════════════════════════════════════════════════════════════════════

class ReelsViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly _ctx: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(
    view:     vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token:   vscode.CancellationToken,
  ): void {
    sidebarView = view;

    view.webview.options = { enableScripts:true, localResourceRoots:[] };
    view.webview.html    = getIdleHtml();

    // Handle messages from the IDLE view (Open button)
    view.webview.onDidReceiveMessage(async (msg: {command:string}) => {
      switch (msg.command) {
        case 'openReels': await openReels(this._ctx); break;
        case 'closeReels': closeReels(); break;
      }
    });

    // Clean up if the sidebar is disposed (e.g. user closes the activity bar item)
    view.onDidDispose(() => {
      closeReels();
      sidebarView = undefined;
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Activation
// ═══════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'vsInstaReels.sidebar',
      new ReelsViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  const open = () => openReels(context);
  context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.open',          open));
  context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.openInVSCode',  open));
  context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.openInBrowser', () =>
    void vscode.env.openExternal(vscode.Uri.parse(REELS_URL))));
  context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.launchWithDrm', () => {
    const r = launchWithWidevine();
    if (r.ok) { void vscode.window.showInformationMessage(r.message); }
    else       { void vscode.window.showErrorMessage('Reels DRM: ' + r.message); }
  }));
}

export function deactivate(): void { closeReels(); }