const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');

const METRICS_INTERVAL_MS = 60_000;

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

  // The web app can only sample its own renderer JS heap. The main process and
  // the GPU process are invisible from there, so sample them here and forward
  // the line to the same endpoint through the renderer.
  mainWindow.webContents.once('did-finish-load', () => setTimeout(reportMainMetrics, 5_000));
}

function reportMainMetrics() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const procs = app
    .getAppMetrics()
    .map((m) => {
      if (!m.memory) return `${m.type} ws=n/a`;
      const ws = Math.round(m.memory.workingSetSize / 1024);
      const peak = Math.round(m.memory.peakWorkingSetSize / 1024);
      return `${m.type} ws=${ws}MB peak=${peak}MB cpu=${m.cpu.percentCPUUsage.toFixed(1)}%`;
    })
    .join(' | ');

  const rss = Math.round(process.memoryUsage().rss / 1048576);
  const payload = JSON.stringify({ msg: `main-mem rss=${rss}MB | ${procs}`, ts: new Date().toISOString() });
  mainWindow.webContents
    .executeJavaScript(`navigator.sendBeacon('/api/pwa-log', ${JSON.stringify(payload)})`)
    .catch(() => {});
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
  createWindow();
  setInterval(reportMainMetrics, METRICS_INTERVAL_MS);

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
