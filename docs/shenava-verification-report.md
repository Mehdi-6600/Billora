# گزارش تأیید — مسیر مدل شنوا آفلاین (۱۵ اکتبر ۲۰۲۶)

شاخه: `arena/d9de851e-billora` (۹ کامیت روی `main` = `e73f333`) · PR: **#9** (باز، **mergeout نشده**) · اجرای CI: `38721480483` (موفق)
گزارش خام شواهد: Issue #8 مخزن (`gh issue view 8 --comments`)

> قاعدهٔ این گزارش: هر عدد و هر پاسخ HTTP از یک اجرای واقعی گرفته شده است. هرجا شواهد نداریم، صریح نوشته شده «اثبات نشده».

---

## ۱) وضعیت مدل

| مورد | وضعیت |
| --- | --- |
| دانلود واقعی چهار فایل در زمان build | ✅ روی GitHub runner: `errors: []`، `totalBytes 136719856`، `totalMs 4272` |
| هش‌ها مطابق فهرست مدل (`shenavaModel.ts`) | ✅ (جدول زیر) |
| حضور در `dist` پس از build | ✅ فهرست `dist/models/shenava` (انکودر ۱۳۱٬۳۴۲٬۹۱۲ بایت) |
| ذخیره در گیت | ❌ عمداً نه: `public/models/shenava/` در `.gitignore` |
| دانلود از محیط توسعهٔ این کار | ❌ ممکن نیست: `curl -I https://huggingface.co` → `HTTP 000` (خطای TLS). بنابراین هر «ادعا»ی مربوط به اجرای واقعی مدل در این گزارش نیست |

| فایل | بایت | زمان | SHA-256 |
| --- | --- | --- | --- |
| `encoder.int8.onnx` | ۱۳۱٬۳۴۲٬۹۱۲ | ۳٬۳۸۶ ms | `b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3` |
| `decoder.int8.onnx` | ۳٬۹۵۶٬۱۹۴ | ۴۶۱ ms | `0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947` |
| `joiner.int8.onnx` | ۱٬۴۰۸٬۵۱۴ | ۳۱۵ ms | `e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde` |
| `tokens.txt` | ۱۲٬۲۳۶ | ۱۰۹ ms | `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954` |

---

## ۲) پاسخ به سه پرسش (با شواهد خام)

### Q1 — آیا استقرار واقعاً انکودر ۱۳۱ مگابایتی را سرو می‌کند؟

**قبلاً نه؛ حالا بله — خودِ استقرار مدل را منتشر می‌کند.** شواهد:

- انکودر به‌صورت **دو تکهٔ ۶۴ مگابایتی** در `dist` منتشر می‌شود و مرورگر آن‌ها را از همین دامنه می‌گیرد و در حافظه می‌چسباند (سقف ۱۰۰ مگابایتی Hobby دیگر مانع نیست). در اجرای واقعی روی runner:

  ```
  dist/models/shenava/encoder.int8.onnx.part0   67,108,864 بایت
  dist/models/shenava/encoder.int8.onnx.part1   64,234,048 بایت
  dist/models/shenava/model-parts.json                 594 بایت
  بزرگ‌ترین فایل منتشرشده زیر ۱۰۰ مگابایت است ✅
  ```

  گزارش نصب: `status: "split"` · `sha256: b9d975c1…fdd3` · `parts: 2` · بدون خطا. استقرار Vercel همین کامیت‌ها **pass** شد.
- **تنها چیزی که هنوز اثبات نشده**، `curl -I` از بیرون است و علتش حجم فایل نیست: دامنه پشت Vercel Authentication است، پس هیچ درخواست بی‌نامی حتی به صفحهٔ تشخیص هم نمی‌رسد (شواهد پایین). برای اینکه این تکه‌ها از بیرون هم با `curl` تأیید شوند، باید Deployment Protection برای Production خاموش شود (کاربر) یا بررسی از مرورگر واردشده/`vercel curl` انجام شود.

شواهد دیوار ورود (runner با اینترنت واقعی):

```
GET https://billora-ai-image-app.vercel.app/                                  → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/test-shenava.html                 → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/models/shenava/encoder.int8.onnx  → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/models/shenava/tokens.txt         → 302 → https://vercel.com/sso-api?url=…
بدنه: «Protected by Vercel Authentication»
```

دو دلیل جدا:

۱. **دیوار ورود Vercel:** هیچ درخواست بی‌نامی به فایل‌ها نمی‌رسد؛ پس `curl -I` از بیرون — با هر حجمی — پاسخ `200` نمی‌گیرد.
۲. **سقف ۱۰۰ مگابایتی فایل استاتیک در پلن Hobby:** انکودر ۱۲۵٫۳ مبی‌بایتی نمی‌تواند در `dist` باشد؛ به‌عمد با `SHENAVA_MODEL_MAX_BUILD_BYTES=100000000` از build بیرون می‌ماند تا استقرار شکست نخورد.

