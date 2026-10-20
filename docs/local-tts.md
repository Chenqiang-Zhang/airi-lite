# Self-hosted speech (`TTS_PROVIDER=local`)

airi-lite can send its spoken sentences to a TTS engine you run yourself instead of MiniMax or ElevenLabs. Any engine, or wrapper around one, that serves an **OpenAI-compatible `POST /v1/audio/speech`** works. Both the web chat page (`/api/speech`) and the live stage (the sentence purchase route, through `speech.synthesise`) use it. No other code path changes.

Written 2026-10-20. Only the zero-dependency mock engine below has been tested. No real engine has been installed or listened to yet.

## How a request looks

airi-lite sends one JSON request per sentence:

```http
POST {LOCAL_TTS_URL}/v1/audio/speech
Content-Type: application/json
Accept: audio/wav            (audio/mpeg for mp3)
Authorization: Bearer …      (only when LOCAL_TTS_API_KEY is set)

{"model": "<LOCAL_TTS_MODEL>", "input": "<sentence>", "voice": "<LOCAL_TTS_VOICE>",
 "response_format": "wav", "speed": 1}
```

- `input` is at most 360 UTF-16 characters (the same limit as the cloud providers).
- `speed` comes from the sentence's delivery: `soft` is 0.96 and everything else is 1. With `LOCAL_TTS_INSTRUCTIONS=1`, `soft`/`bright`/`curious` also send a short Chinese `instructions` string such as 「用轻柔、平静的语气说。」. Leave it off unless your wrapper understands that field. The mapping lives in one table, `DELIVERY_STYLE` in `server/local-tts.mjs`.
- The reply must be raw audio bytes with an `audio/*` or `application/octet-stream` content type, at most **2 MiB** and **30 s**. Anything else, including a JSON error body, becomes a stable `TTS_UPSTREAM_INVALID` / `TTS_UPSTREAM_FAILED` code. Engine messages are never relayed to the browser or the logs.
- **WAV** (the default): the sample rate is read from the RIFF header. 8/16/24/32-bit integer PCM or 32-bit float, mono or stereo, 8–96 kHz. Headers from streaming encoders, which write a length of 0 or 0xFFFFFFFF, are patched to the real length.
- **MP3**: set `LOCAL_TTS_SAMPLE_RATE`. Every Layer III frame must carry that rate, so a wrong value fails loudly instead of playing at the wrong pitch.
- The provider returns no word timings, so the avatar's mouth follows the decoded audio level, as it does for the other providers' clips.

## Configure

Put these in `.env.local` on the machine that runs airi-lite (see `.env.example`):

```dotenv
TTS_PROVIDER=local
LOCAL_TTS_ENABLED=1
LOCAL_TTS_URL=http://192.168.1.20:50000   # base URL, without /v1
LOCAL_TTS_MODEL=cosyvoice2                # whatever your wrapper expects
LOCAL_TTS_VOICE=中文女                     # a speaker name your engine knows
LOCAL_TTS_FORMAT=wav
# LOCAL_TTS_API_KEY=                      # if your wrapper checks a bearer key
# LOCAL_TTS_SAMPLE_RATE=24000             # required only for mp3
# LOCAL_TTS_DAILY_CHAR_LIMIT=500000       # runaway guard; this is the default
# LOCAL_TTS_INSTRUCTIONS=0
```

The configuration fails closed. The provider is reported `configured: false` and nothing is sent unless:

- `TTS_PROVIDER=local` and `LOCAL_TTS_ENABLED=1` are both set. A configured local engine is never a fallback for a typo.
- `LOCAL_TTS_URL` is `http(s)` to an **IP literal** that is loopback (`127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`) or link-local (`169.254/16`, `fe80::/10`), or exactly `localhost`. Public addresses, other host names (including `*.local` mDNS names, which could be re-pointed by DNS), `user:password@`, `?query` and `#fragment` are rejected. A path prefix is allowed: `http://10.0.0.5:8000/tts` posts to `/tts/v1/audio/speech`.
- `LOCAL_TTS_MODEL` is 1–128 characters from `A–Z a–z 0–9 . _ : / @ + -`. `LOCAL_TTS_VOICE` is 1–256 characters with no control characters. `LOCAL_TTS_FORMAT` is `wav` or `mp3`. An API key is visible ASCII with no spaces.

