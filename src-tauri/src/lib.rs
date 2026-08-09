mod auth;
mod input;
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
            let simulation_manager = simulation::SimulationManager::new();
            let native_keyboard = input::NativeKeyboardController::new(
                simulation_manager.clone(),
                app.handle().clone(),
            );
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                input::install_linux_window_hooks(&window, native_keyboard.clone())?;
            }
            app.manage(simulation_manager);
            app.manage(native_keyboard);
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
            simulation::commands::simulation_list_environments,
            simulation::commands::simulation_current_environment,
            simulation::commands::simulation_latest_collision,
            simulation::commands::simulation_latest_collision_event,
            simulation::commands::simulation_run_start,
            simulation::commands::simulation_run_pause,
            simulation::commands::simulation_run_step,
            simulation::commands::simulation_run_reset,
            simulation::commands::simulation_run_stop,
            simulation::commands::simulation_set_speed,
            simulation::commands::simulation_latest_pose,
            simulation::commands::simulation_set_motion_command,
            simulation::commands::simulation_clear_motion_command,
            simulation::commands::simulation_set_telemetry_rate,
            simulation::commands::simulation_latest_telemetry,
            simulation::commands::simulation_subscribe,
            simulation::commands::simulation_unsubscribe,
            input::native_keyboard_capabilities,
            input::native_keyboard_state,
            input::native_keyboard_diagnostics,
            input::native_keyboard_arm,
            input::native_keyboard_disarm,
            input::native_keyboard_set_speed,
            input::native_keyboard_set_input_suppressed
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Quadruped Robot Research desktop application");

    application.run(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Focused(focused),
            ..
        } if label == "main" => {
            if let Some(keyboard) = app.try_state::<input::NativeKeyboardController>() {
                keyboard.set_window_focused(focused);
            }
        }
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Some(keyboard) = app.try_state::<input::NativeKeyboardController>() {
                keyboard.shutdown();
            }
            if let Some(manager) = app.try_state::<simulation::SimulationManager>() {
                manager.shutdown_for_exit();
            }
        }
        _ => {}
    });
}
