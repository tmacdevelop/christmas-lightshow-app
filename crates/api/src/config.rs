//! Runtime configuration loaded from `config.toml`.

use std::{net::SocketAddr, path::Path};

use sequencer::EffectKind;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub pixel_count: usize,
    pub fps: u32,
    pub bind: SocketAddr,
    #[serde(default)]
    pub effect: EffectKind,
}

impl Config {
    pub fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        let raw = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
        let cfg: Config =
            toml::from_str(&raw).map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;

        anyhow::ensure!(cfg.pixel_count > 0, "pixel_count must be > 0");
        anyhow::ensure!(cfg.fps > 0, "fps must be > 0");
        Ok(cfg)
    }
}
