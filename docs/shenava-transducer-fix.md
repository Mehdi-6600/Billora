# رفع اشکال شکل تنسورهای RNNT — خطای `decoder_outputs` روی دستگاه

**علامت:** روی Chrome (گوشی/دسکتاپ) موتور با این پیام متوقف می‌شد:

```
failed to call OrtRun(). ERROR_CODE: 2, ERROR_MESSAGE: Got invalid dimensions for input:
decoder_outputs for the following indices
 index: 1 Got: 1 Expected: 640
 Please fix either the inputs/outputs or the model.
```

**علت (تأییدشده با فایل واقعی، نه حدس):** شبکهٔ پیوند (joiner) هر دو ورودی را کانال‌اول با
ترتیب `(B, D, T)` می‌گیرد — همان‌طور که NeMo در `RNNTJoint.input_types` تعریف می‌کند
(`nemo/collections/asr/modules/rnnt.py`) و همان‌طور که sherpa-onnx خروجی دیکودر را دست‌نخورده به
joiner می‌دهد. پس برای پیش‌بین ۶۴۰ بعدی، `decoder_outputs` باید `[1, 640, 1]` باشد. کد قبلی
`[1, 1, 640]` می‌فرستاد؛ یعنی دو بُعد جابه‌جا شده بودند و ONNX Runtime دقیقاً همان
«index: 1 → Got: 1, Expected: 640» را می‌داد.

نکتهٔ مهم: این خطا **mismatch رتبه نیست** بلکه mismatch اندازه در همان رتبه است. با آزمایش واقعی
روی ONNX Runtime تأیید شد که رتبهٔ نادرست پیام دیگری می‌دهد
(`Invalid rank for input: decoder_outputs Got: 3 Expected: 2`) و اندازهٔ نادرست همان پیام گزارش‌شده
را می‌دهد؛ پس فرض «context_size = 640» درست نبود: عدد ۶۴۰ همان `pred_hidden` (پهنای پیش‌بین) است.
همچنین `context_size` در متادیتای دیکودر وجود ندارد (پایین‌تر، لاگ واقعی).

## امضای واقعی مدل (از فایل‌های واقعی، اجرای CI `38733432134`)

```
[real] decoder.int8.onnx inputs { targets:int32[?,?] target_length:int32[?]
       states.1:float32[1,?,640] onnx::LSTM_3:float32[1,1,640] }
       outputs { outputs:float32[?,640,?] prednet_lengths:int32[?]
       states:float32[1,?,640] 74:float32[1,?,640] }
[real] joiner.int8.onnx inputs { encoder_outputs:float32[?,512,?] decoder_outputs:float32[?,640,?] }
       outputs { outputs:float32[?,?,?,1025] }
[real] decoder metadata {"onnx.infer":"onnxruntime.quant","vocab_size":"1024","normalize_type":"",
       "pred_rnn_layers":"1","pred_hidden":"640","subsampling_factor":"8",
       "model_type":"EncDecHybridRNNTCTCBPEModel","version":"1","model_author":"Reza2kn / VisualEars",
       "url":"https://huggingface.co/Reza2kn/Shenava-Koochik-v1.5",
       "comment":"Offline RNNT (transducer) branch of Shenava Koochik v1.5"}
[real] encoder metadata: vocab_size=1024 pred_hidden=640 pred_rnn_layers=1 encoder_dim=512 subsampling_factor=8
```

خواندن این خطوط به‌تنهایی علت را نشان می‌دهد: `decoder_outputs` **`[?, 640, ?]`** است، یعنی بُعد
وسط باید ۶۴۰ باشد — و کد قبلی آن را ۱ می‌فرستاد. نام ورودی‌های حالت هم `states.1` و
`onnx::LSTM_3` است (نه `input_states_1`)، پس خوراک‌دهی باید **بر اساس ترتیب** باشد، نه نام؛ کد فعلی
همین کار را می‌کند.

## اصلاح

1. **`src/speech/offline/transducerShape.ts`** (جدید، خالص و تست‌پذیر): شکل هر خوراک از روی
   `InferenceSession.inputMetadata` ساخته می‌شود. ابعاد پویا در ONNX Runtime Web عدد
   `4294967295` (همان `-1`) یا رشتهٔ نمادین‌اند و «نامعلوم» در نظر گرفته می‌شوند. این ماژول هر سه
   قالب رایج را پشتیبانی می‌کند:
   - پیش‌بین با حالت LSTM: `targets [1, 1]`، `target_length [1]`، حالت‌ها `[layers, 1, hidden]`
   - پیش‌بین با پنجرهٔ context: `targets [1, context_size]` که با توکن blank پر می‌شود و با هر گام
     توکن تازه به انتهای پنجره اضافه می‌شود (`context_size` از شکل ورودی و در صورت پویا‌بودن از
     متادیتای `context_size`/`context`)
   - joiner: `encoder_outputs [1, dim, 1]` و `decoder_outputs [1, hidden, 1]` (کانال‌اول)، با
     نگه‌داشتن ترتیب‌های دیگر به‌عنوان گزینهٔ پشتیبان برای exportهای متفاوت