`GET /airi/api/health` then reports `speech: {configured: true, provider: "local", model: "…"}`. The chat page shows the engine as 「云端 · 自托管语音」. A visitor must confirm it in the voice settings like any cloud vendor: an earlier MiniMax/ElevenLabs consent does not carry over.

The ledger `.data/tts-budget-local.json` counts reserved characters per UTC day, separately from the cloud ledgers. It exists only to stop a runaway loop: a local engine costs nothing per character. Each request also has the shared 30 s timeout, so **warm the engine up first**. Many engines load their model on the first request and would time out on it.

## Try it with the mock engine

```bash
node scripts/mock-local-tts.mjs
```

That serves `http://127.0.0.1:8765/v1/audio/speech` and answers every request with a short sine tone in a WAV file. It logs only the sentence length, never the text. Then start airi-lite with:

```dotenv
TTS_PROVIDER=local
LOCAL_TTS_ENABLED=1
LOCAL_TTS_URL=http://127.0.0.1:8765
LOCAL_TTS_MODEL=mock
LOCAL_TTS_VOICE=mock-voice
```

On the chat page, choose 「云端 · 自托管语音」 in the voice settings, save, and send a message. You should hear a beep per sentence. `server/local-tts.test.mjs` drives the same mock through `/api/speech` and the live stage's `speech.synthesise`.

## Engine notes

Check every licence yourself before you stream with an engine: the code, the **weights**, any **built-in speakers**, and any **reference audio** you clone from. The notes below are starting points from a quick search, not legal review.

| Candidate | Where | Notes |
| --- | --- | --- |
| **CosyVoice family** (FunAudioLLM: CosyVoice 2 / Fun-CosyVoice 3, 0.5B) | Windows or Linux PC with an NVIDIA GPU | First choice for Mandarin. The code is Apache-2.0, and the [CosyVoice2-0.5B model card](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B) lists Apache-2.0 at the time of writing. Confirm the weights and built-in speakers again when you download them. The official repo ships its own servers. Whether they speak the OpenAI route was not verified, so you may need a wrapper such as [vox-box](https://github.com/gpustack/vox-box), which lists CosyVoice behind `POST /v1/audio/speech`. Verify its licence and current behaviour before use. |
| Kokoro behind an OpenAI-compatible server (for example Kokoro-FastAPI) | This Mac (Apple Silicon) | Apache-2.0 weights. Useful to prove the network path on the Mac, but its Mandarin is limited, and airi-lite already runs Kokoro in the browser. |
| Fish-Speech / OpenAudio | — | **Not recommended.** The published weights are CC-BY-NC-SA-4.0 (non-commercial), and a Bilibili stream with gifts or Super Chats is plausibly commercial use. |

For a Windows GPU box on the home network:

1. Bind the engine to the LAN interface (or `0.0.0.0`). Allow that port through Windows Firewall for the private network only.
2. Give the box a fixed address (a DHCP reservation) and use that IP in `LOCAL_TTS_URL`. Host names are deliberately not accepted.
3. Set a bearer key in the wrapper and in `LOCAL_TTS_API_KEY` if the wrapper supports one. Plain HTTP on a home LAN is visible to other devices on it.
4. Run `curl -o test.wav -H 'Content-Type: application/json' -d '{"model":"…","input":"你好","voice":"…","response_format":"wav"}' http://<ip>:<port>/v1/audio/speech` from the Mac first. If `test.wav` plays, airi-lite will accept it.

Do not clone a real person's voice without their permission. The plan for now is to **use existing built-in voices** and train nothing. A self-trained model can later sit behind the same endpoint without code changes.
