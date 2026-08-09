import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { Settings } from './settings';

function redactSensitive(val: string): string {
  val = val.replace(/([a-zA-Z0-9_-]{40,}|XBL3\.0\s+x=[^;]+;[^\s]+)/g, '********');
  val = val.replace(/(--accessToken\s+)\S+/g, '$1********');
  val = val.replace(/(--userProperties\s+)\S+/g, '$1********');
  val = val.replace(/(--userPropertyMap\s+)\S+/g, '$1********');
  return val;
}

function getOfflineUUID(username: string): string {
  const data = Buffer.from(`OfflinePlayer:${username}`, 'utf-8');
  const hash = createHash('md5').update(data).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
}

interface VersionMeta {
  id: string;
  type: string;
  mainClass: string;
  minecraftArguments?: string;
  arguments?: { game: any[]; jvm: any[] };
  libraries: Array<{
    name: string;
    downloads?: {
      artifact?: { path: string; url: string; sha1: string; size: number };
      classifiers?: Record<string, { path: string; url: string; sha1: string; size: number }>;
    };
    rules?: Array<{ action: string; os?: { name?: string } }>;
  }>;
  assetIndex: { id: string; sha1: string; size: number; totalSize: number; url: string };
  downloads: {
    client: { sha1: string; size: number; url: string };
    server?: { sha1: string; size: number; url: string };
  };
  javaVersion: { component: string; majorVersion: number };
}

interface JavaInstall {
  version: number;
  path: string;
  source: string;
  isJdk: boolean;
  displayName: string;
}

type StatusCb = (s: string) => void;
type ProgressCb = (p: number) => void;
type LogCb = (l: string) => void;

function getMCDir(settings: Settings): string {
  const dir = settings.gameDirectory;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buffer);
}

async function downloadWithRetry(url: string, dest: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await downloadFile(url, dest);
      return;
    } catch {
      if (i === retries - 1) throw new Error(`Failed to download ${url} after ${retries} retries`);
    }
  }
}

