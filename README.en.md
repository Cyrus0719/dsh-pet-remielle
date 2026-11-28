# Remielle Desktop Pet · dsh-pet-remielle-desktop

[![npm](https://img.shields.io/npm/v/dsh-pet-remielle-desktop?color=f2a0c0&label=npm)](https://www.npmjs.com/package/dsh-pet-remielle-desktop)
[![stars](https://img.shields.io/github/stars/Cyrus0719/dsh-pet-remielle?color=f2a0c0&label=stars)](https://github.com/Cyrus0719/dsh-pet-remielle/stargazers)
[![license](https://img.shields.io/npm/l/dsh-pet-remielle-desktop?color=f2a0c0)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-f2a0c0)](#install)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-f2a0c0)](https://github.com/topics/dsh-plugin)

English | [简体中文](README.md)

A transparent, always-on-top desktop pet for **DeepSeek Harness** on Windows: 754 hand-cleaned animation frames, a real DSH agent session, images and emoji, and a chat card that lays itself out in all four directions. Not a sticker inside a web page — a desktop companion that can actually get work done.

![demo](docs/demo.gif)

## Why keep her around

- **A real desktop window**: a dedicated Neutralino window (transparent / borderless / always-on-top / hidden from the taskbar) playing six native 340×304 animated WebPs at the original 30 ms frame rate. Crisp at any scale.
- **She works**: say something on the desktop and she opens a real DSH agent session (current workspace, workspace-write). Tool calls, commands and file reads all happen inside DSH; the same session shows up in the DSH Web GUI, so you can keep talking or assign more work there.
- **Images and emoji**: attach up to four images with the ＋ button; emoji render in full color, and image paths or URLs in her replies become inline thumbnails you can click to enlarge.
- **Markdown layout**: replies render as Markdown — headings, bold, strikethrough, inline code, horizontally scrollable code blocks, ordered / unordered lists, quotes, links and tables; streaming replies are typeset as they arrive.
- **Resizable chat card**: drag the small handle on the outer bottom corner of the card to change its width and height (300×360 minimum); the size is stored in ui.json and restored next time.
- **Four-way layout**: she sits on the right half, the card opens left; left half, it opens right; near the top or bottom, it slides back on screen. Her own position never moves when the card opens.
- **Full-screen yield**: when a full-screen game or video is in front, she drops always-on-top and hides; she comes back when you leave full screen.
- **Drag, collapse, close**: − / + / × on hover resize and collapse her into a draggable 64×64 badge that expands on click. The context menu only has “Quit”; bring her back with `/pet on` in any DSH session.
- **She remembers**: conversation, position and scale are persisted across DSH restarts.
- **Picks up where you left off**: when the chat card opens, a model summarizes the recent turns into 1–2 concrete next steps you can send with one click; if there is nothing to continue, she stays quiet.

## Listed on

| Registry | Status |
| --- | --- |
| [dsh-plugin.org](https://dsh-plugin.org/zh/plugins/cyrus0719/dsh-pet-remielle) | ✅ Listed |
| [WhaleHub](https://whalehub-dsh.vercel.app) | ✅ Listed (fun) |
| [DSH Market](https://github.com/2BingLing/dsh-market) | ✅ Listed |
| [npm](https://www.npmjs.com/package/dsh-pet-remielle-desktop) | ✅ Published |
| dsh-plugin-hub / DSH-Store / dsh-plugin-shop / awesome-dsh-plugin / awesome-deepseek-harness / dsh-go-market | 🕓 In review |

> If you find her useful, please give the repo a star~

## Install

Requires Windows 10/11 and DSH 0.2.x+. The Neutralino runtime is bundled; no build scripts run at install time and no allowBuilds entry is needed.

### From npm (recommended)

```
plugin_manager install_bundle target="npm:dsh-pet-remielle-desktop"
```

Equivalent CLI:

```bash
dsh plugin --profile <profile> add dsh-pet-remielle-desktop
```

### From GitHub

```
plugin_manager install_bundle target="github:Cyrus0719/dsh-pet-remielle"
```

### From a local checkout

```
plugin_manager install_bundle target="file:C:/Users/<you>/dsh-pet-remielle"
```

She is enabled right after installation. If no window appears, check that the plugin entry is active; after editing plugin code, toggle the entry off and on to reload.

If runtime/neutralino-win_x64.exe goes missing, run `node scripts/install-neutralino.mjs` to download it again.

### Uninstall

```
plugin_manager remove_bundle target="dsh-pet-remielle-desktop"
```

Then delete `%USERPROFILE%\.dsh\desktop-pet` (conversation, position and scale live there).

## Usage

| Action | Result |
| --- | --- |
| Click the pet | Open / close the chat card |
| Right-click the pet | “Quit” (bring her back with `/pet on`); the small line below opens the GitHub repo for a star |
| Drag the pet | Move her (remembered) |
| − / + on hover | Shrink / grow (0.5×–2× in 0.25 steps, remembered) |
| × on hover | Collapse into a 64×64 badge |
| Drag / click the badge | Move (remembered) / expand back to the pet |
| Chat header ⟲ / ↗ / × | New session / open it in the DSH Web GUI / close the card |
| ＋ in the composer | Attach images (up to 4) |
| Drag the handle at the card's outer bottom corner | Resize the chat card (remembered) |
| Enter / Shift+Enter | Send / new line |

“Quit” ends the window and its process; the plugin itself stays enabled. To bring her back:

1. Send `/pet on` in any DSH session (`/pet off` fully closes her);
2. Toggle dsh-pet-remielle-desktop off and on in the plugin panel.

Use the × on hover when you only want her out of the way — position and conversation are kept.

## Data

- `%USERPROFILE%\.dsh\desktop-pet\chat.json` — last 60 turns + current session id
- `%USERPROFILE%\.dsh\desktop-pet\position.json` — window position
- `%USERPROFILE%\.dsh\desktop-pet\ui.json` — scale and chat card size

The conversation itself lives in the DSH session (chat.json is only a transcript excerpt), so the same session can be resumed from the DSH Web GUI.

## Pet assets and swapping pets

`assets/pets/remielle/pet.json` defines the pet:

```json
{
  "id": "remielle",
  "displayName": "Remielle",
  "cell": [340, 304],
  "animations": {
    "idle": "anims/idle.webp",
    "thinking": "anims/thinking.webp",
    "tool": "anims/tool.webp",
    "review": "anims/review.webp",
    "waiting": "anims/waiting.webp",
    "done": "anims/done.webp"
  }
}
```

To use another pet, drop the same structure into `assets/pets/<id>/` (a `pet.json` plus transparent animated WebPs) and change `petId` in `cordis.patch.yml`. You can also place it in `%USERPROFILE%\.dsh\desktop-pet\pets\<id>\` — the user directory wins over the bundled one.

## What's new in 1.4.0

- Replies render as Markdown: headings, bold, italics, strikethrough, inline code, code blocks, ordered / unordered lists, quotes, links, images and tables; streaming replies are typeset live and older turns are re-rendered too.
- The chat card is resizable: drag the handle at its outer bottom corner; the size is persisted.

### 1.3.0

- “Picks up where you left off” suggestions when the chat card opens: a model summarizes the recent turns into 1–2 concrete, one-click next steps.
- Removed the fixed greeting, the three preset questions and the first-launch popup.
- The context menu is just “Quit”; the star entry became a small line with a ⭐ and ↗.
- Fixed: suggestion cards were covered by the composer gradient, and long suggestions were clamped to two lines.

### 1.2.0

- Send-to-corner menu item, ⭐ repo entry, first-launch greeting, “say something to start” subtitle.
- Fixed: the full-screen watcher script was missing from the package; the collapsed badge was clipped at 150% DPI; `/pet on` could not restore her after a full close.

## Implementation

- Window backend, state machine and pet-directory conventions come from [dsh-desktop-pet](https://github.com/sereinmono/dsh-desktop-pet) (MIT).
- Added here: native-resolution animation frame streaming (no more 8×9 sprite sheet), a chat card (real DSH sessions / images / emoji / four-way layout / auto-scroll), state-machine fixes (stuck on “drawing” after a tool result, stale tasks after disconnecting), full-screen yield, persisted scale and position, a draggable collapsed badge, no tray icon, AI next-step suggestions from recent chat, Markdown rendering and a resizable chat card.
- The frontend is a single `assets/neutralino/resources/index.html`; the host is `lib/index.js`.

## Credits (important)

- Pet art by **HanaAyane / Kolemi** — https://github.com/HanaAyane/remielle-codex-pet
- Fan art derived from *Zenless Zone Zero*; the frames were hand-organized and AI-assisted redrawn. This package only converts formats (GIF → transparent WebP).
- **Personal, non-commercial fan use only**: no selling, no paid distribution, no renaming or impersonation, no trademark registration, and no implication of official endorsement by miHoYo / HoYoverse. Keep the credit and repository link when sharing.
- See [NOTICE.md](NOTICE.md) and [ASSET-USAGE.md](ASSET-USAGE.md).

## License

Code: MIT (see [LICENSE](LICENSE), including the upstream dsh-desktop-pet MIT notice).
Bundled pet art: not covered by MIT; copyright HanaAyane / Kolemi, personal non-commercial fan use only.
