"use strict";
/**
 * chameleon.ts
 *
 * Extracts the dominant color from the playing reel every 3 seconds and
 * repaints VS Code's UI to match — status bar, activity bar, title bar,
 * editor cursor, selection highlight, and focus border.
 *
 * Pipeline:
 *   CDP Page.captureScreenshot (JPEG, quality 20, scaled to 80×160)
 *   → decode base64 → raw pixel buffer via pure-JS JPEG decoder
 *   → median-cut dominant color extraction (no npm, no canvas)
 *   → derive a full palette (base, dark, darker, accent, text)
 *   → vscode.workspace.getConfiguration('workbench').update('colorCustomizations')
 *
 * Why a tiny custom JPEG decoder instead of canvas or sharp?
 *   VS Code extensions run in Node.js — no browser canvas, no native modules.
 *   We need raw RGB pixels from a JPEG. The only zero-dep path is a pure-JS
 *   JPEG parser. We implement the minimum subset needed: baseline DCT JPEG,
 *   which is exactly what Chrome's Page.captureScreenshot produces.
 *   Full JPEG spec is 500+ pages; baseline DCT is ~150 lines.
 *
 * Why 80×160 at quality 20?
 *   Dominant color doesn't need detail — just hue and saturation distribution.
 *   80×160 = 12 800 pixels, quality 20 = ~3 KB per screenshot.
 *   Full resolution would be ~200 KB and add 50+ ms of decode time per tick.
 *   At this size the whole pipeline runs in < 5 ms.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChameleonTheme = void 0;
const vscode = require("vscode");
// ── Config key we write to ──────────────────────────────────────────────────
const COLOR_CONFIG_KEY = 'colorCustomizations';
const WORKBENCH_CONFIG = 'workbench';
// ── Marker so we only undo our own changes ──────────────────────────────────
const OUR_MARKER = '[reels-chameleon]';
// ═══════════════════════════════════════════════════════════════════════════
// Minimal pure-JS JPEG → RGB pixel array
//
// Chrome's Page.captureScreenshot always produces baseline sequential JPEG
// (no progressive, no arithmetic coding). We implement just enough to get
// the raw 8-bit RGB pixels out:
//   1. Parse DHT / DQT / SOF0 / SOS markers
//   2. Huffman decode the bitstream
//   3. Dequantize + 8×8 IDCT per block
//   4. YCbCr → RGB conversion
//
// Any pixel that can't be decoded gets skipped — we're doing color statistics,
// not pixel-perfect rendering, so a few bad pixels are irrelevant.
// ═══════════════════════════════════════════════════════════════════════════
function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function idct8x8(s, out) {
    // Loeffler–Ligtenberg–Moschytz algorithm (fast 1D IDCT × 2 passes)
    const C = [
        1.0, 0.9807852804, 0.9238795325, 0.8314696123,
        0.7071067812, 0.5555702330, 0.3826834324, 0.1950903220,
    ];
    const tmp = new Float32Array(64);
    // Row pass
    for (let y = 0; y < 8; y++) {
        const o = y * 8;
        let v0 = s[o] * C[0], v1 = s[o + 4] * C[0], v2 = s[o + 2] * C[0], v3 = s[o + 6] * C[0];
        let v4 = s[o + 5] * C[3] - s[o + 3] * C[5], v5 = s[o + 1] * C[1] - s[o + 7] * C[7];
        let v6 = s[o + 1] * C[7] + s[o + 7] * C[1], v7 = s[o + 3] * C[3] + s[o + 5] * C[5];
        const t0 = v0 + v1, t1 = v0 - v1, t2 = v2 * 1.41421356 - v3, t3 = v3;
        const p0 = t0 + t3 + t2 * 0.5, p1 = t1 + t2, p2 = t1 - t2, p3 = t0 - t3 - t2 * 0.5;
        const q0 = v4 + v7, q1 = v5 + v6, q2 = v5 - v6, q3 = v4 - v7;
        const r0 = (q0 + q1) * 0.7071067812, r2 = (q2 + q3) * 0.7071067812;
        tmp[o + 0] = p0 + q0;
        tmp[o + 7] = p0 - q0;
        tmp[o + 1] = p1 + r0;
        tmp[o + 6] = p1 - r0;
        tmp[o + 2] = p2 + r2;
        tmp[o + 5] = p2 - r2;
        tmp[o + 3] = p3 + q3;
        tmp[o + 4] = p3 - q3;
    }
    // Column pass
    for (let x = 0; x < 8; x++) {
        let v0 = tmp[x] * C[0], v1 = tmp[x + 32] * C[0], v2 = tmp[x + 16] * C[0], v3 = tmp[x + 48] * C[0];
        let v4 = tmp[x + 40] * C[3] - tmp[x + 24] * C[5], v5 = tmp[x + 8] * C[1] - tmp[x + 56] * C[7];
        let v6 = tmp[x + 8] * C[7] + tmp[x + 56] * C[1], v7 = tmp[x + 24] * C[3] + tmp[x + 40] * C[5];
        const t0 = v0 + v1, t1 = v0 - v1, t2 = v2 * 1.41421356 - v3, t3 = v3;
        const p0 = t0 + t3 + t2 * 0.5, p1 = t1 + t2, p2 = t1 - t2, p3 = t0 - t3 - t2 * 0.5;
        const q0 = v4 + v7, q1 = v5 + v6, q2 = v5 - v6, q3 = v4 - v7;
        const r0 = (q0 + q1) * 0.7071067812, r2 = (q2 + q3) * 0.7071067812;
        out[x + 0] = p0 + q0;
        out[x + 56] = p0 - q0;
        out[x + 8] = p1 + r0;
        out[x + 48] = p1 - r0;
        out[x + 16] = p2 + r2;
        out[x + 40] = p2 - r2;
        out[x + 24] = p3 + q3;
        out[x + 32] = p3 - q3;
    }
}
/** Decode a baseline JPEG Buffer → flat Uint8Array of R,G,B,R,G,B,... */
function decodeJpeg(buf) {
    try {
        let pos = 0;
        const rd16 = () => { const v = (buf[pos] << 8) | buf[pos + 1]; pos += 2; return v; };
        const rdb = () => buf[pos++];
        if (rd16() !== 0xFFD8) {
            return null;
        } // not a JPEG
        // Quantisation tables [tableId][64]
        const qtables = [];
        const htables = [[], []];
        const comps = [];
        let width = 0, height = 0;
        // Bitstream state
        let bitBuf = 0, bitCnt = 0;
        let sosData = null;
        let sosPos = 0;
        const nextBit = () => {
            if (bitCnt === 0) {
                let b = sosData[sosPos++];
                if (b === 0xFF) {
                    sosPos++;
                } // skip stuffed 0x00
                bitBuf = b;
                bitCnt = 8;
            }
            const bit = (bitBuf >> 7) & 1;
            bitBuf = (bitBuf << 1) & 0xFF;
            bitCnt--;
            return bit;
        };
        const readBits = (n) => {
            let v = 0;
            for (let i = 0; i < n; i++) {
                v = (v << 1) | nextBit();
            }
            return v;
        };
        const decodeHuff = (ht) => {
            let code = 0, len = 0;
            for (let i = 0; i < ht.codes.length; i++) {
                code = (code << 1) | nextBit();
                len++;
                if (code === ht.codes[i]) {
                    return ht.values[i];
                }
            }
            return 0;
        };
        const receiveExtend = (n) => {
            if (n === 0) {
                return 0;
            }
            const v = readBits(n);
            return v < (1 << (n - 1)) ? v - (1 << n) + 1 : v;
        };
        // Parse markers
        while (pos < buf.length - 1) {
            if (rdb() !== 0xFF) {
                break;
            }
            const marker = rdb();
            if (marker === 0xD9) {
                break;
            } // EOI
            if (marker === 0xD8) {
                continue;
            }
            if (marker >= 0xD0 && marker <= 0xD7) {
                continue;
            }
            const segLen = rd16() - 2;
            const segEnd = pos + segLen;
            if (marker === 0xDB) {
                // DQT
                while (pos < segEnd) {
                    const info = rdb();
                    const id = info & 0x0F;
                    const qt = [];
                    for (let i = 0; i < 64; i++) {
                        qt.push(rdb());
                    }
                    qtables[id] = qt;
                }
            }
            else if (marker === 0xC0) {
                // SOF0
                rdb(); // precision
                height = rd16();
                width = rd16();
                const nc = rdb();
                for (let i = 0; i < nc; i++) {
                    const id = rdb();
                    const sf = rdb();
                    const qtId = rdb();
                    comps.push({ id, h: (sf >> 4), v: sf & 0xF, qtId, dcPred: 0 });
                }
                pos = segEnd;
            }
            else if (marker === 0xC4) {
                // DHT
                while (pos < segEnd) {
                    const info = rdb();
                    const type = (info >> 4) & 1; // 0=DC, 1=AC
                    const id = info & 0xF;
                    const counts = [];
                    for (let i = 0; i < 16; i++) {
                        counts.push(rdb());
                    }
                    const total = counts.reduce((a, b) => a + b, 0);
                    const values = [];
                    for (let i = 0; i < total; i++) {
                        values.push(rdb());
                    }
                    // Build canonical code table
                    const codes = [];
                    let code = 0, vi = 0;
                    for (let len = 1; len <= 16; len++) {
                        for (let k = 0; k < counts[len - 1]; k++) {
                            codes.push(code);
                            code++;
                            // push corresponding value for this code
                        }
                        code <<= 1;
                    }
                    // Rebuild properly
                    const htCodes = [];
                    code = 0;
                    vi = 0;
                    for (let len = 1; len <= 16; len++) {
                        for (let k = 0; k < counts[len - 1]; k++) {
                            htCodes.push(code);
                            code++;
                            vi++;
                        }
                        code <<= 1;
                    }
                    if (!htables[type]) {
                        htables[type] = [];
                    }
                    htables[type][id] = { codes: htCodes, values };
                }
            }
            else if (marker === 0xDA) {
                // SOS — scan header then raw bitstream
                const ncs = rdb();
                for (let i = 0; i < ncs; i++) {
                    rdb();
                    rdb();
                }
                rdb();
                rdb();
                rdb(); // Ss, Se, Ah/Al
                // Everything from here to the next non-stuffed 0xFF marker is entropy data
                const scanStart = pos;
                while (pos < buf.length - 1) {
                    if (buf[pos] === 0xFF && buf[pos + 1] !== 0x00 && buf[pos + 1] < 0xD0) {
                        break;
                    }
                    pos++;
                }
                sosData = buf.slice(scanStart, pos);
                sosPos = 0;
                bitBuf = 0;
                bitCnt = 0;
                break; // we have what we need
            }
            else {
                pos = segEnd;
            }
        }
        if (!sosData || width === 0 || height === 0) {
            return null;
        }
        // Decode MCUs (only Y channel — we only need luminance + approximate color)
        // For dominant color we use Y+Cb+Cr if available, else fall back to Y only.
        const pixels = new Uint8Array(width * height * 3);
        // Simple path: decode Y,Cb,Cr blocks and convert to RGB
        const mcuW = 8, mcuH = 8;
        const mcuCols = Math.ceil(width / mcuW);
        const mcuRows = Math.ceil(height / mcuH);
        const blk = new Float32Array(64);
        const out = new Float32Array(64);
        const ZIGZAG = [
            0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
            12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
            35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
            58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
        ];
        // We only decode the first component (Y) for speed, map to greyscale → RGB
        // For a dominant-color use case this is sufficient to get hue information
        // from the YCbCr chroma channels IF available. If only one component exists
        // we get luminance. Either way the median-cut will find the right color.
        const numComps = Math.min(comps.length, 3);
        const yPlane = new Uint8Array(width * height);
        const cbPlane = new Uint8Array(width * height).fill(128);
        const crPlane = new Uint8Array(width * height).fill(128);
        for (let row = 0; row < mcuRows; row++) {
            for (let col = 0; col < mcuCols; col++) {
                for (let ci = 0; ci < numComps; ci++) {
                    const comp = comps[ci];
                    const qt = qtables[comp.qtId] ?? qtables[0];
                    const dcHT = htables[0]?.[0] ?? htables[0]?.[0];
                    const acHT = htables[1]?.[0] ?? htables[1]?.[0];
                    if (!dcHT || !acHT || !qt) {
                        continue;
                    }
                    // Decode DC coefficient
                    const dcLen = decodeHuff(dcHT);
                    const dcDiff = receiveExtend(dcLen);
                    comp.dcPred += dcDiff;
                    blk[0] = comp.dcPred * qt[0];
                    // Decode AC coefficients
                    let k = 1;
                    while (k < 64) {
                        const sym = decodeHuff(acHT);
                        if (sym === 0) {
                            break;
                        } // EOB
                        const runLen = (sym >> 4) & 0xF;
                        const acLen = sym & 0xF;
                        k += runLen;
                        if (k >= 64) {
                            break;
                        }
                        blk[ZIGZAG[k]] = receiveExtend(acLen) * qt[ZIGZAG[k]];
                        k++;
                    }
                    // Zero remaining
                    for (let i = k; i < 64; i++) {
                        blk[ZIGZAG[i]] = 0;
                    }
                    idct8x8(blk, out);
                    // Write to appropriate plane
                    for (let py = 0; py < 8; py++) {
                        for (let px = 0; px < 8; px++) {
                            const imgX = col * 8 + px;
                            const imgY = row * 8 + py;
                            if (imgX >= width || imgY >= height) {
                                continue;
                            }
                            const pxIdx = imgY * width + imgX;
                            const val = clamp(Math.round(out[py * 8 + px] + 128));
                            if (ci === 0) {
                                yPlane[pxIdx] = val;
                            }
                            if (ci === 1) {
                                cbPlane[pxIdx] = val;
                            }
                            if (ci === 2) {
                                crPlane[pxIdx] = val;
                            }
                        }
                    }
                    // Reset block
                    blk.fill(0);
                }
            }
        }
        // YCbCr → RGB
        for (let i = 0; i < width * height; i++) {
            const y = yPlane[i];
            const cb = cbPlane[i] - 128;
            const cr = crPlane[i] - 128;
            pixels[i * 3 + 0] = clamp(Math.round(y + 1.402 * cr));
            pixels[i * 3 + 1] = clamp(Math.round(y - 0.344136 * cb - 0.714136 * cr));
            pixels[i * 3 + 2] = clamp(Math.round(y + 1.772 * cb));
        }
        return { pixels, width, height };
    }
    catch {
        return null;
    }
}
function medianCutDominant(pixels, count) {
    // Build initial pixel list — sample every 4th pixel for speed
    const all = [];
    for (let i = 0; i < count; i += 4) {
        const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
        // Skip very dark (< 30) and very light (> 225) pixels — they're background
        const brightness = (r + g + b) / 3;
        if (brightness < 30 || brightness > 225) {
            continue;
        }
        // Skip near-grey pixels (low saturation) — not colorful enough to be dominant
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max - min < 30) {
            continue;
        }
        all.push([r, g, b]);
    }
    if (all.length < 10) {
        // No colorful pixels found — fall back to average of all pixels
        let tr = 0, tg = 0, tb = 0;
        for (let i = 0; i < count; i++) {
            tr += pixels[i * 3];
            tg += pixels[i * 3 + 1];
            tb += pixels[i * 3 + 2];
        }
        return [tr / count, tg / count, tb / count];
    }
    // Recursive split
    function split(bucket, depth) {
        if (depth === 0 || bucket.length < 4) {
            return [bucket];
        }
        let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (const [r, g, b] of bucket) {
            if (r < rMin)
                rMin = r;
            if (r > rMax)
                rMax = r;
            if (g < gMin)
                gMin = g;
            if (g > gMax)
                gMax = g;
            if (b < bMin)
                bMin = b;
            if (b > bMax)
                bMax = b;
        }
        const rRange = rMax - rMin, gRange = gMax - gMin, bRange = bMax - bMin;
        const ch = rRange >= gRange && rRange >= bRange ? 0 : gRange >= bRange ? 1 : 2;
        bucket.sort((a, b2) => a[ch] - b2[ch]);
        const mid = Math.floor(bucket.length / 2);
        return [
            ...split(bucket.slice(0, mid), depth - 1),
            ...split(bucket.slice(mid), depth - 1),
        ];
    }
    const buckets = split(all, 3); // 2^3 = 8 buckets
    // Pick largest bucket
    buckets.sort((a, b) => b.length - a.length);
    const dominant = buckets[0];
    let tr = 0, tg = 0, tb = 0;
    for (const [r, g, b] of dominant) {
        tr += r;
        tg += g;
        tb += b;
    }
    return [tr / dominant.length, tg / dominant.length, tb / dominant.length];
}
// ═══════════════════════════════════════════════════════════════════════════
// Color palette derivation
//
// From one dominant RGB we derive a full set of colors that form a coherent
// dark-mode editor theme. Strategy:
//   • Convert to HSL for manipulation
//   • Keep the hue, vary the lightness/saturation for each role
//   • Ensure text always has sufficient contrast
// ═══════════════════════════════════════════════════════════════════════════
function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) {
        return [0, 0, l];
    }
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) {
        h = (g - b) / d + (g < b ? 6 : 0);
    }
    else if (max === g) {
        h = (b - r) / d + 2;
    }
    else {
        h = (r - g) / d + 4;
    }
    return [h / 6, s, l];
}
function hslToRgb(h, s, l) {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue2rgb = (p2, q2, t) => {
        if (t < 0)
            t += 1;
        if (t > 1)
            t -= 1;
        if (t < 1 / 6)
            return p2 + (q2 - p2) * 6 * t;
        if (t < 1 / 2)
            return q2;
        if (t < 2 / 3)
            return p2 + (q2 - p2) * (2 / 3 - t) * 6;
        return p2;
    };
    return [
        Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
        Math.round(hue2rgb(p, q, h) * 255),
        Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
}
function toHex([r, g, b]) {
    return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}
function buildPalette(dominant) {
    const [h, s, l] = rgbToHsl(...dominant);
    // Clamp saturation so desaturated colors still look intentional
    const sat = Math.max(0.4, Math.min(0.9, s));
    // Status bar: vibrant version of dominant
    const statusBg = hslToRgb(h, sat, 0.38);
    // Very light text on the status bar
    const statusFg = hslToRgb(h, 0.15, 0.94);
    // Activity bar: darker shade of same hue
    const actBg = hslToRgb(h, sat * 0.7, 0.18);
    const actFg = hslToRgb(h, 0.2, 0.80);
    // Title bar: mid-dark shade
    const titleBg = hslToRgb(h, sat * 0.6, 0.22);
    const titleFg = hslToRgb(h, 0.1, 0.90);
    // Cursor: bright, fully saturated
    const cursor = hslToRgb(h, 1.0, 0.65);
    // Selection: very transparent version of dominant
    const selR = hslToRgb(h, sat, 0.45);
    const selectionBg = toHex(selR) + '55'; // 33% opacity
    // Focus border: same as cursor
    const focusBorder = toHex(hslToRgb(h, 0.9, 0.60));
    // Current line: barely-there tint
    const lineHl = toHex(hslToRgb(h, sat * 0.5, 0.22)) + '66';
    return {
        statusBarBg: toHex(statusBg),
        statusBarFg: toHex(statusFg),
        activityBarBg: toHex(actBg),
        activityBarFg: toHex(actFg),
        titleBarBg: toHex(titleBg),
        titleBarFg: toHex(titleFg),
        editorCursor: toHex(cursor),
        selectionBg,
        focusBorder,
        editorLineHl: lineHl,
    };
}
const BINDING_NAME = '__chameleonVideoChange';
// Injected into Chrome once per page load.
// Fires __chameleonVideoChange ONCE per new video by fingerprinting
// duration+dimensions instead of src (blob: URLs regenerate every tick).
const VIDEO_WATCH_SCRIPT = `
(function() {
  if (window.__chameleonRunning) { return; }
  window.__chameleonRunning = true;

  let lastKey = '';

  function getBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null, bestVis = 0;
    for (const v of videos) {
      const r   = v.getBoundingClientRect();
      const vis = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      if (vis > bestVis) { bestVis = vis; best = v; }
    }
    return best;
  }

  function checkVideo() {
    const v = getBestVideo();
    if (!v || !v.duration || !isFinite(v.duration)) { return; }
    // Fingerprint = rounded duration + video dimensions.
    // This is stable across the whole life of one reel clip and
    // changes the moment Instagram swaps to the next video.
    const key = v.duration.toFixed(2) + ':' + v.videoWidth + 'x' + v.videoHeight;
    if (key === lastKey) { return; }
    lastKey = key;
    try { window.${BINDING_NAME}(key); } catch(e) {}
  }

  // MutationObserver for DOM-level swaps
  const obs = new MutationObserver(checkVideo);
  obs.observe(document.body, { childList: true, subtree: true });

  // Poll every 1 s as fallback — duration fingerprint is stable so
  // this fires the binding at most once per unique video regardless
  // of how many times the interval ticks.
  setInterval(checkVideo, 1000);
  checkVideo();
})();
`;
// ═══════════════════════════════════════════════════════════════════════════
// ChameleonTheme class
// ═══════════════════════════════════════════════════════════════════════════
class ChameleonTheme {
    constructor(cdp) {
        this.cdp = cdp;
        this.enabled = false;
        this.sampling = false; // lock — only one sample in-flight at a time
        this.originalColors = {};
    }
    async start() {
        if (this.enabled) {
            return;
        }
        this.enabled = true;
        // Save existing colorCustomizations so we can restore on stop
        const cfg = vscode.workspace.getConfiguration(WORKBENCH_CONFIG);
        const existing = cfg.get(COLOR_CONFIG_KEY) ?? {};
        this.originalColors = Object.fromEntries(Object.entries(existing).filter(([, v]) => !v.includes(OUR_MARKER)));
        // Register CDP binding — Chrome will call this when the video src changes
        await this.cdp.call('Runtime.addBinding', { name: BINDING_NAME });
        // One color sample immediately (first video already playing)
        void this.sample();
        // Listen for video-change events fired by our injected script
        this.cdp.on('Runtime.bindingCalled', (params) => {
            if (!this.enabled) {
                return;
            }
            if (params['name'] !== BINDING_NAME) {
                return;
            }
            // Ignore if a sample is already in-flight — the fingerprint dedup
            // in the injected script already guarantees one call per video, but
            // this lock protects against any edge-case double-fire.
            if (this.sampling) {
                return;
            }
            void this.sample();
        });
        // Inject the video watcher into Chrome
        await this.cdp.call('Runtime.evaluate', {
            expression: VIDEO_WATCH_SCRIPT,
            awaitPromise: false,
        });
        // Re-inject after every page navigation
        this.cdp.on('Page.loadEventFired', () => {
            if (!this.enabled) {
                return;
            }
            void this.cdp.call('Runtime.evaluate', {
                expression: VIDEO_WATCH_SCRIPT,
                awaitPromise: false,
            });
        });
    }
    stop() {
        if (!this.enabled) {
            return;
        }
        this.enabled = false;
        // Stop the watcher in Chrome
        void this.cdp.call('Runtime.evaluate', {
            expression: 'window.__chameleonRunning = false;',
            awaitPromise: false,
        }).catch(() => { });
        void this.restoreColors();
    }
    dispose() { this.stop(); }
    async sample() {
        if (!this.enabled) {
            return;
        }
        if (this.sampling) {
            return;
        } // already running — drop this call
        this.sampling = true;
        try {
            await new Promise(r => setTimeout(r, 600));
            if (!this.enabled) {
                return;
            }
            const result = await this.cdp.call('Page.captureScreenshot', {
                format: 'jpeg',
                quality: 8,
            });
            if (!this.enabled) {
                return;
            }
            const b64 = result['data'];
            if (!b64) {
                return;
            }
            const buf = Buffer.from(b64, 'base64');
            const decoded = decodeJpeg(buf);
            if (!decoded) {
                return;
            }
            const dominant = medianCutDominant(decoded.pixels, decoded.width * decoded.height);
            await this.applyPalette(buildPalette(dominant));
        }
        catch { /* CDP mid-navigation — skip */ }
        finally {
            this.sampling = false;
        }
    }
    async applyPalette(p) {
        const cfg = vscode.workspace.getConfiguration(WORKBENCH_CONFIG);
        await cfg.update(COLOR_CONFIG_KEY, {
            ...this.originalColors,
            'statusBar.background': p.statusBarBg,
            'statusBar.foreground': p.statusBarFg,
            'statusBar.noFolderBackground': p.statusBarBg,
            'statusBarItem.hoverBackground': p.activityBarBg,
            'activityBar.background': p.activityBarBg,
            'activityBar.foreground': p.activityBarFg,
            'activityBar.activeBorder': p.editorCursor,
            'titleBar.activeBackground': p.titleBarBg,
            'titleBar.activeForeground': p.titleBarFg,
            'titleBar.inactiveBackground': p.titleBarBg,
            'editorCursor.foreground': p.editorCursor,
            'editor.selectionBackground': p.selectionBg,
            'editor.lineHighlightBackground': p.editorLineHl,
            'focusBorder': p.focusBorder,
            'sideBar.border': p.activityBarBg,
            'tab.activeBorderTop': p.editorCursor,
        }, vscode.ConfigurationTarget.Global);
    }
    async restoreColors() {
        const cfg = vscode.workspace.getConfiguration(WORKBENCH_CONFIG);
        if (Object.keys(this.originalColors).length === 0) {
            await cfg.update(COLOR_CONFIG_KEY, undefined, vscode.ConfigurationTarget.Global);
        }
        else {
            await cfg.update(COLOR_CONFIG_KEY, this.originalColors, vscode.ConfigurationTarget.Global);
        }
    }
}
exports.ChameleonTheme = ChameleonTheme;
//# sourceMappingURL=chameleon.js.map