# Spotify Sync + Live Mic Reactive Mode

Two ways to drive the light show from music. Spotify deprecated its
`/v1/audio-analysis` endpoint for apps registered after November 2024,
and this app was registered in 2026 — so the deprecated endpoint would
return 403 every time. We skip it entirely and use **Deezer's free
public API** (BPM by ISRC) as the sole analysis source.

## What was added

### Backend (Rust)

| File | What it does |
|---|---|
| [crates/spotify/src/fallback.rs](crates/spotify/src/fallback.rs) | Looks up ISRC on Deezer's free API → returns BPM; synthesizes a minimal `AudioAnalysis` (uniform beat grid, rotating "sections" every 16 beats) |
| [crates/spotify/src/api.rs](crates/spotify/src/api.rs) | Added `external_ids.isrc` to `Track` so we can hit Deezer by ISRC |
| [crates/api/src/spotify_routes.rs](crates/api/src/spotify_routes.rs) | `build_track_sequence` queries Deezer directly (no dead Spotify call); results cached on disk so re-syncs are instant |
| [crates/sequencer/src/effects/reactive.rs](crates/sequencer/src/effects/reactive.rs) | New pulse-driven `Reactive` effect with exponential decay + baseline glow |
| [crates/sequencer/src/show.rs](crates/sequencer/src/show.rs) | New `EffectKind::Reactive`; `ShowState::reactive_pulse(intensity, color)` auto-switches into reactive mode |
| [crates/api/src/rest.rs](crates/api/src/rest.rs) | New `POST /api/reactive/pulse` endpoint: `{ "value": 0..1, "color"?: {...} }` |

### Frontend (Angular)

| File | What it does |
|---|---|
| [ui/src/app/services/mic-beat.service.ts](ui/src/app/services/mic-beat.service.ts) | Opens mic via `getUserMedia`, runs an `AnalyserNode` on the 60–250 Hz kick band, posts pulses to `/api/reactive/pulse` on each onset |
| [ui/src/app/app-components/control-panel.html](ui/src/app/app-components/control-panel.html) | New "Live Mic Sync" toggle with sensitivity slider |
| [ui/src/app/app-components/control-panel.ts](ui/src/app/app-components/control-panel.ts) | `toggleMic()` wiring |
| [ui/src/app/models/show.models.ts](ui/src/app/models/show.models.ts) | `EffectKind` now includes `'reactive'` |

---

## How to use it

### 1. Spotify "Sync Lights" (via Deezer BPM)

Click **Sync Lights** on any track in the Spotify panel. The server:

1. Fetches the Spotify track metadata (for name, duration, and **ISRC**).
2. Queries `https://api.deezer.com/track/isrc:{ISRC}` for the BPM.
3. Synthesizes a uniform beat grid spanning the full duration and runs
   it through the existing sequence builder (color palette rotates every
   16 beats).
4. Saves the resulting sequence and starts playing it.

**Server logs on success:**

```text
INFO using Deezer BPM to synthesize analysis  isrc="USRC17607839" bpm=128
```

**When it won't work:**

- Track has no ISRC in Spotify's response (very rare).
- Deezer doesn't have the track (regional/indie releases sometimes missing).
- In either case, you'll get a clear error message — fall back to
  uploading the MP3 yourself in the Audio panel.

### 2. Live Mic Sync

1. In the **Live Control** panel, scroll to the **Live Mic Sync** section.
2. Click **Start**. Browser will prompt for microphone permission — allow
   it. (Must be on `localhost` or HTTPS; `getUserMedia` blocks plain HTTP.)
3. Play music on any source the laptop's mic can hear — Spotify desktop,
   AirPods on the table, a TV, a record player, a live band.
4. The lights will pulse on detected beats. The strip auto-switches into
   the `reactive` effect kind.
5. Use the **Sensitivity** slider to tune: lower values (~1.2×) detect
   quieter beats but trigger on noise; higher values (~2.0×) only catch
   strong kicks. `1.6×` is a good starting point.
6. Click **Stop** when done — releases the mic and stops pushing pulses.

**Tips:**

- Use a **line-in cable** instead of the mic if you have one — feed your
  speaker output directly into the laptop's audio input. Cleanest signal,
  no room noise.
- If you have multiple input devices, pick the right one in Windows
  Sound Settings *before* clicking Start (the browser uses the system
  default).
- The algorithm watches the 60–250 Hz "kick drum" band, so it works best
  on music with a clear bass beat.
- You can run **both features at the same time**: have a Deezer-derived
  sequence playing AND have mic sync on. The reactive effect takes over
  once a pulse arrives, replacing the sequence.

### 3. Combining the two

For Spotify playback specifically: open Spotify on the **same machine**
so the lightshow app's mic picks up your laptop speakers (or use
line-in). Click **Sync Lights** for a pre-computed sequence as a
baseline, then if a particular drop/fill isn't getting caught, flip
**Live Mic Sync** on top — live mic pulses will momentarily override the
sequence with reactive flashes.

### Restart required

The server picks up the new routes/effect on cold start. Run `dev.sh`
(or kill + restart the Rust process and `pnpm dev` in `ui/`).

---

## Why this design (background)

Spotify deprecated `/v1/audio-features`, `/v1/audio-analysis`,
recommendations, and related-artists for any app created after Nov 2024
— no equivalent endpoint replaces them. The Web Playback SDK streams
DRM-protected audio that browsers won't let JavaScript tap with an
`AnalyserNode` or `MediaRecorder`, so we can't decode the stream we're
already playing. That left two viable paths, both implemented:

- **Pre-analyze elsewhere, then sync to playback position** (Spotify
  path above): Deezer's public API still exposes per-track BPM keyed by
  ISRC. Combined with the existing Web Playback SDK `/api/playback/sync`
  loop, this gives us a deterministic beat grid that lines up with
  what's playing.
- **Listen to the room with the microphone** (Live Mic Sync): Web
  Audio's `AnalyserNode` on a `getUserMedia` stream runs a simple
  spectral-flux onset detector. Works with *any* sound source, not just
  Spotify — same approach as Hue Sync / Nanoleaf Rhythm.

The existing "upload an MP3" path remains the highest-fidelity option
when you have the file.
