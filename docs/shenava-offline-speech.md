# تشخیص گفتار آفلاین فارسی با مدل شنوا کوچیک ۱.۵

موتور گفتار آفلاین روی خود دستگاه اجرا می‌شود: صدا از مرورگر بیرون نمی‌رود، هیچ سروری در میان نیست و پس از نصب مدل حتی بدون اینترنت کار می‌کند. این سند وضعیت واقعی پیاده‌سازی، روش نصب مدل، تست‌ها و محدودیت‌های باقی‌مانده را ثبت می‌کند.

مدل: [`Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx`](https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5-RNNT-sherpa-onnx) (نسخهٔ int8، حدود ۱۳۶٫۸ مگابایت).
اجرا: [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) داخل Web Worker.

## معماری

```
میکروفن → audioCapture (Downsample به ۱۶ kHz مونو) ─┐
                                                    ├─ ShenavaRecognizer ─→ shenava.worker.ts ─→ onnxruntime-web
متن فرمان ← persianItn / ورودی متنی ←────────────────┘        (فقط متن، هیچ اجرای خودکار)      (encoder/decoder/joiner int8)
```

| فایل | نقش |
| --- | --- |
| `src/speech/offline/melFilters.ts` | فیلتربانک مل اسلینی (۸۰×۲۵۷) هم‌ارز librosa/NeMo |
| `src/speech/offline/features.ts` | لگ‌مل ۸۰ باندی نِمو: preemphasis 0.97، پنجرهٔ hann(periodic=false)، FFT 512، hop 160، `log(x + 2**-24)` |
| `src/speech/offline/rnnt.ts` | دیکود حریص RNNT با blank = آخرین توکن، سقف ۱۰ نماد در هر فریم و تایم‌استمپ ۸۰ میلی‌ثانیه‌ای |
| `src/speech/offline/tokenizer.ts` | خواندن `tokens.txt` (SentencePiece با `▁`) و تبدیل شناسه‌ها به متن |
| `src/speech/offline/persianItn.ts` | تبدیل عدد گفتاری به رقم با گارد «اگر معنای فرمان عوض شد، متن خام بماند» |
| `src/speech/offline/shenava.worker.ts` | بارگذاری سه سشن ONNX، کش مدل در Cache API، محاسبهٔ ویژگی و دیکود |
| `src/speech/offline/ShenavaRecognizer.ts` | پوستهٔ اصلی: probe مدل، چرخهٔ عمر worker، متریک‌ها و پیام‌های خطای فارسی |
| `src/speech/offline/useOfflineSpeech.ts` | قلاب React برای اتصال به فرم فاکتور (وضعیت، شروع/توقف، متن نهایی) |
| `src/speech/offline/engineSelection.ts` | انتخاب موتور: iOS/Safari → شنوا، اندروید/Chrome → Web Speech (با امکان تغییر دستی) |
| `src/speech/offline/diagnostic.tsx` + `test-shenava.html` | صفحهٔ تست مستقل: وضعیت `crossOriginIsolated`، جدول هر فایل (حجم مورد انتظار/محلی/بیرونی/نهایی)، انتخاب موتور فعال + دلیل، وضعیت Web Speech، منبع مدل، دکمهٔ تست میکروفن و آزادسازی حافظه |

دستورها دست‌نخورده‌اند: متن تشخیص‌داده‌شده فقط داخل همان ورودی فرمان می‌نشیند و تا زدن «اجرای دستور» هیچ تغییری در فاکتور رخ نمی‌دهد.

## نصب مدل

فایل‌های مدل در گیت ذخیره نمی‌شوند (`.gitignore`: کل پوشهٔ `public/models/shenava/`). نصب در **زمان build** خودکار است و کاربر هیچ کاری نمی‌کند:

```bash
# زنجیرهٔ ساخت: prebuild مدل را نصب می‌کند، سپس ویت آن را در dist کپی می‌کند
npm run build            # = prebuild → tsc -b && vite build
npm run model:download   # نصب دستی مدل (همان اسکریپت)
npm run model:check      # فقط بررسی فایل‌های موجود؛ در صورت نقص با کد ۱ خارج می‌شود
```

اسکریپت `scripts/download-shenava-model.mjs` هر فایل را با حجم و SHA-256 فهرست‌شده در متادیتای Hugging Face مقایسه می‌کند و بعد از دانلود موفق آن را در `node_modules/.cache/shenava-model` هم می‌گذارد (این پوشه در کش build ورسل می‌ماند، پس buildهای بعدی چیزی دانلود نمی‌کنند).

