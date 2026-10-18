import { LANGUAGES, getSettings, setSettings, langName } from './lib.js';

const $ = (id) => document.getElementById(id);
const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));
let settings;
let savedTimer;

function flashSaved() {
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

async function save(patch) {
  Object.assign(settings, patch);
  await setSettings(patch);
  flashSaved();
}

function fillLangSelect(sel, selected) {
  for (const [code, name] of sortedLangs) sel.add(new Option(name, code, false, code === selected));
}

function renderList(key) {
  const box = $(key);
  box.innerHTML = '';
  const isLang = key.endsWith('Langs');
  if (!settings[key].length) {
    box.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'None' }));
  }
  for (const v of settings[key]) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(isLang ? langName(v) : v);
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = 'Remove';
    x.onclick = () => save({ [key]: settings[key].filter((i) => i !== v) }).then(() => renderList(key));
    chip.append(x);
    box.append(chip);
  }
}

function renderEngine() {
  for (const r of document.querySelectorAll('input[name=engine]')) r.checked = r.value === settings.engine;
  $('keyField').classList.toggle('hidden', settings.engine !== 'cloud');
}

async function init() {
  settings = await getSettings();

  fillLangSelect($('targetLang'), settings.targetLang);
  $('targetLang').onchange = () => save({ targetLang: $('targetLang').value });

  for (const id of ['showBanner', 'autoTranslateAll', 'bubbleOnTranslate']) {
    $(id).checked = settings[id];
    $(id).onchange = () => save({ [id]: $(id).checked });
  }

  renderEngine();
  for (const r of document.querySelectorAll('input[name=engine]')) {
    r.onchange = () => save({ engine: r.value }).then(renderEngine);
  }
  $('apiKey').value = settings.apiKey;
  $('apiKey').onchange = () => save({ apiKey: $('apiKey').value.trim() });
  $('testKey').onclick = async () => {
    await save({ apiKey: $('apiKey').value.trim(), engine: 'cloud' });
    $('testResult').textContent = 'Testing…';
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    const r = await chrome.runtime.sendMessage({ type: 'translate', texts: ['Bonjour le monde'], tl: settings.targetLang });
    $('testResult').textContent = r.error ? `✗ ${r.error}` : `✓ Works: “Bonjour le monde” → “${r.translations[0]}”`;
  };

  for (const key of ['alwaysLangs', 'neverLangs', 'alwaysSites', 'neverSites']) {
    renderList(key);
    const input = document.querySelector(`[data-add="${key}"]`);
    if (input.tagName === 'SELECT') fillLangSelect(input);
    const add = async () => {
      let v = input.value.trim();
      if (key.endsWith('Sites')) {
        v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
      }
      if (!v || settings[key].includes(v)) return;
      const opposite = { alwaysLangs: 'neverLangs', neverLangs: 'alwaysLangs', alwaysSites: 'neverSites', neverSites: 'alwaysSites' }[key];
      await save({ [key]: [...settings[key], v], [opposite]: settings[opposite].filter((i) => i !== v) });
      if (input.tagName === 'INPUT') input.value = '';
      renderList(key);
      renderList(opposite);
    };
    document.querySelector(`[data-addbtn="${key}"]`).onclick = add;
    input.onkeydown = (e) => e.key === 'Enter' && add();
  }

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-translation');
  $('shortcut').textContent = (cmd && cmd.shortcut) || 'not set';
  $('shortcuts').onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };
  $('clearCache').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    $('clearCache').textContent = 'Cache cleared';
  };

  // Stay in sync if the popup/bubble changes settings while this page is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync') return;
    settings = await getSettings();
    for (const key of ['alwaysLangs', 'neverLangs', 'alwaysSites', 'neverSites']) if (changes[key]) renderList(key);
    if (changes.targetLang) $('targetLang').value = settings.targetLang;
    if (changes.autoTranslateAll) $('autoTranslateAll').checked = settings.autoTranslateAll;
  });
}

init();
