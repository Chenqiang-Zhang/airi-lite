# Chinese expressive voice: account shortlist

Checked 2026-10-03 JST against official sources. This is a capability/integration shortlist, **not an audio audition or Chinese quality ranking**. No account was created, no key provisioned and no TTS request submitted. Public demo health still reports cloud speech `configured: false`.

For this demo, start with a **mainland MiniMax developer account** and audition `speech-2.8-hd` with a built-in Mandarin female voice. This recommendation combines relevant features with the already-prepared server adapter; it does not prove that MiniMax sounds best. That adapter currently fixes the mainland endpoint, so an international key is not a drop-in substitute. If registration is unavailable, inspect the region and adapt deliberately instead of mixing keys/endpoints.

| Platform | Official current capability | Fit and caveat |
| --- | --- | --- |
| MiniMax Speech 2.8 HD / Turbo | Chinese support; native chuckle/breath/sigh tags; streaming and voice cloning | First audition for fastest integration. HD is the quality-oriented option in the official guide; no local real-provider sound/latency validation yet. [API](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [guide](https://platform.minimax.io/docs/guides/speech-t2a-websocket), [release](https://www.minimax.io/news/minimax-speech-28) |
| Doubao TTS 2.0, Volcengine | Voice instructions, contextual/multi-turn synthesis and streaming; fixed speaker IDs | Strong second audition for Chinese delivery control, not a proven winner. Support varies between built-in voices and cloned standard/expressive voices. Not integrated here. [HTTP documentation](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh), [WebSocket documentation](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketUnidirectionalStreaming-V3?lang=zh) |
| Fish S2.1-Pro | Chinese and natural-language bracket delivery cues; persistent/reference voices; `s2.1-pro-free` has the same model quality | Useful low-cost comparison. The official free window currently runs through **2026-11-30**, under Fair Use, without uptime/first-audio guarantees; requests may improve their models and some commercial use is restricted. Voice design is separately priced, not automatically free. Not integrated here. [Models](https://docs.fish.audio/developer-guide/models-pricing/models-overview), [free terms](https://fish.audio/blog/s2-1-pro-free-api/), [pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits) |
| ElevenLabs v4 / v4 Turbo | Mandarin/Japanese, expressive dialogue and fixed/cloned voices; Turbo uses a dialogue WebSocket | Worth testing if multilingual delivery matters. Prepared adapter uses v4 HTTP, not Turbo streaming. Advertised inference latency excludes app/network time. [Models](https://elevenlabs.io/docs/overview/models) |

Account/experience entry points: [MiniMax mainland console](https://platform.minimax.cn/), [MiniMax voice playground](https://platform.minimax.cn/audio), [Volcengine quick start](https://docs.volcengine.com/docs/DoubaoVoice/QuickStartNewConsole?lang=zh), [Fish API keys](https://fish.audio/app/api-keys), [ElevenLabs signup](https://elevenlabs.io/app/sign-up). These links do not authorize registration, service activation, billing or uploading a voice sample.

Volcengine requires registration and identity verification. Its voice experience centre consumes the initial trial quota, then **automatically bills pay-as-you-go** when that quota runs out; inspect account controls before generating repeatedly. See the official [quick start](https://docs.volcengine.com/docs/DoubaoVoice/QuickStartNewConsole?lang=zh). Do not assume that a consumer voice subscription or coding plan is the correct production TTS credential/allowance; inspect the ordinary API billing page for the selected account and region. Exact mainland prices were not independently frozen in this note.

## Small listening comparison before committing

Use the same four Chinese lines and one permitted youthful fictional female voice per provider, with default pace/volume first:

1. 「你还真买到了？我以为已经关门了呢。」— surprise, without shouting.
2. 「哼，这局先算你赢，下一局可不一定。」— playful challenge, without an exaggerated anime performance.
3. 「嗯，今天不想聊也没关系，就待一会儿吧。」— quiet companionship, without a customer-service tone.
4. 「我选草莓。你喜欢抹茶，我们各选各的就好。」— ordinary conversation, no forced excitement.

Judge voice fit, Mandarin prosody, appropriate emotional restraint, intelligibility and consistency across lines. Keep a default/no-tag comparison: tags are available controls, not evidence that every sentence needs laughter or breathing. Then measure the actual VPS-to-provider-to-browser first-audio time and check mouth/expression/replay against real audio; vendor inference numbers are not this end-to-end latency.

Do not clone a real actor or other person's voice without permission. Start with an authorized preset or a newly designed fictional voice. Before integration, settle the provider, voice ID, commercial/public-demo terms and a small spending cap; store the key server-side only. No key needs to be pasted into chat or committed to Git.
