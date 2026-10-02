// Only stable codes cross the speech boundary; provider messages may contain
// credentials or submitted dialogue and must never reach visitors or logs.
export class SpeechProviderError extends Error {
  constructor(code = 'TTS_UPSTREAM_INVALID') {
    super(code)
    this.code = code
  }
}
