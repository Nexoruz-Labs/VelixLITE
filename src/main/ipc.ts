import { ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { getSettings, saveSettings, Settings } from './settings';
import { microsoftLogin, refreshMicrosoftAccount, Account } from './microsoftAuth';
import { fetchVersions, MinecraftVersion } from './versions';
import { launchMinecraft } from './launcher';
import { getAccounts, addAccount, removeAccount, StoredAccount } from './accounts';
import { resolveProfile } from './launchProfiles';
import { storeTokens, getTokens, deleteTokens, deleteAllTokens } from './secureStorage';

let savedResolution: { width: number; height: number } | null = null;

function getCurrentResolution(): { width: number; height: number } {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  return { width: primaryDisplay.size.width, height: primaryDisplay.size.height };
}

function runPowerShell(script: string): { stdout: string; stderr: string } {
  const psFile = path.join(os.tmpdir(), 'velix_res_' + Date.now() + '_' + Math.floor(Math.random() * 9999) + '.ps1');
  fs.writeFileSync(psFile, '\ufeff' + script, 'utf-8');
  try {
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile
    ], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      stdout: (result.stdout || '').toString().trim(),
      stderr: (result.stderr || '').toString().trim(),
    };
  } finally {
    try { if (fs.existsSync(psFile)) fs.unlinkSync(psFile); } catch {}
  }
}

