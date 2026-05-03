//! Built-in effects.
//!
//! Phase 1 ships four effects: [`Solid`], [`Fade`], [`Chase`], and [`Rainbow`].

mod chase;
mod fade;
mod rainbow;
mod solid;

pub use chase::Chase;
pub use fade::Fade;
pub use rainbow::Rainbow;
pub use solid::Solid;
