import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';

const isWindows = process.platform === 'win32';

/** Try to get Chrome/Edge Application path from Windows Registry. */
function findChromePathFromRegistry(): string | null {
  if (!isWindows) return null;
  try {
    const { execSync } = child_process;
    const keys = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    ];
    for (const key of keys) {
      try {
        const out = execSync(`reg query "${key}" /ve 2>nul`, { encoding: 'utf8', windowsHide: true });
        const match = out.match(/(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/);
        if (match) {
          const exePath = match[1].trim();
          const dir = path.dirname(exePath);
          if (path.basename(dir) === 'Application') return dir;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Version folder pattern: 131.0.6778.85 or 120.0.6099.0 etc. */
const VERSION_FOLDER_REGEX = /^\d+\.\d+\.\d+\.\d+/;

function getWidevineFromWin64Path(win64: string, fallbackVersion?: string, tried: string[] = []): { cdmPath: string; version: string } | null {
  tried.push(`win64:${win64}`);
  const manifestPath = path.join(win64, 'manifest.json');
  const dllPath = path.join(win64, 'widevinecdm.dll');
  if (!fs.existsSync(win64) || !fs.existsSync(dllPath)) return null;

  let version: string | undefined;
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      version = manifest.version ?? manifest.manifest_version;
    } catch {
      // ignore parse errors, fallback below
    }
  }

  version = version ?? fallbackVersion ?? '1.0';
  return { cdmPath: win64, version: String(version) };
}

function findWidevineInBase(base: string, tried: string[] = []): { cdmPath: string; version: string } | null {
  tried.push(`base:${base}`);
  if (!fs.existsSync(base)) return null;

  // Sometimes the path passed in is already the version folder itself (or the Application folder).
  let candidate = path.join(base, 'WidevineCdm', '_platform_specific', 'win_x64');
  tried.push(`candidate:${candidate}`);
  let fromCandidate = getWidevineFromWin64Path(candidate, undefined, tried);
  if (fromCandidate) return fromCandidate;

  let versions: string[];
  try {
    versions = fs.readdirSync(base).filter((v) => VERSION_FOLDER_REGEX.test(v));
  } catch {
    return null;
  }

  versions.sort((a, b) => compareChromeVersions(b, a));
  for (const ver of versions) {
    const win64 = path.join(base, ver, 'WidevineCdm', '_platform_specific', 'win_x64');
    tried.push(`version:${win64}`);
    const result = getWidevineFromWin64Path(win64, ver, tried);
    if (result) return result;

    // Legacy or non-standard installs may have WidevineCdm installed directly in the version folder.
    const directWin64 = path.join(base, ver, '_platform_specific', 'win_x64');
    tried.push(`version-direct:${directWin64}`);
    const directResult = getWidevineFromWin64Path(directWin64, ver, tried);
    if (directResult) return directResult;
  }

  return null;
}

/**
 * Check Chrome User Data folder for WidevineCDM (component updater installs it there on some setups).
 * userDataPath e.g. C:\Users\AK\AppData\Local\Google\Chrome\User Data
 */
function findWidevineInUserData(userDataPath: string, tried: string[] = []): { cdmPath: string; version: string } | null {
  tried.push(`userData:${userDataPath}`);
  if (!fs.existsSync(userDataPath)) return null;
  const widevineFolderNames = ['WidevineCDM', 'Widevine Cdm', 'WidevineCdm'];
  for (const folderName of widevineFolderNames) {
    const win64 = path.join(userDataPath, folderName, '_platform_specific', 'win_x64');
    if (!fs.existsSync(win64)) continue;
    const manifestPath = path.join(win64, 'manifest.json');
    const dllPath = path.join(win64, 'widevinecdm.dll');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(dllPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const version = manifest.version ?? manifest.manifest_version ?? '1.0';
      return { cdmPath: win64, version: String(version) };
    } catch {
      continue;
    }
  }
  try {
    const entries = fs.readdirSync(userDataPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const win64 = path.join(userDataPath, e.name, '_platform_specific', 'win_x64');
      if (!fs.existsSync(path.join(win64, 'widevinecdm.dll'))) continue;
      const manifestPath = path.join(win64, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const version = manifest.version ?? manifest.manifest_version ?? '1.0';
        return { cdmPath: win64, version: String(version) };
      } catch {
        continue;
      }
    }
  } catch {
    // ignore readdir errors
  }
  return null;
}

/**
 * Find Chrome's or Edge's Widevine CDM directory and version (for Electron --widevine-cdm-path).
 * Returns { cdmPath, version } or null if not found.
 */
export function findChromeWidevine(tried: string[] = []): { cdmPath: string; version: string } | null {
  if (isWindows) {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

    const chromeBases = [
      path.join(programFiles, 'Google', 'Chrome', 'Application'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application'),
      path.join(localAppData, 'Google', 'Chrome', 'Application'),
      path.join(programFiles, 'Google', 'Chrome SxS', 'Application'),
      path.join(programFilesX86, 'Google', 'Chrome SxS', 'Application'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application'),
      path.join(programFiles, 'Microsoft', 'Edge SxS', 'Application'),
      path.join(programFilesX86, 'Microsoft', 'Edge SxS', 'Application'),
    ];

    for (const base of chromeBases) {
      const result = findWidevineInBase(base, tried);
      if (result) return result;
    }

    const fromReg = findChromePathFromRegistry();
    if (fromReg) {
      tried.push(`registry:${fromReg}`);
      const result = findWidevineInBase(fromReg, tried);
      if (result) return result;
    }

    const userDataLocations = [
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
    ];

    for (const userDataPath of userDataLocations) {
      const userDataResult = findWidevineInUserData(userDataPath, tried);
      if (userDataResult) return userDataResult;
    }

    return null;
  }

  if (process.platform === 'darwin') {
    const chromeApp = '/Applications/Google Chrome.app';
    const frameworkPath = path.join(chromeApp, 'Contents', 'Versions');
    if (!fs.existsSync(frameworkPath)) return null;
    const versions = fs.readdirSync(frameworkPath).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v));
    versions.sort((a, b) => compareChromeVersions(b, a));
    for (const ver of versions) {
      const mac64 = path.join(
        frameworkPath,
        ver,
        'Google Chrome Framework.framework',
        'Versions',
        'A',
        'Libraries',
        'WidevineCdm',
        '_platform_specific',
        'mac_x64'
      );
      if (!fs.existsSync(mac64)) continue;
      const manifestPath = path.join(mac64, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const version = manifest.version || manifest.manifest_version || ver;
        if (fs.existsSync(path.join(mac64, 'libwidevinecdm.dylib'))) {
          return { cdmPath: mac64, version: String(version) };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  return null;
}

function compareChromeVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Launch a new VS Code / Cursor window with Widevine CDM flags so DRM video (e.g. Instagram) can play in Simple Browser.
 * Uses the same executable as the current process (process.execPath).
 */
export function launchWithWidevine(): { ok: boolean; message: string } {
  const tried: string[] = [];
  const widevine = findChromeWidevine(tried);
  if (!widevine) {
    const tries = tried.length > 0 ? '\nTried paths:\n' + tried.join('\n') : '';
    return {
      ok: false,
      message: "Widevine CDM not found. Install Google Chrome or Microsoft Edge, open it once so Widevine can install, then try again." + tries,
    };
  }

  const exe = process.execPath;
  const widevineUserData = path.join(os.tmpdir(), 'vscode-reels-widevine-profile');
  const args = [
    '--widevine-cdm-path=' + widevine.cdmPath,
    '--widevine-cdm-version=' + widevine.version,
    '--enable-widevine-cdm',
    '--enable-encrypted-media',
    '--enable-features=WidevineCdm',
    '--disable-features=RendererCodeIntegrity,AudioServiceOutOfProcess',
    '--disable-gpu-sandbox',
    '--force-device-scale-factor=1',
    '--disable-extensions',
    '--user-data-dir=' + widevineUserData,
    '--new-window',
    '--command',
    'vsInstaReels.open',
  ];

  try {
    child_process.spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
    });
    return {
      ok: true,
      message: 'A new DRM-enabled window is starting and should open Reels automatically. If the video still does not play, close all editor windows and run "Launch with DRM support" again.',
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Failed to launch.',
    };
  }
}
