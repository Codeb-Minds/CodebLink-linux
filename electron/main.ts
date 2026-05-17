import { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, screen } from 'electron';
import * as path from 'path';
import * as http from 'http';
import { Server } from 'socket.io';
import * as os from 'os';
import * as fs from 'fs';
import * as CryptoJS from 'crypto-js';
import { execSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';

type FilePayload = {
  name: string;
  type?: string;
  data?: string;  // base64 (legacy / small files)
  path?: string;  // local file path (large files)
  url?: string;   // download URL (sent to phone)
};

import { EventEmitter } from 'events';
const ghostBus = new EventEmitter();

// State
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let io: Server | null = null;
let lastClipboardText = readBestClipboardText();
let isQuitting = false;
let syncKey = 'CodebLink-Default-Key';
const pollListeners = new Set<(text: string) => void>();

// 📦 GHOST VAULT: Holds the last message for 60s for phones "between" polls
let ghostVault: { content: string; timestamp: number } | null = null;

// 📁 PENDING DOWNLOADS: token → file path, expires after 10 minutes
const pendingDownloads = new Map<string, { filePath: string; expires: number }>();

// Internal bus: when clipboard changes, tell all long-polling background clients
ghostBus.on('broadcast', (text: string) => {
  // Only fill the vault for plain clipboard text — file payloads are one-shot
  // (they carry a single-use download token) and must NOT be vaulted, otherwise
  // a re-poll after the live listener fires would deliver the same token again
  // and trigger a duplicate download.
  const isFileBroadcast = text.startsWith('{"type":"file"');
  if (!isFileBroadcast) {
    ghostVault = { content: text, timestamp: Date.now() };
  }

  for (const listener of pollListeners) {
    listener(text);
  }
});

const iconPath = path.join(__dirname, 'icon.png');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

// ─── showMainWindow (workspace-shift trick, same as whatsapp project) ────
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }

  const wasVisible = win.isVisible();

  // If visible on another workspace, hide first so it re-appears on the
  // CURRENT workspace (same trick used in the whatsapp project).
  if (wasVisible) {
    win.hide();
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.show();
  win.moveTop();
  win.focus();

  // Unpin after it's safely shown on the current workspace
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
    }
  }, 300);
}


// ─── Single Instance Lock ────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
    startSocketServer();
    startClipboardPolling();
  });
}

// ─── Window ──────────────────────────────────────────────────────────────
function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize || primaryDisplay.size;

  win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.removeMenu();

  win.once('ready-to-show', () => {
    if (win) {
      // Explicitly set window icon on Linux so the taskbar/dock shows it
      if (process.platform === 'linux' && fs.existsSync(iconPath)) {
        const { nativeImage } = require('electron');
        win.setIcon(nativeImage.createFromPath(iconPath));
      }
      win.maximize();
      win.show();
    }
  });

  win.on('close', (event: any) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on('closed', () => { win = null; });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    if (process.env.NODE_ENV !== 'production') {
      win.webContents.openDevTools();
    }
  } else {
    // __dirname is dist-electron/ inside the asar; dist/ is one level up at asar root
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ─── Tray ────────────────────────────────────────────────────────────────
function createTray() {
  if (!fs.existsSync(iconPath)) {
    console.log('Tray icon not found. Add icon.png to enable system tray.');
    return;
  }
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromPath(iconPath);

    if (image.isEmpty()) {
      console.error('Failed to load tray icon: image is empty at', iconPath);
      return;
    }

    // Resize to standard Linux tray icon size (22×22) so it renders cleanly
    const trayImage = image.resize({ width: 22, height: 22 });
    tray = new Tray(trayImage);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Codeb Link',
        click: () => { showMainWindow(); }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          if (tray) { tray.destroy(); tray = null; }
          app.quit();
        }
      },
    ]);

    tray.setToolTip('Codeb Link');
    tray.setContextMenu(contextMenu);

    const closeTrayMenuSoon = () => {
      setTimeout(() => { if (tray) tray.closeContextMenu(); }, 0);
    };

    // Left click → open window on current workspace
    tray.on('click', (event: any) => {
      const button = event && event.button;
      if (button === 2 || button === 'right') return;
      showMainWindow();
      closeTrayMenuSoon();
    });

    // Right click → show context menu
    tray.on('right-click', () => {
      tray!.popUpContextMenu(contextMenu);
    });

    // GNOME extensions may emit only mouse-up for secondary click
    tray.on('mouse-up', (event: any) => {
      const button = event && event.button;
      if (button === 2 || button === 'right') {
        tray!.popUpContextMenu(contextMenu);
      }
    });

  } catch (e) {
    console.warn('Tray failed:', e);
  }
}

