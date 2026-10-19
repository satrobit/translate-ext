import { DEFAULTS, LANGUAGES, getSettings, setSettings, normLang, langName, hostOf } from './lib.js';

// ---------------------------------------------------------------------------
// Translation engines
// ---------------------------------------------------------------------------

const MAX_ITEMS = 100;
const MAX_CHARS = 4500;
const cache = new Map(); // `${tl}\u0001${text}` -> [translation, detectedLang]
const CACHE_MAX = 30000;

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest ~10% (Map preserves insertion order).
    let n = CACHE_MAX / 10;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (--n <= 0) break;
    }
  }
  cache.set(key, value);
}

function chunk(texts) {
  const chunks = [];
  let cur = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= MAX_ITEMS || chars + t.length > MAX_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function fetchWithRetry(url, init, tries = 3) {
  let delay = 800;
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (i >= tries - 1) throw new Error('Network error: ' + e.message);
    }
    if (res) {
      if (res.ok) return res;
      if (i >= tries - 1 || !(res.status === 429 || res.status >= 500)) {
        let detail = '';
        try {
          const body = await res.text();
          detail = (JSON.parse(body).error || {}).message || '';
        } catch {}
        if (res.status === 429) throw new Error('Google rate-limited translation requests. Try again in a minute, or add a Cloud API key in settings.');
        throw new Error(`Translation request failed (${res.status})${detail ? ': ' + detail : ''}`);
      }
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

async function translateFree(texts, tl, sl) {
  const body = new URLSearchParams();
  for (const t of texts) body.append('q', t);
  const url = `https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&format=text&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Google blocked the request (captcha). Wait a bit or add a Cloud API key in settings.');
  }
  if (!Array.isArray(data)) data = [data];
  // sl=auto -> [[translation, detectedLang], ...]; explicit sl -> [translation, ...]
  return data.map((item) => (Array.isArray(item) ? [item[0], item[1] || sl] : [item, sl]));
}

async function translateCloud(texts, tl, sl, apiKey) {
  if (!apiKey) throw new Error('Cloud Translation engine selected but no API key set (see extension settings).');
  const out = [];
  // Cloud API v2 allows at most 128 segments per request.
  for (let i = 0; i < texts.length; i += 128) {
    const q = texts.slice(i, i + 128);
    const payload = { q, target: tl, format: 'text' };
    if (sl && sl !== 'auto') payload.source = sl;
    const res = await fetchWithRetry(
      `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    );
    const json = await res.json();
    for (const t of json.data.translations) {
      out.push([t.translatedText, t.detectedSourceLanguage || sl]);
    }
  }
  return out;
}

async function translate(texts, tl, sl = 'auto') {
  const settings = await getSettings();
  const results = new Array(texts.length);
  const missing = [];
  const missingIdx = [];
  texts.forEach((t, i) => {
    const hit = cache.get(`${tl}\u0001${t}`);
    if (hit) results[i] = hit;
    else {
      missing.push(t);
      missingIdx.push(i);
    }
  });

  if (missing.length) {
    const engine = settings.engine === 'cloud' ? translateCloud : translateFree;
    let pos = 0;
    for (const part of chunk(missing)) {
      const translated = await engine(part, tl, sl, settings.apiKey);
      translated.forEach((r, j) => {
        const i = missingIdx[pos + j];
        results[i] = r;
        cacheSet(`${tl}\u0001${texts[i]}`, r);
      });
      pos += part.length;
    }
  }
  return {
    translations: results.map((r) => r[0]),
    langs: results.map((r) => r[1]),
  };
}

// ---------------------------------------------------------------------------
// Language detection & auto-translate decision
// ---------------------------------------------------------------------------

// With less text than this, detectors return confident-looking noise (e.g. an
// image viewer whose only text is the file name), and there's nothing worth
// translating anyway.
const MIN_DETECT_LETTERS = 40;
// Google always names *some* language, with no confidence, so only ask it when
// there's enough text for the answer to mean something.
const MIN_REMOTE_DETECT_LETTERS = 200;

async function detect(sample, htmlLang) {
  const letters = ((sample || '').match(/\p{L}/gu) || []).length;
  if (letters < MIN_DETECT_LETTERS) return 'und';
  try {
    const r = await chrome.i18n.detectLanguage(sample);
    const top = r.languages && r.languages[0];
    // `percentage` is the share of the text in that language, not confidence,
    // so it can't stand in for `isReliable`.
    if (r.isReliable && top && top.percentage >= 50 && top.language !== 'und') return normLang(top.language);
  } catch {}
  if (htmlLang) return normLang(htmlLang);
  if (letters >= MIN_REMOTE_DETECT_LETTERS) {
    // Ask Google to detect it.
    try {
      const { langs } = await translate([sample.slice(0, 500)], 'en');
      if (langs[0]) return normLang(langs[0]);
    } catch {}
  }
  return 'und';
}

