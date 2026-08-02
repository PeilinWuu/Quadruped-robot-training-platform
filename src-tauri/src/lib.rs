mod auth;
mod scenes;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("scene", scenes::protocol::handle)
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let auth_state = auth::AuthState::initialize(app_data_dir.clone())?;
            let scene_state = scenes::SceneState::initialize(app_data_dir)?;
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
            scenes::commands::scene_delete
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Quadruped Robot Research desktop application");
}
