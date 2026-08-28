use super::error::SimulationError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 64;
const EXPECTED_JOINTS: usize = 12;
pub const MINIMAL_MODEL_ID: &str = "minimal-quadruped-v1";
pub const GO2_MODEL_ID: &str = "unitree-go2-menagerie";
pub const FLAT_GROUND_ENVIRONMENT_ID: &str = "flat-ground-v1";
pub const MINIMAL_JOINT_NAMES: [&str; 12] = [
    "front_left_hip_abduction",
    "front_left_hip_flexion",
    "front_left_knee",
    "front_right_hip_abduction",
    "front_right_hip_flexion",
    "front_right_knee",
    "rear_left_hip_abduction",
    "rear_left_hip_flexion",
    "rear_left_knee",
    "rear_right_hip_abduction",
    "rear_right_hip_flexion",
    "rear_right_knee",
];
pub const GO2_JOINT_NAMES: [&str; 12] = [
    "FL_hip_joint",
    "FL_thigh_joint",
    "FL_calf_joint",
    "FR_hip_joint",
    "FR_thigh_joint",
    "FR_calf_joint",
    "RL_hip_joint",
    "RL_thigh_joint",
    "RL_calf_joint",
    "RR_hip_joint",
    "RR_thigh_joint",
    "RR_calf_joint",
];