async function decide({ url, htmlLang, sample }) {
  const s = await getSettings();
  const host = hostOf(url);
  const lang = await detect(sample, htmlLang);
  const target = normLang(s.targetLang);
  let action = 'none';
  if (lang !== 'und' && lang !== target && !s.neverSites.includes(host) && !s.neverLangs.includes(lang)) {
    if (s.alwaysSites.includes(host) || s.alwaysLangs.includes(lang) || s.autoTranslateAll) action = 'auto';
    else if (s.showBanner) action = 'offer';
  }
  return {
    lang,
    langName: lang === 'und' ? 'Unknown' : langName(lang),
    targetLang: s.targetLang,
    targetName: langName(s.targetLang),
    action,
    bubbleOnTranslate: s.bubbleOnTranslate,
    host,
    rules: {
      alwaysLang: s.alwaysLangs.includes(lang),
      neverLang: s.neverLangs.includes(lang),
      alwaysSite: s.alwaysSites.includes(host),
      neverSite: s.neverSites.includes(host),
    },
    languages: LANGUAGES,
  };
}

// kind: alwaysLang | neverLang | alwaysSite | neverSite
async function setRule(kind, value, on) {
  const s = await getSettings();
  const lists = {
    alwaysLang: 'alwaysLangs',
    neverLang: 'neverLangs',
    alwaysSite: 'alwaysSites',
    neverSite: 'neverSites',
  };
  const opposite = { alwaysLang: 'neverLang', neverLang: 'alwaysLang', alwaysSite: 'neverSite', neverSite: 'alwaysSite' };
  const key = lists[kind];
  const okey = lists[opposite[kind]];
  const patch = {};
  patch[key] = s[key].filter((v) => v !== value);
  if (on) {
    patch[key].push(value);
    patch[okey] = s[okey].filter((v) => v !== value);
  }
  await setSettings(patch);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'translate':
        return translate(msg.texts, msg.tl, msg.sl || 'auto');
      case 'decide':
        return decide(msg);
      case 'setRule':
        await setRule(msg.kind, msg.value, msg.on);
        return { ok: true };
      case 'setTarget':
        await setSettings({ targetLang: msg.targetLang });
        return { ok: true };
      case 'state':
        if (sender.tab) updateBadge(sender.tab.id, msg);
        return { ok: true };
      case 'openOptions':
        chrome.runtime.openOptionsPage();
        return { ok: true };
      case 'clearCache':
        cache.clear();
        return { ok: true };
      default:
        return { error: 'unknown message' };
    }
  })().then(
    (r) => sendResponse(r),
    (e) => sendResponse({ error: e.message || String(e) }),
  );
  return true;
});

function updateBadge(tabId, { translated, targetLang }) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' }).catch(() => {});
  chrome.action
    .setBadgeText({ tabId, text: translated ? normLang(targetLang).slice(0, 2).toUpperCase() : '' })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Context menus, keyboard command, install
// ---------------------------------------------------------------------------

// Serialized: onInstalled and storage.onChanged can both fire at install time,
// and overlapping removeAll/create calls produce "duplicate id" errors.
let menuChain = Promise.resolve();
function buildMenus() {
  menuChain = menuChain.then(rebuildMenus, rebuildMenus);
  return menuChain;
}

async function rebuildMenus() {
  const s = await getSettings();
  await chrome.contextMenus.removeAll();
  const name = langName(s.targetLang);
  const items = [
    { id: 'translate-page', title: `Translate to ${name}`, contexts: ['page', 'frame', 'link', 'image'] },
    { id: 'show-original', title: 'Show original', contexts: ['page', 'frame', 'link', 'image'] },
    { id: 'translate-selection', title: `Translate selection to ${name}`, contexts: ['selection'] },
  ];
  for (const item of items) {
    await new Promise((resolve) => chrome.contextMenus.create(item, () => resolve(chrome.runtime.lastError)));
  }
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Content script not present (tab opened before install) — inject and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return null;
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const type = { 'translate-page': 'translate', 'show-original': 'restore', 'translate-selection': 'translateSelection' }[info.menuItemId];
  if (type) sendToTab(tab.id, { type, text: info.selectionText });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) sendToTab(tab.id, { type: 'toggle' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.targetLang) buildMenus();
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in s)) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  buildMenus();
});

chrome.runtime.onStartup.addListener(buildMenus);
