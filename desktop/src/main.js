const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, shell } = require('electron');

const METRICS_INTERVAL_MS = 60_000;
const METRICS_RING_SIZE = 20;
const RELOAD_WINDOW_MS = 10 * 60_000;
const RELOAD_LIMIT = 5;
// The renderer cannot bound its own raster memory, and Chromium purges its caches
// only when something tells it memory is short - on macOS that signal arrives once
// the machine is already thrashing. So bound the tile budget at start-up, and apply
// the pressure from here, where the renderer's footprint is actually measured.
const TILE_BUDGET_MB = 1024;
const TAB_PURGE_MB = 1400;
const TAB_RECYCLE_MB = 3000;
const PURGE_COOLDOWN_MS = 60_000;

app.commandLine.appendSwitch('force-gpu-mem-available-mb', String(TILE_BUDGET_MB));

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
let metricsRing = [];
let metricsLogPath;
let windowOpenedAt = 0;
let reloadTimes = [];
let lastReportStatus = 0;
let lastReportError = '';
let lastPurgeAt = 0;

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
  windowOpenedAt = Date.now();

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

  // The renderer dies on its own memory limit, and Electron then leaves the window
  // white until the app is restarted. Record why it died and bring the page back.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logDesktopLine(
      `desktop-crash renderer-gone reason=${details.reason} exit=${details.exitCode} up=${secondsOpen()}s ring=${metricsRing.slice(-5).join(' || ')}`,
    );
    recoverRenderer();
  });

  mainWindow.webContents.on('unresponsive', () => {
    logDesktopLine(
      `desktop-hang renderer-unresponsive up=${secondsOpen()}s ring=${metricsRing.slice(-3).join(' || ')}`,
    );
  });

  mainWindow.webContents.on('responsive', () => {
    logDesktopLine('desktop-hang renderer-responsive');
  });

  // The GPU and utility processes die separately from the page.
  app.on('child-process-gone', (_event, details) => {
    logDesktopLine(`desktop-crash child-gone type=${details.type} reason=${details.reason} exit=${details.exitCode}`);
  });

  // The page samples its own JS heap. The main process, the renderer process and
  // the GPU process are invisible from there, so sample them here.
  mainWindow.webContents.once('did-finish-load', () => setTimeout(reportMainMetrics, 5_000));
}

function secondsOpen() {
  return Math.round((Date.now() - windowOpenedAt) / 1000);
}

function metricsLine() {
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
  const err = lastReportError ? ` err=${lastReportError.replaceAll(' ', '_')}` : '';
  return `main-mem rss=${rss}MB posted=${lastReportStatus}${err} | ${procs}`;
}

// Every sample goes to a file as well as to the server, because a renderer that
// dies cannot send its own last line, and an app that crashes cannot either. The
// file outlives both and can be read on the machine that shows the fault.
function logDesktopLine(line) {
  metricsRing.push(line);
  if (metricsRing.length > METRICS_RING_SIZE) metricsRing.shift();

  if (metricsLogPath) {
    try {
      fs.appendFileSync(metricsLogPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // A full disk must not take the app down with it.
    }
  }

  sendDesktopLine(line);
}

// Sent from the main process, not from the page: a dead renderer cannot send its
// own last line. The cookies are read from the window's session and set by hand,
// because the request has to carry the Cloudflare Access session to reach the log
// endpoint, and the outcome is kept so a failure is visible in the next line.
async function sendDesktopLine(line) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const url = new URL('/api/pwa-log', currentApp.url).toString();
    const cookies = await mainWindow.webContents.session.cookies.get({ url });
    const headers = { 'Content-Type': 'application/json' };
    if (cookies.length > 0) {
      headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }

    const body = JSON.stringify({ msg: line, ts: new Date().toISOString() });
    const response = await fetch(url, { method: 'POST', headers, body });
    lastReportStatus = response.status;
    lastReportError = '';
  } catch (err) {
    lastReportStatus = -1;
    lastReportError = err instanceof Error ? err.message : String(err);
  }
}

function recoverRenderer() {
  const now = Date.now();
  reloadTimes = reloadTimes.filter((at) => now - at < RELOAD_WINDOW_MS);
  if (reloadTimes.length >= RELOAD_LIMIT) {
    logDesktopLine(`desktop-crash reload-skipped reloads=${reloadTimes.length} in ${RELOAD_WINDOW_MS / 60000}min`);
    return;
  }

  reloadTimes.push(now);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  }, 500);
}

// The Tab entry in the app metrics is the page renderer: the process that holds the
// transcript, its layout objects and its raster tiles.
function tabWorkingSetMb() {
  const metric = app.getAppMetrics().find((m) => m.type === 'Tab');
  if (!metric || !metric.memory) return 0;
  return Math.round(metric.memory.workingSetSize / 1024);
}

// Ask Chromium to release what it is holding. It answers a pressure signal by
// lowering its internal caches and collecting, which is the release that otherwise
// never happens until the machine is out of memory and the process hits its ceiling.
// A notification in the middle of a paint is cheaper than a dead renderer.
async function purgeRenderer(reason, mb) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (Date.now() - lastPurgeAt < PURGE_COOLDOWN_MS) return;
  lastPurgeAt = Date.now();

  try {
    const dbg = mainWindow.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Memory.simulatePressureNotification', { level: 'critical' });
    await dbg.sendCommand('Memory.forciblyPurgeJavaScriptMemory');
    if (dbg.isAttached()) dbg.detach();
    logDesktopLine(`tab-purge reason=${reason} ws=${mb}MB`);
  } catch (err) {
    logDesktopLine(`tab-purge-failed reason=${err instanceof Error ? err.message : String(err)}`);
  }
}

function reportMainMetrics() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  logDesktopLine(metricsLine());

  // Keep the renderer under the ceiling that kills it. A reload below is the same
  // path a crash takes, so one budget covers both, and a controlled reload costs a
  // few seconds instead of a white window.
  const tab = tabWorkingSetMb();
  if (tab >= TAB_RECYCLE_MB) {
    logDesktopLine(`tab-recycle ws=${tab}MB`);
    recoverRenderer();
    return;
  }
  if (tab >= TAB_PURGE_MB) purgeRenderer('high', tab);
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
  metricsLogPath = path.join(app.getPath('userData'), 'orchestrel-desktop-metrics.log');
  logDesktopLine(
    `desktop-start tileBudget=${TILE_BUDGET_MB}MB purgeAt=${TAB_PURGE_MB}MB recycleAt=${TAB_RECYCLE_MB}MB electron=${process.versions.electron} chrome=${process.versions.chrome}`,
  );
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