### دانلود خودکار در Vercel

در Vercel، `npm run build` اجرا می‌شود و npm خودش `prebuild` را قبل از آن اجرا می‌کند: چهار فایل مدل (حدود ۱۳۷ مگابایت) دانلود، بررسی و داخل `dist` قرار می‌گیرند و بعد از استقرار مثل هر فایل استاتیک دیگری از دامنهٔ خودتان سرو می‌شوند. پس از اولین بارگذاری، همه‌چیز روی خود دستگاه اجرا می‌شود و دیگر هیچ درخواستی برای مدل لازم نیست.

> **سقف حجم فایل استاتیک در پلن Hobby ورسل ۱۰۰ مگابایت است.** انکودر ۱۲۵٫۳ مبی‌بایت (۱۳۱٬۳۴۲٬۹۱۲ بایت) است، پس نمی‌تواند در `dist` باشد وگرنه استقرار شکست می‌خورد. به همین دلیل `SHENAVA_MODEL_MAX_BUILD_BYTES=100000000` لازم است: فایل‌های کوچک (decoder + joiner + tokens ≈ ۵٫۴ مگابایت) همراه برنامه می‌آیند و انکودر بزرگ بار اول توسط مرورگر از Hugging Face گرفته و روی دستگاه کش می‌شود. برای اینکه انکودر هم از یک میزبان دلخواه (Vercel Blob، Cloudflare R2، CDN خودتان) بیاید، `VITE_SHENAVA_MODEL_BASE_URL` را به آن میزبان تنظیم کنید؛ جزئیات در بخش «شواهد اندازه‌گیری‌شده».

#### بررسی وضعیت

پس از deploy دو راه سریع هست:

۱) مسیر خود فایل مدل را باز کنید:

```
https://<your-app>.vercel.app/models/shenava/encoder.int8.onnx
```

باید **خودِ فایل** دانلود شود (نه HTML). اگر HTML برگشت یعنی مدل کنار برنامه نیست؛ لاگ build را ببینید: در مرحلهٔ `prebuild` باید خطوط `GET`/`OK`/`CACHE` برای هر فایل دیده شود.

۲) صفحهٔ تشخیص را روی همان دامنه باز کنید: `https://<your-app>.vercel.app/test-shenava.html` — این صفحه حالا همراه خود برنامه build می‌شود و روی گوشی نشان می‌دهد «موجود بودن مدل: موجود»، «Cross-Origin Isolated: بله» و زمان هر مرحله؛ دکمهٔ «شروع ضبط» هم همان‌جا قابل امتحان است.

۳) ابزار بررسی خودکار (پیشنهادشده): این دستور وضعیت واقعی یک استقرار را با درخواست‌های HTTP می‌سنجد و دربارهٔ هدرهای COOP/COEP، صفحهٔ تشخیص و هر چهار فایل مدل (status، `Content-Type`، `Content-Length` در برابر فهرست مدل) حکم می‌دهد:

```bash
npm run verify:deployed -- https://<your-app>.vercel.app          # متن خوانا + کد خروج ۰/۱
npm run verify:deployed -- https://<app> --json                   # خروجی JSON برای گزارش
npm run verify:deployed -- http://localhost:4173                  # روی preview محلی
```

اگر پاسخ مدل `text/html` باشد (یعنی به‌جای فایل، `index.html` برگشته باشد) ابزار آن را رد می‌کند و راه‌حل فارسی چاپ می‌کند؛ چون تجربه نشان داد سرورهای SPA برای مسیرهای ناموجود با کد ۲۰۰ همان `index.html` را می‌دهند.

> نکته: دامنه‌های Vercel این پروژه پشت «Vercel Authentication» هستند (Protected Deployment)؛ اندازه‌گیری‌شده: درخواست بی‌نام به `/`، `/test-shenava.html` و به هر دو فایل مدل پاسخ `HTTP/2 302` می‌گیرد و به `https://vercel.com/sso-api?...` می‌رود با بدنهٔ «Protected by Vercel Authentication». یعنی **هیچ ابزار بیرونی (curl بی‌نام) نمی‌تواند وجود فایل را روی این دامنه اثبات کند**، صرف نظر از حجم فایل. برای اثبات بیرونی یا باید Protection را برای Production خاموش کرد یا از دامنهٔ اختصاصی عمومی استفاده کرد؛ در غیر این صورت بررسی باید از داخل مرورگر خودتان (که به Vercel وارد شده‌اید) یا با `vercel curl <deployment-url>` انجام شود. مسیر `dist/models/shenava/` هم فقط پس از موفقیت دانلود در build ساخته می‌شود.

