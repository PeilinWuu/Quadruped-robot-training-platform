mod database;
mod models;

use database::AuthDatabase;
pub use models::{AuthError, AuthResponse, LoginInput, RegisterInput};
use std::path::PathBuf;
use tauri::State;

#[derive(Debug, Clone)]
pub struct AuthState {
    database: AuthDatabase,
}

impl AuthState {
    pub fn initialize(app_data_dir: PathBuf) -> Result<Self, AuthError> {
        AuthDatabase::initialize(app_data_dir).map(|database| Self { database })
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AuthError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AuthError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| AuthError::internal())?
}

#[tauri::command]
pub async fn auth_current_user(state: State<'_, AuthState>) -> Result<AuthResponse, AuthError> {
    let database = state.database.clone();
    run_blocking(move || database.current_user()).await
}

#[tauri::command]
pub async fn auth_register(
    state: State<'_, AuthState>,
    input: RegisterInput,
) -> Result<AuthResponse, AuthError> {
    let database = state.database.clone();
    run_blocking(move || database.register(input)).await
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AuthState>,
    input: LoginInput,
) -> Result<AuthResponse, AuthError> {
    let database = state.database.clone();
    run_blocking(move || database.login(input)).await
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AuthState>) -> Result<(), AuthError> {
    let database = state.database.clone();
    run_blocking(move || database.logout()).await
}