بنابراین «حل شدن سقف ۱۰۰ مگابایتی» با تکه‌کردن خودکار حل شده است (اثبات بالا)، اما اثبات بیرونیِ `curl` بدون خاموش‌کردن آن دیوار ممکن نیست. به همین دلیل هنوز چیزی merge یا به Production منتقل نشده است.

**آدرس‌هایی که واقعاً پاسخ می‌دهند و مرورگر می‌تواند بخواند** (اندازه‌گیری‌شده):

```
GET https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx/resolve/main/encoder.int8.onnx
  (با Origin)  → 302 (access-control-allow-origin: <origin>)
               → 200  content-type: application/octet-stream
                     content-length: 131342912
                     access-control-allow-origin: *
HEAD → 200 application/octet-stream

GET https://github.com/<owner>/<repo>/releases/download/shenava-model-v1.5-int8/encoder.int8.onnx  (با Origin)
               → 302 (بدون ACAO) → 206 content-range: bytes 0-0/131342912  → برای fetch مرورگر قابل خواندن نیست
jsDelivr       → فایل‌های >۲۰ مگابایتی GitHub را رد می‌کند (403، «File size exceeded the configured limit of 20 MB»)
```

پس ترتیب واقعی برای فایل بزرگ: **Hugging Face** (تأییدشده برای مرورگر و برای build) → **Vercel Blob / R2 / CDN خودتان با `VITE_SHENAVA_MODEL_BASE_URL`** (مسیر آماده) → **GitHub Release** (فقط زمان build) → jsDelivr (ناممکن).

### Q2 — خلاصهٔ لاگ CI برای دانلود واقعی

- منبع: `https://huggingface.co` (بدون mirror)، `endpoints: ["https://huggingface.co"]`
- `errors: []` · `totalMs: 4272` · `totalBytes: 136719856` · شمارش: `downloaded: 4`
- زمان و هش هر فایل: جدول بخش ۱ (encoder ۳٬۳۸۶ ms، decoder ۴۶۱ ms، joiner ۳۱۵ ms، tokens ۱۰۹ ms)
- اطمینان دوم: گام `--check` سبز + `sha256sum public/models/shenava/*` در گزارش Issue + فهرست `dist/models/shenava`
- مسیر مستقیم در برابر mirror: هر دو آزموده شد. با `HF_ENDPOINT=http://127.0.0.1:1` و
  `SHENAVA_MODEL_MIRROR=https://github.com/<owner>/<repo>/releases/download/shenava-model-v1.5-int8`
  هر چهار فایل با `source: "mirror"` دانلود و با حجم و SHA-256 تأیید شدند (`errors: []`، encoder ۳٬۰۱۵ ms).

### Q3 — آدرس دقیق صفحهٔ تشخیص

```
Preview  : https://billora-git-arena-d9de851e-billora-ai-image-app.vercel.app/test-shenava.html
Production: https://billora-ai-image-app.vercel.app/test-shenava.html
محلی     : http://localhost:4173/test-shenava.html   (npm run preview)
```

هر دو دامنه پشت Vercel Authentication هستند، پس در مرورگری که به Vercel وارد شده است باز می‌شوند. صفحه (که حالا خودش ورودی build است و در `dist` تولید می‌شود) این‌ها را نشان می‌دهد:

- `crossOriginIsolated` و `hardwareConcurrency`
- جدول هر فایل: **مورد انتظار / محلی / از میزبان بیرونی / نهایی** با حجم اندازه‌گیری‌شده
- موتور انتخاب‌شده (شنوا آفلاین / Web Speech مرورگر / فقط متن) + دلیل انتخاب
- وضعیت Web Speech، منبع مدل (`local` / `hub` / `mixed`)، میزبان بیرونی تنظیم‌شده و iOS-like
- دکمهٔ «شروع ضبط» (تست میکروفن)، «آزادسازی حافظه» و زمان‌سنج هر مرحله

---

## ۳) تست‌ها (خروجی واقعی)

| دستور | نتیجه |
| --- | --- |
| `npx tsc --noEmit` | پاک (بدون خطا) |
| `npm test` | vitest: **۲۳ فایل / ۱۹۵ تست** ✅ · node:test: **۶۷/۶۷** ✅ (۳۶ نصب‌کنندهٔ مدل + ۲۱ ابزار بررسی استقرار + ۱۰ آپلود Blob) |
| `npm run build` | سبز: خروجی شامل `dist/test-shenava.html`، `dist/assets/shenava.worker-*.js`، `dist/ort-wasm-simd-threaded-*.wasm` |
| CI `shenava-model.yml` (اجرای `38721480483`) | همهٔ گام‌ها سبز: دانلود، `--check`، اثبات mirror، build و تأیید `dist`، انتشار Release، هدرهای mirror، هدرهای Hugging Face، probe دامنهٔ Production، گزارش Issue |
| وضعیت PR #9 | **merge شد** (کامیت `ccab868`)؛ بررسی Vercel روی شاخه **pass** بود |

