const P = require('../src/parser.js');
const now = new Date(2026, 8, 28, 12, 0);
const samples = [
`شراء عبر نقاط البيع
بطاقة: 4521;مدى-ابل باي
مبلغ: SAR 86.75
لدى: PANDA RETAIL CO
في: 26-9-27 21:14`,
`شراء إنترنت
بطاقة:4521;فيزا
من:NETFLIX.COM
مبلغ:USD 15.99
في:27/09/26 03:10`,
`شراء POS
بـ 42.00 SAR
من BARNS COFFEE
مدى *7788
في 27/09/26 08:05
الرصيد 5,300.10 SAR`,
`POS Purchase
Card: **7788
Amount: SAR 1,250.00
At: EXTRA STORES
Date: 2026-09-25 19:40
Available Balance: SAR 12,000.00`,
`سحب صراف آلي
بطاقة: 4521
مبلغ: 500 ر.س
الرصيد: ٣٢١٠٫٥٠ ر.س
٢٠٢٦/٠٩/٢٦ ١٠:٢٢`,
`حوالة واردة
مبلغ: SAR 18,500
من: وزارة المالية - راتب
في: 2026-09-27`,
`حوالة محلية صادرة
مبلغ: SAR 2000
إلى: محمد عبدالله
من حساب: ***9012
في: 26/09/2026 17:30`,
`سداد فاتورة
المفوتر: STC
مبلغ: 345.00 ريال
2026-09-20 09:00`,
`Your OTP is 123456 do not share it`,
`Purchase of SAR 23.50 at JAHEZ on 28/09/26 13:05 with card ending 4521`,
`استرداد مبلغ 120 SAR من NOON على البطاقة 4521`,
`شراء عبر نقاط البيع
بطاقة: 4521;مدى
مبلغ: SAR 150
لدى: صيدلية النهدي
في: 2026-09-28 11:10`,
];
for (const s of samples) {
  const r = P.parseSms(s, { now });
  console.log(r.ok ? `${r.type}\t${r.amount} ${r.currency}\t${r.cat}\t${r.merchant}\t${r.date}\t${r.method}\t${r.warnings.join('|')}` : 'ERR ' + r.error);
}
console.log(P.splitMessages(samples.slice(0,3).join('\n\n')).length, P.splitMessages(samples[0]+'\n'+samples[3]+'\n'+samples[4]).length);
