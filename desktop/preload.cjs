const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ducksideDesktop', {
  getConfig: () => ipcRenderer.invoke('launcher:get-config'),
  setTheme: (theme) => ipcRenderer.invoke('launcher:set-theme', theme),
  setApiUrl: (url) => ipcRenderer.invoke('launcher:set-api-url', url),
  openSteamAuth: (url) => ipcRenderer.invoke('launcher:open-steam-auth', url),
  installUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('launcher:update-state', listener);
    return () => ipcRenderer.removeListener('launcher:update-state', listener);
  },
  onSteamAuthTicket: (callback) => {
    const listener = (_event, ticket) => callback(ticket);
    ipcRenderer.on('launcher:steam-auth-ticket', listener);
    return () => ipcRenderer.removeListener('launcher:steam-auth-ticket', listener);
  }
});
