use serde::Serialize;
use std::{error::Error, fmt};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimulationError {
    pub code: String,
    pub message: String,
}

impl SimulationError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }

    pub fn internal() -> Self {
        Self::new(
            "SIMULATION_INTERNAL_ERROR",
            "The simulation sidecar operation failed.",
        )
    }

    pub fn invalid_state() -> Self {
        Self::new(
            "INVALID_STATE",
            "The simulation sidecar is not in the required state.",
        )
    }

    pub fn timeout(code: &str) -> Self {
        Self::new(code, "The simulation sidecar did not respond in time.")
    }

    pub fn protocol() -> Self {
        Self::new(
            "SIDECAR_PROTOCOL_ERROR",
            "The simulation sidecar returned an invalid response.",
        )
    }
}

impl fmt::Display for SimulationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.code)
    }
}

impl Error for SimulationError {}