#### عیب‌یابی

| نشانه | راه‌حل |
| --- | --- |
| لاگ `FAIL ... HTTP 403/404` | فایل‌ها در مخزن بالا نیستند یا revision عوض شده؛ مخزن و نام فایل‌ها را بررسی کنید |
| لاگ `FAIL ... fetch failed` | شبکهٔ build به Hugging Face دسترسی ندارد → `HF_ENDPOINT=https://hf-mirror.com` را به‌عنوان Environment Variable در Vercel بگذارید (می‌شود چند میزبان با کاما داد) یا یک mirror تخت (مثل assetهای GitHub Release) با `SHENAVA_MODEL_MIRROR` بدهید |
| می‌خواهید بدانید هر فایل واقعاً از کجا آمده | `SHENAVA_MODEL_REPORT=/tmp/model.json` (یا `--report=`)؛ در JSON هر فایل `status`/`bytes`/`ms`/`sha256`/`endpoint`/`source` دارد (`network` یا `cache` یا `mirror`) |
| build خیلی طول می‌کشد | بار اول طبیعی است (چند دقیقه برای ۱۳۷ مگابایت)؛ بارهای بعد از کش `node_modules/.cache` استفاده می‌شود |
| استقرار با خطای حجم شکست می‌خورد | پلن Hobby ورسل برای «آپلود فایل استاتیک» سقف ۱۰۰ مگابایت دارد. با `SHENAVA_MODEL_MAX_BUILD_BYTES=100000000` فقط فایل‌های کوچک همراه build می‌آیند و انکودر بزرگ (۱۳۱ مگابایت) بار اول توسط مرورگر از Hugging Face گرفته و روی دستگاه کش می‌شود. با `SHENAVA_MODEL_DOWNLOAD=0` هم می‌توان کل دانلود را به مرورگر سپرد |
| می‌خواهید مدل اصلاً همراه build نباشد | `SHENAVA_MODEL_DOWNLOAD=0` |

متغیرهای محیطی پشتیبانی‌شده: `HF_ENDPOINT` (یک یا چند میزبان با کاما)، `SHENAVA_MODEL_MIRROR` / `SHENAVA_MODEL_MIRRORS` (میزبان با ساختار **تخت**: `<base>/<fileName>`، مثل assetهای GitHub Release؛ بعد از میزبان‌های Hugging Face امتحان می‌شود)، `SHENAVA_MODEL_DOWNLOAD` (`0` = خاموش)، `SHENAVA_MODEL_MAX_BUILD_BYTES` (سقف حجم فایل‌هایی که همراه build می‌آیند)، `SHENAVA_MODEL_DIR`، `SHENAVA_MODEL_CACHE_DIR`، `SHENAVA_MODEL_MANIFEST` (برای تست یا mirror با فایل‌های دیگر) و `SHENAVA_MODEL_REPORT` (مسیر فایل JSON گزارش).

سرخط فرمان هم همان‌ها را دارد: `--check` (فقط بررسی)، `--force`، `--strict` (شکست با کد ۱)، `--quiet`، `--dir=`, `--endpoint=`, `--mirror=`, `--max-bytes=`, `--report=`. بدون `--strict`/`--check` دانلود ناموفق **هرگز build را نمی‌شکند** (خواستهٔ صریح: نبود مدل نباید استقرار را از کار بیندازد).

روی **GitHub Pages** دانلود به‌طور پیش‌فرض خاموش است (`GITHUB_PAGES=true`): آن میزبان نمی‌تواند هدرهای COOP/COEP بفرستد و افزودن ۱۳۷ مگابایت به آرتیفکت Pages هم منطقی نیست. اگر لازم شد، با `SHENAVA_MODEL_DOWNLOAD=1` می‌توان اجبار کرد.

| فایل | حجم (بایت) | SHA-256 |
| --- | --- | --- |
| `encoder.int8.onnx` | ۱۳۱٬۳۴۲٬۹۱۲ | `b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3` |
| `decoder.int8.onnx` | ۳٬۹۵۶٬۱۹۴ | `0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947` |
| `joiner.int8.onnx` | ۱٬۴۰۸٬۵۱۴ | `e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde` |
| `tokens.txt` | ۱۲٬۲۳۶ | — (LFS نیست) |

