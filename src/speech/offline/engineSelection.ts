/**
 * Decides which speech engine drives the invoice editor's microphone button.
 *
 * iOS Safari has no Persian Web Speech service (`service-not-allowed`), which is exactly the case
 * the offline engine exists for. Android Chrome usually does have fa-IR, so the browser engine stays
 * the default there. Users can always override the choice explicitly.
 */

export type SpeechEnginePreference = 'auto' | 'browser' | 'offline'

export interface SpeechEnvironment {
  userAgent: string
  platform: string
  maxTouchPoints: number
  webSpeechAvailable: boolean
  /** The browser reported `service-not-allowed` for `fa-IR` (no Persian service). */
  webSpeechServiceUnavailable: boolean
  offlineAvailable: boolean
  preference: SpeechEnginePreference
}

export type SpeechEngine = 'browser' | 'offline'

export function detectIosLike(environment: Pick<SpeechEnvironment, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  const agent = environment.userAgent.toLowerCase()
  if (/iphone|ipad|ipod/.test(agent)) return true
  // iPadOS 13+ reports itself as a Mac; the touch point count is the reliable signal.
  return environment.platform === 'MacIntel' && environment.maxTouchPoints > 1
}

export function shouldUseOfflineEngine(environment: SpeechEnvironment): boolean {
  if (!environment.offlineAvailable) return false
  if (environment.preference === 'offline') return true
  if (environment.preference === 'browser') return false
  if (!environment.webSpeechAvailable) return true
  if (environment.webSpeechServiceUnavailable) return true
  return detectIosLike(environment)
}

export function resolveActiveEngine(environment: SpeechEnvironment): SpeechEngine {
  return shouldUseOfflineEngine(environment) ? 'offline' : 'browser'
}
