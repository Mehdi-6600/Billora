import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, ImagePlus, LockKeyhole, Save, ShieldCheck, Store, Trash2 } from 'lucide-react'
import { parseBackup, type BackupError } from '../domain/backup'
import type { AppSettings, AppSnapshot } from '../domain/types'

const MAX_LOGO_BYTES = 1_500_000
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export function SettingsPage({
  settings,
  onSave,
  onExport,
  onRestore,
  onNotify,
}: {
  settings: AppSettings
  onSave: (settings: AppSettings) => Promise<void>
  onExport: () => void
  onRestore: (snapshot: AppSnapshot) => Promise<void>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(settings), [settings])

  const chooseLogo = (file?: File) => {
    if (!file) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) { setError('فرمت لوگو باید PNG، JPEG یا WebP باشد.'); return }
    if (file.size > MAX_LOGO_BYTES) { setError('حجم لوگو باید کمتر از ۱٫۵ مگابایت باشد.'); return }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraft((current) => ({ ...current, logoDataUrl: reader.result as string }))
        setError('')
      }
    }
    reader.onerror = () => setError('خواندن فایل لوگو انجام نشد.')
    reader.readAsDataURL(file)
  }

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.storeName.trim()) { setError('نام فروشگاه را وارد کنید.'); return }
    setSaving(true)
    setError('')
    try {
      await onSave({ ...draft, storeName: draft.storeName.trim(), phone: draft.phone.trim(), address: draft.address.trim() })
      onNotify('اطلاعات فروشگاه در همین دستگاه ذخیره شد.', 'success')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ذخیرهٔ تنظیمات انجام نشد.')
    } finally {
      setSaving(false)
    }
  }

  const importBackup = async (file?: File) => {
    if (!file) return
    setError('')
    if (file.size > 12_000_000) { setError('حجم فایل پشتیبان بیش از ۱۲ مگابایت است.'); return }
    setRestoreBusy(true)
    try {
      const snapshot = parseBackup(await file.text())
      const accepted = window.confirm(`این پشتیبان شامل ${snapshot.invoices.length.toLocaleString('fa-IR')} فاکتور و ${snapshot.products.length.toLocaleString('fa-IR')} محصول است. بازیابی، اطلاعات فعلی این مرورگر را جایگزین می‌کند. ابتدا از اطلاعات فعلی پشتیبان دارید؟`)
      if (!accepted) return
      await onRestore(snapshot)
      onNotify('پشتیبان بازیابی شد؛ اطلاعات قبلی این دستگاه با محتوای فایل جایگزین شد.', 'success')
    } catch (caught) {
      const message = caught as BackupError | Error
      setError(message instanceof Error ? message.message : 'بازیابی پشتیبان انجام نشد.')
    } finally {
      setRestoreBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div><span className="eyebrow"><span className="eyebrow-dot" />شخصی‌سازی و نگهداری</span><h1>تنظیمات</h1><p>اطلاعاتی که روی فاکتور چاپ می‌شوند و نسخه‌های پشتیبان را مدیریت کنید.</p></div>
      </section>

      <div className="settings-layout">
        <form className="panel settings-form" onSubmit={(event) => void save(event)}>
          <div className="panel-heading settings-panel-heading">
            <span className="settings-heading-icon"><Store size={19} /></span>
            <div><span className="panel-kicker">اطلاعات چاپی</span><h2>مشخصات فروشگاه</h2></div>
          </div>
          <div className="logo-upload-row">
            <div className="logo-preview">{draft.logoDataUrl ? <img src={draft.logoDataUrl} alt="پیش‌نمایش لوگوی فروشگاه" /> : <ImagePlus size={22} />}</div>
            <div className="logo-upload-copy"><strong>لوگوی فروشگاه</strong><span>PNG، JPEG یا WebP · حداکثر ۱٫۵ مگابایت</span><div className="logo-actions"><label className="button button-soft button-small"><ImagePlus size={15} /> انتخاب لوگو<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseLogo(event.target.files?.[0])} /></label>{draft.logoDataUrl && <button type="button" className="button button-quiet button-small" onClick={() => setDraft({ ...draft, logoDataUrl: null })}><Trash2 size={14} /> حذف لوگو</button>}</div></div>
          </div>
          <div className="settings-fields">
            <label className="field"><span>نام فروشگاه <b>*</b></span><input maxLength={100} value={draft.storeName} onChange={(event) => setDraft({ ...draft, storeName: event.target.value })} placeholder="نام کسب‌وکار شما" /></label>
            <div className="form-two-columns">
              <label className="field"><span>شماره تماس</span><input dir="ltr" inputMode="tel" maxLength={40} value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="۰۲۱…" /></label>
              <label className="field"><span>نشانی</span><input maxLength={250} value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="نشانی قابل چاپ روی فاکتور" /></label>
            </div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="settings-save-row"><span><ShieldCheck size={15} /> فقط روی این دستگاه ذخیره می‌شود</span><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'در حال ذخیره…' : <><Save size={16} /> ذخیرهٔ تغییرات</>}</button></div>
        </form>

        <div className="settings-side-stack">
          <section className="panel backup-panel">
            <div className="panel-heading settings-panel-heading"><span className="settings-heading-icon backup-heading-icon"><ArrowDownToLine size={19} /></span><div><span className="panel-kicker">مالکیت داده‌ها</span><h2>پشتیبان‌گیری</h2></div></div>
            <p className="panel-description">یک نسخهٔ JSON از فروشگاه، محصولات، فاکتورها و اطلاعات مشتری بسازید یا روی همین دستگاه بازیابی کنید.</p>
            <button type="button" className="button button-primary backup-export" onClick={onExport}><ArrowDownToLine size={17} /> دریافت فایل پشتیبان</button>
            <div className="backup-divider" />
            <input ref={fileInput} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => void importBackup(event.target.files?.[0])} />
            <button type="button" className="button button-soft backup-import" onClick={() => fileInput.current?.click()} disabled={restoreBusy}><ArrowUpFromLine size={17} /> {restoreBusy ? 'در حال بررسی فایل…' : 'بازیابی از فایل'}</button>
            <div className="warning-note"><AlertTriangle size={16} /><span>بازیابی جایگزین اطلاعات فعلی می‌شود. فایل پشتیبان ممکن است اطلاعات شخصی داشته باشد؛ آن را امن نگه دارید.</span></div>
          </section>

          <section className="panel privacy-panel">
            <span className="privacy-large-icon"><LockKeyhole size={19} /></span>
            <h2>داده‌ها در ابر نیستند</h2>
            <p>Billora سرور، حساب کاربری یا همگام‌سازی ابری ندارد. پاک‌کردن داده‌های مرورگر، خرابی دستگاه یا استفاده از مرورگر دیگری می‌تواند اطلاعات را از دسترس خارج کند؛ فایل پشتیبان بگیرید.</p>
            <div className="privacy-status"><Check size={15} /> ذخیره‌سازی با IndexedDB همین مرورگر</div>
          </section>
        </div>
      </div>
    </div>
  )
}
