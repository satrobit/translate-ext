(() => {
  if (!document.documentElement || document.documentElement.nodeName !== 'HTML') return;
  // The page's `window` (isolated world) outlives extension reloads, so a flag
  // here can belong to an orphaned instance whose messaging is dead. We only get
  // injected twice when the old instance isn't answering, so always take over.
  if (window.__pageTranslate) {
    try {
      window.__pageTranslate.teardown();
    } catch {}
  }
  let dead = false;
  window.__pageTranslate = { teardown: () => teardown() };

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'AUDIO', 'VIDEO',
  ]);
  const ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];
  const HAS_LETTER = /\p{L}/u;
  const HOST_ID = '__page-translate-ui';

  const ctx = {
    lang: 'und',
    langName: 'Unknown',
    targetLang: 'en',
    targetName: 'English',
    host: location.hostname,
    rules: {},
    languages: {},
    bubbleOnTranslate: false,
  };

  let translated = false; // page is (being) shown translated
  let gen = 0; // bumps on restore / retarget, to drop stale responses
  let inflight = 0;
  let errorMsg = '';
  const units = new Map(); // Text node -> unit, or Element -> Map(attr -> unit)
  const queue = new Set();
  const waiting = new WeakMap(); // Element -> Set(unit) waiting to become visible
  const localCache = new Map(); // source text -> translation, for ctx.targetLang
  const detectedCounts = {};

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(r || {});
        });
      } catch (e) {
        resolve({ error: e.message });
      }
    });

  // -------------------------------------------------------------------------
  // Units: one translatable string (a text node or an attribute)
  // -------------------------------------------------------------------------

  function makeUnit(node, attr) {
    return {
      node,
      attr,
      orig: attr ? node.getAttribute(attr) : node.nodeValue,
      trans: null, // value we wrote to the DOM
    };
  }
  const getVal = (u) => (u.attr ? u.node.getAttribute(u.attr) : u.node.nodeValue);
  const setVal = (u, v) => (u.attr ? u.node.setAttribute(u.attr, v) : (u.node.nodeValue = v));

  function isSkippedElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.nodeName.toUpperCase())) return true;
    if (el.id === HOST_ID) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function insideSkipped(el) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      if (isSkippedElement(e)) return true;
    }
    return false;
  }

  function worthTranslating(s) {
    return s && s.trim().length > 0 && HAS_LETTER.test(s);
  }

  function addTextUnit(node) {
    let u = units.get(node);
    if (u && getVal(u) === u.trans) return; // already translated, unchanged
    if (!worthTranslating(node.nodeValue)) return;
    if (!u) units.set(node, (u = makeUnit(node)));
    else {
      u.orig = node.nodeValue;
      u.trans = null;
    }
    schedule(u, node.parentElement);
  }

  function addAttrUnits(el) {
    const list = el.nodeName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? [...ATTRS, 'value'] : ATTRS;
    for (const attr of list) {
      const v = el.getAttribute(attr);
      if (!worthTranslating(v)) continue;
      let m = units.get(el);
      if (!m) units.set(el, (m = new Map()));
      let u = m.get(attr);
      if (u && v === u.trans) continue;
      if (!u) m.set(attr, (u = makeUnit(el, attr)));
      else {
        u.orig = v;
        u.trans = null;
      }
      schedule(u, el);
    }
  }

  // Translate lazily: only when the element is near the viewport.
  // Elements without a layout box (title, option) are translated right away.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const set = waiting.get(e.target);
        io.unobserve(e.target);
        waiting.delete(e.target);
        if (set) for (const u of set) enqueue(u);
      }
    },
    { rootMargin: '1000px 0px 1000px 0px' },
  );

  function schedule(u, el) {
    if (!el || el.closest('head, title, option, optgroup, select') || !el.isConnected) {
      enqueue(u);
      return;
    }
    let set = waiting.get(el);
    if (!set) {
      waiting.set(el, (set = new Set()));
      io.observe(el);
    }
    set.add(u);
  }

  function scan(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return isSkippedElement(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    if (root.nodeType === 1) addAttrUnits(root);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) addTextUnit(n);
      else {
        addAttrUnits(n);
        if (n.shadowRoot) {
          scan(n.shadowRoot);
          observeRoot(n.shadowRoot);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Request queue
  // -------------------------------------------------------------------------

  let flushTimer = 0;
  function enqueue(u) {
    queue.add(u);
    if (!flushTimer) flushTimer = setTimeout(flush, 30);
  }

  const MAX_INFLIGHT = 4;
  const BATCH_ITEMS = 80;
  const BATCH_CHARS = 4000;

  function split(s) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    return [m[1], m[2], m[3]];
  }

  function apply(u, translation) {
    const cur = getVal(u);
    if (cur !== u.orig) return; // page changed it since; mutation handler re-queues
    const [lead, , trail] = split(cur);
    const v = lead + translation + trail;
    u.trans = v;
    if (v !== cur) setVal(u, v);
  }

  function flush() {
    flushTimer = 0;
    if (!translated) {
      queue.clear();
      return;
    }
    while (queue.size && inflight < MAX_INFLIGHT) {
      const batch = new Map(); // core text -> [units]
      let chars = 0;
      for (const u of queue) {
        queue.delete(u);
        if (!u.node.isConnected || u.trans !== null) continue;
        const cur = getVal(u);
        if (cur !== u.orig) {
          u.orig = cur;
        }
        const core = split(cur)[1];
        if (!core) continue;
        if (localCache.has(core)) {
          apply(u, localCache.get(core));
          continue;
        }
        if (!batch.has(core)) {
          batch.set(core, []);
          chars += core.length;
        }
        batch.get(core).push(u);
        if (batch.size >= BATCH_ITEMS || chars >= BATCH_CHARS) break;
      }
      if (!batch.size) continue;
      request(batch);
    }
    updateUI();
  }

  async function request(batch) {
    inflight++;
    const myGen = gen;
    const texts = [...batch.keys()];
    const tl = ctx.targetLang;
    updateUI();
    const r = await send({ type: 'translate', texts, tl });
    inflight--;
    if (myGen !== gen) return;
    if (r.error) {
      errorMsg = r.error;
      // Put them back so "Try again" picks them up.
      for (const list of batch.values()) for (const u of list) failed.add(u);
      updateUI();
      return;
    }
    errorMsg = '';
    const pending = observer.takeRecords();
    if (pending.length) handleMutations(pending);
    texts.forEach((t, i) => {
      const tr = r.translations[i];
      if (tr == null) return;
      localCache.set(t, tr);
      for (const u of batch.get(t)) apply(u, tr);
      const l = r.langs && r.langs[i];
      if (l) detectedCounts[l] = (detectedCounts[l] || 0) + t.length;
    });
    observer.takeRecords(); // drop records caused by our own writes
    if (ctx.lang === 'und') guessLangFromResults();
    if (queue.size) flush();
    else updateUI();
  }
  const failed = new Set();

  function guessLangFromResults() {
    let best = null;
    let total = 0;
    for (const [l, n] of Object.entries(detectedCounts)) {
      total += n;
      if (!best || n > detectedCounts[best]) best = l;
    }
    // Only name a language when it clearly dominates a decent amount of text.
    if (best && detectedCounts[best] >= 100 && detectedCounts[best] / total >= 0.6) {
      ctx.lang = best;
      ctx.langName = ctx.languages[best] || displayName(best);
    }
  }

  function displayName(code) {
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
      return code;
    }
  }

  // -------------------------------------------------------------------------
  // Watching the page for changes while translated
  // -------------------------------------------------------------------------

  const observer = new MutationObserver(handleMutations);
  const observedRoots = new Set();
  const OBS_OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] };

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, OBS_OPTS);
  }

  function handleMutations(records) {
    if (!translated) return;
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const n of rec.addedNodes) {
          if (n.nodeType === 3) {
            if (!insideSkipped(n.parentElement)) addTextUnit(n);
          } else if (n.nodeType === 1 && n.id !== HOST_ID && !insideSkipped(n)) {
            scan(n);
          }
        }
      } else if (rec.type === 'characterData') {
        const n = rec.target;
        const u = units.get(n);
        if (u && n.nodeValue === u.trans) continue; // our own write
        if (!insideSkipped(n.parentElement)) addTextUnit(n);
      } else if (rec.type === 'attributes') {
        const m = units.get(rec.target);
        const u = m && m.get(rec.attributeName);
        if (u && rec.target.getAttribute(rec.attributeName) === u.trans) continue;
        if (!insideSkipped(rec.target)) addAttrUnits(rec.target);
      }
    }
  }

  // Forget detached nodes now and then (infinite-scroll pages).
  const pruneTimer = setInterval(() => {
    for (const k of units.keys()) if (!k.isConnected) units.delete(k);
  }, 30000);

  // -------------------------------------------------------------------------
  // Public actions
  // -------------------------------------------------------------------------

  function translatePage() {
    if (translated) return;
    translated = true;
    errorMsg = '';
    document.documentElement.classList.add('translated-ltr');
    observeRoot(document.documentElement);
    scan(document.documentElement);
    flush();
    notifyState();
    updateUI();
  }

  function restorePage() {
    if (!translated) return;
    translated = false;
    gen++;
    observer.disconnect();
    observedRoots.clear();
    io.disconnect();
    queue.clear();
    failed.clear();
    for (const [, v] of units) {
      const list = v instanceof Map ? v.values() : [v];
      for (const u of list) {
        if (u.trans !== null && u.node.isConnected && getVal(u) === u.trans) setVal(u, u.orig);
      }
    }
    units.clear();
    document.documentElement.classList.remove('translated-ltr');
    errorMsg = '';
    notifyState();
    updateUI();
  }

  // Called by a newer instance of this script (e.g. after the extension reloads).
  function teardown() {
    restorePage();
    dead = true;
    clearInterval(pruneTimer);
    clearTimeout(flushTimer);
    clearTimeout(autoHideTimer);
    if (ui) ui.host.remove();
    ui = null;
  }

  function retry() {
    errorMsg = '';
    for (const u of failed) enqueue(u);
    failed.clear();
    updateUI();
  }

  function retarget(lang) {
    if (!lang || lang === ctx.targetLang) return;
    const was = translated;
    restorePage();
    ctx.targetLang = lang;
    ctx.targetName = ctx.languages[lang] || displayName(lang);
    localCache.clear();
    if (was) translatePage();
  }

  function notifyState() {
    send({ type: 'state', translated, targetLang: ctx.targetLang });
  }

  function getState() {
    return {
      ok: true,
      translated,
      busy: translated && (inflight > 0 || queue.size > 0),
      error: errorMsg,
      lang: ctx.lang,
      langName: ctx.langName,
      targetLang: ctx.targetLang,
      targetName: ctx.targetName,
      host: ctx.host,
    };
  }

  // -------------------------------------------------------------------------
  // Chrome-style translate bubble (shadow DOM so page CSS can't touch it)
  // -------------------------------------------------------------------------

  let ui = null;
  let autoHideTimer = 0;

  const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#1a73e8" d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;

  const CSS = `
    :host { all: initial; }
    .bubble {
      position: fixed; top: 12px; right: 16px; z-index: 2147483647;
      width: 340px; box-sizing: border-box;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1f1f1f; background: #fff; border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.12);
      padding: 12px 12px 10px; animation: in .14s ease-out;
    }
    @keyframes in { from { opacity: 0; transform: translateY(-6px); } }
    .row { display: flex; align-items: center; gap: 6px; }
    .title { flex: 1; font-weight: 500; display: flex; align-items: center; gap: 8px; }
    .icon-btn { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 50%;
      display: grid; place-items: center; color: #444; }
    .icon-btn:hover { background: rgba(0,0,0,.06); }
    .tabs { display: flex; margin-top: 10px; border-bottom: 1px solid #e3e3e3; }
    .tab { all: unset; cursor: pointer; padding: 8px 12px; color: #444; font-weight: 500;
      border-bottom: 3px solid transparent; margin-bottom: -1px; max-width: 50%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tab:hover { background: rgba(0,0,0,.04); }
    .tab.on { color: #1a73e8; border-bottom-color: #1a73e8; }
    .status { margin-top: 8px; color: #5f5f5f; font-size: 12px; min-height: 16px; display: flex; gap: 8px; align-items: center; }
    .status.err { color: #c5221f; }
    .status a { color: #1a73e8; cursor: pointer; text-decoration: underline; }
    .spinner { width: 12px; height: 12px; border: 2px solid #c6dafc; border-top-color: #1a73e8;
      border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .menu { position: absolute; top: 44px; right: 12px; background: #fff; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,.2); padding: 6px 0; min-width: 240px; z-index: 1; }
    .menu button { all: unset; box-sizing: border-box; display: flex; gap: 10px; align-items: center;
      width: 100%; padding: 8px 14px; cursor: pointer; }
    .menu button:hover { background: rgba(0,0,0,.06); }
    .check { width: 16px; color: #1a73e8; font-weight: 700; }
    .sep { height: 1px; background: #e3e3e3; margin: 6px 0; }
    select { margin-top: 10px; width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #ccc;
      font: inherit; background: #fff; color: inherit; }
    .hidden { display: none !important; }
    @media (prefers-color-scheme: dark) {
      .bubble, .menu { background: #2b2b2b; color: #e3e3e3; }
      .icon-btn, .tab { color: #c4c4c4; }
      .icon-btn:hover, .menu button:hover, .tab:hover { background: rgba(255,255,255,.08); }
      .tabs, .sep { border-color: #444; background-color: transparent; }
      .sep { background: #444; }
      .tab.on { color: #8ab4f8; border-bottom-color: #8ab4f8; }
      .status { color: #aaa; } .status.err { color: #f28b82; } .status a { color: #8ab4f8; }
      select { background: #1f1f1f; border-color: #555; }
    }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="bubble hidden" role="dialog" aria-label="Translate">
        <div class="row">
          <div class="title">${ICON}<span class="heading">Translate this page?</span></div>
          <button class="icon-btn more" title="Options" aria-label="Options">
            <svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>
          </button>
          <button class="icon-btn close" title="Close" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="tabs">
          <button class="tab src"></button>
          <button class="tab dst"></button>
        </div>
        <select class="target hidden" aria-label="Translate to"></select>
        <div class="status"></div>
        <div class="menu hidden">
          <button data-act="alwaysLang"><span class="check"></span><span class="label"></span></button>
          <button data-act="neverLang"><span class="check"></span><span class="label"></span></button>
          <button data-act="neverSite"><span class="check"></span><span class="label">Never translate this site</span></button>
          <div class="sep"></div>
          <button data-act="choose"><span class="check"></span><span>Choose another language…</span></button>
          <button data-act="settings"><span class="check"></span><span>Translation settings</span></button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = {
      host,
      bubble: $('.bubble'),
      heading: $('.heading'),
      src: $('.src'),
      dst: $('.dst'),
      status: $('.status'),
      menu: $('.menu'),
      select: $('.target'),
      root,
    };

    ui.src.onclick = () => restorePage();
    ui.dst.onclick = () => (errorMsg ? retry() : translatePage());
    $('.close').onclick = hideBubble;
    $('.more').onclick = (e) => {
      e.stopPropagation();
      renderMenu();
      ui.menu.classList.toggle('hidden');
    };
    ui.bubble.addEventListener('click', (e) => {
      if (!e.composedPath().includes(ui.menu)) ui.menu.classList.add('hidden');
    });
    ui.bubble.addEventListener('mouseenter', () => clearTimeout(autoHideTimer));
    ui.menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      ui.menu.classList.add('hidden');
      if (act === 'settings') return send({ type: 'openOptions' });
      if (act === 'choose') {
        fillSelect();
        ui.select.classList.toggle('hidden');
        return;
      }
      const on = !ctx.rules[act];
      const value = act.endsWith('Site') ? ctx.host : ctx.lang;
      await send({ type: 'setRule', kind: act, value, on });
      ctx.rules[act] = on;
      if (on) {
        const opposite = { alwaysLang: 'neverLang', neverLang: 'alwaysLang', neverSite: 'alwaysSite' }[act];
        ctx.rules[opposite] = false;
      }
      if (on && act === 'alwaysLang') translatePage();
      if (on && (act === 'neverLang' || act === 'neverSite')) {
        restorePage();
        hideBubble();
      }
    });
    ui.select.onchange = () => {
      const lang = ui.select.value;
      send({ type: 'setTarget', targetLang: lang });
      ui.select.classList.add('hidden');
      const was = translated;
      retarget(lang);
      if (!was) translatePage();
    };
    // Close bubble when clicking elsewhere on the page.
    document.addEventListener(
      'mousedown',
      (e) => {
        if (ui && !ui.bubble.classList.contains('hidden') && !e.composedPath().includes(ui.host)) {
          ui.menu.classList.add('hidden');
        }
      },
      true,
    );
    (document.body || document.documentElement).appendChild(host);
  }

  function fillSelect() {
    if (ui.select.options.length) return;
    const entries = Object.entries(ctx.languages).sort((a, b) => a[1].localeCompare(b[1]));
    for (const [code, name] of entries) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      if (code === ctx.targetLang) o.selected = true;
      ui.select.appendChild(o);
    }
  }

  function renderMenu() {
    const items = ui.menu.querySelectorAll('button[data-act]');
    for (const b of items) {
      const act = b.dataset.act;
      if (act === 'alwaysLang') b.querySelector('.label').textContent = `Always translate ${ctx.langName}`;
      if (act === 'neverLang') b.querySelector('.label').textContent = `Never translate ${ctx.langName}`;
      if (act === 'alwaysLang' || act === 'neverLang') b.classList.toggle('hidden', ctx.lang === 'und');
      b.querySelector('.check').textContent = ctx.rules[act] ? '✓' : '';
    }
  }

  function showBubble(autoHideMs = 0) {
    if (!ui) buildUI();
    if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
    ui.bubble.classList.remove('hidden');
    clearTimeout(autoHideTimer);
    if (autoHideMs) autoHideTimer = setTimeout(hideBubble, autoHideMs);
    updateUI();
  }

  function hideBubble() {
    if (!ui) return;
    ui.bubble.classList.add('hidden');
    ui.menu.classList.add('hidden');
    ui.select.classList.add('hidden');
  }

  function updateUI() {
    if (!ui) return;
    ui.src.textContent = ctx.lang === 'und' ? 'Detected language' : ctx.langName;
    ui.dst.textContent = ctx.targetName;
    ui.src.classList.toggle('on', !translated);
    ui.dst.classList.toggle('on', translated);
    ui.heading.textContent = translated ? 'Translated' : 'Translate this page?';
    ui.status.classList.toggle('err', !!errorMsg);
    if (errorMsg) {
      ui.status.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = errorMsg;
      const a = document.createElement('a');
      a.textContent = 'Try again';
      a.onclick = retry;
      ui.status.append(span, a);
    } else if (translated && (inflight > 0 || queue.size > 0)) {
      ui.status.innerHTML = '<span class="spinner"></span><span>Translating…</span>';
    } else if (translated) {
      ui.status.textContent = `Page translated to ${ctx.targetName}`;
    } else {
      ui.status.textContent = '';
    }
  }

  // -------------------------------------------------------------------------
  // Selection translation card
  // -------------------------------------------------------------------------

  async function translateSelection(textFromMenu) {
    const sel = window.getSelection();
    const text = (sel && sel.toString().trim()) || textFromMenu || '';
    if (!text) return;
    let rect = { left: window.innerWidth / 2 - 160, bottom: 80 };
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) rect = r;
    }
    if (!ui) buildUI();
    if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
    let card = ui.root.querySelector('.selcard');
    if (!card) {
      const style = document.createElement('style');
      style.textContent = `
        .selcard { position: fixed; z-index: 2147483647; width: 320px; max-height: 300px; overflow: auto;
          box-sizing: border-box; padding: 12px 14px; border-radius: 10px; background: #fff; color: #1f1f1f;
          font: 14px/1.45 system-ui, -apple-system, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
        .selcard .meta { font-size: 11px; color: #5f5f5f; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em; }
        @media (prefers-color-scheme: dark) { .selcard { background: #2b2b2b; color: #e3e3e3; } .selcard .meta { color: #aaa; } }`;
      card = document.createElement('div');
      card.className = 'selcard';
      ui.root.append(style, card);
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!e.composedPath().includes(card)) card.classList.add('hidden');
        },
        true,
      );
    }
    card.classList.remove('hidden');
    card.innerHTML = '<div class="meta">Translating…</div>';
    const top = Math.min(rect.bottom + 8, window.innerHeight - 120);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 328));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    const r = await send({ type: 'translate', texts: [text], tl: ctx.targetLang });
    card.innerHTML = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const body = document.createElement('div');
    if (r.error) {
      meta.textContent = 'Error';
      body.textContent = r.error;
    } else {
      const from = r.langs && r.langs[0];
      meta.textContent = `${from ? ctx.languages[from] || displayName(from) : ''} → ${ctx.targetName}`;
      body.textContent = r.translations[0];
    }
    card.append(meta, body);
  }

  // -------------------------------------------------------------------------
  // Messages from popup / background
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (dead) return;
    switch (msg.type) {
      case 'ping':
      case 'getState':
        sendResponse(getState());
        break;
      case 'translate':
        if (msg.targetLang) retarget(msg.targetLang);
        translatePage();
        sendResponse(getState());
        break;
      case 'restore':
        restorePage();
        sendResponse(getState());
        break;
      case 'toggle':
        translated ? restorePage() : translatePage();
        if (ctx.bubbleOnTranslate) showBubble(2500);
        else if (!translated) hideBubble();
        sendResponse(getState());
        break;
      case 'showBubble':
        showBubble();
        sendResponse(getState());
        break;
      case 'translateSelection':
        translateSelection(msg.text);
        sendResponse({ ok: true });
        break;
      case 'rulesChanged':
        if (msg.rules) Object.assign(ctx.rules, msg.rules);
        sendResponse({ ok: true });
        break;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (dead || area !== 'sync') return;
    if (changes.bubbleOnTranslate) ctx.bubbleOnTranslate = !!changes.bubbleOnTranslate.newValue;
    if (changes.targetLang && changes.targetLang.newValue !== ctx.targetLang) retarget(changes.targetLang.newValue);
  });

  // -------------------------------------------------------------------------
  // Init: detect language and decide whether to offer / auto-translate
  // -------------------------------------------------------------------------

  function sampleText(limit = 3000) {
    const body = document.body;
    if (!body) return '';
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === 1 ? (isSkippedElement(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
    });
    let out = '';
    let n;
    while ((n = walker.nextNode()) && out.length < limit) {
      const t = n.nodeValue.trim();
      if (t.length > 1 && HAS_LETTER.test(t)) out += t + ' ';
    }
    return out.trim();
  }

  async function init(attempt = 0) {
    // Chrome's built-in image/video/audio viewers have nothing to translate.
    if (/^(image|video|audio)\//.test(document.contentType)) return;
    const sample = sampleText();
    if (sample.length < 40 && attempt < 3) {
      // SPA still rendering.
      setTimeout(() => init(attempt + 1), 1200);
      return;
    }
    const r = await send({
      type: 'decide',
      url: location.href,
      htmlLang: document.documentElement.lang,
      sample: (document.title + ' ' + sample).trim(),
    });
    if (r.error || dead) return;
    Object.assign(ctx, {
      lang: r.lang,
      langName: r.langName,
      targetLang: r.targetLang,
      targetName: r.targetName,
      host: r.host,
      rules: r.rules,
      languages: r.languages,
    });
    ctx.bubbleOnTranslate = !!r.bubbleOnTranslate;
    if (r.action === 'auto') {
      translatePage();
      if (ctx.bubbleOnTranslate) showBubble(2500);
    } else if (r.action === 'offer') {
      showBubble();
    }
  }

  init();
})();
