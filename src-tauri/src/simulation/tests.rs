use super::{
    manager::{LifecycleState, SimulationManager},
    protocol::{
        parse_response_line, sequence_is_newer, ProtocolCommand, ProtocolResponse, RobotPose,
        SimulationState, MODEL_ID,
    },
};
use serde_json::{json, Value};

fn envelope(kind: &str, payload: Value) -> Vec<u8> {
    serde_json::to_vec(
        &json!({"protocolVersion":1,"requestId":"r","type":kind,"timestamp":1,"payload":payload}),
    )
    .unwrap()
}
fn pose(sequence: u32) -> Value {
    json!({"sequence":sequence,"simulationTime":0.2,"wallTime":1,"rootPosition":[1.0,2.0,3.0],"rootOrientation":[0.0,0.0,0.0,1.0],"joints":(0..12).map(|i|json!({"name":format!("joint-{i}"),"position":0.1})).collect::<Vec<_>>()})
}

#[test]
fn manager_starts_idle_and_unloaded() {
    let s = SimulationManager::new().status();
    assert_eq!(s.state, LifecycleState::Idle);
    assert_eq!(s.simulation_state, SimulationState::Unloaded);
}
#[test]
fn model_loaded_parses() {
    let m = parse_response_line(&envelope("model_loaded",json!({"modelId":MODEL_ID,"timestep":0.002,"jointCount":12,"actuatorCount":12,"bodyCount":14}))).unwrap();
    assert!(matches!(m.response, ProtocolResponse::ModelLoaded(_)));
}
#[test]
fn robot_pose_parses() {
    let m = parse_response_line(&envelope("pose", pose(1))).unwrap();
    assert!(matches!(m.response, ProtocolResponse::Pose(_)));
}
#[test]
fn non_finite_pose_rejected() {
    let mut p = pose(1);
    p["simulationTime"] = json!("NaN");
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn zero_quaternion_rejected() {
    let mut p = pose(1);
    p["rootOrientation"] = json!([0.0, 0.0, 0.0, 0.0]);
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn non_normalized_quaternion_rejected() {
    let mut p = pose(1);
    p["rootOrientation"] = json!([0.0, 0.0, 0.0, 2.0]);
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn too_many_joints_rejected() {
    let mut p = pose(1);
    p["joints"] = json!((0..257)
        .map(|i| json!({"name":format!("j{i}"),"position":0.0}))
        .collect::<Vec<_>>());
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn too_few_joints_rejected() {
    let mut p = pose(1);
    p["joints"] = json!([]);
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn duplicate_joint_names_rejected() {
    let mut p = pose(1);
    p["joints"][1]["name"] = json!("joint-0");
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn unknown_model_rejected() {
    assert!(parse_response_line(&envelope(
        "model_loaded",
        json!({"modelId":"other","timestep":0.002,"jointCount":12,"actuatorCount":12,"bodyCount":1})
    ))
    .is_err());
}
#[test]
fn illegal_state_rejected() {
    assert!(parse_response_line(&envelope(
        "state_changed",
        json!({"state":"flying","speed":1.0})
    ))
    .is_err());
}
#[test]
fn negative_simulation_time_rejected() {
    let mut p = pose(1);
    p["simulationTime"] = json!(-1.0);
    assert!(parse_response_line(&envelope("pose", p)).is_err());
}
#[test]
fn negative_timestamp_rejected() {
    let bytes=serde_json::to_vec(&json!({"protocolVersion":1,"requestId":"r","type":"pose","timestamp":-1,"payload":pose(1)})).unwrap();
    assert!(parse_response_line(&bytes).is_err());
}
#[test]
fn unsupported_protocol_rejected() {
    let bytes = serde_json::to_vec(
        &json!({"protocolVersion":2,"requestId":"r","type":"pose","timestamp":1,"payload":pose(1)}),
    )
    .unwrap();
    assert!(parse_response_line(&bytes).is_err());
}
#[test]
fn unknown_event_rejected_without_panic() {
    assert!(parse_response_line(&envelope("future_event", json!({}))).is_err());
}
#[test]
fn sequence_advances_and_old_is_rejected() {
    assert!(sequence_is_newer(2, 1));
    assert!(!sequence_is_newer(1, 2));
    assert!(!sequence_is_newer(2, 2));
}
#[test]
fn sequence_wrap_is_newer() {
    assert!(sequence_is_newer(0, u32::MAX));
    assert!(!sequence_is_newer(u32::MAX, 0));
}
#[test]
fn step_command_bounds_are_serialized() {
    let line = ProtocolCommand::Step { steps: 1000 }
        .to_line("r".into(), 1)
        .unwrap();
    assert!(line.contains("1000"));
}
#[test]
fn speed_valid_boundaries() {
    assert!(ProtocolCommand::SetSpeed { speed: 0.25 }
        .to_line("r".into(), 1)
        .is_ok());
    assert!(ProtocolCommand::SetSpeed { speed: 4.0 }
        .to_line("r".into(), 1)
        .is_ok());
}
#[test]
fn speed_invalid_values() {
    for speed in [0.0, -1.0, 4.1, f64::NAN, f64::INFINITY] {
        assert!(ProtocolCommand::SetSpeed { speed }
            .to_line("r".into(), 1)
            .is_err());
    }
}
#[test]
fn load_command_contains_only_fixed_model_id() {
    let line = ProtocolCommand::LoadModel.to_line("r".into(), 1).unwrap();
    assert!(line.contains(MODEL_ID));
    assert!(!line.contains(".."));
}
#[test]
fn process_stop_and_simulation_stop_are_distinct() {
    let a = ProtocolCommand::Stop.to_line("a".into(), 1).unwrap();
    let b = ProtocolCommand::Shutdown.to_line("b".into(), 1).unwrap();
    assert!(a.contains("\"stop\""));
    assert!(b.contains("shutdown"));
}
#[test]
fn asynchronous_pose_allows_null_request_id() {
    let bytes=serde_json::to_vec(&json!({"protocolVersion":1,"requestId":null,"type":"pose","timestamp":1,"payload":pose(1)})).unwrap();
    assert!(parse_response_line(&bytes).unwrap().request_id.is_none());
}
#[test]
fn robot_pose_json_is_small() {
    let parsed = parse_response_line(&envelope("pose", pose(1))).unwrap();
    if let ProtocolResponse::Pose(p) = parsed.response {
        assert!(serde_json::to_vec(&p).unwrap().len() < 256 * 1024);
    } else {
        panic!();
    }
}
#[test]
fn latest_pose_initially_empty() {
    assert!(SimulationManager::new().latest_pose().is_none());
}
#[test]
fn robot_pose_has_u32_sequence() {
    let p: RobotPose = serde_json::from_value(pose(u32::MAX)).unwrap();
    assert_eq!(p.sequence, u32::MAX);
}
