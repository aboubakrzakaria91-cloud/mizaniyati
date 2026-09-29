// ===== محلل رسائل البنوك + التصنيف التلقائي =====
// Pure functions: no DOM. Tested with node (test/parser.test.js).

const CATEGORIES = [
  // id, Arabic name, icon glyph, kind
  { id: 'groceries', name: 'بقالة وتموينات', icon: '🛒', kind: 'expense' },
  { id: 'restaurants', name: 'مطاعم', icon: '🍽', kind: 'expense' },
  { id: 'coffee', name: 'قهوة وكافيهات', icon: '☕', kind: 'expense' },
  { id: 'delivery', name: 'تطبيقات توصيل', icon: '🛵', kind: 'expense' },
  { id: 'fuel', name: 'وقود', icon: '⛽', kind: 'expense' },
  { id: 'transport', name: 'مواصلات وتنقل', icon: '🚕', kind: 'expense' },
  { id: 'car', name: 'سيارة وصيانة', icon: '🔧', kind: 'expense' },
  { id: 'shopping', name: 'تسوق', icon: '🛍', kind: 'expense' },
  { id: 'bills', name: 'فواتير واتصالات', icon: '💡', kind: 'expense' },
  { id: 'subscriptions', name: 'اشتراكات رقمية', icon: '📺', kind: 'expense' },
  { id: 'housing', name: 'سكن وإيجار', icon: '🏠', kind: 'expense' },
  { id: 'health', name: 'صحة وصيدلية', icon: '💊', kind: 'expense' },
  { id: 'personal', name: 'عناية شخصية', icon: '💈', kind: 'expense' },
  { id: 'education', name: 'تعليم', icon: '🎓', kind: 'expense' },
  { id: 'entertainment', name: 'ترفيه', icon: '🎬', kind: 'expense' },
  { id: 'travel', name: 'سفر وفنادق', icon: '✈', kind: 'expense' },
  { id: 'government', name: 'رسوم حكومية', icon: '🏛', kind: 'expense' },
  { id: 'insurance', name: 'تأمين', icon: '🛡', kind: 'expense' },
  { id: 'family', name: 'عائلة ومنزل', icon: '👨‍👩‍👧', kind: 'expense' },
  { id: 'charity', name: 'صدقات وزكاة', icon: '🤲', kind: 'expense' },
  { id: 'cash', name: 'سحب نقدي', icon: '💵', kind: 'expense' },
  { id: 'transfers', name: 'حوالات صادرة', icon: '↗', kind: 'expense' },
  { id: 'other', name: 'أخرى', icon: '•', kind: 'expense' },
  { id: 'salary', name: 'راتب', icon: '💼', kind: 'income' },
  { id: 'transfer_in', name: 'حوالة واردة', icon: '↙', kind: 'income' },
  { id: 'refund', name: 'استرداد', icon: '↩', kind: 'income' },
  { id: 'income_other', name: 'دخل آخر', icon: '＋', kind: 'income' },
];