function buildResScript(width: number, height: number, flags: number): string {
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
public struct DEVMODE {
    public const int DM_PELSWIDTH = 0x80000;
    public const int DM_PELSHEIGHT = 0x100000;
    
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
}

public class ResChanger {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int ChangeDisplaySettings(ref DEVMODE lpDevMode, int dwFlags);
    
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool EnumDisplaySettings(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode);
    
    public static int SetRes(int w, int h, int pFlags) {
        DEVMODE dm = new DEVMODE();
        dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        if (!EnumDisplaySettings(null, -1, ref dm))
          return -2;
        dm.dmPelsWidth = w;
        dm.dmPelsHeight = h;
        dm.dmFields = DEVMODE.DM_PELSWIDTH | DEVMODE.DM_PELSHEIGHT;
        int result = ChangeDisplaySettings(ref dm, pFlags);
        System.Console.Error.WriteLine("ChangeDisplaySettings(flags=" + pFlags + ") returned: " + result);
        return result;
    }
}
"@
$r = [ResChanger]::SetRes(${width}, ${height}, ${flags})
Write-Output $r
`;
}

function changeDisplayResolution(width: number, height: number, testOnly: boolean): { ok: boolean; code: number } {
  const tryFlags = testOnly ? [2] : [0, 4, 1];

  for (const flags of tryFlags) {
    try {
      const { stdout } = runPowerShell(buildResScript(width, height, flags));
      const code = parseInt(stdout);
      if (code === 0) return { ok: true, code: 0 };
    } catch {}
  }
  return { ok: false, code: -999 };
}

function sendStatus(window: BrowserWindow, status: string): void {
  window.webContents.send('velix:status', status);
}

function sendProgress(window: BrowserWindow, progress: number): void {
  window.webContents.send('velix:progress', progress);
}

function sendLaunchLog(window: BrowserWindow, log: string): void {
  window.webContents.send('velix:launchLog', log);
}

function sendDone(window: BrowserWindow): void {
  window.webContents.send('velix:done');
}

export function registerIpcHandlers(): void {
  ipcMain.handle('velix:getSettings', async () => {
    return getSettings();
  });

  ipcMain.handle('velix:saveSettings', async (_e, settings: Settings) => {
    saveSettings(settings);
    return true;
  });

  ipcMain.handle('velix:loginMicrosoft', async () => {
    try {
      const account = await microsoftLogin();
      if (account && account.type === 'microsoft' && account.accessToken) {
        const stored = storeTokens(account.uuid || account.username, {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken || '',
          clientId: account.clientId || '',
          xuid: account.xuid || '',
        });
        const safeAccount = {
          type: account.type,
          username: account.username,
          uuid: account.uuid,
        };
        account.accessToken = undefined;
        account.refreshToken = undefined;
        account.clientId = undefined;
        account.xuid = undefined;
        return { success: true, account: safeAccount, rememberDisabled: !stored };
      }
      return { success: true, account };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('velix:logoutMicrosoft', async () => {
    deleteAllTokens();
    return true;
  });

  ipcMain.handle('velix:getAccount', async () => {
    return null;
  });

  ipcMain.handle('velix:getVersions', async () => {
    try {
      return await fetchVersions();
    } catch {
      return [];
    }
  });

  ipcMain.handle('velix:launch', async (_e, versionId: string, account: any) => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window) return { success: false, error: 'No window' };

    const settings = getSettings();
    const logCb = (l: string) => sendLaunchLog(window, l);

    const accountId = account?.uuid || account?.username || '';
    let storedTokens = getTokens(accountId);
    if (storedTokens && account?.type === 'microsoft') {
      account.accessToken = storedTokens.accessToken;
      account.refreshToken = storedTokens.refreshToken;
      account.clientId = storedTokens.clientId;
      account.xuid = storedTokens.xuid;

      if (!account.accessToken && storedTokens.refreshToken) {
        const refreshed = await refreshMicrosoftAccount(accountId);
        if (refreshed && refreshed.accessToken) {
          storeTokens(accountId, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken || storedTokens.refreshToken,
            clientId: storedTokens.clientId || '',
            xuid: refreshed.xuid || '',
          });
          account.accessToken = refreshed.accessToken;
          account.refreshToken = refreshed.refreshToken || storedTokens.refreshToken;
          account.xuid = refreshed.xuid;
        }
      }
    }

    if (account?.type === 'microsoft' && !account.accessToken) {
      return {
        success: false,
        error: 'No saved Microsoft session available. Secure storage is unavailable — please log in again.',
      };
    }

    logCb('[Auth] Loaded credentials for: ' + (account?.username || 'unknown'));
    logCb('[Auth] Token status: ' + (account?.accessToken ? 'present' : 'absent'));

    const profile = resolveProfile(settings.launchProfile || 'potato', os.totalmem());
    settings.ram = profile.maxRAM;
    settings.closeAfterLaunch = profile.closeAfterLaunch;
    const profileArgsStr = profile.jvmArgs.join(' ');
    settings.jvmArgs = settings.jvmArgs ? profileArgsStr + ' ' + settings.jvmArgs : profileArgsStr;
    (settings as any)._profilePriority = profile.processPriority;
    logCb('[Profile] ' + profile.icon + ' ' + profile.label + ' — RAM: ' + profile.minRAM + '-' + profile.maxRAM + 'MB, Priority: ' + profile.processPriority);

    logCb('[Display] forceDisplayResolution=' + settings.forceDisplayResolution + ' displayMode=' + settings.displayMode);
    if (settings.forceDisplayResolution && settings.displayMode === 'fullscreen') {
      const current = getCurrentResolution();
      savedResolution = current;
      logCb('[Display] Current desktop: ' + current.width + 'x' + current.height);
      logCb('[Display] Requested: ' + settings.fullscreenResWidth + 'x' + settings.fullscreenResHeight);

      let { ok, code } = changeDisplayResolution(settings.fullscreenResWidth, settings.fullscreenResHeight, false);
      if (ok) {
        logCb('[Display] Resolution changed successfully');
      } else {
        logCb('[Display] ERROR: Failed to change display resolution (code=' + code + '). Check if the resolution is supported by your monitor.');
        savedResolution = null;
      }
    }

    const statusCb = (s: string) => sendStatus(window, s);
    const progressCb = (p: number) => sendProgress(window, p);

    try {
      await launchMinecraft(versionId, settings, account, statusCb, progressCb, logCb);
      logCb('⭐ Like VelixLITE? Give it a Star!');
      logCb('https://github.com/Nexoruz-Labs/VelixLITE');
      sendDone(window);
      return { success: true };
    } catch (err: any) {
      sendStatus(window, 'Error: ' + err.message);
      return { success: false, error: err.message };
    } finally {
      if (savedResolution) {
        const restore = changeDisplayResolution(savedResolution.width, savedResolution.height, false);
        if (restore.ok) {
          logCb('Restored display resolution to ' + savedResolution.width + 'x' + savedResolution.height);
        } else {
          logCb('Warning: Failed to restore display resolution. You may need to set it manually.');
        }
        savedResolution = null;
      }
      if (account) {
        account.accessToken = undefined;
        account.refreshToken = undefined;
        account.clientId = undefined;
        account.xuid = undefined;
      }
      if (storedTokens) {
        storedTokens.accessToken = '';
        storedTokens.refreshToken = '';
        storedTokens.clientId = '';
        storedTokens.xuid = '';
      }
      storedTokens = null;
    }
  });

  ipcMain.handle('velix:getCurrentResolution', async () => {
    return getCurrentResolution();
  });

  ipcMain.handle('velix:validateResolution', async (_e, width: number, height: number) => {
    const { ok } = changeDisplayResolution(width, height, true);
    return ok;
  });

  ipcMain.handle('velix:getAccounts', async () => {
    return getAccounts();
  });

  ipcMain.handle('velix:addAccount', async (_e, account: StoredAccount) => {
    return addAccount(account);
  });

  ipcMain.handle('velix:removeAccount', async (_e, id: string) => {
    removeAccount(id);
    deleteTokens(id);
    return true;
  });

  ipcMain.handle('velix:getSystemRam', async () => {
    return os.totalmem();
  });

  ipcMain.handle('velix:detectJava', async () => {
    const results: Array<{ version: number; path: string; source: string; isJdk: boolean; displayName: string }> = [];
    const seen = new Set<string>();

    function isJdkByPath(javaPath: string): boolean {
      const p = javaPath.toLowerCase();
      return p.includes('jdk') || p.includes('adoptium') || p.includes('corretto') ||
             p.includes('liberica') || p.includes('zulu') || p.includes('graalvm') ||
             p.includes('microsoft') || p.includes('java jdk');
    }

    function getJavaDisplayName(version: number, path: string, source: string, isJdk: boolean): string {
      const p = path.toLowerCase();
      let vendor = 'Java';
      if (p.includes('adoptium') || p.includes('eclipse')) vendor = 'Eclipse Adoptium';
      else if (p.includes('corretto') || p.includes('amazon')) vendor = 'Amazon Corretto';
      else if (p.includes('liberica') || p.includes('bellsoft')) vendor = 'BellSoft Liberica';
      else if (p.includes('zulu') || p.includes('azul')) vendor = 'Azul Zulu';
      else if (p.includes('graalvm')) vendor = 'GraalVM';
      else if (p.includes('microsoft')) vendor = 'Microsoft';
      else if (source === 'JAVA_HOME') vendor = 'JAVA_HOME';
      else if (source === 'Auto-installed') vendor = 'VelixLITE';
      const type = isJdk ? 'JDK' : 'JRE';
      return `${vendor} ${type} ${version}`;
    }

    function addResult(version: number, exePath: string, source: string, isJdk?: boolean) {
      if (fs.existsSync(exePath) && !seen.has(exePath)) {
        seen.add(exePath);
        const jdk = isJdk !== undefined ? isJdk : isJdkByPath(exePath);
        results.push({ version, path: exePath, source, isJdk: jdk, displayName: getJavaDisplayName(version, exePath, source, jdk) });
      }
    }

    function getJavaVersion(exePath: string): number | null {
      try {
        const out = execSync(`"${exePath}" -version 2>&1`, { timeout: 5000 }).toString();
        const m = out.match(/(?:version\s+)"?(?:1\.)?(\d+)/);
        if (m) return parseInt(m[1]);
      } catch {}
      return null;
    }

    function parseJavaDir(name: string): number | null {
      let m = name.match(/^(?:jre|jdk)-(\d+)/);
      if (m) return parseInt(m[1]);
      m = name.match(/^(?:jre|jdk)1\.(\d+)/);
      if (m) return parseInt(m[1]);
      m = name.match(/^(?:jre|jdk)(\d+)$/);
      if (m) return parseInt(m[1]);
      return null;
    }

    const { execSync } = require('child_process');

    try {
      const javaHome = process.env.JAVA_HOME;
      if (javaHome) {
        const exe = path.join(javaHome, 'bin', 'java.exe');
        const ver = getJavaVersion(exe);
        if (ver) addResult(ver, exe, 'JAVA_HOME');
      }
    } catch {}

    try {
      const script = `
$result = @()
$regPaths = @(
  "HKLM:\\SOFTWARE\\JavaSoft\\JRE",
  "HKLM:\\SOFTWARE\\JavaSoft\\JDK",
  "HKLM:\\SOFTWARE\\JavaSoft\\Java Runtime Environment",
  "HKLM:\\SOFTWARE\\JavaSoft\\Java Development Kit",
  "HKLM:\\SOFTWARE\\WOW6432Node\\JavaSoft\\JRE",
  "HKLM:\\SOFTWARE\\WOW6432Node\\JavaSoft\\JDK",
  "HKLM:\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment",
  "HKLM:\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit",
  "HKLM:\\SOFTWARE\\Microsoft\\JDK"
)
foreach ($regPath in $regPaths) {
  Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
    $ver = $_.PSChildName -replace '^1\\.', ''
    $home = (Get-ItemProperty "$regPath\\$($_.PSChildName)" -Name JavaHome -ErrorAction SilentlyContinue).JavaHome
    if ($home -and (Test-Path "$home\\bin\\java.exe")) { $result += "$ver|$home" }
  }
}
Write-Output ($result -join ';')
`;
      const { stdout } = runPowerShell(script);
      if (stdout) {
        for (const entry of stdout.split(';').filter(Boolean)) {
          const parts = entry.split('|');
          if (parts.length === 2) {
            const major = parseInt(parts[0]);
            if (!isNaN(major)) addResult(major, path.join(parts[1], 'bin', 'java.exe'), 'Registry');
          }
        }
      }
    } catch {}

    const commonBases = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\BellSoft',
      'C:\\Program Files\\Liberica JDK',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\GraalVM',
      'C:\\Program Files (x86)\\Java',
      'C:\\Program Files (x86)\\Eclipse Adoptium',
      path.join(os.homedir(), '.sdkman', 'candidates', 'java'),
    ];
    for (const base of commonBases) {
      try {
        if (fs.existsSync(base)) {
          for (const dir of fs.readdirSync(base)) {
            const ver = parseJavaDir(dir);
            if (ver) {
              const exe = path.join(base, dir, 'bin', 'java.exe');
              if (fs.existsSync(exe)) addResult(ver, exe, 'System');
            }
          }
        }
      } catch {}
    }

    try {
      const out = execSync('where java 2>nul', { timeout: 5000 }).toString().trim();
      if (out) {
        for (const line of out.split(/\r?\n/).filter(Boolean)) {
          const trimmed = line.trim();
          if (!seen.has(trimmed) && fs.existsSync(trimmed)) {
            const parentDir = path.basename(path.dirname(path.dirname(trimmed)));
            let ver = parseJavaDir(parentDir);
            if (!ver) ver = getJavaVersion(trimmed);
            if (ver) addResult(ver, trimmed, 'PATH');
          }
        }
      }
    } catch {}

    try {
      const pfDirs = ['C:\\Program Files', 'C:\\Program Files (x86)'];
      for (const pf of pfDirs) {
        if (fs.existsSync(pf)) {
          for (const dir of fs.readdirSync(pf)) {
            if (seen.has(path.join(pf, dir, 'bin', 'java.exe'))) continue;
            const ver = parseJavaDir(dir);
            if (ver) {
              const exe1 = path.join(pf, dir, 'bin', 'java.exe');
              if (fs.existsSync(exe1) && !seen.has(exe1)) addResult(ver, exe1, 'System');
              try {
                for (const sub of fs.readdirSync(path.join(pf, dir))) {
                  const exe2 = path.join(pf, dir, sub, 'bin', 'java.exe');
                  if (fs.existsSync(exe2) && !seen.has(exe2)) addResult(ver, exe2, 'System');
                }
              } catch {}
            }
          }
        }
      }
    } catch {}

    try {
      const s = getSettings();
      const runtimeDir = path.join(s.gameDirectory, 'runtime');
      if (fs.existsSync(runtimeDir)) {
        for (const dir of fs.readdirSync(runtimeDir)) {
          const ver = parseJavaDir(dir);
          if (ver) {
            const exe = path.join(runtimeDir, dir, 'bin', 'java.exe');
            if (fs.existsSync(exe) && !seen.has(exe)) addResult(ver, exe, 'Auto-installed', false);
          }
        }
      }
    } catch {}

    results.sort((a, b) => a.version - b.version);
    return results;
  });
}