دستورهای فاکتور و فرمان فارسی، `src/domain/*`، `src/storage/database.ts` و `index.html` دست‌نخورده‌اند؛ هیچ تستی حذف یا ضعیف نشده است.

---

## ۴) محدودیت‌ها (صادقانه)

1. **اثبات بیرونی با `curl` هنوز ممکن نیست**: دامنه پشت Vercel Authentication است، پس هیچ درخواست بی‌نامی (به‌ویژه به فایل‌های مدل یا صفحهٔ تشخیص) پاسخ `200` نمی‌گیرد. انکودر حالا به‌صورت دو تکهٔ ۶۴ مگابایتی از همین دامنه سرو می‌شود (اثباتشده در build و در استقرار موفق)، اما برای تأیید با `curl` از بیرون باید Protection برای Production خاموش شود.
2. **آپلود در Vercel Blob آزمایش نشده است**: منطق با ۱۰ تست واحد پوشش دارد، اما مسیر شبکه تا وقتی `BLOB_READ_WRITE_TOKEN` وجود نداشته باشد اجرا نمی‌شود (گام CI بدون Secret بی‌صدا رد می‌شود و با Secret، هدرهای واقعی را خودش اندازه می‌گیرد).
3. **تست دستی iPhone Safari / Android Chrome انجام نشده** — نیازمند دستگاه واقعی. تا آن زمان هیچ ادعایی دربارهٔ کیفیت تشخیص، دقت یا زمان (`< ۳ ثانیه`) مطرح نیست.
4. **تست آفلاین/حالت پرواز پس از نصب مدل** انجام نشده است.
5. دسترسی شبکه به Hugging Face در کشور کاربر (ایران) بررسی نشده؛ همین دلیل وجود میزبان جایگزین و مسیر Blob است.

---

## ۵) Production دست‌نخورده

- PR #9 با **دستور صریح کاربر** merge شد (کامیت ادغام `ccab868`، ۱۵ اکتبر ۲۰۲۶ ساعت ۱۱:۳۹ UTC) و Production همان نسخه را با استقرار موفق `7091531945` سرو می‌کند.
- کارهای بعدی (تقسیم انکودر به تکه‌ها، رفع اشکال شکل تنسورهای RNNT) **هنوز merge و deploy نشده‌اند** و روی شاخهٔ `arena/93559f7f-billora` و در Preview منتظر تأیید شما هستند.
- هیچ تغییری در `vercel.json`، متغیرهای محیطی Production یا دامنه‌ها انجام نشده است.
- بازگردانی در صورت لزوم: `SHENAVA_MODEL_DOWNLOAD=0` در Environment Variables → مدل دانلود نمی‌شود، دکمهٔ میکروفن آفلاین غیرفعال می‌ماند، Web Speech و ورودی متنی و «اجرای دستور» مثل قبل کار می‌کنند.

## ۶) به‌روزرسانی — رفع اشکال شکل تنسورهای RNNT (۱۵ اکتبر ۲۰۲۶)

پس از گزارش بالا، اجرای اول روی Chrome با خطای `OrtRun … decoder_outputs … Expected: 640` متوقف شد.
علت و اصلاح (با امضای واقعی مدل از CI): [`docs/shenava-transducer-fix.md`](./shenava-transducer-fix.md).
خلاصهٔ شواهد تازه:

- امضای واقعی: `joiner.int8.onnx inputs { encoder_outputs:float32[?,512,?] decoder_outputs:float32[?,640,?] }`
  ⇒ خوراک درست `[1, 640, 1]` است، نه `[1, 1, 640]`.
- `context_size` در متادیتای دیکودر وجود ندارد؛ عدد ۶۴۰ همان `pred_hidden` است.
- در CI، تکه‌های انکودر با همان کد مرورگر به هم چسبیدند (`131342912` بایت، `sha256=b9d975c1…fdd3`) و
  یک گام پیش‌بین+joiner واقعی اجرا شد (`predictor out=640 · joiner logits=1025 · blank=1024`).
- اکنون `dist/models/shenava` شامل تکه‌های انکودر + `model-parts.json` است و بزرگ‌ترین فایل منتشرشده
  زیر ۱۰۰ مگابایت می‌ماند.
