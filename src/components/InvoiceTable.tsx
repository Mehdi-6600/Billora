import { ArrowLeft, Eye, Printer, Trash2 } from 'lucide-react'
import { formatToman } from '../domain/calculations'
import type { Invoice } from '../domain/types'
import { formatDate } from '../utils'

export function InvoiceTable({
  invoices,
  onOpen,
  onPrint,
  onDelete,
  compact = false,
}: {
  invoices: Invoice[]
  onOpen: (invoice: Invoice) => void
  onPrint?: (invoice: Invoice) => void
  onDelete?: (invoice: Invoice) => void
  compact?: boolean
}) {
  if (invoices.length === 0) return null

  return (
    <div className={`table-scroll${compact ? ' compact-table' : ''}`}>
      <table className="data-table invoice-table">
        <thead>
          <tr>
            <th>شماره فاکتور</th>
            <th>مشتری</th>
            <th>تاریخ</th>
            <th>مبلغ نهایی</th>
            <th>وضعیت</th>
            {!compact && <th className="table-actions-heading">عملیات</th>}
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td data-label="شماره فاکتور">
                <button type="button" className="table-primary-link" onClick={() => onOpen(invoice)}>
                  {invoice.number}
                </button>
              </td>
              <td data-label="مشتری"><span className="customer-cell">{invoice.customerName || 'مشتری نامشخص'}</span></td>
              <td data-label="تاریخ" className="muted-cell">{formatDate(invoice.createdAt)}</td>
              <td data-label="مبلغ نهایی" className="money-cell">{formatToman(invoice.totals.total)}</td>
              <td data-label="وضعیت">
                <span className={`status-badge ${invoice.status === 'paid' ? 'status-paid' : 'status-draft'}`}>
                  <span />{invoice.status === 'paid' ? 'پرداخت‌شده' : 'در انتظار پرداخت'}
                </span>
              </td>
              {!compact && (
                <td data-label="عملیات" className="row-actions">
                  <button type="button" className="icon-button table-action" aria-label={`مشاهدهٔ فاکتور ${invoice.number}`} title="مشاهده و ویرایش" onClick={() => onOpen(invoice)}><Eye size={16} /></button>
                  {onPrint && <button type="button" className="icon-button table-action" aria-label={`چاپ فاکتور ${invoice.number}`} title="چاپ / ذخیره به PDF" onClick={() => onPrint(invoice)}><Printer size={16} /></button>}
                  {onDelete && <button type="button" className="icon-button table-action table-action-danger" aria-label={`حذف فاکتور ${invoice.number}`} title="حذف فاکتور" onClick={() => onDelete(invoice)}><Trash2 size={16} /></button>}
                </td>
              )}
              {compact && <td className="compact-arrow"><button type="button" className="icon-button" aria-label={`باز کردن فاکتور ${invoice.number}`} onClick={() => onOpen(invoice)}><ArrowLeft size={16} /></button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
