// Shared helpers for the service worker, popup and options page.

export const DEFAULTS = {
  targetLang: 'en',
  engine: 'free', // 'free' (translate.googleapis.com) | 'cloud' (Cloud Translation API v2)
  apiKey: '',
  autoTranslateAll: false, // translate every page not in the target language
  showBanner: true, // offer translation with a bubble, like Chrome
  bubbleOnTranslate: false, // show the bubble after auto/shortcut translation
  alwaysLangs: [],
  neverLangs: [],
  alwaysSites: [],
  neverSites: [],
};

export async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// Languages supported by Google Translate.
export const LANGUAGES = {
  af: 'Afrikaans', sq: 'Albanian', am: 'Amharic', ar: 'Arabic', hy: 'Armenian', as: 'Assamese',
  ay: 'Aymara', az: 'Azerbaijani', bm: 'Bambara', eu: 'Basque', be: 'Belarusian', bn: 'Bengali',
  bho: 'Bhojpuri', bs: 'Bosnian', bg: 'Bulgarian', ca: 'Catalan', ceb: 'Cebuano', ny: 'Chichewa',
  'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', co: 'Corsican', hr: 'Croatian',
  cs: 'Czech', da: 'Danish', dv: 'Dhivehi', doi: 'Dogri', nl: 'Dutch', en: 'English',
  eo: 'Esperanto', et: 'Estonian', ee: 'Ewe', tl: 'Filipino', fi: 'Finnish', fr: 'French',
  fy: 'Frisian', gl: 'Galician', ka: 'Georgian', de: 'German', el: 'Greek', gn: 'Guarani',
  gu: 'Gujarati', ht: 'Haitian Creole', ha: 'Hausa', haw: 'Hawaiian', iw: 'Hebrew', hi: 'Hindi',
  hmn: 'Hmong', hu: 'Hungarian', is: 'Icelandic', ig: 'Igbo', ilo: 'Ilocano', id: 'Indonesian',
  ga: 'Irish', it: 'Italian', ja: 'Japanese', jw: 'Javanese', kn: 'Kannada', kk: 'Kazakh',
  km: 'Khmer', rw: 'Kinyarwanda', gom: 'Konkani', ko: 'Korean', kri: 'Krio', ku: 'Kurdish (Kurmanji)',
  ckb: 'Kurdish (Sorani)', ky: 'Kyrgyz', lo: 'Lao', la: 'Latin', lv: 'Latvian', ln: 'Lingala',
  lt: 'Lithuanian', lg: 'Luganda', lb: 'Luxembourgish', mk: 'Macedonian', mai: 'Maithili',
  mg: 'Malagasy', ms: 'Malay', ml: 'Malayalam', mt: 'Maltese', mi: 'Maori', mr: 'Marathi',
  'mni-Mtei': 'Meiteilon (Manipuri)', lus: 'Mizo', mn: 'Mongolian', my: 'Myanmar (Burmese)',
  ne: 'Nepali', no: 'Norwegian', or: 'Odia (Oriya)', om: 'Oromo', ps: 'Pashto', fa: 'Persian',
  pl: 'Polish', pt: 'Portuguese', pa: 'Punjabi', qu: 'Quechua', ro: 'Romanian', ru: 'Russian',
  sm: 'Samoan', sa: 'Sanskrit', gd: 'Scots Gaelic', nso: 'Sepedi', sr: 'Serbian', st: 'Sesotho',
  sn: 'Shona', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', so: 'Somali',
  es: 'Spanish', su: 'Sundanese', sw: 'Swahili', sv: 'Swedish', tg: 'Tajik', ta: 'Tamil',
  tt: 'Tatar', te: 'Telugu', th: 'Thai', ti: 'Tigrinya', ts: 'Tsonga', tr: 'Turkish',
  tk: 'Turkmen', ak: 'Twi', uk: 'Ukrainian', ur: 'Urdu', ug: 'Uyghur', uz: 'Uzbek',
  vi: 'Vietnamese', cy: 'Welsh', xh: 'Xhosa', yi: 'Yiddish', yo: 'Yoruba', zu: 'Zulu',
};

// Normalize language codes so "en-US", "en" and Google's legacy codes compare equal.
export function normLang(code) {
  if (!code) return 'und';
  const c = String(code).trim();
  const lower = c.toLowerCase();
  if (lower.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh-CN';
  }
  const base = lower.split(/[-_]/)[0];
  return { he: 'iw', jv: 'jw', nb: 'no', nn: 'no', fil: 'tl' }[base] || base;
}

export function langName(code) {
  const n = normLang(code);
  if (LANGUAGES[n]) return LANGUAGES[n];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
