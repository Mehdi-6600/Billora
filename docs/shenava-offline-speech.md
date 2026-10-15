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
| `src/speech/offline/diagnostic.tsx` + `test-shenava.html` | صفحهٔ تست مستقل با نمایش زمان هر مرحله |

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

#### بررسی وضعیت

پس از deploy، این آدرس را باز کنید:

```
https://<your-app>.vercel.app/models/shenava/encoder.int8.onnx
```

باید **خودِ فایل** دانلود شود (نه HTML). اگر HTML برگشت یعنی مدل کنار برنامه نیست؛ لاگ build را ببینید: در مرحلهٔ `prebuild` باید خطوط `GET`/`OK`/`CACHE` برای هر فایل دیده شود.

#### عیب‌یابی

| نشانه | راه‌حل |
| --- | --- |
| لاگ `FAIL ... HTTP 403/404` | فایل‌ها در مخزن بالا نیستند یا revision عوض شده؛ مخزن و نام فایل‌ها را بررسی کنید |
| لاگ `FAIL ... fetch failed` | شبکهٔ build به Hugging Face دسترسی ندارد → `HF_ENDPOINT=https://hf-mirror.com` را به‌عنوان Environment Variable در Vercel بگذارید (می‌شود چند میزبان با کاما داد) |
| build خیلی طول می‌کشد | بار اول طبیعی است (چند دقیقه برای ۱۳۷ مگابایت)؛ بارهای بعد از کش `node_modules/.cache` استفاده می‌شود |
| استقرار با خطای حجم شکست می‌خورد | پلن Hobby ورسل برای «آپلود فایل استاتیک» سقف ۱۰۰ مگابایت دارد. با `SHENAVA_MODEL_MAX_BUILD_BYTES=100000000` فقط فایل‌های کوچک همراه build می‌آیند و انکودر بزرگ (۱۳۱ مگابایت) بار اول توسط مرورگر از Hugging Face گرفته و روی دستگاه کش می‌شود. با `SHENAVA_MODEL_DOWNLOAD=0` هم می‌توان کل دانلود را به مرورگر سپرد |
| می‌خواهید مدل اصلاً همراه build نباشد | `SHENAVA_MODEL_DOWNLOAD=0` |

متغیرهای محیطی پشتیبانی‌شده: `HF_ENDPOINT` (یک یا چند میزبان با کاما)، `SHENAVA_MODEL_DOWNLOAD` (`0` = خاموش)، `SHENAVA_MODEL_MAX_BUILD_BYTES` (سقف حجم فایل‌هایی که همراه build می‌آیند)، `SHENAVA_MODEL_DIR`، `SHENAVA_MODEL_CACHE_DIR` و `SHENAVA_MODEL_MANIFEST` (برای تست یا mirror با فایل‌های دیگر).

روی **GitHub Pages** دانلود به‌طور پیش‌فرض خاموش است (`GITHUB_PAGES=true`): آن میزبان نمی‌تواند هدرهای COOP/COEP بفرستد و افزودن ۱۳۷ مگابایت به آرتیفکت Pages هم منطقی نیست. اگر لازم شد، با `SHENAVA_MODEL_DOWNLOAD=1` می‌توان اجبار کرد.

| فایل | حجم (بایت) | SHA-256 |
| --- | --- | --- |
| `encoder.int8.onnx` | ۱۳۱٬۳۴۲٬۹۱۲ | `b9d975c1af77002f83897017e3adaaa6510148c6ba332df92b8d281369f2fdd3` |
| `decoder.int8.onnx` | ۳٬۹۵۶٬۱۹۴ | `0adaad326a536dfbb30c67287e909b4e6f0775fccb8c3ca47270890364824947` |
| `joiner.int8.onnx` | ۱٬۴۰۸٬۵۱۴ | `e441ed265c961ff4a2436aa8bc36638e65849445e7a1f65cf263f0c310593dde` |
| `tokens.txt` | ۱۲٬۲۳۶ | — (LFS نیست) |

۲) دانلود خودکار در مرورگر (یک‌بار): اگر فایل‌ها کنار برنامه نباشند، مرورگر خودش همان چهار فایل را از مخزن Hugging Face می‌گیرد، حجم و SHA-256 را بررسی می‌کند و در Cache API نگه می‌دارد؛ دفعهٔ بعد کاملاً آفلاین است. با `allowRemoteModel: false` می‌توان این مسیر را بست و فقط URLهای هم‌مبدأ را مجاز دانست. در این مسیر هیچ صدایی جابه‌جا نمی‌شود؛ فقط وزن‌های مدل دانلود می‌شود.

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
| تست‌های نصب‌کنندهٔ مدل (۲۴ تست، با سرور HTTP محلی) | ✅ `npm test` → `node --test scripts/…` |
| `npm run typecheck` | ✅ |
| `npm run build` + بررسی خروجی `dist/assets` | ✅ (با مدل غایب: هشدار و ادامهٔ build) |
| دانلود خودکار در build با میزبان واقعی (Hugging Face) | ⚠️ از این محیط ممکن نبود: `curl -I https://huggingface.co` → `HTTP 000` — به‌جایش با یک سرور HTTP محلی، همان مسیر کد کامل تست شد |
| استقرار روی Vercel (پرکردن مدل در dist و سرو شدن فایل‌ها) | ⏳ در همین PR بررسی می‌شود؛ وضعیت نهایی در گزارش آمده است |
| اجرای واقعی مدل int8 در مرورگر (با فایل‌های ۱۳۷ مگابایتی) | ❌ انجام نشده — مدل از این محیط دانلود نمی‌شود |
| تست دستی iPhone Safari / Android Chrome | ❌ انجام نشده (نیازمند دستگاه واقعی) |
| تست آفلاین‌بودن پس از نصب مدل | ❌ انجام نشده |

> **رفع یک باگ مهم:** در نسخهٔ قبلی، worker آدرس فایل‌ها را با `new URL('encoder.int8.onnx', '/models/shenava/')` می‌ساخت. مرورگرها پایهٔ **نسبی** را نمی‌پذیرند و این خط خطای `Invalid base URL` می‌داد؛ یعنی موتور آفلاین حتی با نصب‌بودن مدل هم هرگز شروع نمی‌شد. حالا همهٔ آدرس‌ها با `resolveShenavaWorkerUrls()` نسبت به `location.href` **مطلق** ساخته می‌شوند و این تابع (به‌جای کد درون worker) تست واحد دارد.

دلیل نبود مدل: خروجی `curl` از این محیط برای هر دو میزبان مدل، خطای شبکه است (بدون VPN):

```
huggingface.co           -> HTTP 000   (curl: (35) TLS handshake failure)
cdn-lfs.huggingface.co   -> HTTP 000
```

بنابراین موتور در وضعیت «مدل نصب نشده» تست شده است: دکمهٔ میکروفن آفلاین غیرفعال می‌شود، پیام «موتور تشخیص گفتار آفلاین در دسترس نیست. از ورودی متنی استفاده کنید.» نمایش داده می‌شود و ورودی متنی و «اجرای دستور» بدون تغییر کار می‌کنند. **تا نصب مدل و اجرای واقعی روی یک دستگاه، هیچ ادعایی دربارهٔ کیفیت تشخیص یا سرعت قابل ارائه نیست.**

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