2. **`src/speech/offline/transducerRuntime.ts`** (جدید): همین منطق از worker جدا شد تا همان مسیر کد
   با ONNX Runtime واقعی تست شود. قبل از اولین اجرای هر session، نام/نوع/شکل همهٔ ورودی‌ها و
   خروجی‌ها و «تنسورهایی که ساخته می‌شوند» در کنسول چاپ می‌شود:

   ```
   [shenava] decoder.int8.onnx inputs: targets: int32[?, ?], target_length: int32[?], …
   [shenava] joiner.int8.onnx inputs: encoder_outputs: float32[?, 512, ?], decoder_outputs: float32[?, 640, ?]
   [shenava] decoder.int8.onnx metadata: {"vocab_size":"1024","pred_hidden":"640", …}
   [shenava] predictor: states · context=1 (from default) · targets int32[1, 1] · states [1, 1, 640] [1, 1, 640]
   [shenava] joiner shapes: encoder_outputs [1, 512, 1] · decoder_outputs [1, 640, 1]
   [shenava] predictor run · targets: int32[1, 1] · target_length: int32[1] · states.1: float32[1, 1, 640] · …
   [shenava] joiner run · encoder_outputs: float32[1, 512, 1] · decoder_outputs: float32[1, 640, 1]
   ```

   همین خطوط روی صفحهٔ تشخیص (`/test-shenava.html`) هم در ردیف «شکل تنسورهای RNNT» دیده می‌شوند.
3. **`blank_id`**: اول از متادیتای دیکودر (`blank_id`/`blank_idx`) و در نبود آن از آخرین شناسهٔ
   `tokens.txt` گرفته می‌شود (برای این مدل ۱۰۲۴ = `vocab_size` متادیتا). تنسور اولیهٔ پیش‌بین با
   همین شناسه پر می‌شود.
4. **`src/speech/offline/rnnt.ts`**: می‌تواند `blankId` را صریح بگیرد (پیش‌تر همیشه `vocabSize-1`).

## تست‌ها (اجرای واقعی، بدون شبیه‌سازی نتیجه)

- `src/speech/offline/transducerShape.test.ts` — ۱۷ تست خالص روی انتخاب شکل‌ها.
- `src/speech/offline/transducerRuntime.test.ts` — ۵ تست روی **ONNX Runtime واقعی** با مدل‌های
  کوچکِ ساخته‌شده در حافظه (`__fixtures__/tinyOnnx.ts`) که امضای همین مدل را دارند:
  - خوراک قدیمی `[1, 1, 640]` با همان پیام دستگاه رد می‌شود (متن خطا کلمه‌به‌کلمه یکی است)،
  - خوراک ساخته‌شده از `inputMetadata` یعنی `[1, 640, 1]` پذیرفته می‌شود،
  - کل زنجیره روی ویژگی‌های mel یک صدای کوتاه اجرا می‌شود و شکل‌ها بررسی می‌شوند.
- `src/speech/offline/shenavaRealModel.test.ts` — روی **فایل‌های واقعی** (در CI با دانلود مدل):
  امضاها را چاپ می‌کند، تکه‌های انکودر را با همان `assembleModelParts` مرورگر به هم می‌چسباند
  (`131342912` بایت، `sha256=b9d975c1…fdd3`)، یک گام پیش‌بین و یک گام joiner واقعی را اجرا می‌کند
  (`predictor out=640 · joiner logits=1025 · blank=1024`) و با `SHENAVA_REAL_ENCODER=1` یک صدای
  کوچک را از mel تا دیکود کامل می‌گذراند (`encoder output: [1, 512, 8]`).

اجرای محلی صادقانه: در این جعبهٔ شبیه‌ساز دسترسی به Hugging Face نیست، پس تست فایل واقعی
«skip» می‌شود؛ همان تست در CI (اجرای `38733432134`) واقعی و سبز است و لاگش در Issue #8 ثبت شده.

## نکتهٔ جانبی که در همین مسیر پیدا و رفع شد

`node scripts/download-shenava-model.mjs --check` (که `prebuild`/CI بعد از دانلود اجرا می‌کند)
حالت «هیچ فایلی تقسیم نشده» را می‌دید و فایل `model-parts.json` را **پاک می‌کرد**؛ یعنی یک بررسی
فقط‌خواندنی وضعیت build را خراب می‌کرد. حالا `--check` هیچ چیزی نمی‌نویسد و حذف نمی‌کند و یک تست
(`scripts/download-shenava-model.test.mjs`) ماندن manifest را تضمین می‌کند.
