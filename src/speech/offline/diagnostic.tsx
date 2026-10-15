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
import { OFFLINE_SPEECH_MESSAGES } from './offlineSpeechMessages'
import { ShenavaRecognizer } from './ShenavaRecognizer'
import { shenavaModelUrl, type ShenavaModelAvailability } from './shenavaModel'
import type { ShenavaEngineInfo, ShenavaMetrics } from './shenavaProtocol'

const ACCEPTED_SENTENCE = 'سلام حال شما خوبه'

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-row"><span>{label}</span><strong>{value}</strong></div>
  )
}

function DiagnosticPage() {
  const [availability, setAvailability] = useState<ShenavaModelAvailability | null>(null)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [info, setInfo] = useState<ShenavaEngineInfo | null>(null)
  const [metrics, setMetrics] = useState<ShenavaMetrics | null>(null)
  const [text, setText] = useState('')
  const [cancelRequested, setCancelRequested] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [log, setLog] = useState<string[]>([])
  const [modelSource, setModelSource] = useState<'local' | 'hub' | null>(null)

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
    void engine().probe().then((result) => {
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
    const result = await engine().probe()
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
        <h2>۱) وضعیت مدل و محیط</h2>
        <MetricRow label="مسیر مدل" value={shenavaModelUrl('encoder.int8.onnx', import.meta.env.BASE_URL)} />
        <MetricRow label="موجود بودن مدل" value={availability === null ? 'در حال بررسی…' : availability.available ? 'موجود' : `ناقص (${availability.missing.join(', ') || 'نامشخص'})`} />
        <MetricRow label="منبع مدل" value={modelSource === 'hub' ? 'نصب‌نشده؛ دانلود یک‌بار از Hugging Face' : modelSource === 'local' ? 'کنار خود برنامه' : '—'} />
        <MetricRow label="Cross-Origin Isolated" value={isolated ? 'بله (چندرشته‌ای)' : 'خیر (تک‌رشته‌ای و کندتر)'} />
        <MetricRow label="hardwareConcurrency" value={String(navigator.hardwareConcurrency ?? 0)} />
        <MetricRow label="threads مورد استفادهٔ ORT" value={info ? String(info.threads) : '—'} />
        <MetricRow label="blankId / vocab" value={info ? `${info.blankId} / ${info.vocabSize}` : '—'} />
        <MetricRow label="منبع فایل‌ها" value={info ? Object.entries(info.sources).map(([file, source]) => `${file}=${source}`).join('، ') : '—'} />
        {!availability?.available && (
          <p className="hint">
            برای نصب مدل، روی رایانه‌ای با اینترنت: <code>npm run model:download</code> — سپس فایل‌ها در
            <code> public/models/shenava/</code> قرار می‌گیرند و در گیت ذخیره نمی‌شوند.
          </p>
        )}
        {modelSource === 'hub' && (
          <p className="hint">{OFFLINE_SPEECH_MESSAGES.remoteModelDownload}</p>
        )}
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