function isLibraryAllowed(lib: VersionMeta['libraries'][0]): boolean {
  if (!lib.rules || lib.rules.length === 0) return true;
  const allow = lib.rules.some(r => {
    if (r.action === 'allow') {
      if (!r.os) return true;
      return r.os.name === 'windows' || !r.os.name;
    }
    if (r.action === 'disallow') {
      if (!r.os) return false;
      return r.os.name === 'windows';
    }
    return false;
  });
  return allow;
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

function runPowerShell(script: string): { stdout: string; stderr: string } {
  const psFile = path.join(os.tmpdir(), 'velix_ps_' + Date.now() + '_' + Math.floor(Math.random() * 9999) + '.ps1');
  fs.writeFileSync(psFile, '\ufeff' + script, 'utf-8');
  try {
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
    return { stdout: (result || '').toString().trim(), stderr: '' };
  } finally {
    try { if (fs.existsSync(psFile)) fs.unlinkSync(psFile); } catch {}
  }
}

function detectSystemJava(): JavaInstall[] {
  const results: JavaInstall[] = [];
  const seen = new Set<string>();

  function addResult(version: number, exePath: string, source: string, isJdk?: boolean) {
    if (fs.existsSync(exePath) && !seen.has(exePath)) {
      seen.add(exePath);
      const jdk = isJdk !== undefined ? isJdk : isJdkByPath(exePath);
      results.push({ version, path: exePath, source, isJdk: jdk, displayName: getJavaDisplayName(version, exePath, source, jdk) });
    }
  }

  function getJavaVersion(exePath: string): number | null {
    try {
      const out = execSync(`"${exePath}" -version`, { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      const m = out.match(/(?:version\s+)"?(?:1\.)?(\d+)/);
      if (m) return parseInt(m[1]);
    } catch {
      try {
        const out = execSync(`cmd /c ""${exePath}" -version 2>&1"`, { timeout: 5000, encoding: 'utf-8' }).toString();
        const m = out.match(/(?:version\s+)"?(?:1\.)?(\d+)/);
        if (m) return parseInt(m[1]);
      } catch {}
    }
    return null;
  }

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
            if (fs.existsSync(exe)) {
              addResult(ver, exe, 'System');
            }
          }
        }
      }
    } catch {}
  }

  try {
    const out = execSync('cmd /c where java 2>nul', { timeout: 5000, encoding: 'utf-8' }).toString().trim();
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
    const s = require('./settings').getSettings() as Settings;
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
}

function findCompatibleJava(required: number, installs: JavaInstall[]): JavaInstall | null {
  const exact = installs.filter(j => j.version === required);
  if (exact.length > 0) {
    const jdk = exact.find(j => j.isJdk);
    if (jdk) return jdk;
    return exact[0];
  }

  const sorted = [...installs].sort((a, b) => a.version - b.version);
  const higher = sorted.filter(j => j.version > required);
  if (higher.length > 0) {
    const jdk = higher.find(j => j.isJdk);
    if (jdk) return jdk;
    return higher[0];
  }

  const byDesc = sorted.reverse();
  const jdk = byDesc.find(j => j.isJdk);
  if (jdk) return jdk;
  return byDesc[0] || null;
}

async function extractNativeJars(nativeJars: string[], nativesDir: string, onLog: LogCb): Promise<boolean> {
  ensureDir(nativesDir);
  let anyExtracted = false;

  for (const jarPath of nativeJars) {
    const baseName = path.basename(jarPath);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let extractCmd: string;

        if (attempt === 0) {
          const zipPath = jarPath + '.zip';
          if (!fs.existsSync(zipPath)) fs.copyFileSync(jarPath, zipPath);
          extractCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${nativesDir}" -Force`;
        } else if (attempt === 1) {
          extractCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath.replace(/'/g, "''")}', '${nativesDir.replace(/'/g, "''")}')`;
        } else {
          extractCmd = `$s = New-Object -ComObject Shell.Application; $z = $s.Namespace('${jarPath.replace(/'/g, "''")}'); $d = $s.Namespace('${nativesDir.replace(/'/g, "''")}'); $d.CopyHere($z.Items(), 20)`;
        }

        const psFile = path.join(os.tmpdir(), 'velix_nat_' + Date.now() + '_' + Math.floor(Math.random() * 99999) + '.ps1');
        fs.writeFileSync(psFile, '\ufeff' + extractCmd, 'utf-8');
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'pipe', timeout: 120000, encoding: 'utf-8' });
        try { fs.unlinkSync(psFile); } catch {}
        try { if (fs.existsSync(jarPath + '.zip')) fs.unlinkSync(jarPath + '.zip'); } catch {}

        const filesBefore = attempt === 0 ? 0 : fs.readdirSync(nativesDir).length;
        await new Promise(r => setTimeout(r, 200));
        const filesAfter = fs.readdirSync(nativesDir).length;

        if (filesAfter > 0) {
          onLog('[Natives] Extracted ' + baseName + ' (' + (filesAfter) + ' files in ' + nativesDir + ')');
          anyExtracted = true;
          break;
        } else if (attempt < 2) {
          onLog('[Natives] Method ' + (attempt + 1) + ' extracted 0 files from ' + baseName + ', retrying...');
        } else {
          onLog('[Natives] WARNING: All extraction methods produced 0 files from ' + baseName);
        }
      } catch (e: any) {
        if (attempt < 2) {
          onLog('[Natives] Method ' + (attempt + 1) + ' failed for ' + baseName + ': ' + e.message + ', retrying...');
        } else {
          onLog('[Natives] WARNING: All extraction methods failed for ' + baseName + ': ' + e.message);
        }
      }
    }
  }

  return anyExtracted;
}

function listNativeFiles(nativesDir: string): string[] {
  if (!fs.existsSync(nativesDir)) return [];
  return fs.readdirSync(nativesDir).filter(f => !fs.statSync(path.join(nativesDir, f)).isDirectory());
}

function validateJsonFile(filePath: string, onLog: LogCb): { valid: boolean; error?: string } {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: 'File does not exist: ' + filePath };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content || content.trim().length === 0) {
    return { valid: false, error: 'File is empty: ' + filePath };
  }
  try {
    JSON.parse(content);
    return { valid: true };
  } catch (e: any) {
    const firstBytes = content.substring(0, 200).replace(/\r?\n/g, '\\n');
    const lastBytes = content.length > 200 ? '...' : '';
    onLog('[JSON] Parse error: ' + e.message);
    onLog('[JSON] First 200 chars: "' + firstBytes + lastBytes + '"');
    return { valid: false, error: 'Invalid JSON: ' + e.message + ' — File: ' + filePath };
  }
}

