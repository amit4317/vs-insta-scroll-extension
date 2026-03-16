"use strict";
/**
 * platforms.ts
 *
 * All platform-specific configuration in one place.
 * Adding a new platform = add one entry here, nothing else changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PLATFORM = exports.PLATFORMS = void 0;
// ── iPhone 14 Pro Max UA — used for Instagram and TikTok ────────────────────
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/21A331 Safari/604.1';
// ── Android UA — TikTok's mobile web is better on Android than iOS ──────────
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
// ── YouTube Shorts UA — Chrome on iPhone shows the Shorts UI correctly ───────
const YT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1';
// ═══════════════════════════════════════════════════════════════════════════
// Snap scripts — auto-navigate into the short-form feed on each platform
// ═══════════════════════════════════════════════════════════════════════════
const INSTAGRAM_SNAP = `
(function() {
  function trySnap() {
    const selectors = [
      'a[href="/reels/"]',
      'a[aria-label*="Reels"]',
      'a[aria-label*="reel" i]',
      '[role="tablist"] a:nth-child(3)',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    }
    return false;
  }
  if (!trySnap()) {
    let n = 0;
    const id = setInterval(() => {
      if (trySnap() || ++n > 20) { clearInterval(id); }
    }, 250);
  }
})();
`;
const TIKTOK_SNAP = `
(function() {
  // TikTok mobile web opens directly on the For You feed — no navigation needed.
  // Just make sure we're on the FYP and not a profile or search page.
  if (!location.pathname.startsWith('/foryou') && location.pathname === '/') {
    // Already on home — the feed loads automatically
    return;
  }
  // If landed on a non-feed page, navigate to FYP
  if (!location.pathname.startsWith('/foryou') && location.pathname !== '/') {
    const a = document.querySelector('a[href="/foryou"]') ||
              document.querySelector('[data-e2e="nav-home"]');
    if (a) { a.click(); }
  }
})();
`;
const YOUTUBE_SNAP = `
(function() {
  // YouTube Shorts — the URL already points to /shorts, just make sure
  // fullscreen mode is active by dismissing any overlay dialogs.
  function dismiss() {
    const btn = document.querySelector(
      'tp-yt-paper-dialog button, ytm-alert-with-button-renderer button'
    );
    if (btn) { btn.click(); }
  }
  dismiss();
  setTimeout(dismiss, 1000);
  setTimeout(dismiss, 2500);
})();
`;
// ═══════════════════════════════════════════════════════════════════════════
// Platform registry
// ═══════════════════════════════════════════════════════════════════════════
exports.PLATFORMS = {
    instagram: {
        id: 'instagram',
        label: 'Instagram Reels',
        url: 'https://www.instagram.com/reels/',
        profileDir: 'vscode-reels-instagram-profile',
        width: 430,
        height: 932,
        userAgent: IOS_UA,
        snapScript: INSTAGRAM_SNAP,
        unmuteDelay: 600,
    },
    tiktok: {
        id: 'tiktok',
        label: 'TikTok',
        url: 'https://www.tiktok.com/',
        profileDir: 'vscode-reels-tiktok-profile',
        width: 390,
        height: 844,
        userAgent: ANDROID_UA,
        snapScript: TIKTOK_SNAP,
        unmuteDelay: 800,
    },
    youtube: {
        id: 'youtube',
        label: 'YouTube Shorts',
        url: 'https://www.youtube.com/shorts/',
        profileDir: 'vscode-reels-youtube-profile',
        width: 390,
        height: 844,
        userAgent: YT_UA,
        snapScript: YOUTUBE_SNAP,
        unmuteDelay: 500,
    },
};
exports.DEFAULT_PLATFORM = 'instagram';
//# sourceMappingURL=platforms.js.map