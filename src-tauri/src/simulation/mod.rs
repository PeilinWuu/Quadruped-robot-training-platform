pub mod commands;
mod error;
mod manager;
pub(crate) mod process;
pub(crate) mod protocol;

pub use manager::{ControlSource, SimulationManager};

#[cfg(test)]
mod tests;
