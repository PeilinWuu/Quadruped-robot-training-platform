mod auth;
mod scenes;
mod simulation;

use tauri::Manager;

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("scene", scenes::protocol::handle)
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let auth_state = auth::AuthState::initialize(app_data_dir.clone())?;
            let scene_state = scenes::SceneState::initialize(app_data_dir)?;
            app.manage(simulation::SimulationManager::new());
            app.manage(auth_state);
            app.manage(scene_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_current_user,
            auth::auth_register,
            auth::auth_login,
            auth::auth_logout,
            scenes::commands::scene_list,
            scenes::commands::scene_current,
            scenes::commands::scene_import,
            scenes::commands::scene_cancel_import,
            scenes::commands::scene_set_current,
            scenes::commands::scene_update_orientation,
            scenes::commands::scene_delete,
            simulation::commands::simulation_sidecar_start,
            simulation::commands::simulation_sidecar_status,
            simulation::commands::simulation_sidecar_ping,
            simulation::commands::simulation_sidecar_stop,
            simulation::commands::simulation_load_model,
            simulation::commands::simulation_run_start,
            simulation::commands::simulation_run_pause,
            simulation::commands::simulation_run_step,
            simulation::commands::simulation_run_reset,
            simulation::commands::simulation_run_stop,
            simulation::commands::simulation_set_speed,
            simulation::commands::simulation_latest_pose,
            simulation::commands::simulation_subscribe,
            simulation::commands::simulation_unsubscribe
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Quadruped Robot Research desktop application");

    application.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Some(manager) = app.try_state::<simulation::SimulationManager>() {
                manager.shutdown_for_exit();
            }
        }
        _ => {}
    });
}