// Keywords are matched against the lower-cased merchant (and the whole SMS as fallback).
const CATEGORY_KEYWORDS = {
  groceries: ['panda', 'بنده', 'بندة', 'danube', 'الدانوب', 'othaim', 'العثيمين', 'tamimi', 'التميمي', 'carrefour', 'كارفور', 'lulu', 'لولو', 'farm superstore', 'المزرعة', 'nesto', 'نستو', 'hyper', 'هايبر', 'supermarket', 'سوبرماركت', 'سوبر ماركت', 'grocery', 'بقالة', 'تموينات', 'manuel', 'مانويل', 'bin dawood', 'بن داود', 'ninja', 'نينجا', 'nana', 'نعناع', 'tamimi markets', 'meat', 'ملحمة', 'مخبز', 'bakery', 'خضار'],
  restaurants: ['restaurant', 'مطعم', 'مطاعم', 'albaik', 'al baik', 'البيك', 'mcdonald', 'ماكدونالدز', 'kfc', 'كنتاكي', 'burger', 'برجر', 'بيرجر', 'pizza', 'بيتزا', 'herfy', 'هرفي', 'kudu', 'كودو', 'shawarma', 'شاورما', 'shawarmer', 'شاورمر', 'maestro', 'مايسترو', 'subway', 'صب واي', 'hardee', 'هارديز', 'grill', 'مشويات', 'mandi', 'مندي', 'مطبخ', 'kitchen', 'broast', 'بروست', 'domino', 'دومينوز', 'papa john', 'popeyes', 'بوبايز', 'texas', 'فوال', 'bistro', 'diner', 'steak', 'sushi'],
  coffee: ['coffee', 'قهوة', 'كوفي', 'cafe', 'café', 'كافيه', 'كافي', 'starbucks', 'ستاربكس', 'barns', 'بارنز', 'dunkin', 'دانكن', 'tim hortons', 'تيم هورتنز', 'half million', 'هاف مليون', 'dose', 'دوز', 'roaster', 'محمصة', 'كيف', 'kayf', 'brew', 'espresso', 'dr.cafe', 'دكتور كيف', 'overdose', 'اوفردوز', 'java'],
  delivery: ['jahez', 'جاهز', 'hungerstation', 'هنقرستيشن', 'هنقر', 'keeta', 'كيتا', 'toyou', 'تويو', 'mrsool', 'مرسول', 'the chefz', 'ذا شفز', 'careem food', 'lugmety', 'لقمتي', 'shgardi', 'شقردي', 'talabat', 'طلبات'],
  fuel: ['aldrees', 'al drees', 'الدريس', 'sasco', 'ساسكو', 'naft', 'نفط', 'fuel', 'وقود', 'بنزين', 'petrol', 'gas station', 'محطة', 'adnoc', 'أدنوك', 'ادنوك', 'almaha', 'المها', 'petromin', 'بترومين', 'car fuel', 'mobil'],
  transport: ['uber', 'أوبر', 'اوبر', 'careem', 'كريم', 'bolt', 'بولت', 'jeeny', 'جيني', 'metro', 'مترو', 'parking', 'مواقف', 'saptco', 'سابتكو', 'darb', 'درب', 'train', 'قطار', 'sar rail', 'haramain', 'الحرمين', 'taxi', 'تاكسي', 'ekar', 'إيكار', 'yelo', 'يلو', 'theeb', 'ذيب', 'budget rent', 'تأجير سيارات'],
  car: ['car wash', 'مغسلة سيارات', 'مغسلة', 'workshop', 'ورشة', 'tire', 'tyre', 'كفرات', 'إطارات', 'اطارات', 'oil change', 'تغيير زيت', 'زيوت', 'auto', 'قطع غيار', 'spare parts', 'fahas', 'فحص دوري', 'mvpi', 'najm', 'نجم'],
  shopping: ['amazon', 'أمازون', 'امازون', 'noon', 'نون', 'shein', 'شي ان', 'شي إن', 'namshi', 'نمشي', 'ikea', 'ايكيا', 'إيكيا', 'centrepoint', 'سنتربوينت', 'h&m', 'zara', 'زارا', 'extra', 'اكسترا', 'إكسترا', 'jarir', 'جرير', 'mall', 'مول', 'saco', 'ساكو', 'max', 'ماكس', 'home centre', 'هوم سنتر', 'splash', 'سبلاش', 'nike', 'adidas', 'apple store', 'aliexpress', 'trendyol', 'ترينديول', 'store', 'متجر', 'boutique', 'بوتيك', 'عطور', 'perfume', 'abdul samad', 'عبدالصمد', 'arabian oud', 'العربية للعود', 'salla', 'سلة', 'zid', 'زد', 'tabby', 'تابي', 'tamara', 'تمارا'],
  bills: ['stc', 'اس تي سي', 'زين', 'zain', 'mobily', 'موبايلي', 'salam', 'سلام', 'virgin', 'فيرجن', 'lebara', 'ليبارا', 'sec', 'الكهرباء', 'electricity', 'water', 'المياه', 'nwc', 'فاتورة', 'فواتير', 'sadad', 'سداد', 'bill', 'internet', 'انترنت', 'إنترنت', 'fiber', 'فايبر'],
  subscriptions: ['netflix', 'نتفلكس', 'نتفليكس', 'shahid', 'شاهد', 'spotify', 'سبوتيفاي', 'anghami', 'أنغامي', 'انغامي', 'osn', 'apple.com', 'itunes', 'icloud', 'google', 'youtube', 'يوتيوب', 'chatgpt', 'openai', 'claude', 'anthropic', 'disney', 'ديزني', 'starzplay', 'prime video', 'amazon prime', 'microsoft', 'adobe', 'canva', 'subscription', 'اشتراك', 'playstation plus', 'xbox', 'tod', 'ssc'],
  housing: ['rent', 'إيجار', 'ايجار', 'ejar', 'real estate', 'عقار', 'عقارات', 'housing', 'سكن', 'compound', 'كمباوند', 'maintenance', 'صيانة منزل', 'furniture', 'أثاث', 'اثاث'],
  health: ['pharmacy', 'صيدلية', 'صيدليات', 'nahdi', 'النهدي', 'aldawaa', 'al-dawaa', 'الدواء', 'whites', 'وايتس', 'hospital', 'مستشفى', 'clinic', 'عيادة', 'عيادات', 'medical', 'طبي', 'مجمع طبي', 'lab', 'مختبر', 'dental', 'أسنان', 'اسنان', 'optic', 'نظارات', 'magrabi', 'مغربي', 'sulaiman al habib', 'الحبيب', 'dallah', 'دله', 'mouwasat', 'المواساة', 'gym', 'جيم', 'fitness', 'fitness time', 'وقت اللياقة', 'نادي رياضي'],
  personal: ['salon', 'صالون', 'حلاق', 'حلاقة', 'barber', 'spa', 'سبا', 'laundry', 'مغسلة ملابس', 'غسيل', 'beauty', 'تجميل', 'cosmetic', 'nice one', 'نايس ون', 'sephora', 'سيفورا', 'faces', 'فيسز'],
  education: ['school', 'مدرسة', 'مدارس', 'university', 'جامعة', 'course', 'دورة', 'دورات', 'udemy', 'coursera', 'مكتبة', 'library', 'tuition', 'رسوم دراسية', 'academy', 'أكاديمية', 'اكاديمية', 'institute', 'معهد', 'kindergarten', 'روضة', 'حضانة', 'nursery'],
  entertainment: ['cinema', 'سينما', 'vox', 'ڤوكس', 'فوكس', 'muvi', 'موفي', 'amc', 'boulevard', 'بوليفارد', 'webook', 'ويبوك', 'playstation', 'steam', 'game', 'games', 'ألعاب', 'العاب', 'park', 'ملاهي', 'bowling', 'بولينج', 'riyadh season', 'موسم الرياض', 'ticket', 'تذاكر', 'تذكرة', 'event', 'فعالية', 'sparky', 'سباركيز', 'kidzania'],
  travel: ['saudia', 'السعودية للطيران', 'الخطوط السعودية', 'flynas', 'طيران ناس', 'ناس', 'flyadeal', 'أديل', 'اديل', 'booking', 'بوكينج', 'airbnb', 'hotel', 'فندق', 'فنادق', 'agoda', 'أجودا', 'almosafer', 'المسافر', 'tajawal', 'تجوال', 'emirates', 'airline', 'airways', 'طيران', 'marriott', 'hilton', 'hyatt', 'radisson', 'movenpick', 'شقق فندقية', 'resort', 'منتجع', 'expedia', 'gathern', 'قذرن', 'جاذر إن'],
  government: ['absher', 'أبشر', 'ابشر', 'moi', 'وزارة', 'مرور', 'traffic', 'مخالفة', 'jawazat', 'جوازات', 'najiz', 'ناجز', 'muqeem', 'مقيم', 'qiwa', 'قوى', 'balady', 'بلدي', 'gosi', 'التأمينات', 'رسوم', 'fees', 'efaa', 'إيفاء', 'passport', 'iqama', 'إقامة', 'visa fee', 'تأشيرة', 'saber', 'ساعد'],
  insurance: ['insurance', 'تأمين', 'تامين', 'tawuniya', 'التعاونية', 'bupa', 'بوبا', 'medgulf', 'ميدغلف', 'walaa', 'ولاء', 'malath', 'ملاذ', 'salama', 'سلامة', 'tameeni', 'تأميني', 'takaful', 'تكافل'],
  charity: ['charity', 'صدقة', 'صدقات', 'ehsan', 'احسان', 'إحسان', 'جمعية', 'تبرع', 'تبرعات', 'donation', 'donate', 'zakat', 'زكاة', 'waqf', 'وقف', 'اوقاف', 'أوقاف', 'shefaa', 'شفاء', 'furijat', 'فرجت', 'جود', 'jood'],
};

