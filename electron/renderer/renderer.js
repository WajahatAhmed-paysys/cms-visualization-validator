'use strict';

const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  AVAILABLE: 'AVAILABLE',
  EMPTY: 'EMPTY',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  SKIPPED: 'SKIPPED',
  VERIFIED: 'VERIFIED',
  MISMATCH: 'MISMATCH',
  NOT_COMPARABLE: 'NOT_COMPARABLE'
};

let info = null;
let running = false;
let currentView = 'availability';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.validator
  .info()
  .then((data) => {
    info = data;
    $('tenant').value = data.tenantId || 'DEFAULT';
    $('granularity').value = data.granularity || 'month';
    $('maxWait').value = Math.max(5, Math.round((data.requestTimeoutMs || 35000) / 1000));
    $('concurrency').value = data.concurrency || 2;
    const roles = data.roles || ['creditor', 'debtor'];
    $('roleCreditor').checked = roles.includes('creditor');
    $('roleDebtor').checked = roles.includes('debtor');
    setConnection(true);
  })
  .catch((error) => setConnection(false, error.message));

function setConnection(ok, detail) {
  const el = $('conn');
  if (ok) {
    el.textContent = `${info.cmsBaseUrl}  →  ${info.lakehouseBaseUrl}`;
    el.className = 'conn ok';
  } else {
    el.textContent = `Configuration error: ${detail || 'unknown'}`;
    el.className = 'conn err';
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

$('healthBtn').addEventListener('click', async () => {
  $('healthBtn').disabled = true;
  showBanner('Testing connection…', 'warn');
  try {
    const res = await window.validator.health();
    if (!res.ok) {
      showBanner(`Connection failed: ${res.error}`, 'error');
    } else {
      const healthy = res.healthOk ? 'Lakehouse healthy' : 'Lakehouse degraded';
      showBanner(`CMS login OK · ${healthy} · ${res.tableCount} tables available`, res.healthOk ? 'info' : 'warn');
    }
  } catch (error) {
    showBanner(`Connection failed: ${error.message}`, 'error');
  } finally {
    $('healthBtn').disabled = false;
  }
});

$('runBtn').addEventListener('click', runValidation);

$('saveJsonBtn').addEventListener('click', () => saveReport('json'));
$('saveMdBtn').addEventListener('click', () => saveReport('md'));

$('viewAvailability').addEventListener('click', () => setView('availability'));
$('viewVerify').addEventListener('click', () => setView('verify'));

function setView(view) {
  currentView = view;
  $('viewAvailability').classList.toggle('active', view === 'availability');
  $('viewVerify').classList.toggle('active', view === 'verify');
  $('modeField').classList.toggle('hidden', view === 'verify');
  $('toleranceField').classList.toggle('hidden', view !== 'verify');
  $('runBtn').textContent = view === 'verify' ? 'Run verify' : 'Run validation';
  $('cards').replaceChildren();
  hideEl('summary');
  setSaveEnabled(false);
  hideBanner();
  const emptyP = document.querySelector('#emptyState p');
  if (emptyP) {
    emptyP.textContent =
      view === 'verify'
        ? 'Enter an alert id and press Run verify to compare raw API data against what the CMS shows.'
        : 'Enter an alert id and press Run validation.';
  }
  showEl('emptyState');
}

async function saveReport(format) {
  try {
    const res =
      currentView === 'verify'
        ? await window.validator.saveVerifyReport(format)
        : await window.validator.saveReport(format);
    if (res.canceled) return;
    if (!res.ok) {
      showBanner(`Save failed: ${res.error}`, 'error');
      return;
    }
    showBanner(`Saved: ${res.filePath}`, 'info');
  } catch (error) {
    showBanner(`Save failed: ${error.message}`, 'error');
  }
}

function setSaveEnabled(enabled) {
  $('saveJsonBtn').disabled = !enabled;
  $('saveMdBtn').disabled = !enabled;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'INPUT') {
    runValidation();
  }
});

