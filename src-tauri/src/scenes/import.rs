use super::{
    error::SceneError,
    models::{ImportProgress, SceneOrientation, SceneRecord, MAX_SCENE_BYTES, STORED_FILENAME},
    SceneState,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use uuid::Uuid;
use zip::{result::ZipError, CompressionMethod, ZipArchive};

const COPY_BUFFER_BYTES: usize = 64 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(75);
const DISK_RESERVE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 32;
const MAX_META_BYTES: u64 = 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

pub fn import_scene(
    state: &SceneState,
    source_path: String,
    operation_id: String,
    progress: Channel<ImportProgress>,
) -> Result<SceneRecord, SceneError> {
    let _import_guard = state
        .import_gate
        .try_lock()
        .map_err(|_| SceneError::scene_busy())?;
    let cancel = state.register_import(&operation_id)?;
    let result = import_scene_inner(state, &source_path, &operation_id, &progress, &cancel);
    state.finish_import(&operation_id);
    result
}

fn import_scene_inner(
    state: &SceneState,
    source_path: &str,
    operation_id: &str,
    progress: &Channel<ImportProgress>,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<SceneRecord, SceneError> {
    let source = PathBuf::from(source_path);
    if source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("sog"))
        .unwrap_or(true)
    {
        return Err(SceneError::invalid_file_type());
    }
    let source_metadata =
        fs::symlink_metadata(&source).map_err(|_| SceneError::file_not_found())?;
    if source_metadata.file_type().is_dir() || source_metadata.file_type().is_symlink() {
        return Err(SceneError::invalid_file_type());
    }
    let _canonical = fs::canonicalize(&source).map_err(|_| SceneError::file_not_found())?;
    let display_name = clean_display_name(&source);
    let mut source_file = open_source_file(&source)?;
    let metadata = source_file
        .metadata()
        .map_err(|_| SceneError::file_not_found())?;
    if !metadata.file_type().is_file() {
        return Err(SceneError::invalid_file_type());
    }
    let total_bytes = metadata.len();
    if total_bytes == 0 {
        return Err(SceneError::empty_file());
    }
    if total_bytes > MAX_SCENE_BYTES {
        return Err(SceneError::file_too_large());
    }
    let available =
        fs2::available_space(&state.staging_root).map_err(|_| SceneError::internal())?;
    if available < total_bytes.saturating_add(DISK_RESERVE_BYTES) {
        return Err(SceneError::disk_full());
    }

    let staging_path = state.staging_root.join(format!("{operation_id}.part"));
    let mut staging = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging_path)
        .map_err(|error| SceneError::from_write_error(&error))?;

    let copy_result = (|| {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        let mut bytes_copied = 0_u64;
        let mut last_report = Instant::now()
            .checked_sub(PROGRESS_INTERVAL)
            .unwrap_or_else(Instant::now);
        send_progress(
            progress,
            ImportProgress::Copying {
                bytes_copied,
                total_bytes,
            },
        );

        loop {
            check_cancel(cancel)?;
            let read = source_file
                .read(&mut buffer)
                .map_err(|_| SceneError::file_not_found())?;
            if read == 0 {
                break;
            }
            staging
                .write_all(&buffer[..read])
                .map_err(|error| SceneError::from_write_error(&error))?;
            hasher.update(&buffer[..read]);
            bytes_copied = bytes_copied
                .checked_add(u64::try_from(read).map_err(|_| SceneError::internal())?)
                .ok_or_else(SceneError::internal)?;
            if last_report.elapsed() >= PROGRESS_INTERVAL
                || bytes_copied == total_bytes
                || bytes_copied % (64 * 1024) == 0
            {
                send_progress(
                    progress,
                    ImportProgress::Copying {
                        bytes_copied,
                        total_bytes,
                    },
                );
                last_report = Instant::now();
            }
        }
        if bytes_copied != total_bytes {
            return Err(SceneError::file_not_found());
        }
        staging
            .flush()
            .and_then(|_| staging.sync_all())
            .map_err(|error| SceneError::from_write_error(&error))?;
        drop(staging);

        check_cancel(cancel)?;
        send_progress(
            progress,
            ImportProgress::Validating {
                bytes_copied,
                total_bytes,
            },
        );
        validate_sog(&staging_path, cancel)?;
        let sha256 = format!("{:x}", hasher.finalize());

        if let Some(existing) = state.database.ready_by_hash(&sha256)? {
            if existing.byte_size == total_bytes {
                fs::remove_file(&staging_path).map_err(|_| SceneError::internal())?;
                return state.database.set_current(&existing.id);
            }
        }

        check_cancel(cancel)?;
        send_progress(
            progress,
            ImportProgress::Committing {
                bytes_copied,
                total_bytes,
            },
        );

        let id = Uuid::new_v4().hyphenated().to_string();
        let scene_directory = state.scenes_root.join(&id);
        fs::create_dir(&scene_directory).map_err(|_| SceneError::internal())?;
        let final_path = scene_directory.join(STORED_FILENAME);
        if let Err(error) = fs::rename(&staging_path, &final_path) {
            let _ = fs::remove_dir(&scene_directory);
            return Err(SceneError::from_write_error(&error));
        }

        let record = SceneRecord {
            id,
            display_name,
            stored_filename: STORED_FILENAME.to_owned(),
            byte_size: total_bytes,
            sha256,
            imported_at: now_epoch_millis()?,
            source_format: "sog".to_owned(),
            orientation: SceneOrientation::default(),
            local_url: String::new(),
        };
        let mut record = SceneRecord {
            local_url: SceneRecord::local_url_for(&record.id),
            ..record
        };

        if let Err(database_error) = state.database.insert_ready_and_set_current(&record) {
            let _ = fs::remove_file(&final_path);
            let _ = fs::remove_dir(&scene_directory);
            if let Some(existing) = state.database.ready_by_hash(&record.sha256)? {
                record = state.database.set_current(&existing.id)?;
            } else {
                return Err(database_error);
            }
        }
        send_progress(
            progress,
            ImportProgress::Completed {
                bytes_copied,
                total_bytes,
            },
        );
        Ok(record)
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&staging_path);
    }
    copy_result
}

