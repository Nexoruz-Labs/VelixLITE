import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const STORAGE_DIR = path.join(app.getPath('userData'), 'secure');

let encryptionAvailable: boolean | null = null;

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function tokenFilePath(accountId: string): string {
  return path.join(STORAGE_DIR, `tokens_${accountId}.enc`);
}

export function isEncryptionAvailable(): boolean {
  if (encryptionAvailable === null) {
    try {
      encryptionAvailable = safeStorage.isEncryptionAvailable();
    } catch {
      encryptionAvailable = false;
    }
  }
  return encryptionAvailable;
}

export function storeTokens(accountId: string, tokens: Record<string, string>): boolean {
  if (!isEncryptionAvailable()) {
    return false;
  }
  try {
    ensureStorageDir();
    const json = JSON.stringify(tokens);
    const encrypted = safeStorage.encryptString(json);
    fs.writeFileSync(tokenFilePath(accountId), encrypted);
    return true;
  } catch {
    return false;
  }
}

export function getTokens(accountId: string): Record<string, string> | null {
  if (!isEncryptionAvailable()) {
    return null;
  }
  try {
    const fp = tokenFilePath(accountId);
    if (!fs.existsSync(fp)) return null;
    const encrypted = fs.readFileSync(fp);
    const json = safeStorage.decryptString(encrypted);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function deleteTokens(accountId: string): boolean {
  try {
    const fp = tokenFilePath(accountId);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
    return true;
  } catch {
    return false;
  }
}

export function deleteAllTokens(): boolean {
  try {
    ensureStorageDir();
    for (const f of fs.readdirSync(STORAGE_DIR)) {
      if (f.endsWith('.enc')) {
        try { fs.unlinkSync(path.join(STORAGE_DIR, f)); } catch {}
      }
    }
    return true;
  } catch {
    return false;
  }
}
