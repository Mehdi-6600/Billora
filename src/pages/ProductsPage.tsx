import { useMemo, useState } from 'react'
import { Check, PackagePlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'
import { formatNumber, formatToman, parseLocalizedNumber } from '../domain/calculations'
import type { Product, ProductDraft } from '../domain/types'

const blankProduct: ProductDraft = { name: '', unit: 'عدد', price: 0 }

export function ProductsPage({
  products,
  onSave,
  onDelete,
  onNotify,
}: {
  products: Product[]
  onSave: (product: ProductDraft) => Promise<Product>
  onDelete: (product: Product) => Promise<void>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}) {
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<ProductDraft | null>(null)
  const [priceText, setPriceText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('fa-IR')
    return products.filter((product) => !normalized || `${product.name} ${product.unit}`.toLocaleLowerCase('fa-IR').includes(normalized))
  }, [products, query])

  const openNew = () => {
    setForm({ ...blankProduct })
    setPriceText('')
    setError('')
  }
  const openEdit = (product: Product) => {
    setForm({ id: product.id, name: product.name, unit: product.unit, price: product.price })
    setPriceText(String(product.price))
    setError('')
  }
  const closeForm = () => { setForm(null); setError('') }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form) return
    const price = parseLocalizedNumber(priceText)
    if (!form.name.trim()) { setError('نام محصول را وارد کنید.'); return }
    if (price === null || !Number.isSafeInteger(price) || price < 0) { setError('قیمت را به‌صورت عدد صحیح نامنفی و به تومان وارد کنید.'); return }
    setSaving(true)
    setError('')
    try {
      const wasEdit = Boolean(form.id)
      await onSave({ ...form, price })
      closeForm()
      onNotify(wasEdit ? 'محصول و قیمت پیش‌فرض به‌روزرسانی شد.' : 'محصول به فهرست شما اضافه شد.', 'success')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ذخیرهٔ محصول انجام نشد.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (product: Product) => {
    if (!window.confirm(`«${product.name}» از فهرست محصولات حذف شود؟ فاکتورهای قبلی تغییر نمی‌کنند.`)) return
    try {
      await onDelete(product)
      onNotify('محصول از فهرست حذف شد؛ فاکتورهای قبلی دست‌نخورده‌اند.', 'success')
    } catch (caught) {
      onNotify(caught instanceof Error ? caught.message : 'حذف محصول انجام نشد.', 'error')
    }
  }

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div><span className="eyebrow"><span className="eyebrow-dot" />فهرست و قیمت‌ها</span><h1>محصولات</h1><p>نام و قیمت پیش‌فرض محصول را نگه دارید تا در فاکتورهای بعدی سریع‌تر وارد شود.</p></div>
        <button type="button" className="button button-primary" onClick={openNew}><Plus size={17} /> محصول جدید</button>
      </section>

      <section className="panel products-panel">
        <div className="list-toolbar product-toolbar">
          <div className="toolbar-context"><span className="toolbar-count">{formatNumber(products.length, 0)}</span><span>محصول ذخیره‌شده</span></div>
          <label className="search-field">
            <Search size={18} aria-hidden="true" />
            <span className="sr-only">جست‌وجو در محصولات</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="نام محصول یا واحد..." />
          </label>
        </div>
        {filtered.length ? (
          <div className="table-scroll">
            <table className="data-table product-table">
              <thead><tr><th>نام محصول</th><th>واحد</th><th>قیمت پیش‌فرض</th><th className="table-actions-heading">عملیات</th></tr></thead>
              <tbody>
                {filtered.map((product) => (
                  <tr key={product.id}>
                    <td data-label="نام محصول"><div className="product-name-cell"><span className="product-thumb"><PackagePlus size={18} /></span><strong>{product.name}</strong></div></td>
                    <td data-label="واحد"><span className="unit-pill">{product.unit}</span></td>
                    <td data-label="قیمت پیش‌فرض" className="money-cell">{formatToman(product.price)}</td>
                    <td data-label="عملیات" className="row-actions">
                      <button type="button" className="icon-button table-action" aria-label={`ویرایش ${product.name}`} title="ویرایش" onClick={() => openEdit(product)}><Pencil size={16} /></button>
                      <button type="button" className="icon-button table-action table-action-danger" aria-label={`حذف ${product.name}`} title="حذف" onClick={() => void remove(product)}><Trash2 size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : products.length ? (
          <EmptyState icon={Search} title="محصولی پیدا نشد" description="نام یا واحد دیگری را جست‌وجو کنید." />
        ) : (
          <EmptyState icon={PackagePlus} title="فهرست محصولات خالی است" description="محصولات پرکاربرد را اضافه کنید؛ قیمت پیش‌فرض هنگام ساخت فاکتور قابل ویرایش است." action={<button type="button" className="button button-primary" onClick={openNew}><Plus size={17} /> افزودن اولین محصول</button>} />
        )}
        <div className="table-footnote">تغییر قیمت محصول فقط روی فاکتورهای جدید اثر می‌گذارد؛ مبالغ فاکتورهای قبلی ثابت می‌مانند.</div>
      </section>

      {form && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeForm() }}>
          <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title">
            <div className="dialog-heading">
              <span className="dialog-icon"><PackagePlus size={20} /></span>
              <div><h2 id="product-dialog-title">{form.id ? 'ویرایش محصول' : 'افزودن محصول'}</h2><p>قیمت به تومان ثبت می‌شود.</p></div>
              <button type="button" className="icon-button" aria-label="بستن" onClick={closeForm}><X size={19} /></button>
            </div>
            <form className="form-stack" onSubmit={(event) => void submit(event)}>
              <label className="field"><span>نام محصول <b>*</b></span><input autoFocus maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="مثلاً روغن زیتون" /></label>
              <div className="form-two-columns">
                <label className="field"><span>واحد</span><input maxLength={24} value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} placeholder="عدد" /></label>
                <label className="field"><span>قیمت پیش‌فرض (تومان) <b>*</b></span><input dir="ltr" inputMode="numeric" value={priceText} onChange={(event) => setPriceText(event.target.value)} placeholder="۰" /></label>
              </div>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={closeForm}>انصراف</button><button type="submit" className="button button-primary" disabled={saving}>{saving ? 'در حال ذخیره…' : <><Check size={17} /> ذخیرهٔ محصول</>}</button></div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