pub fn valid_model_id(value: &str) -> bool {
    matches!(value, MINIMAL_MODEL_ID | GO2_MODEL_ID)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EnvironmentId {
    #[serde(rename = "flat-ground-v1")]
    FlatGroundV1,
}

impl EnvironmentId {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FlatGroundV1 => FLAT_GROUND_ENVIRONMENT_ID,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentMetadata {
    pub id: EnvironmentId,
    pub display_name: String,
    pub floor_height: f64,
    pub half_extent: f64,
    pub demo_boundary_half_extent: f64,
    pub spawn_position: [f64; 3],
    pub spawn_orientation: [f64; 4],
    pub friction: [f64; 3],
    pub solref: [f64; 2],
    pub solimp: [f64; 3],
}

impl EnvironmentMetadata {
    pub fn validate(&self) -> Result<(), SimulationError> {
        if self.display_name.is_empty()
            || self.display_name.len() > 64
            || !finite(self.spawn_position)
            || !normalized(&self.spawn_orientation)
            || !finite([
                self.floor_height,
                self.half_extent,
                self.demo_boundary_half_extent,
            ])
            || !finite(self.friction)
            || !finite(self.solref)
            || !finite(self.solimp)
            || self.half_extent != 10.0
            || self.demo_boundary_half_extent != 8.0
            || self.floor_height != 0.0
            || self.friction != [0.9, 0.1, 0.01]
        {
            return Err(SimulationError::protocol());
        }
        Ok(())
    }
}

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
    Ping {
        nonce: String,
    },
    Shutdown,
    LoadModel {
        model_id: String,
        environment_id: EnvironmentId,
    },
    Start,
    Pause,
    Step {
        steps: u16,
    },
    Reset,
    Stop,
    SetSpeed {
        speed: f64,
    },
    SetMotionCommand(MotionCommand),
    ClearMotionCommand,
    SetTelemetryRate {
        rate_hz: u16,
    },
    GetLatestTelemetry,
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
            Self::LoadModel {
                model_id,
                environment_id,
            } => {
                if !valid_model_id(model_id) {
                    return Err(SimulationError::new(
                        "UNKNOWN_MODEL",
                        "The simulation model is not allowed.",
                    ));
                }
                (
                    "load_model",
                    json!({"modelId":model_id,"environmentId":environment_id.as_str()}),
                )
            }
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
            Self::SetMotionCommand(command) => {
                command.validate()?;
                (
                    "set_motion_command",
                    serde_json::to_value(command).map_err(|_| SimulationError::internal())?,
                )
            }
            Self::ClearMotionCommand => ("clear_motion_command", json!({})),
            Self::SetTelemetryRate { rate_hz } => {
                if !(10..=100).contains(rate_hz) {
                    return Err(SimulationError::new(
                        "INVALID_TELEMETRY_RATE",
                        "Telemetry rate must be between 10 and 100 Hz.",
                    ));
                }
                ("set_telemetry_rate", json!({"rateHz":rate_hz}))
            }
            Self::GetLatestTelemetry => ("get_latest_telemetry", json!({})),
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
pub enum MotionCommandMode {
    Stand,
    Locomotion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotionCommand {
    pub sequence: u32,
    pub mode: MotionCommandMode,
    pub forward_velocity: f64,
    pub lateral_velocity: f64,
    pub yaw_rate: f64,
    pub body_height: f64,
    pub valid_for_ms: u32,
}

impl MotionCommand {
    pub fn validate(&self) -> Result<(), SimulationError> {
        if !self.forward_velocity.is_finite()
            || !self.lateral_velocity.is_finite()
            || !self.yaw_rate.is_finite()
            || !self.body_height.is_finite()
            || !(-0.30..=0.30).contains(&self.forward_velocity)
            || !(-0.30..=0.30).contains(&self.lateral_velocity)
            || !(-0.50..=0.50).contains(&self.yaw_rate)
            || !(0.18..=0.40).contains(&self.body_height)
            || !(100..=2000).contains(&self.valid_for_ms)
        {
            return Err(SimulationError::new(
                "INVALID_MOTION_COMMAND",
                "The virtual motion command is outside the allowed range.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ControllerAvailability {
    StandHold,
    Go2KinematicAnimationV1,
    NotImplemented,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotionCommandStatus {
    pub sequence: u32,
    pub mode: MotionCommandMode,
    pub forward_velocity: f64,
    pub lateral_velocity: f64,
    pub yaw_rate: f64,
    pub body_height: f64,
    pub valid_for_ms: u32,
    pub age_ms: u64,
    pub timed_out: bool,
    pub applied_by_controller: bool,
    pub body_height_applied: bool,
    pub controller_availability: ControllerAvailability,
}

impl MotionCommandStatus {
    fn validate(&self) -> Result<(), SimulationError> {
        MotionCommand {
            sequence: self.sequence,
            mode: self.mode,
            forward_velocity: self.forward_velocity,
            lateral_velocity: self.lateral_velocity,
            yaw_rate: self.yaw_rate,
            body_height: self.body_height,
            valid_for_ms: self.valid_for_ms,
        }
        .validate()?;
        let stand = self.mode == MotionCommandMode::Stand;
        if (stand
            && (self.forward_velocity != 0.0
                || self.lateral_velocity != 0.0
                || self.yaw_rate != 0.0))
            || (stand && !self.applied_by_controller)
            || match self.controller_availability {
                ControllerAvailability::StandHold => !stand || self.body_height_applied,
                ControllerAvailability::Go2KinematicAnimationV1 => {
                    !self.applied_by_controller || !self.body_height_applied
                }
                ControllerAvailability::NotImplemented => {
                    stand || self.applied_by_controller || self.body_height_applied
                }
            }
        {
            return Err(SimulationError::protocol());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryConfig {
    pub rate_hz: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySource {
    pub kind: String,
    pub connected_to_physical_robot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RootTelemetry {
    pub position: [f64; 3],
    pub orientation: [f64; 4],
    pub linear_velocity_world: [f64; 3],
    pub angular_velocity_world: [f64; 3],
    pub linear_speed: f64,
    pub angular_speed: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImuTelemetry {
    pub orientation: [f64; 4],
    pub angular_velocity_body: [f64; 3],
    pub linear_acceleration_body: [f64; 3],
    pub frame: String,
    pub includes_gravity: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JointTelemetry {
    pub name: String,
    pub position: f64,
    pub velocity: f64,
    pub actuator_torque: f64,
    pub actuator_force: f64,
    pub control_target: f64,
    pub lower_limit: Option<f64>,
    pub upper_limit: Option<f64>,
    pub limited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FootTelemetry {
    pub name: String,
    pub in_contact: bool,
    pub contact_count: u32,
    pub normal_force: f64,
    pub force_world: [f64; 3],
    pub position_world: [f64; 3],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocomotionAvailability {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocomotionState {
    Standing,
    #[serde(rename = "entering_trot")]
    EnteringTrot,
    Locomotion,
    Stopping,
    Fault,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocomotionTelemetry {
    pub controller_id: String,
    pub availability: LocomotionAvailability,
    pub state: LocomotionState,
    pub commanded_forward_velocity: f64,
    pub commanded_lateral_velocity: f64,
    pub commanded_yaw_rate: f64,
    pub integrated_forward_velocity: f64,
    pub integrated_lateral_velocity: f64,
    pub integrated_yaw_rate: f64,
    pub gait_frequency_hz: f64,
    pub duty_factor: f64,
    pub gait_phase: f64,
    pub expected_contacts: [bool; 4],
    pub fault_reason: Option<String>,
}

impl LocomotionTelemetry {
    fn validate(&self, model_id: &str) -> Result<(), SimulationError> {
        if self.controller_id != "go2-kinematic-animation-v1"
            || self.availability
                != if model_id == GO2_MODEL_ID {
                    LocomotionAvailability::Available
                } else {
                    LocomotionAvailability::Unavailable
                }
            || !finite([
                self.commanded_forward_velocity,
                self.commanded_lateral_velocity,
                self.commanded_yaw_rate,
                self.integrated_forward_velocity,
                self.integrated_lateral_velocity,
                self.integrated_yaw_rate,
                self.gait_frequency_hz,
                self.duty_factor,
                self.gait_phase,
            ])
            || !(0.0..1.0).contains(&self.gait_phase)
            || !(0.0..=1.0).contains(&self.duty_factor)
            || self.gait_frequency_hz <= 0.0
            || self
                .fault_reason
                .as_ref()
                .is_some_and(|reason| reason.is_empty() || reason.len() > 128)
            || (self.state == LocomotionState::Fault) != self.fault_reason.is_some()
        {
            return Err(SimulationError::protocol());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceTelemetry {
    pub physics_frequency_hz: f64,
    pub control_frequency_hz: f64,
    pub pose_publish_frequency_hz: f64,
    pub telemetry_publish_frequency_hz: f64,
    pub real_time_factor: f64,
    pub physics_step_mean_ms: f64,
    pub physics_step_max_ms: f64,
    pub control_step_mean_ms: f64,
    pub control_step_max_ms: f64,
    pub dropped_pose_events: u64,
    pub dropped_telemetry_events: u64,
    pub catch_up_step_count: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CollisionCategory {
    Feet,
    Calves,
    Thighs,
    Hips,
    Torso,
    Head,
    OtherRobot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FallReason {
    None,
    TorsoContact,
    Orientation,
    Height,
    Multiple,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrongestContact {
    pub category: CollisionCategory,
    pub body_name: String,
    pub geom_name: String,
    pub normal_force: f64,
    pub position_world: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollisionTelemetry {
    pub environment_id: EnvironmentId,
    pub total_environment_contacts: u32,
    pub foot_contacts: u32,
    pub non_foot_contacts: u32,
    pub torso_contacts: u32,
    pub head_contacts: u32,
    pub limb_contacts: u32,
    pub max_normal_force: f64,
    pub total_normal_force: f64,
    pub strongest_contact: Option<StrongestContact>,
    pub is_fallen: bool,
    pub fall_reason: FallReason,
    pub is_out_of_bounds: bool,
    pub root_height_above_floor: f64,
    pub roll: f64,
    pub pitch: f64,
}

impl CollisionTelemetry {
    pub fn validate(&self) -> Result<(), SimulationError> {
        let counts_consistent = self.total_environment_contacts
            == self.foot_contacts.saturating_add(self.non_foot_contacts)
            && self.non_foot_contacts
                == self
                    .torso_contacts
                    .saturating_add(self.head_contacts)
                    .saturating_add(self.limb_contacts);
        if !counts_consistent
            || !finite([
                self.max_normal_force,
                self.total_normal_force,
                self.root_height_above_floor,
                self.roll,
                self.pitch,
            ])
            || self.max_normal_force < 0.0
            || self.total_normal_force < 0.0
            || self.roll.abs() > std::f64::consts::PI + 1e-6
            || self.pitch.abs() > std::f64::consts::FRAC_PI_2 + 1e-6
            || self.is_fallen != (self.fall_reason != FallReason::None)
        {
            return Err(SimulationError::protocol());
        }
        if let Some(contact) = &self.strongest_contact {
            if contact.body_name.len() > 64
                || contact.geom_name.len() > 96
                || !contact.normal_force.is_finite()
                || contact.normal_force < 0.0
                || !finite(contact.position_world)
                || (contact.normal_force - self.max_normal_force).abs() > 1e-6
            {
                return Err(SimulationError::protocol());
            }
        } else if self.total_environment_contacts != 0 || self.max_normal_force != 0.0 {
            return Err(SimulationError::protocol());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CollisionEventKind {
    CollisionStarted,
    CollisionEnded,
    ImpactDetected,
    FallDetected,
    Recovered,
    OutOfBounds,
    ReturnedInBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollisionEvent {
    pub kind: CollisionEventKind,
    pub simulation_time: f64,
    pub category: CollisionCategory,
    pub body_name: String,
    pub geom_name: String,
    pub normal_force: f64,
    pub position_world: [f64; 3],
}

impl CollisionEvent {
    pub fn validate(&self) -> Result<(), SimulationError> {
        if !self.simulation_time.is_finite()
            || self.simulation_time < 0.0
            || !self.normal_force.is_finite()
            || self.normal_force < 0.0
            || !finite(self.position_world)
            || self.body_name.len() > 64
            || self.geom_name.len() > 96
        {
            return Err(SimulationError::protocol());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RobotTelemetry {
    pub sequence: u32,
    pub simulation_time: f64,
    pub wall_time: i64,
    pub model_id: String,
    pub source: TelemetrySource,
    pub root: RootTelemetry,
    pub imu: ImuTelemetry,
    pub joints: Vec<JointTelemetry>,
    pub feet: Vec<FootTelemetry>,
    pub collision: CollisionTelemetry,
    pub command: MotionCommandStatus,
    pub locomotion: LocomotionTelemetry,
    pub performance: PerformanceTelemetry,
}

fn finite(values: impl IntoIterator<Item = f64>) -> bool {
    values.into_iter().all(f64::is_finite)
}

fn normalized(value: &[f64; 4]) -> bool {
    let norm = value.iter().map(|v| v * v).sum::<f64>().sqrt();
    norm > f64::EPSILON && (norm - 1.0).abs() <= 1e-3
}

impl RobotTelemetry {
    pub fn validate(&self) -> Result<(), SimulationError> {
        if !valid_model_id(&self.model_id)
            || self.simulation_time < 0.0
            || !self.simulation_time.is_finite()
            || self.wall_time <= 0
            || self.source.kind != "mujoco-simulation"
            || self.source.connected_to_physical_robot
            || self.imu.frame != "body"
            || self.imu.source.is_empty()
            || self.imu.source.len() > 64
            || !normalized(&self.root.orientation)
            || !normalized(&self.imu.orientation)
            || !finite(self.root.position)
            || !finite(self.root.linear_velocity_world)
            || !finite(self.root.angular_velocity_world)
            || !finite([self.root.linear_speed, self.root.angular_speed])
            || !finite(self.imu.angular_velocity_body)
            || !finite(self.imu.linear_acceleration_body)
            || self.joints.len() != EXPECTED_JOINTS
            || self.joints.len() > 256
            || self.feet.len() != 4
        {
            return Err(SimulationError::protocol());
        }
        let expected = match self.model_id.as_str() {
            GO2_MODEL_ID => &GO2_JOINT_NAMES,
            MINIMAL_MODEL_ID => &MINIMAL_JOINT_NAMES,
            _ => return Err(SimulationError::protocol()),
        };
        let mut names = HashSet::new();
        for (joint, expected_name) in self.joints.iter().zip(expected.iter()) {
            if joint.name != *expected_name
                || !names.insert(&joint.name)
                || !finite([
                    joint.position,
                    joint.velocity,
                    joint.actuator_torque,
                    joint.actuator_force,
                    joint.control_target,
                ])
                || joint.lower_limit.is_some_and(|v| !v.is_finite())
                || joint.upper_limit.is_some_and(|v| !v.is_finite())
                || joint.limited != (joint.lower_limit.is_some() && joint.upper_limit.is_some())
            {
                return Err(SimulationError::protocol());
            }
        }
        for (foot, expected_name) in self.feet.iter().zip(["FL", "FR", "RL", "RR"]) {
            if foot.name != expected_name
                || foot.normal_force < 0.0
                || !foot.normal_force.is_finite()
                || !finite(foot.force_world)
                || !finite(foot.position_world)
            {
                return Err(SimulationError::protocol());
            }
        }
        self.command.validate()?;
        self.locomotion.validate(&self.model_id)?;
        self.collision.validate()?;
        let summed_foot_contacts = self.feet.iter().map(|foot| foot.contact_count).sum::<u32>();
        if summed_foot_contacts != self.collision.foot_contacts {
            return Err(SimulationError::protocol());
        }
        let performance = &self.performance;
        if !finite([
            performance.physics_frequency_hz,
            performance.control_frequency_hz,
            performance.pose_publish_frequency_hz,
            performance.telemetry_publish_frequency_hz,
            performance.real_time_factor,
            performance.physics_step_mean_ms,
            performance.physics_step_max_ms,
            performance.control_step_mean_ms,
            performance.control_step_max_ms,
        ]) || performance.physics_frequency_hz < 0.0
            || performance.control_frequency_hz < 0.0
            || performance.pose_publish_frequency_hz < 0.0
            || performance.telemetry_publish_frequency_hz < 0.0
            || performance.real_time_factor < 0.0
            || performance.physics_step_mean_ms < 0.0
            || performance.physics_step_max_ms < 0.0
            || performance.control_step_mean_ms < 0.0
            || performance.control_step_max_ms < 0.0
        {
            return Err(SimulationError::protocol());
        }
        Ok(())
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
    pub environment_id: EnvironmentId,
    pub environment: EnvironmentMetadata,
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

    pub fn has_model_joints(&self, model_id: &str) -> bool {
        let expected = match model_id {
            MINIMAL_MODEL_ID => &MINIMAL_JOINT_NAMES,
            GO2_MODEL_ID => &GO2_JOINT_NAMES,
            _ => return false,
        };
        self.joints
            .iter()
            .map(|joint| joint.name.as_str())
            .eq(expected.iter().copied())
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
    Telemetry(Box<RobotTelemetry>),
    MotionCommandChanged(MotionCommandStatus),
    TelemetryConfigChanged(TelemetryConfig),
    Collision(CollisionEvent),
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
    Telemetry(Box<RobotTelemetry>),
    MotionCommandChanged(MotionCommandStatus),
    TelemetryConfigChanged(TelemetryConfig),
    Collision(CollisionEvent),
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
                "set_motion_command",
                "clear_motion_command",
                "set_telemetry_rate",
                "get_latest_telemetry",
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
            if !valid_model_id(&p.model_id)
                || (p.timestep - 0.002).abs() > 1e-12
                || p.joint_count != 12
                || p.actuator_count != 12
            {
                return Err(SimulationError::protocol());
            }
            p.environment.validate()?;
            if p.environment.id != p.environment_id {
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
        "telemetry" => {
            let p: RobotTelemetry =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            p.validate()?;
            ProtocolResponse::Telemetry(Box::new(p))
        }
        "motion_command_changed" => {
            let p: MotionCommandStatus =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            p.validate()?;
            ProtocolResponse::MotionCommandChanged(p)
        }
        "telemetry_config_changed" => {
            let p: TelemetryConfig =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            if !(10..=100).contains(&p.rate_hz) {
                return Err(SimulationError::protocol());
            }
            ProtocolResponse::TelemetryConfigChanged(p)
        }
        "collision_started" | "collision_ended" | "impact_detected" | "fall_detected"
        | "recovered" | "out_of_bounds" | "returned_in_bounds" => {
            let event: CollisionEvent =
                serde_json::from_value(raw.payload).map_err(|_| SimulationError::protocol())?;
            event.validate()?;
            let expected = match raw.message_type.as_str() {
                "collision_started" => CollisionEventKind::CollisionStarted,
                "collision_ended" => CollisionEventKind::CollisionEnded,
                "impact_detected" => CollisionEventKind::ImpactDetected,
                "fall_detected" => CollisionEventKind::FallDetected,
                "recovered" => CollisionEventKind::Recovered,
                "out_of_bounds" => CollisionEventKind::OutOfBounds,
                _ => CollisionEventKind::ReturnedInBounds,
            };
            if event.kind != expected {
                return Err(SimulationError::protocol());
            }
            ProtocolResponse::Collision(event)
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
            ProtocolResponse::Pose(_)
                | ProtocolResponse::Telemetry(_)
                | ProtocolResponse::MotionCommandChanged(_)
                | ProtocolResponse::TelemetryConfigChanged(_)
                | ProtocolResponse::Collision(_)
                | ProtocolResponse::Warning(_)
                | ProtocolResponse::Error(_)
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

#[cfg(test)]
mod telemetry_tests {
    use super::*;

    fn telemetry() -> RobotTelemetry {
        RobotTelemetry {
            sequence: 1,
            simulation_time: 0.1,
            wall_time: 1_700_000_000_000,
            model_id: GO2_MODEL_ID.into(),
            source: TelemetrySource {
                kind: "mujoco-simulation".into(),
                connected_to_physical_robot: false,
            },
            root: RootTelemetry {
                position: [0.0, 0.3, 0.0],
                orientation: [0.0, 0.0, 0.0, 1.0],
                linear_velocity_world: [0.0; 3],
                angular_velocity_world: [0.0; 3],
                linear_speed: 0.0,
                angular_speed: 0.0,
            },
            imu: ImuTelemetry {
                orientation: [0.0, 0.0, 0.0, 1.0],
                angular_velocity_body: [0.0; 3],
                linear_acceleration_body: [0.0; 3],
                frame: "body".into(),
                includes_gravity: false,
                source: "root-body-state".into(),
            },
            joints: GO2_JOINT_NAMES
                .iter()
                .map(|name| JointTelemetry {
                    name: (*name).into(),
                    position: 0.0,
                    velocity: 0.0,
                    actuator_torque: 0.0,
                    actuator_force: 0.0,
                    control_target: 0.0,
                    lower_limit: Some(-1.0),
                    upper_limit: Some(1.0),
                    limited: true,
                })
                .collect(),
            feet: ["FL", "FR", "RL", "RR"]
                .map(|name| FootTelemetry {
                    name: name.into(),
                    in_contact: true,
                    contact_count: 1,
                    normal_force: 30.0,
                    force_world: [0.0, 30.0, 0.0],
                    position_world: [0.0; 3],
                })
                .into(),
            collision: CollisionTelemetry {
                environment_id: EnvironmentId::FlatGroundV1,
                total_environment_contacts: 4,
                foot_contacts: 4,
                non_foot_contacts: 0,
                torso_contacts: 0,
                head_contacts: 0,
                limb_contacts: 0,
                max_normal_force: 30.0,
                total_normal_force: 120.0,
                strongest_contact: Some(StrongestContact {
                    category: CollisionCategory::Feet,
                    body_name: "FL_calf".into(),
                    geom_name: "FL".into(),
                    normal_force: 30.0,
                    position_world: [0.0; 3],
                }),
                is_fallen: false,
                fall_reason: FallReason::None,
                is_out_of_bounds: false,
                root_height_above_floor: 0.27,
                roll: 0.0,
                pitch: 0.0,
            },
            command: MotionCommandStatus {
                sequence: 0,
                mode: MotionCommandMode::Stand,
                forward_velocity: 0.0,
                lateral_velocity: 0.0,
                yaw_rate: 0.0,
                body_height: 0.3,
                valid_for_ms: 500,
                age_ms: 0,
                timed_out: false,
                applied_by_controller: true,
                body_height_applied: false,
                controller_availability: ControllerAvailability::StandHold,
            },
            locomotion: LocomotionTelemetry {
                controller_id: "go2-kinematic-animation-v1".into(),
                availability: LocomotionAvailability::Available,
                state: LocomotionState::Standing,
                commanded_forward_velocity: 0.0,
                commanded_lateral_velocity: 0.0,
                commanded_yaw_rate: 0.0,
                integrated_forward_velocity: 0.0,
                integrated_lateral_velocity: 0.0,
                integrated_yaw_rate: 0.0,
                gait_frequency_hz: 2.2,
                duty_factor: 0.65,
                gait_phase: 0.0,
                expected_contacts: [true; 4],
                fault_reason: None,
            },
            performance: PerformanceTelemetry {
                physics_frequency_hz: 500.0,
                control_frequency_hz: 100.0,
                pose_publish_frequency_hz: 60.0,
                telemetry_publish_frequency_hz: 50.0,
                real_time_factor: 1.0,
                physics_step_mean_ms: 0.1,
                physics_step_max_ms: 0.2,
                control_step_mean_ms: 0.01,
                control_step_max_ms: 0.02,
                dropped_pose_events: 0,
                dropped_telemetry_events: 0,
                catch_up_step_count: 0,
            },
        }
    }

    #[test]
    fn motion_validation_rejects_nonfinite_and_bounds() {
        let mut command = telemetry().command;
        assert!(command.validate().is_ok());
        command.forward_velocity = f64::NAN;
        assert!(command.validate().is_err());
        command.forward_velocity = 1.51;
        assert!(command.validate().is_err());
        command.forward_velocity = 0.0;
        command.valid_for_ms = 99;
        assert!(command.validate().is_err());
    }

    #[test]
    fn telemetry_validation_rejects_corrupt_semantics() {
        let mut value = telemetry();
        assert!(value.validate().is_ok());
        value.root.orientation = [0.0; 4];
        assert!(value.validate().is_err());
        value = telemetry();
        value.joints[1].name = value.joints[0].name.clone();
        assert!(value.validate().is_err());
        value = telemetry();
        value.feet[0].normal_force = -1.0;
        assert!(value.validate().is_err());
        value = telemetry();
        value.source.connected_to_physical_robot = true;
        assert!(value.validate().is_err());
    }

    #[test]
    fn locomotion_telemetry_validates_availability_fault_and_finite_data() {
        let mut value = telemetry();
        assert!(value.locomotion.validate(GO2_MODEL_ID).is_ok());
        value.locomotion.gait_phase = f64::NAN;
        assert!(value.validate().is_err());
        value = telemetry();
        value.locomotion.integrated_lateral_velocity = f64::NAN;
        assert!(value.validate().is_err());
        value = telemetry();
        value.locomotion.state = LocomotionState::Fault;
        assert!(value.validate().is_err());
        value.locomotion.fault_reason = Some("animation-state-invalid".into());
        assert!(value.validate().is_ok());
        value.locomotion.fault_reason = Some("x".repeat(129));
        assert!(value.validate().is_err());
    }

    #[test]
    fn ten_consecutive_fault_telemetry_frames_are_strictly_accepted() {
        for sequence in 1..=10_u32 {
            let mut value = telemetry();
            value.sequence = sequence;
            value.locomotion.state = LocomotionState::Fault;
            value.locomotion.fault_reason = Some("fall-detected".into());
            value.locomotion.commanded_forward_velocity = 0.0;
            value.locomotion.commanded_lateral_velocity = 0.0;
            value.locomotion.commanded_yaw_rate = 0.0;
            value.locomotion.integrated_forward_velocity = 0.0;
            value.locomotion.integrated_lateral_velocity = 0.0;
            value.locomotion.integrated_yaw_rate = 0.0;
            let frame = json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": null,
                "type": "telemetry",
                "timestamp": 1_700_000_000_000_i64 + i64::from(sequence),
                "payload": value,
            });
            let parsed = parse_response_line(&serde_json::to_vec(&frame).unwrap()).unwrap();
            assert!(matches!(parsed.response, ProtocolResponse::Telemetry(_)));
        }
    }

    #[test]
    fn locomotion_unknown_controller_state_and_retired_fields_are_rejected() {
        let mut json = serde_json::to_value(telemetry()).unwrap();
        json["locomotion"]["controllerId"] = json!("unknown");
        assert!(serde_json::from_value::<RobotTelemetry>(json.clone())
            .unwrap()
            .validate()
            .is_err());
        json = serde_json::to_value(telemetry()).unwrap();
        json["locomotion"]["state"] = json!("flying");
        assert!(serde_json::from_value::<RobotTelemetry>(json).is_err());
        json = serde_json::to_value(telemetry()).unwrap();
        json["locomotion"]["solverStatus"] = json!("retired");
        assert!(serde_json::from_value::<RobotTelemetry>(json).is_err());
    }

    #[test]
    fn minimal_model_requires_unavailable_locomotion() {
        let mut value = telemetry();
        value.model_id = MINIMAL_MODEL_ID.into();
        for (joint, name) in value.joints.iter_mut().zip(MINIMAL_JOINT_NAMES) {
            joint.name = name.into();
        }
        assert!(value.validate().is_err());
        value.locomotion.availability = LocomotionAvailability::Unavailable;
        assert!(value.validate().is_ok());
    }

    #[test]
    fn sequence_comparison_is_wrap_safe() {
        assert!(sequence_is_newer(0, u32::MAX));
        assert!(!sequence_is_newer(10, 10));
        assert!(!sequence_is_newer(9, 10));
    }

    #[test]
    fn environment_id_and_metadata_are_strict() {
        assert_eq!(
            serde_json::from_str::<EnvironmentId>("\"flat-ground-v1\"").unwrap(),
            EnvironmentId::FlatGroundV1
        );
        assert!(serde_json::from_str::<EnvironmentId>("\"other\"").is_err());
        let metadata = EnvironmentMetadata {
            id: EnvironmentId::FlatGroundV1,
            display_name: "纯平地演示场景".into(),
            floor_height: 0.0,
            half_extent: 10.0,
            demo_boundary_half_extent: 8.0,
            spawn_position: [0.0, 0.27, 0.0],
            spawn_orientation: [0.0, 0.0, 0.0, 1.0],
            friction: [0.9, 0.1, 0.01],
            solref: [0.02, 1.0],
            solimp: [0.9, 0.95, 0.001],
        };
        assert!(metadata.validate().is_ok());
    }

    #[test]
    fn collision_validation_rejects_inconsistent_and_nonfinite_values() {
        let mut collision = telemetry().collision;
        assert!(collision.validate().is_ok());
        collision.non_foot_contacts = 1;
        assert!(collision.validate().is_err());
        collision = telemetry().collision;
        collision.max_normal_force = f64::NAN;
        assert!(collision.validate().is_err());
        collision = telemetry().collision;
        collision.strongest_contact.as_mut().unwrap().normal_force = -1.0;
        assert!(collision.validate().is_err());
    }

    #[test]
    fn collision_event_is_strict_and_bounded() {
        let event = CollisionEvent {
            kind: CollisionEventKind::ImpactDetected,
            simulation_time: 1.0,
            category: CollisionCategory::Torso,
            body_name: "base".into(),
            geom_name: "base_torso_collision_0".into(),
            normal_force: 200.0,
            position_world: [0.0, 0.0, 0.0],
        };
        assert!(event.validate().is_ok());
        assert!(serde_json::to_vec(&event).unwrap().len() < MAX_LINE_BYTES);
    }
}
