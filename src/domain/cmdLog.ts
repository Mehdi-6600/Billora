/**
 * Debug helpers for the "اجرای دستور" path.
 *
 * Every log is prefixed with `[billora]` so it can be filtered in Safari Web Inspector / Chrome
 * DevTools and the user can paste the lines back when something fails on a real device. In
 * production the calls are cheap stringified no-ops behind `console.debug` (unless DevTools is
 * open with verbose level).
 */

export function cmdLog(stage: string, details?: Record<string, unknown>) {
  if (typeof console === 'undefined') return
  const parts: string[] = []
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
  }
  console.debug(`[billora] cmd:${stage}${parts.length ? ' · ' + parts.join(' · ') : ''}`)
}
