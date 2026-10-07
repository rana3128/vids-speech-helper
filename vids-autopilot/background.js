// Service worker: real (trusted) key presses via chrome.debugger.
const PROTOCOL = '1.3';
const attached = new Set();

function attach(tabId) {
  if (attached.has(tabId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      // "Already attached" is fine (e.g. service worker restarted while attached).
      if (err && !/already attached/i.test(err.message)) return reject(new Error(err.message));
      attached.add(tabId);
      resolve();
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // ignore "not attached"
      attached.delete(tabId);
      resolve();
    });
  });
}

function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    });
  });
}

// mod: true = Cmd on mac / Ctrl elsewhere; shift: add Shift (8).
const COMBOS = {
  split: { key: 'S', code: 'KeyS', windowsVirtualKeyCode: 83, mod: true, shift: true },     // Cmd/Ctrl+Shift+S
  selectAll: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, mod: true, commands: ['selectAll'] }, // Cmd/Ctrl+A
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
};

async function pressKey(tabId, combo, isMac) {
  const c = COMBOS[combo];
  if (!c) throw new Error('Unknown key combo: ' + combo);
  await attach(tabId);
  const modifiers = (c.mod ? (isMac ? 4 : 2) : 0) + (c.shift ? 8 : 0);
  const base = { key: c.key, code: c.code, windowsVirtualKeyCode: c.windowsVirtualKeyCode, nativeVirtualKeyCode: c.windowsVirtualKeyCode, modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(isMac && c.commands ? { commands: c.commands } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Trusted left click at viewport CSS-pixel coordinates.
async function click(tabId, x, y) {
  await attach(tabId);
  const base = { x, y, button: 'left', clickCount: 1 };
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
}

// Trusted text input into the focused element (works for Docs' canvas editors).
async function insertText(tabId, text) {
  await attach(tabId);
  await send(tabId, 'Input.insertText', { text });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  // Tell the page so a running job stops instead of pressing keys into the void.
  chrome.tabs.sendMessage(source.tabId, { cmd: 'debuggerDetached', reason }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (msg.type === 'pressKey') {
    pressKey(tabId, msg.combo, msg.isMac)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'click' || msg.type === 'insertText') {
    const p = msg.type === 'click' ? click(tabId, msg.x, msg.y) : insertText(tabId, msg.text);
    p.then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'attach') {
    attach(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'detach') {
    detach(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
