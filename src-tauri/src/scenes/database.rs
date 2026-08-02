use super::{
    error::SceneError,
    models::{SceneOrientation, SceneRecord, STORED_FILENAME},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::{fs, path::PathBuf, time::Duration};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone)]
pub struct SceneDatabase {
    path: PathBuf,
}

impl SceneDatabase {
    pub fn initialize(path: PathBuf) -> Result<Self, SceneError> {
        let database = Self { path };
        let mut connection = database.connection()?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| SceneError::database_unavailable())?;
        match version {
            0 => {
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|_| SceneError::database_unavailable())?;
                transaction
                    .execute_batch(
                        "CREATE TABLE scenes (
                            id TEXT PRIMARY KEY,
                            display_name TEXT NOT NULL,
                            stored_filename TEXT NOT NULL CHECK(stored_filename = 'scene.sog'),
                            byte_size INTEGER NOT NULL CHECK(byte_size > 0),
                            sha256 TEXT NOT NULL UNIQUE,
                            imported_at INTEGER NOT NULL,
                            source_format TEXT NOT NULL CHECK(source_format = 'sog'),
                            orientation_x REAL NULL,
                            orientation_y REAL NULL,
                            orientation_z REAL NULL,
                            orientation_w REAL NULL,
                            state TEXT NOT NULL CHECK(state IN ('importing', 'ready', 'deleting'))
                        );
                        CREATE INDEX scenes_state_idx ON scenes(state);
                        CREATE INDEX scenes_imported_at_idx ON scenes(imported_at DESC);
                        CREATE TABLE app_settings (
                            key TEXT PRIMARY KEY,
                            value TEXT NULL
                        );
                        PRAGMA user_version = 1;",
                    )
                    .map_err(|_| SceneError::database_unavailable())?;
                transaction
                    .commit()
                    .map_err(|_| SceneError::database_unavailable())?;
            }
            SCHEMA_VERSION => {}
            _ => return Err(SceneError::database_unavailable()),
        }
        Ok(database)
    }

    pub fn connection(&self) -> Result<Connection, SceneError> {
        let connection =
            Connection::open(&self.path).map_err(|_| SceneError::database_unavailable())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| SceneError::database_unavailable())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| SceneError::database_unavailable())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| SceneError::database_unavailable())?;
        Ok(connection)
    }

    pub fn list_ready(&self) -> Result<Vec<SceneRecord>, SceneError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT id, display_name, stored_filename, byte_size, sha256, imported_at,
                        source_format, orientation_x, orientation_y, orientation_z, orientation_w
                 FROM scenes WHERE state = 'ready' ORDER BY imported_at DESC, id ASC",
            )
            .map_err(|_| SceneError::database_unavailable())?;
        let rows = statement
            .query_map([], record_from_row)
            .map_err(|_| SceneError::database_unavailable())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn ready_by_id(&self, id: &str) -> Result<Option<SceneRecord>, SceneError> {
        self.connection()?
            .query_row(
                "SELECT id, display_name, stored_filename, byte_size, sha256, imported_at,
                        source_format, orientation_x, orientation_y, orientation_z, orientation_w
                 FROM scenes WHERE id = ?1 AND state = 'ready'",
                [id],
                record_from_row,
            )
            .optional()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn ready_by_hash(&self, hash: &str) -> Result<Option<SceneRecord>, SceneError> {
        self.connection()?
            .query_row(
                "SELECT id, display_name, stored_filename, byte_size, sha256, imported_at,
                        source_format, orientation_x, orientation_y, orientation_z, orientation_w
                 FROM scenes WHERE sha256 = ?1 AND state = 'ready'",
                [hash],
                record_from_row,
            )
            .optional()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn current(&self) -> Result<Option<SceneRecord>, SceneError> {
        let connection = self.connection()?;
        let id: Option<String> = connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'current_scene_id'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| SceneError::database_unavailable())?
            .flatten();
        let Some(id) = id else { return Ok(None) };
        let record = connection
            .query_row(
                "SELECT id, display_name, stored_filename, byte_size, sha256, imported_at,
                        source_format, orientation_x, orientation_y, orientation_z, orientation_w
                 FROM scenes WHERE id = ?1 AND state = 'ready'",
                [&id],
                record_from_row,
            )
            .optional()
            .map_err(|_| SceneError::database_unavailable())?;
        if record.is_none() {
            connection
                .execute(
                    "DELETE FROM app_settings WHERE key = 'current_scene_id'",
                    [],
                )
                .map_err(|_| SceneError::database_unavailable())?;
        }
        Ok(record)
    }

    pub fn set_current(&self, id: &str) -> Result<SceneRecord, SceneError> {
        let record = self
            .ready_by_id(id)?
            .ok_or_else(SceneError::scene_not_found)?;
        self.connection()?
            .execute(
                "INSERT INTO app_settings(key, value) VALUES('current_scene_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [id],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        Ok(record)
    }

    pub fn update_orientation(
        &self,
        id: &str,
        orientation: SceneOrientation,
    ) -> Result<SceneRecord, SceneError> {
        let orientation = orientation.normalized()?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE scenes
                 SET orientation_x = ?2, orientation_y = ?3,
                     orientation_z = ?4, orientation_w = ?5
                 WHERE id = ?1 AND state = 'ready'",
                params![
                    id,
                    orientation.quaternion[0],
                    orientation.quaternion[1],
                    orientation.quaternion[2],
                    orientation.quaternion[3],
                ],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        if changed == 0 {
            return Err(SceneError::scene_not_found());
        }
        connection
            .query_row(
                "SELECT id, display_name, stored_filename, byte_size, sha256, imported_at,
                        source_format, orientation_x, orientation_y, orientation_z, orientation_w
                 FROM scenes WHERE id = ?1 AND state = 'ready'",
                [id],
                record_from_row,
            )
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn insert_ready_and_set_current(&self, record: &SceneRecord) -> Result<(), SceneError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .execute(
                "INSERT INTO scenes(
                    id, display_name, stored_filename, byte_size, sha256, imported_at,
                    source_format, orientation_x, orientation_y, orientation_z, orientation_w, state
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'ready')",
                params![
                    record.id,
                    record.display_name,
                    STORED_FILENAME,
                    i64::try_from(record.byte_size).map_err(|_| SceneError::internal())?,
                    record.sha256,
                    record.imported_at,
                    record.source_format,
                    record.orientation.quaternion[0],
                    record.orientation.quaternion[1],
                    record.orientation.quaternion[2],
                    record.orientation.quaternion[3],
                ],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .execute(
                "INSERT INTO app_settings(key, value) VALUES('current_scene_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&record.id],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .commit()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn begin_delete(&self, id: &str) -> Result<(), SceneError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SceneError::database_unavailable())?;
        let changed = transaction
            .execute(
                "UPDATE scenes SET state = 'deleting' WHERE id = ?1 AND state = 'ready'",
                [id],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        if changed == 0 {
            return Err(SceneError::scene_not_found());
        }
        transaction
            .execute(
                "DELETE FROM app_settings WHERE key = 'current_scene_id' AND value = ?1",
                [id],
            )
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .commit()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn finish_delete(&self, id: &str) -> Result<(), SceneError> {
        self.connection()?
            .execute(
                "DELETE FROM scenes WHERE id = ?1 AND state = 'deleting'",
                [id],
            )
            .map(|_| ())
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn recovery_rows(&self) -> Result<Vec<(String, String, u64)>, SceneError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT id, state, byte_size FROM scenes")
            .map_err(|_| SceneError::database_unavailable())?;
        let rows = statement
            .query_map([], |row| {
                let size: i64 = row.get(2)?;
                Ok((row.get(0)?, row.get(1)?, u64::try_from(size).unwrap_or(0)))
            })
            .map_err(|_| SceneError::database_unavailable())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn remove_recovery_record(&self, id: &str) -> Result<(), SceneError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .execute("DELETE FROM app_settings WHERE value = ?1", [id])
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .execute("DELETE FROM scenes WHERE id = ?1", [id])
            .map_err(|_| SceneError::database_unavailable())?;
        transaction
            .commit()
            .map_err(|_| SceneError::database_unavailable())
    }

    pub fn recover(&self, scenes_root: &std::path::Path) -> Result<(), SceneError> {
        for (id, state, expected_size) in self.recovery_rows()? {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                self.remove_recovery_record(&id)?;
                continue;
            };
            if uuid.hyphenated().to_string() != id {
                self.remove_recovery_record(&id)?;
                continue;
            }
            let directory = scenes_root.join(&id);
            let file = directory.join(STORED_FILENAME);
            let valid_ready = state == "ready"
                && fs::symlink_metadata(&file)
                    .map(|metadata| {
                        metadata.file_type().is_file() && metadata.len() == expected_size
                    })
                    .unwrap_or(false);
            if valid_ready {
                continue;
            }
            if directory.is_dir() {
                fs::remove_dir_all(&directory).map_err(|_| SceneError::internal())?;
            }
            self.remove_recovery_record(&id)?;
        }
        let _ = self.current()?;
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SceneRecord> {
    let id: String = row.get(0)?;
    let byte_size: i64 = row.get(3)?;
    let orientation = [
        row.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
        row.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
        row.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
        row.get::<_, Option<f64>>(10)?.unwrap_or(1.0),
    ];
    Ok(SceneRecord {
        local_url: SceneRecord::local_url_for(&id),
        id,
        display_name: row.get(1)?,
        stored_filename: row.get(2)?,
        byte_size: u64::try_from(byte_size).unwrap_or(0),
        sha256: row.get(4)?,
        imported_at: row.get(5)?,
        source_format: row.get(6)?,
        orientation: SceneOrientation {
            quaternion: orientation,
        },
    })
}
