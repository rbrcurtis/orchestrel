const path = require('node:path');
const { app, BrowserWindow, Menu, shell } = require('electron');

const apps = {
  orchestrel: {
    name: 'Orchestrel',
    url: 'https://orchestrel.com',
  },
  'orc-chat': {
    name: 'Orc Chat',
    url: 'https://orchestrel.com/chat/19/',
  },
};

const target = getTarget();
const currentApp = apps[target] || apps.orchestrel;
const internalHosts = new Set(['localhost', '127.0.0.1', 'orchestrel.com', 'wednesday-access.cloudflareaccess.com']);

app.setName(currentApp.name);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    title: currentApp.name,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(currentApp.url);

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(currentApp.name);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key.toLowerCase() === 'r' && input.meta) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      return { action: 'allow' };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-navigate', (_event, url) => {
    if (shouldReturnToChat(url)) {
      mainWindow.loadURL(currentApp.url);
    }
  });
}

function getTarget() {
  if (process.env.ORCHESTREL_TARGET) {
    return process.env.ORCHESTREL_TARGET;
  }

  const executableName = path.basename(process.execPath, path.extname(process.execPath));
  if (executableName.toLowerCase() === 'orc chat') {
    return 'orc-chat';
  }

  return 'orchestrel';
}

function shouldReturnToChat(url) {
  if (target !== 'orc-chat') {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === 'orchestrel.com' && parsedUrl.pathname === '/';
  } catch {
    return false;
  }
}

function isInternalUrl(url) {
  try {
    return internalHosts.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
