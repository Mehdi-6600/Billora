import { applyPercentageChange } from './calculations'
import { normalizeProductName, type ParsedCommand, type SpokenItemEntry } from './commands'
import type { InvoiceLineForm } from './invoice-form'
import type { Product } from './types'
import { createId } from '../utils'

export type ProductCommandAction =
  | { type: 'changeProductPrice'; product: Product; newPrice: number; percent: number; direction: 'increase' | 'decrease' }
  | { type: 'deleteProduct'; product: Product }

export type CommandPlan =
  | { kind: 'addInvoiceItem'; line: InvoiceLineForm; catalogProductFound: boolean }
  | { kind: 'setInvoiceQuantity'; lineId: string; lineName: string; quantity: number }
  | { kind: 'confirmation'; action: ProductCommandAction; matchKind: 'exact' | 'partial' }
  | { kind: 'chooseProduct'; command: ParsedCommand; candidates: Product[] }
  | { kind: 'error'; message: string }

function makeLine(product: Product | undefined, name: string, quantity: number, idFactory: () => string): InvoiceLineForm {
  return {
    id: idFactory(),
    productId: product?.id ?? null,
    name: product?.name ?? name,
    unit: product?.unit ?? 'عدد',
    quantity: String(quantity),
    unitPrice: product ? String(product.price) : '0',
    discountPercent: '0',
  }
}

export function productConfirmation(command: ParsedCommand, product: Product): ProductCommandAction {
  if (command.type === 'changeProductPrice') {
    return {
      type: 'changeProductPrice',
      product,
      newPrice: applyPercentageChange(product.price, command.percent, command.direction),
      percent: command.percent,
      direction: command.direction,
    }
  }
  if (command.type === 'deleteProduct') return { type: 'deleteProduct', product }
  throw new Error('این دستور به تغییر کاتالوگ مربوط نیست.')
}

/** Resolve a parsed command into an explicit local action; destructive catalog changes remain pending for UI confirmation. */
export function planCommand(
  command: ParsedCommand,
  items: InvoiceLineForm[],
  products: Product[],
  idFactory: () => string = createId,
): CommandPlan {
  if (command.type === 'addInvoiceItem') {
    const product = products.find((entry) => normalizeProductName(entry.name) === normalizeProductName(command.productName))
    return { kind: 'addInvoiceItem', line: makeLine(product, command.productName, command.quantity, idFactory), catalogProductFound: Boolean(product) }
  }

  if (command.type === 'setInvoiceQuantity') {
    const matches = items.filter((item) => normalizeProductName(item.name) === normalizeProductName(command.productName))
    if (matches.length === 0) return { kind: 'error', message: `«${command.productName}» در ردیف‌های این فاکتور پیدا نشد.` }
    if (matches.length > 1) return { kind: 'error', message: `چند ردیف با نام «${command.productName}» وجود دارد؛ نام دقیق‌تری بنویسید تا ردیف موردنظر روشن شود.` }
    return { kind: 'setInvoiceQuantity', lineId: matches[0].id, lineName: matches[0].name, quantity: command.quantity }
  }

  if (!command.productName) {
    return products.length
      ? { kind: 'chooseProduct', command, candidates: products }
      : { kind: 'error', message: 'هنوز محصولی برای حذف وجود ندارد.' }
  }

  const normalizedName = normalizeProductName(command.productName)
  const matches = products.filter((product) => {
    const candidate = normalizeProductName(product.name)
    return candidate === normalizedName || candidate.includes(normalizedName) || normalizedName.includes(candidate)
  })
  const exact = matches.filter((product) => normalizeProductName(product.name) === normalizedName)

  if (exact.length === 1) return { kind: 'confirmation', action: productConfirmation(command, exact[0]), matchKind: 'exact' }
  if (exact.length > 1) return { kind: 'chooseProduct', command, candidates: exact }
  if (matches.length === 1 && command.type === 'changeProductPrice') {
    return { kind: 'confirmation', action: productConfirmation(command, matches[0]), matchKind: 'partial' }
  }
  if (matches.length > 0) return { kind: 'chooseProduct', command, candidates: matches }
  return { kind: 'error', message: `محصولی با نام «${command.productName}» در فهرست نیست. نام دقیق محصول را بررسی کنید.` }
}

