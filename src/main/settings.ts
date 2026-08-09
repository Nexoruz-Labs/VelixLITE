import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import type { ProfileId } from './launchProfiles';

export interface Settings {
  gameDirectory: string;
  javaPath: string;
  ram: number;
  resolutionWidth: number;
  resolutionHeight: number;
  displayMode: 'windowed' | 'fullscreen' | 'borderless';
  closeAfterLaunch: boolean;
  jvmArgs: string;
  forceDisplayResolution: boolean;
  fullscreenResWidth: number;
  fullscreenResHeight: number;
  autoInstallJava: boolean;
  lastVersion: string;
  lastAccountId: string;
  launchProfile: ProfileId;
}

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function defaultSettings(): Settings {
  let javaPath = 'java';
  try {
    const out = execSync('where java 2>nul || echo java').toString().trim();
    if (out && out !== 'java') javaPath = out.split('\n')[0].trim();
  } catch {}

  return {
    gameDirectory: path.join(homedir(), 'AppData', 'Roaming', '.velixlite'),
    javaPath,
    ram: 2048,
    resolutionWidth: 854,
    resolutionHeight: 480,
    displayMode: 'windowed',
    closeAfterLaunch: false,
    jvmArgs: '',
    forceDisplayResolution: false,
    fullscreenResWidth: 1920,
    fullscreenResHeight: 1080,
    autoInstallJava: true,
    lastVersion: 'latest-release',
    lastAccountId: '',
    launchProfile: 'potato',
  };
}

export function getSettings(): Settings {
  try {
    const data = fs.readFileSync(settingsPath, 'utf-8');
    return { ...defaultSettings(), ...JSON.parse(data) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}
