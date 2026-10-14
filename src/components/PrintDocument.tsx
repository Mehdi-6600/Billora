import { calculateLineAmounts, formatNumber, formatToman } from '../domain/calculations'
import type { AppSettings, Invoice } from '../domain/types'
import { formatDate } from '../utils'

export function PrintDocument({ invoice, settings }: { invoice: Invoice | null; settings: AppSettings }) {
  if (!invoice) return null

  return (
    <article className="print-document" dir="rtl" lang="fa">
      <header className="print-header">
        <div className="print-brand">
          {settings.logoDataUrl ? <img className="print-logo" src={settings.logoDataUrl} alt="لوگوی فروشگاه" /> : <span className="print-logo-placeholder">B</span>}
          <div><h1>{settings.storeName || 'فروشگاه'}</h1><p>صورتحساب فروش کالا و خدمات</p></div>
        </div>
        <div className="print-meta"><span>شماره فاکتور</span><strong>{invoice.number}</strong><span>تاریخ صدور</span><strong>{formatDate(invoice.createdAt)}</strong></div>
      </header>

      <div className="print-store-details">
        {settings.phone && <span>تلفن: <b dir="ltr">{settings.phone}</b></span>}
        {settings.address && <span>نشانی: <b>{settings.address}</b></span>}
      </div>

      <section className="print-customer">
        <div><span>صورتحساب برای</span><strong>{invoice.customerName || 'مشتری گرامی'}</strong></div>
        <div><span>شماره تماس مشتری</span><strong dir="ltr">{invoice.customerPhone || '—'}</strong></div>
        <div><span>وضعیت پرداخت</span><strong>{invoice.status === 'paid' ? 'پرداخت‌شده' : 'در انتظار پرداخت'}</strong></div>
      </section>

      <table className="print-table">
        <thead><tr><th>ردیف</th><th>شرح کالا / خدمت</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>تخفیف</th><th>مبلغ نهایی (تومان)</th></tr></thead>
        <tbody>
          {invoice.items.map((item, index) => {
            const amounts = calculateLineAmounts(item)
            return <tr key={item.id}><td>{formatNumber(index + 1, 0)}</td><td>{item.name}</td><td>{formatNumber(item.quantity)} {item.unit}</td><td>{formatNumber(item.unitPrice, 0)}</td><td>{formatNumber(item.discountPercent, 2)}٪{amounts.discount > 0 ? ` · ${formatNumber(amounts.discount, 0)}` : ''}</td><td>{formatNumber(amounts.total, 0)}</td></tr>
          })}
        </tbody>
      </table>

      <div className="print-bottom">
        <div className="print-notes">{invoice.notes ? <><strong>یادداشت</strong><p>{invoice.notes}</p></> : <span>از خرید شما سپاسگزاریم.</span>}</div>
        <div className="print-totals">
          <div><span>جمع اقلام</span><strong>{formatToman(invoice.totals.subtotal)}</strong></div>
          {invoice.totals.itemDiscount > 0 && <div><span>تخفیف اقلام</span><strong>− {formatToman(invoice.totals.itemDiscount)}</strong></div>}
          {invoice.totals.invoiceDiscount > 0 && <div><span>تخفیف کلی ({formatNumber(invoice.discountPercent, 2)}٪)</span><strong>− {formatToman(invoice.totals.invoiceDiscount)}</strong></div>}
          <div className="print-grand"><span>مبلغ قابل پرداخت</span><strong>{formatToman(invoice.totals.total)}</strong></div>
        </div>
      </div>

      <footer className="print-footer"><span>این فاکتور توسط Billora تهیه شده است.</span><span>شمارهٔ پیگیری: {invoice.number}</span></footer>
    </article>
  )
}