۴) دانلود خودکار در مرورگر (یک‌بار): اگر فایل‌ها کنار برنامه نباشند، مرورگر خودش همان چهار فایل را از مخزن Hugging Face می‌گیرد، حجم و SHA-256 را بررسی می‌کند و در Cache API نگه می‌دارد؛ دفعهٔ بعد کاملاً آفلاین است. با `allowRemoteModel: false` می‌توان این مسیر را بست و فقط URLهای هم‌مبدأ را مجاز دانست. در این مسیر هیچ صدایی جابه‌جا نمی‌شود؛ فقط وزن‌های مدل دانلود می‌شود.

## شواهد اندازه‌گیری‌شده (۱۵ اکتبر ۲۰۲۶)

همهٔ عددهای این بخش از ماشینی با اینترنت واقعی گرفته شده‌اند (GitHub runner، گردش‌کار `.github/workflows/shenava-model.yml`، گزارش کامل در Issue #8 مخزن). این محیط توسعه خودش به Hugging Face دسترسی ندارد (`curl -I https://huggingface.co` → `HTTP 000`، خطای TLS) و دامنه‌های `*.vercel.app` را هم نمی‌بیند؛ پس هر «ادعای» بدون عدد اینجا نیامده است.

### ۱) دانلود واقعی مدل در زمان build (پاسخ به «آیا CI واقعاً دانلود کرد؟»)

هر چهار فایل از `https://huggingface.co` (بدون mirror)، `errors: []`، مجموع `136719856` بایت در `4272` میلی‌ثانیه:

| فایل | بایت | زمان | SHA-256 (اندازه‌گیری‌شده) |
| --- | --- | --- | --- |
| `encoder.int8.onnx` | ۱۳۱٬۳۴۲٬۹۱۲ | ۳٬۳۸۶ ms | `b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3` |
| `decoder.int8.onnx` | ۳٬۹۵۶٬۱۹۴ | ۴۶۱ ms | `0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947` |
| `joiner.int8.onnx` | ۱٬۴۰۸٬۵۱۴ | ۳۱۵ ms | `e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde` |
| `tokens.txt` | ۱۲٬۲۳۶ | ۱۰۹ ms | `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954` |

هش‌ها با مقدارهای فهرست مدل در `shenavaModel.ts` و با بایت‌های واقعی روی دیسک یکی هستند و گام `--check` و فهرست `dist/models/shenava/` (انکودر ۱۳۱٬۳۴۲٬۹۱۲ بایت) هم همین را تأیید می‌کند. یعنی مسیر «دانلود خودکار در زمان build» واقعاً کار می‌کند، نه فقط در تست واحد.

### ۲) آیا asset گیت‌هاب به‌عنوان میزبان مرورگری قابل استفاده است؟ نه

mirror در Release (`shenava-model-v1.5-int8`) ساخته می‌شود و **برای build کاملاً معتبر است**: با غیرفعال‌کردن Hugging Face (`HF_ENDPOINT=http://127.0.0.1:1`) و دادن `SHENAVA_MODEL_MIRROR=https://github.com/<owner>/<repo>/releases/download/shenava-model-v1.5-int8`، هر چهار فایل دانلود و با حجم و SHA-256 تأیید شدند (`source: "mirror"`، `errors: []`، انکودر ۳٬۰۱۵ ms). اما برای `fetch` مرورگر:

```
GET https://github.com/.../releases/download/shenava-model-v1.5-int8/encoder.int8.onnx
  (با هدر Origin) → HTTP/2 302 … بدون access-control-allow-origin
                  → HTTP/2 206 content-type: application/octet-stream content-range: bytes 0-0/131342912
```

زنجیرهٔ تغییرمسیر هیچ `access-control-allow-origin` ندارد، پس زیر COEP: require-corp مرورگر اجازهٔ خواندن آن را نمی‌دهد. **jsDelivr هم گزینه نیست**: قاعدهٔ خودش برای فایل‌های GitHub سقف ۲۰ مگابایت است و یک فایل ۱۳۱ مگابایتی با خطای «File size exceeded the configured limit of 20 MB» رد می‌شود. نتیجه: Release فقط برای **زمان build** به کار می‌آید، نه برای دانلود در مرورگر.

### ۳) Hugging Face به‌عنوان میزبان مرورگری: تأییدشده

```
GET https://huggingface.co/Reza2kn/…/resolve/main/encoder.int8.onnx  (با Origin)
  → HTTP/2 302 … access-control-allow-origin: <origin>   (روی خود huggingface.co)
  → HTTP/2 200 content-type: application/octet-stream
               content-length: 131342912
               access-control-allow-origin: *
               access-control-expose-headers: *
HEAD → HTTP/2 200 application/octet-stream   (همان پاسخ، برای probe مدل)
```

برای یک `fetch()` بدون credentialed (که کد worker انجام می‌دهد)، این زنجیره با `Cross-Origin-Embedder-Policy: require-corp` سازگار است؛ پس مسیر «بار اول انکودر را از Hugging Face بگیر و روی دستگاه کش کن» از نظر هدرها درست است. این تنها میزبان مرورگری تأییدشده برای فایل ۱۳۱ مگابایتی است.

### ۴) وضعیت دامنهٔ Production (پاسخ به «آیا واقعاً سرو می‌شود؟»)

دامنه‌های این پروژه پشت Vercel Authentication هستند. درخواست بی‌نام (از runner با اینترنت واقعی):

```
GET https://billora-ai-image-app.vercel.app/                     → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/test-shenava.html     → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/models/shenava/encoder.int8.onnx → 302 → https://vercel.com/sso-api?url=…
GET https://billora-ai-image-app.vercel.app/models/shenava/tokens.txt        → 302 → https://vercel.com/sso-api?url=…
بدنه: «Protected by Vercel Authentication»
```

یعنی اثبات با `curl -I` از بیرون **ساختاراً غیرممکن** است — نه به‌خاطر حجم فایل، بلکه چون هیچ درخواست بی‌نامی به فایل‌ها نمی‌رسد. برای اثبات واقعی یکی از این‌ها لازم است:

۱) در Vercel → Settings → Deployment Protection، گزینهٔ Vercel Authentication برای **Production** خاموش شود (یا دامنهٔ اختصاصی عمومی وصل شود) و بعد `npm run verify:deployed -- https://<domain>` اجرا شود؛
۲) یا از مرورگر خودتان (که به Vercel وارد شده‌اید) `/test-shenava.html` باز شود و همان صفحه وضعیت هر فایل را نشان می‌دهد؛
۳) یا با `vercel curl <deployment-url>` (که با احراز هویت CLI کار می‌کند).

