const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs/promises');
const path = require('node:path');

const productionApiUrl = 'https://api.ducksidestudios.com';
const localApiUrl = 'http://localhost:3040';
let mainWindow;
let queuedSteamTicket = null;

function receiveSteamCallback(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'duckside-launcher:' || url.hostname !== 'steam-auth') return;
    const ticket = url.searchParams.get('ticket');
    if (!ticket || !/^[\w-]{32,80}$/.test(ticket)) return;
    queuedSteamTicket = ticket;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send('launcher:steam-auth-ticket', ticket);
      queuedSteamTicket = null;
    }
  } catch {}
}

function publishUpdateState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:update-state', state);
}

function configPath() {
  return path.join(app.getPath('userData'), 'launcher-config.json');
}

function defaultConfig() {
  return {
    apiBaseUrl: app.isPackaged ? productionApiUrl : localApiUrl,
    selectedTheme: 'duck-gold'
  };
}

async function readConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(await fs.readFile(configPath(), 'utf8')) };
  } catch {
    return defaultConfig();
  }
}

async function writeConfig(next) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function isAllowedApiUrl(value) {
  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return url.protocol === 'https:' || isLocalHttp;
  } catch {
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 780,
    minWidth: 1100,
    minHeight: 660,
    backgroundColor: '#100b04',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  window.loadFile(path.join(__dirname, '..', 'index.html'));
  window.webContents.on('did-finish-load', () => {
    if (queuedSteamTicket) {
      window.webContents.send('launcher:steam-auth-ticket', queuedSteamTicket);
      queuedSteamTicket = null;
    }
  });
  mainWindow = window;
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();

app.whenReady().then(() => {
  if (!ownsSingleInstanceLock) return;
  app.setAppUserModelId('com.ducksidestudios.launcher');
  app.setAsDefaultProtocolClient('duckside-launcher');
  ipcMain.handle('launcher:get-config', readConfig);
  ipcMain.handle('launcher:set-theme', async (_event, theme) => {
    const allowed = new Set(['duck-gold', 'black', 'night-raid', 'toxic-mist']);
    if (!allowed.has(theme)) throw new Error('Tema inválido');
    return writeConfig({ ...(await readConfig()), selectedTheme: theme });
  });
  ipcMain.handle('launcher:set-api-url', async (_event, apiBaseUrl) => {
    if (!isAllowedApiUrl(apiBaseUrl)) throw new Error('A API precisa usar HTTPS; HTTP só é aceito para localhost.');
    return writeConfig({ ...(await readConfig()), apiBaseUrl });
  });
  ipcMain.handle('launcher:open-steam-auth', async (_event, value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.pathname !== '/openid/login') throw new Error('Endereço Steam inválido');
    await shell.openExternal(url.href);
  });
  ipcMain.handle('launcher:install-update', () => autoUpdater.quitAndInstall());
  createWindow();
  if (process.argv.length) receiveSteamCallback(process.argv.find(arg => arg.startsWith('duckside-launcher://')) || '');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', info => publishUpdateState({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'current' }));
  autoUpdater.on('download-progress', progress => publishUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', info => publishUpdateState({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', error => publishUpdateState({ status: 'error', message: error.message }));
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(error => publishUpdateState({ status: 'error', message: error.message }));
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('open-url', (event, value) => { event.preventDefault(); receiveSteamCallback(value); });
app.on('second-instance', (_event, commandLine) => receiveSteamCallback(commandLine.find(arg => arg.startsWith('duckside-launcher://')) || ''));

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
