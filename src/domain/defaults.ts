import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'settings',
  storeName: 'فروشگاه من',
  phone: '',
  address: '',
  logoDataUrl: null,
  nextInvoiceNumber: 1,
}

export function formatInvoiceNumber(value: number): string {
  return `BL-${String(value).padStart(4, '0')}`
}
