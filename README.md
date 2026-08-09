# AIRI Lite

A small, self-owned companion prototype inspired by [Project AIRI](https://github.com/moeru-ai/airi).

The first milestone is intentionally narrow:

- render a Live2D character;
- accept text input;
- reply with a configurable personality;
- read replies aloud without microphone access.

The current scaffold already provides a local demonstration conversation and browser text-to-speech. The selected visual model is **Hiyori Momose**; Live2D rendering will be connected after the model files are downloaded from the official source.

## Development

Requirements: Node.js 24+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

Run a production build with:

```bash
pnpm build
```

## Hiyori Momose model

The model files are not redistributed by this repository. Download Hiyori Momose from the [official Live2D sample page](https://www.live2d.com/en/learn/sample/momose-hiyori/) after reviewing the applicable terms, then place the runtime files under `public/models/hiyori/`.

The application code and the model artwork have separate licenses. Any published build using the sample model must include the copyright notice required by Live2D.

## Roadmap

1. Connect Hiyori through the Live2D Web runtime.
2. Drive idle, speaking, and expression states.
3. Move the personality into editable configuration.
4. Add an optional LLM provider without exposing API keys in the browser.

## License

Source code in this repository is released under the MIT License. Live2D sample data is not included and is governed by its own terms.
