#!/bin/sh
# Assemble the single-file page published as the artifact.
set -e
cd "$(dirname "$0")"
mkdir -p build docs
{
cat <<'HEAD'
<title>ميزانيتي</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="ميزانيتي">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Readex+Pro:wght@400;500;600;700&display=swap">
<style>
HEAD
cat src/style.css
cat <<'MID'
</style>
<div dir="rtl" lang="ar">
<div class="wrap">
  <header class="top">
    <div class="brand"><div class="brand-mark" aria-hidden="true">م</div><div><h1>ميزانيتي</h1><div class="sub" id="hijri"></div></div></div>
    <span class="chip-store" id="storechip">جارِ التحميل…</span>
  </header>
  <main>
    <section data-tab="home"></section>
    <section data-tab="txns" hidden></section>
    <section data-tab="add" hidden></section>
    <section data-tab="reports" hidden></section>
    <section data-tab="settings" hidden></section>
  </main>
</div>
<nav class="tabs" aria-label="التنقل">
  <div class="in">
    <button data-go="home"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>الرئيسية</button>
    <button data-go="txns"><svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>العمليات</button>
    <button data-go="add" class="add" aria-label="إضافة عملية"><span class="plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>إضافة</button>
    <button data-go="reports"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>التقارير</button>
    <button data-go="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>الإعدادات</button>
  </div>
</nav>
<div id="sheet" hidden></div>
<div class="toast" id="toast" hidden role="status"></div>
</div>
<script>
MID
sed '/^if (typeof module/,$d' src/parser.js
cat <<'MID2'
</script>
<script>
MID2
cat src/app.js
echo '</script>'
} > build/artifact.html

# Standalone installable web app (PWA) for the iPhone home screen.
python3 - <<'PY'
html = open("build/artifact.html", encoding='utf-8').read()
cut = html.index('</style>') + len('</style>')
head, body = html[:cut], html[cut:]
pre = """<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f6b5c">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<link rel="icon" type="image/png" href="icons/icon-192.png">
<style>html,body{margin:0}body{padding-top:env(safe-area-inset-top,0px)}[hidden]{display:none!important}</style>
<script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('sw.js')})}</script>
"""
import os
os.makedirs('docs/icons', exist_ok=True)
open('docs/index.html', 'w', encoding='utf-8').write(pre + head + '\n</head>\n<body>' + body + '\n</body>\n</html>\n')
PY
cp pwa/manifest.webmanifest pwa/sw.js docs/
cp pwa/icons/*.png docs/icons/ 2>/dev/null || true

# Android app (APK) bundles the same page; no service worker inside the app.
mkdir -p android/app/src/main/assets
sed "/navigator.serviceWorker.register/d" docs/index.html > android/app/src/main/assets/index.html
