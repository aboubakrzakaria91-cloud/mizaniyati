// ===== ميزانيتي — التطبيق =====
(function () {
  'use strict';
  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const EXP_CATS = CATEGORIES.filter((c) => c.kind === 'expense');
  const INC_CATS = CATEGORIES.filter((c) => c.kind === 'income');
  const LS_KEY = 'mizaniyati.v1';
  const DEFAULT_PROFILE = { budget: 15000, startDay: 1, catBudgets: {}, rules: {}, digits: 'latn' };

  const state = {
    profile: { ...DEFAULT_PROFILE },
    months: {}, // 'YYYY-MM' -> [txn]
    mode: 'loading', // loading | cloud | local
    tab: 'home',
    offset: 0,
    txFilter: { q: '', type: '', cat: '' },
    addMode: 'sms',
    parsed: [],
    manual: null,
    editing: null,
    confirmClear: false,
  };

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => isoLocal(d);
  const monthKey = (isoStr) => isoStr.slice(0, 7);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const loc = () => (state.profile.digits === 'arab' ? 'ar-SA-u-nu-arab-ca-gregory' : 'ar-SA-u-nu-latn-ca-gregory');
  function fmt(n, dec) {
    const d = dec ?? (Math.abs(n) < 1000 && n % 1 ? 2 : 0);
    return new Intl.NumberFormat(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  }
  const money = (n, dec) => fmt(n, dec) + ' <span class="cur">ر.س</span>';
  const moneyTxt = (n, dec) => fmt(n, dec) + ' ر.س';
  function fmtDate(d, opts) { return new Intl.DateTimeFormat(loc(), opts).format(d); }
  const parseIso = (s) => { const [a, b] = s.split('T'); const [y, m, d] = a.split('-').map(Number); const [hh, mi] = (b || '00:00').split(':').map(Number); return new Date(y, m - 1, d, hh, mi); };
  const toNum = (v) => { const n = parseFloat(normalizeDigits(v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- storage ----------
  const Store = {
    db: null, uid: null, busy: {}, pending: {},
    loadLocal() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) { const d = JSON.parse(raw); state.profile = { ...DEFAULT_PROFILE, ...(d.profile || {}) }; state.months = d.months || {}; }
      } catch (e) { /* storage blocked: keep defaults */ }
    },
    saveLocal() {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ profile: state.profile, months: state.months })); } catch (e) { /* ignore */ }
    },
    async init() {
      this.loadLocal();
      let db = null, user = null;
      try {
        if (window.claude && window.claude.use) [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      } catch (e) { /* fall back to local */ }
      let id = null;
      if (db && user) { try { id = await user.id(); } catch (e) { id = null; } }
      if (!db || !id) { state.mode = 'local'; render(); return; }
      this.db = db; this.uid = id;
      const profRef = this.profileRef();
      let gotProfile = false, gotMonths = false;
      const localMonths = state.months;
      const ready = () => {
        if (!gotProfile || !gotMonths || state.mode === 'cloud' || state.mode === 'local') return;
        clearTimeout(this.timer);
        state.mode = 'cloud';
        // Carry over anything saved on this device before the account store was reachable.
        if (!Object.keys(state.months).length && Object.keys(localMonths).length) {
          state.months = localMonths;
          Object.keys(localMonths).forEach((k) => this.saveMonth(k));
        }
        render();
      };
      this.timer = setTimeout(() => { if (state.mode !== 'cloud') this.fallback(); }, 12000);
      profRef.onSnapshot((snap) => {
        gotProfile = true;
        const d = snap.exists ? snap.data() : null;
        state.profile = { ...DEFAULT_PROFILE, ...(d || {}) };
        if (state.mode === 'cloud') render(); else ready();
      }, () => this.fallback());
      profRef.collection('months').onSnapshot((snap) => {
        gotMonths = true;
        const m = {};
        snap.docs.forEach((doc) => { const d = doc.data(); if (d && Array.isArray(d.txns)) m[doc.id] = d.txns; });
        state.months = m;
        if (state.mode === 'cloud') render(); else ready();
      }, () => this.fallback());
    },
    profileRef() { return this.db.doc('data/users/' + this.uid + '/profile'); },
    fallback() {
      if (state.mode === 'local') return;
      const wasCloud = state.mode === 'cloud';
      state.mode = 'local'; this.db = null; if (!wasCloud) this.loadLocal(); else this.saveLocal(); render();
      toast('تعذّر الاتصال بالحفظ السحابي — البيانات تُحفظ على هذا الجهاز');
    },
    write(path, getData) {
      if (state.mode !== 'cloud') { this.saveLocal(); return; }
      this.pending[path] = getData;
      if (!this.busy[path]) this.flush(path);
    },
    async flush(path) {
      this.busy[path] = true;
      while (this.pending[path]) {
        const get = this.pending[path]; this.pending[path] = null;
        const data = get();
        const ref = path === 'profile' ? this.profileRef() : this.profileRef().collection('months').doc(path);
        let tries = 0;
        for (;;) {
          try { if (data === null) await ref.delete(); else await ref.set(data); break; }
          catch (e) {
            if (e && e.code === 'unavailable' && tries++ < 1) { await new Promise((r) => setTimeout(r, 600 + Math.random() * 800)); continue; }
            if (e && e.code === 'quota_exceeded') toast('امتلأت مساحة الحفظ — صدّر بياناتك واحذف القديم');
            else { this.busy[path] = false; this.saveLocal(); this.fallback(); return; }
            break;
          }
        }
      }
      this.busy[path] = false;
    },
    saveMonth(key) {
      this.write(key, () => (state.months[key] && state.months[key].length ? { txns: state.months[key] } : null));
    },
    saveProfile() { this.write('profile', () => ({ ...state.profile })); },
  };

  // ---------- data ops ----------
  const realTxns = () => Object.values(state.months).flat();
  const isSample = () => realTxns().length === 0;
  let sampleCache = null;
  function allTxns() {
    const r = realTxns();
    if (r.length) return r;
    return sampleCache || (sampleCache = makeSamples());
  }
  function addTxns(list) {
    const touched = new Set();
    for (const t of list) {
      const k = monthKey(t.date);
      (state.months[k] = state.months[k] || []).push(t);
      touched.add(k);
    }
    touched.forEach((k) => { state.months[k].sort((a, b) => (a.date < b.date ? -1 : 1)); Store.saveMonth(k); });
    if (state.mode !== 'cloud') Store.saveLocal();
  }
  function findTxn(id) {
    for (const [k, arr] of Object.entries(state.months)) { const i = arr.findIndex((t) => t.id === id); if (i >= 0) return { k, i }; }
    return null;
  }
  function updateTxn(id, patch) {
    const f = findTxn(id); if (!f) return;
    const t = { ...state.months[f.k][f.i], ...patch };
    const nk = monthKey(t.date);
    if (nk === f.k) { state.months[f.k] = state.months[f.k].slice(); state.months[f.k][f.i] = t; Store.saveMonth(f.k); }
    else {
      state.months[f.k] = state.months[f.k].filter((x) => x.id !== id); Store.saveMonth(f.k);
      (state.months[nk] = state.months[nk] || []).push(t); state.months[nk].sort((a, b) => (a.date < b.date ? -1 : 1)); Store.saveMonth(nk);
    }
    if (state.mode !== 'cloud') Store.saveLocal();
  }
  function deleteTxn(id) {
    const f = findTxn(id); if (!f) return;
    state.months[f.k] = state.months[f.k].filter((x) => x.id !== id);
    Store.saveMonth(f.k);
    if (state.mode !== 'cloud') Store.saveLocal();
  }
  function setProfile(patch) { state.profile = { ...state.profile, ...patch }; Store.saveProfile(); if (state.mode !== 'cloud') Store.saveLocal(); }
  function knownHashes() { return new Set(realTxns().map((t) => t.hash).filter(Boolean)); }

  // ---------- periods ----------
  function startDay() { return Math.min(28, Math.max(1, state.profile.startDay || 1)); }
  function periodAt(offset) {
    const S = startDay(), now = new Date();
    let y = now.getFullYear(), m = now.getMonth();
    if (now.getDate() < S) m -= 1;
    const start = new Date(y, m + offset, S), end = new Date(y, m + offset + 1, S);
    return { start, end, s: iso(start), e: iso(end), days: Math.round((end - start) / 86400000) };
  }
  function periodLabel(p) {
    if (startDay() === 1) return fmtDate(p.start, { month: 'long', year: 'numeric' });
    const last = new Date(p.end.getTime() - 86400000);
    return fmtDate(p.start, { day: 'numeric', month: 'short' }) + ' – ' + fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const inPeriod = (p) => allTxns().filter((t) => t.date >= p.s && t.date < p.e);
  function sums(list) {
    let exp = 0, inc = 0; const byCat = {};
    for (const t of list) {
      if (t.type === 'income') inc += t.amount; else { exp += t.amount; byCat[t.cat] = (byCat[t.cat] || 0) + t.amount; }
    }
    return { exp, inc, byCat };
  }
  function elapsed(p) {
    const now = new Date();
    if (now >= p.end) return { frac: 1, daysGone: p.days, daysLeft: 0, current: false };
    if (now < p.start) return { frac: 0, daysGone: 0, daysLeft: p.days, current: false };
    const daysGone = Math.floor((now - p.start) / 86400000) + 1;
    return { frac: (now - p.start) / (p.end - p.start), daysGone, daysLeft: p.days - daysGone + 1, current: true };
  }

  // ---------- sample data (shown only while there is no real data) ----------
  function makeSamples() {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const plan = [
      ['groceries', 'بنده', 6, 90, 420], ['groceries', 'الدانوب', 3, 120, 520], ['restaurants', 'البيك', 5, 28, 75], ['restaurants', 'مطعم مندي الشيباني', 2, 120, 260],
      ['coffee', 'بارنز', 9, 12, 32], ['coffee', 'ستاربكس', 3, 22, 48], ['delivery', 'جاهز', 5, 45, 140], ['delivery', 'هنقرستيشن', 3, 55, 150],
      ['fuel', 'الدريس', 4, 90, 150], ['transport', 'أوبر', 3, 25, 70], ['shopping', 'أمازون', 2, 90, 480], ['shopping', 'نون', 1, 120, 400],
      ['bills', 'STC', 1, 345, 345], ['bills', 'الكهرباء', 1, 280, 620], ['subscriptions', 'Netflix', 1, 56, 56], ['subscriptions', 'Shahid', 1, 30, 30],
      ['health', 'صيدلية النهدي', 2, 40, 180], ['personal', 'صالون الحلاقة', 2, 40, 60], ['entertainment', 'VOX Cinemas', 1, 110, 220],
      ['charity', 'منصة إحسان', 1, 100, 300], ['cash', 'صراف آلي', 1, 300, 700], ['housing', 'إيجار (قسط)', 1, 3000, 3000], ['car', 'مغسلة سيارات', 2, 25, 40],
    ];
    const out = [];
    for (let off = -5; off <= 0; off++) {
      const p = periodAt(off);
      const lim = off === 0 ? Math.max(1, elapsed(p).daysGone) : p.days;
      for (const [cat, merchant, n, lo, hi] of plan) {
        for (let i = 0; i < n; i++) {
          if (off === 0 && rnd() > lim / p.days + 0.05) continue;
          const day = Math.floor(rnd() * lim);
          const d = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() + day, 8 + Math.floor(rnd() * 14), Math.floor(rnd() * 60));
          const amount = Math.round((lo + rnd() * (hi - lo)) * (0.9 + (off + 5) * 0.03) * 100) / 100;
          out.push({ id: 's' + out.length, type: 'expense', amount, cat, merchant, date: iso(d), method: rnd() > .4 ? 'مدى · Apple Pay' : 'فيزا', source: rnd() > .3 ? 'sms' : 'manual', sample: true });
        }
      }
      const sal = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() + Math.min(26, p.days - 1), 6, 0);
      if (off < 0 || new Date() >= sal) out.push({ id: 's' + out.length, type: 'income', amount: 18500, cat: 'salary', merchant: 'راتب شهري', date: iso(sal), method: '', source: 'sms', sample: true });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ---------- rendering ----------
  function render() {
    renderHeader();
    document.querySelectorAll('section[data-tab]').forEach((s) => (s.hidden = s.dataset.tab !== state.tab));
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.go === state.tab ? 'page' : 'false'));
    const fn = { home: renderHome, txns: renderTxns, add: renderAdd, reports: renderReports, settings: renderSettings }[state.tab];
    fn($('section[data-tab="' + state.tab + '"]'));
    renderSheet();
  }

  function renderHeader() {
    const hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-' + (state.profile.digits === 'arab' ? 'arab' : 'latn'), { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    $('#hijri').textContent = hijri;
    $('#storechip').textContent = state.mode === 'cloud' ? 'محفوظ في حسابك' : state.mode === 'local' ? 'محفوظ على هذا الجهاز' : 'جارِ التحميل…';
  }

  function periodBar() {
    const p = periodAt(state.offset);
    return `<div class="period">
      <button class="iconbtn" data-act="prev" aria-label="الفترة السابقة">›</button>
      <div class="label">${esc(periodLabel(p))}</div>
      <button class="iconbtn" data-act="next" aria-label="الفترة التالية" ${state.offset >= 0 ? 'disabled' : ''}>‹</button>
    </div>`;
  }

  function sampleBanner() {
    if (!isSample()) return '';
    return `<div class="banner sample"><span><b>هذه بيانات توضيحية</b> لتتعرف على التطبيق. ستختفي تلقائياً عند إضافة أول عملية لك.</span>
      <button class="btn" data-go="add" style="padding:8px 14px">أضف أول عملية</button></div>`;
  }

  function txRow(t) {
    const c = CAT[t.cat] || CAT.other;
    const d = parseIso(t.date);
    const sub = [c.name, fmtDate(d, { hour: 'numeric', minute: '2-digit' }), t.method].filter(Boolean).join(' · ');
    return `<button class="tx" data-edit="${esc(t.id)}">
      <span class="ic" aria-hidden="true">${c.icon}</span>
      <span style="min-width:0"><span class="t1" style="display:block">${esc(t.merchant || c.name)}</span><span class="t2" style="display:block">${esc(sub)}</span></span>
      <span><span class="a ${t.type === 'income' ? 'in' : ''}">${t.type === 'income' ? '+' : ''}${fmt(t.amount)}</span><span class="src">${t.source === 'sms' ? 'من رسالة' : 'يدوي'}</span></span>
    </button>`;
  }

  function catBars(byCat, total, limit, prevByCat) {
    const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const shown = limit ? rows.slice(0, limit) : rows;
    if (!rows.length) return '<div class="empty">لا توجد مصروفات في هذه الفترة</div>';
    const max = rows[0][1];
    const cb = state.profile.catBudgets || {};
    return '<div class="cats">' + shown.map(([id, v]) => {
      const c = CAT[id] || CAT.other;
      const b = cb[id];
      let cls = '', meta = fmt(total ? (v / total) * 100 : 0, 0) + '٪ من المصروف';
      let w = (v / max) * 100;
      if (b) {
        const r = v / b; w = Math.min(100, r * 100);
        cls = r >= 1 ? 'bad' : r >= 0.8 ? 'warn' : '';
        meta = (r >= 1 ? '⚠ تجاوزت ميزانية الفئة (' : 'من ميزانية ') + moneyTxt(b) + (r >= 1 ? ')' : ' · ' + fmt(r * 100, 0) + '٪');
      }
      if (prevByCat) {
        const pv = prevByCat[id] || 0;
        if (pv) { const dlt = ((v - pv) / pv) * 100; meta += ` · <span class="${dlt > 0 ? 'delta-up' : 'delta-down'}">${dlt > 0 ? '▲' : '▼'} ${fmt(Math.abs(dlt), 0)}٪ عن السابقة</span>`; }
      }
      return `<div class="catrow"><span class="ic" aria-hidden="true">${c.icon}</span><span class="nm">${esc(c.name)}</span><span class="amt">${fmt(v)}</span>
        <span class="bar"><i class="${cls}" style="width:${w.toFixed(1)}%"></i></span><span class="meta">${meta}</span></div>`;
    }).join('') + '</div>';
  }

  function renderHome(el) {
    const p = periodAt(state.offset);
    const list = inPeriod(p);
    const { exp, inc, byCat } = sums(list);
    const budget = state.profile.budget || 0;
    const rem = budget - exp;
    const el2 = elapsed(p);
    const frac = budget ? exp / budget : 0;
    let status = 'good', statusTxt = 'ضمن الخطة';
    if (frac >= 1) { status = 'bad'; statusTxt = 'تجاوزت الميزانية'; }
    else if (el2.current && frac > el2.frac + 0.03) { status = 'warn'; statusTxt = 'تصرف أسرع من الخطة'; }
    else if (!el2.current && state.offset < 0) { statusTxt = frac <= 1 ? 'التزمت بالميزانية' : statusTxt; }
    const daily = el2.current && el2.daysLeft ? Math.max(0, rem) / el2.daysLeft : 0;
    const projected = el2.current && el2.daysGone ? (exp / el2.daysGone) * p.days : exp;
    const recent = list.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
    let alert = '';
    if (budget && frac >= 1) alert = `<div class="banner bad"><span>⚠ <b>تجاوزت ميزانية الشهر</b> بمبلغ ${moneyTxt(exp - budget)}.</span></div>`;
    else if (budget && frac >= 0.8) alert = `<div class="banner warn"><span>⚠ <b>صرفت ${fmt(frac * 100, 0)}٪ من ميزانيتك.</b> المتبقي ${moneyTxt(rem)}${el2.current ? ' لمدة ' + fmt(el2.daysLeft, 0) + ' يوم' : ''}.</span></div>`;

    el.innerHTML = `${periodBar()}${sampleBanner()}
    <div class="hero">
      <div class="hero-head"><span class="eyebrow">${rem >= 0 ? 'المتبقي من ميزانية الفترة' : 'تجاوزت الميزانية بمبلغ'}</span>
        <span class="pill ${status}">${status === 'good' ? '✓' : '⚠'} ${statusTxt}</span></div>
      <div class="big ${rem < 0 ? 'neg' : ''}">${money(Math.abs(rem), 0)}</div>
      <div class="gauge" role="img" aria-label="صرفت ${fmt(frac * 100, 0)}٪ من الميزانية">
        <div class="fill ${status === 'good' ? '' : status}" style="width:${Math.min(100, frac * 100).toFixed(1)}%"></div>
        ${el2.current ? `<div class="pace" style="inset-inline-start:${(el2.frac * 100).toFixed(1)}%" data-label="اليوم"></div>` : ''}
      </div>
      <div class="gauge-legend"><span>صرفت <b class="num">${fmt(exp, 0)}</b> من <span class="num">${fmt(budget, 0)}</span> ر.س</span><span class="num">${fmt(frac * 100, 0)}٪</span></div>
    </div>
    ${alert}
    <div class="stats">
      <div class="stat"><div class="k">المصروف</div><div class="v">${fmt(exp, 0)} <small>ر.س</small></div><div class="h">${fmt(list.filter((t) => t.type !== 'income').length, 0)} عملية</div></div>
      <div class="stat"><div class="k">الدخل</div><div class="v" style="color:var(--income)">${fmt(inc, 0)} <small>ر.س</small></div><div class="h">${inc ? 'ادخرت ' + fmt(Math.max(0, ((inc - exp) / inc) * 100), 0) + '٪' : 'لا يوجد دخل مسجل'}</div></div>
      <div class="stat"><div class="k">المسموح يومياً</div><div class="v">${el2.current ? fmt(daily, 0) : '—'} <small>${el2.current ? 'ر.س' : ''}</small></div><div class="h">${el2.current ? 'باقي ' + fmt(el2.daysLeft, 0) + ' يوم' : 'الفترة منتهية'}</div></div>
      <div class="stat"><div class="k">${el2.current ? 'المتوقع نهاية الفترة' : 'متوسط الصرف اليومي'}</div><div class="v" style="${el2.current && projected > budget ? 'color:var(--bad)' : ''}">${fmt(el2.current ? projected : exp / p.days, 0)} <small>ر.س</small></div><div class="h">${el2.current ? (projected > budget ? 'فوق الميزانية' : 'ضمن الميزانية') : 'على ' + fmt(p.days, 0) + ' يوم'}</div></div>
    </div>
    <div class="card"><h2>أين ذهبت أموالك؟ <button class="link" data-go="reports">التقارير</button></h2>${catBars(byCat, exp, 6)}</div>
    <div class="card"><h2>آخر العمليات <button class="link" data-go="txns">عرض الكل</button></h2>
      ${recent.length ? recent.map(txRow).join('') : '<div class="empty">لا توجد عمليات بعد. اضغط ＋ لإضافة أول عملية أو لصق رسالة من البنك.</div>'}</div>`;
  }

  function renderTxns(el) {
    const p = periodAt(state.offset);
    const f = state.txFilter;
    const q = normalizeDigits(f.q).toLowerCase().trim();
    let list = inPeriod(p).filter((t) => (!f.type || t.type === f.type) && (!f.cat || t.cat === f.cat) &&
      (!q || (t.merchant || '').toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q) || (CAT[t.cat]?.name || '').includes(q) || String(t.amount).includes(q)));
    list = list.sort((a, b) => (a.date < b.date ? 1 : -1));
    const days = {};
    list.forEach((t) => (days[t.date.slice(0, 10)] = days[t.date.slice(0, 10)] || []).push(t));
    const { exp, inc } = sums(list);
    const catOpts = CATEGORIES.map((c) => `<option value="${c.id}" ${f.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const prevQ = document.activeElement && document.activeElement.id === 'tx-q';
    el.innerHTML = `${periodBar()}${sampleBanner()}
    <div class="filters">
      <input type="search" id="tx-q" placeholder="ابحث باسم المتجر أو المبلغ…" value="${esc(f.q)}" aria-label="بحث">
      <div class="row2">
        <div class="segs" role="group" aria-label="النوع">
          <button class="seg" data-ftype="" aria-pressed="${!f.type}">الكل</button>
          <button class="seg" data-ftype="expense" aria-pressed="${f.type === 'expense'}">مصروف</button>
          <button class="seg" data-ftype="income" aria-pressed="${f.type === 'income'}">دخل</button>
        </div>
        <select id="tx-cat" aria-label="الفئة"><option value="">كل الفئات</option>${catOpts}</select>
      </div>
    </div>
    <div class="card">
      <h2><span>${fmt(list.length, 0)} عملية</span><span class="small muted" style="font-weight:400">مصروف ${moneyTxt(exp, 0)}${inc ? ' · دخل ' + moneyTxt(inc, 0) : ''}</span></h2>
      ${Object.keys(days).length ? Object.entries(days).map(([d, arr]) => {
        const s = arr.reduce((a, t) => a + (t.type === 'income' ? 0 : t.amount), 0);
        return `<div class="day"><div class="dayhead"><span>${esc(fmtDate(parseIso(d), { weekday: 'long', day: 'numeric', month: 'long' }))}</span><span class="num">${s ? '−' + fmt(s) : ''}</span></div>${arr.map(txRow).join('')}</div>`;
      }).join('') : '<div class="empty">لا توجد عمليات مطابقة</div>'}
    </div>`;
    if (prevQ) { const i = $('#tx-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  // ----- add -----
  const SMS_EXAMPLE = `شراء عبر نقاط البيع
بطاقة: 4521;مدى-ابل باي
مبلغ: SAR 86.75
لدى: PANDA
في: ${iso(new Date()).slice(0, 10)} 21:14

POS Purchase
Card: **7788
Amount: SAR 42.00
At: BARNS COFFEE
Date: ${iso(new Date()).slice(0, 10)} 08:05`;

  function newManual(type) {
    return { type: type || 'expense', amount: '', cat: type === 'income' ? 'salary' : '', merchant: '', date: iso(new Date()), method: 'مدى', note: '' };
  }

  function catPicker(kind, sel, attr) {
    const cats = kind === 'income' ? INC_CATS : EXP_CATS;
    return `<div class="catgrid" role="group" aria-label="الفئة">${cats.map((c) => `<button type="button" class="catbtn" ${attr}="${c.id}" aria-pressed="${sel === c.id}"><span class="e" aria-hidden="true">${c.icon}</span>${esc(c.name)}</button>`).join('')}</div>`;
  }
  const catSelect = (kind, sel, attrs) => `<select ${attrs}>${(kind === 'income' ? INC_CATS : EXP_CATS).map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select>`;
  const METHODS = ['مدى', 'مدى · Apple Pay', 'فيزا', 'ماستركارد', 'بطاقة ائتمانية', 'STC Pay', 'نقداً', 'تحويل بنكي', 'أخرى'];
  const methodSelect = (sel, attrs) => {
    const opts = METHODS.includes(sel) || !sel ? METHODS : [sel, ...METHODS];
    return `<select ${attrs}>${opts.map((m) => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`;
  };

  function renderAdd(el) {
    if (!state.manual) state.manual = newManual();
    const m = state.manual;
    const smsVal = $('#sms-in') ? $('#sms-in').value : '';
    el.innerHTML = `
    <div class="segs" role="tablist" aria-label="طريقة الإضافة" style="justify-content:center">
      <button class="seg" data-addmode="sms" aria-pressed="${state.addMode === 'sms'}">من رسالة البنك</button>
      <button class="seg" data-addmode="manual" aria-pressed="${state.addMode === 'manual'}">إدخال يدوي</button>
    </div>
    ${state.addMode === 'sms' ? `
    <div class="card" style="display:grid;gap:10px">
      <h2 style="margin:0">الصق رسالة البنك</h2>
      <p class="small muted" style="margin:0">انسخ رسالة العملية من تطبيق الرسائل والصقها هنا. يمكنك لصق عدة رسائل مرة واحدة، مع ترك سطر فارغ بين كل رسالة والتي تليها. التطبيق يتعرف على المبلغ والمتجر والتاريخ والفئة تلقائياً.</p>
      <textarea id="sms-in" dir="auto" placeholder="مثال:\nشراء عبر نقاط البيع\nمبلغ: SAR 86.75\nلدى: PANDA\nفي: 2026-09-27 21:14">${esc(smsVal)}</textarea>
      <div class="btns"><button class="btn" data-act="parse">قراءة الرسائل</button><button class="btn ghost" data-act="example">جرّب مثالاً</button><button class="btn ghost" data-act="clear-sms">مسح</button></div>
    </div>
    ${renderParsed()}` : `
    <div class="card" style="display:grid;gap:12px">
      <div class="segs" style="justify-content:center">
        <button class="seg" data-mtype="expense" aria-pressed="${m.type === 'expense'}">مصروف</button>
        <button class="seg" data-mtype="income" aria-pressed="${m.type === 'income'}">دخل</button>
      </div>
      <div class="field"><label for="m-amount">المبلغ (ر.س)</label><input id="m-amount" class="amount-in" type="text" inputmode="decimal" placeholder="0.00" value="${esc(m.amount)}" autocomplete="off"></div>
      <div class="field"><span class="lbl">الفئة</span>${catPicker(m.type, m.cat, 'data-mcat')}</div>
      <div class="field"><label for="m-merchant">${m.type === 'income' ? 'المصدر' : 'المتجر أو الوصف'}</label><input id="m-merchant" type="text" dir="auto" placeholder="${m.type === 'income' ? 'مثلاً: راتب، مكافأة' : 'مثلاً: بقالة الحي، هدية'}" value="${esc(m.merchant)}"></div>
      <div class="row2">
        <div class="field"><label for="m-date">التاريخ والوقت</label><input id="m-date" type="datetime-local" value="${esc(m.date)}"></div>
        <div class="field"><label for="m-method">طريقة الدفع</label>${methodSelect(m.method, 'id="m-method"')}</div>
      </div>
      <div class="field"><label for="m-note">ملاحظة (اختياري)</label><input id="m-note" type="text" dir="auto" value="${esc(m.note)}"></div>
      <button class="btn block" data-act="save-manual">حفظ العملية</button>
    </div>`}`;
  }

  function renderParsed() {
    if (!state.parsed.length) return '';
    const n = state.parsed.filter((r) => r.ok && r.include).length;
    return `<div class="parsed">${state.parsed.map((r, i) => {
      if (!r.ok) return `<div class="pcard err"><div class="errline">${esc(r.error)}</div><div class="raw" dir="auto">${esc(r.raw)}</div></div>`;
      return `<div class="pcard ${r.include ? '' : 'off'}">
        <div class="head"><label class="check"><input type="checkbox" data-pinc="${i}" ${r.include ? 'checked' : ''}> ${r.type === 'income' ? 'دخل' : 'مصروف'}${r.bank ? ' · ' + esc(r.bank) : ''}</label>
          <span class="num" style="font-size:18px;${r.type === 'income' ? 'color:var(--income)' : ''}">${r.type === 'income' ? '+' : ''}${fmt(r.amount)} <small class="muted">${esc(r.currency === 'SAR' ? 'ر.س' : r.currency)}</small></span></div>
        ${r.dup ? '<div class="warnline">⚠ هذه الرسالة مسجلة مسبقاً — لن تُحفظ مرتين إلا إذا فعّلتها</div>' : ''}
        ${r.warnings.map((w) => `<div class="warnline">⚠ ${esc(w)}</div>`).join('')}
        <div class="row2">
          <div class="field"><label for="p-m-${i}">المتجر</label><input id="p-m-${i}" type="text" dir="auto" data-pf="merchant" data-pi="${i}" value="${esc(r.merchant)}"></div>
          <div class="field"><label for="p-a-${i}">المبلغ (ر.س)</label><input id="p-a-${i}" type="text" inputmode="decimal" data-pf="amount" data-pi="${i}" value="${esc(r.amount)}"></div>
        </div>
        <div class="row2">
          <div class="field"><label for="p-c-${i}">الفئة</label>${catSelect(r.type, r.cat, `id="p-c-${i}" data-pf="cat" data-pi="${i}"`)}</div>
          <div class="field"><label for="p-d-${i}">التاريخ</label><input id="p-d-${i}" type="datetime-local" data-pf="date" data-pi="${i}" value="${esc(r.date)}"></div>
        </div>
        <div class="raw" dir="auto">${esc(r.raw)}</div>
      </div>`;
    }).join('')}
    ${n ? `<button class="btn block" data-act="save-parsed">حفظ ${fmt(n, 0)} ${n === 1 ? 'عملية' : 'عمليات'}</button>` : ''}</div>`;
  }

  // ----- reports -----
  function renderReports(el) {
    const p = periodAt(state.offset);
    const list = inPeriod(p);
    const { exp, inc, byCat } = sums(list);
    const prev = sums(inPeriod(periodAt(state.offset - 1)));
    const merchants = {};
    list.filter((t) => t.type !== 'income').forEach((t) => {
      const k = t.merchant || CAT[t.cat]?.name || '—';
      const m = (merchants[k] = merchants[k] || { n: 0, v: 0, cat: t.cat }); m.n++; m.v += t.amount;
    });
    const top = Object.entries(merchants).sort((a, b) => b[1].v - a[1].v).slice(0, 8);
    const net = inc - exp;
    el.innerHTML = `${periodBar()}${sampleBanner()}
    <div class="card"><h2>ملخص الفترة</h2>
      <div class="kv">
        <div><div class="small muted">الدخل</div><div class="num" style="font-size:19px;color:var(--income)">${moneyTxt(inc, 0)}</div></div>
        <div><div class="small muted">المصروف</div><div class="num" style="font-size:19px">${moneyTxt(exp, 0)}</div></div>
        <div><div class="small muted">صافي ${net >= 0 ? 'الادخار' : 'العجز'}</div><div class="num" style="font-size:19px;color:${net >= 0 ? 'var(--good)' : 'var(--bad)'}">${moneyTxt(Math.abs(net), 0)}</div></div>
        <div><div class="small muted">مقارنة بالفترة السابقة</div><div class="num" style="font-size:19px">${prev.exp ? `<span class="${exp > prev.exp ? 'delta-up' : 'delta-down'}">${exp > prev.exp ? '▲' : '▼'} ${fmt(Math.abs(((exp - prev.exp) / prev.exp) * 100), 0)}٪</span>` : '—'}</div></div>
      </div></div>
    <div class="card"><h2>الصرف التراكمي مقابل الميزانية</h2><div class="chart" id="ch-cum"></div>
      <div class="legend"><span><i></i>صرفك الفعلي</span><span><i class="dash"></i>الصرف المثالي حتى ${moneyTxt(state.profile.budget || 0, 0)}</span></div></div>
    <div class="card"><h2>المصروف في آخر ٦ فترات</h2><div class="chart" id="ch-months"></div>
      <div class="legend"><span><i class="bar"></i>ضمن الميزانية</span><span><i class="bad"></i>فوق الميزانية</span><span><i class="dash"></i>الميزانية</span></div></div>
    <div class="card"><h2>المصروف حسب الفئة</h2>${catBars(byCat, exp, 0, prev.byCat)}</div>
    <div class="card"><h2>أكثر الجهات صرفاً</h2>
      ${top.length ? `<div class="tbl"><table><thead><tr><th>الجهة</th><th class="n">عدد</th><th class="n">المبلغ</th></tr></thead><tbody>
      ${top.map(([k, m]) => `<tr><td>${CAT[m.cat]?.icon || ''} ${esc(k)}</td><td class="n">${fmt(m.n, 0)}</td><td class="n">${fmt(m.v)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد بيانات</div>'}
    </div>`;
    drawCumulative($('#ch-cum'), p, list);
    drawMonths($('#ch-months'));
  }

  function svgEl(w, h, inner) { return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${inner}</svg><div class="tip" hidden></div>`; }
  function niceMax(v) {
    if (v <= 0) return 100;
    const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }
  const shortNum = (v) => (v >= 1000 ? fmt(v / 1000, v % 1000 ? 1 : 0) + 'k' : fmt(v, 0));

  function attachTip(box, n, xAt, html) {
    const svg = box.querySelector('svg'), tip = box.querySelector('.tip'), cross = box.querySelector('.cross');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ev.clientX - r.left;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(xAt(i) - x); if (d < bd) { bd = d; best = i; } }
      const h = html(best); if (!h) { tip.hidden = true; return; }
      tip.innerHTML = h.text; tip.hidden = false;
      const tx = Math.max(70, Math.min(r.width - 70, xAt(best)));
      tip.style.left = (tx - tip.offsetWidth / 2) * 1 + 'px'; tip.style.transform = 'translate(0,-100%)';
      tip.style.top = Math.max(0, h.y - 8) + 'px';
      if (cross) { cross.setAttribute('x1', xAt(best)); cross.setAttribute('x2', xAt(best)); cross.style.opacity = 1; }
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; if (cross) cross.style.opacity = 0; });
  }

  function drawCumulative(box, p, list) {
    const W = Math.max(260, box.clientWidth), H = 200, padT = 14, padB = 24, padL = 8, padR = 40;
    const budget = state.profile.budget || 0;
    const daily = new Array(p.days).fill(0);
    list.forEach((t) => { if (t.type !== 'income') { const i = Math.floor((parseIso(t.date) - p.start) / 86400000); if (i >= 0 && i < p.days) daily[i] += t.amount; } });
    const el2 = elapsed(p);
    const lastIdx = el2.current ? el2.daysGone - 1 : p.days - 1;
    const cum = []; let s = 0;
    for (let i = 0; i <= lastIdx; i++) { s += daily[i]; cum.push(s); }
    const ymax = niceMax(Math.max(budget, s) * 1.05);
    // RTL: day 1 on the right, time flows leftwards like the page.
    const x = (i) => W - padR - (i / (p.days - 1)) * (W - padR - padL);
    const y = (v) => padT + (1 - v / ymax) * (H - padT - padB);
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = (ymax / 4) * k; g += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${W - padR + 6}" y="${y(v) + 4}" text-anchor="start">${shortNum(v)}</text>`; }
    const ticks = [0, Math.floor((p.days - 1) / 3), Math.floor((2 * (p.days - 1)) / 3), p.days - 1];
    ticks.forEach((i) => { const d = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() + i); g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtDate(d, { day: 'numeric', month: 'short' })}</text>`; });
    const pace = budget ? `<line x1="${x(0)}" y1="${y(budget / p.days)}" x2="${x(p.days - 1)}" y2="${y(budget)}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>` : '';
    const pts = cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = cum.length ? `<polygon points="${x(0)},${y(0)} ${pts} ${x(cum.length - 1)},${y(0)}" fill="var(--accent)" opacity=".12"/>` : '';
    const line = cum.length ? `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
    const end = cum.length ? `<circle cx="${x(cum.length - 1)}" cy="${y(s)}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/><text x="${x(cum.length - 1)}" y="${y(s) - 10}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${shortNum(s)}</text>` : '';
    box.innerHTML = svgEl(W, H, `${g}<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${pace}${area}${line}<line class="cross" x1="0" x2="0" y1="${padT}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1" style="opacity:0"/>${end}`);
    attachTip(box, cum.length, x, (i) => {
      const d = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() + i);
      const ideal = budget ? (budget / p.days) * (i + 1) : 0;
      return { y: y(cum[i]), text: `<b>${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>هذا اليوم: ${moneyTxt(daily[i])}<br>التراكمي: ${moneyTxt(cum[i], 0)}${budget ? '<br>المثالي: ' + moneyTxt(ideal, 0) : ''}` };
    });
  }

  function drawMonths(box) {
    const W = Math.max(260, box.clientWidth), H = 190, padT = 18, padB = 24, padL = 8, padR = 40;
    const budget = state.profile.budget || 0;
    const data = [];
    for (let o = state.offset - 5; o <= state.offset; o++) { const p = periodAt(o); data.push({ p, v: sums(inPeriod(p)).exp, cur: o === state.offset }); }
    const ymax = niceMax(Math.max(budget, ...data.map((d) => d.v)) * 1.08);
    const n = data.length, slot = (W - padL - padR) / n, bw = Math.min(38, slot * 0.56);
    const cx = (i) => W - padR - slot * (i + 0.5); // RTL: oldest on the right
    const y = (v) => padT + (1 - v / ymax) * (H - padT - padB);
    let g = '';
    for (let k = 0; k <= 4; k++) { const v = (ymax / 4) * k; g += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${W - padR + 6}" y="${y(v) + 4}" text-anchor="start">${shortNum(v)}</text>`; }
    let bars = '';
    data.forEach((d, i) => {
      const over = budget && d.v > budget;
      const top = y(d.v), h = y(0) - top, r = Math.min(4, h / 2);
      const x0 = cx(i) - bw / 2;
      if (h > 0.5) bars += `<path d="M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${y(0)} Z" fill="${over ? 'var(--bad)' : 'var(--accent)'}" opacity="${d.cur ? 1 : 0.72}"/>`;
      const lab = startDay() === 1 ? fmtDate(d.p.start, { month: 'short' }) : fmtDate(d.p.start, { day: 'numeric', month: 'short' });
      bars += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" style="${d.cur ? 'fill:var(--ink);font-weight:600' : ''}">${lab}</text>`;
      if (d.cur || over) bars += `<text x="${cx(i)}" y="${top - 5}" text-anchor="middle" style="fill:var(--ink);font-size:10.5px">${over ? '⚠ ' : ''}${shortNum(d.v)}</text>`;
    });
    const bl = budget ? `<line x1="${padL}" x2="${W - padR}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>` : '';
    box.innerHTML = svgEl(W, H, `${g}${bars}<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${bl}`);
    attachTip(box, n, cx, (i) => {
      const d = data[i];
      const diff = budget ? d.v - budget : 0;
      return { y: y(d.v), text: `<b>${esc(periodLabel(d.p))}</b><br>المصروف: ${moneyTxt(d.v, 0)}${budget ? '<br>' + (diff > 0 ? 'فوق الميزانية بـ ' : 'أقل من الميزانية بـ ') + moneyTxt(Math.abs(diff), 0) : ''}` };
    });
  }

  // ----- settings -----
  function renderSettings(el) {
    const pr = state.profile;
    const cb = pr.catBudgets || {};
    const rules = Object.entries(pr.rules || {});
    const days = Array.from({ length: 28 }, (_, i) => i + 1);
    el.innerHTML = `
    <div class="card" style="display:grid;gap:12px"><h2 style="margin:0">الميزانية</h2>
      <div class="field"><label for="s-budget">ميزانية الشهر (ر.س)</label><input id="s-budget" type="text" inputmode="decimal" value="${esc(pr.budget)}"></div>
      <div class="field"><label for="s-start">يبدأ شهرك المالي يوم</label>
        <select id="s-start">${days.map((d) => `<option value="${d}" ${d === startDay() ? 'selected' : ''}>${d === 1 ? '1 (بداية الشهر الميلادي)' : d === 27 ? '27 (موعد رواتب القطاع الحكومي)' : d}</option>`).join('')}</select>
        <span class="small muted">إذا كان راتبك ينزل يوم 27، اختر 27 لتبدأ الميزانية مع الراتب.</span></div>
      <div class="field"><span class="lbl">شكل الأرقام</span><div class="segs">
        <button class="seg" data-digits="latn" aria-pressed="${pr.digits !== 'arab'}">123</button>
        <button class="seg" data-digits="arab" aria-pressed="${pr.digits === 'arab'}">١٢٣</button></div></div>
    </div>
    <details class="card"><summary>ميزانية لكل فئة (اختياري)</summary>
      <p class="small muted" style="margin-top:0">حدد سقفاً لأي فئة وسيظهر لك تنبيه عند الوصول إلى 80٪ منه. اترك الخانة فارغة لإلغائه.</p>
      <div class="set-list">${EXP_CATS.map((c) => `<div class="setrow"><span aria-hidden="true">${c.icon}</span><label for="cb-${c.id}">${esc(c.name)}</label><input id="cb-${c.id}" type="text" inputmode="decimal" data-cb="${c.id}" placeholder="—" value="${cb[c.id] ? esc(cb[c.id]) : ''}"></div>`).join('')}</div>
    </details>
    <details class="card" id="iphone"><summary>استخدامه على الآيفون</summary>
      <p class="small" style="margin-top:0">آبل لا تسمح لأي تطبيق بقراءة الرسائل تلقائياً، لذلك نستخدم طريقة النسخ واللصق. يستغرق ذلك ثوانٍ لكل رسالة:</p>
      <ol class="steps">
        <li><b>أضف التطبيق للشاشة الرئيسية:</b> افتح هذا الرابط في سفاري، اضغط زر المشاركة ثم «إضافة إلى الشاشة الرئيسية».</li>
        <li><b>عند وصول رسالة البنك:</b> اضغط مطولاً على الرسالة ← «نسخ».</li>
        <li><b>افتح التطبيق</b> ← زر ＋ ← الصق الرسالة ← «قراءة الرسائل» ← «حفظ».</li>
        <li><b>لتوفير الوقت:</b> اجمع رسائل اليوم أو الأسبوع والصقها كلها مرة واحدة، مع سطر فارغ بين كل رسالة والتي تليها. الرسائل المكررة تُكتشف تلقائياً.</li>
        <li><b>اختصار اختياري:</b> في تطبيق «الاختصارات» ← «الأتمتة» ← «رسالة» ← اختر مرسل البنك (مثل <span class="mono">AlRajhiBank</span>) ← أضف إجراء «نسخ إلى الحافظة» لمحتوى الرسالة ← «تشغيل فوري». بعدها يكفي أن تفتح التطبيق وتلصق.</li>
      </ol>
    </details>
    <details class="card"><summary>استخدامه على الأندرويد</summary>
      <ol class="steps">
        <li><b>ثبّت التطبيق:</b> افتح الرابط في متصفح <b>Chrome</b> ← القائمة ⋮ ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</li>
        <li><b>عند وصول رسالة البنك:</b> اضغط مطولاً على الرسالة ← «مشاركة» ← اختر <b>ميزانيتي</b>.</li>
        <li>يفتح التطبيق والرسالة مقروءة وجاهزة ← راجعها واضغط «حفظ».</li>
      </ol>
    </details>
    <details class="card"><summary>قواعد التصنيف المحفوظة (${fmt(rules.length, 0)})</summary>
      <p class="small muted" style="margin-top:0">عندما تغيّر فئة عملية وتختار «تذكّر»، يحفظ التطبيق القاعدة ويطبّقها على رسائل هذا المتجر مستقبلاً.</p>
      ${rules.length ? rules.map(([k, v]) => `<div class="rule"><span>${esc(k)} ← ${CAT[v]?.icon || ''} ${esc(CAT[v]?.name || v)}</span><button class="btn ghost" style="padding:4px 10px" data-delrule="${esc(k)}">حذف</button></div>`).join('') : '<div class="small muted">لا توجد قواعد بعد</div>'}
    </details>
    <div class="card" style="display:grid;gap:10px"><h2 style="margin:0">بياناتك</h2>
      <p class="small muted" style="margin:0">${state.mode === 'cloud' ? 'بياناتك محفوظة في حسابك على Claude بشكل خاص: لا يراها غيرك حتى لو شاركت الرابط، وتصلك على أي جهاز تفتح منه التطبيق.' : 'البيانات محفوظة في متصفح هذا الجهاز فقط. صدّرها بين فترة وأخرى كنسخة احتياطية.'}</p>
      <div class="btns"><button class="btn ghost" data-act="export" ${realTxns().length ? '' : 'disabled'}>تصدير Excel ‏(CSV)</button>
        ${state.confirmClear ? `<button class="btn danger" data-act="clear-yes">نعم، احذف كل شيء</button><button class="btn ghost" data-act="clear-no">إلغاء</button>` : `<button class="btn ghost" data-act="clear" ${realTxns().length ? '' : 'disabled'} style="color:var(--bad)">حذف كل العمليات</button>`}</div>
      <div class="btns"><button class="btn ghost" data-act="backup" ${realTxns().length ? '' : 'disabled'}>حفظ نسخة احتياطية</button>
        <label class="btn ghost" for="restore-file" style="cursor:pointer">استعادة نسخة</label><input id="restore-file" type="file" accept=".json,application/json" hidden></div>
      <div class="small muted">عدد العمليات المسجلة: ${fmt(realTxns().length, 0)}</div>
    </div>`;
  }

  // ----- edit sheet -----
  function renderSheet() {
    const host = $('#sheet');
    const e = state.editing;
    if (!e) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const t = e.t;
    host.innerHTML = `<div class="sheet-bg" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title">
      <h3><span id="sh-title">${t.sample ? 'عملية توضيحية' : 'تعديل العملية'}</span><button class="iconbtn" data-act="close-sheet" aria-label="إغلاق">✕</button></h3>
      ${t.sample ? '<div class="banner sample small">هذه عملية من البيانات التوضيحية ولا يمكن تعديلها. أضف عملياتك الحقيقية لتبدأ.</div>' : ''}
      <div class="segs"><button class="seg" data-etype="expense" aria-pressed="${t.type === 'expense'}">مصروف</button><button class="seg" data-etype="income" aria-pressed="${t.type === 'income'}">دخل</button></div>
      <div class="row2">
        <div class="field"><label for="e-amount">المبلغ (ر.س)</label><input id="e-amount" type="text" inputmode="decimal" value="${esc(t.amount)}"></div>
        <div class="field"><label for="e-cat">الفئة</label>${catSelect(t.type, t.cat, 'id="e-cat"')}</div>
      </div>
      <div class="field"><label for="e-merchant">المتجر أو الوصف</label><input id="e-merchant" type="text" dir="auto" value="${esc(t.merchant)}"></div>
      <div class="row2">
        <div class="field"><label for="e-date">التاريخ والوقت</label><input id="e-date" type="datetime-local" value="${esc(t.date)}"></div>
        <div class="field"><label for="e-method">طريقة الدفع</label>${methodSelect(t.method, 'id="e-method"')}</div>
      </div>
      <div class="field"><label for="e-note">ملاحظة</label><input id="e-note" type="text" dir="auto" value="${esc(t.note || '')}"></div>
      ${t.merchant ? `<label class="check"><input type="checkbox" id="e-remember"> تذكّر هذه الفئة لكل عمليات «${esc(t.merchant)}»</label>` : ''}
      ${t.raw ? `<details><summary class="small muted">نص الرسالة الأصلية</summary><div class="small muted" dir="auto" style="white-space:pre-line">${esc(t.raw)}</div></details>` : ''}
      ${t.sample ? '' : `<div class="btns"><button class="btn" data-act="save-edit" style="flex:1">حفظ التعديل</button>
        ${e.confirmDel ? '<button class="btn danger" data-act="del-yes">تأكيد الحذف</button>' : '<button class="btn ghost" data-act="del" style="color:var(--bad)">حذف</button>'}</div>`}
    </div></div>`;
  }

  // ---------- actions ----------
  function readManualForm() {
    const m = state.manual; if (!m || !$('#m-amount')) return;
    m.amount = $('#m-amount').value; m.merchant = $('#m-merchant').value; m.date = $('#m-date').value || m.date; m.method = $('#m-method').value; m.note = $('#m-note').value;
  }
  function readParsedField(el) {
    const i = +el.dataset.pi, f = el.dataset.pf, r = state.parsed[i]; if (!r) return;
    if (f === 'amount') { const n = toNum(el.value); if (!isNaN(n)) r.amount = n; }
    else r[f] = el.value;
  }

  function doParse() {
    const raw = $('#sms-in').value;
    const msgs = splitMessages(raw);
    if (!msgs.length) { toast('الصق رسالة البنك أولاً'); return; }
    const hashes = knownHashes(), seen = new Set();
    state.parsed = msgs.map((s) => {
      const r = parseSms(s, { rules: state.profile.rules });
      if (r.ok) { r.dup = hashes.has(r.hash) || seen.has(r.hash); r.include = !r.dup; seen.add(r.hash); }
      return r;
    });
    render();
  }

  function saveParsed() {
    const list = state.parsed.filter((r) => r.ok && r.include && r.amount > 0).map((r) => ({
      id: uid(), type: r.type, amount: Math.round(r.amount * 100) / 100, cat: r.cat, merchant: (r.merchant || '').trim(), date: r.date,
      method: r.method || '', note: '', source: 'sms', hash: r.hash, raw: r.raw.slice(0, 600), bank: r.bank || '',
    }));
    if (!list.length) return;
    addTxns(list);
    state.parsed = []; if ($('#sms-in')) $('#sms-in').value = '';
    toast('تم حفظ ' + fmt(list.length, 0) + (list.length === 1 ? ' عملية' : ' عمليات'));
    state.tab = 'home'; state.offset = 0; render();
  }

  function saveManual() {
    readManualForm();
    const m = state.manual, amount = toNum(m.amount);
    if (!(amount > 0)) { toast('اكتب المبلغ'); $('#m-amount').focus(); return; }
    const cat = m.cat || (m.merchant ? categorize(m.merchant, '', m.type, state.profile.rules) : m.type === 'income' ? 'income_other' : 'other');
    addTxns([{ id: uid(), type: m.type, amount: Math.round(amount * 100) / 100, cat, merchant: m.merchant.trim(), date: m.date || iso(new Date()), method: m.method, note: m.note.trim(), source: 'manual' }]);
    state.manual = newManual(m.type);
    toast('تم حفظ العملية');
    state.tab = 'home'; state.offset = 0; render();
  }

  function saveEdit() {
    const e = state.editing, t = e.t;
    const amount = toNum($('#e-amount').value);
    if (!(amount > 0)) { toast('المبلغ غير صحيح'); return; }
    const patch = { type: t.type, amount: Math.round(amount * 100) / 100, cat: $('#e-cat').value, merchant: $('#e-merchant').value.trim(), date: $('#e-date').value || t.date, method: $('#e-method').value, note: $('#e-note').value.trim() };
    if ($('#e-remember') && $('#e-remember').checked && patch.merchant) {
      setProfile({ rules: { ...(state.profile.rules || {}), [normalizeMerchant(patch.merchant)]: patch.cat } });
    }
    updateTxn(t.id, patch);
    state.editing = null; toast('تم الحفظ'); render();
  }

  async function exportCsv() {
    const rows = [['التاريخ', 'النوع', 'المبلغ', 'الفئة', 'الجهة', 'طريقة الدفع', 'المصدر', 'ملاحظة']];
    realTxns().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((t) => rows.push([t.date.replace('T', ' '), t.type === 'income' ? 'دخل' : 'مصروف', t.amount, CAT[t.cat]?.name || t.cat, t.merchant, t.method, t.source === 'sms' ? 'رسالة' : 'يدوي', t.note || '']));
    const csv = '﻿' + rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    await offerFile('mizaniyati-' + iso(new Date()).slice(0, 10) + '.csv', csv, 'text/csv');
  }

  // Save a file: the artifact viewer's downloads capability, else the phone's share sheet, else a plain download.
  async function offerFile(filename, text, type) {
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data: text }); } catch (e) { if (e && e.code !== 'declined') toast('تعذّر حفظ الملف'); }
      return;
    }
    const blob = new Blob([text], { type });
    try {
      const file = new File([blob], filename, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportBackup() {
    const data = JSON.stringify({ app: 'mizaniyati', v: 1, at: new Date().toISOString(), profile: state.profile, months: state.months });
    offerFile('mizaniyati-backup-' + iso(new Date()).slice(0, 10) + '.json', data, 'application/json');
  }

  function importBackup(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || d.app !== 'mizaniyati' || typeof d.months !== 'object') throw new Error('bad');
        const have = new Set(realTxns().map((t) => t.id));
        const list = Object.values(d.months).flat().filter((t) => t && t.id && !have.has(t.id) && t.date && t.amount > 0);
        if (d.profile) setProfile({ ...d.profile });
        if (list.length) addTxns(list);
        toast('تمت استعادة ' + fmt(list.length, 0) + ' عملية');
        render();
      } catch (e) { toast('الملف غير صالح — اختر ملف نسخة احتياطية من ميزانيتي'); }
    };
    r.readAsText(file);
  }

  function clearAll() {
    const keys = Object.keys(state.months);
    state.months = {};
    keys.forEach((k) => Store.saveMonth(k));
    if (state.mode !== 'cloud') Store.saveLocal();
    state.confirmClear = false; toast('تم حذف كل العمليات'); render();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-go],[data-act],[data-edit],[data-ftype],[data-addmode],[data-mtype],[data-mcat],[data-digits],[data-delrule],[data-etype]');
    if (!t) return;
    const d = t.dataset;
    if (d.go) { if (state.tab === 'add') readManualForm(); state.tab = d.go; state.editing = null; render(); window.scrollTo(0, 0); return; }
    if (d.edit) { const tx = allTxns().find((x) => x.id === d.edit); if (tx) { state.editing = { t: { ...tx } }; renderSheet(); } return; }
    if (d.ftype !== undefined) { state.txFilter.type = d.ftype; render(); return; }
    if (d.addmode) { readManualForm(); state.addMode = d.addmode; render(); return; }
    if (d.mtype) { readManualForm(); state.manual.type = d.mtype; state.manual.cat = d.mtype === 'income' ? 'salary' : ''; render(); return; }
    if (d.mcat) { readManualForm(); state.manual.cat = state.manual.cat === d.mcat ? '' : d.mcat; render(); return; }
    if (d.digits) { setProfile({ digits: d.digits }); render(); return; }
    if (d.delrule) { const r = { ...(state.profile.rules || {}) }; delete r[d.delrule]; setProfile({ rules: r }); render(); return; }
    if (d.etype) {
      const e = state.editing; e.t = { ...e.t, amount: $('#e-amount').value, merchant: $('#e-merchant').value, date: $('#e-date').value, method: $('#e-method').value, note: $('#e-note').value, type: d.etype };
      e.t.cat = d.etype === 'income' ? (CAT[e.t.cat]?.kind === 'income' ? e.t.cat : 'income_other') : (CAT[e.t.cat]?.kind === 'expense' ? e.t.cat : 'other');
      renderSheet(); return;
    }
    switch (d.act) {
      case 'prev': state.offset--; render(); break;
      case 'next': if (state.offset < 0) { state.offset++; render(); } break;
      case 'parse': doParse(); break;
      case 'example': $('#sms-in').value = SMS_EXAMPLE; doParse(); break;
      case 'clear-sms': $('#sms-in').value = ''; state.parsed = []; render(); break;
      case 'save-parsed': saveParsed(); break;
      case 'save-manual': saveManual(); break;
      case 'close-sheet': if (ev.target === t) { state.editing = null; renderSheet(); } break;
      case 'save-edit': saveEdit(); break;
      case 'del': state.editing.confirmDel = true; renderSheet(); break;
      case 'del-yes': deleteTxn(state.editing.t.id); state.editing = null; toast('تم حذف العملية'); render(); break;
      case 'export': exportCsv(); break;
      case 'backup': exportBackup(); break;
      case 'clear': state.confirmClear = true; render(); break;
      case 'clear-no': state.confirmClear = false; render(); break;
      case 'clear-yes': clearAll(); break;
    }
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'tx-q') { state.txFilter.q = el.value; render(); return; }
    if (el.dataset.pf) { readParsedField(el); return; }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'restore-file') { if (el.files && el.files[0]) importBackup(el.files[0]); el.value = ''; return; }
    if (el.id === 'tx-cat') { state.txFilter.cat = el.value; render(); return; }
    if (el.dataset.pinc !== undefined) { const r = state.parsed[+el.dataset.pinc]; r.include = el.checked; render(); return; }
    if (el.dataset.pf) { readParsedField(el); return; }
    if (el.id === 's-budget') { const n = toNum(el.value); if (n > 0) { setProfile({ budget: Math.round(n) }); toast('تم تحديث الميزانية'); } else el.value = state.profile.budget; return; }
    if (el.id === 's-start') { setProfile({ startDay: +el.value }); state.offset = 0; sampleCache = null; toast('تم تحديث بداية الشهر'); return; }
    if (el.dataset.cb) {
      const n = toNum(el.value); const cb = { ...(state.profile.catBudgets || {}) };
      if (n > 0) cb[el.dataset.cb] = Math.round(n); else delete cb[el.dataset.cb];
      setProfile({ catBudgets: cb }); return;
    }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.editing) { state.editing = null; renderSheet(); } });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.tab === 'reports') render(); }, 150); });

  if (location.hash === '#iphone') state.tab = 'settings';
  // Android share sheet: a bank SMS shared to the installed app arrives as ?text=… — open it ready to save.
  let sharedText = '';
  try {
    const qs = new URLSearchParams(location.search);
    sharedText = [qs.get('title'), qs.get('text')].filter(Boolean).join('\n').trim();
    if (sharedText) history.replaceState(null, '', location.pathname);
  } catch (e) { sharedText = ''; }
  // First paint shows the layout (with marked sample data) while storage connects.
  state.mode = 'connecting';
  render();
  Store.init().then(() => {
    if (!sharedText) return;
    state.tab = 'add'; state.addMode = 'sms'; render();
    $('#sms-in').value = sharedText; doParse();
  });
})();