const DEFAULT_KIND_CAT = { expense: 'other', income: 'income_other' };

// ---- text normalisation ----
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/[٬،]/g, ',') // Arabic thousands separator / comma
    .replace(/ـ/g, '') // tatweel
    .replace(/[‎‏‪-‮⁦-⁩]/g, ''); // bidi marks
}

function normalizeMerchant(s) {
  return normalizeDigits(s).toLowerCase().replace(/[\s\-_.*#]+/g, ' ').replace(/\s\d{3,}$/, '').trim();
}

function hashText(s) {
  const t = normalizeDigits(s).replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(36) + t.length.toString(36);
}

// ---- category detection ----
function findCat(text) {
  let best = null, bestLen = 0;
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (w.length > bestLen && matchesWord(text, w)) { best = cat; bestLen = w.length; }
    }
  }
  return best;
}

function categorize(merchant, fullText, kind, rules) {
  const m = normalizeMerchant(merchant);
  if (rules && m && rules[m]) return rules[m];
  const byMerchant = m && findCat(m);
  if (byMerchant) return byMerchant;
  if (kind === 'expense' && fullText) {
    // Payment-method words ("stc pay", "apple pay") must not decide the category.
    const t = normalizeDigits(fullText).toLowerCase().replace(/(stc\s*pay|apple\s*pay|اس تي سي باي|ابل باي|أبل باي)/g, ' ');
    const byText = findCat(t);
    if (byText) return byText;
  }
  return DEFAULT_KIND_CAT[kind] || 'other';
}

