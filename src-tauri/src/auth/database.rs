use super::models::{
    clean_register_input, hash_password, verify_password, AuthError, AuthResponse, AuthUser,
    LoginInput, RegisterInput,
};
use rusqlite::{
    params, Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: i64 = 1;
const SESSION_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone)]
pub struct AuthDatabase {
    path: PathBuf,
}

impl AuthDatabase {
    pub fn initialize(app_data_dir: PathBuf) -> Result<Self, AuthError> {
        fs::create_dir_all(&app_data_dir).map_err(|_| AuthError::database_unavailable())?;
        let database = Self {
            path: app_data_dir.join("auth.sqlite"),
        };
        database.initialize_schema()?;
        database.clear_expired_sessions()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn initialize_at(path: PathBuf) -> Result<Self, AuthError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| AuthError::database_unavailable())?;
        }
        let database = Self { path };
        database.initialize_schema()?;
        database.clear_expired_sessions()?;
        Ok(database)
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    fn connection(&self) -> Result<Connection, AuthError> {
        let connection =
            Connection::open(&self.path).map_err(|_| AuthError::database_unavailable())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| AuthError::database_unavailable())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| AuthError::database_unavailable())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| AuthError::database_unavailable())?;
        Ok(connection)
    }

    fn initialize_schema(&self) -> Result<(), AuthError> {
        let mut connection = self.connection()?;
        let current_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| AuthError::database_unavailable())?;

        match current_version {
            0 => {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|_| AuthError::database_unavailable())?;
                transaction
                    .execute_batch(
                        "
                        CREATE TABLE users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                            email TEXT NOT NULL COLLATE NOCASE UNIQUE,
                            display_name TEXT NOT NULL,
                            password_hash TEXT NOT NULL,
                            role TEXT NOT NULL DEFAULT 'operator',
                            created_at TEXT NOT NULL DEFAULT (
                                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                            )
                        );
                        CREATE TABLE desktop_session (
                            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                            user_id INTEGER NOT NULL UNIQUE,
                            expires_at INTEGER NOT NULL,
                            created_at TEXT NOT NULL DEFAULT (
                                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                            ),
                            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                        );
                        CREATE INDEX desktop_session_expires_idx
                            ON desktop_session(expires_at);
                        PRAGMA user_version = 1;
                        ",
                    )
                    .map_err(|_| AuthError::database_unavailable())?;
                transaction
                    .commit()
                    .map_err(|_| AuthError::database_unavailable())
            }
            SCHEMA_VERSION => Ok(()),
            _ => Err(AuthError::database_unavailable()),
        }
    }

    pub fn register(&self, input: RegisterInput) -> Result<AuthResponse, AuthError> {
        let input = clean_register_input(input)?;
        let password_hash = hash_password(&input.password)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::database_unavailable())?;

        let duplicate: Option<i64> = transaction
            .query_row(
                "SELECT id FROM users WHERE username = ?1 OR email = ?2",
                params![input.username, input.email],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| AuthError::database_unavailable())?;
        if duplicate.is_some() {
            return Err(AuthError::user_exists());
        }

        let insert = transaction.execute(
            "INSERT INTO users (username, email, display_name, password_hash)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                input.username,
                input.email,
                input.display_name,
                password_hash
            ],
        );
        if let Err(error) = insert {
            if matches!(
                error.sqlite_error_code(),
                Some(ErrorCode::ConstraintViolation)
            ) {
                return Err(AuthError::user_exists());
            }
            return Err(AuthError::database_unavailable());
        }

        let user_id = transaction.last_insert_rowid();
        let user = select_user(&transaction, user_id)?;
        replace_session(&transaction, user_id)?;
        transaction
            .commit()
            .map_err(|_| AuthError::database_unavailable())?;
        Ok(AuthResponse { user })
    }

    pub fn login(&self, input: LoginInput) -> Result<AuthResponse, AuthError> {
        let account = input.account.trim();
        let connection = self.connection()?;
        let record = connection
            .query_row(
                "SELECT id, username, email, display_name, password_hash, role, created_at
                 FROM users WHERE username = ?1 OR email = ?1",
                params![account],
                |row| {
                    Ok((
                        AuthUser {
                            id: row.get(0)?,
                            username: row.get(1)?,
                            email: row.get(2)?,
                            display_name: row.get(3)?,
                            role: row.get(5)?,
                            created_at: row.get(6)?,
                        },
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| AuthError::database_unavailable())?;

        let Some((user, password_hash)) = record else {
            return Err(AuthError::invalid_credentials());
        };
        if !verify_password(&input.password, &password_hash) {
            return Err(AuthError::invalid_credentials());
        }

        let mut connection = connection;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::database_unavailable())?;
        replace_session(&transaction, user.id)?;
        transaction
            .commit()
            .map_err(|_| AuthError::database_unavailable())?;
        Ok(AuthResponse { user })
    }

    pub fn current_user(&self) -> Result<AuthResponse, AuthError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| AuthError::database_unavailable())?;
        transaction
            .execute(
                "DELETE FROM desktop_session WHERE expires_at <= ?1",
                params![now_epoch_seconds()?],
            )
            .map_err(|_| AuthError::database_unavailable())?;
        let user = transaction
            .query_row(
                "SELECT users.id, users.username, users.email, users.display_name,
                        users.role, users.created_at
                 FROM desktop_session
                 JOIN users ON users.id = desktop_session.user_id
                 WHERE desktop_session.singleton_id = 1",
                [],
                user_from_row,
            )
            .optional()
            .map_err(|_| AuthError::database_unavailable())?;
        transaction
            .commit()
            .map_err(|_| AuthError::database_unavailable())?;
        user.map(|user| AuthResponse { user })
            .ok_or_else(AuthError::not_authenticated)
    }

    pub fn logout(&self) -> Result<(), AuthError> {
        self.connection()?
            .execute("DELETE FROM desktop_session WHERE singleton_id = 1", [])
            .map(|_| ())
            .map_err(|_| AuthError::database_unavailable())
    }

    fn clear_expired_sessions(&self) -> Result<(), AuthError> {
        self.connection()?
            .execute(
                "DELETE FROM desktop_session WHERE expires_at <= ?1",
                params![now_epoch_seconds()?],
            )
            .map(|_| ())
            .map_err(|_| AuthError::database_unavailable())
    }
}

