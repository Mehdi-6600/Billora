import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Mic,
  MicOff,
  PackageOpen,
  Plus,
  Printer,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { calculateInvoiceTotals, calculateLineAmounts, formatNumber, formatToman, parseLocalizedNumber } from '../domain/calculations'
import { normalizeProductName, parseCommand, supportedCommandExamples, type ParsedCommand } from '../domain/commands'
import { planCommand, productConfirmation, type ProductCommandAction } from '../domain/command-execution'
import { PersianSpeechSession, getSpeechRecognitionConstructor, type SpeechStatus } from '../domain/speech-recognition'
import { resolveActiveEngine, detectIosLike, type SpeechEnginePreference } from '../speech/offline/engineSelection'
import { OFFLINE_SPEECH_MESSAGES } from '../speech/offline/offlineSpeechMessages'
import { itnForCommand } from '../speech/offline/persianItn'
import { useOfflineSpeech, type OfflineSpeechOptions } from '../speech/offline/useOfflineSpeech'
import type { InvoiceForm, InvoiceLineForm } from '../domain/invoice-form'
import type { Product, ProductDraft } from '../domain/types'
import { createId } from '../utils'

function amountForLine(line: InvoiceLineForm) {
  const quantity = parseLocalizedNumber(line.quantity)
  const unitPrice = parseLocalizedNumber(line.unitPrice)
  const discountPercent = parseLocalizedNumber(line.discountPercent)
  if (quantity === null || unitPrice === null || discountPercent === null || !Number.isSafeInteger(unitPrice) || quantity <= 0 || unitPrice < 0 || discountPercent < 0 || discountPercent > 100) return null
  try {
    return calculateLineAmounts({ quantity, unitPrice, discountPercent })
  } catch {
    return null
  }
}

function newLine(product?: Product, quantity = '1'): InvoiceLineForm {
  return {
    id: createId(),
    productId: product?.id ?? null,
    name: product?.name ?? '',
    unit: product?.unit ?? 'عدد',
    quantity,
    unitPrice: product ? String(product.price) : '0',
    discountPercent: '0',
  }
}

type PendingAction = ProductCommandAction

type TargetPrompt = { command: ParsedCommand; candidates: Product[] }

