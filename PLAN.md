# Christmas Light Show App — Project Plan 🎄✨

A phased plan to build a Christmas light show system using **Rust** (backend / hardware control) and **Angular** (web UI / show designer / simulator), starting with an in-browser simulator and progressing to whole-yard, music-synced, FM-broadcast displays.

---

## Table of Contents

1. [Goals](#goals)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Hardware Shopping List (Apartment Scale)](#hardware-shopping-list-apartment-scale)
5. [Phased Roadmap](#phased-roadmap)
6. [Simulator Design](#simulator-design)
7. [Suggested Repository Layout](#suggested-repository-layout)
8. [Key Rust Crates](#key-rust-crates)
9. [Safety Notes](#safety-notes)
10. [Next Steps](#next-steps)

---

## Goals

- Start **simulator-first** so we can develop without any hardware.
- Use the **same show engine** for both the virtual canvas and real LEDs (swap renderer at runtime).
- Build a small **apartment-scale show** (1 strip + a mini tree, ~100 pixels) as the first physical milestone.
- Progress toward a **whole-yard, music-synced, FM-broadcast** show with multiple controllers.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Hardware Control | Rust | Real-time GPIO/serial/network control of lights |
| Protocol Layer | Rust crates (`rs_ws281x`, `serialport`, `tokio`) | WS2812, DMX, E1.31 (sACN), DDP |
| Backend API | Rust (`axum`) | REST + WebSocket API for show control & simulator frames |
| Frontend UI | Angular | Show designer, timeline editor, live simulator |
| Audio Sync | Rust (`symphonia`, `rustfft`, `rodio`) | Beat detection, music-synced effects |
| Storage | SQLite via `sqlx` | Show sequences, layouts, presets, schedules |
| Hardware (progressive) | Raspberry Pi → ESP32 (WLED) → Pixel controllers | Start small, scale up |

---

## Architecture

The key insight: **the simulator is just another renderer** for the same show engine. The Rust core produces pixel frames; we send them to either a virtual canvas (browser) OR real LEDs.

```
┌─────────────────────────────────────────────────────────┐
│  Angular UI: Designer + Simulator Canvas                │
└────────────────┬────────────────────────────────────────┘
                 │ WebSocket (pixel frames @ 40 FPS)
┌────────────────▼────────────────────────────────────────┐
│  Rust Backend (axum)                                    │
│  ┌────────────────────────────────────────────────┐     │
│  │  Show Engine: effects → timeline → frame       │     │
│  └─────────────┬──────────────────────────────────┘     │
│                │ Vec<Rgb> per frame                     │
│        ┌───────┴────────┐                               │
│        ▼                ▼                               │
│  ┌──────────┐    ┌───────────────┐                      │
│  │ Virtual  │    │  Hardware     │                      │
│  │ Renderer │    │  Renderer     │                      │
│  │ (WS msg) │    │ (WS2812/E1.31)│                      │
│  └──────────┘    └───────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

A `trait Renderer { fn render(&mut self, frame: &[Rgb]); }` makes swapping trivial.

```rust
pub type Rgb = [u8; 3];

pub trait Renderer: Send {
    fn pixel_count(&self) -> usize;
    fn render(&mut self, frame: &[Rgb]) -> anyhow::Result<()>;
}

pub struct VirtualRenderer { /* broadcast channel to WS clients */ }
pub struct Ws2812Renderer  { /* SPI/PWM handle */ }
pub struct SacnRenderer    { /* UDP socket, universes */ }
```

---

## Hardware Shopping List (Apartment Scale)

Total: **~$80–$150** for a starter indoor show.

### 🟢 Essential (Phase 1 hardware day)

| # | Item | Notes | Est. Price |
|---|---|---|---|
| 1 | Raspberry Pi 4 (2GB or 4GB) | Pi 5 or Pi Zero 2 W also work | $35–$55 |
| 2 | MicroSD card (32GB, Class 10) | SanDisk / Samsung | $8 |
| 3 | Pi power supply | Official 5V/3A USB-C | $10 |
| 4 | WS2812B LED strip | 5V, 60 LEDs/m, 1–2 meters to start | $10–$15 |
| 5 | 5V power supply for LEDs | 5V / 4A barrel jack (do NOT power LEDs from the Pi) | $12 |
| 6 | DC barrel jack pigtail | Screw-terminal adapter | $5 |
| 7 | Jumper wires (F–F) | Pi GPIO → LED data line | $5 |
| 8 | 74AHCT125 level shifter ⚠️ | 3.3V → 5V signal conversion (highly recommended) | $3 |
| 9 | 1000µF capacitor (6.3V+) | Across LED strip power input | $1 |
| 10 | 470Ω resistor | Inline on data wire | $1 |
| 11 | Small breadboard | For the level shifter circuit | $5 |

### 🟡 Nice to Have (Phase 3–4)

- USB or 3.5mm powered speaker — $15–$25
- Second strip (different shape) — $10–$15
- WS2812B bullet pixel string (50 pixels) — $15–$20
- Mini 2–3 ft Christmas tree — $15–$25
- Ethernet cable — $5

### 🔵 Optional Upgrades

- ESP32 dev board (run [WLED](https://kno.wled.ge/)) — $8
- Pi case + heatsink — $10
- Project enclosure box — $8
- Multimeter — $15

---

## Phased Roadmap

### Phase 0 — Repo Bootstrap (Week 0)
- Cargo workspace + Angular app skeleton
- CI (build + lint for both Rust and Angular)
- README, this PLAN.md, contributing notes

### Phase 1 — "Hello, Virtual Lights!" (Weeks 1–2)
- `Renderer` trait + `VirtualRenderer`
- `axum` WebSocket streaming pixel frames
- Angular canvas component drawing pixels as glowing dots
- Effects: solid, fade, chase, rainbow
- ✅ **Deliverable:** Browser shows a virtual strip running effects

### Phase 2 — Web Control Panel (Weeks 3–4) ✅
- REST endpoints: `/api/effects`, `/api/status`, `/api/start`, `/api/stop`,
  `/api/effect`, `/api/color`, `/api/brightness`
- Live `ShowState` shared between engine + REST handlers (effect/color/
  brightness/play swap mid-frame)
- Angular: color picker, effect selector, brightness slider, live status
- ✅ **Deliverable:** Phone/laptop control of the virtual strip

### Phase 3 — Sequencer & Timeline Editor (Weeks 5–7)
- Timeline component, drag-and-drop effects per light group
- Layout designer (place virtual props on a "room map")
- **Stacked-strip "virtual matrix" groups:** group N parallel strips of equal
  length into a 2D grid prop and run matrix-style animations across them
  (per-row chases, vertical/horizontal wipes, scrolling text, plasma, 2D
  noise). The group exposes an (x, y) → pixel-index mapping (with optional
  serpentine/zig-zag wiring) so the same effect engine can address it as a
  W×H matrix; the renderer still emits a flat `Vec<Rgb>` per strip
- Save/load sequences + layouts as JSON in SQLite
- Frame-accurate playback engine (~40 FPS)
- ✅ **Deliverable:** Reusable, saveable shows previewed in the simulator,
  including 2D effects driven across stacked strips

### Phase 4 — Music Synchronization (Weeks 8–10)

#### Phase 4a — Foundations ✅ (done)
- Audio decode (`symphonia`), local onset/beat detection (spectral flux)
- Auto-generate beat-synced sequences from uploaded files
- Spotify integration: PKCE auth, search/library, Web Playback SDK,
  Deezer-ISRC BPM fallback (since `/v1/audio-analysis` is deprecated)
- `MicBeatService` — browser mic → onset pulses → `Reactive` effect
- Unified light-show transport (`SequencerTransportService` + footer
  `MusicConsoleComponent`) so any tab can drive playback

#### Phase 4b — Unified Now-Playing Pipeline ⏳ (next up)

**Problem.** The transport currently only plays content that has a saved
`Sequence`. A song highlighted in the Spotify panel without a generated
sequence has no path to the engine; the Music tab is upload-only; and the
mic source posts pulses out-of-band, invisible to the transport. The
result: when Deezer has no BPM (e.g. Feliz Navidad — TCM Hardstyle Version,
ISRC `QZTAX2260898`) sequence generation fails and the user dead-ends.

**Goal.** One pipeline, three input sources, one transport bar.

```
 ┌──────────────┐  ┌────────────────┐  ┌──────────────┐
 │ Music tab    │  │ Spotify tab    │  │ Live Input   │
 │ (uploads)    │  │ (search/lib)   │  │ (mic / line) │
 └──────┬───────┘  └────────┬───────┘  └──────┬───────┘
        │  Load into player │                 │
        ▼                   ▼                 ▼
 ┌──────────────────────────────────────────────────────┐
 │            NowPlayingService (UI singleton)          │
 │  source · metadata · sequenceId? · transport state   │
 └────────────────────────┬─────────────────────────────┘
                          │
       ┌──────────────────┼────────────────────┐
       ▼                  ▼                    ▼
 ┌───────────┐    ┌───────────────┐    ┌───────────────┐
 │ <audio>   │    │ Spotify SDK   │    │ MicBeatSvc    │
 │ + seq     │    │ + seq (opt.)  │    │ + Reactive    │
 └───────────┘    └───────────────┘    └───────────────┘
```

`MusicSource` is a discriminated union:

```ts
type MusicSource =
  | { kind: 'upload',  trackId: string, sequenceId: string }
  | { kind: 'spotify', trackId: string, uri: string,
                       sequenceId: string | null, bpm?: number }
  | { kind: 'live',    inputId: 'mic' | 'loopback' };  // reactive only
```

##### Tasks

- **Frontend services**
  - New `NowPlayingService` — single source of truth for *what's loaded*
    and *what's playing*. Owns the `MusicSource`, transport methods,
    seek/volume, and the "active" sequence id.
  - `SequencerTransportService` becomes sequence-only (range loop, current
    editing copy) and is *driven by* `NowPlayingService`.
  - `MusicConsoleComponent` reads exclusively from `NowPlayingService`;
    it no longer mixes `SpotifyService` + transport state directly.
  - `MicBeatService` becomes a first-class source (`{ kind: 'live' }`):
    starting the source toggles `Reactive` mode and the mic onset stream;
    stopping reverts to whatever was loaded before.

- **"Load into player" UX**
  - Spotify panel rows: `[ Load ]` button → `NowPlayingService.load({
    kind:'spotify', ... })`. If a sequence already exists, attach it; if
    not, load with `sequenceId: null` (lights run in `Reactive` mode while
    the song plays).
  - Music (upload) tab rows: `[ Load ]` button → upload source.
  - New "Live Input" tile → `live` source.
  - Highlighted (selected) ≠ loaded. Loading mirrors the track into the
    footer's now-playing block; playback always operates on the *loaded*
    source.

- **No-BPM fallback (Feliz Navidad case)**
  - Backend: `POST /api/spotify/track/:id/sequence` accepts
    `{ bpm?: f32 }`. When supplied, build the synthetic analysis via
    `synthesize_analysis(track, DeezerHit { bpm, .. })` directly,
    skipping Deezer. When omitted, current Deezer path runs.
  - Backend: typed error `NoBpm` returned when Deezer 404s and no manual
    BPM was supplied (so the UI can branch).
  - Frontend: when `NoBpm` comes back, surface an inline dialog with a
    **tap-tempo widget** + numeric BPM input + "Try again" button.
    Successful retry saves a real `Sequence` and the track loads into the
    player as usual.
  - Backup path: a Spotify track can also be loaded with `sequenceId:
    null` and played reactively (mic-driven) while the song streams via
    SDK — useful when the user just wants lights bouncing off the room.

- **"Record to upload" — saving music from speaker input**
  - Music tab gets a **"Record from mic"** button. Captures N seconds of
    audio in the browser (`MediaRecorder`) and posts the WAV blob to the
    existing `/api/audio/upload` route — which already runs symphonia
    decode + onset detection + sequence generation. No new backend
    endpoint required.
  - Result: a live performance / room mic / line-in capture becomes a
    saved upload with a generated sequence, immediately loadable into
    the unified player. This is what unlocks "save music data from
    speaker input."

- **Music tab structure**
  - Sub-tabs: **Uploads · Spotify (mirror) · Live Input** so all sources
    are reachable from one tab. The dedicated Spotify stage tab can stay
    as the "library/search" surface; the Music tab is the *player-centric*
    view.

##### Backend changes (small)
- `POST /api/spotify/track/:id/sequence`: optional `{ bpm }` body; typed
  `NoBpm` error variant.
- `synthesize_analysis`: already accepts a `DeezerHit`; expose a thin
  `synthesize_analysis_from_bpm(track, bpm)` helper.

##### Out of scope for 4b (still in Phase 4)
- MP4/video export (kept as a stretch goal).
- Real-time FFT-driven effects (Reactive mode is onset-only today; full
  FFT-bin → effect routing comes after the unified pipeline lands).

#### Phase 4c — Polish & exports
- Waveform overlay synced to the loaded source (uploads have it; show the
  same canvas for Spotify using a precomputed envelope from analysis).
- Real-time FFT-driven effects (frequency bins → per-pixel intensity).
- Export show as MP4 video (ffmpeg).

- ✅ **Deliverable (4b):** Any song from Uploads, Spotify, or the live mic
  loads into one player; the footer transport drives lights + audio
  together; the Feliz Navidad / "no Deezer BPM" case resolves via
  manual BPM or reactive playback.
- ✅ **Deliverable (4c):** MP4 export and FFT-driven effects.

### Phase 4.5 — 🎉 Hardware Day (Apartment)
- Wire up Pi + WS2812 strip + level shifter + cap (see safety notes below)
- Implement `Ws2812Renderer` using `rs_ws281x`
- Flip a config flag — **the same shows now play on real lights**
- ✅ **Deliverable:** First physical light show on a mini tree

### Phase 4.75 — Interop & Adoption ⭐

> **Why this phase exists:** the existing Christmas-light hobbyist community
> has already invested thousands of dollars in controllers (FPP, Falcon,
> HinksPix, AlphaPix, WLED, Light-O-Rama). They will not throw that gear out
> to try our app. The single highest-leverage move we can make is to **drive
> the hardware they already own** and **read/write the file formats they
> already use**. This converts the project from "yet another sequencer" into
> a drop-in modern front-end for setups that already work, which is also the
> foundation for any future SaaS / marketplace monetization.

- **`.fseq` export** (FPP/xLights sequence format, v2.0): serialize the show
  engine's frame output to FSEQ so any FPP or xLights user can play our
  shows on their existing controllers.
- **`.fseq` import** (moved up from Phase 6): round-trip compatibility lets
  users bring existing libraries into our designer/simulator.
- **E1.31 (sACN) streaming sender:** implement `SacnRenderer` (UDP, multiple
  universes, per-universe priority, unicast + multicast). This is the
  lingua franca of pixel controllers.
- **DDP sender:** lightweight alternative to sACN, used by WLED and others.
- **Universe / pixel-mapping config:** UI to map a layout's pixels to
  (universe, channel) ranges, with import from xLights `xlights_rgbeffects.xml`.
- **WLED JSON preset export:** for users running plain ESP32 + WLED.
- ✅ **Deliverable:** A user with an existing FPP/xLights/WLED rig can point
  our app at their network and run shows on real hardware **without buying
  anything new** — and can also export `.fseq` files to drop into their
  current workflow.

### Phase 5 — Scale Out (Weeks 11–14)
- Add ESP32 nodes running WLED
- Multi-universe pixel mapping at scale (builds on Phase 4.75 sACN/DDP work)
- Yard layout designer (2D map of props)
- ✅ **Deliverable:** Whole-yard synchronized show capability

### Phase 6 — Production Polish (Weeks 15+)
- Cron-style scheduler ("on at sunset, off at 10 PM")
- FM transmitter integration (broadcast audio for car radios)
- Weather pause (rain/wind)
- Telemetry dashboard (power, controller health)
- Docker container + systemd unit for Pi deployment

---

## Simulator Design

### Features by Phase

- **Phase 1:** 2D canvas, each pixel = glowing dot, real-time effect playback
- **Phase 2:** Drag-and-drop layout designer (strips as lines/curves, strings as paths, matrices as rectangles), snap-to-grid, save layouts as JSON
- **Phase 3:** Realistic glow with HTML5 Canvas radial gradients, dim-room background, configurable pixel size/spacing; stacked-strip groups render as a contiguous 2D grid so matrix effects can be previewed exactly as they'll appear on the wall
- **Phase 4:** Audio waveform + beat markers, scrubbable timeline, MP4 export
- **Phase 5 (stretch):** 3D yard view via Three.js for outdoor planning

### Tech Choices

| Concern | Choice | Why |
|---|---|---|
| 2D rendering | HTML5 Canvas | Fast, simple, perfect for hundreds of pixels |
| 3D rendering | Three.js (later) | Industry standard for browser 3D |
| Frame transport | WebSocket binary frames | ~40 FPS, low latency |
| Frame format | Packed `[u8; 3 * N]` RGB | Compact, zero-copy in Rust |
| Layout storage | JSON in SQLite | Easy import/export and sharing |

### Bonus Features

- 🎨 Effect library browser (preview effects on virtual layout)
- 🔁 A/B preview (simulator vs. real hardware side-by-side)
- 📸 Screenshot / GIF export
- 🌐 Shareable links (encode show JSON in URL)
- 🎮 Live "performance" mode (keyboard shortcuts to trigger effects like a DJ)

---

## Suggested Repository Layout

```
christmas-lightshow-app/
├── Cargo.toml                  # Rust workspace
├── PLAN.md                     # This file
├── README.md
├── crates/
│   ├── controller/             # Hardware drivers + Renderer trait
│   │   ├── virtual_renderer.rs
│   │   ├── ws2812_renderer.rs
│   │   └── sacn_renderer.rs
│   ├── sequencer/              # Show playback engine + effects
│   ├── audio/                  # FFT, beat detection
│   └── api/                    # axum HTTP/WebSocket server
├── ui/                         # Angular app
│   └── src/app/
│       ├── simulator/          # Canvas component
│       ├── timeline/           # Timeline editor
│       ├── layout-designer/    # Drag-and-drop room/yard map
│       └── live-control/       # Color picker, effect selector
└── shows/                      # Saved sequences & layouts (JSON / FSEQ)
```

---

## Key Rust Crates

- `rs_ws281x` / `smart-leds` — WS2812 pixel control
- `rppal` — Raspberry Pi GPIO/SPI/I2C
- `tokio` + `axum` — async backend with WebSockets
- `serialport` — DMX over USB
- `rustfft` — audio frequency analysis
- `symphonia` / `rodio` — audio decode/playback
- `sqlx` — SQLite persistence
- `serde` + `serde_json` — sequence/layout serialization
- `anyhow` / `thiserror` — error handling

---

## Safety Notes

1. **Never power more than ~50 LEDs from the Pi itself** — always use a separate 5V PSU.
2. **Common ground:** Connect the Pi's GND to the LED PSU's GND, or the data signal won't work.
3. **Power budget:** Each WS2812 LED draws up to **60mA at full white**. 60 LEDs = 3.6A. Size your PSU accordingly.
4. **Use a UL-listed PSU.** Don't run strips folded on themselves at full brightness.
5. **Apartment scale:** 1–2 strips + a pixel string is plenty for a living room and stays well under 30W total.

---

## Next Steps

- [ ] Bootstrap repo: Cargo workspace + Angular app + CI (Phase 0)
- [ ] Implement `Renderer` trait + `VirtualRenderer` (Phase 1)
- [ ] WebSocket pixel-frame streaming from `axum` (Phase 1)
- [ ] Angular canvas simulator component + 4 starter effects (Phase 1)
- [ ] **Interop wedge (Phase 4.75): `.fseq` export + `SacnRenderer` (E1.31)** — highest-leverage step for adoption and any future monetization, since it lets the app drive hardware users already own
- [ ] Open GitHub issues for each phase as a project roadmap

---

*Last updated: 2026-05-09*