fn send_progress(channel: &Channel<ImportProgress>, progress: ImportProgress) {
    let _ = channel.send(progress);
}

fn check_cancel(cancel: &std::sync::atomic::AtomicBool) -> Result<(), SceneError> {
    if cancel.load(Ordering::Acquire) {
        Err(SceneError::import_cancelled())
    } else {
        Ok(())
    }
}

fn clean_display_name(path: &Path) -> String {
    let candidate = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(STORED_FILENAME);
    let clean: String = candidate
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    if clean.trim().is_empty() {
        STORED_FILENAME.to_owned()
    } else {
        clean
    }
}

#[cfg(windows)]
fn open_source_file(path: &Path) -> Result<File, SceneError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    };

    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| SceneError::file_not_found())?;
    let metadata = file.metadata().map_err(|_| SceneError::file_not_found())?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(SceneError::invalid_file_type());
    }
    Ok(file)
}

#[cfg(not(windows))]
fn open_source_file(path: &Path) -> Result<File, SceneError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| SceneError::file_not_found())?;
    if metadata.file_type().is_symlink() {
        return Err(SceneError::invalid_file_type());
    }
    File::open(path).map_err(|_| SceneError::file_not_found())
}

pub fn validate_sog(path: &Path, cancel: &std::sync::atomic::AtomicBool) -> Result<(), SceneError> {
    reject_zip64(path)?;
    let file = File::open(path).map_err(|_| SceneError::invalid_sog())?;
    let mut archive = ZipArchive::new(file).map_err(map_zip_error)?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(SceneError::unsupported_sog());
    }

    let mut names = HashSet::new();
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        check_cancel(cancel)?;
        let entry = archive.by_index(index).map_err(map_zip_error)?;
        if entry.encrypted() {
            return Err(SceneError::unsupported_sog());
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(SceneError::unsupported_sog());
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(SceneError::unsupported_sog());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(SceneError::unsupported_sog)?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
            return Err(SceneError::unsupported_sog());
        }
        let name = normalized_entry_name(&entry)?;
        if !names.insert(name) {
            return Err(SceneError::invalid_sog());
        }
    }

    let meta_index = (0..archive.len())
        .find(|index| {
            archive
                .by_index(*index)
                .ok()
                .and_then(|entry| normalized_entry_name(&entry).ok())
                .as_deref()
                == Some("meta.json")
        })
        .ok_or_else(SceneError::invalid_sog)?;
    let mut meta_file = archive.by_index(meta_index).map_err(map_zip_error)?;
    if meta_file.size() > MAX_META_BYTES {
        return Err(SceneError::unsupported_sog());
    }
    let mut meta_bytes = Vec::with_capacity(meta_file.size() as usize);
    meta_file
        .read_to_end(&mut meta_bytes)
        .map_err(|_| SceneError::invalid_sog())?;
    drop(meta_file);
    let meta: Value = serde_json::from_slice(&meta_bytes).map_err(|_| SceneError::invalid_sog())?;
    let referenced = validate_meta(&meta)?;

    for name in referenced {
        check_cancel(cancel)?;
        let index = (0..archive.len())
            .find(|index| {
                archive
                    .by_index(*index)
                    .ok()
                    .and_then(|entry| normalized_entry_name(&entry).ok())
                    .as_deref()
                    == Some(name.as_str())
            })
            .ok_or_else(SceneError::invalid_sog)?;
        let mut entry = archive.by_index(index).map_err(map_zip_error)?;
        let mut buffer = [0_u8; COPY_BUFFER_BYTES];
        loop {
            check_cancel(cancel)?;
            let read = entry
                .read(&mut buffer)
                .map_err(|_| SceneError::invalid_sog())?;
            if read == 0 {
                break;
            }
        }
    }
    Ok(())
}

