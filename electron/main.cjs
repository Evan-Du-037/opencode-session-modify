const { app, BrowserWindow, Menu, dialog, ipcMain, clipboard, session } = require('electron');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { runtimeEnv, findExecutable, startBackend } = require('./runtime.cjs');

app.setName('OpenCode Session Editor');
let mainWindow;
let backend;
let quitting = false;
let cleanedUp = false;
let pendingSession = process.argv.find(arg => /^ses_[\w-]+$/.test(arg));

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trustedSender(event) {
  return mainWindow && event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === backend?.url;
}

function reportFailure(error) {
  if (quitting) return;
  dialog.showErrorBox('无法运行 OpenCode Session Editor', error.message || String(error));
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const sid = argv.find(arg => /^ses_[\w-]+$/.test(arg));
    if (sid && !mainWindow) pendingSession = sid;
    focusWindow();
  });
  app.on('activate', focusWindow);
  app.on('window-all-closed', () => app.quit());
  // will-quit runs after the window's unsaved-edit check has allowed closing.
  app.on('will-quit', event => {
    if (!backend || cleanedUp) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    backend.stop().finally(() => { cleanedUp = true; app.quit(); });
  });

  app.whenReady().then(async () => {
    const env = runtimeEnv();
    const backendDir = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(__dirname, '..');
    const bun = app.isPackaged
      ? path.join(backendDir, 'bun')
      : findExecutable('bun', env, env.OCEDIT_BUN);
    const opencode = findExecutable('opencode', env, env.OCEDIT_OPENCODE);
    const token = randomBytes(32).toString('hex');
    backend = await startBackend({
      bun, opencode, sourceDir: path.join(backendDir, 'src'), env, token,
      onExit: reportFailure,
    });

    const windowSession = session.fromPartition('ocedit-desktop');
    windowSession.webRequest.onBeforeSendHeaders({ urls: [`${backend.url}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, 'X-Ocedit-Token': token } });
    });
    windowSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    windowSession.setPermissionCheckHandler(() => false);

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '显示', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    ]));

    mainWindow = new BrowserWindow({
      title: app.name,
      width: 1240, height: 860, minWidth: 760, minHeight: 520,
      backgroundColor: '#1a1a1a', show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        session: windowSession,
      },
    });
    mainWindow.once('ready-to-show', focusWindow);
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== backend.url) event.preventDefault();
    });
    mainWindow.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', title: '有尚未保存的修改',
        message: '离开后，尚未保存的修改将丢失。',
        buttons: ['继续编辑', '放弃修改并离开'], defaultId: 0, cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
    });

    ipcMain.handle('pick-directory', async event => {
      if (!trustedSender(event)) throw new Error('Untrusted sender');
      const result = await dialog.showOpenDialog(mainWindow, { title: '选择会话目录', properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('copy-text', (event, text) => {
      if (!trustedSender(event) || typeof text !== 'string') throw new Error('Invalid clipboard request');
      clipboard.writeText(text);
    });

    const url = new URL(backend.url);
    if (pendingSession) url.searchParams.set('session', pendingSession);
    await mainWindow.loadURL(url.href);
  }).catch(reportFailure);
}
