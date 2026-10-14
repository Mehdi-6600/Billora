import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppShell } from './AppShell'

describe('قالب صفحهٔ Billora', () => {
  it('ناوبری فارسی راست‌چین، وضعیت آفلاین و محتوای صفحه را رندر می‌کند', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        activePage="invoices"
        pageTitle="مدیریت فاکتورها"
        isOnline={false}
        onNavigate={() => undefined}
        onCreateInvoice={() => undefined}
      >
        <h1>فاکتورهای شما</h1>
      </AppShell>,
    )
    expect(markup).toContain('aria-label="منوی اصلی"')
    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('حالت آفلاین')
    expect(markup).toContain('فاکتورهای شما')
    expect(markup).toContain('Billora')
  })
})
