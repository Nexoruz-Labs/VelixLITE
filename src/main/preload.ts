import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('velix', {
  getSettings: () => ipcRenderer.invoke('velix:getSettings'),
  saveSettings: (s: any) => ipcRenderer.invoke('velix:saveSettings', s),
  loginMicrosoft: () => ipcRenderer.invoke('velix:loginMicrosoft'),
  logoutMicrosoft: () => ipcRenderer.invoke('velix:logoutMicrosoft'),
  getAccount: () => ipcRenderer.invoke('velix:getAccount'),
  getVersions: () => ipcRenderer.invoke('velix:getVersions'),
  launchMinecraft: (v: string, account?: any) => ipcRenderer.invoke('velix:launch', v, account),
  onStatus: (cb: (s: string) => void) => {
    ipcRenderer.on('velix:status', (_e, s) => cb(s));
  },
  onProgress: (cb: (p: number) => void) => {
    ipcRenderer.on('velix:progress', (_e, p) => cb(p));
  },
  onLaunchLog: (cb: (l: string) => void) => {
    ipcRenderer.on('velix:launchLog', (_e, l) => cb(l));
  },
  onDone: (cb: () => void) => {
    ipcRenderer.on('velix:done', () => cb());
  },
  removeAllListeners: (ch: string) => ipcRenderer.removeAllListeners(ch),
  getAccounts: () => ipcRenderer.invoke('velix:getAccounts'),
  addAccount: (a: any) => ipcRenderer.invoke('velix:addAccount', a),
  removeAccount: (id: string) => ipcRenderer.invoke('velix:removeAccount', id),
  minimizeWindow: () => ipcRenderer.send('velix:window-minimize'),
  closeWindow: () => ipcRenderer.send('velix:window-close'),
  openExternal: (url: string) => ipcRenderer.invoke('velix:openExternal', url),
  openDonationWindow: (url: string) => ipcRenderer.invoke('velix:openDonationWindow', url),
  getSystemRam: () => ipcRenderer.invoke('velix:getSystemRam'),
  getCurrentResolution: () => ipcRenderer.invoke('velix:getCurrentResolution'),
  validateResolution: (w: number, h: number) => ipcRenderer.invoke('velix:validateResolution', w, h),
  detectJava: () => ipcRenderer.invoke('velix:detectJava'),
});
