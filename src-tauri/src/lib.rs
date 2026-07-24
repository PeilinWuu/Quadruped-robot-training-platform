mod auth;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let auth_state = auth::AuthState::initialize(app_data_dir)?;
            app.manage(auth_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_current_user,
            auth::auth_register,
            auth::auth_login,
            auth::auth_logout
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the Quadruped Robot Research desktop application");
}
