//! Built-in effects.
//!
//! Phase 1 ships four effects: [`Solid`], [`Fade`], [`Chase`], and [`Rainbow`].
//! Phase 4 (Spotify / mic) adds [`Reactive`] — a pulse-driven effect.

mod chase;
mod fade;
mod rainbow;
mod reactive;
mod solid;

pub use chase::Chase;
pub use fade::Fade;
pub use rainbow::Rainbow;
pub use reactive::{Reactive, ReactiveHandle};
pub use solid::Solid;