fn replace_session(transaction: &Transaction<'_>, user_id: i64) -> Result<(), AuthError> {
    let expires_at = now_epoch_seconds()?
        .checked_add(SESSION_LIFETIME_SECONDS)
        .ok_or_else(AuthError::internal)?;
    transaction
        .execute(
            "INSERT INTO desktop_session (singleton_id, user_id, expires_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(singleton_id) DO UPDATE SET
                user_id = excluded.user_id,
                expires_at = excluded.expires_at,
                created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![user_id, expires_at],
        )
        .map(|_| ())
        .map_err(|_| AuthError::database_unavailable())
}

fn select_user(transaction: &Transaction<'_>, user_id: i64) -> Result<AuthUser, AuthError> {
    transaction
        .query_row(
            "SELECT id, username, email, display_name, role, created_at
             FROM users WHERE id = ?1",
            params![user_id],
            user_from_row,
        )
        .map_err(|_| AuthError::database_unavailable())
}

fn user_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthUser> {
    Ok(AuthUser {
        id: row.get(0)?,
        username: row.get(1)?,
        email: row.get(2)?,
        display_name: row.get(3)?,
        role: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn now_epoch_seconds() -> Result<i64, AuthError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AuthError::internal())
        .and_then(|duration| i64::try_from(duration.as_secs()).map_err(|_| AuthError::internal()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, Barrier},
        thread,
    };
    use tempfile::TempDir;

    fn database() -> (TempDir, AuthDatabase) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database =
            AuthDatabase::initialize_at(directory.path().join("auth.sqlite")).expect("database");
        (directory, database)
    }

    fn registration(username: &str, email: &str) -> RegisterInput {
        RegisterInput {
            username: username.into(),
            email: email.into(),
            display_name: "操作员一号".into(),
            password: "FireRobot2026".into(),
        }
    }

    #[test]
    fn initializes_versioned_schema_and_security_pragmas() {
        let (_directory, database) = database();
        let connection = database.connection().expect("connection");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version");
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .expect("foreign keys");
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(foreign_keys, 1);
    }

    #[test]
    fn registration_creates_user_and_active_session_without_plaintext_password() {
        let (_directory, database) = database();
        let response = database
            .register(registration("operator01", "operator@example.com"))
            .expect("register");
        assert_eq!(response.user.username, "operator01");
        assert_eq!(
            database.current_user().expect("current user").user,
            response.user
        );

        let connection = database.connection().expect("connection");
        let stored: String = connection
            .query_row("SELECT password_hash FROM users", [], |row| row.get(0))
            .expect("password hash");
        assert_ne!(stored, "FireRobot2026");
        assert!(!stored.contains("FireRobot2026"));
    }

    #[test]
    fn duplicate_username_or_email_is_rejected_case_insensitively() {
        let (_directory, database) = database();
        database
            .register(registration("operator01", "operator@example.com"))
            .expect("first registration");
        let username_error = database
            .register(registration("OPERATOR01", "second@example.com"))
            .expect_err("duplicate username");
        let email_error = database
            .register(registration("operator02", "OPERATOR@EXAMPLE.COM"))
            .expect_err("duplicate email");
        assert_eq!(username_error.code, "USER_ALREADY_EXISTS");
        assert_eq!(email_error.code, "USER_ALREADY_EXISTS");
    }

    #[test]
    fn login_accepts_correct_password_and_rejects_wrong_or_unknown_credentials() {
        let (_directory, database) = database();
        database
            .register(registration("operator01", "operator@example.com"))
            .expect("register");
        database.logout().expect("logout");
        assert!(database
            .login(LoginInput {
                account: "OPERATOR@EXAMPLE.COM".into(),
                password: "FireRobot2026".into(),
            })
            .is_ok());
        assert_eq!(
            database
                .login(LoginInput {
                    account: "operator01".into(),
                    password: "WrongPassword1".into(),
                })
                .expect_err("wrong password")
                .code,
            "INVALID_CREDENTIALS"
        );
        assert_eq!(
            database
                .login(LoginInput {
                    account: "missing".into(),
                    password: "WrongPassword1".into(),
                })
                .expect_err("unknown user")
                .code,
            "INVALID_CREDENTIALS"
        );
    }

    #[test]
    fn session_survives_database_reopen_and_logout_is_idempotent() {
        let (directory, database) = database();
        let path = database.path().to_owned();
        let user = database
            .register(registration("operator01", "operator@example.com"))
            .expect("register")
            .user;
        drop(database);

        let reopened = AuthDatabase::initialize_at(path).expect("reopen");
        assert_eq!(reopened.current_user().expect("restored").user, user);
        reopened.logout().expect("first logout");
        reopened.logout().expect("second logout");
        assert_eq!(
            reopened.current_user().expect_err("logged out").code,
            "NOT_AUTHENTICATED"
        );
        drop(directory);
    }

    #[test]
    fn expired_session_is_removed_and_cannot_restore_user() {
        let (_directory, database) = database();
        database
            .register(registration("operator01", "operator@example.com"))
            .expect("register");
        database
            .connection()
            .expect("connection")
            .execute("UPDATE desktop_session SET expires_at = 0", [])
            .expect("expire session");
        assert_eq!(
            database.current_user().expect_err("expired").code,
            "NOT_AUTHENTICATED"
        );
        let count: i64 = database
            .connection()
            .expect("connection")
            .query_row("SELECT COUNT(*) FROM desktop_session", [], |row| row.get(0))
            .expect("session count");
        assert_eq!(count, 0);
    }

    #[test]
    fn errors_do_not_expose_password_or_hash_material() {
        let (_directory, database) = database();
        let password = "SecretPassword2026";
        let error = database
            .login(LoginInput {
                account: "missing".into(),
                password: password.into(),
            })
            .expect_err("invalid credentials");
        let rendered = format!("{error:?}");
        assert!(!rendered.contains(password));
        assert!(!rendered.contains("$scrypt$"));
    }

    #[test]
    fn concurrent_duplicate_registration_cannot_bypass_unique_constraints() {
        let (_directory, database) = database();
        let database = Arc::new(database);
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let database = Arc::clone(&database);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    database.register(registration("operator01", "operator@example.com"))
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(
                    |result| matches!(result, Err(error) if error.code == "USER_ALREADY_EXISTS")
                )
                .count(),
            1
        );
    }
}
