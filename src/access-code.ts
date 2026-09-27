export const INVALID_ACCESS_CODE_MESSAGE = '体验码只能包含英文半角字符，不能含中文、全角字符、空格或不可见字符。请重新粘贴原始体验码。'

export function isValidAccessCode(code: string): boolean {
  return /^[\x21-\x7e]{1,256}$/.test(code)
}
