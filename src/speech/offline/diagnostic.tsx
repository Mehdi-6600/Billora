/**
 * Standalone diagnostic page for the offline engine (`/test-shenava.html`).
 *
 * Vite serves every HTML file in the project root during `npm run dev`, so this page exists purely
 * for the "does the on-device model actually work here?" check on a real phone: it shows model
 * availability, cross-origin isolation, thread count, per-stage latency and the raw transcript.
 * The page is not part of the production build and does not touch invoices or commands.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createMicCapture, type MicCapture } from './audioCapture'
import { detectIosLike, resolveActiveEngine, type SpeechEnvironment } from './engineSelection'
import { OFFLINE_SPEECH_MESSAGES } from './offlineSpeechMessages'
import { ShenavaRecognizer } from './ShenavaRecognizer'
import {
  configuredRemoteBaseUrl,
  shenavaModelUrl,
  SHENAVA_REMOTE_BASE_ENV,
  type ShenavaDetailedAvailability,
  type ShenavaFileReport,
} from './shenavaModel'
import type { ShenavaEngineInfo, ShenavaMetrics } from './shenavaProtocol'

const ACCEPTED_SENTENCE = 'سلام حال شما خوبه'

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const STATE_LABELS: Record<string, string> = {
  ok: 'موجود',
  absent: 'غایب',
  unreachable: 'دسترس‌ناپذیر',
  'not-checked': 'بررسی نشده',
}

function FileTable({ files }: { files: ShenavaFileReport[] }) {
  return (
    <table className="files">
      <thead>
        <tr>
          <th>فایل</th>
          <th>حجم مورد انتظار</th>
          <th>روی همین دامنه</th>
          <th>روی میزبان بیرونی</th>
          <th>وضعیت نهایی</th>
          <th>تکه‌ها</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => {
          const usable = file.local === 'ok' || file.remote === 'ok'
          return (
            <tr key={file.name}>
              <td dir="ltr">{file.name}</td>
              <td>{formatBytes(file.expectedBytes)}</td>
              <td>{STATE_LABELS[file.local] ?? file.local} ({formatBytes(file.localBytes)})</td>
              <td>
                {file.remote === 'not-checked'
                  ? '—'
                  : `${STATE_LABELS[file.remote] ?? file.remote} (${formatBytes(file.remoteBytes)})`}
              </td>
              <td>{usable ? '✅ قابل استفاده' : '❌ ناموجود'}</td>
              <td>
                {file.parts ? (
                  <>
                    {`${file.parts} تکه (جمع ${formatBytes(file.expectedBytes)})`}
                    {file.partsState && file.partsState !== 'ok'
                      ? ` — مشکل: ${STATE_LABELS[file.partsState] ?? file.partsState}`
                      : ''}
                    {file.partsUrl ? (
                      <>
                        {' '}
                        <code dir="ltr">{file.partsUrl.split('/').pop()}</code>
                      </>
                    ) : null}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-row"><span>{label}</span><strong>{value}</strong></div>
  )
}

function DiagnosticPage() {
  const [availability, setAvailability] = useState<ShenavaDetailedAvailability | null>(null)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [info, setInfo] = useState<ShenavaEngineInfo | null>(null)
  const [metrics, setMetrics] = useState<ShenavaMetrics | null>(null)
  const [text, setText] = useState('')
  const [cancelRequested, setCancelRequested] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [modelSource, setModelSource] = useState<'local' | 'hub' | 'mixed' | null>(null)

  const recognizerRef = useRef<ShenavaRecognizer | null>(null)
  const captureRef = useRef<MicCapture | null>(null)

  const appendLog = useCallback((line: string) => {
    setLog((entries) => [`${new Date().toLocaleTimeString('fa-IR')} · ${line}`, ...entries].slice(0, 20))
  }, [])

  const engine = useCallback(() => {
    if (!recognizerRef.current) {
      recognizerRef.current = new ShenavaRecognizer({
        baseUrl: import.meta.env.BASE_URL,
        logger: (logMessage, details) => appendLog(`${logMessage} ${details ? JSON.stringify(details) : ''}`.trim()),
      })
    }
    return recognizerRef.current
  }, [appendLog])

  useEffect(() => {
    const isolated = typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false
    if (!isolated) console.error('[Shenava] Cross-origin isolation missing. WASM will run on 1 thread.')
    void engine().probeFiles().then((result) => {
      setAvailability(result)
      setModelSource(result.source ?? null)
      appendLog(result.available ? 'مدل روی همین دامنه پیدا شد.' : `مدل ناقص است: ${result.missing.join(', ')}`)
    })
    return () => {
      captureRef.current?.cancel()
      recognizerRef.current?.dispose()
      recognizerRef.current = null
    }
  }, [appendLog, engine])

  const checkModel = async () => {
    const result = await engine().probeFiles()
    setAvailability(result)
    setModelSource(result.source ?? null)
    appendLog(result.available ? 'بررسی مدل: موجود' : `بررسی مدل: ناقص (${result.missing.join(', ')})`)
  }

  const startEngine = async () => {
    setStatus('loading')
    setMessage(OFFLINE_SPEECH_MESSAGES.preparing)
    try {
      const engineInfo = await engine().init()
      setInfo(engineInfo)
      setStatus('ready')
      setMessage(OFFLINE_SPEECH_MESSAGES.ready)
      appendLog(`موتور آماده شد: threads=${engineInfo.threads} blank=${engineInfo.blankId}`)
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : OFFLINE_SPEECH_MESSAGES.initFailed)
      appendLog(`خطای راه‌اندازی: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const startRecording = async () => {
    try {
      if (recognizerRef.current?.status !== 'ready') await startEngine()
      const capture = await createMicCapture({ onProgress: (samples) => setSeconds(samples / 16_000) })
      captureRef.current = capture
      setCancelRequested(false)
      setSeconds(0)
      setStatus('listening')
      setMessage(OFFLINE_SPEECH_MESSAGES.listening)
      appendLog('ضبط شروع شد.')
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : OFFLINE_SPEECH_MESSAGES.noMicrophone)
    }
  }

  const stopAndTranscribe = async () => {
    const capture = captureRef.current
    if (!capture) return
    captureRef.current = null
    setStatus('transcribing')
    setMessage(OFFLINE_SPEECH_MESSAGES.transcribing)
    try {
      const pcm = await capture.stop()
      appendLog(`ضبط تمام شد: ${(pcm.length / 16_000).toFixed(1)} ثانیه`)
      if (pcm.length < 1_600) {
        setStatus('error')
        setMessage(OFFLINE_SPEECH_MESSAGES.noAudio)
        return
      }
      const transcript = await engine().transcribe(pcm)
      setText(transcript.text)
      setMetrics(transcript.metrics)
      setStatus('result')
      setMessage(transcript.text.trim() ? OFFLINE_SPEECH_MESSAGES.done : OFFLINE_SPEECH_MESSAGES.noSpeech)
      appendLog(`نتیجه: «${transcript.text}» در ${Math.round(transcript.metrics.totalMs)} میلی‌ثانیه`)
    } catch (error) {
      setStatus('error')
      setMessage(error instanceof Error ? error.message : OFFLINE_SPEECH_MESSAGES.decodeFailed)
      appendLog(`خطای تبدیل: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const cancelAll = () => {
    captureRef.current?.cancel()
    captureRef.current = null
    setCancelRequested(true)
    setStatus(recognizerRef.current?.status === 'ready' ? 'ready' : 'idle')
    setMessage('ضبط لغو شد.')
  }

  const release = () => {
    captureRef.current?.cancel()
    captureRef.current = null
    recognizerRef.current?.dispose()
    recognizerRef.current = null
    setInfo(null)
    setMetrics(null)
    setStatus('idle')
    setMessage('موتور آزاد شد؛ حافظهٔ مدل رها شد.')
    appendLog('موتور آزاد شد.')
  }

  const isolated = typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false
  const listening = recognizerRef.current !== null && captureRef.current !== null
  const webSpeechSupported = typeof window !== 'undefined'
    && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition)
  const environment: SpeechEnvironment = {
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    platform: typeof navigator === 'undefined' ? '' : (navigator.platform ?? ''),
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
    webSpeechAvailable: webSpeechSupported,
    webSpeechServiceUnavailable: false,
    offlineAvailable: availability?.available ?? false,
    preference: 'auto',
  }
  const chosenEngine = resolveActiveEngine(environment)
  const engineDecision = {
    label: !availability?.available
      ? 'فقط ورودی متنی و Web Speech API (موتور آفلاین در دسترس نیست)'
      : chosenEngine === 'offline'
        ? 'تشخیص گفتار آفلاین روی دستگاه (شنوا)'
        : 'موتور گفتار مرورگر (Web Speech API)',
    reason: !availability?.available
      ? 'مدل نصب نیست یا فایل‌ها خوانده نمی‌شوند'
      : chosenEngine === 'offline'
        ? (detectIosLike(environment)
            ? 'دستگاه iOS است؛ سرویس فارسی Web Speech در آن وجود ندارد'
            : 'گزینهٔ آفلاین به‌صورت دستی انتخاب شده است')
        : 'این مرورگر Web Speech دارد؛ گزینهٔ آفلاین با کلید «آفلاین» قابل انتخاب است',
  }

  return (
    <div className="wrap">
      <header>
        <h1>آزمایش موتور تشخیص گفتار آفلاین شنوا</h1>
        <p className="lead">
          این صفحه فقط برای تست است. اگر متن «{ACCEPTED_SENTENCE}» را ببینید، موتور آفلاین روی این دستگاه کار می‌کند.
          صفحهٔ فاکتور از همین موتور استفاده می‌کند، ولی اینجا هیچ دستوری اجرا نمی‌شود.
        </p>
      </header>

      <section className="card">
        <h2>۱) وضعیت موتور و مدل</h2>
        <MetricRow label="موتور فعال در فرم فاکتور" value={engineDecision.label} />
        <MetricRow label="دلیل انتخاب" value={engineDecision.reason} />
        <MetricRow label="Web Speech API در این مرورگر" value={webSpeechSupported ? 'در دسترس' : 'در دسترس نیست'} />
        <MetricRow label="مدل آفلاین" value={availability === null ? 'در حال بررسی…' : availability.available ? 'قابل استفاده' : 'قابل استفاده نیست'} />
        <MetricRow label="منبع مدل" value={availability?.source === 'local' ? 'کنار خود برنامه' : availability?.source === 'hub' ? 'دانلود یک‌بار از میزبان بیرونی' : availability?.source === 'mixed' ? 'بخشی همراه برنامه، بقیه از میزبان بیرونی' : '—'} />
        <MetricRow label="میزبان بیرونی مدل" value={configuredRemoteBaseUrl() ?? 'Hugging Face (پیش‌فرض)'} />
        {availability !== null && <div className="table-wrap"><FileTable files={availability.files} /></div>}
        {availability !== null && !availability.available && (
          <p className="hint">فایل‌های ناموجود: {availability.missing.join('، ') || 'نامشخص'}</p>
        )}
        <h3>محیط اجرا</h3>
        <MetricRow label="مسیر مدل" value={shenavaModelUrl('encoder.int8.onnx', import.meta.env.BASE_URL)} />
        <MetricRow label="موجود بودن مدل" value={availability === null ? 'در حال بررسی…' : availability.available ? 'موجود' : `ناقص (${availability.missing.join(', ') || 'نامشخص'})`} />
        <MetricRow label="منبع مدل" value={modelSource === 'local' ? 'کنار خود برنامه (تکه‌ها هم همین‌جا)' : modelSource === 'hub' ? 'نصب‌نشده؛ دانلود یک‌بار از Hugging Face' : modelSource === 'mixed' ? 'بخشی همراه برنامه، بقیه یک‌بار از Hugging Face' : '—'} />
        <MetricRow
          label="فایل تقسیم‌شده"
          value={
            availability === null
              ? '—'
              : availability.files.some((file) => file.parts)
                ? availability.files
                    .filter((file) => file.parts)
                    .map((file) => `${file.name}: ${file.parts} تکه`)
                    .join(' · ')
                : 'ندارد (همهٔ فایل‌ها یکجا سرو می‌شوند)'
          }
        />
        <MetricRow label="Cross-Origin Isolated" value={isolated ? 'بله (چندرشته‌ای)' : 'خیر (تک‌رشته‌ای و کندتر)'} />
        <MetricRow label="hardwareConcurrency" value={String(navigator.hardwareConcurrency ?? 0)} />
        <MetricRow label="iOS-like" value={detectIosLike(environment) ? 'بله' : 'خیر'} />
        {configuredRemoteBaseUrl() === null && (
          <p className="hint">
            برای استفاده از میزبان دیگر (GitHub Release، Vercel Blob، R2 و …) مقدار
            <code> {SHENAVA_REMOTE_BASE_ENV}</code> را در زمان build تنظیم کنید.
          </p>
        )}
        <MetricRow label="threads مورد استفادهٔ ORT" value={info ? String(info.threads) : '—'} />
        <MetricRow label="blankId / vocab" value={info ? `${info.blankId} / ${info.vocabSize}` : '—'} />
        <MetricRow label="منبع فایل‌ها" value={info ? Object.entries(info.sources).map(([file, source]) => `${file}=${source}`).join('، ') : '—'} />
        <MetricRow label="شکل تنسورهای RNNT" value={info?.transducerPlan ?? '—'} />
        {!availability?.available && (
          <p className="hint">
            برای نصب مدل، روی رایانه‌ای با اینترنت: <code>npm run model:download</code> — سپس فایل‌ها در
            <code> public/models/shenava/</code> قرار می‌گیرند و در گیت ذخیره نمی‌شوند.
          </p>
        )}
        {modelSource === 'hub' && <p className="hint">{OFFLINE_SPEECH_MESSAGES.remoteModelDownload}</p>}
        {modelSource === 'mixed' && <p className="hint">{OFFLINE_SPEECH_MESSAGES.remoteModelPartial}</p>}
      </section>

      <section className="card">
        <h2>۲) ضبط و تبدیل</h2>
        <div className="row">
          <button type="button" onClick={() => void startEngine()}>راه‌اندازی موتور</button>
          <button type="button" className="primary" onClick={() => void startRecording()} disabled={status === 'listening' || status === 'transcribing'}>
            شروع ضبط
          </button>
          <button type="button" onClick={() => void stopAndTranscribe()} disabled={!listening}>توقف و تبدیل</button>
          <button type="button" onClick={cancelAll}>لغو</button>
          <button type="button" onClick={() => { setText(''); setMetrics(null) }}>پاک کردن</button>
          <button type="button" onClick={release}>آزادسازی حافظه</button>
          <button type="button" onClick={() => void checkModel()}>بررسی دوبارهٔ مدل</button>
        </div>
        <p className="status" role="status">
          وضعیت: {status}
          {status === 'listening' && ` · ${seconds.toFixed(1)} ثانیه`}
          {cancelRequested && ' · لغو شده'}
        </p>
        {message && <p className="message">{message}</p>}
        <label className="field">
          <span>متن تشخیص‌داده‌شده</span>
          <textarea dir="rtl" rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="این‌جا نمایش داده می‌شود" />
        </label>
        <p className="verdict">
          {text.trim() === ACCEPTED_SENTENCE
            ? '✅ معیار موفقیت برآورده شد: جملهٔ «سلام حال شما خوبه» درست تشخیص داده شد.'
            : text.trim()
              ? `ℹ️ متن دریافت شد: «${text.trim()}» — آن را با جملهٔ «${ACCEPTED_SENTENCE}» مقایسه کنید.`
              : 'منتظر ضبط هستم…'}
        </p>
      </section>

      <section className="card">
        <h2>۳) کارایی و لاگ</h2>
        {metrics
          ? (
              <>
                <MetricRow label="طول صدا" value={`${Math.round(metrics.audioMs)} ms`} />
                <MetricRow label="ویژگی (log-mel)" value={`${metrics.featureMs.toFixed(1)} ms · ${metrics.featureFrames} فریم`} />
                <MetricRow label="انکودر" value={`${metrics.encoderMs.toFixed(1)} ms · ${metrics.encoderFrames} فریم خروجی`} />
                <MetricRow label="دیکود RNNT" value={`${metrics.decodeMs.toFixed(1)} ms · ${metrics.tokens} توکن`} />
                <MetricRow label="کل زمان" value={`${Math.round(metrics.totalMs)} ms`} />
                <MetricRow label="معیار iPhone 12 به بالا" value={metrics.totalMs < 3_000 ? '✅ کمتر از ۳ ثانیه' : '⚠️ بیشتر از ۳ ثانیه'} />
              </>
            )
          : <p className="hint">پس از اولین تبدیل، زمان هر مرحله اینجا و در کنسول مرورگر لاگ می‌شود.</p>}
        <ul className="log">
          {log.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
        </ul>
      </section>
    </div>
  )
}

const container = document.getElementById('root')
if (container) createRoot(container).render(<DiagnosticPage />)
