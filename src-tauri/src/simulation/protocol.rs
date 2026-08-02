use super::error::SimulationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 64;
const MAX_CAPABILITIES: usize = 16;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEnvelope<T> {
    pub protocol_version: u32,
    pub request_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub timestamp: i64,
    pub payload: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolCommand {
    Hello,
    Ping { nonce: String },
    Shutdown,
}

impl ProtocolCommand {
    pub fn to_line(&self, request_id: String, timestamp: i64) -> Result<String, SimulationError> {
        let (message_type, payload) = match self {
            Self::Hello => (
                "hello",
                json!({"clientName": "tauri-host", "clientProtocolVersion": PROTOCOL_VERSION}),
            ),
            Self::Ping { nonce } => ("ping", json!({"nonce": nonce})),
            Self::Shutdown => ("shutdown", json!({})),
        };
        serde_json::to_string(&ProtocolEnvelope {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            message_type: message_type.to_owned(),
            timestamp,
            payload,
        })
        .map_err(|_| SimulationError::internal())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadyPayload {
    pub sidecar_name: String,
    pub sidecar_version: String,
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PongPayload {
    pub nonce: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct StateChangedPayload {
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ProtocolErrorPayload {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolResponse {
    Ready(ReadyPayload),
    Pong(PongPayload),
    StateChanged(StateChangedPayload),
    Error(ProtocolErrorPayload),
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

pub fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_BYTES
        && request_id.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

pub fn parse_response_line(bytes: &[u8]) -> Result<(String, ProtocolResponse), SimulationError> {
    if bytes.len() > MAX_LINE_BYTES {
        return Err(SimulationError::new(
            "MESSAGE_TOO_LARGE",
            "The simulation sidecar response exceeded the size limit.",
        ));
    }
    let envelope: RawEnvelope =
        serde_json::from_slice(bytes).map_err(|_| SimulationError::protocol())?;
    if envelope.protocol_version != PROTOCOL_VERSION || envelope.timestamp < 0 {
        return Err(SimulationError::protocol());
    }
    let request_id = envelope.request_id.ok_or_else(SimulationError::protocol)?;
    if !valid_request_id(&request_id) || !envelope.payload.is_object() {
        return Err(SimulationError::protocol());
    }

    let response = match envelope.message_type.as_str() {
        "ready" => {
            let payload: ReadyPayload = serde_json::from_value(envelope.payload)
                .map_err(|_| SimulationError::protocol())?;
            if payload.protocol_version != PROTOCOL_VERSION
                || payload.sidecar_name != "quadruped-simulation-sidecar"
                || payload.sidecar_version.is_empty()
                || payload.sidecar_version.len() > 64
                || payload.capabilities.len() > MAX_CAPABILITIES
                || payload.capabilities != ["hello", "ping", "shutdown"].map(str::to_owned)
            {
                return Err(SimulationError::protocol());
            }
            ProtocolResponse::Ready(payload)
        }
        "pong" => ProtocolResponse::Pong(
            serde_json::from_value(envelope.payload).map_err(|_| SimulationError::protocol())?,
        ),
        "state_changed" => ProtocolResponse::StateChanged(
            serde_json::from_value(envelope.payload).map_err(|_| SimulationError::protocol())?,
        ),
        "error" => ProtocolResponse::Error(
            serde_json::from_value(envelope.payload).map_err(|_| SimulationError::protocol())?,
        ),
        _ => return Err(SimulationError::protocol()),
    };
    Ok((request_id, response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_request_identifiers() {
        assert!(valid_request_id("request-1"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id(&"x".repeat(65)));
        assert!(!valid_request_id("line\nbreak"));
    }

    #[test]
    fn rejects_unsupported_protocol_and_unknown_events() {
        let unsupported =
            br#"{"protocolVersion":2,"requestId":"x","type":"pong","timestamp":0,"payload":{}}"#;
        assert_eq!(
            parse_response_line(unsupported).unwrap_err().code,
            "SIDECAR_PROTOCOL_ERROR"
        );
        let unknown =
            br#"{"protocolVersion":1,"requestId":"x","type":"other","timestamp":0,"payload":{}}"#;
        assert_eq!(
            parse_response_line(unknown).unwrap_err().code,
            "SIDECAR_PROTOCOL_ERROR"
        );
    }

    #[test]
    fn rejects_damaged_and_oversized_lines() {
        assert_eq!(
            parse_response_line(b"{broken").unwrap_err().code,
            "SIDECAR_PROTOCOL_ERROR"
        );
        assert_eq!(
            parse_response_line(&vec![b'x'; MAX_LINE_BYTES + 1])
                .unwrap_err()
                .code,
            "MESSAGE_TOO_LARGE"
        );
    }
}
