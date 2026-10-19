// Characters that must never reach captions or speech: C0/C1 controls and
// every bidi mark, embedding, override and isolate (they can make a caption
// display text in a different order from what the gate screened).
// HOST_CONTROL also removes newlines (console input is a single line);
// REPLY_CONTROL keeps them, since a model reply may use paragraphs.
export const HOST_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
export const REPLY_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