export function InvoiceEditorPage({
  form,
  products,
  saving,
  hasSaved,
  onChange,
  onSave,
  onBack,
  onPrint,
  onUpdateProduct,
  onDeleteProduct,
  onNotify,
  offlineSpeech,
}: {
  form: InvoiceForm
  products: Product[]
  saving: boolean
  hasSaved: boolean
  onChange: (form: InvoiceForm) => void
  onSave: () => Promise<void>
  onBack: () => void
  onPrint: () => void
  onUpdateProduct: (product: ProductDraft) => Promise<void>
  onDeleteProduct: (product: Product) => Promise<void>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
  /** Injection seam for the on-device engine (tests and the standalone diagnostic page). */
  offlineSpeech?: Partial<OfflineSpeechOptions>
}) {
  const [commandText, setCommandText] = useState('')
  const [commandMessage, setCommandMessage] = useState('')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [targetPrompt, setTargetPrompt] = useState<TargetPrompt | null>(null)
  const [targetId, setTargetId] = useState('')
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>('idle')
  const [webSpeechServiceUnavailable, setWebSpeechServiceUnavailable] = useState(false)
  const [enginePreference, setEnginePreference] = useState<SpeechEnginePreference>('auto')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const recognitionRef = useRef<PersianSpeechSession | null>(null)

  // The on-device Shenava engine. It only ever produces a transcript string, exactly like the
  // Web Speech session above, so the Persian command pipeline below is untouched.
  const offline = useOfflineSpeech({
    ...offlineSpeech,
    baseUrl: offlineSpeech?.baseUrl ?? import.meta.env.BASE_URL,
    onTranscript: (transcript) => {
      offlineSpeech?.onTranscript?.(transcript)
      setCommandText(transcript)
      setCommandMessage(OFFLINE_SPEECH_MESSAGES.done)
    },
    transformTranscript: offlineSpeech?.transformTranscript ?? ((transcript) => itnForCommand(transcript, parseCommand)),
  })

  useEffect(() => {
    const session = new PersianSpeechSession(window, {
      onStatusChange: setSpeechStatus,
      onMessage: (message) => {
        // A missing Persian speech service is the one Web Speech failure that the offline engine fixes.
        if (message.includes('service-not-allowed')) setWebSpeechServiceUnavailable(true)
        setCommandMessage(message)
      },
      onTranscript: (transcript) => setCommandText(transcript),
    })
    recognitionRef.current = session
    return () => {
      if (recognitionRef.current === session) recognitionRef.current = null
      session.dispose()
    }
  }, [])

  const parsedItems = useMemo(() => form.items.map((item) => ({ item, amount: amountForLine(item) })), [form.items])
  const validItems = parsedItems.filter((entry) => entry.amount !== null && entry.item.name.trim())
  const discount = parseLocalizedNumber(form.discountPercent)
  let totals = null
  if (validItems.length === form.items.length && form.items.length > 0 && discount !== null) {
    try {
      totals = calculateInvoiceTotals(form.items.map((item) => ({
        quantity: parseLocalizedNumber(item.quantity) ?? Number.NaN,
        unitPrice: parseLocalizedNumber(item.unitPrice) ?? Number.NaN,
        discountPercent: parseLocalizedNumber(item.discountPercent) ?? Number.NaN,
      })), discount)
    } catch {
      totals = null
    }
  }

  const updateLine = (id: string, changes: Partial<InvoiceLineForm>) => {
    onChange({ ...form, items: form.items.map((item) => item.id === id ? { ...item, ...changes } : item) })
    setFormError('')
  }

  const addLine = (product?: Product, quantity = '1') => {
    onChange({ ...form, items: [...form.items, newLine(product, quantity)] })
    setFormError('')
  }

  const removeLine = (item: InvoiceLineForm) => {
    const label = item.name.trim() || 'این ردیف'
    if (!window.confirm(`«${label}» از فاکتور حذف شود؟`)) return
    onChange({ ...form, items: form.items.filter((line) => line.id !== item.id) })
  }

  const handleSave = async () => {
    setFormError('')
    if (!form.items.length) { setFormError('برای ذخیره، دست‌کم یک قلم اضافه کنید.'); return }
    if (form.items.some((line) => !line.name.trim())) { setFormError('نام همهٔ اقلام را کامل کنید.'); return }
    try {
      await onSave()
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : 'ذخیرهٔ فاکتور انجام نشد.')
    }
  }

  const runCommand = () => {
    setPending(null)
    setTargetPrompt(null)
    setCommandMessage('')
    if (!commandText.trim()) {
      setCommandMessage('متنی برای پردازش دریافت نشد. گفتار را دوباره ضبط کنید یا دستور را با صفحه‌کلید وارد کنید.')
      return
    }
    const command = parseCommand(commandText)
    if (!command) {
      // Show the exact text the parser received so a misheard phrase is visible, not hidden as a generic failure.
      setCommandMessage(`این دستور را نمی‌شناسم: «${commandText.trim()}». از یکی از نمونه‌های پایین استفاده کنید یا نام و عدد را واضح‌تر بنویسید.`)
      return
    }

    const plan = planCommand(command, form.items, products)
    if (plan.kind === 'addInvoiceItem') {
      onChange({ ...form, items: [...form.items, plan.line] })
      setCommandMessage(plan.catalogProductFound
        ? `${formatNumber(command.type === 'addInvoiceItem' ? command.quantity : 0)} ${plan.line.unit} ${plan.line.name} به فاکتور اضافه شد. قیمت و تعداد را بررسی کنید.`
        : `«${plan.line.name}» در فهرست نیست؛ به‌صورت قلم دستی با قیمت صفر اضافه شد. قیمت را پیش از ذخیره بررسی کنید.`)
      setCommandText('')
      return
    }

    if (plan.kind === 'setInvoiceQuantity') {
      updateLine(plan.lineId, { quantity: String(plan.quantity) })
      setCommandMessage(`تعداد «${plan.lineName}» به ${formatNumber(plan.quantity)} تغییر کرد. برای ثبت دائمی، فاکتور را ذخیره کنید.`)
      setCommandText('')
      return
    }

    if (plan.kind === 'error') {
      setCommandMessage(plan.message)
      return
    }

    if (plan.kind === 'chooseProduct') {
      setTargetPrompt({ command: plan.command, candidates: plan.candidates })
      setTargetId('')
      setCommandMessage(command.type === 'deleteProduct' && !command.productName
        ? 'منظور از «این محصول» مشخص نیست؛ محصول را از فهرست انتخاب کنید.'
        : 'چند محصول ممکن پیدا شد؛ مورد درست را انتخاب کنید. سپس مرحلهٔ تأیید نمایش داده می‌شود.')
      return
    }

    setPending(plan.action)
    setCommandMessage(plan.matchKind === 'partial'
      ? `نام دقیق پیدا نشد؛ تنها تطبیق «${plan.action.product.name}» است. تغییر پیشنهادی را بررسی و تأیید کنید.`
      : plan.action.type === 'deleteProduct'
        ? 'حذف محصول برگشت‌پذیر نیست؛ فاکتورهای قبلی تغییر نمی‌کنند. برای ادامه تأیید کنید.'
        : 'این تغییر فقط قیمت پیش‌فرض محصول را عوض می‌کند؛ فاکتورهای قبلی ثابت می‌مانند. تأیید کنید.')
  }

  const proceedWithTarget = () => {
    if (!targetPrompt) return
    const target = targetPrompt.candidates.find((product) => product.id === targetId)
    if (!target) { setCommandMessage('ابتدا یک محصول از فهرست انتخاب کنید.'); return }
    try {
      const action = productConfirmation(targetPrompt.command, target)
      setPending(action)
      setCommandMessage(action.type === 'deleteProduct'
        ? 'حذف محصول برگشت‌پذیر نیست؛ فاکتورهای قبلی تغییر نمی‌کنند. برای ادامه تأیید کنید.'
        : 'این تغییر فقط قیمت پیش‌فرض محصول را عوض می‌کند؛ فاکتورهای قبلی ثابت می‌مانند. تأیید کنید.')
      setTargetPrompt(null)
      setTargetId('')
    } catch (caught) {
      setCommandMessage(caught instanceof Error ? caught.message : 'ساخت تغییر پیشنهادی انجام نشد.')
    }
  }

  const confirmPending = async () => {
    if (!pending) return
    setBusy(true)
    try {
      if (pending.type === 'changeProductPrice') {
        await onUpdateProduct({ ...pending.product, price: pending.newPrice })
        onNotify(`قیمت پیش‌فرض «${pending.product.name}» به ${formatToman(pending.newPrice)} تغییر کرد.`, 'success')
        setCommandMessage('قیمت محصول به‌روزرسانی شد؛ فاکتورهای قبلی با همان مبلغ باقی ماندند.')
      } else {
        await onDeleteProduct(pending.product)
        onNotify(`محصول «${pending.product.name}» حذف شد.`, 'success')
        setCommandMessage('محصول از فهرست حذف شد؛ ردیف‌های موجود در فاکتورها حفظ شده‌اند.')
      }
      setPending(null)
      setCommandText('')
    } catch (caught) {
      setCommandMessage(caught instanceof Error ? caught.message : 'تغییر انجام نشد؛ دوباره تلاش کنید.')
    } finally {
      setBusy(false)
    }
  }

  const startListening = () => recognitionRef.current?.start()

  const invoiceNumber = form.number ?? 'پس از ذخیره شماره می‌گیرد'
  const speechBusy = speechStatus === 'starting' || speechStatus === 'listening' || speechStatus === 'stopping'
  const speechError = speechStatus === 'error' || speechStatus === 'unsupported'
  const voiceButtonLabel = speechBusy
    ? 'توقف تشخیص گفتار'
    : speechStatus === 'unsupported'
      ? 'تشخیص گفتار پشتیبانی نمی‌شود؛ متن را دستی وارد کنید'
      : speechStatus === 'result'
        ? 'شروع دوبارهٔ تشخیص گفتار'
        : speechStatus === 'error'
          ? 'تلاش دوباره برای تشخیص گفتار'
          : 'گفتن دستور با میکروفن'
  const voiceButtonText = speechStatus === 'starting'
    ? 'آماده‌سازی…'
    : speechStatus === 'listening'
      ? 'توقف'
      : speechStatus === 'stopping'
        ? 'در حال توقف…'
        : speechStatus === 'result'
          ? 'دوباره'
          : speechStatus === 'unsupported'
            ? 'بدون پشتیبانی'
            : speechStatus === 'error'
              ? 'تلاش دوباره'
              : 'گفتار'

  const offlineAvailable = offline.available === true
  const offlineBusy = offline.status === 'preparing' || offline.status === 'listening' || offline.status === 'transcribing'
  const offlineFailed = offline.status === 'error' || offline.status === 'unavailable' || offline.status === 'unsupported' || offline.status === 'checking'
  const activeEngine = resolveActiveEngine({
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    platform: typeof navigator === 'undefined' ? '' : (navigator.platform ?? ''),
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
    webSpeechAvailable: Boolean(getSpeechRecognitionConstructor(window)),
    webSpeechServiceUnavailable,
    offlineAvailable,
    preference: enginePreference,
  })
  const offlineActive = activeEngine === 'offline'
  const offlineButtonLabel = offline.status === 'listening'
    ? 'توقف ضبط موتور آفلاین'
    : offline.status === 'preparing'
      ? 'در حال آماده‌سازی موتور آفلاین روی دستگاه'
      : offline.status === 'transcribing'
        ? 'در حال تبدیل گفتار به متن روی دستگاه'
        : offline.status === 'result'
          ? 'شروع دوبارهٔ تشخیص گفتار آفلاین'
          : offlineAvailable
            ? 'گفتن دستور با میکروفن آفلاین'
            : 'موتور تشخیص گفتار آفلاین در دسترس نیست؛ متن را دستی وارد کنید'
  const offlineButtonText = offline.status === 'listening'
    ? 'توقف'
    : offline.status === 'preparing'
      ? 'آماده‌سازی…'
      : offline.status === 'transcribing'
        ? 'تبدیل…'
        : offline.status === 'result'
          ? 'دوباره'
          : offline.status === 'error'
            ? 'تلاش دوباره'
            : 'آفلاین'
  const micButtonLabel = offlineActive ? offlineButtonLabel : voiceButtonLabel
  const micButtonText = offlineActive ? offlineButtonText : voiceButtonText
  const micButtonBusy = offlineActive ? offlineBusy : speechBusy
  const micButtonListening = offlineActive ? offline.status === 'listening' : speechStatus === 'listening'
  const micButtonError = offlineActive ? offlineFailed : speechError
  const micButtonComplete = offlineActive ? offline.status === 'result' : speechStatus === 'result'
  const micButtonDisabled = offlineActive && !offlineAvailable
  const handleMicClick = offlineActive
    ? (offlineBusy ? offline.stop : offline.start)
    : (speechBusy ? () => recognitionRef.current?.stop() : startListening)
  // Users who cannot use Web Speech Persian (iOS Safari, or a service-not-allowed error) get the
  // explicit "engine unavailable" hint demanded by the offline-engine contract.
  const offlineHintNeeded = !offlineAvailable && offline.status !== 'checking' && (
    enginePreference === 'offline'
    || webSpeechServiceUnavailable
    || !getSpeechRecognitionConstructor(window)
    || detectIosLike({
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      platform: typeof navigator === 'undefined' ? '' : (navigator.platform ?? ''),
      maxTouchPoints: typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0),
    })
  )
  // Progress and failures of the on-device engine have to be visible, otherwise a failed start
  // looks like a dead button (the first load can take minutes on a phone).
  const offlineNoteVisible = Boolean(offline.message) && (
    offlineHintNeeded
    || (offlineActive && (offline.status === 'error' || offline.status === 'preparing' || offline.status === 'transcribing'))
  )

  return (
    <div className="page-stack invoice-editor-page">
      <div className="editor-back-row"><button type="button" className="back-link" onClick={onBack}><ArrowRight size={17} /> بازگشت به فاکتورها</button><span className={`editor-local-label${hasSaved ? ' saved' : ' unsaved'}`}><span />{hasSaved ? 'ذخیره‌شده روی دستگاه' : 'ذخیره نشده'}</span></div>
      <section className="page-title-row editor-title-row">
        <div><span className="eyebrow"><span className="eyebrow-dot" />{form.id ? 'ویرایش سند فروش' : 'سند فروش تازه'}</span><h1>{form.id ? `فاکتور ${form.number}` : 'ساخت فاکتور جدید'}</h1><p>مبالغ به تومان‌اند؛ جمع‌ها به‌صورت خودکار محاسبه می‌شوند.</p></div>
        <div className="editor-heading-actions">
          <button type="button" className="button button-soft" onClick={onPrint} disabled={!form.items.length}><Printer size={17} /> چاپ / PDF</button>
          <button type="button" className="button button-primary" onClick={() => void handleSave()} disabled={saving}>{saving ? 'در حال ذخیره…' : <><Save size={17} /> ذخیرهٔ فاکتور</>}</button>
        </div>
      </section>

      <section className="invoice-sheet panel">
        <div className="invoice-sheet-top">
          <div className="invoice-number-block"><span>شمارهٔ فاکتور</span><strong>{invoiceNumber}</strong></div>
          <div className="status-toggle" role="group" aria-label="وضعیت پرداخت">
            <button type="button" className={form.status === 'draft' ? 'selected' : ''} aria-pressed={form.status === 'draft'} onClick={() => onChange({ ...form, status: 'draft' })}>در انتظار پرداخت</button>
            <button type="button" className={form.status === 'paid' ? 'selected status-toggle-paid' : ''} aria-pressed={form.status === 'paid'} onClick={() => onChange({ ...form, status: 'paid' })}><Check size={14} /> پرداخت‌شده</button>
          </div>
        </div>

        <div className="invoice-section-heading"><span className="section-number">۱</span><div><h2>مشخصات مشتری</h2><p>نام و تلفن برای ثبت در سابقهٔ فاکتور</p></div></div>
        <div className="customer-fields">
          <label className="field"><span>نام مشتری</span><input maxLength={120} value={form.customerName} onChange={(event) => onChange({ ...form, customerName: event.target.value })} placeholder="نام و نام خانوادگی / شرکت" /></label>
          <label className="field"><span>شماره تماس</span><input dir="ltr" inputMode="tel" maxLength={40} value={form.customerPhone} onChange={(event) => onChange({ ...form, customerPhone: event.target.value })} placeholder="۰۹۱۲…" /></label>
        </div>

        <div className="invoice-section-heading items-section-heading"><span className="section-number">۲</span><div><h2>اقلام فاکتور</h2><p>قیمت‌ها به تومان و تعداد تا سه رقم اعشار</p></div></div>
        <div className="line-list">
          <div className="line-list-header"><span>شرح کالا یا خدمت</span><span>تعداد</span><span>قیمت واحد</span><span>تخفیف ٪</span><span>مبلغ نهایی</span><span /></div>
          {form.items.map((item, index) => {
            const lineAmounts = amountForLine(item)
            return (
              <div className="invoice-line" key={item.id}>
                <div className="line-product-field">
                  <span className="line-mobile-label">شرح کالا یا خدمت</span>
                  <div className="product-select-wrap">
                    <select aria-label={`انتخاب محصول برای ردیف ${index + 1}`} value={item.productId ?? ''} onChange={(event) => {
                      const selected = products.find((product) => product.id === event.target.value)
                      if (selected) updateLine(item.id, { productId: selected.id, name: selected.name, unit: selected.unit, unitPrice: String(selected.price) })
                      else updateLine(item.id, { productId: null })
                    }}>
                      <option value="">قلم دستی / انتخاب محصول</option>
                      {products.map((product) => <option key={product.id} value={product.id}>{product.name} · {formatToman(product.price)}</option>)}
                    </select>
                    <ChevronDown size={15} aria-hidden="true" />
                  </div>
                  <input aria-label={`شرح ردیف ${index + 1}`} maxLength={160} value={item.name} onChange={(event) => updateLine(item.id, { name: event.target.value, productId: products.find((product) => normalizeProductName(product.name) === normalizeProductName(event.target.value))?.id ?? null })} placeholder="نام محصول یا خدمت" />
                </div>
                <label className="line-number-field"><span className="line-mobile-label">تعداد</span><input dir="ltr" inputMode="decimal" value={item.quantity} onChange={(event) => updateLine(item.id, { quantity: event.target.value })} aria-label={`تعداد ردیف ${index + 1}`} /></label>
                <div className="line-price-field"><span className="line-mobile-label">قیمت واحد · تومان</span><input dir="ltr" inputMode="numeric" value={item.unitPrice} onChange={(event) => updateLine(item.id, { unitPrice: event.target.value })} aria-label={`قیمت واحد ردیف ${index + 1}`} /></div>
                <div className="line-discount-field"><span className="line-mobile-label">تخفیف</span><div><input dir="ltr" inputMode="decimal" value={item.discountPercent} onChange={(event) => updateLine(item.id, { discountPercent: event.target.value })} aria-label={`درصد تخفیف ردیف ${index + 1}`} /><span>٪</span></div></div>
                <div className="line-total-field"><span className="line-mobile-label">مبلغ نهایی</span><strong>{lineAmounts ? formatToman(lineAmounts.total) : '—'}</strong></div>
                <button type="button" className="icon-button remove-line" aria-label={`حذف ردیف ${item.name || index + 1}`} title="حذف ردیف" onClick={() => removeLine(item)}><Trash2 size={17} /></button>
              </div>
            )
          })}
          {form.items.length === 0 && <div className="line-empty"><PackageOpen size={20} /><span>هنوز قلمی اضافه نشده است.</span></div>}
        </div>
        <div className="line-list-footer"><button type="button" className="add-line-button" onClick={() => addLine()}><Plus size={17} /> افزودن قلم دستی</button><span>قیمت محصول از فهرست قابل ویرایش است.</span></div>

        <div className="invoice-bottom-grid">
          <div className="notes-block"><label className="field"><span>یادداشت فاکتور</span><textarea maxLength={500} rows={3} value={form.notes} onChange={(event) => onChange({ ...form, notes: event.target.value })} placeholder="توضیحات یا شرایط پرداخت (اختیاری)" /></label></div>
          <div className="totals-card">
            <div className="invoice-discount-input"><span>تخفیف کلی فاکتور</span><label><input dir="ltr" inputMode="decimal" value={form.discountPercent} onChange={(event) => onChange({ ...form, discountPercent: event.target.value })} aria-label="درصد تخفیف کلی فاکتور" /><span>٪</span></label></div>
            {totals ? <>
              <div className="total-row"><span>جمع اقلام</span><strong>{formatToman(totals.subtotal)}</strong></div>
              {totals.itemDiscount > 0 && <div className="total-row total-discount"><span>تخفیف اقلام</span><strong>− {formatToman(totals.itemDiscount)}</strong></div>}
              {totals.invoiceDiscount > 0 && <div className="total-row total-discount"><span>تخفیف کلی ({formatNumber(discount ?? 0, 2)}٪)</span><strong>− {formatToman(totals.invoiceDiscount)}</strong></div>}
              <div className="total-grand"><span>مبلغ قابل پرداخت</span><strong>{formatToman(totals.total)}</strong></div>
            </> : <div className="totals-help"><CircleHelp size={16} /> تعداد، قیمت و تخفیف معتبر وارد کنید تا جمع نمایش داده شود.</div>}
          </div>
        </div>

        {formError && <div className="form-error invoice-form-error" role="alert"><AlertTriangle size={16} />{formError}</div>}
        <div className="invoice-save-footer"><span><ShieldCheckIcon /> برای ثبت تغییرات، «ذخیرهٔ فاکتور» را بزنید.</span><div><button type="button" className="button button-quiet" onClick={onBack}>انصراف</button><button type="button" className="button button-primary" onClick={() => void handleSave()} disabled={saving}>{saving ? 'در حال ذخیره…' : <><Save size={16} /> ذخیرهٔ فاکتور</>}</button></div></div>
      </section>

      <section className="command-panel panel">
        <div className="command-heading"><span className="command-heading-icon"><Sparkles size={18} /></span><div><span className="panel-kicker">پردازش محلی · بدون API هوش مصنوعی</span><h2>دستور متنی فارسی</h2><p>برای فاکتور یا فهرست محصولات، یکی از دستورهای مشخص را بنویسید.</p></div></div>
        <div className="command-input-row">
          <input value={commandText} onChange={(event) => { setCommandText(event.target.value); setCommandMessage('') }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runCommand() } }} placeholder="مثلاً: سه عدد شیر به فاکتور اضافه کن" aria-label="نوشتن دستور فارسی" />
          <button type="button" className={`voice-button${offlineActive ? ' offline-voice-button' : ''}${micButtonListening ? ' listening' : ''}${micButtonError ? ' speech-error' : ''}${micButtonComplete ? ' speech-complete' : ''}`} onClick={handleMicClick} disabled={micButtonDisabled} aria-label={micButtonLabel} title={offlineActive ? 'تشخیص گفتار روی دستگاه؛ صدا از این دستگاه خارج نمی‌شود' : 'تشخیص گفتار مرورگر؛ آفلاین تضمین نمی‌شود'}>{micButtonBusy ? <MicOff size={17} /> : micButtonComplete ? <Check size={17} /> : <Mic size={17} />}<span>{micButtonText}</span></button>
          {offlineActive && Boolean(getSpeechRecognitionConstructor(window)) && <button type="button" className="engine-toggle" aria-label="استفاده از تشخیص گفتار مرورگر" title="تشخیص گفتار مرورگر؛ ممکن است به اینترنت نیاز داشته باشد" onClick={() => { setEnginePreference('browser'); offline.cancel() }}><Mic size={15} /><span>مرورگر</span></button>}
          {!offlineActive && offlineAvailable && <button type="button" className="engine-toggle" aria-label="تشخیص گفتار آفلاین روی دستگاه" title="تشخیص گفتار آفلاین شنوا؛ صدا از این دستگاه خارج نمی‌شود" onClick={() => { setEnginePreference('offline'); offline.start() }}><Sparkles size={15} /><span>آفلاین</span></button>}
          {!offlineActive && !offlineAvailable && offlineHintNeeded && <button type="button" className="engine-toggle" disabled aria-label="موتور تشخیص گفتار آفلاین در دسترس نیست؛ متن را دستی وارد کنید" title="موتور تشخیص گفتار آفلاین در دسترس نیست؛ متن را دستی وارد کنید"><Sparkles size={15} /><span>آفلاین</span></button>}
          <button type="button" className="button button-primary command-run" onClick={runCommand}>اجرای دستور</button>
        </div>
        {offlineNoteVisible && <div className="offline-engine-note" aria-live="polite"><CircleHelp size={14} />{offline.message || OFFLINE_SPEECH_MESSAGES.modelMissing}</div>}
        <p className="voice-disclaimer">{offlineActive
          ? 'موتور آفلاین «شنوا کوچیک» صدا را کامل روی همین دستگاه پردازش می‌کند و به اینترنت نیازی ندارد. متن شنیده‌شده خودکار اجرا نمی‌شود و پیش از اجرا قابل ویرایش است.'
          : 'تشخیص گفتار فقط به Web Speech API مرورگر وابسته است؛ پشتیبانی فارسی و کارکرد آفلاین تضمین نمی‌شود و ممکن است به اینترنت یا مجوز میکروفن نیاز داشته باشد. بعضی مرورگرها صدا را برای پردازش به سرویس گفتار خود می‌فرستند. متن شنیده‌شده خودکار اجرا نمی‌شود.'}</p>
        {commandMessage && <div className="command-feedback" role="status"><CircleHelp size={16} />{commandMessage}</div>}
        <div className="command-examples"><span>نمونه‌ها:</span>{supportedCommandExamples.map((example) => <button type="button" key={example} onClick={() => { setCommandText(example); setCommandMessage('') }}>{example}</button>)}</div>

        {targetPrompt && (
          <div className="command-target-picker">
            <label className="field"><span>انتخاب محصول موردنظر</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">یک محصول انتخاب کنید</option>{targetPrompt.candidates.map((product) => <option value={product.id} key={product.id}>{product.name} · {formatToman(product.price)}</option>)}</select></label>
            <button type="button" className="button button-soft" onClick={proceedWithTarget}>ادامه به تأیید</button>
          </div>
        )}

        {pending && (
          <div className={`command-confirmation${pending.type === 'deleteProduct' ? ' is-danger' : ''}`}>
            <span className="confirm-icon">{pending.type === 'deleteProduct' ? <AlertTriangle size={18} /> : <Check size={18} />}</span>
            <div className="confirm-copy">
              {pending.type === 'changeProductPrice' ? <><strong>تغییر قیمت «{pending.product.name}»؟</strong><span>{formatToman(pending.product.price)} ← {formatToman(pending.newPrice)} ({pending.direction === 'increase' ? '+' : '−'}{formatNumber(pending.percent, 2)}٪)</span></> : <><strong>«{pending.product.name}» حذف شود؟</strong><span>این تغییر فقط کاتالوگ را تغییر می‌دهد و روی فاکتورهای ثبت‌شده اثر ندارد.</span></>}
            </div>
            <button type="button" className={pending.type === 'deleteProduct' ? 'button button-danger' : 'button button-primary'} onClick={() => void confirmPending()} disabled={busy}>{busy ? 'در حال انجام…' : pending.type === 'deleteProduct' ? <><Trash2 size={16} /> تأیید حذف</> : <><Check size={16} /> تأیید تغییر</>}</button>
            <button type="button" className="icon-button" aria-label="لغو تغییر" onClick={() => { setPending(null); setCommandMessage('تغییر لغو شد.') }}><X size={17} /></button>
          </div>
        )}
      </section>
    </div>
  )
}

function ShieldCheckIcon() {
  return <span className="inline-shield" aria-hidden="true"><Check size={12} /></span>
}
