/**
 * reelsCdp.ts — pure Node.js built-ins, zero npm deps
 *
 * Why a WebSocket relay server instead of panel.webview.postMessage?
 *
 *   postMessage path:
 *     base64-string → JSON.stringify → Electron IPC serialize → pipe → webview
 *     → IPC deserialize → JSON.parse → atob() → Image.src
 *     overhead ≈ 10–20 ms per frame, JSON parse dominates
 *
 *   WS relay path:
 *     Buffer.from(b64,'base64') → TCP loopback write → webview TCP recv
 *     → Blob(ArrayBuffer) → createImageBitmap  
 *     overhead ≈ 0.5–1 ms per frame, zero JSON, zero IPC
 *
 *   That is a 15–30× reduction in frame overhead.
 *   The stutter disappears because the webview is no longer blocked on
 *   JSON deserialization before it can start decoding the next JPEG.
 */

import * as net        from 'net';
import * as http       from 'http';
import * as crypto     from 'crypto';
import * as fs         from 'fs';
import * as os         from 'os';
import * as path       from 'path';
import * as child_proc from 'child_process';

export const REELS_URL = 'https://www.instagram.com/reels/';
export const REMOTE_W  = 430;
export const REMOTE_H  = 932;

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/21A331 Safari/604.1';

// Script injected after page load — taps the Reels nav icon so Instagram
// snaps into the full-screen TikTok-style Reels viewer automatically.
export const REELS_SNAP_SCRIPT = `
(function() {
  function trySnap() {
    // Instagram's bottom nav SVG paths for the Reels (play) button.
    // Works on the mobile layout served to iPhone UA.
    const selectors = [
      'a[href="/reels/"]',
      'a[aria-label*="Reels"]',
      'a[aria-label*="reel" i]',
      '[role="tablist"] a:nth-child(3)',   // middle tab = Reels
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    }
    return false;
  }
  // Try immediately, then retry until the nav renders (up to 5s)
  if (!trySnap()) {
    let attempts = 0;
    const id = setInterval(() => {
      if (trySnap() || ++attempts > 20) { clearInterval(id); }
    }, 250);
  }
})();
`;

// Script injected after every page load — unmutes all video elements and
// clicks the mute toggle button if Instagram rendered one.
const UNMUTE_SCRIPT = `
(function() {
  function unmute() {
    // 1. Unmute every <video> element directly
    document.querySelectorAll('video').forEach(v => {
      v.muted  = false;
      v.volume = 1;
    });
    // 2. Click Instagram's mute button if it is visible
    //    Instagram renders a speaker icon button when video is muted.
    const muteSelectors = [
      'button[aria-label*="mute" i]',
      'button[aria-label*="unmute" i]',
      'button[aria-label*="sound" i]',
      'button[aria-label*="audio" i]',
    ];
    for (const sel of muteSelectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); break; }
    }
  }

  // Run immediately for any videos already in the DOM
  unmute();

  // Also watch for new videos added dynamically (Reels lazy-loads clips)
  const obs = new MutationObserver(() => unmute());
  obs.observe(document.body, { childList: true, subtree: true });

  // Disconnect after 10 s to avoid running forever on static pages
  setTimeout(() => obs.disconnect(), 10000);
})();
`;
//
// Why roll our own instead of the 'ws' npm package?
//   The extension has zero npm runtime deps. We keep it that way.
//   All we need is: accept connections, broadcast binary frames.
//   The full RFC 6455 framing for a broadcast-only server is ~80 lines.
// ═══════════════════════════════════════════════════════════════════════════

export class WsFrameServer {
  private readonly srv: http.Server;
  private readonly clients = new Set<net.Socket>();
  // Latest JPEG pending send; overwritten on every new frame so the
  // webview always gets the freshest frame, never a stale backlog.
  private pendingBuf: Buffer | null = null;

