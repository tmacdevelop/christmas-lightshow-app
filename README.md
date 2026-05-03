# christmas-lightshow-app 🎄✨

A Christmas light show system built with **Rust** (backend / hardware control) and (eventually) **Angular** (web UI / show designer / simulator).

The project is being built in phases — see [PLAN.md](PLAN.md) for the full roadmap. Current status: **Phase 0 complete** (workspace bootstrap). Phase 1 ("Hello, Virtual Lights!") is up next.

---

## Project Status

| Phase | Description | Status |
|---|---|---|
| 0 | Repo bootstrap — Cargo workspace, CI, tooling | ✅ Done |
| 1 | `Renderer` trait + `VirtualRenderer` + axum WebSocket | 🚧 Next |
| 2 | Web control panel (REST API + Angular UI) | ⏳ |
| 3 | Sequencer & timeline editor | ⏳ |
| 4 | Music synchronization | ⏳ |
| 4.5 | 🎉 Hardware day — first physical light show | ⏳ |
| 5 | Scale out (E1.31, multiple controllers) | ⏳ |
| 6 | Production polish (scheduler, FM, telemetry) | ⏳ |

---

## Repository Layout

```
christmas-lightshow-app/
├── Cargo.toml              # Rust workspace root
├── rust-toolchain.toml     # Pinned stable toolchain (1.95.0)
├── rustfmt.toml            # Formatting config (edition 2024, max_width 100)
├── .gitattributes          # LF line endings across platforms
├── .github/workflows/      # CI (fmt + clippy + test)
├── crates/
│   ├── controller/         # Renderer trait + hardware drivers (Phase 1+)
│   ├── sequencer/          # Show playback engine + effects (Phase 1+)
│   └── api/                # axum HTTP/WebSocket server (binary: lightshow-api)
├── PLAN.md                 # Full project plan and phased roadmap
└── README.md
```

---

## Tech Stack

- **Rust** (edition 2024, toolchain pinned to 1.95.0) — workspace with three crates: `controller`, `sequencer`, `api`.
- **GitHub Actions CI** — `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` on every push and PR to `main`.
- Future: `axum` + `tokio` (Phase 1), `rs_ws281x` / `rppal` (Phase 4.5+), `symphonia` / `rustfft` (Phase 4), `sqlx` (Phase 3), Angular (Phase 1+).

---

## Prerequisites

- **Rust** 1.95.0 or newer — install via [rustup](https://rustup.rs).
  - The toolchain is pinned in `rust-toolchain.toml`, so `rustup` will auto-install the correct version on first `cargo` invocation.
- **Git** with LF-friendly settings (the repo's `.gitattributes` enforces LF line endings; no extra config needed).

---

## Getting Started

Clone the repo and build the workspace:

```bash
git clone https://github.com/tylerwoody/christmas-lightshow-app.git
cd christmas-lightshow-app
cargo build --workspace
```

Run the API binary (currently a placeholder):

```bash
cargo run -p api
# → lightshow-api: not yet implemented
```

---

## Development

Run the same checks CI runs:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

Format the workspace:

```bash
cargo fmt --all
```

---

## Roadmap

The full phased plan, hardware shopping list, architecture diagrams, and safety notes live in [PLAN.md](PLAN.md).

---

## License

Dual-licensed under MIT or Apache-2.0 at your option.
