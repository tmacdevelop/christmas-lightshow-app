# Spotify Integration Plan 🎵

A focused plan for adding Spotify-powered music search, beat analysis, and synchronized playback to the Christmas Light Show app.

> **Goal:** User logs into Spotify Premium → searches the full catalog from our UI → picks any song → lights are auto-synced to Spotify's professional beat analysis while the song plays in lock-step via the Web Playback SDK.

---

## Table of Contents

1. [Why Spotify](#why-spotify)
2. [Constraints & ToS Boundaries](#constraints--tos-boundaries)
3. [Prerequisites (User Setup)](#prerequisites-user-setup)
4. [Architecture Overview](#architecture-overview)
5. [Authentication Flow (PKCE)](#authentication-flow-pkce)
6. [Backend Plan](#backend-plan)
7. [Frontend Plan](#frontend-plan)
8. [Sync Strategy (Lights ↔ Playhead)](#sync-strategy-lights--playhead)
9. [Beat-Analysis → Sequence Mapping](#beat-analysis--sequence-mapping)
10. [Pluggable Provider Architecture](#pluggable-provider-architecture)
11. [Phased Build Order](#phased-build-order)
12. [Risks & Mitigations](#risks--mitigations)
13. [Open Questions for Tomorrow](#open-questions-for-tomorrow)

---

## Why Spotify

- ~100M tracks; covers virtually anything mainstream
- **Pre-computed professional audio analysis** (beats, bars, sections, segments with loudness/timbre/pitch) — far better than our local FFT detector
- **Web Playback SDK** plays full-quality DRM tracks in-browser with ms-accurate playhead events
- Stable, well-documented, free developer tier
- Combined: lights synced to the actual song, full quality, fully ToS-compliant

## Constraints & ToS Boundaries

These are hard limits — design must respect them:

- ❌ Cannot capture, decode, or save raw Spotify audio bytes
- ❌ Cannot persist Spotify track audio anywhere
- ❌ Cannot redistribute Spotify metadata as our own
- ❌ Cannot bypass the Web Playback SDK's player UI
- ✅ Can use `audio-analysis` JSON to drive our own light engine
- ✅ Can store our derived `Sequence` keyed by Spotify track ID
- ✅ Can sync our show clock to the SDK's playhead events

> **Note:** Spotify deprecated `audio-analysis` and `audio-features` for new third-party apps in late 2024 but kept them functional for existing/individual-use apps. Personal use should still work; commercial distribution would not.

### Spotify Redirect URI Security Requirements

Per Spotify's developer policy, the redirect URI registered in the dashboard
**and** sent in the `/authorize` request must obey:

- ✅ **HTTPS is required** for any non-loopback host
- ✅ **HTTP is permitted only for loopback** addresses
- ✅ Loopback **must be an explicit IP**: `http://127.0.0.1:PORT` or `http://[::1]:PORT`
- ❌ `http://localhost:PORT` is **rejected** by Spotify

We use `http://127.0.0.1:3000/api/spotify/auth/callback` everywhere — dashboard
config, `.env`, code, and tests. Deviating from this exact string (case, slash,
port) will fail with `INVALID_CLIENT: Invalid redirect URI` at the token
exchange step.

When we eventually deploy beyond localhost (Phase 6), the production redirect
URI must be HTTPS (e.g. `https://lights.example.com/api/spotify/auth/callback`)
and registered as a separate URI in the dashboard.

## Prerequisites (User Setup)

Before any code runs, the user must:

1. Go to <https://developer.spotify.com/dashboard>
2. Click **Create app**
3. Fill in:
   - App name: `Christmas Light Show` (or anything)
   - Redirect URI: `http://127.0.0.1:3000/api/spotify/auth/callback`
     > Spotify requires explicit loopback IPs for HTTP redirect URIs.
     > `localhost` is **not** accepted; use `127.0.0.1` (or `[::1]` for IPv6).
   - Which APIs: tick **Web API** and **Web Playback SDK**
4. Save the **Client ID** (no client secret needed — we use PKCE)
5. Add the Client ID to a local `.env` file (committed as `.env.example`):
   ```env
   SPOTIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/api/spotify/auth/callback
   ```

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Angular UI                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐     │
│  │ SpotifyPanel │  │ Search box + │  │ Web Playback SDK    │     │
│  │ (Login btn)  │  │ Result list  │  │ (plays DRM audio)   │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬──────────┘     │
│         │                 │                     │                │
└─────────┼─────────────────┼─────────────────────┼────────────────┘
          │                 │                     │ playhead ms
          ▼                 ▼                     ▼
┌──────────────────────────────────────────────────────────────────┐
│  Rust Backend                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/spotify/* routes                                     │  │
│  │  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────────────┐  │  │
│  │  │ auth    │ │ search  │ │ analysis │ │ sequence build  │  │  │
│  │  │ (PKCE)  │ │ proxy   │ │ fetch    │ │ + cache         │  │  │
│  │  └─────────┘ └─────────┘ └──────────┘ └─────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────┐    ┌─────────────────────────────────────┐     │
│  │ Token store  │    │ Existing show engine                │     │
│  │ (encrypted)  │    │ (now accepts external playhead)     │     │
│  └──────────────┘    └─────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │ api.spotify.com        │
                    │ - /v1/search           │
                    │ - /v1/audio-analysis/* │
                    │ - /v1/audio-features/* │
                    └────────────────────────┘
```

## Authentication Flow (PKCE)

PKCE = Authorization Code with Proof Key for Code Exchange. **No client secret required**, safe for SPAs and desktop apps.

```
1. User clicks "Login with Spotify"
   UI → GET  /api/spotify/auth/login
        Backend generates:
           - code_verifier (random 64-char)
           - code_challenge = SHA256(verifier) base64url
           - state (CSRF token)
        Backend stores {verifier, state} in short-lived session
        Backend returns Spotify authorize URL:
           https://accounts.spotify.com/authorize?
             client_id=...
             &response_type=code
             &redirect_uri=...
             &code_challenge_method=S256
             &code_challenge=...
             &state=...
             &scope=streaming user-read-email user-read-private
                   user-modify-playback-state user-read-playback-state

2. UI redirects browser to Spotify's authorize URL
3. User logs in + grants permissions
4. Spotify redirects back to /api/spotify/auth/callback?code=...&state=...

5. Backend callback handler:
   - Verifies state matches
   - POSTs to https://accounts.spotify.com/api/token with:
       grant_type=authorization_code
       code=...
       redirect_uri=...
       client_id=...
       code_verifier=...
   - Receives { access_token, refresh_token, expires_in }
   - Encrypts and stores tokens (filesystem keyring or AES-GCM file)
   - Redirects browser back to / with a success cookie

6. Subsequent /api/spotify/* calls:
   - Backend reads token, refreshes if expired (using refresh_token),
     proxies to api.spotify.com with Bearer header
```

**Required scopes:**
- `streaming` — Web Playback SDK
- `user-read-email`, `user-read-private` — basic profile
- `user-modify-playback-state`, `user-read-playback-state` — control playback

## Backend Plan

### New crate: `crates/spotify/`

Isolated so future providers (SoundCloud, Jamendo) follow the same shape.

```
crates/spotify/
├── Cargo.toml
└── src/
    ├── lib.rs           # public API: SpotifyClient
    ├── auth.rs          # PKCE flow, token refresh
    ├── api.rs           # search, audio-analysis, audio-features
    ├── analysis.rs      # types mirroring Spotify's analysis JSON
    ├── token_store.rs   # encrypted-at-rest token persistence
    └── error.rs
```

**Dependencies to add:**
- `reqwest` (with `rustls-tls` and `json`) — HTTP client
- `sha2`, `base64` — PKCE challenge
- `rand` — random verifier + state
- `aes-gcm` (or `ring`) — token encryption at rest
- `chrono` — token expiry tracking
- `url` — URL building

### New module: `crates/api/src/spotify_routes.rs`

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/spotify/auth/login` | Returns `{ authorize_url }` for the SPA to redirect to |
| GET | `/api/spotify/auth/callback` | Handles Spotify redirect, exchanges code, stores token |
| GET | `/api/spotify/auth/status` | `{ authenticated: bool, user?: {...} }` |
| POST | `/api/spotify/auth/logout` | Clears stored token |
| GET | `/api/spotify/search?q=&type=track&limit=20` | Proxies to Spotify Search |
| GET | `/api/spotify/track/:id` | Track metadata |
| GET | `/api/spotify/track/:id/analysis` | Full audio-analysis JSON (cached) |
| POST | `/api/spotify/track/:id/sequence` | Builds + saves a `Sequence` from analysis |

### Engine changes

Add a third `PlaybackMode::ExternalSync`:
- Show clock takes its `position_ms` from an external source instead of `Instant::now() - started_at`
- New REST endpoint: `POST /api/playback/sync { position_ms }` — UI pushes playhead from the SDK at ~10 Hz

```rust
pub enum PlaybackMode {
    Live,
    Sequence,
    ExternalSync { sequence_id: String, position_ms: u64 },
}
```

### Caching

- `crates/api/src/spotify_cache.rs` — JSON-on-disk cache for `audio-analysis` keyed by track ID
- Cuts Spotify API hits to once per track ever
- Cache directory configurable via `config.toml` → `spotify_cache_dir`

### Config additions (`config.toml`)

```toml
[spotify]
client_id = ""              # or read from SPOTIFY_CLIENT_ID env
redirect_uri = "http://127.0.0.1:3000/api/spotify/auth/callback"
cache_dir = "spotify-cache"
token_path = "spotify-token.bin"
```

## Frontend Plan

### New service: `ui/src/app/spotify.service.ts`

```typescript
@Injectable({ providedIn: 'root' })
export class SpotifyService {
  // signals
  authenticated = signal(false);
  user = signal<SpotifyUser | null>(null);
  searchResults = signal<SpotifyTrack[]>([]);
  selectedTrack = signal<SpotifyTrack | null>(null);
  playerState = signal<PlayerState | null>(null);

  // methods
  login(): Promise<void>           // opens authorize URL
  logout(): Promise<void>
  refreshAuth(): Promise<void>
  search(query: string): Promise<SpotifyTrack[]>
  getAnalysis(trackId: string): Promise<AudioAnalysis>
  generateSequence(trackId: string): Promise<Sequence>

  // Web Playback SDK lifecycle
  initPlayer(): Promise<void>      // loads SDK script, creates Player
  play(trackUri: string): Promise<void>
  pause(): Promise<void>
  seek(ms: number): Promise<void>
}
```

### New component: `ui/src/app/spotify-panel.ts`

Sections:
1. **Auth bar** — "Login with Spotify" / user avatar + logout
2. **Search box** with debounced input (300ms)
3. **Results list** — track cards (album art, title, artist, duration, "Sync Lights" button)
4. **Now-playing strip** (when a track is loaded):
   - Album art, title/artist
   - Transport: ⏮ ⏯ ⏭ + scrubber
   - "Generate light show" → calls backend, lights up simulator preview
   - "Play synced" → starts Spotify playback + pushes playhead to backend

### Web Playback SDK integration

```typescript
// In SpotifyService.initPlayer()
window.onSpotifyWebPlaybackSDKReady = () => {
  this.player = new Spotify.Player({
    name: 'Christmas Light Show',
    getOAuthToken: cb => this.getAccessToken().then(cb),
    volume: 0.8,
  });

  this.player.addListener('player_state_changed', (state) => {
    this.playerState.set(state);
    // Push position to backend at high rate
    this.pushPlayhead(state.position);
  });

  this.player.connect();
};

// Push playhead at 10 Hz while playing
private pushPlayhead(positionMs: number) {
  fetch('/api/playback/sync', {
    method: 'POST',
    body: JSON.stringify({ position_ms: positionMs }),
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### Music tab — add a third sub-tab

Existing Music tab gets sub-tabs: **[Local Files]** **[Spotify]** **[SoundCloud (later)]**

## Sync Strategy (Lights ↔ Playhead)

### Problem
The browser SDK reports playhead position via `player_state_changed` events — but those fire only on state changes (~every 1s in steady playback). Naive use means our lights run on a stale position.

### Solution: client-side dead-reckoning

```typescript
// Every state change updates our reference points:
let referencePosition = state.position;
let referenceTimestamp = performance.now();

// 10 Hz interpolation pushed to backend:
setInterval(() => {
  if (state.paused) return;
  const elapsed = performance.now() - referenceTimestamp;
  const currentPosition = referencePosition + elapsed;
  pushPlayhead(currentPosition);
}, 100);
```

Backend receives smoothed playhead → engine resolves the active clip in our generated `Sequence` → renders correct frame. Latency budget: ~50–150 ms (SDK→browser→backend→render→WS→canvas) which is imperceptible for beat-flash effects.

## Beat-Analysis → Sequence Mapping

Spotify's `audio-analysis` returns rich nested JSON. Our converter:

```rust
fn build_sequence(analysis: &AudioAnalysis, track: &Track) -> Sequence {
    let mut clips = Vec::new();

    // Strategy 1: Section-driven palette + beat-driven flashes
    for (section_idx, section) in analysis.sections.iter().enumerate() {
        let palette = palette_for_key(section.key, section.mode);

        // Beats inside this section → solid flashes cycling palette
        for beat in beats_in_range(&analysis.beats, section.start, section.end) {
            let next_beat_start = next_beat_or_end(beat, section.end);
            clips.push(Clip {
                id: format!("beat-{}", clips.len()),
                start_ms: (beat.start * 1000.0) as u64,
                duration_ms: ((next_beat_start - beat.start) * 1000.0) as u64,
                kind: pick_effect(beat.confidence, section.energy),
                color: palette[clips.len() % palette.len()],
            });
        }
    }

    Sequence { id, name, duration_ms, clips }
}
```

### Mapping table

| Spotify field | Drives |
|---|---|
| `beats[]` | Clip timing |
| `sections[].loudness` | Brightness ramps between sections |
| `sections[].tempo` | Effect speed (faster = chase shorter width) |
| `sections[].key` + `mode` | Color palette (major = warm, minor = cool) |
| `segments[].pitches[]` (12 chroma) | Per-segment hue (Phase 4.1 enhancement) |
| `segments[].timbre[]` | Effect kind selection (bright timbre → rainbow, dark → fade) |

## Pluggable Provider Architecture

To make SoundCloud/Jamendo trivial to add later:

```rust
// crates/audio/src/provider.rs
#[async_trait]
pub trait MusicProvider: Send + Sync {
    fn id(&self) -> &str;             // "spotify" | "local" | ...
    fn display_name(&self) -> &str;
    fn auth_status(&self) -> AuthStatus;

    async fn search(&self, query: &str, limit: usize)
        -> Result<Vec<TrackSummary>>;

    async fn fetch_analysis(&self, track_id: &str)
        -> Result<TrackAnalysis>;     // unified shape

    fn playback_kind(&self) -> PlaybackKind;
}

pub enum PlaybackKind {
    LocalFile { path: PathBuf },
    DirectStream { url: String },
    EmbeddedSdk { provider_id: String, track_uri: String },
}

pub struct TrackAnalysis {
    pub duration_ms: u64,
    pub bpm: f32,
    pub beats_ms: Vec<u32>,
    pub sections: Vec<Section>,        // optional, populated by Spotify
    pub key: Option<u8>,
    pub mode: Option<u8>,
}
```

Then `LocalProvider`, `SpotifyProvider` (and later `SoundCloudProvider`, `JamendoProvider`) all implement the same trait and the UI gets a unified search experience.

## Phased Build Order

| Step | Scope | Status |
|---|---|---|
| 1 | Spotify Developer app + .env wiring | ⏳ user task |
| 2 | `crates/spotify/` skeleton + PKCE auth flow | ⏳ |
| 3 | Token storage (encrypted at rest) | ⏳ |
| 4 | Search proxy endpoint | ⏳ |
| 5 | Audio-analysis fetch + cache | ⏳ |
| 6 | Analysis → `Sequence` converter | ⏳ |
| 7 | `MusicProvider` trait + refactor existing local audio under it | ⏳ |
| 8 | Angular `SpotifyService` (auth + REST only) | ⏳ |
| 9 | `SpotifyPanel` component (login, search, generate) | ⏳ |
| 10 | Web Playback SDK integration | ⏳ |
| 11 | `PlaybackMode::ExternalSync` + `/api/playback/sync` | ⏳ |
| 12 | Dead-reckoning playhead pusher | ⏳ |
| 13 | Polish: error states, token-expired UX, rate-limit handling | ⏳ |

**Estimate:** Steps 2–6 are one focused session (backend can be tested with curl). Steps 7–12 are the second session. Step 13 is incremental.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Spotify deprecates `audio-analysis` for our app | Medium | Cache aggressively; fall back to local FFT analyzer if 404 |
| Web Playback SDK rate limits or session conflicts | Low | Reuse single device, document Premium-only requirement |
| Token leakage from disk | Low | AES-GCM at rest; gitignore token file; add `.env.example` only |
| Sync drift on long tracks | Medium | Re-anchor on every `player_state_changed` event |
| User on Free tier → SDK fails silently | High | Detect via `auth/status` (product=premium check), show clear error |
| CORS issues during local dev | Medium | Use existing Vite/proxy setup, redirect URI must exactly match dashboard |

## Open Questions for Tomorrow

Things to decide before / during implementation:

1. **Token storage location** — keep in workspace dir, or in user's OS config dir (`%APPDATA%`/`~/.config`)?
2. **Multi-user support** — assume single user for now, or namespace tokens by Spotify user ID?
3. **Generated sequence overwriting** — if user re-generates for the same track, replace or version?
4. **Color-palette-from-key mapping** — do we want hand-curated palettes per key, or programmatic HSV rotation?
5. **Section transitions** — hard cut between sections, or crossfade effect?
6. **Offline mode** — should cached analyses still let the user *design* a sequence even when not logged in?
7. **Mobile** — Web Playback SDK is desktop-only; do we want a fallback that uses the 30-sec preview URL on mobile?

---

## Quick reference: relevant files in current repo

To extend cleanly tomorrow, the following files will be touched:

- New: [crates/spotify/](crates/spotify/) — entire crate
- New: [crates/api/src/spotify_routes.rs](crates/api/src/spotify_routes.rs)
- New: [crates/api/src/spotify_cache.rs](crates/api/src/spotify_cache.rs)
- Modified: [Cargo.toml](Cargo.toml) — add member + workspace deps
- Modified: [crates/api/Cargo.toml](crates/api/Cargo.toml) — add `spotify` + `reqwest`
- Modified: [crates/api/src/main.rs](crates/api/src/main.rs) — mount routes, init token store
- Modified: [crates/api/src/state.rs](crates/api/src/state.rs) — add SpotifyClient + cache
- Modified: [crates/api/src/rest.rs](crates/api/src/rest.rs) — add `/api/playback/sync`
- Modified: [crates/sequencer/src/show.rs](crates/sequencer/src/show.rs) — add `ExternalSync` mode
- Modified: [config.toml](config.toml) — `[spotify]` section
- New: [ui/src/app/spotify.service.ts](ui/src/app/spotify.service.ts)
- New: [ui/src/app/spotify-panel.ts](ui/src/app/spotify-panel.ts)
- Modified: [ui/src/app/audio-panel.ts](ui/src/app/audio-panel.ts) — convert to tabbed view
- Modified: [ui/src/index.html](ui/src/index.html) — load Web Playback SDK script

---

*Last updated: 2026-05-09 — sleep well, see you tomorrow* 🎄💤