async function runValidation() {
  if (running) return;

  const alertId = Number($('alertId').value);
  if (!Number.isFinite(alertId) || alertId <= 0) {
    showBanner('Enter a valid numeric alert id.', 'error');
    return;
  }

  const roles = [];
  if ($('roleCreditor').checked) roles.push('creditor');
  if ($('roleDebtor').checked) roles.push('debtor');
  if (!roles.length) {
    showBanner('Select at least one role.', 'error');
    return;
  }

  const maxWaitSeconds = Math.max(5, Math.min(180, Number($('maxWait').value) || 35));
  const concurrency = Math.max(1, Math.min(8, Number($('concurrency').value) || 2));

  const input = {
    alertId,
    maxWaitMs: maxWaitSeconds * 1000,
    granularity: $('granularity').value,
    mode: $('mode').value,
    tenantId: $('tenant').value || undefined,
    roles,
    concurrency,
    retryTransient: $('retryTransient').checked,
    e2eId: $('e2e').value ? $('e2e').value.trim() : undefined,
    tolerance: Number($('tolerance').value) || 0.01
  };

  setRunning(true);
  setSaveEnabled(false);
  hideBanner();
  hideEl('emptyState');
  $('cards').replaceChildren();

  try {
    const res =
      currentView === 'verify'
        ? await window.validator.verify(input)
        : await window.validator.run(input);
    if (!res.ok) {
      showBanner(res.error, 'error');
      showEl('emptyState');
      return;
    }
    if (currentView === 'verify') renderVerify(res.payload);
    else render(res.payload);
    setSaveEnabled(true);
  } catch (error) {
    showBanner(error.message, 'error');
    showEl('emptyState');
  } finally {
    setRunning(false);
  }
}

