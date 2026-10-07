// Vids Autopilot content script: all DOM logic (find, seek, verify, split, fill).
// Rules: never select by class; re-query the DOM before every step; verify after every action.
(() => {
  if (window.__vidsAutopilotLoaded) return;
  window.__vidsAutopilotLoaded = true;

  const CFG = window.CFG;
  const P = globalThis.VAParse;
  const docId = (location.pathname.match(/\/videos\/d\/([^/]+)/) || [])[1] || 'unknown';
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
  const progKey = `prog:${docId}`;
  const logKey = `log:${docId}`;

  let running = false;
  let cancel = false;
  let t0 = Date.now();
  let calib = null;

  class Cancelled extends Error {}

  // ---------------------------------------------------------------- utilities
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function checkCancel() {
    if (cancel) throw new Cancelled('Stopped by user');
  }

  async function waitFor(fn, { timeout = CFG.waitFor.timeout, interval = CFG.waitFor.interval } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      checkCancel();
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(interval);
    }
  }

  // Interruptible fixed delay (only for delays named in config.js).
  async function pause(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { checkCancel(); await sleep(Math.min(100, end - Date.now())); }
  }

  function safeSend(msg) {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
  }

  // ------------------------------------------------------------------ logging
  let logBuf = null;
  let logFlush = null;

  async function appendLog(entry) {
    if (!logBuf) {
      try { logBuf = (await chrome.storage.local.get(logKey))[logKey] || []; } catch { logBuf = []; }
    }
    logBuf.push(entry);
    if (logBuf.length > CFG.logBufferSize) logBuf.splice(0, logBuf.length - CFG.logBufferSize);
    clearTimeout(logFlush);
    logFlush = setTimeout(() => { try { chrome.storage.local.set({ [logKey]: logBuf }); } catch {} }, 400);
  }

  // The popup's "Clear log" removes the key; drop our cached copy too.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[logKey] && changes[logKey].newValue === undefined) logBuf = [];
  });

  function log(msg, level = 'info') {
    const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`;
    (level === 'error' ? console.error : console.log)('[Vids Autopilot]', line);
    const entry = { line, level, ts: Date.now() };
    appendLog(entry);
    safeSend({ type: 'log', docId, ...entry });
  }
  const slog = (i, N, action, result, level) => log(`[scene ${i}/${N}] ${action} → ${result}`, level);

  function status(phase, extra = {}) {
    safeSend({ type: 'status', docId, running, phase, ...extra });
  }

  // ----------------------------------------------------------------- progress
  async function loadProg() {
    try {
      const p = (await chrome.storage.local.get(progKey))[progKey] || {};
      p.progress = p.progress || {};
      p.progress.splitDone = p.progress.splitDone || [];
      p.progress.fillDone = p.progress.fillDone || [];
      return p;
    } catch { return { progress: { splitDone: [], fillDone: [] } }; }
  }
  async function saveProg(mut) {
    const p = await loadProg();
    mut(p);
    await chrome.storage.local.set({ [progKey]: p });
    return p;
  }

  // ------------------------------------------------------------------ finders
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  const label = (el) => (el.getAttribute('aria-label') || '').trim();
  const textOf = (el) => (el.innerText || el.textContent || '').trim();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function rawSceneButtons() {
    const out = [];
    for (const el of document.querySelectorAll('[aria-label^="Scene "]')) {
      const m = label(el).match(CFG.sceneLabelRe);
      if (m) out.push({ el, i: Number(m[1]), n: Number(m[2]) });
    }
    return out;
  }

  function scroller() {
    const big = [...document.querySelectorAll('div')].filter(
      (d) => d.scrollWidth > CFG.scrollerMinScrollWidth && d.clientWidth > 100 && d.clientWidth < innerWidth
    );
    if (big.length) {
      // Prefer the one that contains scene buttons, then the widest.
      const withScenes = big.filter((d) => rawSceneButtons().some((b) => d.contains(b.el)));
      return (withScenes.length ? withScenes : big).sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
    }
    // Short videos: scroll width may be small. Walk up from a scene button.
    const b = rawSceneButtons()[0];
    for (let p = b?.el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') || p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  }

  // Scene buttons in the timeline (inside the scroller when we can tell).
  function sceneButtons() {
    const all = rawSceneButtons();
    const s = scroller();
    const inS = s ? all.filter((b) => s.contains(b.el)) : [];
    return (inS.length ? inS : all).filter((b) => b.el.getBoundingClientRect().width > 0).sort((a, b) => a.i - b.i);
  }
  const sceneBtn = (n) => sceneButtons().find((b) => b.i === n) || null;

  // N from "Scene i of N", taken from the timeline scroller (other panels may carry
  // their own "Scene i of N" labels, e.g. with the AI voiceover sidebar open).
  function sceneCount() {
    const all = rawSceneButtons();
    if (!all.length) return 0;
    const s = scroller();
    const inS = s ? all.filter((b) => s.contains(b.el)) : [];
    return Math.max(...(inS.length ? inS : all).map((b) => b.n));
  }

  // Diagnostic: every distinct "Scene i of N" label and where it lives.
  function sceneLabelReport() {
    const s = scroller();
    const seen = new Map();
    for (const b of rawSceneButtons()) {
      const key = `${label(b.el)} [${b.el.tagName.toLowerCase()}${b.el.getAttribute('role') ? ' role=' + b.el.getAttribute('role') : ''}${s && s.contains(b.el) ? ', in timeline' : ', outside timeline'}${isVisible(b.el) ? '' : ', hidden'}]`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    return [...seen.keys()].slice(0, 12).join('; ') || 'none';
  }

  function readTimerFull() {
    const el = document.querySelector(CFG.timerSel);
    return el ? P.parseTimer(el.textContent) : null;
  }
  const readTimer = () => readTimerFull()?.current ?? null;
  const readTotal = () => readTimerFull()?.total ?? null;

  // Visible elements whose aria-label or text equals (or contains) one of `texts`.
  function findByText(texts, { roles = null, exact = true, within = null, exclude = null } = {}) {
    const want = texts.map((t) => t.toLowerCase());
    const sel = roles
      ? roles.map((r) => `[role="${r}"]`).concat(roles.includes('button') ? ['button'] : []).join(',')
      : '[role],button,a,[aria-label],[tabindex],li,span';
    const res = [];
    for (const el of (within || document).querySelectorAll(sel)) {
      if (exclude && exclude.contains(el)) continue;
      if (!isVisible(el)) continue;
      const cands = [label(el), textOf(el)].filter(Boolean).map((s) => norm(s).toLowerCase());
      if (cands.some((c) => want.some((w) => (exact ? c === w : c.includes(w))))) res.push(el);
    }
    // Most specific (smallest) first.
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    return res.sort((a, b) => area(a) - area(b));
  }

  const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';

  // ------------------------------------------------------------------ actions
  function fire(el, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    for (const [C, t] of [[PointerEvent, 'pointerdown'], [MouseEvent, 'mousedown'], [PointerEvent, 'pointerup'], [MouseEvent, 'mouseup'], [MouseEvent, 'click']]) {
      el.dispatchEvent(new C(t, o));
    }
  }
  function clickEl(el) {
    const r = el.getBoundingClientRect();
    fire(el, r.left + r.width / 2, r.top + r.height / 2);
  }
  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) throw new Error(`Nothing to click at (${Math.round(x)}, ${Math.round(y)})`);
    fire(el, x, y);
    return el;
  }

  // Set scrollLeft and wait for it to stick (Vids may re-render and reset it).
  async function scrollTo(left) {
    let s = scroller();
    if (!s) throw new Error('Timeline scroller not found');
    const max = Math.max(0, s.scrollWidth - s.clientWidth);
    const target = Math.min(max, Math.max(0, left));
    s.scrollLeft = target;
    await pause(CFG.delays.afterScroll);
    const ok = await waitFor(() => {
      s = scroller();
      if (!s) return false;
      if (Math.abs(s.scrollLeft - target) <= 2) return true;
      s.scrollLeft = target;
      return false;
    }, { timeout: 2000, interval: 150 });
    if (!ok) throw new Error(`Timeline did not scroll to ${Math.round(target)} (at ${Math.round(scroller()?.scrollLeft)})`);
    return scroller();
  }

  // Content-x (relative to scroller content) of an element.
  function contentX(el, s = scroller()) {
    return el.getBoundingClientRect().left - s.getBoundingClientRect().left + s.scrollLeft;
  }

  // Make sure "Scene n of N" is rendered and roughly centred; return its record.
  async function ensureSceneRendered(n, approxStart) {
    let b = sceneBtn(n);
    let s = scroller();
    const inView = (b) => {
      const r = b.el.getBoundingClientRect(), sr = scroller().getBoundingClientRect();
      return r.left >= sr.left && r.left < sr.right - 20;
    };
    if (b && s && inView(b)) return b;
    if (!s) { if (b) return b; throw new Error('Timeline scroller not found'); }

    const centre = async (b) => {
      s = scroller();
      await scrollTo(contentX(b.el, s) - s.clientWidth / 3);
      return await waitFor(() => sceneBtn(n), { timeout: 2000 });
    };
    if (b) return await centre(b);

    if (calib && approxStart != null) {
      const cx = calib.trackStartX + approxStart * calib.pxPerSec + calib.gapPx * (n - 1);
      await scrollTo(cx - s.clientWidth / 3);
      b = await waitFor(() => sceneBtn(n), { timeout: 1500 });
      if (b) return await centre(b);
    }
    // Sweep the whole timeline.
    s = scroller();
    const step = Math.max(200, s.clientWidth * 0.8);
    for (let x = 0; x <= s.scrollWidth; x += step) {
      await scrollTo(x);
      b = sceneBtn(n);
      if (b) return await centre(b);
    }
    throw new Error(`Scene ${n} not found in the timeline`);
  }

  // Click a scene to select it. Clicking a thumbnail moves the playhead to the click point,
  // so click just inside its left edge. Returns the timer after the click (~ scene start).
  async function selectScene(n, approxStart) {
    const b = await ensureSceneRendered(n, approxStart);
    const r = b.el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(CFG.sceneClickOffsetPx, r.width / 4)), y = r.top + r.height / 2;
    const before = readTimer();
    fire(b.el, x, y);
    await pause(CFG.delays.afterClick);
    await waitFor(() => readTimer() !== before, { timeout: 1500 });
    return readTimer();
  }

  // Start time of scene n from its geometry (no click): its left edge minus the gaps before it.
  async function sceneStartTime(n, approxStart) {
    if (!calib) throw new Error('Not calibrated');
    const b = await ensureSceneRendered(n, approxStart);
    const left = contentX(b.el);
    return (left - calib.trackStartX - calib.gapPx * (n - 1)) / calib.pxPerSec;
  }

  // -------------------------------------------------------------------- zoom
  // Zoom toolbar: combobox with a text input holding the value, plus a slider.
  function zoomParts() {
    const input = document.querySelector(CFG.zoomInputSel);
    const combo = input?.closest('[role="combobox"]') || null;
    const slider = document.querySelector(CFG.zoomSliderSel);
    return { input, combo, slider };
  }

  function currentZoom() {
    const { input, slider } = zoomParts();
    return norm(input?.value) || slider?.getAttribute('aria-valuetext') || null;
  }

  async function setZoom100() {
    const want = CFG.zoomLabel;
    const { input, combo } = zoomParts();
    if (!input || !combo) { log(`Zoom control not found (${CFG.zoomInputSel}): set the timeline zoom to ${want} by hand.`, 'warn'); return false; }
    const before = currentZoom();
    if (before === want) { log(`Zoom already ${want}`); return true; }
    const isWant = () => currentZoom() === want;

    // 1) Open the dropdown via its arrow (right edge of the combobox) and pick the option.
    const r = combo.getBoundingClientRect();
    const arrowX = r.right - 6, midY = r.top + r.height / 2;
    const arrow = document.elementFromPoint(arrowX, midY);
    if (arrow && combo.contains(arrow)) {
      fire(arrow, arrowX, midY);
      const opt = await waitFor(() => findByText([want], { roles: ['option', 'menuitem', 'menuitemradio'], exclude: combo })[0]
        || findByText([want], { exclude: combo })[0], { timeout: 3000 });
      if (opt) {
        clickEl(opt);
        if (await waitFor(isWant, { timeout: 2000 })) { await pause(CFG.delays.afterZoom); log(`Zoom: ${before} → ${want} (dropdown)`); return true; }
      }
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await pause(CFG.delays.afterClick);
    }

    // 2) Type the value into the combobox input and press Enter.
    input.focus();
    input.select();
    document.execCommand('insertText', false, want);
    if (input.value !== want) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, want);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (await waitFor(isWant, { timeout: 2000 })) { input.blur(); await pause(CFG.delays.afterZoom); log(`Zoom: ${before} → ${want} (typed)`); return true; }
    input.blur();

    log(`Could not set zoom to ${want} (still ${currentZoom()}). Calibration will use the current zoom if it is fine enough.`, 'warn');
    return false;
  }

  // ---------------------------------------------------------------- calibrate
  function gapsBefore(T, prog) {
    const done = (prog?.progress?.splitDone || []).filter((x) => x < T).length;
    const total = Math.max(0, sceneCount() - 1);
    const unknown = Math.max(0, total - (prog?.progress?.splitDone || []).length);
    return Math.min(total, done + unknown);
  }

  async function calibrate(video) {
    status('calibrate');
    log(`Calibrate: start (zoom ${currentZoom() ?? 'unknown'})`);
    await setZoom100();
    checkCancel();

    const duration = video?.duration || readTotal();
    if (!duration) throw new Error('Unknown duration: not in the file and timer total not readable');

    let s = scroller();
    if (!s) throw new Error('Timeline scroller not found (is the timeline visible?)');
    s = await scrollTo(0);

    const k = sceneCount();
    if (!k) throw new Error('No "Scene i of N" buttons found in the timeline');
    const first = await waitFor(() => sceneBtn(1));
    if (!first) throw new Error('Scene 1 button not rendered after scrolling to start');
    const r1 = first.el.getBoundingClientRect();
    const trackStartX = contentX(first.el, s);

    // Gap between adjacent rendered clips.
    let gapPx = CFG.defaultGapPx;
    const btns = sceneButtons();
    const gaps = [];
    for (let j = 0; j + 1 < btns.length; j++) {
      if (btns[j + 1].i !== btns[j].i + 1) continue;
      const a = btns[j].el.getBoundingClientRect(), b = btns[j + 1].el.getBoundingClientRect();
      const g = b.left - a.right;
      if (g >= 0 && g < 100) gaps.push(g);
    }
    if (gaps.length) gapPx = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];

    // Pixels per second.
    let pxPerSec;
    if (k === 1) {
      pxPerSec = r1.width / duration;
    } else {
      s = await scrollTo(s.scrollWidth);
      const last = await waitFor(() => sceneBtn(k), { timeout: 2000 });
      if (!last) throw new Error(`Scene ${k} not rendered at end of timeline`);
      const lastRight = contentX(last.el) + last.el.getBoundingClientRect().width;
      pxPerSec = (lastRight - trackStartX - (k - 1) * gapPx) / duration;
      s = await scrollTo(0);
    }
    // At 100% zoom the scale is ~50 px/s. A far smaller value is a real measurement of a
    // zoomed-out ("Fit") timeline, where 0.15 s is a fraction of a pixel, so seeking
    // cannot work. Substituting a default here made every click land off-screen.
    if (!(pxPerSec >= CFG.minPxPerSec && pxPerSec < 2000)) {
      throw new Error(`Timeline is not at ${CFG.zoomLabel} zoom (measured ${pxPerSec.toFixed(2)} px/s, need at least ${CFG.minPxPerSec}). Set the zoom to ${CFG.zoomLabel} by hand and run again; if the zoom control was not found, run Inspect DOM.`);
    }

    s = scroller();
    const baseScrollWidth = s.scrollWidth - (k - 1) * gapPx;

    // Ruler Y: probe upward from the scene row until we're off the scene button.
    const fb = sceneBtn(1).el.getBoundingClientRect();
    const probeX = Math.min(fb.right - 5, fb.left + 40);
    let edgeY = null;
    for (let y = fb.top + 2; y > fb.top - 80; y -= 2) {
      const el = document.elementFromPoint(probeX, y);
      if (!el || !rawSceneButtons().some((b) => b.el === el || b.el.contains(el))) { edgeY = y; break; }
    }
    let rulerY = fb.top - CFG.rulerAboveThumbsPx;
    const ph = document.querySelector(CFG.playheadSel);
    const phTop = ph ? ph.getBoundingClientRect().top : null;
    if (phTop != null && phTop < fb.top && rulerY < phTop + 4) rulerY = phTop + Math.min(10, (fb.top - phTop) / 2);
    if (edgeY != null && rulerY > edgeY) rulerY = edgeY - 4;

    calib = { trackStartX, pxPerSec, gapPx, baseScrollWidth, rulerY, duration, k, viewport: [innerWidth, innerHeight], at: Date.now() };
    log(`Calibrate: duration=${duration}s scenes=${k} trackStartX=${trackStartX.toFixed(1)} pxPerSec=${pxPerSec.toFixed(3)} gapPx=${gapPx.toFixed(1)} baseScrollWidth=${baseScrollWidth.toFixed(1)} rulerY=${rulerY.toFixed(1)} (sceneTop=${fb.top.toFixed(1)}, playheadTop=${phTop?.toFixed(1)}, edgeY=${edgeY})`);

    // Test seek, inside scene 1 so no gaps are involved.
    const scene1Sec = k === 1 ? duration : fb.width / pxPerSec;
    let T = Math.min(5, duration / 2, scene1Sec / 2);
    if (Math.abs((readTimer() ?? -99) - T) < 1) T = Math.min(T + 2, duration * 0.75);
    const baseY = rulerY;
    let ok = null;
    for (const off of CFG.rulerProbeOffsets) {
      calib.rulerY = baseY + off;
      try {
        ok = await seek(T, { label: 'Calibrate', retries: 2, gaps: 0 });
        break;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        log(`Calibrate: test seek at rulerY=${calib.rulerY.toFixed(1)} failed: ${e.message}`, 'warn');
      }
    }
    if (!ok) throw new Error('Calibrate: test seek failed at all ruler offsets. Run Inspect DOM and share the output.');
    log(`Calibrate: test seek ${P.fmt(T)} → timer ${P.fmt(ok.time)} (err ${ok.err.toFixed(2)}s, rulerY=${calib.rulerY.toFixed(1)}) ✓`);
    await saveProg((p) => { p.calib = calib; });
    return calib;
  }

  async function ensureCalib(video) {
    if (calib && calib.viewport[0] === innerWidth && calib.viewport[1] === innerHeight) return calib;
    const p = await loadProg();
    if (p.calib && p.calib.viewport?.[0] === innerWidth && p.calib.viewport?.[1] === innerHeight) { calib = p.calib; return calib; }
    return calibrate(video);
  }

  // --------------------------------------------------------------------- seek
  async function seek(T, { label: lbl = '', retries = CFG.retries, prog, gaps: fixedGaps = null } = {}) {
    let adjust = 0, last = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      checkCancel();
      let s = scroller();
      if (!s) throw new Error('Timeline scroller not found');
      const gaps = fixedGaps ?? gapsBefore(T, prog);
      const cx = calib.trackStartX + T * calib.pxPerSec + calib.gapPx * gaps + adjust;
      if (cx < 0 || cx > s.scrollWidth) throw new Error(`${lbl} seek ${P.fmt(T)}: target x=${Math.round(cx)} is outside the timeline (0..${s.scrollWidth}). Re-run Calibrate.`);
      s = await scrollTo(cx - s.clientWidth / 2);
      const sr = s.getBoundingClientRect();
      const x = Math.round(sr.left + cx - s.scrollLeft); // mouse events only carry whole pixels
      if (x < sr.left || x > sr.right) throw new Error(`${lbl} seek ${P.fmt(T)}: x=${x} is outside the visible timeline`);
      // Clicking on (or right next to) the playhead handle grabs it instead of seeking,
      // so first park the playhead well away from the target.
      const ph = document.querySelector(CFG.playheadSel);
      if (ph) {
        const pr = ph.getBoundingClientRect();
        const phX = pr.left + pr.width / 2;
        if (Math.abs(phX - x) < CFG.playheadAvoidPx) {
          const away = Math.round(x + (x - CFG.playheadParkPx > sr.left + 10 ? -CFG.playheadParkPx : CFG.playheadParkPx));
          const b0 = readTimer();
          clickAt(away, calib.rulerY);
          await waitFor(() => readTimer() !== b0, { timeout: 1500 });
        }
      }
      const before = readTimer();
      const target = clickAt(x, calib.rulerY);
      if (rawSceneButtons().some((b) => b.el === target || b.el.contains(target))) {
        log(`${lbl} seek: click at y=${calib.rulerY.toFixed(1)} hit a scene clip, not the ruler`, 'warn');
      }
      await waitFor(() => { const v = readTimer(); return v != null && v !== before; }, { timeout: 1500 });
      const now = readTimer();
      if (now == null) throw new Error('Timer [role="timer"] not readable');
      last = now;
      const err = now - T;
      if (Math.abs(err) <= CFG.seekTolerance) return { time: now, err, attempt };
      const corr = -err * calib.pxPerSec;
      if (Math.abs(corr) < 1) throw new Error(`${lbl} seek ${P.fmt(T)}: off by ${err.toFixed(2)}s, which is under 1 px at ${calib.pxPerSec.toFixed(2)} px/s. Zoom in to ${CFG.zoomLabel} and re-calibrate.`);
      log(`${lbl} seek ${P.fmt(T)} attempt ${attempt}: timer ${P.fmt(now)} (err ${err.toFixed(2)}s) → shifting ${corr.toFixed(1)} px`, 'warn');
      adjust += corr;
    }
    throw new Error(`${lbl} seek to ${P.fmt(T)} failed after ${retries} attempts (timer at ${P.fmt(last)})`);
  }

  // -------------------------------------------------------------------- split
  async function pressSplit() {
    if (CFG.split.useDebuggerKey) {
      const r = await safeSend({ type: 'pressKey', combo: 'split', isMac });
      if (r?.ok) return 'debugger key';
      log(`Debugger key press failed: ${r?.error || 'no response'}; trying menu fallback`, 'warn');
    }
    // Fallback: a visible "Split" item, else right-click at the playhead and look again.
    let item = findByText(CFG.split.menuTextFallback, { roles: ['menuitem', 'button', 'option'] })[0];
    if (!item) {
      const ph = document.querySelector(CFG.playheadSel);
      const b = sceneButtons()[0];
      if (ph && b) {
        const x = ph.getBoundingClientRect().left + ph.getBoundingClientRect().width / 2;
        const y = b.el.getBoundingClientRect().top + 10;
        const el = document.elementFromPoint(x, y);
        el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
        item = await waitFor(() => findByText(CFG.split.menuTextFallback, { roles: ['menuitem', 'button', 'option'] })[0], { timeout: 2000 });
      }
    }
    if (!item) throw new Error('Could not split: debugger key failed and no "Split" menu item found');
    clickEl(item);
    return 'menu item';
  }

  async function split(video, opts) {
    status('split');
    await ensureCalib(video);
    const N = video.scenes.length;
    const startFrom = Math.max(2, Number(opts.startFrom) || 1);
    log(`Split: ${N} scenes in file, ${sceneCount()} in timeline, starting at scene ${startFrom}`);

    try {
      for (let idx = startFrom - 1; idx < N; idx++) {
        checkCancel();
        const n = idx + 1;
        const T = video.scenes[idx].start;
        status('split', { scene: n, total: N });
        let prog = await loadProg();

        // Skip if already split here.
        if (prog.progress.splitDone.some((x) => Math.abs(x - T) < 0.01)) { slog(n, N, `split @${P.fmt(T)}`, 'already done (saved progress), skip'); continue; }
        // The scene that would start at T, if it exists, is one of these (left-to-right order).
        const g = gapsBefore(T, prog);
        let already = null;
        for (const cand of [...new Set([n, g + 1, g + 2])]) {
          if (cand < 2 || cand > sceneCount()) continue;
          const st = await sceneStartTime(cand, T).catch(() => null);
          if (st != null && Math.abs(st - T) <= CFG.splitVerifyTolerance) { already = { cand, st }; break; }
        }
        if (already) {
          slog(n, N, `split @${P.fmt(T)}`, `scene ${already.cand} already starts at ${P.fmt(already.st)}, skip`);
          await saveProg((p) => { if (!p.progress.splitDone.includes(T)) p.progress.splitDone.push(T); p.progress.splitLast = n; });
          continue;
        }
        const newIdx = g + 2; // index the new scene will get after splitting at T

        const sk = await seek(T, { label: `[scene ${n}/${N}]`, prog });
        slog(n, N, `seek ${P.fmt(T)}`, `timer ${P.fmt(sk.time)} (err ${sk.err.toFixed(2)}s, attempt ${sk.attempt})`);

        const prevCount = sceneCount();
        const prevSW = scroller().scrollWidth;
        let how = await pressSplit();
        let ok = await waitFor(() => sceneCount() === prevCount + 1, { timeout: CFG.splitWaitMs });
        if (!ok) {
          if (sceneCount() > prevCount + 1) throw new Error(`[scene ${n}/${N}] scene count jumped from ${prevCount} to ${sceneCount()}. Undo with ${isMac ? 'Cmd' : 'Ctrl'}+Z and check.`);
          slog(n, N, 'split', `scene count still ${sceneCount()}, retrying once`, 'warn');
          // Re-seek in case focus/selection moved the playhead.
          await seek(T, { label: `[scene ${n}/${N}]`, prog });
          how = await pressSplit();
          ok = await waitFor(() => sceneCount() === prevCount + 1, { timeout: CFG.splitWaitMs });
          if (!ok) throw new Error(`[scene ${n}/${N}] split at ${P.fmt(T)} did not create a new scene (count ${sceneCount()}). Stopped.`);
        }
        await pause(CFG.delays.afterSplit);

        // Refine the gap: scrollWidth is whole pixels (18 or 19 per split), so average
        // the total growth since the 1-scene width instead of using one delta.
        const s = scroller();
        const splits = sceneCount() - 1;
        const avg = (s.scrollWidth - calib.baseScrollWidth) / splits;
        if (s.scrollWidth - prevSW > 2 && avg > 2 && avg < 100 && Math.abs(avg - calib.gapPx) > 0.05) {
          log(`gapPx refined ${calib.gapPx.toFixed(2)} → ${avg.toFixed(2)} (average over ${splits} splits)`);
          calib.gapPx = avg;
        }

        // Verify: the new scene must start at T.
        const st = await sceneStartTime(newIdx, T);
        if (st == null || Math.abs(st - T) > CFG.splitVerifyTolerance) {
          throw new Error(`[scene ${n}/${N}] split landed at ${P.fmt(st)}, expected ${P.fmt(T)}. Undo with ${isMac ? 'Cmd' : 'Ctrl'}+Z, then re-run Calibrate and resume from scene ${n}.`);
        }
        await saveProg((p) => { p.calib = calib; if (!p.progress.splitDone.includes(T)) p.progress.splitDone.push(T); p.progress.splitLast = n; });
        slog(n, N, `split @${P.fmt(T)} (${how})`, `ok, ${sceneCount()} scenes, scene ${newIdx} starts ${P.fmt(st)}`);
      }
    } finally {
      await safeSend({ type: 'detach' });
    }

    const count = sceneCount();
    if (count === N) log(`Split done: ${count} scenes ✓`);
    else log(`Split finished but timeline has ${count} scenes, expected ${N}.`, 'warn');
  }

  // -------------------------------------------------------------------- fill
  const VO = CFG.voiceover;
  const squash = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();

  async function dbg(msg) {
    const r = await safeSend(msg);
    if (!r?.ok) throw new Error(`Debugger ${msg.type} failed: ${r?.error || 'no response'}`);
  }
  async function dbgClickEl(el) {
    const r = el.getBoundingClientRect();
    await dbg({ type: 'click', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  }

  const sidebar = () => [...document.querySelectorAll(VO.sidebarSel)].find(isVisible) || null;

  // Visible leaf-ish elements inside the sidebar whose own text matches.
  function sidebarLeaves(test) {
    const sb = sidebar();
    if (!sb) return [];
    const box = sb.querySelector(VO.scriptBoxSel); // the script itself is not UI text
    return [...sb.querySelectorAll('div,span,button,h2')].filter((el) => {
      if (box && (box.contains(el) || el.contains(box))) return false;
      if (el.children.length && [...el.children].some((c) => c.tagName !== 'svg' && norm(c.textContent))) return false;
      return isVisible(el) && test(norm(el.textContent));
    });
  }
  const sidebarButton = (lbl) => sidebar() && [...sidebar().querySelectorAll('[role="button"]')].find((el) => label(el) === lbl && isVisible(el)) || null;
  const enabled = (el) => el && el.getAttribute('aria-disabled') !== 'true' && !el.disabled;

  function sidebarScene() {
    for (const el of sidebarLeaves((t) => VO.sceneLabelRe.test(t))) {
      const m = norm(el.textContent).match(VO.sceneLabelRe);
      return { n: Number(m[1]), total: Number(m[2]) };
    }
    return null;
  }
  const scriptBox = () => sidebar()?.querySelector(VO.scriptBoxSel) || null;

  // Current script text ('' when only the placeholder shows, null if no editor).
  function currentScript() {
    const box = scriptBox();
    if (!box) return null;
    const t = norm([...box.querySelectorAll('text')].map((x) => x.textContent).join(' '));
    return squash(t) === squash(VO.placeholder) ? '' : t;
  }
  function charCount() {
    const el = sidebarLeaves((t) => VO.counterRe.test(t))[0];
    return el ? Number(norm(el.textContent).match(VO.counterRe)[1].replace(/,/g, '')) : null;
  }
  const scriptMatches = (speech) => {
    if (squash(currentScript()) === squash(speech)) return 'text';
    const c = charCount();
    return c != null && Math.abs(c - speech.length) <= 2 ? 'count' : null;
  };
  const outdatedShown = () => sidebarLeaves((t) => t === VO.outdatedText).length > 0;
  const inProgress = () => sidebarLeaves((t) => t.startsWith(VO.progressText)).length > 0;
  const voiceShown = () => sidebarLeaves((t) => t === VO.voiceName).length > 0;

  async function openVoiceoverPanel() {
    if (sidebar()) return true;
    const btn = findByText(VO.panelButtonText, { roles: ['button', 'tab', 'menuitem'] })[0];
    if (btn) { clickEl(btn); if (await waitFor(sidebar, { timeout: 5000 })) return true; }
    return false;
  }

  async function ensureCurrentSceneTab() {
    const sb = sidebar();
    const tab = sb && [...sb.querySelectorAll('[role="tab"]')].find((t) => norm(t.textContent) === VO.currentSceneTab);
    if (tab && tab.getAttribute('aria-selected') !== 'true') {
      await dbgClickEl(tab);
      await waitFor(() => tab.getAttribute('aria-selected') === 'true', { timeout: 3000 });
    }
  }

  // Make the sidebar show scene n: click it on the timeline, else step with the arrows.
  async function gotoScene(n, approxStart) {
    if (sidebarScene()?.n === n) return;
    await selectScene(n, approxStart).catch((e) => log(`select scene ${n} on timeline failed: ${e.message}`, 'warn'));
    if (await waitFor(() => sidebarScene()?.n === n, { timeout: 3000 })) return;
    for (let guard = 0; guard < 400; guard++) {
      const cur = sidebarScene();
      if (!cur) break;
      if (cur.n === n) return;
      const btn = sidebarButton(cur.n < n ? VO.nextLabel : VO.prevLabel);
      if (!enabled(btn)) break;
      await dbgClickEl(btn);
      await waitFor(() => sidebarScene()?.n !== cur.n, { timeout: 3000 });
    }
    throw new Error(`Could not show scene ${n} in the AI voiceover panel (panel shows ${JSON.stringify(sidebarScene())})`);
  }

  async function ensureVoice() {
    if (voiceShown()) return 'already ' + VO.voiceName;
    const change = sidebarButton(VO.changeVoiceLabel);
    if (!change) throw new Error(`Voice is not ${VO.voiceName} and "${VO.changeVoiceLabel}" was not found`);
    await dbgClickEl(change);
    const opt = await waitFor(() => findByText([VO.voiceName])[0], { timeout: 5000 });
    if (!opt) throw new Error(`Voice "${VO.voiceName}" not found in the voice list. Pick it by hand, then resume.`);
    await dbgClickEl(opt);
    await pause(CFG.delays.afterClick);
    const ok = findByText(VO.voiceConfirmText, { roles: ['button'] }).find(enabled);
    if (ok) { await dbgClickEl(ok); await pause(CFG.delays.afterClick); }
    if (!(await waitFor(voiceShown, { timeout: 5000 }))) throw new Error(`Voice still not ${VO.voiceName}. Pick it by hand, then resume.`);
    return 'changed to ' + VO.voiceName;
  }

  async function typeScript(speech) {
    const box = scriptBox();
    if (!box) throw new Error('Script editor not found');
    const r = box.getBoundingClientRect();
    await dbg({ type: 'click', x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + Math.min(12, r.height / 2)) });
    await pause(CFG.delays.afterClick);
    await dbg({ type: 'pressKey', combo: 'selectAll', isMac });
    await pause(CFG.delays.typing);
    await dbg({ type: 'insertText', text: speech });
    return await waitFor(() => scriptMatches(speech), { timeout: 4000 });
  }

  async function fillScene(video, idx, opts) {
    const N = video.scenes.length;
    const n = idx + 1;
    const sc = video.scenes[idx];
    status('fill', { scene: n, total: N });

    await gotoScene(n, sc.start);
    await ensureCurrentSceneTab();
    slog(n, N, 'panel', `showing scene ${sidebarScene()?.n}/${sidebarScene()?.total}`);

    const existing = currentScript();
    if (existing == null) throw new Error(`[scene ${n}/${N}] script editor not found in the panel`);
    const same = squash(existing) === squash(sc.speech);
    if (existing && !same && !opts.overwrite) {
      slog(n, N, 'script', `already has a different script ("${existing.slice(0, 40)}…"); skip. Tick "Overwrite existing" to replace.`, 'warn');
      return 'skipped';
    }

    slog(n, N, 'voice', await ensureVoice());

    if (!same) {
      let how = null;
      for (let a = 1; a <= CFG.retries && !how; a++) {
        how = await typeScript(sc.speech);
        if (!how) slog(n, N, 'type script', `attempt ${a}: panel shows "${(currentScript() || '').slice(0, 50)}" (count ${charCount()})`, 'warn');
      }
      if (!how) throw new Error(`[scene ${n}/${N}] script text did not stick in the editor`);
      slog(n, N, 'type script', `${sc.speech.length} chars ✓ (verified by ${how})`);
    } else {
      slog(n, N, 'script', 'already matches the file');
    }

    const ins = await waitFor(() => { const b = sidebarButton(VO.insertLabel); return enabled(b) ? b : null; }, { timeout: 5000 });
    if (!ins) {
      if (same && !outdatedShown()) { slog(n, N, 'voiceover', 'already inserted (no enabled Insert button), skip'); return 'skipped'; }
      throw new Error(`[scene ${n}/${N}] "${VO.insertLabel}" button is missing or disabled`);
    }
    await dbgClickEl(ins);
    slog(n, N, `click "${VO.insertLabel}"`, 'waiting for generation…');

    const started = await waitFor(() => inProgress() || !enabled(sidebarButton(VO.insertLabel)), { timeout: VO.startTimeoutMs, interval: 250 });
    if (!started) throw new Error(`[scene ${n}/${N}] nothing happened after clicking "${VO.insertLabel}"`);
    const t = Date.now();
    const done = await waitFor(() => !inProgress(), { timeout: VO.waitClipTimeoutMs, interval: 500 });
    if (!done) throw new Error(`[scene ${n}/${N}] voiceover still generating after ${VO.waitClipTimeoutMs / 1000}s`);
    const err = sidebarLeaves((x) => /error|couldn.t|failed|try again/i.test(x))[0];
    if (err) throw new Error(`[scene ${n}/${N}] Vids reported: ${norm(err.textContent)}`);
    slog(n, N, 'voiceover', `inserted ✓ (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    return 'inserted';
  }

  // Audit from the "All scenes" tab: each card shows "Scene k", the script (or "Add your script"),
  // and a visible "Voiceover outdated" badge when the audio doesn't match the script.
  async function audit(N) {
    const sb = sidebar();
    const tab = sb && [...sb.querySelectorAll('[role="tab"]')].find((t) => norm(t.textContent) === VO.allScenesTab);
    if (!tab) { log('Audit: "All scenes" tab not found; skipped', 'warn'); return; }
    await dbgClickEl(tab);
    await pause(CFG.delays.afterClick * 2);
    const cards = [...sidebar().querySelectorAll('[role="button"]')].filter(isVisible).map((card) => {
      const m = norm(card.textContent).match(/Scene (\d+)/);
      if (!m) return null;
      const outdated = [...card.querySelectorAll('span,div')].some((e) => !e.children.length && norm(e.textContent) === VO.outdatedText && isVisible(e));
      return { n: Number(m[1]), empty: norm(card.textContent).includes(VO.emptyCardText), outdated };
    }).filter(Boolean);
    const bad = [];
    for (let n = 1; n <= N; n++) {
      const c = cards.find((x) => x.n === n);
      if (!c) bad.push(`${n} (card not visible)`);
      else if (c.empty) bad.push(`${n} (no script)`);
      else if (c.outdated) bad.push(`${n} (voiceover outdated)`);
    }
    if (bad.length) log(`Audit: ${bad.length} scene(s) need attention: ${bad.join(', ')}`, 'warn');
    else log(`Audit: all ${N} scenes have a script and an up-to-date voiceover ✓`);
    await ensureCurrentSceneTab();
  }

  async function updateAllVoiceovers() {
    const more = sidebarButton(VO.moreActionsLabel);
    if (more) { await dbgClickEl(more); await pause(CFG.delays.afterClick); }
    const upd = await waitFor(() => findByText(VO.updateAllText, { exact: false })[0], { timeout: 4000 });
    if (!upd) throw new Error('"Update all voiceovers" not found');
    await dbgClickEl(upd);
    const rep = await waitFor(() => findByText(VO.replaceText, { roles: ['button'] })[0], { timeout: 5000 });
    if (!rep) throw new Error('"Replace" confirmation not found');
    await dbgClickEl(rep);
    log('Update all voiceovers → Replace clicked');
  }

  async function fill(video, opts) {
    status('fill');
    const N = video.scenes.length;
    const count = sceneCount();
    if (count !== N) log(`Timeline has ${count} scenes but the file has ${N}. Scene labels found: ${sceneLabelReport()}`, count < N ? 'error' : 'warn');
    if (count < N) throw new Error('Not enough scenes in the timeline for the voiceover fill');
    if (!calib) { const p = await loadProg(); calib = p.calib || null; }

    const r = await safeSend({ type: 'attach' });
    if (!r?.ok) throw new Error(`Could not attach debugger: ${r?.error || 'no response'}`);
    await pause(CFG.delays.afterDebuggerAttach);

    if (!(await openVoiceoverPanel())) throw new Error('AI voiceover panel not open. Open it by hand (select a scene → Voiceover), then run Fill again.');

    const prog = await loadProg();
    const startFrom = Math.max(1, Number(opts.startFrom) || 1);
    log(`Fill: scenes ${startFrom}..${N}${opts.overwrite ? ' (overwrite)' : ''}`);
    for (let idx = startFrom - 1; idx < N; idx++) {
      checkCancel();
      if (!opts.overwrite && prog.progress.fillDone.includes(idx + 1)) { slog(idx + 1, N, 'voiceover', 'already done (saved progress), skip'); continue; }
      await fillScene(video, idx, opts);
      await saveProg((p) => { p.progress.fillLast = idx + 1; if (!p.progress.fillDone.includes(idx + 1)) p.progress.fillDone.push(idx + 1); });
    }

    await audit(N);
    if (opts.updateAll) await updateAllVoiceovers();
  }

  // ------------------------------------------------------------------- inspect
  function inspect() {
    const roles = new Set(CFG.inspectRoles);
    const out = [];
    for (const el of document.querySelectorAll('[aria-label],[role],[contenteditable]')) {
      const role = el.getAttribute('role');
      const ce = el.getAttribute('contenteditable');
      if (!(el.hasAttribute('aria-label') || (role && roles.has(role)) || (ce != null && ce !== 'false'))) continue;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        role: role || undefined,
        aria: label(el) || undefined,
        text: norm(textOf(el)).slice(0, 60) || undefined,
        ce: ce != null ? ce : undefined,
        disabled: isDisabled(el) || undefined,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
      });
    }
    const s = scroller();
    return {
      url: location.href,
      viewport: [innerWidth, innerHeight],
      timer: document.querySelector(CFG.timerSel)?.textContent,
      sceneCount: sceneCount(),
      scroller: s ? { scrollWidth: s.scrollWidth, clientWidth: s.clientWidth, scrollLeft: s.scrollLeft, rect: (() => { const r = s.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() } : null,
      calib,
      elements: out
    };
  }

  // -------------------------------------------------------------------- jobs
  async function runJob(cmd, video, opts) {
    running = true; cancel = false; t0 = Date.now();
    status(cmd);
    try {
      if (!video || !video.scenes?.length) throw new Error('No video file loaded');
      if (!video.duration) video.duration = readTotal();
      if (video.voice) VO.voiceName = video.voice;
      // Attaching the debugger shows Chrome's banner, which shifts the page down.
      // Attach before calibrating so measured positions stay valid during the split.
      if ((cmd === 'split' || cmd === 'runAll') && CFG.split.useDebuggerKey) {
        const r = await safeSend({ type: 'attach' });
        if (!r?.ok) throw new Error(`Could not attach debugger: ${r?.error || 'no response'}`);
        log('Debugger attached (the yellow "debugging this browser" bar is expected)');
        await pause(CFG.delays.afterDebuggerAttach);
      }
      if (cmd === 'calibrate') await calibrate(video);
      else if (cmd === 'split') { await calibrate(video); await split(video, opts); }
      else if (cmd === 'fill') await fill(video, opts);
      else if (cmd === 'runAll') {
        await calibrate(video);
        await split(video, opts);
        await fill(video, { ...opts, startFrom: 1 });
      }
      log(`${cmd}: finished`);
    } catch (e) {
      if (e instanceof Cancelled) log(`${cmd}: stopped by user`, 'warn');
      else log(`${cmd}: ERROR: ${e.message}`, 'error');
    } finally {
      running = false;
      await safeSend({ type: 'detach' });
      status('idle');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.cmd) {
        case 'ping':
          sendResponse({ ok: true, docId, running });
          return;
        case 'pageInfo':
          sendResponse({ ok: true, docId, running, duration: readTotal(), timer: readTimer(), sceneCount: sceneCount(), calib });
          return;
        case 'stop':
          cancel = true;
          safeSend({ type: 'detach' });
          log('Stop requested');
          sendResponse({ ok: true });
          return;
        case 'debuggerDetached':
          if (running) { cancel = true; log(`Debugger detached (${msg.reason}); stopping.`, 'warn'); }
          return;
        case 'inspect': {
          const data = inspect();
          log(`Inspect DOM: ${data.elements.length} elements (JSON copied to clipboard by the popup)`);
          console.log('[Vids Autopilot] Inspect DOM', data);
          sendResponse({ ok: true, data });
          return;
        }
        case 'calibrate':
        case 'split':
        case 'fill':
        case 'runAll':
          if (running) { sendResponse({ ok: false, error: 'A job is already running' }); return; }
          runJob(msg.cmd, msg.video, msg.opts || {}).catch((e) => log(`Unexpected: ${e.message}`, 'error'));
          sendResponse({ ok: true });
          return;
        default:
          return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  });

  window.addEventListener('unhandledrejection', (ev) => {
    if (ev.reason instanceof Cancelled) ev.preventDefault();
  });
})();
