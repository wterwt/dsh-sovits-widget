# dsh-sovits-widget

A GPT-SoVITS voice-broadcast plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (dsh). Assistant replies are read aloud in a cloned voice — with role personas, emotion mapping, voice blending, streaming playback, and interruption handling.

Works on both the dsh desktop build and the plain web profile. Same bundle-plugin shape as `dsh-whale-widget`: an npm package declaring `dsh.bundle.patch`, with a host half (`lib/index.js`) and a browser half (`assets/sovits-widget.js`).

> 中文文档见 [README.md](README.md)；逐步安装说明见 [INSTALL.md](INSTALL.md)。

## Features

| Module | Description |
| --- | --- |
| Role prompt injection | Injects a persona section (`ctx.systemPrompt.section`, order 131) that follows the active role; switching a role switches both prompt and voice |
| Text cleaning & segmentation | Strips Markdown/emoji, replaces URLs with "链接" and code blocks with "（省略代码）"; splits on sentence punctuation and a max length (~50 chars) without breaking Latin words |
| Concurrent queue | p-queue based, concurrency configurable (1 for local GPU to avoid VRAM exhaustion, 2-4 for remote APIs); barge-in clears queued work and aborts in-flight HTTP |
| Disk LRU cache | Key = `sha256(roleId + text + ttsParams)`, 2 GB budget by default, evicts by last use, rebuilds its index on restart |
| Streaming playback | Web Audio API schedules each segment as soon as it is synthesized; interruption fades out over 100 ms to avoid popping |
| Config panel | Basic settings, voice management (roles, reference-audio upload with denoise + 3-10 s trim, emotion mapping, A/B voice blending), advanced GPT-SoVITS parameters, diagnostics |
| Per-message buttons | Play / regenerate / stop under every assistant reply |
| Floating console | Progress bar, current sentence highlight, pause/stop, speed slider; `Esc` interrupts |
| Resident process pool | Optionally launches and supervises a long-lived `api_v2.py` (never spawns per request); reuses an already-running service instead of starting a duplicate |
| Health & fallback | Periodic ping; after 3 consecutive failures falls back to the browser's Web Speech API, and switches back automatically once healthy |
| Config safety | zod-validated config persisted atomically with automatic backups (5 kept) and rollback on corruption |

## Requirements

- DeepSeek Harness desktop (Windows) or a dsh web profile, started at least once
- A working GPT-SoVITS deployment containing `api_v2.py` (v2Pro / v2ProPlus recommended)
- Node.js is **not** required to install the prebuilt package

## Quick start

```bat
:: 1. install (CLI form)
dsh plugin --profile desktop add link:D:/dsh-sovits-widget

:: 2. restart dsh, then click the 🔊 button in the bottom-right corner
:: 3. voice management -> new role -> pick a reference audio -> enable it
:: 4. basic settings -> turn on "auto-play assistant replies"
```

Manual installation (no CLI), service setup, and troubleshooting are covered step by step in [INSTALL.md](INSTALL.md).

## HTTP surface (`/dsh-sovits/*`)

| Route | Method | Purpose |
| --- | --- | --- |
| `client.js` | GET | Browser bundle (hot-read by mtime) |
| `config.json` | GET / PUT | Read / save config (PUT is zod-validated and backs up first) |
| `backups.json`, `rollback.json` | GET / POST | List backups / roll back |
| `speak.json`, `stop.json` | POST | Start synthesis / interrupt |
| `status.json?messageId=` | GET | Per-message synthesis state |
| `audio.bin?token=` | GET | Fetch synthesized WAV |
| `messages.json?since=` | GET | Recent messages (auto-play polling) |
| `health.json` | GET | Health, failure count, degradation flag |
| `preview.json` | POST | Voice preview |
| `upload-audio.json?filename=` | POST | Upload reference audio (ffmpeg denoise + trim) |
| `ref-audios.json?dir=` | GET | List reference audios |
| `logs.json`, `export-logs.json` | GET / POST | Read / export diagnostics |

All routes are guarded: a non-loopback request is rejected unless the host provides a trust fence.

## Development

```sh
pnpm install
pnpm test          # vitest, 62 cases, no network needed
pnpm typecheck     # tsc --noEmit
pnpm build         # esbuild -> lib/index.js + assets/sovits-widget.js
node scripts/smoke.mjs        # load the build against a stub Cordis context
node scripts/loader-check.cjs # verify the package resolves the way dsh does
```

The host half has no `@deepseek-ai` runtime dependency — every host capability is duck-typed (`ctx.webServer.register`, `ctx.systemPrompt.section`, `ctx.on('session/event')`, `webserver/index-inject`), so the plugin stays decoupled from the installed dsh build. Runtime dependencies are `zod` and `p-queue`, resolved from the profile's hoisted pnpm workspace.

## Project layout

```
src/host/    Host half: config (zod) / config-store / engine / provider / task-queue /
             lru-cache / text-cleaner / text-segmenter / emotion / style-injector /
             sovits-process / health / diagnostics / audio-tool / wav / routes / index
src/client/  Browser half: player (Web Audio) / console-ui / config-panel /
             message-buttons / ui / api / index
tests/       vitest unit tests
scripts/     build, smoke, loader check, preconfig, start-sovits.bat
```

## License

MIT — see [LICENSE](LICENSE).
