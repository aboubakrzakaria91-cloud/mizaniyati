// ===== ميزانيتي — الإصدار 2 =====
// Model: every expense sits on a budget line (section → item, the same as the Excel sheet) and is paid from a wallet.
// Wallets marked "from salary" count against the month's budget; savings wallets are recorded but don't touch it.
(function () {
  'use strict';
  const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const INC_CATS = CATEGORIES.filter((c) => c.kind === 'income');
  const LS_KEY = 'mizaniyati.v2';
  const LS_OLD = 'mizaniyati.v1';
  const TYPE_AR = { Needs: 'ضروريات', Wants: 'كماليات', Goals: 'أهداف', Safe: 'ادخار وأمان' };
  const SEC_ICON = { 'السعودية': '🏠', 'مصر': '🇪🇬', 'السيارة': '🚗', 'سارة': '👩', 'بكر': '👤', 'الترفيه': '☕', 'اشتراكات': '📺', 'أقساط': '🧾', 'سداد الديون': '💳', 'الاستثمارات': '📈', 'أخرى': '•' };
  const CUR_AR = { SAR: 'ر.س', EGP: 'ج.م' };
  const DEFAULT_WALLETS = [
    { id: 'bank', n: 'البنك', cur: 'SAR', open: 0, budget: true },
    { id: 'cash', n: 'كاش', cur: 'SAR', open: 0, budget: true },
    { id: 'savings', n: 'مدخرات سابقة', cur: 'EGP', open: 0, budget: false },
  ];
  const METHODS = ['', 'مدى', 'مدى · Apple Pay', 'فيزا', 'فيزا · Apple Pay', 'ماستركارد', 'STC Pay', 'نقداً', 'تحويل بنكي', 'أخرى'];

  function defaultProfile() {
    return {
      v: 2, startDay: 1, digits: 'latn', earlySalary: true, rules: {}, lineRules: {},
      rates: { EGP: PLAN_EGP_RATE }, planIncome: PLAN_INCOME,
      lines: PLAN_LINES.map((l) => ({ ...l })), wallets: DEFAULT_WALLETS.map((w) => ({ ...w })),
    };
  }
  // Brings a v1 (or partial) profile up to v2 without losing anything the user set.
  function ensureProfile(p) {
    const d = defaultProfile();
    const out = { ...d, ...(p || {}) };
    if (!p || !Array.isArray(p.lines) || !p.lines.length) {
      const over = (p && p.plan) || {};
      out.lines = d.lines.map((l) => (over[l.k] != null ? { ...l, p: over[l.k], pe: undefined, cur: l.cur === 'EGP' && over[l.k] ? 'SAR' : l.cur } : l));
    }
    if (!p || !Array.isArray(p.wallets) || !p.wallets.length) out.wallets = d.wallets;
    if (!out.rates || !out.rates.EGP) out.rates = { EGP: (p && p.egpRate) || PLAN_EGP_RATE };
    if (out.planIncome == null) out.planIncome = PLAN_INCOME;
    out.v = 2;
    return out;
  }

  const state = {
    profile: defaultProfile(),
    months: {},
    mode: 'connecting',
    tab: 'home',
    offset: 0,
    txFilter: { q: '', type: '', line: '', wallet: '' },
    addMode: 'manual',
    parsed: [],
    draft: null,
    editing: null,
    confirmClear: false,
    confirmLine: null,
    newLine: null,
  };

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  const curTxt = (n, cur, dec) => fmt(n, dec) + ' ' + CUR_AR[cur || 'SAR'];
  function fmtDate(d, opts) { return new Intl.DateTimeFormat(loc(), opts).format(d); }
  const parseIso = (s) => { const [a, b] = s.split('T'); const [y, m, d] = a.split('-').map(Number); const [hh, mi] = (b || '00:00').split(':').map(Number); return new Date(y, m - 1, d, hh, mi); };
  const toNum = (v) => { const n = parseFloat(normalizeDigits(v).replace(/,/g, '')); return isFinite(n) ? n : NaN; };
  const r2 = (n) => Math.round(n * 100) / 100;
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  // ---------- storage (local, or the account store when running inside Claude) ----------
  const Store = {
    db: null, uid: null, busy: {}, pending: {},
    loadLocal() {
      try {
        let raw = localStorage.getItem(LS_KEY);
        if (!raw) {
          // First run of v2: copy the v1 data. The v1 copy stays untouched as a backup.
          const old = localStorage.getItem(LS_OLD);
          if (old) { raw = old; state.migrated = true; }
        }
        if (raw) { const d = JSON.parse(raw); state.profile = ensureProfile(d.profile); state.months = d.months || {}; }
        if (state.migrated) this.saveLocal();
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
        if (!Object.keys(state.months).length && Object.keys(localMonths).length) {
          state.months = localMonths;
          Object.keys(localMonths).forEach((k) => this.saveMonth(k));
        }
        render();
      };
      this.timer = setTimeout(() => { if (state.mode !== 'cloud') this.fallback(); }, 12000);
      profRef.onSnapshot((snap) => {
        gotProfile = true;
        state.profile = ensureProfile(snap.exists ? snap.data() : null);
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
    saveMonth(key) { this.write(key, () => (state.months[key] && state.months[key].length ? { txns: state.months[key] } : null)); },
    saveProfile() { this.write('profile', () => JSON.parse(JSON.stringify(state.profile))); },
  };

  // ---------- profile lookups ----------
  const rate = () => (state.profile.rates && state.profile.rates.EGP) || PLAN_EGP_RATE;
  const toSar = (amount, cur) => (cur === 'EGP' ? amount / rate() : amount);
  const fromSar = (sar, cur) => (cur === 'EGP' ? sar * rate() : sar);
  let lineCache = null, lineCacheFor = null;
  function LINE() {
    if (lineCacheFor !== state.profile.lines) { lineCache = Object.fromEntries(state.profile.lines.map((l) => [l.k, l])); lineCacheFor = state.profile.lines; }
    return lineCache;
  }
  const sections = () => [...new Set(state.profile.lines.map((l) => l.s))];
  const secIcon = (s) => SEC_ICON[s] || '📁';
  const planOf = (l) => (l.cur === 'EGP' && l.pe != null ? l.pe / rate() : l.p || 0);
  const planTotal = () => state.profile.lines.reduce((a, l) => a + planOf(l), 0);
  const walletById = (id) => state.profile.wallets.find((w) => w.id === id) || state.profile.wallets[0];
  const walletOf = (t) => walletById(t.wallet || (t.method === 'نقداً' ? 'cash' : 'bank'));
  const inBudget = (t) => walletOf(t).budget !== false;
  const isRefund = (t) => t.type === 'income' && t.cat === 'refund';

  // Same rules used to fill the Excel sheet; '' means the user picks the line.
  function lineFor(t) {
    if (t.type !== 'expense') return '';
    const L = LINE(), ok = (k) => (L[k] ? k : '');
    const m = (t.merchant || '').toLowerCase(), note = t.note || '', cat = t.cat, amt = t.amount;
    const nm = normalizeMerchant(t.merchant || ''), lr = state.profile.lineRules || {};
    if (nm && lr[nm] !== undefined && (lr[nm] === '' || L[lr[nm]])) return lr[nm];
    if (/تذكرة طيران|تذكره طيران|تذاكر/.test(note)) return ok('مصر - فلوس تذكره');
    if (/احمد سعد|أحمد سعد/.test(note)) return ok('مصر - فلوس احمد سعد');
    if (/ديون|دين/.test(note)) return ok('سداد الديون - رد ديون');
    if (/قسط السيار[ةه]/.test(note) || /\bjebi\b/.test(m)) return ok('السيارة - قسط السيارة');
    if (/صيان[ةه]/.test(m + ' ' + note) && /باب|بيت|منزل|شق[ةه]/.test(m + ' ' + note)) return ok('السعودية - صيانة للبيت');
    if (/tabby|تابي/.test(m)) return ok('أقساط - تابي');
    if (/perplexity/.test(m)) return ok('اشتراكات - Preplex');
    if (cat === 'subscriptions') return ok('اشتراكات - المواقع');
    if (/الكهرباء|كهرباء|\bsec\b/.test(m)) return ok('السعودية - الكهرباء');
    if (/المياه|مياه|\bnwc\b/.test(m)) return ok('السعودية - فاتوره المياه');
    if (/^stc\b/.test(m.trim()) && cat === 'bills') return ok('بكر - فاتورة جوال');
    if (cat === 'fuel') return ok('السيارة - بنزين');
    if (/باركن|parking|مواقف/.test(m)) return ok('السيارة - اشتراك الموقف');
    if (/بلايستيشن|playstation/.test(m)) return ok('الترفيه - تمشيه / ملاهي');
    if (/baskin|حلويات|حلوى/.test(m)) return ok('الترفيه - حلويات');
    if (cat === 'coffee') return ok('الترفيه - كوفي شوب');
    if (cat === 'restaurants' || cat === 'delivery') return ok('الترفيه - مطاعم');
    if (cat === 'groceries' || /\bmeed\b/.test(m)) return ok('السعودية - المقاضي الشهرية');
    if (cat === 'health') return ok('بكر - علاج');
    if ((cat === 'transport' || cat === 'personal') && amt < 100) return ok('بكر - مصروف جيب');
    if (cat === 'other' && amt < 20) return ok('بكر - مصروف جيب');
    if (cat === 'car' && amt < 50) return ok('السيارة - غسيل');
    if (cat === 'entertainment') return ok('الترفيه - تمشيه / ملاهي');
    if (cat === 'shopping' || cat === 'personal') return ok('بكر - ملابس');
    return '';
  }
  const lineOf = (t) => (t.line !== undefined && (t.line === '' || LINE()[t.line]) ? t.line : lineFor(t));
  const lineName = (k) => (LINE()[k] ? LINE()[k].n : '');
  const lineSelect = (sel, attrs, withSections) => `<select ${attrs}>${withSections ? '<option value="">كل البنود</option><option value="__none" ' + (sel === '__none' ? 'selected' : '') + '>⚠ بدون بند</option>' : '<option value="">— بدون بند —</option>'}${sections().map((sec) => `<optgroup label="${esc(secIcon(sec) + ' ' + sec)}">${withSections ? `<option value="sec:${esc(sec)}" ${sel === 'sec:' + sec ? 'selected' : ''}>كل ${esc(sec)}</option>` : ''}${state.profile.lines.filter((l) => l.s === sec).map((l) => `<option value="${esc(l.k)}" ${l.k === sel ? 'selected' : ''}>${esc(l.n)}</option>`).join('')}</optgroup>`).join('')}</select>`;

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
    for (const t0 of list) {
      const t = autoBudgetMonth(t0);
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

  // ---------- Android app (APK): reads bank SMS from the inbox through a native bridge ----------
  const Native = window.MizaniyatiAndroid || null;
  const nativeSmsOn = () => { try { return !!(Native && Native.hasSmsPermission()); } catch (e) { return false; } };
  const TXN_WORDS = /(شراء|سحب|حوالة|حواله|تحويل|إيداع|ايداع|راتب|استرداد|مسترد|سداد|خصم من|مدين|دائن|Purchase|POS|Withdraw|Transfer|Deposit|Salary|Refund|Payment|debited|credited)/i;
  const PROMO_WORDS = /(عرض|عروض|اربح|فرصة|احصل على|سارع|offer|promo|\bwin\b|cashback|كاش باك|\d\s?%|٪)/i;
  function smsSyncFrom() { return state.profile.smsSince || periodAt(-2).start.getTime(); }
  function smsToTxn(r, extra) {
    return { id: uid(), type: r.type, amount: r.amount, cur: 'SAR', orig: r.amount, cat: r.cat, merchant: (r.merchant || '').trim(), date: r.date, method: r.method || '', wallet: 'bank',
      note: r.currency !== 'SAR' ? 'المبلغ بعملة ' + r.currency : '', source: 'sms', hash: r.hash, raw: r.raw.slice(0, 600), bank: r.bank || '', ...(extra || {}) };
  }
  function syncSms(since) {
    if (!nativeSmsOn()) return 0;
    let msgs = [];
    try { msgs = JSON.parse(Native.readSms(String(since ?? smsSyncFrom()))) || []; } catch (e) { msgs = []; }
    const hashes = knownHashes(), add = [];
    let last = state.profile.smsSince || 0;
    for (const m of msgs) {
      last = Math.max(last, m.date + 1);
      // Bank senders are names (AlRajhiBank, SNB-AlAhli…) or short codes; full phone numbers are personal chats.
      if (/^\+?\d{8,}$/.test(String(m.address || '').replace(/[\s-]/g, ''))) continue;
      if (!TXN_WORDS.test(m.body) || PROMO_WORDS.test(m.body)) continue;
      const r = parseSms(m.body, { rules: state.profile.rules, now: new Date(m.date) });
      if (!r.ok || hashes.has(r.hash)) continue;
      hashes.add(r.hash);
      add.push(smsToTxn(r, { bank: r.bank || m.address || '' }));
    }
    if (add.length) addTxns(add);
    setProfile({ smsSince: Math.max(last, state.profile.smsSince || 0), smsSyncedAt: Date.now() });
    if (add.length) toast('أُضيفت ' + fmt(add.length, 0) + (add.length === 1 ? ' عملية' : ' عمليات') + ' من رسائل البنك');
    render();
    return add.length;
  }
  window.onSmsPermission = (granted) => {
    if (granted) { const n = syncSms(); if (!n) toast('تم التفعيل — لا توجد رسائل بنك جديدة'); }
    else { toast('لم يتم منح صلاحية قراءة الرسائل'); render(); }
  };
  window.mizaniyatiResume = () => { if (nativeSmsOn()) syncSms(); };
  window.mizaniyatiShare = (text) => {
    state.tab = 'add'; state.addMode = 'sms'; render();
    $('#sms-in').value = String(text || ''); doParse();
  };

  // ---------- periods ----------
  function startDay() { return Math.min(28, Math.max(1, state.profile.startDay || 1)); }
  function periodAt(offset) {
    const S = startDay(), now = new Date();
    let y = now.getFullYear(), m = now.getMonth();
    if (now.getDate() < S) m -= 1;
    const start = new Date(y, m + offset, S), end = new Date(y, m + offset + 1, S);
    return { start, end, s: iso(start), e: iso(end), days: Math.round((end - start) / 86400000) };
  }
  function periodOfDate(isoStr) {
    const S = startDay(), d = parseIso(isoStr);
    let y = d.getFullYear(), m = d.getMonth();
    if (d.getDate() < S) m -= 1;
    const start = new Date(y, m, S), end = new Date(y, m + 1, S);
    return { start, end, s: iso(start), e: iso(end), days: Math.round((end - start) / 86400000) };
  }
  function periodLabel(p) {
    if (startDay() === 1) return fmtDate(p.start, { month: 'long', year: 'numeric' });
    const last = new Date(p.end.getTime() - 86400000);
    return fmtDate(p.start, { day: 'numeric', month: 'short' }) + ' – ' + fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  // A transaction counts in its date's period unless it carries a budget month (bm = 'YYYY-MM' of that period's start).
  const periodKey = (p) => p.s.slice(0, 7);
  const inPeriod = (p) => { const k = periodKey(p); return allTxns().filter((t) => (t.bm ? t.bm === k : t.date >= p.s && t.date < p.e)); };
  // Salary that lands in the last days of a period pays for the next one.
  function autoBudgetMonth(t) {
    if (t.bm !== undefined || t.type !== 'income' || t.cat !== 'salary' || state.profile.earlySalary === false) return t;
    const p = periodOfDate(t.date);
    const daysLeft = (p.end - parseIso(t.date)) / 86400000;
    return daysLeft <= (state.profile.earlySalaryDays || 7) ? { ...t, bm: iso(p.end).slice(0, 7) } : t;
  }
  function elapsed(p) {
    const now = new Date();
    if (now >= p.end) return { frac: 1, daysGone: p.days, daysLeft: 0, current: false };
    if (now < p.start) return { frac: 0, daysGone: 0, daysLeft: p.days, current: false, future: true };
    const daysGone = Math.floor((now - p.start) / 86400000) + 1;
    return { frac: (now - p.start) / (p.end - p.start), daysGone, daysLeft: p.days - daysGone + 1, current: true };
  }
  // Money for one period: what came in, what went out from salary wallets, and what was paid from savings.
  function totals(list) {
    let income = 0, spent = 0, savings = 0, savingsEgp = 0;
    const byLine = {}, bySec = {}; let unassigned = 0;
    for (const t of list) {
      const budget = inBudget(t);
      if (t.type === 'income') {
        if (!budget) continue;
        if (isRefund(t)) { spent -= t.amount; const k = lineOf(t); if (k) { byLine[k] = (byLine[k] || 0) - t.amount; const s = LINE()[k].s; bySec[s] = (bySec[s] || 0) - t.amount; } }
        else income += t.amount;
        continue;
      }
      if (!budget) { savings += t.amount; savingsEgp += t.cur === 'EGP' ? t.orig : fromSar(t.amount, 'EGP'); continue; }
      spent += t.amount;
      const k = lineOf(t);
      if (k) { byLine[k] = (byLine[k] || 0) + t.amount; const s = LINE()[k].s; bySec[s] = (bySec[s] || 0) + t.amount; }
      else unassigned += t.amount;
    }
    return { income, spent, savings, savingsEgp, byLine, bySec, unassigned };
  }
  const baseIncome = (tt) => tt.income || state.profile.planIncome || 0;

  // ---------- sample data (shown only while there is no real data) ----------
  function makeSamples() {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const plan = [
      ['groceries', 'بنده', 6, 90, 420], ['restaurants', 'البيك', 5, 28, 75], ['coffee', 'بارنز', 9, 12, 32], ['fuel', 'الدريس', 4, 90, 150],
      ['shopping', 'أمازون', 2, 90, 480], ['health', 'صيدلية النهدي', 2, 40, 180], ['entertainment', 'VOX Cinemas', 1, 110, 220],
    ];
    const out = [];
    for (let off = -2; off <= 0; off++) {
      const p = periodAt(off);
      const lim = off === 0 ? Math.max(1, elapsed(p).daysGone) : p.days;
      for (const [cat, merchant, n, lo, hi] of plan) {
        for (let i = 0; i < n; i++) {
          const day = Math.floor(rnd() * lim);
          const d = new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() + day, 8 + Math.floor(rnd() * 14), Math.floor(rnd() * 60));
          const amount = r2(lo + rnd() * (hi - lo));
          out.push({ id: 's' + out.length, type: 'expense', amount, cur: 'SAR', orig: amount, cat, merchant, date: iso(d), method: 'مدى', wallet: 'bank', source: 'sms', sample: true });
        }
      }
      out.push({ id: 's' + out.length, type: 'income', amount: 16650, cur: 'SAR', orig: 16650, cat: 'salary', merchant: 'راتب', date: iso(new Date(p.start.getTime() + 5 * 86400000)), wallet: 'bank', source: 'sms', sample: true });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ---------- rendering ----------
  function render() {
    renderHeader();
    document.querySelectorAll('section[data-tab]').forEach((s) => (s.hidden = s.dataset.tab !== state.tab));
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.go === state.tab ? 'page' : 'false'));
    const fn = { home: renderHome, txns: renderTxns, add: renderAdd, reports: renderPlan, settings: renderSettings }[state.tab];
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
      <button class="iconbtn" data-act="prev" aria-label="الشهر السابق">›</button>
      <div class="label">${esc(periodLabel(p))}${state.offset ? ' <button class="link small" data-act="today">العودة لهذا الشهر</button>' : ''}</div>
      <button class="iconbtn" data-act="next" aria-label="الشهر التالي" ${state.offset >= 3 ? 'disabled' : ''}>‹</button>
    </div>`;
  }

  function banners() {
    let h = '';
    if (state.migrated) h += `<div class="banner sample"><span><b>تم الانتقال للإصدار الجديد.</b> نُقلت كل عملياتك، والإصدار القديم ببياناته محفوظ كما هو${Native ? '' : ' من «المزيد ← النسخة السابقة»'}.</span><button class="btn ghost" data-act="dismiss-migrated" style="padding:6px 12px">تمام</button></div>`;
    if (isSample()) h += `<div class="banner sample"><span><b>هذه بيانات توضيحية</b>. ستختفي عند إضافة أول عملية لك.</span><button class="btn" data-go="add" style="padding:8px 14px">أضف أول عملية</button></div>`;
    if (Native && !nativeSmsOn()) h += `<div class="banner sample"><span><b>فعّل قراءة رسائل البنك تلقائياً</b> ليسجّل التطبيق عملياتك بنفسه.</span><button class="btn" data-act="sms-enable" style="padding:8px 14px">تفعيل</button></div>`;
    return h;
  }

  function amountHtml(t) {
    const sign = t.type === 'income' ? '+' : '';
    const egp = t.cur === 'EGP' ? `<span class="src">${sign}${curTxt(t.orig, 'EGP', 0)}</span>` : '';
    return `<span class="a ${t.type === 'income' ? 'in' : ''}">${sign}${fmt(t.amount)}</span>${egp}`;
  }
  function txRow(t) {
    const k = lineOf(t), L = LINE()[k], w = walletOf(t);
    const icon = t.type === 'income' ? (CAT[t.cat] || CAT.income_other).icon : L ? secIcon(L.s) : '❔';
    const title = t.merchant || (L ? L.n : t.type === 'income' ? (CAT[t.cat] || CAT.income_other).name : 'بدون وصف');
    const sub = [t.type === 'income' ? (CAT[t.cat] || CAT.income_other).name : L ? L.s + ' › ' + L.n : '⚠ بدون بند', fmtDate(parseIso(t.date), { hour: 'numeric', minute: '2-digit' }), w.n].filter(Boolean).join(' · ');
    return `<button class="tx ${w.budget === false ? 'saving' : ''}" data-edit="${esc(t.id)}">
      <span class="ic" aria-hidden="true">${icon}</span>
      <span style="min-width:0"><span class="t1" style="display:block">${esc(title)}</span><span class="t2" style="display:block">${esc(sub)}</span></span>
      <span>${amountHtml(t)}${w.budget === false ? '<span class="src">من المدخرات</span>' : ''}</span>
    </button>`;
  }

  function sectionBars(tt, limit) {
    const rows = Object.entries(tt.bySec).sort((a, b) => b[1] - a[1]);
    if (tt.unassigned) rows.push(['__none', tt.unassigned]);
    if (!rows.length) return '<div class="empty">لا توجد مصروفات في هذا الشهر</div>';
    const plans = {}; state.profile.lines.forEach((l) => (plans[l.s] = (plans[l.s] || 0) + planOf(l)));
    const max = Math.max(...rows.map((r) => Math.max(r[1], plans[r[0]] || 0)));
    return '<div class="cats">' + rows.slice(0, limit || rows.length).map(([s, v]) => {
      const p = plans[s] || 0, over = p && v > p;
      return `<button class="catrow plain" data-filter-line="${s === '__none' ? '__none' : 'sec:' + esc(s)}"><span class="ic" aria-hidden="true">${s === '__none' ? '❔' : secIcon(s)}</span><span class="nm">${s === '__none' ? 'بدون بند' : esc(s)}</span><span class="amt ${over ? 'delta-up' : ''}">${fmt(v, 0)}</span>
        <span class="bar"><i class="${over ? 'bad' : ''}" style="width:${((v / max) * 100).toFixed(1)}%"></i>${p ? `<b class="planmark" style="inset-inline-start:${Math.min(100, (p / max) * 100).toFixed(1)}%"></b>` : ''}</span>
        <span class="meta">${s === '__none' ? 'اضغط لتوزيعها على بنودها' : p ? 'المخطط ' + fmt(p, 0) + (over ? ' · تجاوز ' + fmt(v - p, 0) : ' · متبقي ' + fmt(p - v, 0)) : 'غير مخطط له'}</span></button>`;
    }).join('') + '</div>';
  }

  function overCard(tt) {
    const over = state.profile.lines.map((l) => ({ l, p: planOf(l), a: tt.byLine[l.k] || 0 })).filter((x) => x.a > x.p + 0.5).sort((a, b) => (b.a - b.p) - (a.a - a.p)).slice(0, 5);
    if (!over.length) return '';
    return `<div class="card"><h2>تجاوزت الخطة <button class="link" data-go="reports">الخطة كاملة</button></h2><div class="cats">
      ${over.map((x) => `<button class="catrow plain" data-filter-line="${esc(x.l.k)}"><span class="ic" aria-hidden="true">⚠</span><span class="nm">${esc(x.l.n)} <span class="small muted">${esc(x.l.s)}</span></span><span class="amt delta-up">+${fmt(x.a - x.p, 0)}</span>
        <span class="meta">${x.p ? 'صرفت ' + fmt(x.a, 0) + ' من مخطط ' + fmt(x.p, 0) : 'غير مخطط له · ' + fmt(x.a, 0) + ' ر.س'}</span></button>`).join('')}</div></div>`;
  }

  function renderHome(el) {
    const p = periodAt(state.offset);
    const list = inPeriod(p);
    const tt = totals(list);
    const base = baseIncome(tt);
    const rem = base - tt.spent;
    const el2 = elapsed(p);
    const frac = base ? tt.spent / base : 0;
    let status = 'good', statusTxt = 'ضمن الخطة';
    if (frac >= 1) { status = 'bad'; statusTxt = 'تجاوزت الدخل'; }
    else if (el2.current && frac > el2.frac + 0.03) { status = 'warn'; statusTxt = 'تصرف أسرع من الخطة'; }
    else if (el2.future) statusTxt = 'شهر قادم';
    const daily = el2.current && el2.daysLeft ? Math.max(0, rem) / el2.daysLeft : 0;
    const projected = el2.current && el2.daysGone ? (tt.spent / el2.daysGone) * p.days : tt.spent;
    const todayIso = iso(new Date()).slice(0, 10);
    const today = list.filter((t) => t.type === 'expense' && inBudget(t) && t.date.slice(0, 10) === todayIso).reduce((a, t) => a + t.amount, 0);
    const recent = list.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
    el.innerHTML = `${periodBar()}${banners()}
    <div class="hero">
      <div class="hero-head"><span class="eyebrow">${rem >= 0 ? 'المتبقي من ' + (tt.income ? 'الراتب' : 'الدخل المخطط') : 'صرفت أكثر من الدخل بـ'}</span>
        <span class="pill ${status}">${status === 'good' ? '✓' : '⚠'} ${statusTxt}</span></div>
      <div class="big ${rem < 0 ? 'neg' : ''}">${money(Math.abs(rem), 0)}</div>
      <div class="gauge" role="img" aria-label="صرفت ${fmt(frac * 100, 0)}٪ من الدخل">
        <div class="fill ${status === 'good' ? '' : status}" style="width:${Math.min(100, frac * 100).toFixed(1)}%"></div>
        ${el2.current ? `<div class="pace" style="inset-inline-start:${(el2.frac * 100).toFixed(1)}%" data-label="اليوم"></div>` : ''}
      </div>
      <div class="gauge-legend"><span>صرفت <b class="num">${fmt(tt.spent, 0)}</b> من <span class="num">${fmt(base, 0)}</span> ر.س</span><span class="num">${fmt(frac * 100, 0)}٪</span></div>
      ${tt.savings ? `<div class="savings-note">💰 صرفت أيضاً <b>${moneyTxt(tt.savings, 0)}</b>${tt.savingsEgp ? ' (' + curTxt(tt.savingsEgp, 'EGP', 0) + ')' : ''} من المدخرات · الإجمالي ${moneyTxt(tt.spent + tt.savings, 0)}</div>` : ''}
    </div>
    <div class="quick">
      <button class="btn" data-quick="expense">＋ مصروف</button>
      <button class="btn ghost" data-quick="egp">＋ بالجنيه</button>
      <button class="btn ghost" data-quick="income">＋ دخل</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">صرفت اليوم</div><div class="v">${fmt(today, 0)} <small>ر.س</small></div><div class="h">${el2.current ? 'المسموح ' + fmt(daily, 0) + ' يومياً' : '—'}</div></div>
      <div class="stat"><div class="k">${el2.current ? 'المتوقع نهاية الشهر' : 'الدخل'}</div><div class="v" style="${el2.current && projected > base ? 'color:var(--bad)' : ''}">${fmt(el2.current ? projected : tt.income, 0)} <small>ر.س</small></div><div class="h">${el2.current ? (projected > base ? 'فوق الدخل بـ ' + fmt(projected - base, 0) : 'ضمن الدخل') : tt.income ? 'مستلم' : 'لم يُسجَّل'}</div></div>
    </div>
    ${isSample() ? '' : overCard(tt)}
    <div class="card"><h2>أين ذهبت أموالك؟ <button class="link" data-go="reports">الخطة</button></h2>${sectionBars(tt, 7)}</div>
    <div class="card"><h2>آخر العمليات <button class="link" data-go="txns">عرض الكل</button></h2>
      ${recent.length ? recent.map(txRow).join('') : '<div class="empty">لا توجد عمليات بعد. اضغط ＋ لإضافة أول عملية.</div>'}</div>`;
  }

  function txMatches(t, f, q) {
    if (f.type === 'expense' && t.type !== 'expense') return false;
    if (f.type === 'income' && t.type !== 'income') return false;
    if (f.type === 'savings' && inBudget(t)) return false;
    if (f.wallet && walletOf(t).id !== f.wallet) return false;
    if (f.line) {
      const k = lineOf(t);
      if (f.line === '__none') { if (t.type !== 'expense' || k) return false; }
      else if (f.line.startsWith('sec:')) { if (!k || LINE()[k].s !== f.line.slice(4)) return false; }
      else if (k !== f.line) return false;
    }
    if (q) {
      const hay = [t.merchant, t.note, lineName(lineOf(t)), String(t.amount), String(t.orig || '')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderTxns(el) {
    const p = periodAt(state.offset);
    const f = state.txFilter;
    const q = normalizeDigits(f.q).toLowerCase().trim();
    const list = inPeriod(p).filter((t) => txMatches(t, f, q)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const days = {};
    list.forEach((t) => (days[t.date.slice(0, 10)] = days[t.date.slice(0, 10)] || []).push(t));
    const tt = totals(list);
    const prevQ = document.activeElement && document.activeElement.id === 'tx-q';
    el.innerHTML = `${periodBar()}
    <div class="filters">
      <input type="search" id="tx-q" placeholder="ابحث بالمتجر أو البند أو المبلغ…" value="${esc(f.q)}" aria-label="بحث">
      <div class="segs" role="group" aria-label="النوع">
        ${[['', 'الكل'], ['expense', 'مصروف'], ['income', 'دخل'], ['savings', 'من المدخرات']].map(([v, l]) => `<button class="seg" data-ftype="${v}" aria-pressed="${f.type === v}">${l}</button>`).join('')}
      </div>
      <div class="row2">
        ${lineSelect(f.line, 'id="tx-line" aria-label="البند"', true)}
        <select id="tx-wallet" aria-label="المحفظة"><option value="">كل المحافظ</option>${state.profile.wallets.map((w) => `<option value="${esc(w.id)}" ${f.wallet === w.id ? 'selected' : ''}>${esc(w.n)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="card">
      <h2><span>${fmt(list.length, 0)} عملية</span><span class="small muted" style="font-weight:400">مصروف ${moneyTxt(tt.spent, 0)}${tt.savings ? ' · مدخرات ' + moneyTxt(tt.savings, 0) : ''}${tt.income ? ' · دخل ' + moneyTxt(tt.income, 0) : ''}</span></h2>
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
في: ${iso(new Date()).slice(0, 10)} 21:14`;

  function newDraft(kind) {
    const egp = kind === 'egp';
    const sav = state.profile.wallets.find((w) => w.budget === false && w.cur === 'EGP');
    return { type: kind === 'income' ? 'income' : 'expense', cur: egp ? 'EGP' : 'SAR', orig: '', line: '', sec: egp ? 'مصر' : '', inc: 'salary',
      wallet: egp && sav ? sav.id : 'bank', merchant: '', date: iso(new Date()), note: '', method: '' };
  }
  function readDraft() {
    const d = state.draft; if (!d || !$('#d-amount')) return;
    d.orig = $('#d-amount').value; d.merchant = $('#d-merchant').value; d.date = $('#d-date').value || d.date; d.note = $('#d-note').value;
  }
  function convLine(d) {
    const n = toNum(d.orig);
    if (!(n > 0)) return d.cur === 'EGP' ? 'بسعر ' + fmt(rate(), 2) + ' جنيه للريال' : '';
    return d.cur === 'EGP' ? '= ' + moneyTxt(toSar(n, 'EGP')) + ' · بسعر ' + fmt(rate(), 2) : '= ' + curTxt(fromSar(n, 'EGP'), 'EGP', 0);
  }
  function suggestLine(d) {
    if (d.type !== 'expense' || d.line || !d.merchant.trim()) return '';
    const cat = categorize(d.merchant, '', 'expense', state.profile.rules);
    return lineFor({ type: 'expense', merchant: d.merchant, note: d.note, cat, amount: toSar(toNum(d.orig) || 0, d.cur) });
  }

  function renderAdd(el) {
    if (!state.draft) state.draft = newDraft();
    readDraft();
    const d = state.draft;
    const smsVal = $('#sms-in') ? $('#sms-in').value : '';
    const secs = sections();
    const curSec = d.sec || (d.line && LINE()[d.line] ? LINE()[d.line].s : secs[0]);
    const sug = suggestLine(d);
    el.innerHTML = `
    <div class="segs center" role="tablist" aria-label="طريقة الإضافة">
      <button class="seg" data-addmode="manual" aria-pressed="${state.addMode === 'manual'}">إدخال سريع</button>
      <button class="seg" data-addmode="sms" aria-pressed="${state.addMode === 'sms'}">من رسالة البنك</button>
    </div>
    ${state.addMode === 'sms' ? `
    <div class="card" style="display:grid;gap:10px">
      <h2 style="margin:0">الصق رسالة البنك</h2>
      <p class="small muted" style="margin:0">انسخ رسالة العملية والصقها هنا، ويمكن لصق عدة رسائل بينها سطر فارغ. يتعرف التطبيق على المبلغ والمتجر والتاريخ والبند.</p>
      <textarea id="sms-in" dir="auto" placeholder="الصق الرسالة هنا">${esc(smsVal)}</textarea>
      <div class="btns"><button class="btn" data-act="parse">قراءة الرسائل</button><button class="btn ghost" data-act="example">مثال</button><button class="btn ghost" data-act="clear-sms">مسح</button></div>
    </div>
    ${renderParsed()}` : `
    <div class="card form">
      <div class="segs center">
        <button class="seg" data-dtype="expense" aria-pressed="${d.type === 'expense'}">مصروف</button>
        <button class="seg" data-dtype="income" aria-pressed="${d.type === 'income'}">دخل</button>
      </div>
      <div class="amountbox">
        <input id="d-amount" class="amount-in" type="text" inputmode="decimal" placeholder="0" value="${esc(d.orig)}" autocomplete="off" aria-label="المبلغ">
        <div class="segs center curseg" role="group" aria-label="العملة">
          <button class="seg" data-dcur="SAR" aria-pressed="${d.cur === 'SAR'}">ريال ر.س</button>
          <button class="seg" data-dcur="EGP" aria-pressed="${d.cur === 'EGP'}">جنيه ج.م</button>
        </div>
        <div class="conv" id="d-conv">${esc(convLine(d))}</div>
      </div>
      <div class="field"><label for="d-merchant">${d.type === 'income' ? 'المصدر' : 'على ماذا؟ (المتجر أو الوصف)'}</label><input id="d-merchant" type="text" dir="auto" placeholder="${d.type === 'income' ? 'مثلاً: راتب نوفمبر' : 'مثلاً: بنده، مصروف البيت، هدية'}" value="${esc(d.merchant)}"></div>
      ${d.type === 'expense' ? `
      <div class="field"><span class="lbl">البند ${d.line ? '· <b>' + esc(LINE()[d.line] ? LINE()[d.line].s + ' › ' + LINE()[d.line].n : '') + '</b>' : ''}</span>
        <div id="d-sug">${sug && !d.line ? `<button type="button" class="chip sug" data-dline="${esc(sug)}">✨ اقتراح: ${esc(LINE()[sug].s)} › ${esc(LINE()[sug].n)}</button>` : ''}</div>
        <div class="chips scroll" role="group" aria-label="القسم">${secs.map((s) => `<button type="button" class="chip" data-dsec="${esc(s)}" aria-pressed="${s === curSec}">${secIcon(s)} ${esc(s)}</button>`).join('')}</div>
        <div class="chips" role="group" aria-label="البند">${state.profile.lines.filter((l) => l.s === curSec).map((l) => `<button type="button" class="chip" data-dline="${esc(l.k)}" aria-pressed="${d.line === l.k}">${esc(l.n)}</button>`).join('')}</div>
      </div>` : `
      <div class="field"><span class="lbl">نوع الدخل</span><div class="chips">${INC_CATS.map((c) => `<button type="button" class="chip" data-dinc="${c.id}" aria-pressed="${d.inc === c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div></div>`}
      <div class="field"><span class="lbl">${d.type === 'income' ? 'أين استلمته؟' : 'من أين دفعت؟'}</span>
        <div class="chips">${state.profile.wallets.map((w) => `<button type="button" class="chip" data-dwallet="${esc(w.id)}" aria-pressed="${d.wallet === w.id}">${esc(w.n)} <span class="muted small">${CUR_AR[w.cur]}${w.budget === false ? ' · لا يُخصم من الراتب' : ''}</span></button>`).join('')}</div>
      </div>
      <div class="row2">
        <div class="field"><label for="d-date">التاريخ</label><input id="d-date" type="datetime-local" value="${esc(d.date)}"></div>
        <div class="field"><span class="lbl">&nbsp;</span><div class="chips"><button type="button" class="chip" data-ddate="0">اليوم</button><button type="button" class="chip" data-ddate="1">أمس</button></div></div>
      </div>
      <div class="field"><label for="d-note">ملاحظة (اختياري)</label><input id="d-note" type="text" dir="auto" value="${esc(d.note)}"></div>
      <button class="btn block big-btn" data-act="save-draft">حفظ</button>
    </div>`}`;
  }

  function renderParsed() {
    if (!state.parsed.length) return '';
    const n = state.parsed.filter((r) => r.ok && r.include).length;
    return `<div class="parsed">${state.parsed.map((r, i) => {
      if (!r.ok) return `<div class="pcard err"><div class="errline">${esc(r.error)}</div><div class="raw" dir="auto">${esc(r.raw)}</div></div>`;
      const k = r.line !== undefined ? r.line : lineFor({ type: r.type, merchant: r.merchant, cat: r.cat, amount: r.amount, note: '' });
      return `<div class="pcard ${r.include ? '' : 'off'}">
        <div class="head"><label class="check"><input type="checkbox" data-pinc="${i}" ${r.include ? 'checked' : ''}> ${r.type === 'income' ? 'دخل' : 'مصروف'}${r.bank ? ' · ' + esc(r.bank) : ''}</label>
          <span class="num" style="font-size:18px;${r.type === 'income' ? 'color:var(--income)' : ''}">${r.type === 'income' ? '+' : ''}${fmt(r.amount)} <small class="muted">${esc(r.currency === 'SAR' ? 'ر.س' : r.currency)}</small></span></div>
        ${r.dup ? '<div class="warnline">⚠ هذه الرسالة مسجلة مسبقاً — لن تُحفظ مرتين إلا إذا فعّلتها</div>' : ''}
        ${r.warnings.map((w) => `<div class="warnline">⚠ ${esc(w)}</div>`).join('')}
        <div class="row2">
          <div class="field"><label for="p-m-${i}">المتجر</label><input id="p-m-${i}" type="text" dir="auto" data-pf="merchant" data-pi="${i}" value="${esc(r.merchant)}"></div>
          <div class="field"><label for="p-a-${i}">المبلغ (ر.س)</label><input id="p-a-${i}" type="text" inputmode="decimal" data-pf="amount" data-pi="${i}" value="${esc(r.amount)}"></div>
        </div>
        ${r.type === 'expense' ? `<div class="field"><label for="p-l-${i}">البند</label>${lineSelect(k, `id="p-l-${i}" data-pf="line" data-pi="${i}"`)}</div>` : ''}
        <div class="raw" dir="auto">${esc(r.raw)}</div>
      </div>`;
    }).join('')}
    ${n ? `<button class="btn block" data-act="save-parsed">حفظ ${fmt(n, 0)} ${n === 1 ? 'عملية' : 'عمليات'}</button>` : ''}</div>`;
  }

  // ----- plan (reports) -----
  function renderPlan(el) {
    const p = periodAt(state.offset);
    const list = inPeriod(p);
    const tt = totals(list);
    const base = baseIncome(tt);
    const pt = planTotal();
    const merchants = {};
    list.filter((t) => t.type === 'expense' && inBudget(t)).forEach((t) => {
      const k = t.merchant || lineName(lineOf(t)) || '—';
      const m = (merchants[k] = merchants[k] || { n: 0, v: 0 }); m.n++; m.v += t.amount;
    });
    const top = Object.entries(merchants).sort((a, b) => b[1].v - a[1].v).slice(0, 8);
    const bar = (a, pl) => { const r = pl ? a / pl : a ? 2 : 0; return `<span class="bar"><i class="${r > 1 ? 'bad' : r >= 0.8 ? 'warn' : ''}" style="width:${Math.min(100, r * 100).toFixed(1)}%"></i></span>`; };
    const savBySec = {};
    list.filter((t) => t.type === 'expense' && !inBudget(t)).forEach((t) => { const k = lineOf(t); const s = k ? LINE()[k].s : 'بدون بند'; savBySec[s] = (savBySec[s] || 0) + t.amount; });
    const secRows = sections().map((sec) => {
      const ls = state.profile.lines.filter((l) => l.s === sec).map((l) => ({ l, p: planOf(l), a: tt.byLine[l.k] || 0 })).filter((x) => x.p || x.a);
      return { sec, ls, p: ls.reduce((a, x) => a + x.p, 0), a: ls.reduce((a, x) => a + x.a, 0) };
    }).filter((x) => x.ls.length || savBySec[x.sec]);
    const egpSec = (x) => x.ls.some((y) => y.l.cur === 'EGP');
    el.innerHTML = `${periodBar()}
    <div class="card"><h2>ملخص الشهر</h2>
      <div class="kv">
        <div><div class="small muted">${tt.income ? 'الدخل المستلم' : 'الدخل المخطط'}</div><div class="num big-n" style="color:var(--income)">${moneyTxt(base, 0)}</div></div>
        <div><div class="small muted">المخطط للصرف</div><div class="num big-n">${moneyTxt(pt, 0)}</div></div>
        <div><div class="small muted">صرفت من الراتب</div><div class="num big-n">${moneyTxt(tt.spent, 0)}</div></div>
        <div><div class="small muted">${base - tt.spent >= 0 ? 'المتبقي' : 'العجز'}</div><div class="num big-n" style="color:${base - tt.spent >= 0 ? 'var(--good)' : 'var(--bad)'}">${moneyTxt(Math.abs(base - tt.spent), 0)}</div></div>
      </div>
      ${tt.savings ? `<div class="savings-note">💰 من المدخرات: <b>${moneyTxt(tt.savings, 0)}</b>${tt.savingsEgp ? ' (' + curTxt(tt.savingsEgp, 'EGP', 0) + ')' : ''} — لا تُخصم من الراتب. إجمالي الصرف ${moneyTxt(tt.spent + tt.savings, 0)}.</div>` : ''}
      ${tt.unassigned ? `<div class="banner warn small" style="margin-top:10px"><span>⚠ <b>${moneyTxt(tt.unassigned, 0)}</b> بدون بند.</span><button class="btn ghost" data-filter-line="__none" style="padding:6px 12px">توزيعها</button></div>` : ''}
    </div>
    <div class="card"><h2>الخطة مقابل الفعلي</h2>
      ${secRows.length ? secRows.map((x) => `<details class="sec" ${x.a > x.p ? 'open' : ''}><summary><span class="sec-t">${secIcon(x.sec)} ${esc(x.sec)}</span><span class="num ${x.a > x.p ? 'delta-up' : ''}">${fmt(x.a, 0)} / ${fmt(x.p, 0)}</span></summary>
        ${bar(x.a, x.p)}
        ${savBySec[x.sec] ? `<div class="small muted" style="margin:4px 0">+ ${moneyTxt(savBySec[x.sec], 0)} من المدخرات</div>` : ''}
        <div class="tbl"><table><thead><tr><th>البند</th><th class="n">المخطط</th><th class="n">الفعلي</th><th class="n">المتبقي</th></tr></thead><tbody>
        ${x.ls.map((y) => `<tr data-filter-line="${esc(y.l.k)}" class="clickable"><td>${esc(y.l.n)}${egpSec(x) && y.l.cur === 'EGP' ? `<div class="small muted">${curTxt(fromSar(y.p, 'EGP'), 'EGP', 0)} مخطط${y.a ? ' · ' + curTxt(fromSar(y.a, 'EGP'), 'EGP', 0) + ' فعلي' : ''}</div>` : ''}</td><td class="n">${fmt(y.p, 0)}</td><td class="n">${fmt(y.a, 0)}</td><td class="n ${y.p - y.a < 0 ? 'delta-up' : ''}">${fmt(y.p - y.a, 0)}</td></tr>`).join('')}
        </tbody></table></div></details>`).join('') : '<div class="empty">لا توجد بنود</div>'}
    </div>
    ${typeCard(tt, base)}
    <div class="card"><h2>الصرف التراكمي مقابل الخطة</h2><div class="chart" id="ch-cum"></div>
      <div class="legend"><span><i></i>صرفك الفعلي</span><span><i class="dash"></i>المخطط حتى ${moneyTxt(pt, 0)}</span></div></div>
    <div class="card"><h2>آخر ٦ أشهر</h2><div class="chart" id="ch-months"></div>
      <div class="legend"><span><i class="bar"></i>ضمن الخطة</span><span><i class="bad"></i>فوق الخطة</span><span><i class="dash"></i>المخطط</span></div></div>
    <div class="card"><h2>أكثر الجهات صرفاً</h2>
      ${top.length ? `<div class="tbl"><table><thead><tr><th>الجهة</th><th class="n">عدد</th><th class="n">المبلغ</th></tr></thead><tbody>
      ${top.map(([k, m]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(m.n, 0)}</td><td class="n">${fmt(m.v)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد بيانات</div>'}
    </div>`;
    drawCumulative($('#ch-cum'), p, list);
    drawMonths($('#ch-months'));
  }

  function typeCard(tt, base) {
    const T = PLAN_TARGETS;
    const rows = Object.keys(T).map((ty) => {
      const ls = state.profile.lines.filter((l) => l.t === ty);
      return { ty, target: T[ty] * base, p: ls.reduce((a, l) => a + planOf(l), 0), a: ls.reduce((a, l) => a + (tt.byLine[l.k] || 0), 0) };
    });
    const bad = (r) => ((r.ty === 'Needs' || r.ty === 'Wants') && r.a > r.target) || ((r.ty === 'Safe' || r.ty === 'Goals') && r.a < r.target);
    return `<div class="card"><h2>قاعدة التوزيع</h2>
      <div class="tbl"><table><thead><tr><th>النوع</th><th class="n">المستهدف</th><th class="n">المخطط</th><th class="n">الفعلي</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${TYPE_AR[r.ty]} <span class="small muted">${fmt(T[r.ty] * 100, 0)}٪</span></td><td class="n">${fmt(r.target, 0)}</td><td class="n">${fmt(r.p, 0)}</td><td class="n"><span class="${bad(r) ? 'delta-up' : 'delta-down'}">${fmt(r.a, 0)}</span> <span class="small muted">${base ? fmt((r.a / base) * 100, 0) + '٪' : ''}</span></td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin:8px 0 0">نفس النسب في ملفك. الأحمر: ضروريات أو كماليات فوق المستهدف، أو ادخار وأهداف أقل منه.</p></div>`;
  }

  // ----- charts -----
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
      tip.style.left = (tx - tip.offsetWidth / 2) + 'px'; tip.style.transform = 'translate(0,-100%)';
      tip.style.top = Math.max(0, h.y - 8) + 'px';
      if (cross) { cross.setAttribute('x1', xAt(best)); cross.setAttribute('x2', xAt(best)); cross.style.opacity = 1; }
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; if (cross) cross.style.opacity = 0; });
  }
  function drawCumulative(box, p, list) {
    const W = Math.max(260, box.clientWidth), H = 200, padT = 14, padB = 24, padL = 8, padR = 40;
    const budget = planTotal();
    const daily = new Array(p.days).fill(0);
    list.forEach((t) => {
      if (!inBudget(t)) return;
      const sign = t.type === 'expense' ? 1 : isRefund(t) ? -1 : 0;
      if (!sign) return;
      const i = Math.min(p.days - 1, Math.max(0, Math.floor((parseIso(t.date) - p.start) / 86400000)));
      daily[i] += sign * t.amount;
    });
    const el2 = elapsed(p);
    const lastIdx = el2.current ? el2.daysGone - 1 : el2.future ? -1 : p.days - 1;
    const cum = []; let s = 0;
    for (let i = 0; i <= lastIdx; i++) { s += daily[i]; cum.push(s); }
    const ymax = niceMax(Math.max(budget, s) * 1.05);
    // RTL: day 1 on the right, time flows leftwards like the page.
    const x = (i) => W - padR - (i / (p.days - 1)) * (W - padR - padL);
    const y = (v) => padT + (1 - Math.max(0, v) / ymax) * (H - padT - padB);
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
      return { y: y(cum[i]), text: `<b>${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>هذا اليوم: ${moneyTxt(daily[i])}<br>التراكمي: ${moneyTxt(cum[i], 0)}${budget ? '<br>المخطط حتى اليوم: ' + moneyTxt((budget / p.days) * (i + 1), 0) : ''}` };
    });
  }
  function drawMonths(box) {
    const W = Math.max(260, box.clientWidth), H = 190, padT = 18, padB = 24, padL = 8, padR = 40;
    const budget = planTotal();
    const data = [];
    for (let o = state.offset - 5; o <= state.offset; o++) { const p = periodAt(o); data.push({ p, v: Math.max(0, totals(inPeriod(p)).spent), cur: o === state.offset }); }
    const ymax = niceMax(Math.max(budget, ...data.map((d) => d.v)) * 1.08);
    const n = data.length, slot = (W - padL - padR) / n, bw = Math.min(38, slot * 0.56);
    const cx = (i) => W - padR - slot * (i + 0.5);
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
      if ((d.cur || over) && d.v) bars += `<text x="${cx(i)}" y="${top - 5}" text-anchor="middle" style="fill:var(--ink);font-size:10.5px">${over ? '⚠ ' : ''}${shortNum(d.v)}</text>`;
    });
    const bl = budget ? `<line x1="${padL}" x2="${W - padR}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>` : '';
    box.innerHTML = svgEl(W, H, `${g}${bars}<line class="base" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${bl}`);
    attachTip(box, n, cx, (i) => {
      const d = data[i], diff = budget ? d.v - budget : 0;
      return { y: y(d.v), text: `<b>${esc(periodLabel(d.p))}</b><br>المصروف: ${moneyTxt(d.v, 0)}${budget ? '<br>' + (diff > 0 ? 'فوق الخطة بـ ' : 'أقل من الخطة بـ ') + moneyTxt(Math.abs(diff), 0) : ''}` };
    });
  }

  // ----- settings ("المزيد") -----
  function walletBalance(w) {
    let b = w.open || 0;
    for (const t of realTxns()) {
      if (walletOf(t).id !== w.id) continue;
      const v = t.cur === w.cur ? t.orig ?? t.amount : fromSar(t.amount, w.cur);
      b += t.type === 'income' ? v : -v;
    }
    return b;
  }
  function renderSettings(el) {
    const pr = state.profile;
    const days = Array.from({ length: 28 }, (_, i) => i + 1);
    const nl = state.newLine;
    const TYPES = Object.keys(TYPE_AR);
    el.innerHTML = `
    <div class="card" style="display:grid;gap:12px"><h2 style="margin:0">الشهر والراتب</h2>
      <div class="row2">
        <div class="field"><label for="s-income">الراتب الشهري المخطط (ر.س)</label><input id="s-income" type="text" inputmode="decimal" value="${esc(pr.planIncome)}"></div>
        <div class="field"><label for="s-rate">سعر الريال بالجنيه</label><input id="s-rate" type="text" inputmode="decimal" value="${esc(rate())}"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="s-start">يبدأ الشهر يوم</label><select id="s-start">${days.map((d) => `<option value="${d}" ${d === startDay() ? 'selected' : ''}>${d === 1 ? '1 (بداية الشهر)' : d}</option>`).join('')}</select></div>
        <div class="field"><label for="s-early">الراتب المبكر</label><select id="s-early"><option value="on" ${pr.earlySalary !== false ? 'selected' : ''}>يُحسب للشهر التالي</option><option value="off" ${pr.earlySalary === false ? 'selected' : ''}>حسب تاريخه</option></select></div>
      </div>
      <p class="small muted" style="margin:0">الراتب الذي يصل في آخر 7 أيام من الشهر يُحسب للشهر التالي. ويمكنك نقل أي عملية لشهر آخر من شاشة تعديلها.</p>
      <div class="field"><span class="lbl">شكل الأرقام</span><div class="segs"><button class="seg" data-digits="latn" aria-pressed="${pr.digits !== 'arab'}">123</button><button class="seg" data-digits="arab" aria-pressed="${pr.digits === 'arab'}">١٢٣</button></div></div>
    </div>

    <details class="card" ${state.openSet === 'wallets' ? 'open' : ''} data-set="wallets"><summary>المحافظ ومصادر الفلوس</summary>
      <p class="small muted" style="margin-top:0">كل عملية تُدفع من محفظة. المحافظ «من الراتب» تُخصم من ميزانية الشهر، أما «لا تُخصم» مثل المدخرات فتُسجَّل في إجمالي صرفك فقط. اكتب الرصيد الافتتاحي ليظهر لك الرصيد الحالي.</p>
      <div class="wallets">${pr.wallets.map((w, i) => `<div class="wallet">
        <div class="row2"><div class="field"><label for="w-n-${i}">الاسم</label><input id="w-n-${i}" type="text" dir="auto" data-wallet="${i}" data-wf="n" value="${esc(w.n)}"></div>
          <div class="field"><label for="w-o-${i}">الرصيد الافتتاحي (${CUR_AR[w.cur]})</label><input id="w-o-${i}" type="text" inputmode="decimal" data-wallet="${i}" data-wf="open" value="${w.open ? esc(w.open) : ''}" placeholder="0"></div></div>
        <div class="row2"><div class="field"><label for="w-c-${i}">العملة</label><select id="w-c-${i}" data-wallet="${i}" data-wf="cur"><option value="SAR" ${w.cur === 'SAR' ? 'selected' : ''}>ريال</option><option value="EGP" ${w.cur === 'EGP' ? 'selected' : ''}>جنيه</option></select></div>
          <div class="field"><label for="w-b-${i}">من الراتب؟</label><select id="w-b-${i}" data-wallet="${i}" data-wf="budget"><option value="1" ${w.budget !== false ? 'selected' : ''}>نعم، تُخصم من الراتب</option><option value="0" ${w.budget === false ? 'selected' : ''}>لا تُخصم (مدخرات)</option></select></div></div>
        <div class="wallet-foot"><span>الرصيد الحالي: <b class="num">${curTxt(walletBalance(w), w.cur, 0)}</b></span>${w.id !== 'bank' ? `<button class="btn ghost small-btn" data-delwallet="${i}" style="color:var(--bad)">حذف</button>` : ''}</div>
      </div>`).join('')}</div>
      <button class="btn ghost" data-act="add-wallet">＋ محفظة جديدة</button>
    </details>

    <details class="card" ${state.openSet === 'lines' ? 'open' : ''} data-set="lines"><summary>البنود والخطة الشهرية</summary>
      <p class="small muted" style="margin-top:0">نفس بنود ملف الإكسيل. عدّل المبلغ المخطط لكل بند، وبنود مصر تُكتب بالجنيه وتتحول للريال تلقائياً. إجمالي الخطة الآن: <b>${moneyTxt(planTotal(), 0)}</b> من راتب ${moneyTxt(pr.planIncome || 0, 0)}.</p>
      <div class="btns" style="margin-bottom:10px"><button class="btn ghost" data-act="plan-suggest">اقترح الخطة من صرف الشهر السابق</button></div>
      ${sections().map((sec) => `<div class="secblock"><div class="sechead">${secIcon(sec)} ${esc(sec)} <span class="muted small">${fmt(state.profile.lines.filter((l) => l.s === sec).reduce((a, l) => a + planOf(l), 0), 0)} ر.س</span></div>
        ${state.profile.lines.map((l, i) => (l.s !== sec ? '' : `<div class="linerow">
          <input type="text" dir="auto" aria-label="اسم البند" data-line="${i}" data-lf="n" value="${esc(l.n)}">
          <select aria-label="النوع" data-line="${i}" data-lf="t">${TYPES.map((t) => `<option value="${t}" ${l.t === t ? 'selected' : ''}>${TYPE_AR[t]}</option>`).join('')}</select>
          <span class="planin"><input type="text" inputmode="decimal" aria-label="المخطط" data-line="${i}" data-lf="plan" value="${l.cur === 'EGP' ? (l.pe ? esc(l.pe) : '') : l.p ? esc(r2(l.p)) : ''}" placeholder="0"><span class="muted small">${CUR_AR[l.cur]}</span></span>
          ${state.confirmLine === i ? `<button class="btn danger small-btn" data-delline="${i}">تأكيد</button>` : `<button class="iconbtn sm" data-askdel="${i}" aria-label="حذف البند">✕</button>`}
        </div>`)).join('')}</div>`).join('')}
      <div class="newline">
        <div class="lbl" style="font-weight:600">＋ بند جديد</div>
        <div class="row2">
          <div class="field"><label for="nl-s">القسم</label><input id="nl-s" type="text" dir="auto" list="nl-secs" value="${esc(nl ? nl.s : '')}" placeholder="مثلاً: مصر"><datalist id="nl-secs">${sections().map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist></div>
          <div class="field"><label for="nl-n">اسم البند</label><input id="nl-n" type="text" dir="auto" value="${esc(nl ? nl.n : '')}" placeholder="مثلاً: مصاريف المدرسة"></div>
        </div>
        <div class="row2">
          <div class="field"><label for="nl-p">المبلغ المخطط</label><input id="nl-p" type="text" inputmode="decimal" placeholder="0"></div>
          <div class="field"><label for="nl-c">العملة / النوع</label><div class="row2 tight"><select id="nl-c"><option value="SAR">ريال</option><option value="EGP">جنيه</option></select><select id="nl-t">${TYPES.map((t) => `<option value="${t}">${TYPE_AR[t]}</option>`).join('')}</select></div></div>
        </div>
        <button class="btn" data-act="add-line">إضافة البند</button>
      </div>
    </details>

    ${Native ? `<div class="card" style="display:grid;gap:10px"><h2 style="margin:0">قراءة رسائل البنك تلقائياً</h2>
      ${nativeSmsOn() ? `<div class="pill good" style="justify-self:start">✓ مفعّلة</div>
      <p class="small muted" style="margin:0">يقرأ رسائل البنوك الجديدة كلما فتحت التطبيق.${pr.smsSyncedAt ? ' آخر مزامنة: ' + esc(fmtDate(new Date(pr.smsSyncedAt), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) : ''}</p>
      <div class="btns"><button class="btn" data-act="sms-sync">مزامنة الآن</button><button class="btn ghost" data-act="sms-resync">إعادة فحص آخر 3 أشهر</button></div>`
      : `<button class="btn" data-act="sms-enable" style="justify-self:start">تفعيل القراءة التلقائية</button>`}</div>` : `
    <details class="card"><summary>تسجيل رسائل البنك بسرعة</summary>
      <ol class="steps">
        <li><b>آيفون:</b> اضغط مطولاً على رسالة البنك ← نسخ ← افتح التطبيق ← ＋ ← «من رسالة البنك» ← الصق.</li>
        <li><b>أندرويد:</b> ثبّت <a href="https://aboubakrzakaria91-cloud.github.io/mizaniyati/mizaniyati.apk" style="color:var(--accent);font-weight:600">تطبيق الأندرويد</a> ليقرأ الرسائل تلقائياً.</li>
      </ol>
    </details>`}

    <div class="card" style="display:grid;gap:10px"><h2 style="margin:0">ملف الإكسيل والبيانات</h2>
      <p class="small muted" style="margin:0">«تصدير Excel» يعطيك ملفاً أعمدته من A إلى I بنفس ترتيب ورقة «الحركات» في ملفك، فتلصقه من الصف 6 ويتحدث «اجمالي الدفع الفعلي». الصرف من المدخرات يُصدَّر بنوع «مصروف من المدخرات» فلا يُخصم من الراتب في الإكسيل.</p>
      <div class="btns"><button class="btn" data-act="export" ${realTxns().length ? '' : 'disabled'}>تصدير Excel</button><button class="btn ghost" data-act="backup" ${realTxns().length ? '' : 'disabled'}>حفظ نسخة احتياطية</button>
        <label class="btn ghost" for="restore-file" style="cursor:pointer">استعادة نسخة</label><input id="restore-file" type="file" accept=".json,application/json" hidden></div>
      <div class="small muted">عدد العمليات: ${fmt(realTxns().length, 0)}${Native ? '' : ' · <a href="v1/" style="color:var(--accent)">النسخة السابقة (الإصدار 1)</a>'}</div>
      <div>${state.confirmClear ? `<button class="btn danger" data-act="clear-yes">نعم، احذف كل العمليات</button> <button class="btn ghost" data-act="clear-no">إلغاء</button>` : `<button class="btn ghost" data-act="clear" ${realTxns().length ? '' : 'disabled'} style="color:var(--bad)">حذف كل العمليات</button>`}</div>
    </div>`;
  }

  // ----- edit sheet -----
  function bmSelect(t, attrs) {
    const own = periodOfDate(t.date), prev = periodOfDate(iso(new Date(own.start.getTime() - 86400000))), next = periodOfDate(own.e);
    const opt = (v, label) => `<option value="${v}" ${(t.bm || '') === v ? 'selected' : ''}>${esc(label)}</option>`;
    return `<select ${attrs}>${opt('', 'حسب التاريخ (' + periodLabel(own) + ')')}${opt(periodKey(next), 'الشهر التالي: ' + periodLabel(next))}${opt(periodKey(prev), 'الشهر السابق: ' + periodLabel(prev))}</select>`;
  }
  function renderSheet() {
    const host = $('#sheet');
    const e = state.editing;
    if (!e) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const t = e.t;
    const k = t.line !== undefined ? t.line : lineOf(t);
    host.innerHTML = `<div class="sheet-bg" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-title">
      <h3><span id="sh-title">${t.sample ? 'عملية توضيحية' : 'تعديل العملية'}</span><button class="iconbtn" data-act="close-sheet" aria-label="إغلاق">✕</button></h3>
      ${t.sample ? '<div class="banner sample small">هذه عملية توضيحية ولا يمكن تعديلها.</div>' : ''}
      <div class="segs"><button class="seg" data-etype="expense" aria-pressed="${t.type === 'expense'}">مصروف</button><button class="seg" data-etype="income" aria-pressed="${t.type === 'income'}">دخل</button></div>
      <div class="row2">
        <div class="field"><label for="e-amount">المبلغ</label><input id="e-amount" type="text" inputmode="decimal" value="${esc(t.cur === 'EGP' ? t.orig : t.amount)}"></div>
        <div class="field"><label for="e-cur">العملة</label><select id="e-cur"><option value="SAR" ${t.cur !== 'EGP' ? 'selected' : ''}>ريال</option><option value="EGP" ${t.cur === 'EGP' ? 'selected' : ''}>جنيه</option></select></div>
      </div>
      ${t.type === 'expense' ? `<div class="field"><label for="e-line">البند</label>${lineSelect(k, 'id="e-line"')}</div>`
        : `<div class="field"><label for="e-inc">نوع الدخل</label><select id="e-inc">${INC_CATS.map((c) => `<option value="${c.id}" ${t.cat === c.id ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>
           ${t.cat === 'refund' ? `<div class="field"><label for="e-line">يُخصم من بند</label>${lineSelect(k, 'id="e-line"')}</div>` : ''}`}
      <div class="row2">
        <div class="field"><label for="e-wallet">${t.type === 'income' ? 'استلمته في' : 'دفعت من'}</label><select id="e-wallet">${state.profile.wallets.map((w) => `<option value="${esc(w.id)}" ${walletOf(t).id === w.id ? 'selected' : ''}>${esc(w.n)}</option>`).join('')}</select></div>
        <div class="field"><label for="e-method">طريقة الدفع</label><select id="e-method">${(METHODS.includes(t.method || '') ? METHODS : [t.method, ...METHODS]).map((m) => `<option value="${esc(m)}" ${m === (t.method || '') ? 'selected' : ''}>${esc(m || '—')}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="e-merchant">المتجر أو الوصف</label><input id="e-merchant" type="text" dir="auto" value="${esc(t.merchant)}"></div>
      <div class="row2">
        <div class="field"><label for="e-date">التاريخ والوقت</label><input id="e-date" type="datetime-local" value="${esc(t.date)}"></div>
        <div class="field"><label for="e-bm">يُحسب في شهر</label>${bmSelect(t, 'id="e-bm"')}</div>
      </div>
      <div class="field"><label for="e-note">ملاحظة</label><input id="e-note" type="text" dir="auto" value="${esc(t.note || '')}"></div>
      ${t.merchant ? `<label class="check"><input type="checkbox" id="e-remember"> طبّق نفس البند على كل عمليات «${esc(t.merchant)}»</label>` : ''}
      ${t.raw ? `<details><summary class="small muted">نص الرسالة الأصلية</summary><div class="small muted" dir="auto" style="white-space:pre-line">${esc(t.raw)}</div></details>` : ''}
      ${t.sample ? '' : `<div class="btns"><button class="btn" data-act="save-edit" style="flex:1">حفظ</button>
        ${e.confirmDel ? '<button class="btn danger" data-act="del-yes">تأكيد الحذف</button>' : '<button class="btn ghost" data-act="del" style="color:var(--bad)">حذف</button>'}</div>`}
    </div></div>`;
  }
  function readEditForm() {
    const t = state.editing.t;
    const amt = toNum($('#e-amount').value), cur = $('#e-cur').value;
    return { ...t, cur, orig: isNaN(amt) ? t.orig : amt, amount: isNaN(amt) ? t.amount : r2(toSar(amt, cur)), rate: cur === 'EGP' ? rate() : undefined,
      line: $('#e-line') ? $('#e-line').value : t.line, cat: $('#e-inc') ? $('#e-inc').value : t.cat, wallet: $('#e-wallet').value, method: $('#e-method').value,
      merchant: $('#e-merchant').value, date: $('#e-date').value || t.date, bm: $('#e-bm').value, note: $('#e-note').value };
  }

  // ---------- actions ----------
  function readParsedField(el) {
    const i = +el.dataset.pi, f = el.dataset.pf, r = state.parsed[i]; if (!r) return;
    if (f === 'amount') { const n = toNum(el.value); if (!isNaN(n)) r.amount = n; }
    else r[f] = el.value;
  }
  function doParse() {
    const msgs = splitMessages($('#sms-in').value);
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
    const list = state.parsed.filter((r) => r.ok && r.include && r.amount > 0).map((r) => smsToTxn({ ...r, amount: r2(r.amount) }, r.line !== undefined ? { line: r.line } : {}));
    if (!list.length) return;
    addTxns(list);
    state.parsed = []; if ($('#sms-in')) $('#sms-in').value = '';
    toast('تم حفظ ' + fmt(list.length, 0) + (list.length === 1 ? ' عملية' : ' عمليات'));
    state.tab = 'home'; state.offset = 0; render();
  }
  function saveDraft() {
    readDraft();
    const d = state.draft, n = toNum(d.orig);
    if (!(n > 0)) { toast('اكتب المبلغ'); $('#d-amount').focus(); return; }
    const amount = r2(toSar(n, d.cur));
    const cat = d.type === 'income' ? d.inc : categorize(d.merchant, d.note, 'expense', state.profile.rules);
    const t = { id: uid(), type: d.type, amount, cur: d.cur, orig: n, rate: d.cur === 'EGP' ? rate() : undefined, cat, merchant: d.merchant.trim(),
      date: d.date || iso(new Date()), wallet: d.wallet, method: '', note: d.note.trim(), source: 'manual' };
    if (d.type === 'expense') t.line = d.line || suggestLine(d) || '';
    addTxns([t]);
    const w = walletById(d.wallet);
    toast('تم الحفظ' + (d.cur === 'EGP' ? ' · ' + moneyTxt(amount) : '') + (w.budget === false ? ' · من ' + w.n : ''));
    state.draft = newDraft(d.cur === 'EGP' ? 'egp' : d.type === 'income' ? 'income' : '');
    state.tab = 'home'; state.offset = 0; render();
  }
  function saveEdit() {
    const t = readEditForm();
    if (!(t.amount > 0)) { toast('المبلغ غير صحيح'); return; }
    if ($('#e-remember') && $('#e-remember').checked && t.merchant) {
      const nm = normalizeMerchant(t.merchant);
      // Generic names (a bare «حوالة») would capture every transfer, so no rule is saved for them.
      if (!/^(حوال[ةه]|تحويل|transfer|تسوق|شراء|سحب)$/.test(nm)) setProfile({ lineRules: { ...(state.profile.lineRules || {}), [nm]: t.line || '' } });
    }
    updateTxn(t.id, { type: t.type, amount: t.amount, cur: t.cur, orig: t.orig, rate: t.rate, line: t.line, cat: t.cat, wallet: t.wallet, method: t.method, merchant: t.merchant.trim(), date: t.date, bm: t.bm, note: t.note.trim() });
    state.editing = null; toast('تم الحفظ'); render();
  }

  async function exportCsv() {
    const rows = [['التاريخ', 'النوع', 'المبلغ', 'البند', 'الجهة', 'طريقة الدفع', 'المصدر', 'ملاحظة', 'البند في الميزانية', 'المحفظة', 'العملة', 'المبلغ بالعملة', 'سعر التحويل']];
    realTxns().sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((t) => {
      const w = walletOf(t), k = lineOf(t);
      const type = t.type === 'income' ? 'دخل' : w.budget === false ? 'مصروف من المدخرات' : 'مصروف';
      rows.push([t.date.replace('T', ' '), type, t.amount, t.type === 'income' ? (CAT[t.cat] || CAT.income_other).name : lineName(k), t.merchant, t.method || w.n, t.source === 'sms' ? 'رسالة' : 'يدوي', t.note || '', k, w.n, CUR_AR[t.cur || 'SAR'], t.orig ?? t.amount, t.cur === 'EGP' ? t.rate || rate() : '']);
    });
    const csv = '﻿' + rows.map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    await offerFile('mizaniyati-' + iso(new Date()).slice(0, 10) + '.csv', csv, 'text/csv');
  }
  async function offerFile(filename, text, type) {
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (dl) { try { await dl.save({ filename, data: text }); } catch (e) { if (e && e.code !== 'declined') toast('تعذّر حفظ الملف'); } return; }
    if (Native && Native.saveFile) { try { toast(Native.saveFile(filename, text)); } catch (e) { toast('تعذّر حفظ الملف'); } return; }
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
    const data = JSON.stringify({ app: 'mizaniyati', v: 2, at: new Date().toISOString(), profile: state.profile, months: state.months });
    offerFile('mizaniyati-backup-' + iso(new Date()).slice(0, 10) + '.json', data, 'application/json');
  }
  function importBackup(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(rd.result);
        if (!d || d.app !== 'mizaniyati' || typeof d.months !== 'object') throw new Error('bad');
        const have = new Set(realTxns().map((t) => t.id));
        const list = Object.values(d.months).flat().filter((t) => t && t.id && !have.has(t.id) && t.date && t.amount > 0);
        // A v2 backup carries the plan and wallets; a v1 backup only adds its transactions.
        if (d.profile && d.v >= 2) setProfile(ensureProfile(d.profile));
        if (list.length) addTxns(list);
        toast('تمت استعادة ' + fmt(list.length, 0) + ' عملية');
        render();
      } catch (e) { toast('الملف غير صالح — اختر ملف نسخة احتياطية من ميزانيتي'); }
    };
    rd.readAsText(file);
  }
  function clearAll() {
    const keys = Object.keys(state.months);
    state.months = {};
    keys.forEach((k) => Store.saveMonth(k));
    if (state.mode !== 'cloud') Store.saveLocal();
    state.confirmClear = false; toast('تم حذف كل العمليات'); render();
  }
  function updateLine(i, patch) {
    const lines = state.profile.lines.slice();
    lines[i] = { ...lines[i], ...patch };
    setProfile({ lines });
  }
  function addLine() {
    const s = $('#nl-s').value.trim(), n = $('#nl-n').value.trim();
    if (!s || !n) { toast('اكتب القسم واسم البند'); return; }
    const cur = $('#nl-c').value, t = $('#nl-t').value, amt = toNum($('#nl-p').value) || 0;
    let k = s + ' - ' + n, i = 2;
    while (LINE()[k]) k = s + ' - ' + n + ' ' + i++;
    const line = { k, s, n, t, cur, p: cur === 'SAR' ? amt : 0, ...(cur === 'EGP' ? { pe: amt } : {}) };
    // Keep sections together: insert after the last line of the same section.
    const lines = state.profile.lines.slice();
    let at = -1; lines.forEach((l, j) => { if (l.s === s) at = j; });
    if (at < 0) lines.push(line); else lines.splice(at + 1, 0, line);
    setProfile({ lines }); state.newLine = null; state.openSet = 'lines';
    toast('تمت إضافة «' + n + '»'); render();
  }

  function goFilter(line) {
    state.tab = 'txns'; state.txFilter = { q: '', type: '', line, wallet: '' }; render(); window.scrollTo(0, 0);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-go],[data-act],[data-edit],[data-ftype],[data-addmode],[data-dtype],[data-dcur],[data-dsec],[data-dline],[data-dinc],[data-dwallet],[data-ddate],[data-quick],[data-digits],[data-etype],[data-filter-line],[data-delwallet],[data-askdel],[data-delline]');
    if (!t) return;
    const d = t.dataset;
    if (d.go) { if (state.tab === 'add') readDraft(); state.tab = d.go; state.editing = null; render(); window.scrollTo(0, 0); return; }
    if (d.quick) { state.draft = newDraft(d.quick === 'egp' ? 'egp' : d.quick); state.addMode = 'manual'; state.tab = 'add'; render(); window.scrollTo(0, 0); setTimeout(() => { const a = $('#d-amount'); if (a) a.focus(); }, 50); return; }
    if (d.filterLine !== undefined) { goFilter(d.filterLine); return; }
    if (d.edit) { const tx = allTxns().find((x) => x.id === d.edit); if (tx) { state.editing = { t: { ...tx, cur: tx.cur || 'SAR', orig: tx.orig ?? tx.amount } }; renderSheet(); } return; }
    if (d.ftype !== undefined) { state.txFilter.type = d.ftype; render(); return; }
    if (d.addmode) { readDraft(); state.addMode = d.addmode; render(); return; }
    const draft = state.draft;
    if (d.dtype) { readDraft(); draft.type = d.dtype; draft.line = ''; render(); return; }
    if (d.dcur) { readDraft(); draft.cur = d.dcur; render(); return; }
    if (d.dsec) { readDraft(); draft.sec = d.dsec; render(); return; }
    if (d.dline) { readDraft(); draft.line = draft.line === d.dline ? '' : d.dline; if (draft.line) draft.sec = LINE()[draft.line].s; render(); return; }
    if (d.dinc) { readDraft(); draft.inc = d.dinc; render(); return; }
    if (d.dwallet) { readDraft(); draft.wallet = d.dwallet; const w = walletById(d.dwallet); if (w.cur !== draft.cur && !toNum(draft.orig)) draft.cur = w.cur; render(); return; }
    if (d.ddate !== undefined) { readDraft(); const x = new Date(); x.setDate(x.getDate() - +d.ddate); draft.date = iso(x); render(); return; }
    if (d.digits) { setProfile({ digits: d.digits }); render(); return; }
    if (d.delwallet !== undefined) {
      const w = state.profile.wallets[+d.delwallet];
      if (realTxns().some((x) => walletOf(x).id === w.id)) { toast('لا يمكن حذف محفظة عليها عمليات'); return; }
      setProfile({ wallets: state.profile.wallets.filter((_, i) => i !== +d.delwallet) }); state.openSet = 'wallets'; render(); return;
    }
    if (d.askdel !== undefined) { state.confirmLine = +d.askdel; state.openSet = 'lines'; render(); return; }
    if (d.delline !== undefined) {
      const l = state.profile.lines[+d.delline];
      setProfile({ lines: state.profile.lines.filter((_, i) => i !== +d.delline) }); state.confirmLine = null; state.openSet = 'lines';
      toast('حُذف «' + l.n + '» — عملياته صارت بدون بند'); render(); return;
    }
    if (d.etype) {
      const e = state.editing; e.t = { ...readEditForm(), type: d.etype };
      e.t.cat = d.etype === 'income' ? (CAT[e.t.cat] && CAT[e.t.cat].kind === 'income' ? e.t.cat : 'income_other') : (CAT[e.t.cat] && CAT[e.t.cat].kind === 'expense' ? e.t.cat : 'other');
      renderSheet(); return;
    }
    switch (d.act) {
      case 'prev': state.offset--; render(); break;
      case 'next': if (state.offset < 3) { state.offset++; render(); } break;
      case 'today': state.offset = 0; render(); break;
      case 'dismiss-migrated': state.migrated = false; render(); break;
      case 'parse': doParse(); break;
      case 'example': $('#sms-in').value = SMS_EXAMPLE; doParse(); break;
      case 'clear-sms': $('#sms-in').value = ''; state.parsed = []; render(); break;
      case 'save-parsed': saveParsed(); break;
      case 'save-draft': saveDraft(); break;
      case 'close-sheet': if (ev.target === t) { state.editing = null; renderSheet(); } break;
      case 'save-edit': saveEdit(); break;
      case 'del': state.editing.confirmDel = true; renderSheet(); break;
      case 'del-yes': deleteTxn(state.editing.t.id); state.editing = null; toast('تم حذف العملية'); render(); break;
      case 'export': exportCsv(); break;
      case 'backup': exportBackup(); break;
      case 'clear': state.confirmClear = true; render(); break;
      case 'clear-no': state.confirmClear = false; render(); break;
      case 'clear-yes': clearAll(); break;
      case 'add-wallet': setProfile({ wallets: [...state.profile.wallets, { id: 'w' + uid(), n: 'محفظة جديدة', cur: 'SAR', open: 0, budget: true }] }); state.openSet = 'wallets'; render(); break;
      case 'add-line': addLine(); break;
      case 'plan-suggest': {
        const tt = totals(inPeriod(periodAt(state.offset - 1)));
        let n = 0;
        const lines = state.profile.lines.map((l) => {
          const a = tt.byLine[l.k] || 0;
          if (a <= planOf(l)) return l;
          n++;
          const v = Math.ceil(fromSar(a, l.cur) / 50) * 50;
          return l.cur === 'EGP' ? { ...l, pe: v } : { ...l, p: v };
        });
        setProfile({ lines }); state.openSet = 'lines';
        toast(n ? 'رُفعت ' + fmt(n, 0) + ' بنود حسب صرف الشهر السابق' : 'الخطة تغطي صرف الشهر السابق'); render(); break;
      }
      case 'sms-enable': if (Native) Native.requestSmsPermission(); break;
      case 'sms-sync': { const n = syncSms(); if (!n) toast('لا توجد رسائل بنك جديدة'); break; }
      case 'sms-resync': { const n = syncSms(periodAt(-2).start.getTime()); if (!n) toast('كل رسائل آخر 3 أشهر مسجلة مسبقاً'); break; }
    }
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'tx-q') { state.txFilter.q = el.value; render(); return; }
    if (el.id === 'd-amount' && state.draft) { state.draft.orig = el.value; const c = $('#d-conv'); if (c) c.textContent = convLine(state.draft); return; }
    if (el.id === 'd-merchant' && state.draft) {
      state.draft.merchant = el.value;
      const box = $('#d-sug'); if (!box) return;
      const sug = suggestLine(state.draft);
      box.innerHTML = sug && !state.draft.line ? `<button type="button" class="chip sug" data-dline="${esc(sug)}">✨ اقتراح: ${esc(LINE()[sug].s)} › ${esc(LINE()[sug].n)}</button>` : '';
      return;
    }
    if (el.dataset.pf) { readParsedField(el); return; }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'restore-file') { if (el.files && el.files[0]) importBackup(el.files[0]); el.value = ''; return; }
    if (el.id === 'tx-line') { state.txFilter.line = el.value; render(); return; }
    if (el.id === 'tx-wallet') { state.txFilter.wallet = el.value; render(); return; }
    if (el.dataset.pinc !== undefined) { const r = state.parsed[+el.dataset.pinc]; r.include = el.checked; render(); return; }
    if (el.dataset.pf) { readParsedField(el); return; }
    if (el.id === 'e-cur' && state.editing) { state.editing.t = readEditForm(); renderSheet(); return; }
    if (el.id === 'e-inc' && state.editing) { state.editing.t = readEditForm(); renderSheet(); return; }
    if (el.id === 's-income') { const n = toNum(el.value); if (n > 0) { setProfile({ planIncome: r2(n) }); toast('تم تحديث الراتب المخطط'); } return; }
    if (el.id === 's-rate') { const n = toNum(el.value); if (n > 0) { setProfile({ rates: { ...(state.profile.rates || {}), EGP: n } }); toast('تم تحديث سعر الجنيه'); } return; }
    if (el.id === 's-early') { setProfile({ earlySalary: el.value === 'on' }); toast('تم الحفظ'); return; }
    if (el.id === 's-start') { setProfile({ startDay: +el.value }); state.offset = 0; sampleCache = null; toast('تم تحديث بداية الشهر'); return; }
    if (el.dataset.wallet !== undefined) {
      const i = +el.dataset.wallet, f = el.dataset.wf, ws = state.profile.wallets.slice(), w = { ...ws[i] };
      if (f === 'n') w.n = el.value.trim() || w.n;
      if (f === 'open') w.open = toNum(el.value) || 0;
      if (f === 'cur') w.cur = el.value;
      if (f === 'budget') w.budget = el.value === '1';
      ws[i] = w; setProfile({ wallets: ws }); state.openSet = 'wallets'; if (f !== 'n') render(); return;
    }
    if (el.dataset.line !== undefined) {
      const i = +el.dataset.line, f = el.dataset.lf, l = state.profile.lines[i];
      if (f === 'n') { if (el.value.trim()) updateLine(i, { n: el.value.trim() }); return; }
      if (f === 't') { updateLine(i, { t: el.value }); return; }
      if (f === 'plan') { const v = Math.max(0, toNum(el.value) || 0); updateLine(i, l.cur === 'EGP' ? { pe: v } : { p: v }); state.openSet = 'lines'; render(); return; }
    }
  });
  document.addEventListener('toggle', (ev) => { const d = ev.target; if (d.dataset && d.dataset.set) state.openSet = d.open ? d.dataset.set : state.openSet === d.dataset.set ? null : state.openSet; }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.editing) { state.editing = null; renderSheet(); } });
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.tab === 'reports') render(); }, 150); });

  // Android share sheet: a bank SMS shared to the installed web app arrives as ?text=…
  let sharedText = '';
  try {
    const qs = new URLSearchParams(location.search);
    sharedText = [qs.get('title'), qs.get('text')].filter(Boolean).join('\n').trim();
    if (sharedText) history.replaceState(null, '', location.pathname);
  } catch (e) { sharedText = ''; }
  render();
  Store.init().then(() => {
    if (nativeSmsOn()) syncSms();
    if (!sharedText) return;
    state.tab = 'add'; state.addMode = 'sms'; render();
    $('#sms-in').value = sharedText; doParse();
  });
})();
