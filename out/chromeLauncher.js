"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findChromePath = findChromePath;
exports.launchReelsOverlay = launchReelsOverlay;
exports.closeReelsOverlay = closeReelsOverlay;
const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");
const REELS_URL = 'https://www.instagram.com/reels/';
// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------
function findChromePath() {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    const candidates = [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(lad, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p))
            return p;
    }
    try {
        const regKeys = [
            'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
            'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
        ];
        for (const key of regKeys) {
            try {
                const out = child_process.execSync(`reg query "${key}" /ve 2>nul`, {
                    encoding: 'utf8', windowsHide: true,
                });
                const match = out.match(/(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/);
                if (match) {
                    const exePath = match[1].trim();
                    if (fs.existsSync(exePath))
                        return exePath;
                }
            }
            catch {
                continue;
            }
        }
    }
    catch { /* ignore */ }
    return null;
}
// ---------------------------------------------------------------------------
// PowerShell: overlay Chrome on VS Code's editor area
//
// Strategy:
//  1. Get VS Code's window rect precisely via GetWindowRect (WinAPI).
//  2. Estimate the editor area by subtracting VS Code chrome:
//       - Activity bar (left):  48 px
//       - Title bar (top):      30 px  (standard Windows non-client area)
//       - Tab bar (top):        35 px  (VS Code's own editor tab row)
//       - Status bar (bottom):  22 px
//  3. Launch Chrome with --app (no toolbar), position it over that rect.
//  4. After Chrome window appears, strip its remaining window decorations
//     (WS_CAPTION, WS_THICKFRAME) via SetWindowLong so it is truly borderless.
//  5. Pin it HWND_TOPMOST — it never goes "background", video never throttles.
// ---------------------------------------------------------------------------
function buildOverlayScript(chromePid, vsPid) {
    return `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Overlay {
    public delegate bool EnumWndProc(IntPtr hwnd, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern int  GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern int  SetWindowLong(IntPtr h, int idx, int val);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static List<IntPtr> WindowsForPids(HashSet<uint> pids) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, lp) => {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pids.Contains(pid) && IsWindowVisible(hwnd) && GetWindowTextLength(hwnd) > 0)
                found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$rootPid = ${chromePid}
$vsPid   = ${vsPid}

# ── Collect Chrome process tree ───────────────────────────────────────────────
function Get-ProcessTree([int]$parentId) {
    $ids  = New-Object System.Collections.Generic.List[int]
    $ids.Add($parentId)
    $all  = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue
    $q    = [System.Collections.Queue]::new()
    $q.Enqueue($parentId)
    while ($q.Count -gt 0) {
        $cur = $q.Dequeue()
        $all | Where-Object { $_.ParentProcessId -eq $cur } | ForEach-Object {
            $ids.Add([int]$_.ProcessId); $q.Enqueue([int]$_.ProcessId)
        }
    }
    return $ids
}

# ── Get VS Code window rect ───────────────────────────────────────────────────
$vsProc = Get-Process -Id $vsPid -ErrorAction SilentlyContinue
$vsHwnd = if ($vsProc) { $vsProc.MainWindowHandle } else { [IntPtr]::Zero }

$vsRect = New-Object Overlay+RECT
if ($vsHwnd -ne [IntPtr]::Zero) {
    [Overlay]::ShowWindow($vsHwnd, 9) | Out-Null   # SW_RESTORE
    [Overlay]::GetWindowRect($vsHwnd, [ref]$vsRect) | Out-Null
} else {
    $vsRect.L = 0; $vsRect.T = 0; $vsRect.R = 1280; $vsRect.B = 800
}

# ── Calculate editor area ────────────────────────────────────────────────────
# Subtract VS Code's own non-content chrome from the window rect.
# These pixel values match default VS Code with title bar visible.
$activityBar = 48   # left: activity bar icons
$tabBar      = 65   # top:  title bar (30) + editor tab row (35)
$statusBar   = 22   # bottom: status bar

$ex = $vsRect.L + $activityBar
$ey = $vsRect.T + $tabBar
$ew = ($vsRect.R - $vsRect.L) - $activityBar
$eh = ($vsRect.B - $vsRect.T) - $tabBar - $statusBar

# ── Wait up to 15 s for Chrome window ────────────────────────────────────────
$chromeHwnd = [IntPtr]::Zero
$deadline   = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and $chromeHwnd -eq [IntPtr]::Zero) {
    $treeIds = Get-ProcessTree $rootPid
    $pidSet  = [System.Collections.Generic.HashSet[uint]]::new()
    foreach ($id in $treeIds) { $pidSet.Add([uint]$id) | Out-Null }
    $wins    = [Overlay]::WindowsForPids($pidSet)
    if ($wins.Count -gt 0) { $chromeHwnd = $wins[0]; break }
    Start-Sleep -Milliseconds 300
}
if ($chromeHwnd -eq [IntPtr]::Zero) { exit 1 }

# ── Strip Chrome window decorations (title bar, resize border) ────────────────
# GWL_STYLE = -16
# WS_CAPTION     = 0x00C00000  (title bar + border)
# WS_THICKFRAME  = 0x00040000  (resizable border)
# WS_SYSMENU     = 0x00080000  (window menu)
$GWL_STYLE    = -16
$REMOVE_STYLE = 0x00C00000 -bor 0x00040000 -bor 0x00080000   # WS_CAPTION | WS_THICKFRAME | WS_SYSMENU
$style        = [Overlay]::GetWindowLong($chromeHwnd, $GWL_STYLE)
$newStyle     = $style -band (-bnot $REMOVE_STYLE)
[Overlay]::SetWindowLong($chromeHwnd, $GWL_STYLE, $newStyle) | Out-Null

# ── Position Chrome exactly over VS Code editor area, pin always-on-top ───────
# HWND_TOPMOST  = [IntPtr](-1)
# SWP_FRAMECHANGED = 0x0020  (apply the style change we made above)
# SWP_SHOWWINDOW   = 0x0040
[Overlay]::ShowWindow($chromeHwnd, 9) | Out-Null   # SW_RESTORE first
[Overlay]::SetWindowPos(
    $chromeHwnd,
    [IntPtr](-1),         # HWND_TOPMOST
    $ex, $ey, $ew, $eh,
    (0x0020 -bor 0x0040)  # SWP_FRAMECHANGED | SWP_SHOWWINDOW
) | Out-Null

[Overlay]::SetForegroundWindow($chromeHwnd) | Out-Null
`;
}
function launchReelsOverlay() {
    if (process.platform !== 'win32') {
        return { ok: false, message: 'Overlay mode is Windows-only.' };
    }
    const chromePath = findChromePath();
    if (!chromePath) {
        return {
            ok: false,
            message: 'Chrome or Edge not found. Install Google Chrome and try again.',
        };
    }
    // Dedicated profile so Chrome opens a fresh app window without hijacking
    // the user's normal Chrome session.
    const profileDir = path.join(os.tmpdir(), 'vscode-reels-overlay-profile');
    const chromeArgs = [
        `--app=${REELS_URL}`,
        `--user-data-dir=${profileDir}`,
        // ── Prevent ALL background throttling ────────────────────────────────────
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
        '--autoplay-policy=no-user-gesture-required',
        // ── Clean UI ──────────────────────────────────────────────────────────────
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-infobars',
        '--disable-translate',
        // Open at a small off-screen position first — the PS1 moves it into place
        // after stripping decorations. If we open maximised the decoration removal
        // fight with the maximise state.
        '--window-position=0,0',
        '--window-size=800,600',
    ];
    let chromePid;
    try {
        const child = child_process.spawn(chromePath, chromeArgs, {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        if (!child.pid) {
            return { ok: false, message: 'Failed to launch Chrome (no PID returned).' };
        }
        chromePid = child.pid;
    }
    catch (e) {
        return {
            ok: false,
            message: e instanceof Error ? e.message : 'Failed to launch Chrome.',
        };
    }
    const ps1Path = path.join(os.tmpdir(), 'vscode-reels-overlay.ps1');
    try {
        fs.writeFileSync(ps1Path, buildOverlayScript(chromePid, process.pid), 'utf8');
        child_process.spawn('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass',
            '-File', ps1Path,
        ], { detached: true, stdio: 'ignore' }).unref();
    }
    catch {
        return {
            ok: true,
            message: 'Reels opened in Chrome. (Overlay positioning failed — drag it over VS Code manually.)',
        };
    }
    return {
        ok: true,
        message: "Reels is loading — it will appear over VS Code's editor area.",
    };
}
/** Kill any existing Reels overlay Chrome instance */
function closeReelsOverlay() {
    if (process.platform !== 'win32')
        return;
    const profileDir = path.join(os.tmpdir(), 'vscode-reels-overlay-profile');
    // Kill Chrome processes using our dedicated profile
    try {
        child_process.execSync(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq Instagram*" 2>nul`, { windowsHide: true });
    }
    catch { /* ignore */ }
    // Also nuke any lingering lock files so next launch is clean
    const lockFile = path.join(profileDir, 'Default', 'lockfile');
    if (fs.existsSync(lockFile)) {
        try {
            fs.unlinkSync(lockFile);
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=chromeLauncher.js.map