import { FilePlus2, Search, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { InvoiceTable } from '../components/InvoiceTable'
import type { Invoice } from '../domain/types'

export function InvoicesPage({
  invoices,
  onCreateInvoice,
  onOpenInvoice,
  onPrintInvoice,
  onDeleteInvoice,
}: {
  invoices: Invoice[]
  onCreateInvoice: () => void
  onOpenInvoice: (invoice: Invoice) => void
  onPrintInvoice: (invoice: Invoice) => void
  onDeleteInvoice: (invoice: Invoice) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'draft' | 'paid'>('all')
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('fa-IR')
    return invoices.filter((invoice) => {
      const matchesFilter = filter === 'all' || invoice.status === filter
      const matchesSearch = !normalized || [invoice.number, invoice.customerName, invoice.customerPhone]
        .some((value) => value.toLocaleLowerCase('fa-IR').includes(normalized))
      return matchesFilter && matchesSearch
    })
  }, [filter, invoices, query])

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div><span className="eyebrow"><span className="eyebrow-dot" />مدیریت فروش</span><h1>فاکتورها</h1><p>فاکتورها را جست‌وجو، ویرایش یا برای چاپ آماده کنید.</p></div>
        <button type="button" className="button button-primary" onClick={onCreateInvoice}><FilePlus2 size={17} /> فاکتور جدید</button>
      </section>

      <section className="panel invoice-list-panel">
        <div className="list-toolbar">
          <label className="search-field">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">جست‌وجو در فاکتورها</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="شماره، نام یا تلفن مشتری..." />
            {query && <button type="button" aria-label="پاک کردن جست‌وجو" onClick={() => setQuery('')}>×</button>}
          </label>
          <div className="filter-controls" aria-label="فیلتر وضعیت فاکتور">
            <SlidersHorizontal size={16} />
            {([
              ['all', 'همه'],
              ['draft', 'در انتظار'],
              ['paid', 'پرداخت‌شده'],
            ] as const).map(([value, label]) => (
              <button type="button" key={value} className={filter === value ? 'filter-chip selected' : 'filter-chip'} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>
            ))}
          </div>
        </div>

        {filtered.length ? (
          <InvoiceTable invoices={filtered} onOpen={onOpenInvoice} onPrint={onPrintInvoice} onDelete={onDeleteInvoice} />
        ) : invoices.length ? (
          <EmptyState icon={Search} title="موردی پیدا نشد" description="عبارت جست‌وجو یا فیلتر وضعیت را تغییر دهید." />
        ) : (
          <EmptyState icon={FilePlus2} title="فاکتوری ثبت نشده است" description="پس از ساخت فاکتور، سوابق اینجا باقی می‌مانند و آفلاین هم در دسترس‌اند." action={<button type="button" className="button button-primary" onClick={onCreateInvoice}><FilePlus2 size={17} /> ساخت فاکتور</button>} />
        )}
        {filtered.length > 0 && <div className="table-footnote">{filtered.length.toLocaleString('fa-IR')} فاکتور نمایش داده می‌شود. اطلاعات روی همین دستگاه نگهداری می‌شود.</div>}
      </section>
    </div>
  )
}