let ghostLastSeen = 0;
let lastReportedMode: 'socket' | 'ghost' | 'none' = 'none';

function updateOverallStatus() {
  const isSocketConnected = io ? io.sockets.sockets.size > 0 : false;
  const isGhostActive = (Date.now() - ghostLastSeen) < 40000;

  let currentMode: 'socket' | 'ghost' | 'none' = 'none';
  if (isSocketConnected) currentMode = 'socket';
  else if (isGhostActive) currentMode = 'ghost';

  if (currentMode !== lastReportedMode) {
    lastReportedMode = currentMode;
    win?.webContents.send('overall-connection-status', {
      connected: currentMode !== 'none',
      mode: currentMode
    });
  }
}

// Periodically check pulse
setInterval(updateOverallStatus, 5000);

// ─── Socket.io Server ───────────────────────────────────────────────────
function startSocketServer() {
  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Log EVERY incoming HTTP request for diagnostics
    if (req.url?.startsWith('/api/')) {
      // console.log(`📡 [PC Server] Incoming: ${req.method} ${req.url}`);
    }

    // ── POST /api/clipboard  (Android → PC) ──────────────────────────────
    if (req.method === 'POST' && req.url === '/api/clipboard') {
      ghostLastSeen = Date.now();
      updateOverallStatus();
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const { data } = JSON.parse(body);
          const bytes = CryptoJS.AES.decrypt(data, syncKey);
          const text = bytes.toString(CryptoJS.enc.Utf8);
          if (text && text !== lastClipboardText) {
            lastClipboardText = text;
            writeSystemClipboard(text);
            win?.webContents.send('clipboard-received', text);
            process.stdout.write(`\r📋 [BG Sync] Clipboard received from Android\n`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Failed' }));
        }
      });
      return;

      // ── POST /api/ghost/receipt  (Android → PC confirmation) ─────────────
    } else if (req.method === 'POST' && req.url === '/api/ghost/receipt') {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const { file } = JSON.parse(body);
          process.stdout.write(`\r✅ [Ghost] Phone confirmed receipt of: ${file}\n`);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end();
        }
      });
      return;

      // ── GET /api/clipboard/poll  (PC → Android long-poll) ────────────────
    } else if (req.method === 'GET' && req.url === '/api/clipboard/poll') {
      res.setHeader('Content-Type', 'application/json');
      ghostLastSeen = Date.now();
      updateOverallStatus();

      const sendResponse = (content: string) => {
        let responseBody;
        if (content.startsWith('{"type":"file"')) {
          responseBody = content;
        } else {
          const encrypted = CryptoJS.AES.encrypt(content, syncKey).toString();
          responseBody = JSON.stringify({ data: encrypted });
        }
        res.writeHead(200);
        res.end(responseBody);
        process.stdout.write(`\r🚀 [Ghost] Dispatching update (Vault/Live) ✓\n`);
      };

      // 1. Instant Vault Check
      if (ghostVault && (Date.now() - ghostVault.timestamp < 60000)) {
        sendResponse(ghostVault.content);
        ghostVault = null;
        return;
      }

      process.stdout.write(`\r🛰️ [Ghost] Background device waiting...\n`);

      // Hold connection open until clipboard changes or 25s timeout
      const timeoutId = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(204); // No content — tell phone to re-poll immediately
          res.end();
        }
      }, 25000);

      const onClipChange = (content: string) => {
        clearTimeout(timeoutId);
        if (!res.writableEnded) {
          sendResponse(content);
        }
      };

      pollListeners.add(onClipChange);
      req.on('close', () => {
        clearTimeout(timeoutId);
        pollListeners.delete(onClipChange);
      });

      // ── GET /api/dl/:token  (Phone streams file from PC) ──────────────────
    } else if (req.method === 'GET' && req.url?.startsWith('/api/dl/')) {
      const token = req.url.slice('/api/dl/'.length).split('?')[0];
      const entry = pendingDownloads.get(token);
      if (!entry || Date.now() > entry.expires) {
        pendingDownloads.delete(token);
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      // Consume the token immediately — any concurrent or subsequent request for
      // the same token gets a 404, preventing duplicate downloads.
      pendingDownloads.delete(token);
      try {
        const stat = fs.statSync(entry.filePath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': 'attachment',
        });
        const stream = fs.createReadStream(entry.filePath);
        stream.pipe(res);
        stream.on('error', () => { if (!res.writableEnded) res.end(); });
      } catch (e) {
        res.writeHead(500);
        res.end();
      }
      return;

      // ── Everything else: let socket.io handle ────────────────────────────
    } else if (!req.url?.startsWith('/socket.io')) {
      res.writeHead(404);
      res.end();
    }
  });
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    // Base64 inflates payload size (~33%).
    maxHttpBufferSize: 500 * 1024 * 1024,
    // Extremely generous timeouts to prevent Android power-management from
    // triggering false disconnects during Wi-Fi "naps".
    pingInterval: 10000,
    pingTimeout: 60000,
    connectTimeout: 30000,
    // Explicitly allow both transports for better fallback
    transports: ['polling', 'websocket'],
    allowEIO3: true,
  });

  // Plain WebSocket support for the Native Android Background Service
  // This allows the "Ghost" service to receive updates even when JS is killed.
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/bg-sync') {
      // We can handle plain WS here if needed, but for now 
      // Socket.io already handles the 'upgrade' event.
      // I will ensure the broadcast hits the background service too.
    }
  });

  io.on('connection', (socket: any) => {
    console.log('📱 Connected:', socket.id);
    win?.webContents.send('device-connected', socket.id);

    // Immediately read fresh system clipboard and sync it to the newly connected device
    const freshText = readBestClipboardText();
    if (freshText) {
      lastClipboardText = freshText;
      const encrypted = CryptoJS.AES.encrypt(freshText, syncKey).toString();
      socket.emit('clipboard-received', encrypted);
      console.log('⚡ Initial sync sent to new connection');
    }

    socket.on('sync-key', (key: string, ack?: (result: { ok: boolean; keyId?: string }) => void) => {
      const incoming = typeof key === 'string' ? key : '';
      if (incoming.length > 0) {
        syncKey = incoming;
        const keyId = CryptoJS.MD5(syncKey).toString().slice(0, 8);
        console.log(`🔑 Sync key updated from phone session (id=${keyId})`);
        ack?.({ ok: true, keyId });
        // After key sync, send the latest clipboard snapshot immediately so
        // phone receives at least one known-good encrypted state.
        const current = readBestClipboardText();
        if (current) {
          const encrypted = CryptoJS.AES.encrypt(current, syncKey).toString();
          socket.emit('clipboard-received', encrypted);
        }
      } else {
        ack?.({ ok: false });
      }
    });

    socket.on('clipboard-update', (encryptedData: string) => {
      try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, syncKey);
        const data = bytes.toString(CryptoJS.enc.Utf8);

        if (data && data !== lastClipboardText) {
          lastClipboardText = data;
          writeSystemClipboard(data);
          win?.webContents.send('clipboard-received', data);
        }
      } catch (e) {
        console.error('Decrypt failed');
      }
    });

    socket.on('file-received', (fileData: FilePayload, ack?: (result: { ok: boolean; name?: string; error?: string }) => void) => {
      try {
        const downloadsPath = path.join(os.homedir(), 'Downloads');
        if (!fs.existsSync(downloadsPath)) fs.mkdirSync(downloadsPath, { recursive: true });
        const safeName = sanitizeFileName(fileData.name || `shared_${Date.now()}`);
        const filePath = resolveUniqueFilePath(downloadsPath, safeName);

        // Convert base64 data to buffer
        const buffer = Buffer.from(fileData.data ?? '', 'base64');
        fs.writeFileSync(filePath, buffer);

        console.log(`📂 File saved: ${filePath}`);
        win?.webContents.send('file-saved', { name: path.basename(filePath), path: filePath });
        ack?.({ ok: true, name: path.basename(filePath) });
      } catch (e) {
        console.error('File save failed:', e);
        ack?.({ ok: false, error: e instanceof Error ? e.message : 'File save failed' });
      }
    });

    socket.on('file-delivered-phone', (info: { name?: string; ok?: boolean; error?: string }) => {
      win?.webContents.send('file-delivered-phone', info || {});
    });

    socket.on('phone-log', (line: string) => {
      process.stdout.write(`\r📱 [Phone] ${line}\n`);
    });

    socket.on('disconnect', () => {
      win?.webContents.send('device-disconnected', socket.id);
    });
  });

  server.listen(4321, '0.0.0.0', () => {
    console.log(`✅ Server ready on 4321`);
  });
}

