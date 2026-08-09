import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import { registerIpcHandlers } from './ipc';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;

const iconPath = path.join(__dirname, 'icon.png');
const icoPath = path.join(__dirname, 'icon.ico');

function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    resizable: false,
    movable: true,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    show: true,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  splashWindow.setMenu(null);
  splashWindow.loadFile(path.join(__dirname, '../renderer/splash.html'));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 760,
    maxWidth: 760,
    minHeight: 560,
    maxHeight: 560,
    resizable: true,
    frame: false,
    title: 'VelixLITE',
    icon: process.platform === 'win32' ? icoPath : iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#FBF3DC',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
        splashWindow = null;
      }
      mainWindow?.show();
    }, 3000);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerWindowControls(): void {
  ipcMain.on('velix:window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('velix:window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('velix:openExternal', async (_e, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('velix:openDonationWindow', async (_e, url: string) => {
    const win = new BrowserWindow({
      width: 500,
      height: 740,
      title: 'Donate to VelixLITE',
      icon: iconPath,
      autoHideMenuBar: true,
      minimizable: true,
      maximizable: true,
      closable: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenu(null);
    await win.loadURL(url);
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.velixlite.app');
  }
  registerIpcHandlers();
  registerWindowControls();
  createSplash();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