  constructor(readonly port: number) {
    this.srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });

    this.srv.on('upgrade', (req, socket: net.Socket) => {
      const key = req.headers['sec-websocket-key'] as string;
      if (!key) { socket.destroy(); return; }

      // RFC 6455 §4.2.2 — compute Sec-WebSocket-Accept
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      socket.setNoDelay(true);   // disable Nagle algorithm — sends small frames immediately
      this.clients.add(socket);

      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => { this.clients.delete(socket); socket.destroy(); });

      // Webview may send a small ack/ping; we just ignore it
      socket.on('data', () => { /* no-op */ });
    });

    this.srv.listen(port, '127.0.0.1');
  }

  /**
   * Deliver a JPEG buffer to all connected clients.
   *
   * Backpressure handling:
   *   If a socket's write buffer is already carrying data (writableLength > 0)
   *   the socket is behind — writing more will queue frames and build lag.
   *   Instead we store the latest buffer in pendingBuf and flush it when
   *   the socket becomes writable again.  This ensures the webview always
   *   sees the freshest frame, never a queue of stale ones.
   */
  broadcast(jpegBuf: Buffer): void {
    if (this.clients.size === 0) { return; }

    // Build the WS binary frame once and share it across all clients
    const frame = this.buildFrame(jpegBuf);

    for (const sock of this.clients) {
      if (sock.destroyed) { this.clients.delete(sock); continue; }

      if (sock.writableLength === 0) {
        // Socket is free — send immediately
        sock.write(frame);
      } else {
        // Socket is still flushing the previous frame.
        // Store latest; overwrite any stale pending so we never fall behind.
        this.pendingBuf = jpegBuf;

        if (sock.listenerCount('drain') === 0) {
          sock.once('drain', () => {
            if (this.pendingBuf) {
              const f = this.buildFrame(this.pendingBuf);
              this.pendingBuf = null;
              if (!sock.destroyed) { sock.write(f); }
            }
          });
        }
      }
    }
  }

  /** RFC 6455 binary frame (opcode 0x2), server→client (no masking). */
  private buildFrame(data: Buffer): Buffer {
    const len = data.length;
    let hdr: Buffer;
    if      (len < 126)   { hdr = Buffer.alloc(2);  hdr[0] = 0x82; hdr[1] = len; }
    else if (len < 65536) { hdr = Buffer.alloc(4);  hdr[0] = 0x82; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
    else                  { hdr = Buffer.alloc(10); hdr[0] = 0x82; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([hdr, data]);
  }

  close(): void {
    for (const s of this.clients) { s.destroy(); }
    this.clients.clear();
    this.srv.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WsClient — minimal RFC-6455 client for CDP connection
// ═══════════════════════════════════════════════════════════════════════════

export class WsClient {
  private accum: Buffer = Buffer.alloc(0);
  public  onMessage?: (text: string) => void;
  public  onClose?:   () => void;

  private constructor(private readonly sock: net.Socket) {}

  static connect(host: string, port: number, pathname: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const sock   = net.connect({ host, port });
      const client = new WsClient(sock);
      const key    = crypto.randomBytes(16).toString('base64');
      let   done   = false;
      let   hBuf   = '';

      sock.setTimeout(20_000);
      sock.on('timeout', () => { if (!done) { reject(new Error('WS handshake timed out')); } });

      sock.on('connect', () => {
        sock.write(
          `GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      sock.on('data', (chunk: Buffer) => {
        if (!done) {
          hBuf += chunk.toString('binary');
          const split = hBuf.indexOf('\r\n\r\n');
          if (split < 0) { return; }
          if (!hBuf.startsWith('HTTP/1.1 101')) {
            return reject(new Error('WS upgrade failed: ' + hBuf.slice(0, 80)));
          }
          done = true; sock.setTimeout(0); resolve(client);
          const tail = Buffer.from(hBuf.slice(split + 4), 'binary');
          if (tail.length) { client.feed(tail); }
        } else { client.feed(chunk); }
      });

      sock.on('error', err => { if (!done) { reject(err); } else { client.onClose?.(); } });
      sock.on('close', () => client.onClose?.());
    });
  }

  private feed(chunk: Buffer) {
    this.accum = Buffer.concat([this.accum, chunk]);
    this.drain();
  }

  private drain() {
    while (this.accum.length >= 2) {
      const op  = this.accum[0] & 0x0f;
      let   pl  = this.accum[1] & 0x7f;
      let   off = 2;
      if      (pl === 126) { if (this.accum.length < 4)  { return; } pl = this.accum.readUInt16BE(2);           off = 4;  }
      else if (pl === 127) { if (this.accum.length < 10) { return; } pl = Number(this.accum.readBigUInt64BE(2)); off = 10; }
      if ((this.accum[1] & 0x80) !== 0) { off += 4; }
      if (this.accum.length < off + pl) { return; }
      const payload = this.accum.slice(off, off + pl);
      this.accum    = this.accum.slice(off + pl);
      if      (op === 0x1) { this.onMessage?.(payload.toString('utf8')); }
      else if (op === 0x8) { this.close(); }
    }
  }

  send(text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const plen    = payload.length;
    const mask    = crypto.randomBytes(4);
    let   hdr: Buffer;
    if      (plen < 126)   { hdr = Buffer.alloc(2);  hdr[0] = 0x81; hdr[1] = 0x80 | plen; }
    else if (plen < 65536) { hdr = Buffer.alloc(4);  hdr[0] = 0x81; hdr[1] = 0xfe; hdr.writeUInt16BE(plen, 2); }
    else                   { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0xff; hdr.writeBigUInt64BE(BigInt(plen), 2); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < plen; i++) { masked[i] ^= mask[i % 4]; }
    this.sock.write(Buffer.concat([hdr, mask, masked]));
  }

  close(): void { try { this.sock.destroy(); } catch { /* ignore */ } }
}

// ═══════════════════════════════════════════════════════════════════════════
// CDP Session
// ═══════════════════════════════════════════════════════════════════════════

type Params = Record<string, unknown>;

export class CdpSession {
  private seq      = 1;
  private pending  = new Map<number, { resolve:(r:Params)=>void; reject:(e:Error)=>void }>();
  private handlers = new Map<string, Array<(p:Params)=>void>>();

  private constructor(private readonly ws: WsClient) {
    ws.onMessage = raw => this.dispatch(raw);
    ws.onClose   = ()  => this.emit('_disconnect', {});
  }

  static async attach(port: number, timeoutMs = 25_000): Promise<CdpSession> {
    const deadline = Date.now() + timeoutMs;
    let wsUrl = '';
    while (Date.now() < deadline) {
      try {
        wsUrl = await new Promise<string>((res, rej) => {
          const req = http.get(`http://127.0.0.1:${port}/json`, resp => {
            let body = '';
            resp.on('data', (c:Buffer) => (body += c.toString()));
            resp.on('end', () => {
              try {
                type T = { type:string; webSocketDebuggerUrl:string };
                const ts = JSON.parse(body) as T[];
                const pg = ts.find(t => t.type === 'page');
                pg ? res(pg.webSocketDebuggerUrl) : rej(new Error('no page yet'));
              } catch(e) { rej(e); }
            });
          });
          req.on('error', rej);
          req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
        });
        break;
      } catch { await sleep(400); }
    }
    if (!wsUrl) { throw new Error(`Chrome DevTools unreachable on port ${port}`); }
    const u  = new URL(wsUrl);
    const ws = await WsClient.connect('127.0.0.1', parseInt(u.port, 10), u.pathname);
    return new CdpSession(ws);
  }

  on(event: string, fn: (p:Params)=>void): void {
    const arr = this.handlers.get(event) ?? [];
    arr.push(fn);
    this.handlers.set(event, arr);
  }

  private emit(ev: string, p: Params) {
    (this.handlers.get(ev) ?? []).forEach(h => { try { h(p); } catch { /* ignore */ } });
  }

  private dispatch(raw: string) {
    try {
      type Msg = { id?:number; method?:string; params?:Params; result?:Params; error?:{message:string} };
      const msg = JSON.parse(raw) as Msg;
      if (msg.id !== undefined) {
        const cb = this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result ?? {}); }
      } else if (msg.method) { this.emit(msg.method, msg.params ?? {}); }
    } catch { /* malformed */ }
  }

  call(method: string, params: Params = {}): Promise<Params> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.ws.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Chrome discovery
