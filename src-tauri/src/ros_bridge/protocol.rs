use crate::simulation::protocol::{MotionCommand, MotionCommandMode, RobotTelemetry};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const WATCHDOG_MS: u32 = 300;

#[derive(Debug, Clone, PartialEq)]
pub enum BridgeMessage {
    Ready {
        bridge_version: String,
        watchdog_ms: u32,
    },
    CmdVel(MotionCommand),
    WatchdogZero {
        last_cmd_vel_age_ms: Option<u64>,
    },
    Status {
        control_enabled: bool,
        last_cmd_vel_age_ms: Option<u64>,
        watchdog_state: String,
    },
    ProtocolError {
        code: String,
        message: String,
        recoverable: bool,
    },
}

pub fn outgoing_frame(kind: &str, payload: Value) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(&json!({
        "protocolVersion": PROTOCOL_VERSION,
        "type": kind,
        "payload": payload,
    }))
    .map_err(|_| "ROS bridge frame serialization failed".to_owned())?;
    if line.len() > MAX_FRAME_BYTES {
        return Err("ROS bridge frame exceeds the maximum size".into());
    }
    line.push(b'\n');
    Ok(line)
}

pub fn configure_frame(enabled: bool) -> Result<Vec<u8>, String> {
    outgoing_frame(
        "configure",
        json!({"controlEnabled":enabled,"watchdogMs":WATCHDOG_MS}),
    )
}

pub fn control_frame(enabled: bool) -> Result<Vec<u8>, String> {
    outgoing_frame("control_enable", json!({"enabled":enabled}))
}

pub fn telemetry_frame(telemetry: &RobotTelemetry) -> Result<Vec<u8>, String> {
    outgoing_frame(
        "telemetry",
        serde_json::to_value(telemetry)
            .map_err(|_| "ROS telemetry serialization failed".to_owned())?,
    )
}

pub fn shutdown_frame() -> Result<Vec<u8>, String> {
    outgoing_frame("shutdown", json!({}))
}

pub fn parse_bridge_frame(line: &[u8]) -> Result<BridgeMessage, String> {
    if line.is_empty() || line.len() > MAX_FRAME_BYTES {
        return Err("invalid ROS bridge frame size".into());
    }
    let value: Value =
        serde_json::from_slice(line).map_err(|_| "invalid ROS bridge JSON".to_owned())?;
    if value.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION.into()) {
        return Err("unsupported ROS bridge protocol version".into());
    }
    let payload = value
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(|| "invalid ROS bridge payload".to_owned())?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing ROS bridge frame type".to_owned())?;
    match kind {
        "ready" => {
            let bridge_version = string_field(payload, "bridgeVersion", 32)?;
            let watchdog_ms = u32_field(payload, "watchdogMs")?;
            if watchdog_ms != WATCHDOG_MS {
                return Err("ROS bridge watchdog configuration mismatch".into());
            }
            Ok(BridgeMessage::Ready {
                bridge_version,
                watchdog_ms,
            })
        }
        "cmd_vel" => {
            let sequence = u32_field(payload, "sequence")?;
            let forward_velocity = finite_field(payload, "forwardVelocity")?;
            let yaw_rate = finite_field(payload, "yawRate")?;
            let command = MotionCommand {
                sequence,
                mode: MotionCommandMode::Locomotion,
                forward_velocity,
                lateral_velocity: 0.0,
                yaw_rate,
                body_height: 0.3,
                valid_for_ms: WATCHDOG_MS,
            };
            command.validate().map_err(|error| error.code)?;
            Ok(BridgeMessage::CmdVel(command))
        }
        "watchdog_zero" => Ok(BridgeMessage::WatchdogZero {
            last_cmd_vel_age_ms: optional_u64_field(payload, "lastCmdVelAgeMs")?,
        }),
        "bridge_status" => {
            let control_enabled = payload
                .get("controlEnabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| "invalid bridge control state".to_owned())?;
            let watchdog_state = string_field(payload, "watchdogState", 16)?;
            if !matches!(watchdog_state.as_str(), "idle" | "armed" | "triggered") {
                return Err("invalid watchdog state".into());
            }
            Ok(BridgeMessage::Status {
                control_enabled,
                last_cmd_vel_age_ms: optional_u64_field(payload, "lastCmdVelAgeMs")?,
                watchdog_state,
            })
        }
        "protocol_error" => Ok(BridgeMessage::ProtocolError {
            code: string_field(payload, "code", 64)?,
            message: string_field(payload, "message", 256)?,
            recoverable: payload
                .get("recoverable")
                .and_then(Value::as_bool)
                .ok_or_else(|| "invalid protocol error recovery flag".to_owned())?,
        }),
        _ => Err("unknown ROS bridge frame type".into()),
    }
}

fn string_field(
    payload: &serde_json::Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<String, String> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("invalid {key}"))?;
    if value.is_empty() || value.len() > max {
        return Err(format!("invalid {key}"));
    }
    Ok(value.to_owned())
}

fn finite_field(payload: &serde_json::Map<String, Value>, key: &str) -> Result<f64, String> {
    let value = payload
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("invalid {key}"))?;
    value
        .is_finite()
        .then_some(value)
        .ok_or_else(|| format!("invalid {key}"))
}

fn u32_field(payload: &serde_json::Map<String, Value>, key: &str) -> Result<u32, String> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("invalid {key}"))
}

fn optional_u64_field(
    payload: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, String> {
    match payload.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("invalid {key}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_and_cmd_vel_parse() {
        assert!(matches!(
            parse_bridge_frame(br#"{"protocolVersion":1,"type":"ready","payload":{"bridgeVersion":"0.1.0","watchdogMs":300}}"#).unwrap(),
            BridgeMessage::Ready { .. }
        ));
        let command = parse_bridge_frame(br#"{"protocolVersion":1,"type":"cmd_vel","payload":{"sequence":4,"forwardVelocity":0.15,"yawRate":-0.3}}"#).unwrap();
        assert!(matches!(
            command,
            BridgeMessage::CmdVel(MotionCommand { sequence: 4, .. })
        ));
        assert!(matches!(
            parse_bridge_frame(br#"{"protocolVersion":1,"type":"watchdog_zero","payload":{"forwardVelocity":0.0,"yawRate":0.0,"lastCmdVelAgeMs":317}}"#).unwrap(),
            BridgeMessage::WatchdogZero { last_cmd_vel_age_ms: Some(317) }
        ));
    }

    #[test]
    fn invalid_json_version_command_and_size_are_rejected() {
        assert!(parse_bridge_frame(b"{").is_err());
        assert!(
            parse_bridge_frame(br#"{"protocolVersion":2,"type":"ready","payload":{}}"#).is_err()
        );
        assert!(parse_bridge_frame(br#"{"protocolVersion":1,"type":"cmd_vel","payload":{"sequence":1,"forwardVelocity":9.0,"yawRate":0.0}}"#).is_err());
        assert!(parse_bridge_frame(&vec![b'x'; MAX_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn outgoing_protocol_is_separate_and_bounded() {
        let frame = control_frame(true).unwrap();
        assert!(frame.len() <= MAX_FRAME_BYTES + 1);
        assert!(std::str::from_utf8(&frame)
            .unwrap()
            .contains("control_enable"));
        assert!(!std::str::from_utf8(&frame).unwrap().contains("requestId"));
    }
}
