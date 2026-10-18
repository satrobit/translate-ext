import { LANGUAGES, getSettings, setSettings, langName } from './lib.js';

const $ = (id) => document.getElementById(id);
let tab;
let state;
let settings;

async function toTab(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 150));
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      return null;
    }
  }
}

function render() {
  if (!state) return;
  const from = state.lang === 'und' ? null : state.langName;
  if (state.error) $('status').textContent = state.error;
  else if (state.translated && state.busy) $('status').textContent = `Translating${from ? ' from ' + from : ''} to ${state.targetName}…`;
  else if (state.translated) $('status').textContent = `Translated${from ? ' from ' + from : ''} to ${state.targetName}.`;
  else if (from) $('status').textContent = `This page is in ${from}.`;
  else $('status').textContent = 'Page language not detected.';

  $('translate').disabled = state.translated && !state.error;
  $('translate').textContent = state.error ? 'Try again' : 'Translate';
  $('restore').disabled = !state.translated;

  const hasLang = state.lang !== 'und';
  $('row-alwaysLang').classList.toggle('hidden', !hasLang);
  $('row-neverLang').classList.toggle('hidden', !hasLang);
  $('lbl-alwaysLang').innerHTML = '';
  $('lbl-alwaysLang').append('Always translate ', Object.assign(document.createElement('b'), { textContent: state.langName }));
  $('lbl-neverLang').innerHTML = '';
  $('lbl-neverLang').append('Never translate ', Object.assign(document.createElement('b'), { textContent: state.langName }));
  $('host1').textContent = $('host2').textContent = state.host || 'this site';

  const rules = {
    alwaysLang: settings.alwaysLangs.includes(state.lang),
    neverLang: settings.neverLangs.includes(state.lang),
    alwaysSite: settings.alwaysSites.includes(state.host),
    neverSite: settings.neverSites.includes(state.host),
  };
  for (const el of document.querySelectorAll('[data-rule]')) el.checked = rules[el.dataset.rule];
  $('autoAll').checked = settings.autoTranslateAll;
  return rules;
}

async function refresh() {
  settings = await getSettings();
  const s = await toTab({ type: 'getState' });
  if (s && s.ok) state = s;
  const rules = render();
  if (rules) toTab({ type: 'rulesChanged', rules });
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await getSettings();

  const sel = $('target');
  for (const [code, name] of Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]))) {
    sel.add(new Option(name, code, false, code === settings.targetLang));
  }

  const commands = await chrome.commands.getAll();
  const cmd = commands.find((c) => c.name === 'toggle-translation');
  $('shortcut').textContent = (cmd && cmd.shortcut) || 'not set';

  state = tab && /^(https?|file):/.test(tab.url || '') ? await toTab({ type: 'getState' }) : null;
  if (!state || !state.ok) {
    $('main').classList.add('hidden');
    $('bubble').classList.add('hidden');
    $('unsupported').classList.remove('hidden');
    return;
  }
  render();

  $('translate').onclick = async () => {
    state = (await toTab({ type: 'translate' })) || state;
    render();
  };
  $('restore').onclick = async () => {
    state = (await toTab({ type: 'restore' })) || state;
    render();
  };
  sel.onchange = async () => {
    await setSettings({ targetLang: sel.value });
    // Content script reacts to the storage change; if not translated yet, translate now.
    state = (await toTab({ type: 'translate', targetLang: sel.value })) || state;
    state.targetName = langName(sel.value);
    render();
  };
  for (const el of document.querySelectorAll('[data-rule]')) {
    el.onchange = async () => {
      const kind = el.dataset.rule;
      const value = kind.endsWith('Site') ? state.host : state.lang;
      await chrome.runtime.sendMessage({ type: 'setRule', kind, value, on: el.checked });
      if (el.checked && (kind === 'alwaysLang' || kind === 'alwaysSite')) await toTab({ type: 'translate' });
      if (el.checked && (kind === 'neverLang' || kind === 'neverSite')) await toTab({ type: 'restore' });
      await refresh();
    };
  }
  $('autoAll').onchange = async () => {
    await setSettings({ autoTranslateAll: $('autoAll').checked });
    if ($('autoAll').checked && state.lang !== 'und' && !state.translated) await toTab({ type: 'translate' });
    await refresh();
  };
  $('bubble').onclick = () => {
    toTab({ type: 'showBubble' });
    window.close();
  };

  // Keep status fresh while translating.
  setInterval(async () => {
    const s = await toTab({ type: 'getState' });
    if (s && s.ok) {
      state = s;
      render();
    }
  }, 700);
}

$('settings').onclick = () => chrome.runtime.openOptionsPage();
init();