// ─── Clipboard Polling ──────────────────────────────────────────────────
function startClipboardPolling() {
  setInterval(() => {
    try {
      const broadcastClipboard = (text: string) => {
        lastClipboardText = text;
        const encrypted = CryptoJS.AES.encrypt(text, syncKey).toString();
        io?.emit('clipboard-received', encrypted);
        win?.webContents.send('clipboard-received', text);
        // Signal the long-polling HTTP listeners
        ghostBus.emit('broadcast', text);
      };

      const text = readBestClipboardText();
      if (text && text !== lastClipboardText) {
        broadcastClipboard(text);
      }
    } catch (e) {
      console.warn('Polling glitch (ignoring):', e);
    }
  }, 1000);
}

// ─── IPC ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-local-ip', () => getLocalIp());

ipcMain.handle('read-local-clipboard', () => {
  return readBestClipboardText() || '';
});

ipcMain.on('set-sync-key', (_event: any, key: string) => {
  syncKey = key || 'CodebLink-Default-Key';
});

ipcMain.on('send-clipboard', (_event: any, text: string) => {
  if (!text) return;
  // Force update the cache so the next poll doesn't see this as a "new" change
  lastClipboardText = text;
  clipboard.writeText(text);
  const encrypted = CryptoJS.AES.encrypt(text, syncKey).toString();
  // Broadcast to ALL connected phones immediately
  io?.emit('clipboard-received', encrypted);
  ghostBus.emit('broadcast', text);
  console.log('📢 Manual sync: Broad-casted clipboard to phone(s)');
});

