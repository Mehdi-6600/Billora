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

function makeLine(
  product: Product | undefined,
  name: string,
  quantity: number,
  idFactory: () => string,
  spoken?: { unit?: string | null; unitPrice?: number | null },
): InvoiceLineForm {
  return {
    id: idFactory(),
    productId: product?.id ?? null,
    name: product?.name ?? name,
    unit: product?.unit ?? spoken?.unit ?? 'عدد',
    quantity: String(quantity),
    unitPrice: String(spoken?.unitPrice ?? product?.price ?? 0),
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

export interface SpokenItemsPlan {
  planned: PlannedSpokenLine[]
  issues: SpokenItemIssue[]
}

/**
 * Resolve a spoken item list against the catalog. Spoken prices win over catalog prices.
 * An item with neither (or with a parse problem) becomes an `issue` — it must be shown to
 * the user for correction instead of being registered with a guessed price.
 */
export function planSpokenItems(
  items: SpokenItemEntry[],
  products: Product[],
  idFactory: () => string = createId,
): SpokenItemsPlan {
  const planned: PlannedSpokenLine[] = []
  const issues: SpokenItemIssue[] = []

  for (const entry of items) {
    if (entry.status === 'review') {
      issues.push({ raw: entry.raw, reason: entry.reason })
      continue
    }
    const product = products.find((candidate) => normalizeProductName(candidate.name) === normalizeProductName(entry.productName))
    const priceSource: 'speech' | 'catalog' | null = entry.unitPrice !== null ? 'speech' : product ? 'catalog' : null
    if (priceSource === null) {
      issues.push({
        raw: entry.raw,
        reason: `قیمت «${entry.productName}» معلوم نیست و در فهرست محصولات هم نیست؛ قیمت را در متن بگویید (مثلاً «به قیمت ۲۵۰۰۰۰») یا محصول را در فهرست ثبت کنید.`,
      })
      continue
    }
    planned.push({
      raw: entry.raw,
      line: makeLine(product, entry.productName, entry.quantity, idFactory, { unit: entry.unit, unitPrice: entry.unitPrice }),
      catalogProductFound: Boolean(product),
      priceSource,
    })
  }

  return { planned, issues }
}
