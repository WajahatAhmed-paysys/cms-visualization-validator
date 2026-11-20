'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const config = require('../src/config');
const { runValidation, createContext, authenticate } = require('../src/core/executor');
const { buildUiPayload, buildVerifyPayload } = require('./payload');
const { buildArtifact, toMarkdown, buildVerifyArtifact, toVerifyMarkdown } = require('../src/core/report');
const { runVerify } = require('../src/verify/verifier');
const { http } = require('../src/lib/http');

let mainWindow = null;
let lastRun = null;
let lastVerify = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0b1118',
    title: 'CMS Visualization Data Validator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const hash = process.env.SMOKE_HASH || (process.argv.includes('--demo') ? 'demo' : null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), hash ? { hash } : undefined);

  // Open external links in the OS browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Optional headless smoke test: loads the renderer, prints a marker, quits.
  if (process.env.SMOKE_TEST === '1') {
    const wc = mainWindow.webContents;
    wc.on('did-finish-load', async () => {
      try {
        const stats = await wc.executeJavaScript(`(() => {
          const rowToggle = document.querySelector('.row-toggle');
          if (rowToggle) rowToggle.click();
          const firstBody = document.querySelector('.row-body');
          const rowExpanded = firstBody ? !firstBody.classList.contains('hidden') : null;
          const respToggle = Array.from(document.querySelectorAll('.resp-toggle')).find((b) => b.textContent.startsWith('Response'));
          if (respToggle) respToggle.click();
          const firstResp = document.querySelector('pre.resp');
          const respExpanded = firstResp ? !firstResp.classList.contains('hidden') : null;
          const respPreview = firstResp ? firstResp.textContent.slice(0, 60) : null;
          return {
            heading: (document.querySelector('h1') || {}).textContent || null,
            cards: document.querySelectorAll('.card').length,
            rows: document.querySelectorAll('.row').length,
            queries: document.querySelectorAll('.query').length,
            chips: Array.from(document.querySelectorAll('.chip')).map((c) => c.className.replace('chip ', '')),
            badges: Array.from(document.querySelectorAll('.badge')).map((b) => b.className.replace('badge ', '')),
            rowExpanded,
            respExpanded,
            respPreview,
            hasSaveButtons: Boolean(document.getElementById('saveJsonBtn') && document.getElementById('saveMdBtn')),
            hasE2eField: Boolean(document.getElementById('e2e')),
            viewButtons: document.querySelectorAll('.viewBtn').length,
            fieldRows: document.querySelectorAll('.fieldTable tbody tr').length,
            passRows: document.querySelectorAll('.fieldTable tbody tr.pass').length,
            failRows: document.querySelectorAll('.fieldTable tbody tr.fail').length,
            attemptsShown: Array.from(document.querySelectorAll('.qsub')).some((s) => /^x\d+$/.test(s.textContent)),
            sqlShown: Array.from(document.querySelectorAll('pre.resp')).some((p) => p.textContent.includes('# SQL:')),
            banner: (document.getElementById('banner') || {}).textContent || null
          };
        })()`);
        console.log('SMOKE_DOM ' + JSON.stringify(stats));
        if (process.env.SMOKE_SHOT) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const image = await wc.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT, image.toPNG());
          console.log(`SMOKE_SHOT_SAVED ${process.env.SMOKE_SHOT}`);
        }
        console.log('SMOKE_OK: renderer loaded');
      } catch (error) {
        console.error('SMOKE_CAPTURE_ERROR', error.message);
      }
      setTimeout(() => app.quit(), 300);
    });
    wc.on('did-fail-load', (_event, code, description) => {
      console.error('SMOKE_FAIL', code, description);
      app.quit();
    });
    setTimeout(() => {
      console.error('SMOKE_TIMEOUT');
      app.quit();
    }, 10000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  cmsBaseUrl: config.cmsBaseUrl,
  lakehouseBaseUrl: config.lakehouseBaseUrl,
  tenantId: config.tenantId,
  granularity: config.granularity,
  roles: config.roles,
  requestTimeoutMs: config.requestTimeoutMs,
  concurrency: config.concurrency,
  username: config.username ? config.username.replace(/(.).*(@.*)/, '$1***$2') : ''
}));

ipcMain.handle('validate:run', async (_event, input) => {
  try {
    const result = await runValidation({
      alertId: input.alertId,
      tenantId: input.tenantId,
      granularity: input.granularity,
      roles: input.roles,
      mode: input.mode,
      requestTimeoutMs: input.maxWaitMs,
      concurrency: input.concurrency,
      retryTransient: input.retryTransient
    });
    lastRun = result;
    return { ok: true, payload: buildUiPayload(result) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('report:save', async (_event, format) => {
  if (!lastRun) return { ok: false, error: 'No completed run to save yet.' };
  const ext = format === 'md' ? 'md' : 'json';
  const suggested = `run-${lastRun.runId.replace(/[:.]/g, '-')}.${ext}`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: ext === 'json' ? 'Save run JSON' : 'Save run Markdown',
    defaultPath: `${config.reportDir}/${suggested}`,
    filters:
      ext === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    if (ext === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(buildArtifact(lastRun, { storeFullResponses: false }), null, 2), 'utf8');
    } else {
      fs.writeFileSync(filePath, toMarkdown(lastRun), 'utf8');
    }
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('verify:run', async (_event, input) => {
  try {
    const result = await runVerify({
      alertId: input.alertId,
      tenantId: input.tenantId,
      granularity: input.granularity,
      roles: input.roles,
      concurrency: input.concurrency,
      requestTimeoutMs: input.maxWaitMs,
      e2eId: input.e2eId,
      verifyTolerance: input.tolerance
    });
    lastVerify = result;
    return { ok: true, payload: buildVerifyPayload(result) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('verify:save', async (_event, format) => {
  if (!lastVerify) return { ok: false, error: 'No completed verify run to save yet.' };
  const ext = format === 'md' ? 'md' : 'json';
  const suggested = `verify-${lastVerify.runId.replace(/[:.]/g, '-')}.${ext}`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: ext === 'json' ? 'Save verify JSON' : 'Save verify Markdown',
    defaultPath: `${config.reportDir}/${suggested}`,
    filters: ext === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(
      filePath,
      ext === 'json' ? JSON.stringify(buildVerifyArtifact(lastVerify), null, 2) : toVerifyMarkdown(lastVerify),
      'utf8'
    );
    return { ok: true, filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('diagnostics:health', async () => {
  try {
    const ctx = createContext({ alertId: 1, mode: 'cms' });
    await authenticate(ctx);
    const headers = { Authorization: `Bearer ${ctx.token}` };
    const health = await http({ method: 'GET', url: `${config.lakehouseBaseUrl}/health`, headers });
    const tables = await http({ method: 'GET', url: `${config.lakehouseBaseUrl}/tables`, headers });
    const tableCount = extractTableCount(tables.body);
    return {
      ok: true,
      login: true,
      healthOk: health.ok,
      health: health.body || null,
      tablesOk: tables.ok,
      tableCount
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function extractTableCount(body) {
  if (!body) return 0;
  if (Array.isArray(body.available_tables)) return body.available_tables.length;
  if (Array.isArray(body.tables)) return body.tables.length;
  if (Array.isArray(body.data)) return body.data.length;
  return 0;
}
