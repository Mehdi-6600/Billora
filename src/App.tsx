import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react'
import { AppShell, type PageKey } from './components/AppShell'
import { PrintDocument } from './components/PrintDocument'
import { Toast, type ToastMessage } from './components/Toast'
import { calculateInvoiceTotals, parseLocalizedNumber } from './domain/calculations'
import { serializeBackup } from './domain/backup'
import { blankInvoiceForm, invoiceToForm, toInvoiceDraft, type InvoiceForm } from './domain/invoice-form'
import type { AppSettings, AppSnapshot, Invoice, Product, ProductDraft } from './domain/types'
import { DashboardPage } from './pages/DashboardPage'
import { InvoiceEditorPage } from './pages/InvoiceEditorPage'
import { InvoicesPage } from './pages/InvoicesPage'
import { ProductsPage } from './pages/ProductsPage'
import { SettingsPage } from './pages/SettingsPage'
import {
  deleteInvoice,
  deleteProduct,
  initializeDatabase,
  loadSnapshot,
  replaceAllData,
  saveInvoice,
  saveProduct,
  saveSettings,
} from './storage/database'

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [page, setPage] = useState<PageKey>('dashboard')
  const [form, setForm] = useState<InvoiceForm | null>(null)
  const [formDirty, setFormDirty] = useState(false)
  const [savingInvoice, setSavingInvoice] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [toast, setToast] = useState<ToastMessage>(null)
  const [printInvoice, setPrintInvoice] = useState<Invoice | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, tone })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5_000)
  }, [])

  const refreshSnapshot = useCallback(async () => {
    await initializeDatabase()
    const next = await loadSnapshot()
    setSnapshot(next)
    setLoadError('')
    return next
  }, [])

  useEffect(() => {
    let active = true
    void refreshSnapshot().catch((error: unknown) => {
      if (!active) return
      setLoadError(error instanceof Error ? error.message : 'ذخیره‌سازی محلی در دسترس نیست.')
    }).finally(() => { if (active) setLoading(false) })

    const updateConnectivity = () => setIsOnline(navigator.onLine)
    window.addEventListener('online', updateConnectivity)
    window.addEventListener('offline', updateConnectivity)

    try {
      if ('serviceWorker' in navigator) {
        registerSW({
          immediate: true,
          onOfflineReady() { notify('فایل‌های اصلی برنامه برای استفادهٔ آفلاین آماده‌اند.', 'info') },
          onNeedRefresh() { notify('نسخهٔ تازهٔ Billora آماده است و به‌روزرسانی می‌شود.', 'info') },
        })
      }
    } catch {
      // The application still works online when service workers are unavailable.
    }

    return () => {
      active = false
      window.removeEventListener('online', updateConnectivity)
      window.removeEventListener('offline', updateConnectivity)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [notify, refreshSnapshot])

  useEffect(() => {
    if (!printInvoice) return
    const clearPrint = () => setPrintInvoice(null)
    window.addEventListener('afterprint', clearPrint)
    const timer = window.setTimeout(() => {
      if (typeof window.print === 'function') window.print()
    }, 180)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('afterprint', clearPrint)
    }
  }, [printInvoice])

  const confirmLeaveEditor = () => {
    if (page !== 'editor' || !formDirty) return true
    return window.confirm('تغییرات این فاکتور ذخیره نشده است. بدون ذخیره خارج شوید؟')
  }

  const navigate = (target: Exclude<PageKey, 'editor'>) => {
    if (!confirmLeaveEditor()) return
    setPage(target)
    if (page === 'editor') {
      setForm(null)
      setFormDirty(false)
    }
  }

  const createInvoice = () => {
    if (!confirmLeaveEditor()) return
    setForm(blankInvoiceForm())
    setFormDirty(false)
    setPage('editor')
  }

  const openInvoice = (invoice: Invoice) => {
    if (!confirmLeaveEditor()) return
    setForm(invoiceToForm(invoice))
    setFormDirty(false)
    setPage('editor')
  }

  const backFromEditor = () => {
    if (!confirmLeaveEditor()) return
    setPage('invoices')
    setForm(null)
    setFormDirty(false)
  }

  const saveCurrentInvoice = async () => {
    if (!form) throw new Error('فاکتوری برای ذخیره وجود ندارد.')
    setSavingInvoice(true)
    try {
      const draft = toInvoiceDraft(form, parseLocalizedNumber)
      const invoice = await saveInvoice(draft)
      const nextSnapshot = await loadSnapshot()
      setSnapshot(nextSnapshot)
      setForm(invoiceToForm(invoice))
      setFormDirty(false)
      notify(`فاکتور ${invoice.number} در همین دستگاه ذخیره شد.`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'ذخیرهٔ فاکتور انجام نشد.', 'error')
      throw error
    } finally {
      setSavingInvoice(false)
    }
  }

  const saveProductAction = async (product: ProductDraft): Promise<Product> => {
    const saved = await saveProduct(product)
    setSnapshot(await loadSnapshot())
    return saved
  }

  const deleteProductAction = async (product: Product) => {
    await deleteProduct(product.id)
    setSnapshot((current) => current ? { ...current, products: current.products.filter((entry) => entry.id !== product.id) } : current)
  }

  const deleteInvoiceAction = async (invoice: Invoice) => {
    if (!window.confirm(`فاکتور ${invoice.number} برای همیشه از همین دستگاه حذف شود؟`)) return
    try {
      await deleteInvoice(invoice.id)
      setSnapshot((current) => current ? { ...current, invoices: current.invoices.filter((entry) => entry.id !== invoice.id) } : current)
      notify(`فاکتور ${invoice.number} حذف شد.`, 'success')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'حذف فاکتور انجام نشد.', 'error')
    }
  }

  const saveStoreSettings = async (settings: AppSettings) => {
    await saveSettings(settings)
    setSnapshot((current) => current ? { ...current, settings } : current)
  }

  const exportBackup = () => {
    if (!snapshot) return
    try {
      const file = new Blob([serializeBackup(snapshot)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = `billora-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      notify('فایل پشتیبان روی دستگاه شما آماده شد.', 'success')
    } catch {
      notify('ساخت فایل پشتیبان انجام نشد.', 'error')
    }
  }

  const restoreBackup = async (restored: AppSnapshot) => {
    await replaceAllData(restored)
    setSnapshot(await loadSnapshot())
  }

  const printSavedInvoice = (invoice: Invoice) => setPrintInvoice(invoice)

  const printCurrentDraft = () => {
    if (!form) return
    try {
      const draft = toInvoiceDraft(form, parseLocalizedNumber)
      if (!draft.items.length) throw new Error('برای چاپ، دست‌کم یک قلم اضافه کنید.')
      const now = new Date().toISOString()
      const existing = draft.id ? snapshot?.invoices.find((invoice) => invoice.id === draft.id) : undefined
      const preview: Invoice = {
        id: draft.id ?? 'preview',
        number: draft.number ?? 'پیش‌نمایش',
        customerName: draft.customerName,
        customerPhone: draft.customerPhone,
        notes: draft.notes,
        status: draft.status,
        discountPercent: draft.discountPercent,
        items: draft.items,
        totals: calculateInvoiceTotals(draft.items, draft.discountPercent),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      setPrintInvoice(preview)
    } catch (error) {
      notify(error instanceof Error ? error.message : 'آماده‌سازی فاکتور برای چاپ انجام نشد.', 'error')
    }
  }

  if (loading) {
    return <div className="loading-screen"><span className="loading-mark">B</span><strong>Billora</strong><span className="loading-dots">در حال آماده‌سازی فضای کاری…</span></div>
  }

  if (loadError || !snapshot) {
    return <div className="error-screen"><span className="error-screen-icon"><AlertCircle size={24} /></span><h1>ذخیره‌سازی محلی در دسترس نیست</h1><p>{loadError || 'اطلاعات برنامه بارگذاری نشد.'}</p><span className="error-screen-hint">Billora به IndexedDB مرورگر نیاز دارد. در یک پنجرهٔ معمولی مرورگر باز کنید و دسترسی ذخیره‌سازی را بررسی کنید.</span><button type="button" className="button button-primary" onClick={() => { setLoading(true); void refreshSnapshot().catch((error: unknown) => setLoadError(error instanceof Error ? error.message : 'بارگذاری ناموفق بود.')).finally(() => setLoading(false)) }}><RefreshCw size={17} /> تلاش دوباره</button></div>
  }

  const titles: Record<PageKey, string> = {
    dashboard: 'نمای کلی',
    invoices: 'مدیریت فاکتورها',
    products: 'محصولات و قیمت‌ها',
    settings: 'تنظیمات فروشگاه',
    editor: form?.number ? `فاکتور ${form.number}` : 'فاکتور جدید',
  }

  return (
    <>
      <AppShell activePage={page} pageTitle={titles[page]} isOnline={isOnline} onNavigate={navigate} onCreateInvoice={createInvoice}>
        {page === 'dashboard' && <DashboardPage snapshot={snapshot} onCreateInvoice={createInvoice} onOpenInvoice={openInvoice} onGoInvoices={() => navigate('invoices')} onGoProducts={() => navigate('products')} />}
        {page === 'invoices' && <InvoicesPage invoices={snapshot.invoices} onCreateInvoice={createInvoice} onOpenInvoice={openInvoice} onPrintInvoice={printSavedInvoice} onDeleteInvoice={(invoice) => void deleteInvoiceAction(invoice)} />}
        {page === 'products' && <ProductsPage products={snapshot.products} onSave={saveProductAction} onDelete={deleteProductAction} onNotify={notify} />}
        {page === 'settings' && <SettingsPage settings={snapshot.settings} onSave={saveStoreSettings} onExport={exportBackup} onRestore={restoreBackup} onNotify={notify} />}
        {page === 'editor' && form && <InvoiceEditorPage form={form} products={snapshot.products} saving={savingInvoice} hasSaved={Boolean(form.id) && !formDirty} onChange={(next) => { setForm(next); setFormDirty(true) }} onSave={saveCurrentInvoice} onBack={backFromEditor} onPrint={printCurrentDraft} onUpdateProduct={async (product) => { await saveProductAction(product) }} onDeleteProduct={deleteProductAction} onNotify={notify} />}
      </AppShell>
      <PrintDocument invoice={printInvoice} settings={snapshot.settings} />
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="sr-only" aria-live="polite"><ShieldCheck />{isOnline ? 'ذخیره‌سازی محلی فعال است' : 'بدون اینترنت، اطلاعات همچنان در همین دستگاه ذخیره می‌شوند'}</div>
    </>
  )
}
