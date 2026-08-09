import { BrowserWindow } from 'electron';
import { storeTokens, getTokens, deleteTokens } from './secureStorage';

const CLIENT_ID = '00000000402b5328';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const AUTH_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

export interface Account {
  type: 'microsoft' | 'offline';
  username: string;
  uuid?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  xuid?: string;
}

function interceptAuthCode(window: BrowserWindow): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Login timed out'));
    }, 300000);

    window.webContents.on('will-redirect', (_e, url) => {
      if (url.startsWith(REDIRECT_URI)) {
        clearTimeout(timeout);
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        if (code) resolve(code);
        else reject(new Error(error || 'No auth code received'));
      }
    });

    window.webContents.on('will-navigate', (_e, url) => {
      if (url.startsWith(REDIRECT_URI)) {
        clearTimeout(timeout);
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        if (code) resolve(code);
        else reject(new Error(error || 'No auth code received'));
      }
    });
  });
}

async function exchangeCodeForToken(code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: 'service::user.auth.xboxlive.com::MBI_SSL',
  }).toString();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error('Token exchange failed: ' + res.status);
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    redirect_uri: REDIRECT_URI,
    grant_type: 'refresh_token',
  }).toString();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error('Token refresh failed: ' + res.status);
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
}

async function authenticateWithXBL(accessToken: string): Promise<string> {
  const rpsBody = (rpsTicket: string) => JSON.stringify({
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: rpsTicket },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  let res = await fetch(XBL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: rpsBody(accessToken),
  });

  if (res.status === 400) {
    res = await fetch(XBL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: rpsBody(`d=${accessToken}`),
    });
  }

  if (!res.ok) throw new Error('XBL auth failed: ' + res.status);
  const data = await res.json();
  return data.Token;
}

async function authenticateWithXSTS(xblToken: string): Promise<{ token: string; userHash: string; xuid: string }> {
  const res = await fetch(XSTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
  });

  if (!res.ok) throw new Error('XSTS auth failed: ' + res.status);
  const data = await res.json();
  const xui = data.DisplayClaims.xui[0] || {};
  return { token: data.Token, userHash: xui.uhs || '', xuid: xui.xid || '' };
}

async function authenticateWithMinecraft(xstsToken: string, userHash: string): Promise<string> {
  const res = await fetch(MC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xstsToken}` }),
  });

  if (!res.ok) throw new Error('Minecraft auth failed: ' + res.status);
  const data = await res.json();
  return data.access_token;
}

async function getProfile(mcToken: string): Promise<{ id: string; name: string }> {
  const res = await fetch(PROFILE_URL, {
    headers: { 'Authorization': `Bearer ${mcToken}` },
  });

  if (!res.ok) throw new Error('Failed to get profile: ' + res.status);
  const data = await res.json();
  return { id: data.id, name: data.name };
}

export async function microsoftLogin(): Promise<Account> {
  const loginWindow = new BrowserWindow({
    width: 600,
    height: 700,
    title: 'Microsoft Login',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  loginWindow.setMenu(null);

  const codePromise = interceptAuthCode(loginWindow);

  const authUrl = `${AUTH_URL}?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('service::user.auth.xboxlive.com::MBI_SSL')}&lw=1&fl=dob,easi2&xsup=1&nopa=2&prompt=login`;

  loginWindow.loadURL(authUrl);

  const code = await codePromise;
  loginWindow.close();

  const tokens = await exchangeCodeForToken(code);
  const xblToken = await authenticateWithXBL(tokens.accessToken);
  const xsts = await authenticateWithXSTS(xblToken);
  const mcToken = await authenticateWithMinecraft(xsts.token, xsts.userHash);
  const profile = await getProfile(mcToken);

  const account: Account = {
    type: 'microsoft',
    username: profile.name,
    uuid: profile.id,
    accessToken: mcToken,
    refreshToken: tokens.refreshToken,
    clientId: CLIENT_ID,
    xuid: xsts.xuid,
  };

  return account;
}

export async function refreshMicrosoftAccount(accountId: string): Promise<Account | null> {
  const storedTokens = getTokens(accountId);
  if (!storedTokens?.refreshToken) return null;

  try {
    const tokens = await refreshAccessToken(storedTokens.refreshToken);
    const xblToken = await authenticateWithXBL(tokens.accessToken);
    const xsts = await authenticateWithXSTS(xblToken);
    const mcToken = await authenticateWithMinecraft(xsts.token, xsts.userHash);
    const profile = await getProfile(mcToken);

    const account: Account = {
      type: 'microsoft',
      username: profile.name,
      uuid: profile.id,
      accessToken: mcToken,
      refreshToken: tokens.refreshToken,
      clientId: CLIENT_ID,
      xuid: xsts.xuid,
    };

    return account;
  } catch {
    return null;
  }
}

export function getStoredAccount(): Account | null {
  return null;
}

export function logout(): void {
}