حتی پس از برداشتن آن دیوار، انکودر ۱۳۱ مگابایتی به‌خاطر سقف ۱۰۰ مگابایتی فایل استاتیک در پلن Hobby در `dist` حاضر نیست (فقط decoder/joiner/tokens همراه build می‌آیند و همین باعث می‌شود استقرار موفق شود). پس برای «هم‌مبدأ بودن انکودر» یا باید به پلن Pro رفت، یا از Vercel Blob / Cloudflare R2 / CDN خودتان استفاده کرد و `VITE_SHENAVA_MODEL_BASE_URL` را به آن نشان داد؛ در همهٔ این حالت‌ها `npm run verify:deployed` حکم نهایی را می‌دهد. صفحهٔ تشخیص هم برای همین ساخته شده: ستون «نهائی» هر فایل منبع واقعی (محلی یا میزبان بیرونی) را نشان می‌دهد.

### ۵) گردش‌کار GitHub و ابزار بررسی

| ابزار | کار |
| --- | --- |
| `.github/workflows/shenava-model.yml` | دستی (`workflow_dispatch`): دانلود `--strict` + گزارش JSON، `--check`، build و تأیید حضور مدل در `dist`، انتشار Release به‌عنوان mirror، اندازه‌گیری هدرهای mirror و Hugging Face، probe خواندنی دامنهٔ Production، بررسی اختیاری استقرار با `verify:deployed`، و ثبت همهٔ این‌ها به‌صورت کامنت در Issue |
| `npm run model:download` / `model:check` | نصب و بررسی مدل روی هر ماشین (بی‌خطر برای build) |
| `npm run verify:deployed -- <url>` | حکم دربارهٔ یک استقرار واقعی: COOP/COEP، صفحهٔ تشخیص و چهار فایل مدل (status، نوع محتوا، حجم)؛ کد خروج ۰/۱ |

