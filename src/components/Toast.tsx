import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastMessage = { tone: 'success' | 'error' | 'info'; message: string } | null

export function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  if (!toast) return null
  const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? AlertCircle : Info
  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={19} aria-hidden="true" />
      <span>{toast.message}</span>
      <button type="button" className="icon-button toast-close" aria-label="بستن پیام" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}
