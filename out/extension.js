"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const crypto = require("crypto");
const widevineLauncher_1 = require("./widevineLauncher");
const reelsCdp_1 = require("./reelsCdp");
// ── Global session state ─────────────────────────────────────────────────────
let activeSession;
let activeWsServer;
// Cached window.innerHeight read from Chrome via CDP.
// This is the real rendered page height — used for snap scroll distance.
// Falls back to REMOTE_H until the first CDP read completes.
let cachedViewportH = reelsCdp_1.REMOTE_H;
// ── Auto-scroll state ────────────────────────────────────────────────────────
let autoScrollEnabled = false;
let autoScrollTimer;
let autoScrollWatchId; // polls video progress
// Single reference to the sidebar view — set when VS Code first resolves it.
// Kept so we can push HTML updates from outside the provider.
let sidebarView;
// ── Windows Virtual Key codes ────────────────────────────────────────────────
const VK = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
    F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
// ═══════════════════════════════════════════════════════════════════════════
// HTML: idle state — just the Open button
// ═══════════════════════════════════════════════════════════════════════════
function getIdleHtml() {
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
function getPlayerHtml(nonce, wsPort) {
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

    /* ── Top bar with close + auto-scroll buttons ── */
    #bar{
      flex-shrink:0;
      display:flex;align-items:center;justify-content:space-between;
      padding:4px 6px;
      background:#111;
      border-bottom:1px solid #222;
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
    #btn-close{
      background:transparent;border:none;
      color:#888;font-size:16px;cursor:pointer;
      padding:2px 6px;border-radius:3px;line-height:1;
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
    <button id="btn-auto" title="Auto-scroll to next reel when video ends">⟳ Auto Scroll</button>
    <button id="btn-close" title="Close Reels">✕</button>
  </div>
  <div id="wrap">
    <canvas id="c" tabindex="0" width="${reelsCdp_1.REMOTE_W}" height="${reelsCdp_1.REMOTE_H}"></canvas>
    <div id="loading"><div class="spin"></div><span id="st">Connecting…</span></div>
  </div>

  <script nonce="${nonce}">
  (function(){
    const api    = acquireVsCodeApi();
    const canvas = document.getElementById('c');
    const ctx    = canvas.getContext('2d', {alpha:false});
    const load   = document.getElementById('loading');
    const stEl   = document.getElementById('st');

    const RW = ${reelsCdp_1.REMOTE_W};
    const RH = ${reelsCdp_1.REMOTE_H};

    // Close button → tell host to tear down
    document.getElementById('btn-close').onclick = () =>
      api.postMessage({command:'closeReels'});

    // Auto-scroll toggle
    const btnAuto = document.getElementById('btn-auto');
    btnAuto.onclick = () => api.postMessage({command:'toggleAutoScroll'});

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

    // Control messages (status / die / autoScrollState)
    window.addEventListener('message', e => {
      if (e.data?.type==='status') { stEl.textContent=e.data.text; }
      if (e.data?.type==='die')    { alive=false; ws?.close(); }
      if (e.data?.type==='autoScrollState') {
        btnAuto.classList.toggle('on', !!e.data.on);
        btnAuto.textContent = e.data.on ? '⟳ Auto: ON' : '⟳ Auto Scroll';
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
async function refreshViewportHeight(cdp) {
    try {
        const result = await cdp.call('Runtime.evaluate', {
            expression: 'window.innerHeight',
            returnByValue: true,
        });
        const h = result['result']?.['value'];
        if (typeof h === 'number' && h > 100) {
            cachedViewportH = h;
        }
    }
    catch { /* keep previous cached value */ }
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
async function fireTouchSwipe(cdp, direction) {
    const cx = Math.round(reelsCdp_1.REMOTE_W / 2);
    // Start and end positions chosen to give maximum swipe distance while
    // staying well clear of the bottom nav (don't start inside the nav area).
    const startY = direction > 0
        ? Math.round(reelsCdp_1.REMOTE_H * 0.65) // swipe up:   start 65% down
        : Math.round(reelsCdp_1.REMOTE_H * 0.35); // swipe down: start 35% down
    const endY = direction > 0
        ? Math.round(reelsCdp_1.REMOTE_H * 0.12) // swipe up:   end near top
        : Math.round(reelsCdp_1.REMOTE_H * 0.88); // swipe down: end near bottom
    const STEPS = 6;
    const STEP_MS = 16; // ~60 fps — matches real hardware touch sampling rate
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
        await (0, reelsCdp_1.sleep)(STEP_MS);
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
    await (0, reelsCdp_1.sleep)(8);
    await cdp.call('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
    });
}
function fireAutoSnap(cdp) {
    void fireTouchSwipe(cdp, 1); // 1 = swipe up = advance to next reel
}
function startAutoScroll(cdp) {
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
    function scheduleNext(ms) {
        if (!autoScrollEnabled) {
            return;
        }
        autoScrollWatchId = setTimeout(() => { void poll(); }, ms);
    }
    async function poll() {
        // Guard 1: check before doing any work
        if (!autoScrollEnabled) {
            return;
        }
        let val = null;
        try {
            const res = await cdp.call('Runtime.evaluate', {
                expression: VIDEO_POLL_EXPR,
                returnByValue: true,
            });
            // Guard 2: check AFTER the await — stopAutoScroll() may have run
            // while we were waiting for CDP to respond.
            if (!autoScrollEnabled) {
                return;
            }
            val = res['result']?.['value'] ?? null;
        }
        catch {
            // Guard 3: check after catch — same race applies
            if (!autoScrollEnabled) {
                return;
            }
            scheduleNext(1000);
            return;
        }
        // ── No valid video yet (page loading, navigating) ─────────────────────
        if (!val || !isFinite(val.dur) || val.dur <= 0) {
            prevCur = -1; // reset tracking — new reel will be a fresh start
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
        prevCur = val.cur; // update for next poll
        const remaining = val.dur - val.cur;
        // ── Decide whether to snap ────────────────────────────────────────────
        // Conditions to snap:
        //   a) Video is within 0.6 s of its end, OR
        //   b) We detected a loop (video restarted)
        // AND we haven't already snapped this exact video.
        // AND video is not paused (user may have manually paused).
        const nearEnd = remaining <= 0.6;
        const shouldSnap = (nearEnd || looped) && key !== snappedKey && !val.paused;
        if (shouldSnap) {
            snappedKey = key; // mark as snapped — won't fire again for same video
            prevCur = -1; // reset so the incoming new video gets clean tracking
            fireAutoSnap(cdp);
            // Guard 4: check after firing snap (fireAutoSnap is void/fire-and-forget
            // but we still need to check before scheduling)
            if (!autoScrollEnabled) {
                return;
            }
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
        }
        else {
            // remaining ≤ 0.6 but already snapped this video (key === snappedKey).
            // The new reel hasn't appeared yet. Poll quickly until it does.
            scheduleNext(300);
        }
    }
    // First poll after 1.5 s — gives the page time to settle after opening.
    scheduleNext(1500);
}
function stopAutoScroll() {
    autoScrollEnabled = false;
    if (autoScrollTimer) {
        clearTimeout(autoScrollTimer);
        autoScrollTimer = undefined;
    }
    if (autoScrollWatchId) {
        clearTimeout(autoScrollWatchId);
        autoScrollWatchId = undefined;
    }
    updateAutoScrollButton(false);
}
function updateAutoScrollButton(on) {
    void sidebarView?.webview.postMessage({ type: 'autoScrollState', on });
}
// ═══════════════════════════════════════════════════════════════════════════
// Screencast → WsFrameServer
// ═══════════════════════════════════════════════════════════════════════════
function startScreencast(cdp, wsServer) {
    const params = {
        format: 'jpeg', quality: 72,
        maxWidth: reelsCdp_1.REMOTE_W, maxHeight: reelsCdp_1.REMOTE_H, everyNthFrame: 1,
    };
    void cdp.call('Page.startScreencast', params);
    cdp.on('Page.screencastFrame', (p) => {
        void cdp.call('Page.screencastFrameAck', { sessionId: p['sessionId'] });
        const b64 = p['data'];
        if (b64) {
            wsServer.broadcast(Buffer.from(b64, 'base64'));
        }
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Input forwarding — all fire-and-forget
// ═══════════════════════════════════════════════════════════════════════════
const BTN = { 0: 'left', 1: 'middle', 2: 'right' };
function forwardInput(cdp, msg) {
    const x = msg['x'] ?? 0;
    const y = msg['y'] ?? 0;
    const mod = msg['modifiers'] ?? 0;
    switch (msg['event']) {
        case 'mousedown':
            void cdp.call('Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, modifiers: mod,
                button: BTN[msg['button']] ?? 'left', clickCount: 1,
            });
            break;
        case 'mouseup':
            void cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, modifiers: mod,
                button: BTN[msg['button']] ?? 'left', clickCount: 1,
            });
            break;
        case 'mousemove':
            void cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseMoved', x, y, modifiers: mod, button: 'none',
            });
            break;
        case 'smoothscroll':
            // Forward raw delta as a native mouseWheel — Chrome scrolls smoothly
            void cdp.call('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x, y,
                deltaX: 0,
                deltaY: msg['deltaY'] ?? 0,
                modifiers: mod,
            });
            break;
        case 'wheel':
            void fireTouchSwipe(cdp, (msg['direction'] ?? 1));
            break;
        case 'keydown': {
            const key = msg['key'], code = msg['code'];
            if (key === 'ArrowDown' || key === 'ArrowUp') {
                void fireTouchSwipe(cdp, key === 'ArrowDown' ? 1 : -1);
                break;
            }
            const vk = VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
            void cdp.call('Input.dispatchKeyEvent', {
                type: 'rawKeyDown', key, code, modifiers: mod,
                windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
            });
            break;
        }
        case 'char': {
            const text = msg['text'];
            void cdp.call('Input.dispatchKeyEvent', {
                type: 'char', key: text, text, unmodifiedText: text,
                modifiers: mod, windowsVirtualKeyCode: text.toUpperCase().charCodeAt(0),
            });
            break;
        }
        case 'keyup': {
            const key = msg['key'], code = msg['code'];
            if (key === 'ArrowDown' || key === 'ArrowUp') {
                break;
            }
            const vk = VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
            void cdp.call('Input.dispatchKeyEvent', {
                type: 'keyUp', key, code, modifiers: mod,
                windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
            });
            break;
        }
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// Open / close — both operate directly on sidebarView
// ═══════════════════════════════════════════════════════════════════════════
async function openReels(context) {
    if (activeSession) {
        return;
    } // already running
    if (!(0, reelsCdp_1.findChromePath)()) {
        void vscode.window.showErrorMessage('Instagram Reels: Chrome or Edge not found. Install Google Chrome and try again.');
        return;
    }
    const wsPort = await (0, reelsCdp_1.getFreePort)();
    activeWsServer = new reelsCdp_1.WsFrameServer(wsPort);
    const nonce = crypto.randomBytes(16).toString('hex');
    // Switch sidebar to player HTML immediately (shows spinner while Chrome loads)
    if (sidebarView) {
        sidebarView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };
        sidebarView.webview.html = getPlayerHtml(nonce, wsPort);
        // Wire input + close from the player HTML
        sidebarView.webview.onDidReceiveMessage((msg) => {
            const cmd = msg['command'];
            if (cmd === 'closeReels') {
                closeReels();
                return;
            }
            if (cmd === 'toggleAutoScroll') {
                if (autoScrollEnabled) {
                    stopAutoScroll();
                }
                else if (activeSession) {
                    startAutoScroll(activeSession.cdp);
                }
                return;
            }
            if (msg['type'] === 'input' && activeSession) {
                forwardInput(activeSession.cdp, msg);
            }
        }, undefined, context.subscriptions);
    }
    const setStatus = (t) => void sidebarView?.webview.postMessage({ type: 'status', text: t });
    setStatus('Launching Chrome…');
    try {
        activeSession = await (0, reelsCdp_1.launchReelsWithCdp)();
        setStatus('Starting stream…');
        // Read the real window.innerHeight from Chrome now and on every navigation.
        // This is the correct snap distance — accounts for Instagram's own nav bars.
        void refreshViewportHeight(activeSession.cdp);
        activeSession.cdp.on('Page.loadEventFired', () => {
            void refreshViewportHeight(activeSession.cdp);
        });
        activeSession.cdp.on('Page.navigatedWithinDocument', () => {
            void refreshViewportHeight(activeSession.cdp);
        });
        startScreencast(activeSession.cdp, activeWsServer);
        activeSession.cdp.on('_disconnect', () => {
            void vscode.window.showWarningMessage('Reels: Chrome disconnected.');
            closeReels();
        });
    }
    catch (err) {
        void vscode.window.showErrorMessage('Instagram Reels: ' + (err instanceof Error ? err.message : String(err)));
        closeReels();
    }
}
function closeReels() {
    stopAutoScroll();
    void sidebarView?.webview.postMessage({ type: 'die' });
    activeWsServer?.close();
    activeWsServer = undefined;
    activeSession?.kill();
    activeSession = undefined;
    cachedViewportH = reelsCdp_1.REMOTE_H; // reset for next session
    // Revert sidebar to the idle button view
    if (sidebarView) {
        sidebarView.webview.html = getIdleHtml();
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// Sidebar provider
// ═══════════════════════════════════════════════════════════════════════════
class ReelsViewProvider {
    constructor(_ctx) {
        this._ctx = _ctx;
    }
    resolveWebviewView(view, _context, _token) {
        sidebarView = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = getIdleHtml();
        // Handle messages from the IDLE view (Open button)
        view.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'openReels':
                    await openReels(this._ctx);
                    break;
                case 'closeReels':
                    closeReels();
                    break;
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
function activate(context) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('vsInstaReels.sidebar', new ReelsViewProvider(context), { webviewOptions: { retainContextWhenHidden: true } }));
    const open = () => openReels(context);
    context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.open', open));
    context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.openInVSCode', open));
    context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.openInBrowser', () => void vscode.env.openExternal(vscode.Uri.parse(reelsCdp_1.REELS_URL))));
    context.subscriptions.push(vscode.commands.registerCommand('vsInstaReels.launchWithDrm', () => {
        const r = (0, widevineLauncher_1.launchWithWidevine)();
        if (r.ok) {
            void vscode.window.showInformationMessage(r.message);
        }
        else {
            void vscode.window.showErrorMessage('Reels DRM: ' + r.message);
        }
    }));
}
function deactivate() { closeReels(); }
//# sourceMappingURL=extension.js.map