## جداسازی Cross-Origin (برای چندرشته‌ای شدن WASM)

هدرها هم در `vercel.json` (Production) و هم در `vite.config.ts` (`server` و `preview`) تنظیم شده‌اند:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

- پیش از افزودن این هدرها، همهٔ منابع بیرونی برنامه بازبینی شد: `index.html`، `src/styles.css` و کل `src` هیچ منبع CDN/فونت/تصویر بیرونی ندارند، بنابراین `require-corp` چیزی را نمی‌شکند.
- روی **GitHub Pages** امکان تعیین هدر وجود ندارد؛ آنجا `crossOriginIsolated === false` می‌شود و موتور با یک رشته اجرا می‌شود (کندتر ولی درست). موتور در همین حالت هم `console.error('[Shenava] Cross-origin isolation missing. WASM will run on 1 thread.')` را ثبت می‌کند.
- وصلهٔ `ortRuntimePlugin` در `vite.config.ts` فایل‌های runtime را از `node_modules/onnxruntime-web/dist` به `public/ort/` می‌کند تا هیچ درخواستی از دامنهٔ دیگر (یا CDN) انجام نشود؛ این پوشه در گیت ignore است.

## وضعیت تأیید (صادقانه)

| مورد | وضعیت |
| --- | --- |
| تست‌های واحد موتور (ویژگی‌ها، توکنایزر، RNNT، ITN، probe، worker، آدرس‌سازی) | ✅ `npm test` |
| تست‌های نصب‌کنندهٔ مدل (۲۹ تست با سرور HTTP محلی، شامل mirror و گزارش JSON) | ✅ `npm test` → `node --test scripts/…` |
| تست‌های ابزار بررسی استقرار (۱۶ تست، شامل تلهٔ پاسخ HTML) | ✅ `npm test` → `node --test scripts/…` |
| `npm run typecheck` | ✅ |
| `npm run build` + بررسی خروجی `dist/assets` | ✅ (با مدل غایب: هشدار و ادامهٔ build) |
| دانلود خودکار در build با میزبان واقعی (Hugging Face) | ✅ روی GitHub runner: هر چهار فایل، `136719856` بایت در `4272 ms`، هش‌ها مطابق فهرست مدل (جدول بخش «شواهد») |
| mirror روی GitHub Release (زمان build) | ✅ با غیرفعال‌کردن Hugging Face هم هر چهار فایل از Release دانلود و تأیید شدند |
| مرورگری بودن میزبان‌ها | ✅ Hugging Face (`access-control-allow-origin: *` روی پاسخ نهایی) · ❌ GitHub Release (بدون ACAO) · ❌ jsDelivr (سقف ۲۰ مگابایت برای فایل GitHub) |
| استقرار روی Vercel (build و خروجی `dist`) | ✅ استقرار موفق؛ اما سرو شدن فایل‌ها از بیرون **قابل اثبات نیست**: دامنه پشت Vercel Authentication است (۳۰۲ به `vercel.com/sso-api`، اندازه‌گیری‌شده). انکودر هم به‌عمد در `dist` نیست (سقف ۱۰۰ مگابایتی Hobby) |
| اجرای واقعی مدل int8 در مرورگر (با فایل‌های ۱۳۷ مگابایتی) | ❌ انجام نشده — مدل از این محیط دانلود نمی‌شود |
| تست دستی iPhone Safari / Android Chrome | ❌ انجام نشده (نیازمند دستگاه واقعی) |
| تست آفلاین‌بودن پس از نصب مدل | ❌ انجام نشده |

> **رفع یک باگ مهم:** در نسخهٔ قبلی، worker آدرس فایل‌ها را با `new URL('encoder.int8.onnx', '/models/shenava/')` می‌ساخت. مرورگرها پایهٔ **نسبی** را نمی‌پذیرند و این خط خطای `Invalid base URL` می‌داد؛ یعنی موتور آفلاین حتی با نصب‌بودن مدل هم هرگز شروع نمی‌شد. حالا همهٔ آدرس‌ها با `resolveShenavaWorkerUrls()` نسبت به `location.href` **مطلق** ساخته می‌شوند و این تابع (به‌جای کد درون worker) تست واحد دارد.

دلیل نبود مدل **در همین محیط توسعه**: خروجی `curl` از این محیط برای هر دو میزبان مدل، خطای شبکه است (بدون VPN):

