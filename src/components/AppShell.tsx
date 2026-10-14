import { useState } from 'react'
import {
  ArrowLeft,
  FileText,
  Grid2X2,
  Menu,
  Package2,
  Plus,
  Settings2,
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { BrandMark } from './Brand'

export type PageKey = 'dashboard' | 'invoices' | 'products' | 'settings' | 'editor'

const navigation: Array<{ key: Exclude<PageKey, 'editor'>; label: string; icon: typeof Grid2X2 }> = [
  { key: 'dashboard', label: 'نمای کلی', icon: Grid2X2 },
  { key: 'invoices', label: 'فاکتورها', icon: FileText },
  { key: 'products', label: 'محصولات', icon: Package2 },
  { key: 'settings', label: 'تنظیمات', icon: Settings2 },
]

export function AppShell({
  activePage,
  pageTitle,
  isOnline,
  onNavigate,
  onCreateInvoice,
  children,
}: {
  activePage: PageKey
  pageTitle: string
  isOnline: boolean
  onNavigate: (page: Exclude<PageKey, 'editor'>) => void
  onCreateInvoice: () => void
  children: React.ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const navigate = (page: Exclude<PageKey, 'editor'>) => {
    setMenuOpen(false)
    onNavigate(page)
  }

  return (
    <div className={`app-frame${menuOpen ? ' menu-open' : ''}`}>
      {menuOpen && <button className="mobile-scrim" aria-label="بستن منو" onClick={() => setMenuOpen(false)} />}
      <aside className="sidebar" aria-label="منوی اصلی">
        <div className="sidebar-brand">
          <BrandMark size={42} />
          <div className="brand-copy"><strong>Billora</strong><span>فاکتور ساده، خیال آسوده</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMenuOpen(false)} aria-label="بستن منو"><X size={19} /></button>
        </div>

        <button className="sidebar-create" onClick={() => { setMenuOpen(false); onCreateInvoice() }}>
          <Plus size={18} strokeWidth={2.5} />
          <span>فاکتور جدید</span>
          <ArrowLeft className="create-arrow" size={16} />
        </button>

        <div className="nav-caption">فضای کاری</div>
        <nav className="side-nav">
          {navigation.map(({ key, label, icon: Icon }) => (
            <button
              type="button"
              key={key}
              className={`nav-item${activePage === key || (key === 'invoices' && activePage === 'editor') ? ' active' : ''}`}
              aria-current={activePage === key || (key === 'invoices' && activePage === 'editor') ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
              {key === 'invoices' && activePage === 'editor' && <span className="nav-current-dot" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span className="privacy-icon"><ShieldCheck size={18} /></span>
            <div><strong>اطلاعات شما، پیش خودتان</strong><p>ذخیره روی همین دستگاه؛ بدون حساب کاربری.</p></div>
          </div>
          <div className={`connection-state${isOnline ? '' : ' is-offline'}`}>
            {isOnline ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{isOnline ? 'اتصال اینترنت برقرار است' : 'حالت آفلاین'}</span>
          </div>
          <div className="sidebar-version">Billora · نسخهٔ محلی</div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu-toggle" onClick={() => setMenuOpen(true)} aria-label="باز کردن منو"><Menu size={21} /></button>
          <div className="topbar-heading">
            <span className="topbar-kicker">فضای کاری شما</span>
            <strong>{pageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <div className={`topbar-status${isOnline ? '' : ' is-offline'}`}>
              <span className="status-pulse" />
              {isOnline ? 'ذخیره‌سازی محلی فعال' : 'بدون اینترنت · داده‌ها در دسترس‌اند'}
            </div>
            <button className="button button-primary topbar-create" onClick={onCreateInvoice}>
              <Plus size={17} /> <span>فاکتور جدید</span>
            </button>
          </div>
        </header>

        <main className="page-content">{children}</main>

        <nav className="mobile-bottom-nav" aria-label="ناوبری موبایل">
          {navigation.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" className={activePage === key || (key === 'invoices' && activePage === 'editor') ? 'active' : ''} onClick={() => navigate(key)}>
              <Icon size={19} /> <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}
