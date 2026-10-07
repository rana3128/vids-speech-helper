// Popup: load the video file, store it per Vids doc, send commands, show the live log.
const P = globalThis.VAParse;
const $ = (id) => document.getElementById(id);
const JOB_BUTTONS = ['calibrate', 'split', 'fill', 'runAll'];

let tab = null;
let docId = null;
let video = null;

function addLog(line, level = 'info') {
  const div = document.createElement('div');
  div.className = level;
  div.textContent = line;
  const log = $('log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.appendChild(div);
  if (atBottom) log.scrollTop = log.scrollHeight;
}
const localLog = (msg, level) => addLog(`[popup] ${msg}`, level);

function setRunning(running, phase = '') {
  $('status').textContent = running ? `running: ${phase}` : 'idle';
  for (const id of JOB_BUTTONS) $(id).disabled = running || !video || !docId;
  $('inspect').disabled = running || !docId;
  $('stop').disabled = !docId;
}

function getOpts() {
  return {
    startFrom: Math.max(1, parseInt($('startFrom').value, 10) || 1),
    overwrite: $('overwrite').checked,
    updateAll: $('updateAll').checked
  };
}

async function saveJob() {
  if (!docId) return;
  await chrome.storage.local.set({ [`job:${docId}`]: { video, opts: getOpts() } });
}

function showSummary() {
  if (!video) { $('summary').textContent = 'No file loaded.'; $('summary').className = 'summary muted'; return; }
  const s = P.summary(video);
  const { errors, warnings } = P.validate(video);
  const el = $('summary');
  el.className = 'summary';
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = `${video.title ? video.title + ' · ' : ''}${s.scenes} scenes · duration ${s.duration != null ? P.fmt(s.duration) + ` (${s.duration}s)` : 'from page'} · longest speech ${s.longest} chars · voice ${video.voice}`;
  el.appendChild(head);
  for (const w of warnings) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = '⚠ ' + w; el.appendChild(d); }
  for (const e of errors) { const d = document.createElement('div'); d.className = 'err'; d.textContent = '✖ ' + e; el.appendChild(d); }
}

async function showProgress() {
  if (!docId) return;
  const p = (await chrome.storage.local.get(`prog:${docId}`))[`prog:${docId}`];
  const pr = p?.progress || {};
  const parts = [];
  if (pr.splitLast) parts.push(`split ✓ to scene ${pr.splitLast}`);
  if (pr.fillLast) parts.push(`fill ✓ to scene ${pr.fillLast}`);
  if (p?.calib) parts.push(`calibrated ${p.calib.pxPerSec.toFixed(1)}px/s`);
  $('progress').textContent = parts.join(' · ');
}

// Make sure our content script is in the tab (tabs opened before install won't have it).
async function ensureContent() {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { cmd: 'ping' });
    if (r?.ok) return r;
  } catch { /* not injected */ }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['config.js', 'parse.js', 'content.js'] });
  return chrome.tabs.sendMessage(tab.id, { cmd: 'ping' });
}

async function send(cmd, extra = {}) {
  try {
    await ensureContent();
    return await chrome.tabs.sendMessage(tab.id, { cmd, ...extra });
  } catch (e) {
    localLog(`${cmd}: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  }
}

async function startJob(cmd) {
  if (!video) return localLog('Load a file first.', 'warn');
  const { errors } = P.validate(video);
  if (errors.length) return localLog(`File has errors: ${errors[0]}`, 'error');
  await saveJob();
  const v = { ...video };
  if (!v.duration) {
    const info = await send('pageInfo');
    v.duration = info?.duration || null;
    if (!v.duration) return localLog('Duration unknown: not in file and not readable from the page timer.', 'error');
    localLog(`Duration from page: ${v.duration}s`);
  }
  const r = await send(cmd, { video: v, opts: getOpts() });
  if (!r?.ok) localLog(`${cmd}: ${r?.error || 'no response from page'}`, 'error');
  else setRunning(true, cmd);
}

async function onFile(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    video = P.parseFile(f.name, text);
    if (!video.scenes.length) throw new Error('No scenes found in file');
    localLog(`Loaded ${f.name}: ${video.scenes.length} scenes`);
    showSummary();
    await saveJob();
  } catch (e) {
    video = null;
    showSummary();
    localLog(`Could not read ${f.name}: ${e.message}`, 'error');
  }
  setRunning(false);
}

async function inspect() {
  const r = await send('inspect');
  if (!r?.ok) return;
  const json = JSON.stringify(r.data, null, 1);
  try {
    await navigator.clipboard.writeText(json);
    localLog(`Inspect DOM: ${r.data.elements.length} elements, ${json.length} chars copied to clipboard. Paste it to Claude Code.`);
  } catch (e) {
    localLog(`Clipboard failed (${e.message}); JSON is below and in the page console.`, 'warn');
  }
  addLog(json);
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = tab?.url?.match(/^https:\/\/docs\.google\.com\/videos\/d\/([^/]+)/);
  if (!m) {
    $('pageMsg').textContent = 'Open a Google Vids video (docs.google.com/videos/d/…/edit) and click the icon again.';
    $('pageMsg').className = 'err';
    setRunning(false);
    for (const b of document.querySelectorAll('button')) b.disabled = true;
    return;
  }
  docId = m[1];
  $('pageMsg').textContent = `Doc ${docId.slice(0, 12)}…`;

  const store = await chrome.storage.local.get([`job:${docId}`, `log:${docId}`]);
  const job = store[`job:${docId}`];
  if (job?.video) { video = job.video; showSummary(); }
  if (job?.opts) {
    $('startFrom').value = job.opts.startFrom ?? 1;
    $('overwrite').checked = !!job.opts.overwrite;
    $('updateAll').checked = !!job.opts.updateAll;
  }
  for (const e of store[`log:${docId}`] || []) addLog(e.line, e.level);
  await showProgress();

  setRunning(false);
  const info = await send('ping');
  if (info?.running) setRunning(true, 'in progress');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.docId && msg.docId !== docId) return;
  if (msg.type === 'log') addLog(msg.line, msg.level);
  if (msg.type === 'status') { setRunning(msg.running, msg.phase + (msg.scene ? ` ${msg.scene}/${msg.total}` : '')); showProgress(); }
});

$('file').addEventListener('change', onFile);
for (const id of JOB_BUTTONS) $(id).addEventListener('click', () => startJob(id));
$('stop').addEventListener('click', async () => { await send('stop'); chrome.runtime.sendMessage({ type: 'detach', tabId: tab.id }).catch(() => {}); });
$('inspect').addEventListener('click', inspect);
for (const id of ['startFrom', 'overwrite', 'updateAll']) $(id).addEventListener('change', saveJob);
$('resetProg').addEventListener('click', async () => {
  if (!docId || !confirm('Forget saved split/fill progress and calibration for this video?')) return;
  await chrome.storage.local.remove(`prog:${docId}`);
  localLog('Progress reset.');
  showProgress();
});
$('clearLog').addEventListener('click', async () => {
  $('log').innerHTML = '';
  if (docId) await chrome.storage.local.remove(`log:${docId}`);
});

init().catch((e) => localLog(`Init failed: ${e.message}`, 'error'));