```
huggingface.co           -> HTTP 000   (curl: (35) TLS handshake failure)
cdn-lfs.huggingface.co   -> HTTP 000
```

این محدودیت فقط مربوط به همین فضای کاری است؛ روی GitHub runner مدل واقعاً دانلود و تأیید شد (بخش «شواهد») و همان مسیر در build ورسل هم اجرا می‌شود. بنابراین موتور در این محیط در وضعیت «مدل نصب نشده» تست شده است: دکمهٔ میکروفن آفلاین غیرفعال می‌شود، پیام «موتور تشخیص گفتار آفلاین در دسترس نیست. از ورودی متنی استفاده کنید.» نمایش داده می‌شود و ورودی متنی و «اجرای دستور» بدون تغییر کار می‌کنند. **تا اجرای واقعی روی یک دستگاه (iPhone Safari / Android Chrome)، هیچ ادعایی دربارهٔ کیفیت تشخیص یا سرعت قابل ارائه نیست.**

### چک‌لیست تست دستی روی دستگاه

۱. `npm run dev` روی رایانه‌ای با اینترنت و اجرای `npm run model:download`.
۲. باز کردن `/test-shenava.html` روی iPhone (Safari) و Android (Chrome): بررسی «موجود بودن مدل: موجود» و «Cross-Origin Isolated: بله».
۳. «شروع ضبط» → گفتن «سلام حال شما خوبه» → «توقف و تبدیل» → باید همین جمله (با املای فارسی) در کادر بیاید.
۴. ثبت زمان‌ها: `featureMs`، `encoderMs`، `decodeMs`، `totalMs` (هدف: کمتر از ۳ ثانیه برای فرمان پنج‌کلمه‌ای روی iPhone 12 و بالاتر).
۵. تکرار تست پس از قطع اینترنت (حالت پرواز) و رفرش صفحه: نباید درخواست مدل دوباره انجام شود.
۶. تست در فرم فاکتور: گفتن «دو عدد برنج هاشمی اضافه کن» → متن داخل ورودی می‌آید، ردیف‌های موجود دست‌نخورده می‌مانند و تا زدن «اجرای دستور» چیزی تغییر نمی‌کند.

## رفع اشکال

- **خطای `Invalid base URL` یا «آدرس قابل تجزیه نیست»**: هیچ آدرسی نباید نسبت به یک مسیر نسبی حل شود. `resolveShenavaWorkerUrls()` را ببینید؛ ورودی‌اش `baseHref` مطلق (`location.href`) است.
- **`crossOriginIsolated === false`**: هدرهای COOP/COEP را در همان میزبان بررسی کنید (`curl -I`). در توسعه، سرور Vite خودش این هدرها را می‌فرستد.
- **خروجی بی‌معنا**: مدل باید `model_type = nemo_transducer` و `normalize_type=""` باشد (همین export استفاده شده). اگر در چشم‌انداز آینده مدل عوض شد، `features.ts` و `rnnt.ts` جاهای تغییر تنظیمات‌اند.
- **کرش Safari روی حافظهٔ کم**: در صفحهٔ تشخیص، دکمهٔ «آزادسازی حافظه» سشن‌ها را می‌بندد؛ در کد اصلی هم `dispose()` همین کار را می‌کند. برای دستگاه‌های کم‌حافظه `threads: 1` بگذارید.
- **دانلود ناقص مدل**: اسکریپت دانلود و مسیر مرورگر هر دو حجم و SHA-256 را بررسی می‌کنند؛ پیام خطا نام فایل و علت را می‌گوید.
- **HTTP status دانلود**: در شبکه‌های محدود `curl -I https://huggingface.co` را اجرا کنید؛ اگر `000` بود، دسترسی شبکه بسته است (VPN راه‌حل ما نیست).

## بازگردانی (Rollback)

هیچ بخشی از منطق فاکتور یا دستورها تغییر نکرده است؛ تغییرات موتور گفتار آفلاین جدا هستند و در صورت نیاز با `git revert` قابل بازگشت‌اند. برای خاموش‌کردن سریع بدون تغییر کد، `SHENAVA_MODEL_DOWNLOAD=0` را در Environment Variables بگذارید: مدل دانلود نمی‌شود، دکمهٔ میکروفن آفلاین غیرفعال می‌ماند و رفتار قبلی (Web Speech API + ورودی متنی) دست‌نخورده کار می‌کند.
