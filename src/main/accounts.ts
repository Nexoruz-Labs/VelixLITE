import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface StoredAccount {
  id: string;
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
}

const accountsPath = path.join(app.getPath('userData'), 'accounts.json');

export function getAccounts(): StoredAccount[] {
  try {
    const data = fs.readFileSync(accountsPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: StoredAccount[]): void {
  const dir = path.dirname(accountsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), 'utf-8');
}

export function addAccount(account: StoredAccount): { success: boolean; error?: string } {
  const accounts = getAccounts();
  const dup = accounts.find(a => a.username === account.username && a.type === account.type);
  if (dup) return { success: false, error: 'Account "' + account.username + '" already exists' };
  const filtered = accounts.filter(a => a.id !== account.id);
  filtered.push(account);
  saveAccounts(filtered);
  return { success: true };
}

export function removeAccount(id: string): void {
  const accounts = getAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
}