function setRunning(value) {
  running = value;
  $('runBtn').disabled = value;
  $('runBtn').textContent = value ? 'Running…' : 'Run validation';
  if (value) showEl('overlay');
  else hideEl('overlay');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(payload) {
  renderSummary(payload);
  renderCards(payload);

  if (payload.bootstrap && payload.bootstrap.ok) {
    const boot = (payload.bootstrap.calls || [])
      .map((call) => `${call.id} ${call.ok ? fmtMs(call.durationMs) : 'FAILED'}`)
      .join('   ');
    showBanner(`Bootstrap ok — ${boot}`, 'info');
  } else {
    showBanner(
      `Bootstrap failed — ${(payload.bootstrap && payload.bootstrap.message) || 'could not resolve alert/identifiers'}`,
      'error'
    );
  }
}

function renderSummary(payload) {
  showEl('summary');
  const chips = $('chips');
  chips.replaceChildren();
  const s = payload.summary;
  chips.append(
    chip('available', s.available, 'available'),
    chip('empty', s.empty, 'empty'),
    chip('failed', s.failed, 'failed'),
    chip('blocked', s.blocked, 'blocked')
  );

  const resolved = payload.resolved || {};
  const meta = [
    `Alert ${payload.input.alertId}`,
    `tenant ${payload.input.tenantId}`,
    `e2e ${resolved.endToEndId || '(unresolved)'}`,
    `mode ${payload.mode}`,
    `granularity ${payload.input.granularity}`,
    `${payload.summary.total} checks`,
    fmtMs(payload.totalDurationMs)
  ].join('   ·   ');
  $('runMeta').textContent = meta;
}

function chip(kind, num, label) {
  const el = document.createElement('span');
  el.className = `chip ${kind}`;
  const n = document.createElement('span');
  n.className = 'num';
  n.textContent = String(num);
  el.append(n, document.createTextNode(` ${label}`));
  return el;
}

function renderCards(payload) {
  const container = $('cards');
  container.replaceChildren();

  const cards = payload.cards || [];
  if (!cards.length) {
    showEl('emptyState');
    return;
  }

  for (const card of cards) {
    container.append(buildCard(card));
  }
}

function buildCard(card) {
  const section = document.createElement('section');
  section.className = `card status-${card.status.toLowerCase()}`;

  const head = document.createElement('div');
  head.className = 'cardHead';
  const title = document.createElement('h2');
  title.textContent = card.card;
  const stat = document.createElement('span');
  stat.className = 'cardStat';
  stat.textContent = `${card.available}/${card.total} checks available`;
  const badge = statusBadge(card.status);
  head.append(title, stat, badge);

  section.append(head);

  for (const row of card.rows) {
    section.append(buildRow(row));
  }

  return section;
}

function buildRow(row) {
  const wrapper = document.createElement('div');
  wrapper.className = 'row';

  const main = document.createElement('div');
  main.className = 'rowMain';

  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = row.role ? capitalize(row.role) : 'Transaction';

  const badge = statusBadge(row.status);

  const qcount = document.createElement('span');
  qcount.className = 'qcount';
  const total = row.queries.length;
  const okCount = row.queries.filter((query) => query.ok).length;
  qcount.textContent = total ? `${okCount}/${total} queries` : '0 queries';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtMs(row.durationMs);

  const reason = document.createElement('span');
  reason.className = 'reason';
  reason.textContent = row.reason || '';

  const toggle = document.createElement('button');
  toggle.className = 'row-toggle';
  toggle.textContent = 'Queries ▾';

  main.append(role, badge, qcount, time, reason, toggle);

  const body = document.createElement('div');
  body.className = 'row-body hidden';

  if (!row.queries.length) {
    const none = document.createElement('div');
    none.className = 'reason';
    none.textContent = 'No queries executed for this check.';
    body.append(none);
  } else {
    for (const query of row.queries) body.append(buildQuery(query));
  }

  toggle.addEventListener('click', () => {
    const hidden = body.classList.toggle('hidden');
    toggle.textContent = hidden ? 'Queries ▾' : 'Queries ▴';
  });

  wrapper.append(main, body);
  return wrapper;
}

function buildQuery(query) {
  const block = document.createElement('div');
  block.className = 'query';

  const main = document.createElement('div');
  main.className = 'queryMain';

  const id = document.createElement('span');
  id.className = 'qid';
  id.textContent = query.id;

  main.append(id);

  if (query.subId) {
    const sub = document.createElement('span');
    sub.className = 'qsub';
    sub.textContent = query.subId;
    main.append(sub);
  }

  const label = document.createElement('span');
  label.className = 'qlabel';
  label.textContent = query.label || '';
  main.append(label);

  const mode = document.createElement('span');
  mode.className = 'mono';
  mode.textContent = query.mode;
  main.append(mode);

  const http = document.createElement('span');
  http.className = `mono ${query.ok ? 'ok' : 'bad'}`;
  http.textContent = query.statusCode != null ? `HTTP ${query.statusCode}` : (query.error ? query.error.code : 'no response');
  main.append(http);

  const rows = document.createElement('span');
  rows.className = 'mono';
  rows.textContent = `rows ${query.rowCount != null ? query.rowCount : '-'}`;
  main.append(rows);

  const time = document.createElement('span');
  time.className = 'mono';
  time.textContent = fmtMs(query.durationMs);
  main.append(time);

  if (query.attempts > 1) {
    const attempts = document.createElement('span');
    attempts.className = 'qsub';
    attempts.textContent = `x${query.attempts}`;
    main.append(attempts);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'resp-toggle';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await window.validator.copy(formatResponse(query));
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1200);
    } catch (error) {
      copyBtn.textContent = 'Copy failed';
    }
  });
  main.append(copyBtn);

  const respBtn = document.createElement('button');
  respBtn.className = 'resp-toggle';
  respBtn.textContent = 'Response ▾';
  main.append(respBtn);

  const pre = document.createElement('pre');
  pre.className = 'resp hidden';
  pre.textContent = formatResponse(query);

  respBtn.addEventListener('click', () => {
    const hidden = pre.classList.toggle('hidden');
    respBtn.textContent = hidden ? 'Response ▾' : 'Response ▴';
  });

  block.append(main, pre);
  return block;
}

function formatResponse(query) {
  const parts = [];
  parts.push(`# ${query.id}${query.subId ? ' · ' + query.subId : ''} — ${query.label || ''}`);
  parts.push(`# mode: ${query.mode}`);
  if (query.request) {
    const req = query.request;
    parts.push(`# request: ${req.method || ''} ${req.url || ''}`);
    if (req.query) parts.push(`# params: ${JSON.stringify(req.query)}`);
  }
  if (query.sql) {
    parts.push('');
    parts.push('# SQL:');
    parts.push(query.sql);
  }
  if (query.error) {
    parts.push(`# ERROR ${query.error.code}: ${query.error.message}`);
  }
  parts.push('');
  if (query.response === null || query.response === undefined) {
    parts.push('(no response body)');
  } else {
    try {
      parts.push(JSON.stringify(query.response, null, 2));
    } catch (error) {
      parts.push(String(query.response));
    }
  }
  return parts.join('\n');
}

function statusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `badge ${String(status).toLowerCase()}`;
  badge.textContent = STATUS_LABEL[status] || status;
  return badge;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function capitalize(text) {
  return String(text).charAt(0).toUpperCase() + String(text).slice(1);
}

function showEl(id) {
  $(id).classList.remove('hidden');
}

function hideEl(id) {
  $(id).classList.add('hidden');
}

function showBanner(message, type) {
  const el = $('banner');
  el.className = `banner ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideBanner() {
  $('banner').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Offline demo mode (#demo) — renders a synthetic result so the UI can be
// previewed without the CMS/Lakehouse being reachable.
// ---------------------------------------------------------------------------

function q(overrides) {
  return Object.assign(
    {
      id: 'Q-X',
      subId: null,
      label: 'Query',
      mode: 'cms',
      ok: true,
      statusCode: 200,
      rowCount: 3,
      durationMs: 820,
      error: null,
      request: { method: 'GET', url: '/api/v1/example', query: { tenantId: 'DEFAULT' } },
      sql: 'SELECT alert_id FROM alert_navigator_header WHERE alert_id = 796',
      response: { status: 'success', code: 200, row_count: 3, data: [{ example: true }] }
    },
    overrides
  );
}

function demoRow(view, viewLabel, card, role, status, queries, reason) {
  return {
    view,
    viewLabel,
    card,
    role,
    status,
    reason: reason || null,
    durationMs: queries.reduce((total, entry) => total + (entry.durationMs || 0), 0),
    metrics: {},
    queries
  };
}

function samplePayload() {
  const now = new Date().toISOString();
  const cards = [
    {
      card: 'Alert Navigator',
      status: 'AVAILABLE',
      available: 1,
      total: 1,
      rows: [demoRow('alert-navigator', 'Alert Navigator', 'Alert Navigator', null, 'AVAILABLE', [q({ id: 'C-NAV', label: 'Alert Navigator', durationMs: 2700 })])]
    },
    {
      card: 'Transaction Details',
      status: 'AVAILABLE',
      available: 1,
      total: 1,
      rows: [demoRow('transaction-details', 'Transaction Details', 'Transaction Details', null, 'AVAILABLE', [q({ id: 'C-TD', label: 'Transaction Details', durationMs: 247 })])]
    },
    {
      card: 'Network Analysis',
      status: 'FAILED',
      available: 1,
      total: 3,
      rows: [
        demoRow('network-transaction', 'Transaction Network', 'Network Analysis', 'creditor', 'AVAILABLE', [q({ id: 'C-TN', label: 'Transaction Network', durationMs: 19400 })], ''),
        demoRow('network-account', 'Account Network', 'Network Analysis', 'debtor', 'EMPTY', [q({ id: 'C-AN', label: 'Account Network', rowCount: 1, durationMs: 4900 })], 'Only the root entity node was returned'),
        demoRow('network-counterparty', 'Counterparty Network', 'Network Analysis', 'creditor', 'FAILED', [q({ id: 'C-CPN', label: 'Counterparty Network', ok: false, statusCode: null, rowCount: null, durationMs: 35000, error: { code: 'UPSTREAM_TIMEOUT', message: 'Timeout reached' }, response: null })], 'C-CPN: UPSTREAM_TIMEOUT - Timeout reached')
      ]
    },
    {
      card: 'Conditions',
      status: 'BLOCKED',
      available: 0,
      total: 1,
      rows: [demoRow('conditions', 'Conditions', 'Conditions', null, 'BLOCKED', [], 'endToEndId could not be resolved from Alert Navigator')]
    }
  ];

  return {
    runId: 'demo-run',
    mode: 'cms',
    startedAt: now,
    finishedAt: now,
    totalDurationMs: 41200,
    input: { alertId: 796, tenantId: 'DEFAULT', roles: ['creditor', 'debtor'], granularity: 'month', mode: 'cms' },
    resolved: {
      endToEndId: '379c078f5f5440f1aee66de1cede6e48',
      creditorId: 'crd_..._TAZAMA_EID',
      debtorId: 'dbt_..._TAZAMA_EID',
      entityMetadataOk: true
    },
    bootstrap: { ok: true, calls: [{ id: 'C-NAV', ok: true, durationMs: 2700 }, { id: 'C-EM', ok: true, durationMs: 4200 }] },
    summary: { available: 2, empty: 1, failed: 1, blocked: 1, skipped: 0, total: 5 },
    cards
  };
}

if (window.location.hash === '#demo') {
  render(samplePayload());
  showBanner('Demo mode — synthetic data, no network calls', 'warn');
}


// ---------------------------------------------------------------------------
// Data Verify rendering
// ---------------------------------------------------------------------------

function renderVerify(payload) {
  renderVerifySummary(payload);
  const container = $('cards');
  container.replaceChildren();
  const cards = payload.cards || [];
  if (!cards.length) {
    showEl('emptyState');
    return;
  }
  for (const card of cards) container.append(buildVerifyCard(card, payload.results || []));
}

function renderVerifySummary(payload) {
  showEl('summary');
  const s = payload.summary;
  const chips = $('chips');
  chips.replaceChildren();
  chips.append(
    vchip('verified', s.verified, 'verified'),
    vchip('mismatch', s.mismatch, 'mismatch'),
    vchip('not-comparable', s.notComparable, 'not comparable'),
    vchip('blocked', s.blocked, 'blocked')
  );
  const r = payload.resolved || {};
  $('runMeta').textContent = [
    `Alert ${payload.input.alertId}`,
    `tenant ${payload.input.tenantId}`,
    `e2e ${r.endToEndId || '(unresolved)'}`,
    `granularity ${payload.input.granularity}`,
    `fields ${s.fieldsPassed} passed / ${s.fieldsFailed} failed`,
    fmtMs(payload.totalDurationMs)
  ].join('   ·   ');
}

function vchip(kind, num, label) {
  const el = document.createElement('span');
  el.className = `chip ${kind}`;
  const n = document.createElement('span');
  n.className = 'num';
  n.textContent = String(num);
  el.append(n, document.createTextNode(` ${label}`));
  return el;
}

function buildVerifyCard(card, results) {
  const rows = results.filter((result) => result.card === card.card);
  const section = document.createElement('section');
  section.className = `card status-${badgeKey(card.status)}`;

  const head = document.createElement('div');
  head.className = 'cardHead';
  const title = document.createElement('h2');
  title.textContent = card.card;
  const stat = document.createElement('span');
  stat.className = 'cardStat';
  stat.textContent = `${card.verified}/${card.total} verified`;
  head.append(title, stat, verifyBadge(card.status));
  section.append(head);

  for (const row of rows) section.append(buildVerifyRow(row));
  return section;
}

function buildVerifyRow(row) {
  const wrapper = document.createElement('div');
  wrapper.className = 'row';

  const main = document.createElement('div');
  main.className = 'rowMain';

  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = row.role ? capitalize(row.role) : 'All';

  const fields = row.fields || [];
  const passed = fields.filter((f) => f.pass).length;

  const qc = document.createElement('span');
  qc.className = 'qcount';
  qc.textContent = fields.length ? `${passed}/${fields.length} fields` : 'no fields';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtMs(row.durationMs);

  const reason = document.createElement('span');
  reason.className = 'reason';
  reason.textContent = row.reason || '';

  const toggle = document.createElement('button');
  toggle.className = 'row-toggle';
  toggle.textContent = 'Fields ▾';

  main.append(role, verifyBadge(row.status), qc, time, reason, toggle);

  const body = document.createElement('div');
  body.className = 'row-body hidden';
  if (!fields.length) {
    const none = document.createElement('div');
    none.className = 'reason';
    none.textContent = row.reason || 'No fields evaluated.';
    body.append(none);
  } else {
    body.append(buildFieldTable(fields));
  }

  toggle.addEventListener('click', () => {
    const hidden = body.classList.toggle('hidden');
    toggle.textContent = hidden ? 'Fields ▾' : 'Fields ▴';
  });

  wrapper.append(main, body);
  return wrapper;
}

function buildFieldTable(fields) {
  const table = document.createElement('table');
  table.className = 'fieldTable';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Field', 'API data', 'After calculation', 'CMS value', 'Delta', 'Result']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const f of fields) {
    const tr = document.createElement('tr');
    tr.className = f.informational ? 'info' : f.pass ? 'pass' : 'fail';
    const cells = [
      f.key,
      fmtVal(f.input),
      fmtVal(f.expected),
      fmtVal(f.actual),
      f.delta != null ? String(f.delta) : '-',
      f.informational ? 'INFO' : f.pass ? 'PASS' : 'FAIL'
    ];
    cells.forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (index === 5) td.className = 'resultCell';
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

function fmtVal(value) {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function badgeKey(status) {
  return { VERIFIED: 'available', MISMATCH: 'failed', NOT_COMPARABLE: 'blocked', BLOCKED: 'blocked' }[status] || 'blocked';
}

function verifyBadge(status) {
  const badge = document.createElement('span');
  badge.className = `badge ${badgeKey(status)}`;
  badge.textContent = status;
  return badge;
}

// ---------------------------------------------------------------------------
// Offline demo for the Data Verify view (#verify-demo)
// ---------------------------------------------------------------------------

function sampleVerifyPayload() {
  const now = new Date().toISOString();
  const f = (key, kind, expected, actual, pass, extra) =>
    Object.assign({ key, kind, required: true, input: expected, expected, actual, delta: pass ? 0 : Math.abs((expected || 0) - (actual || 0)), pass, informational: false }, extra || {});
  const results = [
    {
      view: 'alert-navigator',
      viewLabel: 'Alert Navigator',
      card: 'Alert Navigator',
      role: null,
      status: 'MISMATCH',
      reason: null,
      durationMs: 420,
      fields: [
        f('alertId', 'count', 796, 796, true),
        f('statistics.totalTypologies', 'count', 1, 1, true),
        f('statistics.totalRules', 'count', 3, 2, false)
      ]
    },
    {
      view: 'transaction-details',
      viewLabel: 'Transaction Details',
      card: 'Transaction Details',
      role: null,
      status: 'VERIFIED',
      reason: null,
      durationMs: 310,
      fields: [f('amount.amount', 'money', 125.5, 125.5, true), f('debtor.iban', 'string', 'dbtrAcct_1', 'dbtrAcct_1', true)]
    },
    {
      view: 'network-transaction',
      viewLabel: 'Transaction Network',
      card: 'Network Analysis',
      role: 'creditor',
      status: 'VERIFIED',
      reason: null,
      durationMs: 2400,
      fields: [f('connectedAccounts', 'count', 12, 12, true), f('edgeCount', 'count', 41, 41, true)]
    },
    {
      view: 'network-transaction',
      viewLabel: 'Transaction Network',
      card: 'Network Analysis',
      role: 'debtor',
      status: 'VERIFIED',
      reason: null,
      durationMs: 2100,
      fields: [f('connectedAccounts', 'count', 0, 0, true)]
    }
  ];
  const cards = [
    { card: 'Alert Navigator', status: 'MISMATCH', verified: 0, total: 1 },
    { card: 'Transaction Details', status: 'VERIFIED', verified: 1, total: 1 },
    { card: 'Network Analysis', status: 'VERIFIED', verified: 2, total: 2 }
  ];
  return {
    runId: 'verify-demo',
    mode: 'verify',
    startedAt: now,
    finishedAt: now,
    totalDurationMs: 6800,
    input: { alertId: 796, tenantId: 'DEFAULT', roles: ['creditor', 'debtor'], granularity: 'month' },
    resolved: { endToEndId: '379c078f5f5440f1aee66de1cede6e48', entityMetadataOk: true },
    summary: { verified: 3, mismatch: 1, notComparable: 0, blocked: 0, total: 4, fieldsPassed: 7, fieldsFailed: 1 },
    cards,
    results
  };
}

if (window.location.hash === '#verify-demo') {
  setView('verify');
  renderVerify(sampleVerifyPayload());
  showBanner('Demo verify — synthetic data, no network calls', 'warn');
}
