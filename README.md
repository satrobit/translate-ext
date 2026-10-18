# Page Translate

Chrome-style page translation for Chromium browsers without Google's built-in translator (Helium, ungoogled-chromium, etc.), powered by Google Translate.

## Install
1. Open `helium://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.

## Features
- Detects the page language and shows a Chrome-like "Translate this page?" bubble with Original / Target tabs.
- **Always translate [language]**, **Never translate [language]**, **Always / Never translate this site**, or **auto-translate every foreign page**.
- Translates text, page title, `alt` / `title` / `placeholder` / `aria-label`, and button labels. Respects `translate="no"`, `.notranslate`, code blocks and editable fields.
- Keeps translating content that loads later (SPAs, infinite scroll); only translates what's near the viewport to save quota.
- **Show original** restores the page exactly, without reloading.
- Right-click: translate page, show original, translate selected text.
- Shortcut `Alt+Shift+T` toggles translation (change it at `chrome://extensions/shortcuts`).
- Engines: the free Google Translate endpoint (default, no key) or the official Cloud Translation API with your own key (Settings).