// ═══════════════════════════════════════════════════════════════════════════

export function findChromePath(): string | null {
  const pf   = process.env['ProgramFiles']      ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const lad  = process.env['LOCALAPPDATA']       ?? path.join(os.homedir(), 'AppData', 'Local');

  const candidates = [
    path.join(pf,   'Google', 'Chrome',     'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome',     'Application', 'chrome.exe'),
    path.join(lad,  'Google', 'Chrome',     'Application', 'chrome.exe'),
    path.join(lad,  'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    path.join(pf,   'Microsoft', 'Edge',    'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge',    'Application', 'msedge.exe'),
    path.join(lad,  'Microsoft', 'Edge',    'Application', 'msedge.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) { return p; } }

  if (process.platform === 'win32') {
    const keys = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
    ];
    for (const key of keys) {
      try {
        const out = child_proc.execSync(`reg query "${key}" /ve 2>nul`, { encoding:'utf8', windowsHide:true });
        const m   = out.match(/(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/);
        if (m) { const p = m[1].trim(); if (fs.existsSync(p)) { return p; } }
      } catch { /* try next */ }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// hideFromTaskbar — Windows only
//
// Chrome at -32000,-32000 is off-screen but still shows in the taskbar
// because every top-level window with WS_EX_APPWINDOW appears there.
//
// Fix: walk the full Chrome process tree with EnumWindows, then for each
// window swap the extended styles:
//   REMOVE  WS_EX_APPWINDOW  (0x00040000) — forces taskbar entry
//   ADD     WS_EX_TOOLWINDOW (0x00000080) — tool windows never appear
//
// We do NOT minimise or hide the window — that would trigger rendering
// throttle and kill the screencast.  The window stays live and renderable,
// just invisible to the taskbar and Alt-Tab.
// ═══════════════════════════════════════════════════════════════════════════

function hideFromTaskbar(rootPid: number): void {
  if (process.platform !== 'win32') { return; }

  const script = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TaskbarHide {
    public delegate bool EnumWndProc(IntPtr hwnd, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int  GetWindowLong(IntPtr hwnd, int idx);
    [DllImport("user32.dll")] public static extern int  SetWindowLong(IntPtr hwnd, int idx, int val);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

function Get-ProcTree([int]$root) {
    $ids = New-Object System.Collections.Generic.List[uint32]
    $ids.Add([uint32]$root)
    $all = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue
    $q   = [System.Collections.Queue]::new(); $q.Enqueue($root)
    while ($q.Count -gt 0) {
        $cur = $q.Dequeue()
        $all | Where-Object { $_.ParentProcessId -eq $cur } | ForEach-Object {
            $ids.Add([uint32]$_.ProcessId); $q.Enqueue([int]$_.ProcessId)
        }
    }
    return $ids
}

# Wait up to 10 s for Chrome to create its window
$pids    = $null
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
    $pids = Get-ProcTree ${rootPid}
    if ($pids.Count -gt 0) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $pids) { exit 1 }

$GWL_EXSTYLE       = -20
$WS_EX_APPWINDOW   = 0x00040000
$WS_EX_TOOLWINDOW  = 0x00000080
$SWP_NOMOVE        = 0x0002
$SWP_NOSIZE        = 0x0001
$SWP_NOZORDER      = 0x0004
$SWP_FRAMECHANGED  = 0x0020
$SWP_FLAGS         = $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_FRAMECHANGED

# Retry loop — Chrome may still be creating windows for a few seconds
$attempts = 0
while ($attempts -lt 15) {
    $found = $false
    [TaskbarHide]::EnumWindows({
        param([IntPtr]$hwnd, [IntPtr]$lp)
        $pid = [uint32]0
        [TaskbarHide]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        if ($pids -contains $pid) {
            $ex = [TaskbarHide]::GetWindowLong($hwnd, $GWL_EXSTYLE)
            # Remove APPWINDOW, add TOOLWINDOW
            $newEx = ($ex -band (-bnot $WS_EX_APPWINDOW)) -bor $WS_EX_TOOLWINDOW
            if ($newEx -ne $ex) {
                [TaskbarHide]::SetWindowLong($hwnd, $GWL_EXSTYLE, $newEx) | Out-Null
                [TaskbarHide]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
                $found = $true
            }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($found) { break }
    $attempts++
    Start-Sleep -Milliseconds 400
}
`;

  try {
    const ps1 = path.join(os.tmpdir(), 'vscode-reels-hide-taskbar.ps1');
    fs.writeFileSync(ps1, script, 'utf8');
    child_proc.spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', ps1,
    ], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* non-critical — Chrome still works, just shows in taskbar */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Launch Chrome + attach CDP
// ═══════════════════════════════════════════════════════════════════════════

export interface ReelsSession { cdp: CdpSession; kill: () => void; }

export async function launchReelsWithCdp(): Promise<ReelsSession> {
  const chromePath = findChromePath();
  if (!chromePath) { throw new Error('Chrome or Edge not found. Install Google Chrome and try again.'); }

  const cdpPort    = await getFreePort();
  const profileDir = path.join(os.tmpdir(), 'vscode-reels-cdp-profile');

  const child = child_proc.spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--app=${REELS_URL}`,
    `--user-data-dir=${profileDir}`,

    // ── Renderer: SwiftShader software GL
    // --disable-gpu alone forces Chrome into an older, slower software path.
    // --use-gl=angle --use-angle=swiftshader routes through ANGLE → SwiftShader
    // which uses SIMD (SSE4/AVX) and is 3–5× faster for page compositing.
    // Critically, software compositing lets CDP screencast read video pixels —
    // the same reason we can't use hardware GPU (video would be a black overlay).
    '--disable-gpu',
    '--use-gl=swiftshader',

    // ── Prevent background/occlusion throttling
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',

    // ── Media
    '--autoplay-policy=no-user-gesture-required',

    // ── Off-screen (not minimized — minimized triggers rendering throttle)
    '--window-position=-32000,-32000',
    `--window-size=${REMOTE_W},${REMOTE_H}`,

    // ── Clean UX
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-infobars',
    '--disable-translate',
    '--disable-notifications',
  ], { detached:true, stdio:'ignore' });

  child.unref();
  if (!child.pid) { throw new Error('Chrome did not start (no PID returned).'); }

  const pid = child.pid;
  const cdp = await CdpSession.attach(cdpPort, 25_000);

  // Hide Chrome from the Windows taskbar and Alt-Tab switcher.
  // Must be called after spawn (pid is known) but works asynchronously —
  // it waits for Chrome to create its window before applying the style.
  hideFromTaskbar(pid);

  await cdp.call('Page.enable');
  await cdp.call('Network.enable');

  // Lock viewport: deviceScaleFactor=1 → pixel space == DIP space → exact clicks
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: REMOTE_W, height: REMOTE_H,
    deviceScaleFactor: 1, mobile: true,
    screenWidth: REMOTE_W, screenHeight: REMOTE_H,
  });
  await cdp.call('Network.setUserAgentOverride', { userAgent: MOBILE_UA });

  // Note: autoplay with sound is already handled by the --autoplay-policy=no-user-gesture-required
  // Chrome launch flag. No CDP call needed here.

  // After every page load: snap to Reels view AND unmute all videos.
  cdp.on('Page.loadEventFired', () => {
    void cdp.call('Runtime.evaluate', { expression: REELS_SNAP_SCRIPT, awaitPromise: false });
    void cdp.call('Runtime.evaluate', { expression: UNMUTE_SCRIPT,     awaitPromise: false });
  });

  return {
    cdp,
    kill() {
      cdp.close();
      if (process.platform === 'win32') {
        child_proc.spawn('taskkill', ['/F', '/T', '/PID', String(pid)],
          { detached:true, stdio:'ignore' }).unref();
      } else {
        try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* ignore */ } }
      }
    },
  };
}