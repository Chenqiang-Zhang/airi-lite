# P3 avatar performance: screenshot pass — 2026-10-21

Free: mock-live (Vite dev, no `.env.local`, no paid calls) and
`stage.html?role=preview&debug=performance`, rendered by headless Chrome
(SwiftShader WebGL) through the DevTools protocol, because the app's browser
pane was not on screen. Contact sheets are in `.data/p3-screens/` (not in
git). Profile: `src/avatar-profiles/active.json`, 0 problems.

## Faces

Each face was held with the same Idle motion restarted at the same moment,
so the shots differ only by the face. Rendered values read back from the
model matched the profile (for example sad: EyeOpen 0.85, BrowForm −0.38,
Cheek −0.4, MouthForm −0.4; pout: BrowForm −0.6, MouthForm −0.5).

- **sad, pout, surprised, soft** read as intended up close.
- **happy and shy were barely different from neutral** with the
  pre-P3 values (happy: EyeSmile +0.15, MouthForm 0.32), pinned on purpose. On
  Hiyori an eye smile shows only once the eyes are partly closed: raising it
  alone to 0.55 changed nothing visible. A tried variant (happy: EyeOpen ×0.72
  with EyeSmile 1 and MouthForm 0.6; shy: EyeOpen ×0.82, EyeSmile 0.8)
  reads clearly as a smile (`happy-shy-stronger.png`). **Applied at the
  user's choice:** happy is MouthForm 0.6, EyeOpen ×0.72, EyeSmile blended to
  1 (strength 0.9); shy is MouthForm 0.3, EyeOpen ×0.82, EyeSmile to 0.8
  (0.85); the mouth range goes up to 0.9. Rendered values matched (happy:
  EyeOpen 0.72, EyeSmile 0.9, MouthForm 0.6). The final faces, including
  happy mid-sentence, are in `faces-final.png`. The fallback profile, and
  so the pre-P3 snapshot test, keep the old faces.
- Hiyori's blush (Cheek default 0 = full blush) stays as it is.

## Motions (forced, four moments each)

| Motion | What it looks like | Mapping |
| --- | --- | --- |
| Idle m01 / m02 / m05 | calm idles; m05 closes the eyes in a smile | Idle (m05 weight 0 while busy) |
| Flick m03 | bouncy body sway, arms out | happy (0.4), laugh (0.5) |
| FlickDown m04 | head tilt, ends with eyes closed | pout (0.6) |
| Tap m06 | startled arm flare | surprised (0.8) |
| Tap@Body m07 | arms out, then a look aside | shy (0.7) |
| Flick@Body m08 | AngleY −30 for about 2 s, but reads as a gentle downcast with troubled brows, face visible | **sad (0.5, cooldown 30 s)**: added after this pass |

## Timing (debug event log, mock voice, latency 0)

- The happy → curious → sad → shy sequence announced each tone ahead of its
  audio: 105 ms for the first clip (announced at install) and 211 ms for the
  second.
- The blink guard engaged around stressed syllables and released 0.2–0.25 s
  later.
- Gestures followed the gates: happy rolled its chance and skipped, curious
  has none, the laugh act played Flick.

## Guards

- The normal OBS URL (`stage.html?role=obs`) connects live, loads the
  profile, and has no panel or debug API; adding `&debug=performance` to it
  changes nothing.
- The production build contains no debug-panel code (`vite build` output
  grepped for `performance-debug`, `airiPerformanceDebug`, `mockSpeechClip`).

## Not checked here

- Hair motion from the pre-physics sway at 30 fps (needs a screen recording
  in OBS, not stills).
- A real OBS browser source.
