import { ArrowLeft, ArrowUpLeft, CirclePlus, FileText, Package2, ReceiptText, WalletCards } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { InvoiceTable } from '../components/InvoiceTable'
import { formatNumber, formatToman } from '../domain/calculations'
import type { AppSnapshot, Invoice } from '../domain/types'
import { formatDate, greetingForNow } from '../utils'

function weekBars(invoices: Invoice[]) {
  const today = new Date()
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today)
    day.setHours(0, 0, 0, 0)
    day.setDate(today.getDate() - (6 - index))
    const total = invoices.reduce((sum, invoice) => {
      const created = new Date(invoice.createdAt)
      return created.toDateString() === day.toDateString() ? sum + invoice.totals.total : sum
    }, 0)
    return { date: day, total }
  })
  const max = Math.max(1, ...days.map((day) => day.total))
  return days.map((day) => ({
    label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'short' }).format(day.date),
    amount: day.total,
    height: day.total ? Math.max(8, Math.round((day.total / max) * 100)) : 4,
    isToday: day.date.toDateString() === today.toDateString(),
  }))
}

export function DashboardPage({
  snapshot,
  onCreateInvoice,
  onOpenInvoice,
  onGoInvoices,
  onGoProducts,
}: {
  snapshot: AppSnapshot
  onCreateInvoice: () => void
  onOpenInvoice: (invoice: Invoice) => void
  onGoInvoices: () => void
  onGoProducts: () => void
}) {
  const { invoices, products, settings } = snapshot
  const paidTotal = invoices.filter((invoice) => invoice.status === 'paid').reduce((sum, invoice) => sum + invoice.totals.total, 0)
  const waitingCount = invoices.filter((invoice) => invoice.status === 'draft').length
  const recent = invoices.slice(0, 5)
  const bars = weekBars(invoices)

  return (
    <div className="page-stack dashboard-page">
      <section className="dashboard-welcome">
        <div className="welcome-copy">
          <span className="eyebrow"><span className="eyebrow-dot" />نمای کلی کسب‌وکار</span>
          <h1>{greetingForNow()}، <em>{settings.storeName || 'دوست عزیز'}</em></h1>
          <p>وضعیت فروش و فاکتورهای امروز را یک‌جا ببینید.</p>
        </div>
        <div className="welcome-date"><span>امروز</span><strong>{formatDate(new Date())}</strong></div>
      </section>

      <section className="metric-grid" aria-label="آمار کسب‌وکار">
        <article className="metric-card metric-green">
          <span className="metric-icon"><ReceiptText size={20} /></span>
          <span className="metric-label">کل فاکتورها</span>
          <strong>{formatNumber(invoices.length, 0)}</strong>
          <span className="metric-note">از زمان شروع استفاده</span>
          <span className="metric-decoration" aria-hidden="true">۰۱</span>
        </article>
        <article className="metric-card">
          <span className="metric-icon metric-icon-amber"><WalletCards size={20} /></span>
          <span className="metric-label">فروش پرداخت‌شده</span>
          <strong className="metric-money">{formatToman(paidTotal)}</strong>
          <span className="metric-note">مجموع فاکتورهای تسویه‌شده</span>
          <span className="metric-decoration metric-decoration-amber" aria-hidden="true">↗</span>
        </article>
        <article className="metric-card">
          <span className="metric-icon metric-icon-blue"><FileText size={20} /></span>
          <span className="metric-label">در انتظار پرداخت</span>
          <strong>{formatNumber(waitingCount, 0)}</strong>
          <span className="metric-note">فاکتور باز</span>
          <span className="metric-decoration metric-decoration-blue" aria-hidden="true">۰۲</span>
        </article>
        <button type="button" className="metric-card metric-card-button" onClick={onGoProducts}>
          <span className="metric-icon metric-icon-violet"><Package2 size={20} /></span>
          <span className="metric-label">محصولات شما</span>
          <strong>{formatNumber(products.length, 0)}</strong>
          <span className="metric-note">برای دیدن فهرست کلیک کنید</span>
          <span className="metric-decoration metric-decoration-violet" aria-hidden="true"><ArrowUpLeft size={26} /></span>
        </button>
      </section>

      <section className="dashboard-middle-grid">
        <article className="panel chart-panel">
          <div className="panel-heading">
            <div><span className="panel-kicker">روند ثبت‌شده</span><h2>فاکتورهای ۷ روز اخیر</h2></div>
            <span className="chart-legend"><i /> مبلغ فاکتورها</span>
          </div>
          <div className="chart-summary">
            <div><strong>{formatNumber(invoices.filter((invoice) => new Date(invoice.createdAt).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000).length, 0)}</strong><span>فاکتور در این بازه</span></div>
            <span className="chart-period">هفتهٔ جاری</span>
          </div>
          <div className="week-chart" role="img" aria-label="نمودار مبلغ فاکتورهای هفت روز اخیر">
            {bars.map((bar) => (
              <div className={`chart-column${bar.isToday ? ' chart-today' : ''}`} key={bar.label} title={`${bar.label}: ${formatToman(bar.amount)}`}>
                <div className="chart-bar-space"><span className="chart-bar" style={{ height: `${bar.height}%` }} /></div>
                <span className="chart-day">{bar.label}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel quick-panel">
          <div className="panel-heading"><div><span className="panel-kicker">شروع سریع</span><h2>چه کاری انجام می‌دهید؟</h2></div></div>
          <button type="button" className="quick-action" onClick={onCreateInvoice}>
            <span className="quick-icon quick-icon-green"><CirclePlus size={19} /></span>
            <span><strong>ساخت فاکتور جدید</strong><small>برای مشتری، با جمع خودکار</small></span>
            <ArrowLeft size={16} />
          </button>
          <button type="button" className="quick-action" onClick={onGoProducts}>
            <span className="quick-icon quick-icon-amber"><Package2 size={19} /></span>
            <span><strong>ثبت محصول و قیمت</strong><small>برای استفادهٔ دوباره در فاکتورها</small></span>
            <ArrowLeft size={16} />
          </button>
          <div className="local-note"><span className="local-note-icon">✓</span><span>اطلاعات فقط در همین مرورگر ذخیره می‌شود؛ پشتیبان بگیرید.</span></div>
        </article>
      </section>

      <section className="panel recent-panel">
        <div className="panel-heading recent-heading">
          <div><span className="panel-kicker">آخرین فعالیت‌ها</span><h2>فاکتورهای اخیر</h2></div>
          {invoices.length > 0 && <button className="text-link" type="button" onClick={onGoInvoices}>همهٔ فاکتورها <ArrowLeft size={15} /></button>}
        </div>
        {recent.length > 0 ? (
          <InvoiceTable invoices={recent} compact onOpen={onOpenInvoice} />
        ) : (
          <EmptyState
            icon={ReceiptText}
            title="هنوز فاکتوری نساخته‌اید"
            description="اولین فاکتورتان را بسازید؛ جمع‌ها و شماره‌گذاری به‌صورت خودکار انجام می‌شوند."
            action={<button type="button" className="button button-primary" onClick={onCreateInvoice}><CirclePlus size={17} /> ساخت اولین فاکتور</button>}
          />
        )}
      </section>
    </div>
  )
}
