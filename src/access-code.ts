export const INVALID_ACCESS_CODE_MESSAGE = '体验码只能包含英文半角字符，不能含中文、全角字符、空格或不可见字符。请重新粘贴原始体验码。'

export function isValidAccessCode(code: string): boolean {
  return /^[\x21-\x7e]{1,256}$/.test(code)
}

export const ACCESS_CODE_STORAGE_KEY = 'airi-demo-access-code'

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

// Blocked sessionStorage throws from the getter itself. The code then lasts
// only for the current page instead of breaking setup or the unlock form.
export function loadStoredAccessCode(storage?: SessionStore): string {
  try {
    return (storage ?? window.sessionStorage).getItem(ACCESS_CODE_STORAGE_KEY) ?? ''
  }
  catch {
    return ''
  }
}

export function storeAccessCode(code: string, storage?: SessionStore): void {
  try {
    (storage ?? window.sessionStorage).setItem(ACCESS_CODE_STORAGE_KEY, code)
  }
  catch {
    // The unlocked code still applies to this page.
  }
}

export function forgetStoredAccessCode(storage?: SessionStore): void {
  try {
    (storage ?? window.sessionStorage).removeItem(ACCESS_CODE_STORAGE_KEY)
  }
  catch {
    // Nothing could have been stored; the in-page code is cleared by the caller.
  }
}