export async function launchMinecraft(
  versionId: string,
  settings: Settings,
  account: any,
  onStatus: StatusCb,
  onProgress: ProgressCb,
  onLog: LogCb
): Promise<void> {
  const mcDir = getMCDir(settings);
  const versionsDir = path.join(mcDir, 'versions');
  const librariesDir = path.join(mcDir, 'libraries');
  const assetsDir = path.join(mcDir, 'assets');

  ensureDir(versionsDir);
  ensureDir(librariesDir);
  ensureDir(assetsDir);

  onStatus('Preparing...');
  onProgress(0);

  const manifestRes = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const manifest = await manifestRes.json();

  let resolvedId = versionId;
  if (versionId === 'latest-release') resolvedId = manifest.latest.release;
  if (versionId === 'latest-snapshot') resolvedId = manifest.latest.snapshot;

  const versionEntry = manifest.versions.find((v: any) => v.id === resolvedId);
  if (!versionEntry) throw new Error(`Version ${resolvedId} not found`);

  onProgress(5);

  const versionDir = path.join(versionsDir, versionId);
  ensureDir(versionDir);
  const versionJsonPath = path.join(versionDir, `${versionId}.json`);

  onStatus('Downloading version metadata...');
  await downloadWithRetry(versionEntry.url, versionJsonPath);
  const meta: VersionMeta = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));

  onProgress(15);

  const requiredJava = meta.javaVersion?.majorVersion || 8;
  onLog('[Java] Minecraft ' + resolvedId + ' requires Java ' + requiredJava);

  onStatus('Checking Java...');
  const allJavaInstalls = detectSystemJava();
  onLog('[Java] === Java Detection ===');
  for (const j of allJavaInstalls) {
    onLog('[Java]   ' + (j.isJdk ? 'JDK' : 'JRE') + ' ' + j.version + ' — ' + j.path + ' (' + j.source + ')');
  }
  onLog('[Java] Found ' + allJavaInstalls.length + ' Java installation(s)');

  const compatible = findCompatibleJava(requiredJava, allJavaInstalls);
  let effectiveJavaPath: string;

  if (compatible) {
    effectiveJavaPath = compatible.path;
    onLog('[Java] Selected: ' + compatible.displayName + ' — ' + compatible.path);
    onLog('[Java] Reason: Compatible with Minecraft ' + resolvedId + ' (requires Java ' + requiredJava + ')');
    onLog('[Java] Java Download: Skipped (compatible installation found)');
  } else {
    if (settings.autoInstallJava) {
      onLog('[Java] No compatible Java ' + requiredJava + ' found on system');
      onLog('[Java] Java Download: Required (no compatible installation)');
      onStatus('Downloading Java ' + requiredJava + '...');
      const runtimeDir = path.join(mcDir, 'runtime');
      ensureDir(runtimeDir);
      const jreDir = path.join(runtimeDir, 'jre-' + requiredJava);
      const jreBin = path.join(jreDir, 'bin', 'java.exe');

      try {
        const tempDir = path.join(runtimeDir, '.dl_' + Date.now());
        ensureDir(tempDir);
        const zipPath = path.join(tempDir, 'jre.zip');

        const dlUrl = `https://api.adoptium.net/v3/binary/latest/${requiredJava}/ga/windows/x64/jre/hotspot/normal/eclipse`;
        const dlRes = await fetch(dlUrl, { redirect: 'manual' });
        let actualUrl = dlUrl;
        if (dlRes.status >= 300 && dlRes.status < 400) {
          actualUrl = dlRes.headers.get('location') || actualUrl;
        }
        await downloadWithRetry(actualUrl, zipPath);

        onLog('[Java] Extracting...');
        const extractPs = path.join(os.tmpdir(), 'velix_extract_' + Date.now() + '.ps1');
        fs.writeFileSync(extractPs, `Expand-Archive -Path "${zipPath}" -DestinationPath "${tempDir}" -Force`, 'utf-8');
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${extractPs}"`, { stdio: 'pipe', timeout: 120000, encoding: 'utf-8' });
        try { fs.unlinkSync(extractPs); } catch {}

        let foundBin = '';
        try {
          const items = fs.readdirSync(tempDir);
          for (const item of items) {
            const candidate = path.join(tempDir, item, 'bin', 'java.exe');
            if (fs.existsSync(candidate)) {
              foundBin = candidate;
              break;
            }
          }
        } catch {}

        if (foundBin) {
          const extractedRoot = path.dirname(path.dirname(foundBin));
          if (fs.existsSync(jreDir)) fs.rmSync(jreDir, { recursive: true, force: true });
          fs.renameSync(extractedRoot, jreDir);
          effectiveJavaPath = path.join(jreDir, 'bin', 'java.exe');
          onLog('[Java] Installed Java ' + requiredJava + ' to ' + jreDir);
        } else {
          throw new Error('Could not find java.exe in extracted archive');
        }

        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      } catch (e: any) {
        onLog('[Java] Download failed: ' + e.message);
        onLog('[Java] Falling back to configured Java path');
        effectiveJavaPath = settings.javaPath;
      }
    } else {
      onLog('[Java] Auto-install disabled, using configured Java path: ' + settings.javaPath);
      effectiveJavaPath = settings.javaPath;
    }
  }

  if (!fs.existsSync(effectiveJavaPath)) {
    throw new Error('Java executable not found: ' + effectiveJavaPath + '. Please set a valid Java path in settings.');
  }

  const jarPath = path.join(versionDir, `${versionId}.jar`);
  if (!fs.existsSync(jarPath)) {
    onStatus('Downloading client...');
    await downloadWithRetry(meta.downloads.client.url, jarPath);
  }

  onProgress(30);

  onStatus('Downloading libraries...');
  const allowedLibs = meta.libraries.filter(isLibraryAllowed);
  let libProgress = 30;
  const libStart = libProgress;
  const libEnd = 70;
  const libStep = allowedLibs.length > 0 ? (libEnd - libStart) / allowedLibs.length : 0;

  const classPathEntries: string[] = [jarPath];
  const nativeJars: string[] = [];

  for (const lib of allowedLibs) {
    if (lib.downloads) {
      if (lib.downloads.artifact) {
        const art = lib.downloads.artifact;
        const libPath = path.join(librariesDir, art.path);
        if (!fs.existsSync(libPath)) {
          await downloadWithRetry(art.url, libPath);
        }
        classPathEntries.push(libPath);
      }

      if (lib.downloads.classifiers) {
        const nativeKey = Object.keys(lib.downloads.classifiers).find(
          k => k.includes('natives-windows')
        );
        if (nativeKey) {
          const classifier = lib.downloads.classifiers[nativeKey];
          const nativePath = path.join(librariesDir, classifier.path);
          if (!fs.existsSync(nativePath)) {
            await downloadWithRetry(classifier.url, nativePath);
          }
          classPathEntries.push(nativePath);
          nativeJars.push(nativePath);
        }
      }
    }
    libProgress += libStep;
    onProgress(Math.round(libProgress));
  }

  const nativesDir = path.join(versionDir, 'natives');
  if (nativeJars.length > 0) {
    onStatus('Extracting native libraries...');
    const extracted = await extractNativeJars(nativeJars, nativesDir, onLog);
    if (!extracted) {
      onLog('[Natives] WARNING: No native libraries were extracted from any JAR');
    }
  }

  onStatus('Downloading assets...');
  const assetIndexPath = path.join(assetsDir, 'indexes', `${meta.assetIndex.id}.json`);

  let assetIndexValid = false;
  if (fs.existsSync(assetIndexPath)) {
    const result = validateJsonFile(assetIndexPath, onLog);
    if (result.valid) {
      assetIndexValid = true;
      onLog('[Assets] Asset index OK: ' + meta.assetIndex.id + '.json');
    } else {
      onLog('[Assets] WARNING: Existing asset index is invalid, will re-download: ' + result.error);
      try { fs.unlinkSync(assetIndexPath); } catch {}
    }
  }

  if (!assetIndexValid) {
    for (let attempt = 0; attempt < 3; attempt++) {
      ensureDir(path.dirname(assetIndexPath));
      await downloadWithRetry(meta.assetIndex.url, assetIndexPath);
      const result = validateJsonFile(assetIndexPath, onLog);
      if (result.valid) {
        assetIndexValid = true;
        onLog('[Assets] Asset index downloaded and validated: ' + meta.assetIndex.id + '.json');
        break;
      } else {
        onLog('[Assets] WARNING: Downloaded asset index is invalid (attempt ' + (attempt + 1) + '): ' + result.error);
        try { fs.unlinkSync(assetIndexPath); } catch {}
        if (attempt < 2) {
          onLog('[Assets] Retrying download...');
        }
      }
    }
  }

  if (!assetIndexValid) {
    throw new Error('Failed to download valid asset index after 3 attempts: ' + meta.assetIndex.id + '.json');
  }

  const assetIndex = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));

  const objects = assetIndex.objects || {};
  const assetKeys = Object.keys(objects);
  let completedAssets = 0;
  const assetProgressStart = 70;
  const assetProgressEnd = 90;

  const CONCURRENCY = 12;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < assetKeys.length) {
      const i = nextIndex++;
      const key = assetKeys[i];
      const obj = objects[key];
      const hash = obj.hash;
      const subDir = hash.substring(0, 2);
      const assetPath = path.join(assetsDir, 'objects', subDir, hash);

      if (!fs.existsSync(assetPath)) {
        const url = `https://resources.download.minecraft.net/${subDir}/${hash}`;
        try {
          await downloadWithRetry(url, assetPath);
        } catch {
          onLog(`Warning: Failed to download asset ${key}`);
        }
      }

      completedAssets++;
      if (completedAssets % 20 === 0 || completedAssets === assetKeys.length) {
        const p = assetProgressStart + (completedAssets / assetKeys.length) * (assetProgressEnd - assetProgressStart);
        onProgress(Math.round(Math.min(p, assetProgressEnd)));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assetKeys.length) }, () => worker()));

  if (assetIndex.virtual || assetIndex.map_to_resources) {
    onStatus('Preparing legacy assets...');
    const virtualDir = path.join(assetsDir, 'virtual', 'legacy');
    for (const key of assetKeys) {
      const obj = objects[key];
      const hash = obj.hash;
      const subDir = hash.substring(0, 2);
      const src = path.join(assetsDir, 'objects', subDir, hash);
      const dest = path.join(virtualDir, key);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
      }
    }
  }

  onProgress(90);

  const classpath = classPathEntries.join(';');

  const jvmArgs: string[] = [];

  if (settings.jvmArgs && settings.jvmArgs.trim()) {
    const customArgs = settings.jvmArgs.trim().split(/\s+/);
    for (const a of customArgs) {
      if (a) jvmArgs.push(a);
    }
  }

  jvmArgs.push(`-Xms${Math.min(settings.ram, 512)}m`);
  jvmArgs.push(`-Xmx${settings.ram}m`);

  const libraryPathArg = '-Djava.library.path=' + nativesDir;
  jvmArgs.push(libraryPathArg);
  jvmArgs.push('-Dminecraft.launcher.brand=velixlite');
  jvmArgs.push('-Dminecraft.launcher.version=1.0.0');
  jvmArgs.push('-cp', classpath);

  jvmArgs.push(meta.mainClass);

  const gameArgs: string[] = [];

  if (meta.arguments && meta.arguments.game) {
    for (const arg of meta.arguments.game) {
      if (typeof arg === 'string') {
        gameArgs.push(arg);
      }
    }
  } else if (meta.minecraftArguments) {
    gameArgs.push(...meta.minecraftArguments.split(' '));
  }

  const username = account?.username || 'Player';
  const isOffline = account?.type === 'offline' || !account?.accessToken;
  const uuid = account?.uuid || (isOffline ? getOfflineUUID(username) : '00000000-0000-0000-0000-000000000000');
  const accessToken = isOffline ? '0' : (account?.accessToken || '0');

  if (isOffline) {
    jvmArgs.push('-Dminecraft.api.env=custom');
    jvmArgs.push('-Dminecraft.api.auth.host=https://invalid.invalid');
    jvmArgs.push('-Dminecraft.api.account.host=https://invalid.invalid');
    jvmArgs.push('-Dminecraft.api.session.host=https://invalid.invalid');
    jvmArgs.push('-Dminecraft.api.services.host=https://invalid.invalid');
  }

  const tokenMap: Record<string, string> = {
    '${auth_player_name}': username,
    '${version_name}': versionId,
    '${game_directory}': mcDir,
    '${assets_root}': assetsDir,
    '${assets_index_name}': meta.assetIndex.id,
    '${auth_uuid}': uuid,
    '${auth_access_token}': accessToken,
    '${user_type}': isOffline ? 'legacy' : 'msa',
    '${version_type}': meta.type,
    '${resolution_width}': settings.resolutionWidth.toString(),
    '${resolution_height}': settings.resolutionHeight.toString(),
    '${game_assets}': path.join(assetsDir, 'virtual', 'legacy'),
    '${auth_session}': '0',
    '${natives_directory}': nativesDir,
    '${classpath}': classpath,
    '${launcher_name}': 'velixlite',
    '${launcher_version}': '1.0.0',
    '${user_properties}': '{}',
    '${user_property_map}': '{}',
    '${profile_name}': username,
    '${clientid}': account?.clientId || (isOffline ? '00000000402b5328' : ''),
    '${auth_xuid}': account?.xuid || (isOffline ? '0' : ''),
  };

  const allVersionArgs: string[] = [];
  if (meta.arguments?.game) {
    for (const arg of meta.arguments.game) {
      if (typeof arg === 'string') allVersionArgs.push(arg);
    }
  }
  if (meta.arguments?.jvm) {
    for (const arg of meta.arguments.jvm) {
      if (typeof arg === 'string') allVersionArgs.push(arg);
    }
  }
  if (meta.minecraftArguments) {
    allVersionArgs.push(meta.minecraftArguments);
  }
  const placeholderRegex = /\$\{(\w+)\}/g;
  const foundPlaceholders = new Set<string>();
  for (const arg of allVersionArgs) {
    let m;
    while ((m = placeholderRegex.exec(arg)) !== null) {
      const key = m[1];
      const full = '${' + key + '}';
      if (!(full in tokenMap)) {
        foundPlaceholders.add(full);
      }
    }
  }
  if (foundPlaceholders.size > 0) {
    onLog('[Tokens] WARNING: Unsupported placeholders found in version JSON for ' + resolvedId + ':');
    for (const p of foundPlaceholders) {
      onLog('[Tokens]   ' + p + ' — this may cause launch failures');
    }
  }

  const resolvedGameArgs = gameArgs.map(arg => {
    for (const [key, val] of Object.entries(tokenMap)) {
      if (arg.includes(key)) {
        arg = arg.split(key).join(val);
      }
    }
    return arg;
  });

  if (settings.displayMode === 'fullscreen') {
    resolvedGameArgs.push('--fullscreen');
    if (settings.forceDisplayResolution && settings.fullscreenResWidth > 0 && settings.fullscreenResHeight > 0) {
      resolvedGameArgs.push('--width', settings.fullscreenResWidth.toString(), '--height', settings.fullscreenResHeight.toString());
    }
  } else if (settings.displayMode === 'borderless') {
    try {
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.size;
      resolvedGameArgs.push('--width', width.toString(), '--height', height.toString());
    } catch {
      resolvedGameArgs.push('--width', settings.resolutionWidth.toString(), '--height', settings.resolutionHeight.toString());
    }
  }

  let argsModified = false;
  for (let i = 0; i < resolvedGameArgs.length - 1; i++) {
    const key = resolvedGameArgs[i];
    const val = resolvedGameArgs[i + 1];

    if (key === '--username') {
      if (!val || val.trim() === '' || val === 'null' || val === 'undefined') {
        onLog('[Args] WARNING: --username is invalid ("' + val + '"), replacing with "Player"');
        resolvedGameArgs[i + 1] = 'Player';
        argsModified = true;
      }
    }

    if (key === '--uuid') {
      if (!val || val.trim() === '') {
        onLog('[Args] WARNING: --uuid is empty, generating fallback UUID');
        resolvedGameArgs[i + 1] = getOfflineUUID(username);
        argsModified = true;
      }
    }

    if (key === '--accessToken') {
      if (!val || val.trim() === '' || val === 'null' || val === 'undefined') {
        onLog('[Args] WARNING: --accessToken is invalid (value hidden), replacing with "0"');
        resolvedGameArgs[i + 1] = '0';
        argsModified = true;
      }
    }

    if (key === '--userType') {
      if (!val || val.trim() === '') {
        onLog('[Args] WARNING: --userType is empty, replacing with "mojang"');
        resolvedGameArgs[i + 1] = 'mojang';
        argsModified = true;
      }
    }

    if (key === '--userProperties') {
      if (!val || val.trim() === '' || val === 'null' || val === 'undefined') {
        onLog('[Args] WARNING: --userProperties is empty, replacing with {}');
        resolvedGameArgs[i + 1] = '{}';
        argsModified = true;
      } else {
        try {
          JSON.parse(val);
        } catch (e: any) {
          onLog('[Args] WARNING: --userProperties is not valid JSON (value hidden), replacing with {}');
          onLog('[Args]   Parse error: ' + e.message);
          resolvedGameArgs[i + 1] = '{}';
          argsModified = true;
        }
      }
    }
  }

  const allArgs = [...jvmArgs, ...resolvedGameArgs];

  if (argsModified) {
    onLog('[Args] Some arguments were fixed. Final arguments:');
    for (const a of allArgs) {
      onLog('[Args]   ' + redactSensitive(a));
    }
  }

  const unresolved: Array<{ placeholder: string; arg: string }> = [];
  for (const a of allArgs) {
    const matches = a.match(/\$\{[^}]+\}/g);
    if (matches) {
      for (const m of matches) {
        unresolved.push({
          placeholder: m,
          arg: a.substring(0, 200) + (a.length > 200 ? '...' : ''),
        });
      }
    }
  }
  if (unresolved.length > 0) {
    onLog('[Args] ERROR: Unresolved placeholders found in launch arguments:');
    onLog('[Args]   Version: ' + resolvedId);
    onLog('[Args]   Account type: ' + (isOffline ? 'offline' : 'microsoft') + ' (' + username + ')');
    const seen = new Set<string>();
    for (const u of unresolved) {
      if (!seen.has(u.placeholder)) {
        seen.add(u.placeholder);
        onLog('[Args]   Missing placeholder: ' + u.placeholder);
        onLog('[Args]     Requested by: "' + u.arg + '"');
      }
    }
    throw new Error(
      'ABORT: Launch arguments contain ' + unresolved.length + ' unresolved placeholder(s). ' +
      'Missing: ' + [...seen].join(', ') + '. ' +
      'Version: ' + resolvedId + ', Account: ' + (isOffline ? 'offline' : 'microsoft')
    );
  }

  onLog('');
  onLog('[Launch] ====== PRE-LAUNCH VERIFICATION ======');
  onLog('[Launch] Java executable: ' + effectiveJavaPath);
  onLog('[Launch] Java exists: ' + (fs.existsSync(effectiveJavaPath) ? 'YES' : 'NO'));
  onLog('[Launch] Working directory: ' + mcDir);
  onLog('[Launch] Classpath (' + classPathEntries.length + ' entries):');
  for (const entry of classPathEntries) {
    const exists = fs.existsSync(entry);
    onLog('[Launch]   ' + (exists ? 'OK' : 'MISSING') + '  ' + entry);
  }
  onLog('[Launch] -Djava.library.path: ' + nativesDir);
  onLog('[Launch] -Djava.library.path exists: ' + (fs.existsSync(nativesDir) ? 'YES' : 'NO'));
  onLog('[Launch] Natives directory contents:');
  if (fs.existsSync(nativesDir)) {
    const nativeFiles = fs.readdirSync(nativesDir);
    for (const f of nativeFiles) {
      const fpath = path.join(nativesDir, f);
      const stat = fs.statSync(fpath);
      onLog('[Launch]   ' + f + ' (' + (stat.isDirectory() ? 'dir' : Math.round(stat.size / 1024) + ' KB') + ')');
    }
  }
  const nativeFileList = listNativeFiles(nativesDir);
  onLog('[Launch] Extracted natives (' + nativeFileList.length + ' files):');
  for (const f of nativeFileList) {
    const fpath = path.join(nativesDir, f);
    const stat = fs.statSync(fpath);
    onLog('[Launch]   ✓ ' + f + ' (' + Math.round(stat.size / 1024) + ' KB)');
  }
  onLog('[Launch] Main class: ' + meta.mainClass);
  onLog('[Launch] JVM arguments:');
  for (const a of jvmArgs) {
    onLog('[Launch]   ' + redactSensitive(a));
  }
  onLog('[Launch] Minecraft arguments:');
  for (const a of resolvedGameArgs) {
    onLog('[Launch]   ' + redactSensitive(a));
  }
  onLog('[Launch] ======================================');
  onLog('');

  if (!jvmArgs.some(a => a.startsWith('-Djava.library.path='))) {
    throw new Error('ABORT: -Djava.library.path is missing from JVM arguments');
  }

  const nativeFileCount = nativeFileList.length;
  if (fs.existsSync(nativesDir) && nativeFileCount === 0) {
    onLog('[Natives] ERROR: Natives directory exists but contains zero native files. Attempting emergency re-extraction...');

    if (nativeJars.length > 0) {
      if (fs.existsSync(nativesDir)) {
        try { fs.rmSync(nativesDir, { recursive: true, force: true }); } catch {}
      }
      ensureDir(nativesDir);
      await extractNativeJars(nativeJars, nativesDir, onLog);
    }

    const retryFiles = listNativeFiles(nativesDir);
    if (retryFiles.length === 0) {
      onLog('[Natives] ERROR: Emergency re-extraction produced zero files.');
      onLog('[Natives] Natives directory: ' + nativesDir);
      onLog('[Natives] Native JARs attempted: ' + nativeJars.length);
      for (const nj of nativeJars) {
        onLog('[Natives]   ' + nj + ' (' + (fs.existsSync(nj) ? Math.round(fs.statSync(nj).size / 1024) + ' KB' : 'MISSING') + ')');
      }
      throw new Error('ABORT: No native libraries were extracted into ' + nativesDir + '. ' +
        'Tried ' + nativeJars.length + ' native JAR(s). Check the console log for extraction errors.');
    } else {
      onLog('[Natives] Emergency re-extraction succeeded. Extracted ' + retryFiles.length + ' native file(s).');
    }
  } else if (!fs.existsSync(nativesDir) && nativeJars.length > 0) {
    onLog('[Natives] WARNING: Natives directory does not exist. Attempting extraction...');
    ensureDir(nativesDir);
    await extractNativeJars(nativeJars, nativesDir, onLog);
    const retryFiles = listNativeFiles(nativesDir);
    if (retryFiles.length === 0) {
      throw new Error('ABORT: Failed to extract native libraries into ' + nativesDir + '.');
    }
  }

  onLog('[JSON] === JSON File Validation ===');
  const jsonFilesToCheck: string[] = [];

  const indexesDir = path.join(assetsDir, 'indexes');
  if (fs.existsSync(indexesDir)) {
    for (const f of fs.readdirSync(indexesDir)) {
      if (f.endsWith('.json')) {
        jsonFilesToCheck.push(path.join(indexesDir, f));
      }
    }
  }

  if (fs.existsSync(versionJsonPath)) {
    jsonFilesToCheck.push(versionJsonPath);
  }

  let allJsonValid = true;
  const fixableJson: string[] = [];

  for (const jf of jsonFilesToCheck) {
    const result = validateJsonFile(jf, onLog);
    const size = fs.statSync(jf).size;
    if (result.valid) {
      onLog('[JSON]   OK  ' + jf + ' (' + size + ' bytes)');
    } else {
      onLog('[JSON]   BAD  ' + jf + ' (' + size + ' bytes) — ' + (result.error || 'unknown error'));
      if (jf === assetIndexPath) {
        fixableJson.push(jf);
      } else {
        allJsonValid = false;
      }
    }
  }

  if (fixableJson.length > 0) {
    onLog('[JSON] Attempting to re-download asset index...');
    for (const jf of fixableJson) {
      try {
        fs.unlinkSync(jf);
      } catch {}
      try {
        ensureDir(path.dirname(jf));
        await downloadWithRetry(meta.assetIndex.url, jf);
        const retry = validateJsonFile(jf, onLog);
        if (retry.valid) {
          onLog('[JSON] Asset index re-downloaded and validated successfully');
        } else {
          onLog('[JSON] ERROR: Re-downloaded asset index is still invalid: ' + (retry.error || 'unknown'));
          allJsonValid = false;
        }
      } catch (e: any) {
        onLog('[JSON] ERROR: Failed to re-download asset index: ' + e.message);
        allJsonValid = false;
      }
    }
  }

  if (!allJsonValid) {
    throw new Error('ABORT: One or more required JSON files are invalid. See log above for details.');
  }
  onLog('[JSON] ===========================');
  onLog('');

  onStatus('Launching...');
  onProgress(95);

  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn(effectiveJavaPath, allArgs, {
      cwd: mcDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const priority = (settings as any)._profilePriority;
    if (priority && priority !== 'normal') {
      try {
        const cls = priority === 'high' ? 'High' : 'Idle';
        execSync(`powershell -command "(Get-Process -Id ${proc.pid}).PriorityClass = '${cls}'"`, { timeout: 5000 });
        onLog('[Launch] Process priority set to ' + cls);
      } catch {
        onLog('[Launch] Failed to set process priority (continuing)');
      }
    }

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = redactSensitive(data.toString().trim());
      if (lines) onLog(lines);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = redactSensitive(data.toString().trim());
      if (lines) onLog(lines);
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start Java: ${err.message}`));
    });

    proc.on('exit', (code) => {
      onProgress(100);
      onStatus('Finished.');
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Minecraft exited with code ${code}`));
      }
    });
  });
}
