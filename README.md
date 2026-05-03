# christmas-lightshow-app 🎄✨

A Christmas light show system built with **Rust** (backend / hardware control) and **Angular** (web UI / show designer / simulator).

The same show engine drives both an in-browser virtual simulator and real LED hardware — swap the renderer at runtime to move from a canvas of glowing dots to physical strips on a tree.

---

## Repository Layout

```
christmas-lightshow-app/
├── Cargo.toml              # Rust workspace root
├── rust-toolchain.toml     # Pinned Rust toolchain
├── rustfmt.toml            # Rust formatting config
├── config.toml             # Runtime config for lightshow-api
├── .gitattributes          # LF line endings across platforms
├── .github/workflows/      # CI (Rust + frontend)
├── crates/                 # Rust workspace
│   ├── controller/         # Renderer trait + hardware drivers
│   ├── sequencer/          # Show playback engine + effects
│   └── api/                # axum HTTP/WebSocket server (binary: lightshow-api)
├── ui/                     # Angular frontend (simulator + designer)
├── PLAN.md                 # Phased roadmap, hardware list, safety notes
└── README.md
```

### Crates

- **`controller`** — defines the `Renderer` trait and ships `VirtualRenderer` (broadcasts frames to WebSocket clients). Future hardware backends (`Ws2812Renderer`, `SacnRenderer`) implement the same trait.
- **`sequencer`** — the show engine. Defines the `Effect` trait and a fixed-FPS `Engine` that drives any effect into any renderer.
- **`api`** — `lightshow-api` binary. Loads `config.toml`, starts the engine, and serves HTTP/WebSocket endpoints.

### Frontend

- **`ui/`** — Angular app (standalone components, signals, Tailwind v4). The simulator subscribes to the backend's WebSocket frame stream and renders pixels on a canvas.

---

## Tech Stack

- **Rust** (edition 2024) — async backend with `tokio` + `axum`.
- **Angular** with **Tailwind v4** — frontend, served by `pnpm`.
- **GitHub Actions CI** — `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, plus an Angular production build.
- **Future hardware:** Raspberry Pi → ESP32 (WLED) → networked pixel controllers via WS2812, DMX, E1.31 (sACN), DDP.

---

## Prerequisites

- **Rust** — install via [rustup](https://rustup.rs). The toolchain is pinned in `rust-toolchain.toml` and will auto-install on first `cargo` invocation.
- **Node.js** 22+ and **pnpm** 10+ — for the Angular frontend.
- **Git** — `.gitattributes` enforces LF line endings, so no extra config is needed.

---

## Getting Started

Clone and build everything:

```bash
git clone https://github.com/tylerwoody/christmas-lightshow-app.git
cd christmas-lightshow-app

# Build the Rust workspace
cargo build --workspace

# Install frontend dependencies
cd ui && pnpm install && cd ..
```

### Running the app

The backend and frontend run as two processes:

```bash
# Terminal 1 — backend (axum + show engine)
cargo run -p api

# Terminal 2 — frontend (Angular dev server with proxy to backend)
cd ui && pnpm exec ng serve
```

The Angular dev server opens `http://127.0.0.1:4200` in your browser and proxies `/ws` and `/healthz` to the backend on port 3000.

### Configuration

Runtime configuration lives in [config.toml](config.toml) at the repo root:

| Key | Meaning |
|---|---|
| `pixel_count` | Number of virtual pixels in the strip |
| `fps` | Target frame rate of the show engine |
| `bind` | Address the HTTP/WebSocket server binds to |
| `effect` | Built-in effect to play: `solid`, `fade`, `chase`, or `rainbow` |

Override the config path with the `LIGHTSHOW_CONFIG` environment variable.

### Backend endpoints

| Endpoint | Description |
|---|---|
| `GET /healthz` | Liveness probe (returns `ok`) |
| `GET /ws` | Binary WebSocket stream — packed `[r, g, b, ...]` bytes per frame |
| `GET /ws?format=json` | Same stream as JSON text frames (debugging only) |

---

## Development

Run the same checks CI runs:

```bash
# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets

# Frontend
cd ui
pnpm exec ng build --configuration production
```

Format the Rust workspace:

```bash
cargo fmt --all
```

### Pre-commit hook

A `.githooks/pre-commit` hook runs the same Rust + Angular checks CI runs, but
only for the toolchain whose files are staged. Enable it once per clone:

```bash
./.githooks/install.sh
# or, equivalently:
git config core.hooksPath .githooks
```

Bypass for a single commit with `git commit --no-verify`.

---

## Roadmap

The full phased plan, hardware shopping list, architecture diagrams, and safety notes live in [PLAN.md](PLAN.md).

---

## License

Dual-licensed under MIT or Apache-2.0 at your option.