fn map_zip_error(error: ZipError) -> SceneError {
    match error {
        ZipError::UnsupportedArchive(_) => SceneError::unsupported_sog(),
        _ => SceneError::invalid_sog(),
    }
}

fn normalized_entry_name<R: Read>(entry: &zip::read::ZipFile<'_, R>) -> Result<String, SceneError> {
    let path = entry.enclosed_name().ok_or_else(SceneError::invalid_sog)?;
    if path.is_absolute()
        || path.components().count() != 1
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || entry.name().contains('\\')
        || entry.name().contains(':')
    {
        return Err(SceneError::invalid_sog());
    }
    path.to_str()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(SceneError::invalid_sog)
}

fn validate_meta(meta: &Value) -> Result<Vec<String>, SceneError> {
    let object = meta.as_object().ok_or_else(SceneError::invalid_sog)?;
    if object.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(SceneError::unsupported_sog());
    }
    if object.get("count").and_then(Value::as_u64).unwrap_or(0) == 0 {
        return Err(SceneError::invalid_sog());
    }
    let mut referenced = Vec::new();
    collect_files(object, "means", 2, &mut referenced)?;
    collect_files(object, "scales", 1, &mut referenced)?;
    collect_files(object, "quats", 1, &mut referenced)?;
    collect_files(object, "sh0", 1, &mut referenced)?;
    if object.contains_key("shN") {
        collect_files(object, "shN", 2, &mut referenced)?;
    }
    if referenced.iter().collect::<HashSet<_>>().len() != referenced.len() {
        return Err(SceneError::invalid_sog());
    }
    Ok(referenced)
}

fn collect_files(
    object: &serde_json::Map<String, Value>,
    field: &str,
    expected: usize,
    output: &mut Vec<String>,
) -> Result<(), SceneError> {
    let section = object
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(SceneError::invalid_sog)?;
    let files = section
        .get("files")
        .and_then(Value::as_array)
        .filter(|files| files.len() == expected)
        .ok_or_else(SceneError::invalid_sog)?;
    for value in files {
        let name = value.as_str().ok_or_else(SceneError::invalid_sog)?;
        let path = Path::new(name);
        if path.is_absolute()
            || path.components().count() != 1
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || name.contains('\\')
            || name.contains(':')
        {
            return Err(SceneError::invalid_sog());
        }
        output.push(name.to_owned());
    }
    Ok(())
}

fn reject_zip64(path: &Path) -> Result<(), SceneError> {
    let mut file = File::open(path).map_err(|_| SceneError::invalid_sog())?;
    let length = file
        .metadata()
        .map_err(|_| SceneError::invalid_sog())?
        .len();
    let tail_length = length.min(65_557);
    file.seek(SeekFrom::End(-(tail_length as i64)))
        .map_err(|_| SceneError::invalid_sog())?;
    let mut tail = vec![0_u8; tail_length as usize];
    file.read_exact(&mut tail)
        .map_err(|_| SceneError::invalid_sog())?;
    if tail
        .windows(4)
        .any(|window| window == b"PK\x06\x06" || window == b"PK\x06\x07")
    {
        return Err(SceneError::unsupported_sog());
    }
    Ok(())
}

fn now_epoch_millis() -> Result<i64, SceneError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SceneError::internal())?
        .as_millis();
    i64::try_from(millis).map_err(|_| SceneError::internal())
}
