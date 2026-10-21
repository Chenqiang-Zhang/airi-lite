# Avatar profile (`src/avatar-profiles/active.json`)

One tracked JSON file describes how the Live2D model performs: its face for each tone, the act pulses (laugh, sigh, pause), which motions play as gestures, the speaking sway, head drift and blink guard, the parameter roles, the model path and the framing. Both the web chat page and the OBS stage load it. Swapping to another model means editing this file, not the code.

Written 2026-10-21 for P3. Only `neutral`, `happy`, `soft`, `curious` and the activity offsets are pinned (to the pre-P3 poses, by `src/avatar-performance.snapshot.json`). Every other number in Hiyori's profile is a first draft read from her motion curves and parameter ranges, and still needs the screenshot pass on the debug page below.

P4 (2026-10-22) added optional vowel shapes under `mouth.vowels` ([below](#vowel-shapes-mouthvowels)). Hiyori's are starting values that still need the Vowel hold screenshots.

## Where it lives, and why

- `src/avatar-profiles/active.json` is the only profile that is loaded. Other JSON files in that folder are reference copies; the tests validate every one of them.
- It is tracked in Git. `public/models/*` is gitignored, so a profile next to the model files could never be committed.
- It is bundled into the lazily loaded Live2D chunk, whose name is hashed. An unhashed JSON file would go stale in OBS: the server sends every non-HTML file as `immutable` for a year. `npm run live` rebuilds anyway.
- Node tests never import `src/live2d.ts`; they read the JSON with `readFileSync`.

## Swapping models

1. Copy the model's runtime files into `public/models/<name>/`.
2. Overwrite `active.json`, with `"model": "models/<name>/<file>.model3.json"` and that model's parameter ids, faces and motions.
3. Rebuild (`npm run live`, or `npm run build`). No code changes to the performance.
4. Two texts still name Hiyori and are edited by hand: the model credit line on the chat page (`.model-credit` in `src/App.vue`, which the sample's licence requires) and the preflight's hint about `public/models/hiyori` (`server/live/preflight.mjs`).

Open the [debug page](#the-debug-page) and the browser console afterwards: problems in the profile are listed there.

## What happens when something is wrong

`parseAvatarProfile` (in `src/avatar-profile.ts`) validates the file; it is pure and path-qualified.

- The file must be valid JSON. A syntax error (a trailing comma, say) or a missing file stops the build, and `npm run live` checks it first and says so; only a profile that parses falls back as below.
- An invalid `version` or `model` replaces the whole profile with the built-in `FALLBACK_AVATAR_PROFILE` (today's Hiyori).
- Any other invalid value replaces only its top-level section (`layout`, `parameters`, `mouth`, `timing`, `expressions`, `activities`, `acts`, `motions`, `speaking`) with the built-in one. An invalid `id` or `name` replaces only that field. So a bad `mouth.vowels` also resets `mouth.formRange`, and the built-in mouth has no vowel shapes.
- An unknown key is reported but changes nothing. Keys starting with `_` are notes and are ignored.
- After the model loads, `resolveAvatarProfile` drops parameter ids the model does not have (in ops, sway, drift, the `motion` list and `mouth.vowels.*.params`), and motion groups or indices it cannot play, each with a problem. A motion reference without an `index` expands to every motion of its group. A missing `mouthOpen`, `mouthForm` or `headPitch` id is reported but kept.
- At most 20 messages are listed; the 20th then reads "and N more problems".

Where the problems show:

- `console.warn` on both pages (`Avatar profile "<id>": N problem(s); defaults used`).
- On the stage, as a stage problem in the host console: `头像配置有 N 处问题，已用默认值代替：<first path>`. It is sent after the avatar mounts and again each time the stage goes live, because a report sent before the page is primary is dropped.
- `body[data-avatar-profile]` and `body[data-avatar-problems]` on the stage, and the debug panel's Profile section.

## Version policy

The schema is version 1. Adding an optional key keeps version 1, and version 1 files stay valid. The version goes to 2 only if an existing key changes meaning. A file whose `version` is not 1 is rejected as a whole and the built-in profile is used.

## Sections

| Section | Contents |
|---|---|
| `version`, `id`, `name`, `model` | `1`; `[a-z0-9-]`, at most 40; at most 60 characters; `models/<folder>/<file>.model3.json` relative to the base URL, no `..` |
| `layout` | `fitWidth`, `fitHeight`, `anchorY`, `portraitFitHeight`, `portraitAnchorY`, each in (0, 4]. The portrait test (`height < 420 && width > 1.1·height`) stays in code because it describes the page. |
| `parameters` | `mouthOpen`, `mouthForm`, `headPitch` (aligned beat, onset emphasis, the acknowledge nod); `eyeOpen` (0–4 ids, for the blink guard); `motion` (head, body and gaze ids, skipped in every layer under reduced motion); `prePhysics` (a subset of `motion`, written before physics so hair follows) |
| `mouth` | `formRange: [min, max]`, −3 ≤ min < 0 < max ≤ 3; optional `vowels`, the mouth shapes for vowel lip sync (below) |
| `timing` | `easeInMs` (50–2000) and `relaxMs` (50–5000) for the face ease |
| `expressions` | exactly the 8 tones: `neutral`, `happy`, `soft`, `curious`, `surprised`, `sad`, `pout`, `shy` |
| `activities` | `attentive` and `thinking`, add-only offsets (written every frame) |
| `acts` | optional `laugh`, `sigh`, `pause` pulses |
| `motions` | gesture triggers and limits (below) |
| `speaking` | optional envelope, sway, drift and blink guard (below) |

### Ops: `add`, `scale`, `blend`

An expression or act pulse is a set of ops on parameter ids:

```json
{ "mouthForm": -0.4,
  "add":   { "ParamAngleY": -2 },
  "scale": { "ParamEyeLOpen": 0.85 },
  "blend": { "ParamBrowLForm": [-0.45, 0.85] } }
```

- `add` (|value| ≤ 30) adds to the motion's value; `scale` (0–3) multiplies it; `blend` is `[target, strength]` (|target| ≤ 30, strength 0–1) and pulls the value toward the target.
- Each frame the 8 face weights `w` sum to 1. Within one parameter: all adds (`v += Σ w·add`), then all scales (`v *= Π (1 + (scale − 1)·w)`), then the blends in tone order (`set(v, target, strength·w)`).
- `mouthForm` (|value| ≤ 2) is a bias. The rendered form is set absolutely: `clamp(audioForm + Σ w·mouthForm + act·act.mouthForm, formRange)`, where `audioForm` is the spectral form, or the vowel mix while a vowel track plays ([vowel shapes](#vowel-shapes-mouthvowels)). `MouthOpenY` is also set absolutely, so no motion's mouth curve ever shows.
- `{ "like": "soft" }` wears another tone's face. It cannot chain, cannot be the tone itself, and cannot be combined with ops.
- Every write is clamped by Cubism to the parameter's own range. For Hiyori, `ParamCheek` is −1..0 with 0 meaning full blush, so a positive Cheek add does nothing; she can only fade the blush.

### Vowel shapes (`mouth.vowels`)

Optional; the schema stays version 1. Where a speech clip has a vowel track (`src/visemes.ts`, built in the browser from MiniMax word or Eleven character timings), every mouth frame carries one weight per shape `a i u e o n m`: the five vowels, `n` a narrow neutral mouth (the apical -i of 是/字, 嗯, 哼) and `m` the lip closure of b/p/m. The audio still decides how much and when the mouth opens; a shape rescales that opening and sets the form for its share of the frame.

```json
"mouth": {
  "formRange": [-0.8, 0.9],
  "vowels": {
    "a": { "open": 1.3, "form": 0.1 },
    "i": { "open": 0.6, "form": 0.4 },
    "m": { "open": 0 } } }
```

| Key | Range | Default | Meaning |
|---|---|---|---|
| `a`, `i`, `u`, `e`, `o` | required | | one shape each |
| `n`, `m` | optional | | a weight on a shape the profile leaves out is dropped |
| `open` | 0–2 | 1 | scales the audio opening for this shape's share; the rendered value is clamped 0..1 |
| `form` | −2..2 | the audio form | replaces the spectral form for this shape's share; a value outside `formRange` is valid but noted |
| `params` | parameter ids, each −30..30 | none | written absolutely as `opening·weight·value`, and 0 when idle or unshaped; the `mouthOpen` and `mouthForm` ids are dropped at resolve (use `open` and `form`) |
| `strength` | 0–1 | 1 | scales every weight, for an A/B without editing seven entries |

Each frame, with `o` the audio opening, `f` the audio form, `w` the track's weights, `k` the strength and `W = Σ k·w` over the defined shapes (at most 1):

- `MouthOpenY = clamp(o·((1 − W) + Σ k·w·open), 0, 1)`
- `MouthForm = clamp((1 − W)·f + Σ k·w·(form ?? f) + Σ face·mouthForm + act·act.mouthForm, formRange)`
- each id in any `params`: `o·Σ k·w·params[id]`

Rules:

- Only the mouth write uses the shaped opening. The speaking envelope and sway, the onset emphasis, the blink guard and an act's `followVoice` keep the raw audio opening, so vowels never move the head, body or eyes.
- No track means exactly the pre-P4 mouth: a profile without `vowels`, browser speech (its sine pulse), Kokoro and local TTS (no timings), clips whose timings fail the lead or stale-tail checks, and a 3-argument stop. Inside a track, punctuation and silent frames have no weight and keep the spectral form.
- It also runs under reduced motion: it is mouth, not motion.
- The engine adds no smoothing; the track is already shaped (a 1-frame lead, a `[¼, ½, ¼]` blur, gated by the opening).
- A face bias still adds on top, so strong faces eat vowel contrast: happy `i` (0.4 + 0.6) is clamped to 0.9. Keep the forms well inside `formRange`.
- `setMouth(open, form, beat, ahead, vowel)` takes the weights in that order and sanitises them: anything but 7 numbers is no track, a non-finite weight is 0, each is clamped 0..1, a sum above 1 is scaled down to 1, and a sum below 0.001 is no track.

Hiyori has only `MouthOpenY` and `MouthForm`, so her shapes are jaw amount and form; `params` would be dropped. Her mean opening is about 0.86 of the audio-only mouth by design, because `i`, `u` and `n` are narrower. Negative form is a frown on her, so `u` and `o` stay mild.

A model with per-vowel parameters (an example only; nothing ships with one):

```json
"vowels": {
  "a": { "open": 0, "params": { "ParamA": 1 } }, "i": { "open": 0, "params": { "ParamI": 1 } },
  "u": { "open": 0, "params": { "ParamU": 1 } }, "e": { "open": 0, "params": { "ParamE": 1 } },
  "o": { "open": 0, "params": { "ParamO": 1 } }, "n": { "open": 0.4 }, "m": { "open": 0 } }
```

This gives `ParamA = o·w_a` and `MouthOpenY = o·(1 − W)`, so consonant gaps still open the jaw. Use `"open": 1` instead to layer the jaw with the vowel parameters. Leaving `form` out keeps the audio form under the vowel.

### Face timing

`setDelivery` only stores the requested tone. On the next rendered frame the face eases there by smoothstep over `easeInMs`, or over `relaxMs` when the target is neutral and speech has died down (a tone change to neutral mid-reply still uses `easeInMs`). The speech controller announces the next tone 0.18 s early (`onLead`), so the face is about half-way in when the words start. Both pages hold the spoken face for 1.5 s (`SPOKEN_FACE_HOLD_MS`) before relaxing.

### Act pulses

```json
"laugh": { "attackMs": 80, "holdMs": 500, "releaseMs": 400, "mouthForm": 0.25, "followVoice": 0.6,
  "blend": { "ParamEyeLSmile": [0.85, 0.9] },
  "oscillate": { "ParamAngleY": { "amplitude": 1.5, "periodMs": 220 } } }
```

- The envelope rises by smoothstep over `attackMs`, holds for `holdMs`, and falls over `releaseMs` (each 0–3000, sum ≤ 4000). The ops run at the envelope's weight.
- `oscillate` adds `amplitude·envelope·voice·sin(2π·age/periodMs + phase)`, where `voice = 1 − followVoice + followVoice·min(1, open/0.5)`.
- A pulse starts at the speech controller's `onAct`: at the clip's start, or for `pause` at the start of its 0.4 s silence, so the glance comes before the words. The same act again within 700 ms is ignored.

### Motions (gestures)

```json
"motions": { "minGapMs": 8000, "maxPerTurn": 2,
  "tap": { "motions": [{ "group": "Tap" }] },
  "emotions": { "happy": { "chance": 0.4, "cooldownMs": 20000, "motions": [{ "group": "Flick", "index": 0 }] } },
  "acts": { "laugh": { "chance": 0.5, "cooldownMs": 15000, "motions": [{ "group": "Flick", "index": 0 }] } },
  "idle": { "group": "Idle", "busyWeights": [3, 1, 0], "calmOnBusy": true } }
```

- A trigger lists up to 8 motion references, played round-robin (skipping motions that failed to load), with an optional `chance` (0–1, default 1) and `cooldownMs`.
- A tone is offered when it is announced (`onLead`) or starts (`onDelivery`), once per tone change (the announcement and the start are one offer; a tone that comes back later in the reply is offered again, subject to its cooldown and `maxPerTurn`). An act is offered at `onAct`. `turnStart` is offered at each new reply; Hiyori has none.
- Gates, in order, each logged with its code: `unmapped`, `reduced` (reduced motion), `turn-limit` (`maxPerTurn`), `gap` (`minGapMs` since the last gesture), `cooldown`, `busy` (a non-Idle motion is playing or loading), `chance`. A gesture never interrupts another gesture. The gap, cooldown and turn count are recorded at request time and rolled back if the library refuses the motion.
- `tap` is the chat page's click on the character: it ignores chance, cooldowns, gap, the turn limit and reduced motion, but never interrupts a gesture.
- `idle`: while she is thinking or speaking, the library's Idle pick is weighted by `busyWeights` (weight 0 never starts). With `calmOnBusy`, a weight-0 Idle that is already playing is stopped when she starts thinking or speaking; the next Idle fades in over 2 s.
- Every referenced motion is preloaded after the model loads.

### Speaking layer

```json
"speaking": {
  "envelope": { "attackMs": 120, "releaseMs": 600, "fullAt": 0.5 },
  "sway":  { "ParamBodyAngleX": { "amplitude": 1.2, "periodMs": 2900 } },
  "drift": { "ParamAngleX": { "amplitude": 1.5, "periodMs": 5300 } },
  "blink": { "open": 1, "minBeat": 0.15, "minEmphasis": 0.35, "engageAbove": 0.9, "attackMs": 40, "releaseMs": 160 } }
```

- The envelope follows the raw audio mouth opening, not the vowel-shaped one (attack and release time constants); `level = min(1, envelope/fullAt)`. It snaps to 0 in silence, so the sway stops completely.
- `sway` waves are multiplied by the voice level; `drift` waves by the speaking presence. Both are deterministic. Keep `headPitch` out of `drift`, so the aligned-beat nod stays exact.
- The blink guard holds the eyes open around strong syllables: an aligned beat (now or 0.12 s ahead) of at least `minBeat`, or, without alignment, an onset emphasis of at least `minEmphasis`. It engages only if the eyes are at least `engageAbove` open, so a motion's half-closed lids are left alone, and it only ever raises the eyes. It also runs under reduced motion.
- Pose writes on `prePhysics` ids run right after the library's breath and before physics, so hair, skirt and ribbons follow them. Everything else runs after physics, immediately before the model updates its vertices.

## The debug page

```
pnpm dev                        # http://127.0.0.1:5173/airi/stage.html?debug=performance
node scripts/mock-live.mjs      # http://127.0.0.1:4176/airi/stage.html?debug=performance (reads no .env.local)
```

- It exists only in dev builds: the production build (`npm run build`, `npm run live`, `npm start`) contains neither the panel nor its code. It only opens on a preview page outside OBS (`?role=obs`, or OBS's own browser, refuses it).
- The page never connects to the live server: no event stream, no lease, no reports and no paid voice. Speech is an offline mock voice (`src/stage/mock-speech.ts`) through the real speech controller, so joining, the pause silence, leads, `onDelivery`, `onAct`, the face hold and the gesture director run exactly as on stream.
- Rows: speak each tone; acts with a line; a happy → curious → sad → shy sequence with a laugh on clip 2; face hold without audio; act pulses without audio; force-play any motion; idle/thinking; options for aligned or unaligned beats, synthesis latency (0 / 400 / 1500 ms), ignoring the gesture gates, simulated reduced motion and the background (transparent, dark, green, checker); tours of all faces, acts and motions.
- Vowels (P4): a Vowel hold row (`a i u e o n m`, release) shows one shape alone, W = 1 at opening 0.6 and audio form 0, with or without audio; it combines with the face hold and wins over the `vowels` option. The `vowels: track/off` option ignores the track's weights for an A/B on the same clip. Also a vowels tour (each shape under neutral, happy, sad and pout, `body[data-debug-step]=vowel:<v>:<face>`), a vowel test line, and Play capture for a stored speech-response JSON (no network, no paid call; `node scripts/viseme-check.mjs` writes them from `.sse` captures into `.data/viseme-check/`). In code these are `setDebug({ vowel })` and `setDebug({ vowels: false })` on the avatar.
- The readout (5 Hz) shows the profile and its problems, the requested, target and lead tones with the 8 face weights, the voice envelope, sway, drift, blink guard and act, the mouth (`inspect().mouth`: `audioOpen`, rendered `open` and `form`, the strongest `vowel`, the total `weight` W, the `source` `track`, `audio`, `browser`, `hold` or `closed`, and a `lead` field that stays null because the engine is not told the decision; the decision is shown per clip instead: each clip's vowel-track decision this turn, such as `lead 1`, `characters as reported` or `none (stale tail 1.77 s)`), the current motion and the gesture director's last 16 decisions with reasons, every model parameter with its range and rendered value, and an event log on one clock (lead, `playing`, delivery, act, gesture, guard).
- Keys: **H** hides the panel, **Esc** cancels speech and tours. For scripted screenshots, `window.airiPerformanceDebug` has `say`, `act`, `hold`, `vowel`, `vowels('track' | 'off')`, `vowelLine`, `playCapture(blob or JSON text)`, `motion`, `tour`, `sequence`, `cancel` and `snapshot`; tours mark each step in `body[data-debug-step]` and `body[data-debug-phase]` (`settled` about 1 s in, or 0.25 s for a vowel step that keeps the face).

**Never add `?debug` to the OBS browser source URL.** The stream URL stays `stage.html?role=obs`.