function escRe(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matchesWord(text, w) {
  // Whole-word match in both scripts, so "stc" doesn't hit "castcom" and "نون" doesn't hit "قانون".
  const L = /^[a-z0-9&.' ]+$/.test(w) ? 'a-z0-9' : '\u0621-\u064Aa-z0-9';
  const re = new RegExp('(^|[^' + L + '])' + escRe(w) + '($|[^' + L + '])');
  return re.test(text);
}

// ---- SMS parsing ----
const CUR = '(SAR|SR|S\\.R|ر\\.?\\s?س\\.?|ريال|رس|USD|US\\$|EUR|AED|GBP|KWD|BHD|QAR|OMR|EGP|JOD|TRY|\\$|€|£)';
const NUM = '(\\d+(?:\\.\\d{1,3})?)';

function curCode(c) {
  if (!c) return null;
  c = c.replace(/\s/g, '').toUpperCase();
  if (/^(SAR|SR|S\.R|ر\.?س\.?|ريال|رس)$/i.test(c) || /ر.?س/.test(c) || c === 'ريال') return 'SAR';
  if (c === '$' || c === 'US$') return 'USD';
  if (c === '€') return 'EUR';
  if (c === '£') return 'GBP';
  return c;
}

function extractAmount(text) {
  // Drop balance / available-limit fragments so they are never read as the amount.
  const t = text
    .replace(/(الرصيد|رصيد|المتاح|الحد المتاح|Balance|Bal\b|Avail[a-z.]*\s*(?:Bal[a-z.]*|limit)?)[^\n]*/gi, '')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const found = [];
  const push = (re, ai, ci, ci2, weight) => {
    let m; re.lastIndex = 0;
    while ((m = re.exec(t))) found.push({ amount: parseFloat(m[ai]), cur: curCode(m[ci] || (ci2 ? m[ci2] : null)), idx: m.index, weight });
  };
  push(new RegExp('(?:مبلغ|المبلغ|بمبلغ|بقيمة|القيمة|قيمة|Amount|Amt|بـ)\\s*[:：]?\\s*' + CUR + '?\\s*' + NUM + '\\s*' + CUR + '?', 'gi'), 2, 1, 3, 3);
  push(new RegExp(CUR + '\\s*' + NUM, 'gi'), 2, 1, null, 2);
  push(new RegExp(NUM + '\\s*' + CUR, 'gi'), 1, 2, null, 2);
  const valid = found.filter((f) => f.amount > 0 && f.amount < 10000000);
  if (!valid.length) return null;
  // Prefer: labelled, then SAR, then earliest.
  valid.sort((a, b) => (b.weight - a.weight) || ((b.cur === 'SAR') - (a.cur === 'SAR')) || (a.idx - b.idx));
  const best = valid[0];
  // A labelled amount without currency: take currency from a currency match of the same number.
  if (!best.cur) {
    const same = valid.find((v) => v.amount === best.amount && v.cur);
    best.cur = same ? same.cur : 'SAR';
  }
  return { amount: Math.round(best.amount * 100) / 100, currency: best.cur };
}

const RX = {
  ignore: /(رمز\s*(التحقق|التفعيل|الدخول|سري)|كلمة\s*(المرور|السر)|OTP|one[- ]time|verification code|passcode|لا تشارك|do not share|مرفوض|رفض|declined|لم تتم|insufficient|غير كاف)/i,
  refund: /(استرداد|مسترد|مسترجع|استرجاع|refund|reversal|reversed|عكس عملية)/i,
  income: /(راتب|salary|payroll|إيداع|ايداع|deposit|حوالة\s*واردة|حواله\s*وارده|تحويل\s*وارد|واردة|incoming|credited|credit transfer|received|استلام|أضيف|اضافة مبلغ|إضافة مبلغ)/i,
  withdraw: /(سحب|ATM|withdraw)/i,
  transfer: /(حوالة|حواله|تحويل|transfer|صادرة|outgoing|sent to|إلى حساب|الى حساب)/i,
  bill: /(سداد|فاتورة|sadad|bill payment)/i,
};

function detectType(text) {
  if (RX.refund.test(text)) return { kind: 'income', sub: 'refund' };
  if (RX.income.test(text) && !/(شراء|purchase|POS)/i.test(text)) {
    return { kind: 'income', sub: /(راتب|salary|payroll)/i.test(text) ? 'salary' : RX.transfer.test(text) ? 'transfer_in' : 'income_other' };
  }
  if (RX.withdraw.test(text) && !/(شراء|purchase)/i.test(text)) return { kind: 'expense', sub: 'cash' };
  if (RX.bill.test(text)) return { kind: 'expense', sub: 'bill' };
  if (RX.transfer.test(text) && !/(شراء|purchase|POS)/i.test(text)) return { kind: 'expense', sub: 'transfer' };
  return { kind: 'expense', sub: 'purchase' };
}

const MERCHANT_LABEL = /^\s*(?:لدى|لدي|عند|من|المتجر|التاجر|اسم التاجر|الجهة|المفوتر|إلى|الى|المستفيد|لـ|At|Merchant|From|To|Beneficiary|Biller|Payee)\s*[:：]?\s*(.+?)\s*$/i;

function badMerchant(v) {
  const s = normalizeDigits(v).trim();
  if (!s || s.length < 2) return true;
  if (/^[\d\s*xX#:/.\-]+$/.test(s)) return true; // only digits / masks
  if (/^(حساب|بطاقة|البطاقة|الحساب|account|card|acc|a\/c|iban|رقم)/i.test(s)) return true;
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(s)) return true; // a date
  if (/^(SAR|ر\.?س|ريال)\s*\d/i.test(s)) return true;
  return false;
}

function cleanMerchant(v) {
  return normalizeDigits(v)
    .replace(/\s+(?:في|on|بتاريخ|date|at\s+\d).*$/i, '')
    .replace(/\s+\d{1,2}:\d{2}.*$/, '')
    .replace(/[;,|]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);
}

function extractMerchant(text) {
  const lines = text.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(MERCHANT_LABEL);
    if (m && !badMerchant(m[1])) return cleanMerchant(m[1]);
  }
  const inline = [
    /\b(?:at|from|to)\s+([A-Za-z؀-ۿ0-9&'. \-]{2,40}?)(?=\s+(?:on|with|using|card|via)\b|\s*[,.;\n]|\s+\d|$)/i,
    /(?:لدى|لدي|عند|المتجر|من)\s*[:：]?\s*([^\n,،;]{2,40}?)(?=\s+(?:في|على|بتاريخ|بمبلغ|بقيمة|مبلغ)(?:\s|$)|\s*[,،;\n]|$)/,
  ];
  for (const re of inline) {
    const m = text.match(re);
    if (m && !badMerchant(m[1])) return cleanMerchant(m[1]);
  }
  return '';
}

function extractMethod(text) {
  const t = text.toLowerCase();
  const brands = [];
  if (/mada|مدى/.test(t)) brands.push('مدى');
  if (/visa|فيزا/.test(t)) brands.push('فيزا');
  if (/master|ماستر/.test(t)) brands.push('ماستركارد');
  if (/amex|american express|أمريكان/.test(t)) brands.push('أمريكان إكسبريس');
  if (/apple\s*pay|أبل باي|ابل باي|آبل باي/.test(t)) brands.push('Apple Pay');
  if (/stc\s*pay|اس تي سي باي/.test(t)) brands.push('STC Pay');
  const brand = brands.join(' · ');
  const m = normalizeDigits(text).match(/(?:\*+|x{2,}|بطاقة\s*[:：]?\s*\**|البطاقة\s*[:：]?\s*\**|card\s*(?:no\.?|number)?\s*[:：]?\s*\**|ending\s*(?:with|in)?\s*|تنتهي\s*(?:بـ|ب)?\s*)(\d{4})\b/i);
  const last4 = m ? m[1] : '';
  return [brand, last4 ? '•' + last4 : ''].filter(Boolean).join(' ');
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoLocal(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function extractDate(text, now) {
  now = now || new Date();
  const t = normalizeDigits(text);
  const tm = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(ص|م|am|pm)?/i);
  let hh = tm ? +tm[1] : now.getHours(), mi = tm ? +tm[2] : now.getMinutes();
  if (tm && tm[3]) {
    const pm = /م|pm/i.test(tm[3]);
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  const cands = [];
  const add = (y, m, d) => {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const dt = new Date(y, m - 1, d, hh, mi);
    if (dt.getMonth() !== m - 1) return;
    cands.push(dt);
  };
  let m;
  const re4 = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g;
  while ((m = re4.exec(t))) add(+m[1], +m[2], +m[3]);
  if (!cands.length) {
    const re2 = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/g;
    while ((m = re2.exec(t))) {
      add(+m[3], +m[2], +m[1]); // d/m/y
      if (m[3].length === 2) add(+m[1], +m[2], +m[3]); // yy-mm-dd
    }
  }
  const limit = now.getTime() + 36 * 3600 * 1000;
  const ok = cands.filter((d) => d.getTime() <= limit && now.getTime() - d.getTime() < 400 * 86400000);
  if (!ok.length) {
    const d = new Date(now);
    if (tm) d.setHours(hh, mi, 0, 0);
    return { date: isoLocal(d), guessed: true };
  }
  ok.sort((a, b) => Math.abs(now - a) - Math.abs(now - b));
  return { date: isoLocal(ok[0]), guessed: false };
}

function detectBank(text) {
  const t = text.toLowerCase();
  const banks = [
    ['الراجحي', /rajhi|الراجحي/], ['الأهلي', /snb|alahli|الأهلي|الاهلي/], ['الرياض', /riyad ?bank|بنك الرياض/],
    ['الإنماء', /alinma|الإنماء|الانماء/], ['ساب', /\bsab\b|ساب/], ['البلاد', /albilad|البلاد/],
    ['الجزيرة', /aljazira|الجزيرة/], ['العربي', /anb|العربي الوطني/], ['السعودي الفرنسي', /bsf|الفرنسي/],
    ['STC Bank', /stc ?bank|stc ?pay|اس تي سي/], ['D360', /d360/], ['الاستثمار', /saib|الاستثمار/],
  ];
  for (const [name, re] of banks) if (re.test(t)) return name;
  return '';
}

function parseSms(raw, opts) {
  opts = opts || {};
  const text = normalizeDigits(raw).trim();
  const out = { raw: String(raw).trim(), hash: hashText(raw), ok: false, warnings: [] };
  if (!text) { out.error = 'رسالة فارغة'; return out; }
  if (RX.ignore.test(text)) { out.error = 'رسالة رمز تحقق أو عملية مرفوضة — تم تجاهلها'; out.ignored = true; return out; }
  const amt = extractAmount(text);
  if (!amt) { out.error = 'لم أتعرف على المبلغ في هذه الرسالة'; return out; }
  const type = detectType(text);
  const merchant = extractMerchant(text);
  const date = extractDate(text, opts.now);
  let cat;
  if (type.kind === 'income') cat = type.sub === 'salary' ? 'salary' : type.sub === 'refund' ? 'refund' : type.sub === 'transfer_in' ? 'transfer_in' : 'income_other';
  else if (type.sub === 'cash') cat = 'cash';
  else if (type.sub === 'transfer') cat = categorize(merchant, '', 'expense', opts.rules);
  else cat = categorize(merchant, text, 'expense', opts.rules);
  if (type.sub === 'transfer' && cat === 'other') cat = 'transfers';
  if (type.sub === 'bill' && cat === 'other') cat = 'bills';
  if (amt.currency !== 'SAR') out.warnings.push('المبلغ بعملة ' + amt.currency + ' — عدّله إلى الريال إن لزم');
  if (date.guessed) out.warnings.push('لم أجد تاريخاً في الرسالة، استخدمت تاريخ اليوم');
  Object.assign(out, {
    ok: true,
    type: type.kind,
    amount: amt.amount,
    currency: amt.currency,
    merchant: merchant || (type.sub === 'cash' ? 'صراف آلي' : type.sub === 'transfer' ? 'حوالة' : type.sub === 'salary' ? 'راتب' : ''),
    cat,
    date: date.date,
    method: extractMethod(text),
    bank: detectBank(text),
  });
  return out;
}

// Several messages pasted together: split on blank lines, or before a new "header" line.
function splitMessages(raw) {
  const t = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n+/);
  if (parts.length === 1) {
    // No blank lines. If several amount lines exist, split before recognised header words.
    const amountLines = (t.match(/(مبلغ|Amount|SAR|ر\.س)/gi) || []).length;
    if (amountLines > 2) {
      const header = /^(شراء|سحب|حوالة|حواله|تحويل|إيداع|ايداع|استرداد|سداد|راتب|POS|Purchase|Online Purchase|ATM|Transfer|Refund|Deposit|Salary|Payment)/i;
      const lines = t.split('\n');
      parts = []; let cur = [];
      for (const l of lines) {
        if (header.test(l.trim()) && cur.length) { parts.push(cur.join('\n')); cur = []; }
        cur.push(l);
      }
      if (cur.length) parts.push(cur.join('\n'));
    }
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

if (typeof module !== 'undefined') {
  module.exports = { CATEGORIES, CATEGORY_KEYWORDS, parseSms, splitMessages, categorize, normalizeDigits, normalizeMerchant, hashText, extractDate, isoLocal };
}