export interface PlannedSpokenLine {
  raw: string
  line: InvoiceLineForm
  catalogProductFound: boolean
  priceSource: 'speech' | 'catalog'
}

export interface SpokenItemIssue {
  raw: string
  reason: string
}

export interface ProductMatch {
  product: Product | null
  matchKind: 'exact' | 'partial' | 'none' | 'ambiguous'
  candidates: Product[]
}

/** Exact catalog name wins; a unique partial match is accepted; several matches are ambiguous. */
export function matchProduct(name: string, products: Product[]): ProductMatch {
  const normalized = normalizeProductName(name)
  if (!normalized) return { product: null, matchKind: 'none', candidates: [] }
  const exact = products.filter((product) => normalizeProductName(product.name) === normalized)
  if (exact.length > 0) return { product: exact[0]!, matchKind: 'exact', candidates: exact }
  const partial = products.filter((product) => {
    const candidate = normalizeProductName(product.name)
    return candidate.includes(normalized) || normalized.includes(candidate)
  })
  if (partial.length === 1) return { product: partial[0]!, matchKind: 'partial', candidates: partial }
  if (partial.length > 1) return { product: null, matchKind: 'ambiguous', candidates: partial }
  return { product: null, matchKind: 'none', candidates: [] }
}

export interface SpokenItemRow {
  raw: string
  productName: string
  quantity: number
  unit: string | null
  /** Known unit price (spoken or catalog); `null` = the user must supply it. */
  unitPrice: number | null
  product: Product | null
  matchKind: 'exact' | 'partial' | 'none' | 'ambiguous'
  candidates: Product[]
  /** `null` when the row is ready to register; otherwise why the user must complete it. */
  reason: string | null
}

/**
 * Resolve a spoken item list against the catalog. Spoken prices win over catalog prices.
 * A row with `reason !== null` needs user input (missing price, ambiguous name, parse problem)
 * and must be completed in the review panel instead of being registered with a guessed price.
 */
export function planSpokenItems(items: SpokenItemEntry[], products: Product[]): SpokenItemRow[] {
  return items.map((entry) => {
    if (entry.status === 'review') {
      return {
        raw: entry.raw,
        productName: '',
        quantity: 1,
        unit: null,
        unitPrice: null,
        product: null,
        matchKind: 'none' as const,
        candidates: [],
        reason: entry.reason,
      }
    }
    const match = matchProduct(entry.productName, products)
    const unitPrice = entry.unitPrice ?? match.product?.price ?? null
    let reason: string | null = null
    if (match.matchKind === 'ambiguous') {
      reason = `چند محصول مشابه «${entry.productName}» پیدا شد (${match.candidates.map((candidate) => candidate.name).join('، ')})؛ نام دقیق را وارد کنید.`
    } else if (unitPrice === null) {
      reason = `قیمت «${entry.productName}» معلوم نیست؛ قیمت را وارد کنید یا محصول را در فهرست محصولات ثبت کنید.`
    }
    return {
      raw: entry.raw,
      productName: entry.productName,
      quantity: entry.quantity,
      unit: entry.unit,
      unitPrice,
      product: match.product,
      matchKind: match.matchKind,
      candidates: match.candidates,
      reason,
    }
  })
}

/** Build the invoice line for a ready spoken row (spoken price wins over the catalog price). */
export function spokenRowToLine(row: SpokenItemRow, idFactory: () => string = createId): InvoiceLineForm {
  return {
    id: idFactory(),
    productId: row.product?.id ?? null,
    name: row.product?.name ?? row.productName,
    unit: row.product?.unit ?? row.unit ?? 'عدد',
    quantity: String(row.quantity),
    unitPrice: String(row.unitPrice ?? 0),
    discountPercent: '0',
  }
}
