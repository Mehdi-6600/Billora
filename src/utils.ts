export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
}

export function formatDate(value: string | Date, includeTime = false): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}

export function greetingForNow(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 11) return 'صبح بخیر'
  if (hour < 16) return 'روز بخیر'
  return 'عصر بخیر'
}
