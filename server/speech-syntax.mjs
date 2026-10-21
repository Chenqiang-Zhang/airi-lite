// What a speech provider would act on if it appeared in the text it is sent,
// shared by the adapter that removes it (server/minimax.mjs) and the live
// output gate that refuses it (server/live/moderation.mjs). Deleting is only
// safe if the gate has already refused anything that deletion would change:
// otherwise "加(laughs)微信" would be screened in pieces and spoken as 加微信.

// Every sound tag the MiniMax 2.8 docs list, performed when written as
// "(laughs)", with or without spaces inside the brackets.
export const MINIMAX_SOUND_TAGS = Object.freeze(['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant',
  'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes'])
const SOUND_TAG = new RegExp(`\\(\\s*(?:${MINIMAX_SOUND_TAGS.join('|')})\\s*\\)`, 'gi')
// MiniMax pauses only on "<#seconds#>"; any other "<#" is just text.
const PAUSE_TAG = /<#\s*\d+(?:\.\d+)?\s*#>/g

// Text with MiniMax syntax removed, repeating until nothing changes:
// removing '<#1#>' from '<<#1#>#0.5#>' would otherwise leave a new working
// marker behind. Remaining '<#' (a PowerShell comment, say) keeps its words
// but its "<" is made full width, one character for one, so MiniMax never
// reads it as the start of a marker.
export function stripMinimaxSyntax(text) {
  let literal = String(text)
  for (let previous = null; previous !== literal;) {
    previous = literal
    literal = literal.replace(PAUSE_TAG, '').replace(SOUND_TAG, '')
  }
  return literal.replaceAll('<#', '＜#')
}

// True when a provider adapter would delete part of this text.
export function hasProviderSyntax(text) {
  const value = String(text)
  return stripMinimaxSyntax(value).replaceAll('＜#', '<#') !== value
}
