use super::error::SimulationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 64;
const EXPECTED_JOINTS: usize = 12;
pub const MODEL_ID: &str = "minimal-quadruped-v1";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolEnvelope<T> {
    protocol_version: u32,
    request_id: String,
    #[serde(rename = "type")]
    message_type: String,
    timestamp: i64,
    payload: T,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolCommand {
    Hello,
    Ping { nonce: String },
    Shutdown,
    LoadModel,
    Start,
    Pause,
    Step { steps: u16 },
    Reset,
    Stop,
    SetSpeed { speed: f64 },
}

impl ProtocolCommand {
    pub fn to_line(&self, request_id: String, timestamp: i64) -> Result<String, SimulationError> {
        let (message_type, payload) = match self {
            Self::Hello => (
                "hello",
                json!({"clientName":"tauri-host","clientProtocolVersion":PROTOCOL_VERSION}),
            ),
            Self::Ping { nonce } => ("ping", json!({"nonce":nonce})),
            Self::Shutdown => ("shutdown", json!({})),
            Self::LoadModel => ("load_model", json!({"modelId":MODEL_ID})),
            Self::Start => ("start", json!({})),
            Self::Pause => ("pause", json!({})),
            Self::Step { steps } => ("step", json!({"steps":steps})),
            Self::Reset => ("reset", json!({})),
            Self::Stop => ("stop", json!({})),
            Self::SetSpeed { speed } => {
                if !speed.is_finite() || !(0.25..=4.0).contains(speed) {
                    return Err(SimulationError::new(
                        "INVALID_SPEED",
                        "Simulation speed must be between 0.25 and 4.0.",
                    ));
                }
                ("set_speed", json!({"speed":speed}))
            }
        };
        serde_json::to_string(&ProtocolEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            message_type: message_type.into(),
            timestamp,
            payload,
        })
        .map_err(|_| SimulationError::internal())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SimulationState {
    Unloaded,
    Loaded,
    Running,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelLoadedPayload {
    pub model_id: String,
    pub timestep: f64,
    pub joint_count: u32,
    pub actuator_count: u32,
    pub body_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JointPose {
    pub name: String,
    pub position: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RobotPose {
    pub sequence: u32,
    pub simulation_time: f64,
    pub wall_time: i64,
    pub root_position: [f64; 3],
    pub root_orientation: [f64; 4],
    pub joints: Vec<JointPose>,
}

impl RobotPose {
    pub fn validate(&self) -> Result<(), SimulationError> {
        if !self.simulation_time.is_finite()
            || self.simulation_time < 0.0
            || self.wall_time < 0
            || self
                .root_position
                .iter()
                .chain(self.root_orientation.iter())
                .any(|v| !v.is_finite())
            || self.joints.len() != EXPECTED_JOINTS
            || self.joints.len() > 256
        {
            return Err(SimulationError::protocol());
        }
        let norm = self
            .root_orientation
            .iter()
            .map(|v| v * v)
            .sum::<f64>()
            .sqrt();
        if norm <= f64::EPSILON || (norm - 1.0).abs() > 1e-3 {
            return Err(SimulationError::protocol());
        }
        let mut names = HashSet::new();
        for joint in &self.joints {
            if joint.name.is_empty()
                || joint.name.len() > 64
                || !joint.name.is_ascii()
                || !joint.position.is_finite()
                || !names.insert(&joint.name)
            {
                return Err(SimulationError::protocol());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StateChangedPayload {
    pub state: SimulationState,
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyPayload {
    pub sidecar_name: String,
    pub sidecar_version: String,
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PongPayload {
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolErrorPayload {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum SimulationEvent {
    ModelLoaded(ModelLoadedPayload),
    Pose(RobotPose),
    StateChanged(StateChangedPayload),
    Warning(ProtocolErrorPayload),
    Error(ProtocolErrorPayload),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolResponse {
    Ready(ReadyPayload),
    Pong(PongPayload),
    ModelLoaded(ModelLoadedPayload),
    Pose(RobotPose),
    StateChanged(StateChangedPayload),
    ProcessStopping,
    Warning(ProtocolErrorPayload),
    Error(ProtocolErrorPayload),
}

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    pub request_id: Option<String>,
    pub response: ProtocolResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEnvelope {
    protocol_version: u32,
    request_id: Option<String>,
    #[serde(rename = "type")]
    message_type: String,
    timestamp: i64,
    payload: Value,
}

pub fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_BYTES
        && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

pub fn parse_response_line(bytes: &[u8]) -> Result<ParsedMessage, SimulationError> {
    if bytes.len() > MAX_LINE_BYTES {
        return Err(SimulationError::new(
            "MESSAGE_TOO_LARGE",
            "The simulation sidecar response exceeded the size limit.",
        ));
    }
    let raw: RawEnvelope =
        serde_json::from_slice(bytes).map_err(|_| SimulationError::protocol())?;
    if raw.protocol_version != PROTOCOL_VERSION || raw.timestamp < 0 || !raw.payload.is_object() {
        return Err(SimulationError::protocol());
    }
    if let Some(id) = &raw.request_id {
        if !valid_request_id(id) {
            return Err(SimulationError::protocol());
        }
    }
    let response = match raw.message_type.as_str() {
        "ready" => {
            let p: ReadyPayload =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            let expected = [
                "hello",
                "ping",
                "shutdown",
                "load_model",
                "start",
                "pause",
                "step",
                "reset",
                "stop",
                "set_speed",
            ]
            .map(str::to_owned);
            if p.protocol_version != PROTOCOL_VERSION
                || p.sidecar_name != "quadruped-simulation-sidecar"
                || p.sidecar_version.len() > 64
                || p.capabilities != expected
            {
                return Err(SimulationError::protocol());
            }
            ProtocolResponse::Ready(p)
        }
        "pong" => ProtocolResponse::Pong(
            serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?,
        ),
        "model_loaded" => {
            let p: ModelLoadedPayload =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            if p.model_id != MODEL_ID
                || (p.timestep - 0.002).abs() > 1e-12
                || p.joint_count != 12
                || p.actuator_count != 12
            {
                return Err(SimulationError::protocol());
            }
            ProtocolResponse::ModelLoaded(p)
        }
        "pose" => {
            let p: RobotPose =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            p.validate()?;
            ProtocolResponse::Pose(p)
        }
        "state_changed" => {
            if raw.payload.get("state").and_then(Value::as_str) == Some("stopping") {
                ProtocolResponse::ProcessStopping
            } else {
                let p: StateChangedPayload =
                    serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
                if let Some(speed) = p.speed {
                    if !speed.is_finite() || !(0.25..=4.0).contains(&speed) {
                        return Err(SimulationError::protocol());
                    }
                }
                ProtocolResponse::StateChanged(p)
            }
        }
        "error" => ProtocolResponse::Error(
            serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?,
        ),
        "warning" => ProtocolResponse::Warning(
            serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?,
        ),
        _ => return Err(SimulationError::protocol()),
    };
    if raw.request_id.is_none()
        && !matches!(
            response,
            ProtocolResponse::Pose(_) | ProtocolResponse::Warning(_) | ProtocolResponse::Error(_)
        )
    {
        return Err(SimulationError::protocol());
    }
    Ok(ParsedMessage {
        request_id: raw.request_id,
        response,
    })
}

pub fn sequence_is_newer(candidate: u32, current: u32) -> bool {
    let difference = candidate.wrapping_sub(current);
    difference != 0 && difference < (1_u32 << 31)
}
