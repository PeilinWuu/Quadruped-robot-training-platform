use super::manager::{LifecycleState, SimulationManager};

#[test]
fn manager_state_contract_starts_idle() {
    assert_eq!(
        SimulationManager::new().status().state,
        LifecycleState::Idle
    );
}
