use super::error::SceneError;
use serde::{Deserialize, Serialize};

const MIN_QUATERNION_LENGTH_SQUARED: f64 = 1.0e-12;

pub const MAX_SCENE_BYTES: u64 = 50 * 1024 * 1024;
pub const STORED_FILENAME: &str = "scene.sog";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneOrientation {
    pub quaternion: [f64; 4],
}

impl Default for SceneOrientation {
    fn default() -> Self {
        Self {
            quaternion: [0.0, 0.0, 0.0, 1.0],
        }
    }
}

impl SceneOrientation {
    pub fn normalized(self) -> Result<Self, SceneError> {
        if !self.quaternion.iter().all(|value| value.is_finite()) {
            return Err(SceneError::invalid_input());
        }
        let length_squared = self
            .quaternion
            .iter()
            .map(|value| value * value)
            .sum::<f64>();
        if !length_squared.is_finite() || length_squared < MIN_QUATERNION_LENGTH_SQUARED {
            return Err(SceneError::invalid_input());
        }
        let inverse_length = length_squared.sqrt().recip();
        Ok(Self {
            quaternion: self.quaternion.map(|value| value * inverse_length),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneRecord {
    pub id: String,
    pub display_name: String,
    pub stored_filename: String,
    pub byte_size: u64,
    pub sha256: String,
    pub imported_at: i64,
    pub source_format: String,
    pub orientation: SceneOrientation,
    pub local_url: String,
}

impl SceneRecord {
    pub fn local_url_for(id: &str) -> String {
        if cfg!(target_os = "windows") {
            format!("http://scene.localhost/{id}/{STORED_FILENAME}")
        } else {
            format!("scene://localhost/{id}/{STORED_FILENAME}")
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "phase")]
pub enum ImportProgress {
    #[serde(rename = "copying")]
    Copying { bytes_copied: u64, total_bytes: u64 },
    #[serde(rename = "validating")]
    Validating { bytes_copied: u64, total_bytes: u64 },
    #[serde(rename = "committing")]
    Committing { bytes_copied: u64, total_bytes: u64 },
    #[serde(rename = "completed")]
    Completed { bytes_copied: u64, total_bytes: u64 },
}