ipcMain.on('send-file-to-phone', (_event: any, fileData: FilePayload) => {
  if (!io) return;

  const hasSocketClients = io.sockets.sockets.size > 0;

  if (fileData.path) {
    // Large-file path: generate a one-time download token and let the phone
    // stream the file over HTTP — no base64 buffering in memory on either side.
    const token = crypto.randomBytes(16).toString('hex');
    pendingDownloads.set(token, { filePath: fileData.path, expires: Date.now() + 10 * 60 * 1000 });
    const localIp = getLocalIp();
    const url = `http://${localIp}:4321/api/dl/${token}`;
    io.emit('file-to-phone', { name: fileData.name, type: fileData.type, url });
    // Ghost mode: only broadcast via HTTP poll when no socket client is connected —
    // a connected phone receives the file via socket above; double-emitting causes duplicates.
    if (!hasSocketClients) {
      ghostBus.emit('broadcast', JSON.stringify({ type: 'file', name: fileData.name, mimeType: fileData.type, url }));
    }
    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  } else if (fileData.data) {
    // Legacy base64 path (kept for backward compat / very small files)
    io.emit('file-to-phone', { name: fileData.name, type: fileData.type, data: fileData.data });
    if (!hasSocketClients) {
      const ghostPayload = { type: 'file', name: fileData.name, data: fileData.data };
      ghostBus.emit('broadcast', JSON.stringify(ghostPayload));
    }
    win?.webContents.send('file-send-status', { ok: true, name: fileData.name });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const net = interfaces[name];
    if (net) {
      for (const iface of net) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function tryReadCommand(command: string): string {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
      maxBuffer: 1024 * 1024,
    });
    return output.trim();
  } catch {
    return '';
  }
}

// Write text to the system clipboard in a way that BOTH X11 and Wayland-native
// apps can read it. Electron's clipboard.writeText() only writes to the XWayland
// buffer; wl-copy (or xclip) propagates it to the Wayland clipboard protocol.
function writeSystemClipboard(text: string): void {
  clipboard.writeText(text); // X11 / Electron fallback
  if (process.platform !== 'linux') return;
  const r = spawnSync('wl-copy', [], {
    input: text,
    encoding: 'utf8',
    timeout: 1000,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (r.status !== 0) {
    spawnSync('xclip', ['-selection', 'clipboard'], {
      input: text,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  }
}

function readBestClipboardText(): string {
  const direct = clipboard.readText('clipboard').trim();
  if (direct) return direct;
  if (process.platform !== 'linux') return '';

  // Wayland clipboard backend
  const wl = tryReadCommand('wl-paste -n');
  if (wl) return wl;

  // X11 clipboard backend
  const xclip = tryReadCommand('xclip -selection clipboard -o');
  if (xclip) return xclip;
  const xsel = tryReadCommand('xsel --clipboard --output');
  if (xsel) return xsel;

  return '';
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || `shared_${Date.now()}`;
}

function resolveUniqueFilePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  let n = 0;
  while (true) {
    const candidateName = n === 0 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const candidatePath = path.join(dir, candidateName);
    if (!fs.existsSync(candidatePath)) return candidatePath;
    n += 1;
  }
}

// ─── App Lifecycle ────────────────────────────────────────────────────────
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) tray.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep alive for tray
  }
});

app.on('activate', () => {
  if (win === null) createWindow();
});
