use super::{
    import::{import_scene, validate_sog},
    models::{ImportProgress, SceneOrientation, MAX_SCENE_BYTES, STORED_FILENAME},
    protocol::build_response_for_test,
    validate_uuid, SceneDatabase, SceneState,
};
use rusqlite::Connection;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    sync::atomic::AtomicBool,
};
use tauri::{http, ipc::Channel};
use tempfile::TempDir;
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const META: &str = r#"{
  "version": 2,
  "count": 1,
  "means": {"mins":[0,0,0],"maxs":[1,1,1],"files":["means_l.webp","means_u.webp"]},
  "scales": {"codebook":[0],"files":["scales.webp"]},
  "quats": {"files":["quats.webp"]},
  "sh0": {"codebook":[0],"files":["sh0.webp"]}
}"#;

fn operation_id() -> String {
    Uuid::new_v4().hyphenated().to_string()
}

fn channel() -> Channel<ImportProgress> {
    Channel::new(|_| Ok(()))
}

fn state() -> (TempDir, SceneState) {
    let directory = tempfile::tempdir().expect("temporary directory");
    let state = SceneState::initialize(directory.path().to_owned()).expect("scene state");
    (directory, state)
}

fn write_valid_sog(path: &std::path::Path, compression: CompressionMethod) {
    let file = File::create(path).expect("SOG file");
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(compression);
    for (name, bytes) in [
        ("meta.json", META.as_bytes()),
        ("means_l.webp", b"means-l"),
        ("means_u.webp", b"means-u"),
        ("scales.webp", b"scales"),
        ("quats.webp", b"quats"),
        ("sh0.webp", b"sh0"),
    ] {
        writer.start_file(name, options).expect("start zip entry");
        writer.write_all(bytes).expect("write zip entry");
    }
    writer.finish().expect("finish SOG");
}

fn write_custom_sog(path: &std::path::Path, entries: &[(&str, &[u8])]) {
    let file = File::create(path).expect("SOG file");
    let mut writer = ZipWriter::new(file);
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .expect("start zip entry");
        writer.write_all(bytes).expect("write zip entry");
    }
    writer.finish().expect("finish SOG");
}

fn patch_first_zip_entry(path: &std::path::Path, flags: Option<u16>, method: Option<u16>) {
    let mut bytes = fs::read(path).expect("read ZIP");
    let local = bytes
        .windows(4)
        .position(|window| window == b"PK\x03\x04")
        .expect("local header");
    let central = bytes
        .windows(4)
        .position(|window| window == b"PK\x01\x02")
        .expect("central header");
    if let Some(flags) = flags {
        bytes[local + 6..local + 8].copy_from_slice(&flags.to_le_bytes());
        bytes[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
    }
    if let Some(method) = method {
        bytes[local + 8..local + 10].copy_from_slice(&method.to_le_bytes());
        bytes[central + 10..central + 12].copy_from_slice(&method.to_le_bytes());
    }
    fs::write(path, bytes).expect("patch ZIP");
}

#[test]
fn schema_initializes_with_version_security_and_independent_file() {
    let (directory, state) = state();
    let connection = state.database.connection().expect("connection");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("version");
    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .expect("foreign keys");
    assert_eq!(version, 1);
    assert_eq!(foreign_keys, 1);
    assert_eq!(
        state.database.path(),
        directory.path().join("scenes.sqlite")
    );
    assert!(!directory.path().join("auth.sqlite").exists());
}

#[test]
fn unknown_schema_version_is_rejected_without_deletion() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("scenes.sqlite");
    let connection = Connection::open(&path).expect("connection");
    connection
        .pragma_update(None, "user_version", 99)
        .expect("set version");
    drop(connection);
    assert!(SceneDatabase::initialize(path.clone()).is_err());
    assert!(path.exists());
}

#[test]
fn validates_stored_and_deflated_bundled_sog() {
    let directory = tempfile::tempdir().expect("temporary directory");
    for (name, compression) in [
        ("stored.sog", CompressionMethod::Stored),
        ("deflated.sog", CompressionMethod::Deflated),
    ] {
        let path = directory.path().join(name);
        write_valid_sog(&path, compression);
        validate_sog(&path, &AtomicBool::new(false)).expect("valid SOG");
    }
}

#[test]
fn rejects_non_zip_missing_meta_bad_meta_version_and_zero_count() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let plain = directory.path().join("plain.sog");
    fs::write(&plain, b"not zip").expect("plain file");
    assert_eq!(
        validate_sog(&plain, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );

    let missing = directory.path().join("missing.sog");
    write_custom_sog(&missing, &[("means_l.webp", b"x")]);
    assert_eq!(
        validate_sog(&missing, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );

    for (name, meta, code) in [
        ("bad-meta.sog", b"{".as_slice(), "INVALID_SOG"),
        (
            "version.sog",
            META.replace("\"version\": 2", "\"version\": 3").as_bytes(),
            "UNSUPPORTED_SOG",
        ),
        (
            "zero.sog",
            META.replace("\"count\": 1", "\"count\": 0").as_bytes(),
            "INVALID_SOG",
        ),
    ] {
        let path = directory.path().join(name);
        let owned;
        let bytes = if name == "bad-meta.sog" {
            meta
        } else {
            owned = meta.to_vec();
            &owned
        };
        write_custom_sog(&path, &[("meta.json", bytes)]);
        assert_eq!(
            validate_sog(&path, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            code
        );
    }
}

#[test]
fn rejects_unsafe_and_missing_referenced_entries() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let traversal = directory.path().join("traversal.sog");
    write_custom_sog(&traversal, &[("../meta.json", META.as_bytes())]);
    assert_eq!(
        validate_sog(&traversal, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );

    let missing = directory.path().join("reference.sog");
    write_custom_sog(&missing, &[("meta.json", META.as_bytes())]);
    assert_eq!(
        validate_sog(&missing, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );
}

#[test]
fn rejects_zip64_signature_and_cancelled_validation() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("zip64.sog");
    write_valid_sog(&path, CompressionMethod::Stored);
    OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("append")
        .write_all(b"PK\x06\x06")
        .expect("zip64 marker");
    assert_eq!(
        validate_sog(&path, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "UNSUPPORTED_SOG"
    );

    let cancelled = AtomicBool::new(true);
    assert_eq!(
        validate_sog(&path, &cancelled).unwrap_err().code,
        "UNSUPPORTED_SOG"
    );
}

#[test]
fn rejects_encrypted_and_unsupported_compression_entries() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let encrypted = directory.path().join("encrypted.sog");
    write_valid_sog(&encrypted, CompressionMethod::Stored);
    patch_first_zip_entry(&encrypted, Some(1), None);
    assert!(validate_sog(&encrypted, &AtomicBool::new(false)).is_err());

    let unsupported = directory.path().join("unsupported.sog");
    write_valid_sog(&unsupported, CompressionMethod::Stored);
    patch_first_zip_entry(&unsupported, None, Some(12));
    assert_eq!(
        validate_sog(&unsupported, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "UNSUPPORTED_SOG"
    );
}

#[test]
fn rejects_duplicate_excessive_and_oversized_archive_entries() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let duplicate = directory.path().join("duplicate.sog");
    write_custom_sog(&duplicate, &[("dupe-a.bin", b"a"), ("dupe-b.bin", b"b")]);
    let mut duplicate_bytes = fs::read(&duplicate).expect("read duplicate ZIP");
    for offset in 0..=duplicate_bytes.len() - b"dupe-b.bin".len() {
        if &duplicate_bytes[offset..offset + b"dupe-b.bin".len()] == b"dupe-b.bin" {
            duplicate_bytes[offset..offset + b"dupe-a.bin".len()].copy_from_slice(b"dupe-a.bin");
        }
    }
    fs::write(&duplicate, duplicate_bytes).expect("patch duplicate name");
    assert_eq!(
        validate_sog(&duplicate, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );

    let excessive = directory.path().join("excessive.sog");
    let file = File::create(&excessive).expect("SOG file");
    let mut writer = ZipWriter::new(file);
    for index in 0..33 {
        writer
            .start_file(
                format!("entry-{index}"),
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .expect("start ZIP entry");
    }
    writer.finish().expect("finish SOG");
    assert_eq!(
        validate_sog(&excessive, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "UNSUPPORTED_SOG"
    );

    let oversized_meta = directory.path().join("oversized-meta.sog");
    let oversized = vec![b' '; 1024 * 1024 + 1];
    write_custom_sog(&oversized_meta, &[("meta.json", &oversized)]);
    assert_eq!(
        validate_sog(&oversized_meta, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "UNSUPPORTED_SOG"
    );
}

#[test]
fn import_rejects_directory_empty_wrong_extension_and_oversize() {
    let (directory, state) = state();
    let directory_path = directory.path().join("folder.sog");
    fs::create_dir(&directory_path).expect("directory");
    let error = import_scene(
        &state,
        directory_path.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .unwrap_err();
    assert_eq!(error.code, "INVALID_FILE_TYPE");

    let empty = directory.path().join("empty.sog");
    File::create(&empty).expect("empty");
    assert_eq!(
        import_scene(
            &state,
            empty.to_string_lossy().into(),
            operation_id(),
            channel()
        )
        .unwrap_err()
        .code,
        "EMPTY_FILE"
    );

    let wrong = directory.path().join("scene.zip");
    fs::write(&wrong, b"x").expect("wrong extension");
    assert_eq!(
        import_scene(
            &state,
            wrong.to_string_lossy().into(),
            operation_id(),
            channel()
        )
        .unwrap_err()
        .code,
        "INVALID_FILE_TYPE"
    );

    let large = directory.path().join("large.sog");
    File::create(&large)
        .expect("large")
        .set_len(MAX_SCENE_BYTES + 1)
        .expect("resize");
    assert_eq!(
        import_scene(
            &state,
            large.to_string_lossy().into(),
            operation_id(),
            channel()
        )
        .unwrap_err()
        .code,
        "FILE_TOO_LARGE"
    );
}

#[test]
fn uppercase_extension_imports_hashes_persists_and_deduplicates() {
    let (directory, state) = state();
    let source = directory.path().join("Toy-Cat.SOG");
    write_valid_sog(&source, CompressionMethod::Deflated);
    let first = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("first import");
    assert_eq!(first.stored_filename, STORED_FILENAME);
    assert_eq!(first.sha256.len(), 64);
    assert!(!first
        .local_url
        .contains(directory.path().to_string_lossy().as_ref()));
    assert!(state
        .scenes_root
        .join(&first.id)
        .join(STORED_FILENAME)
        .is_file());
    fs::remove_file(&source).expect("remove original");
    assert!(state
        .scenes_root
        .join(&first.id)
        .join(STORED_FILENAME)
        .is_file());

    let second_source = directory.path().join("copy.sog");
    write_valid_sog(&second_source, CompressionMethod::Deflated);
    let second = import_scene(
        &state,
        second_source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("duplicate import");
    assert_eq!(first.id, second.id);
    assert_eq!(state.database.list_ready().expect("list").len(), 1);
    assert_eq!(
        state
            .database
            .current()
            .expect("current")
            .expect("record")
            .id,
        first.id
    );
}

#[test]
fn cancellation_removes_staging_and_cancel_entry() {
    let (directory, state) = state();
    let source = directory.path().join("cancel.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let operation = operation_id();
    let cancel_state = state.clone();
    let cancel_operation = operation.clone();
    let progress = Channel::new(move |_| {
        let _ = cancel_state.cancel_import(&cancel_operation);
        Ok(())
    });
    let error = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation.clone(),
        progress,
    )
    .unwrap_err();
    assert_eq!(error.code, "IMPORT_CANCELLED");
    assert!(!state
        .staging_root
        .join(format!("{operation}.part"))
        .exists());
    assert!(!state
        .cancellations
        .lock()
        .expect("cancellations")
        .contains_key(&operation));
}

#[test]
fn database_failure_rolls_back_staging_and_final_directory() {
    let (directory, state) = state();
    let connection = state.database.connection().expect("connection");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_scene_insert BEFORE INSERT ON scenes
             BEGIN SELECT RAISE(ABORT, 'test rollback'); END;",
        )
        .expect("rollback trigger");
    drop(connection);
    let source = directory.path().join("rollback.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    assert_eq!(
        import_scene(
            &state,
            source.to_string_lossy().into(),
            operation_id(),
            channel()
        )
        .unwrap_err()
        .code,
        "DATABASE_UNAVAILABLE"
    );
    assert!(fs::read_dir(&state.staging_root)
        .expect("staging")
        .next()
        .is_none());
    assert!(fs::read_dir(&state.scenes_root)
        .expect("scenes")
        .filter_map(Result::ok)
        .all(|entry| entry.file_name() == ".staging"));
    assert!(state.database.list_ready().expect("list").is_empty());
}

#[test]
fn restart_recovers_current_and_cleans_staging() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let state = SceneState::initialize(directory.path().to_owned()).expect("state");
    let source = directory.path().join("scene.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let imported = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("import");
    let stale_operation = operation_id();
    fs::write(
        state.staging_root.join(format!("{stale_operation}.part")),
        b"partial",
    )
    .expect("part");
    drop(state);

    let reopened = SceneState::initialize(directory.path().to_owned()).expect("reopen");
    assert_eq!(
        reopened
            .database
            .current()
            .expect("current")
            .expect("record")
            .id,
        imported.id
    );
    assert!(!reopened
        .staging_root
        .join(format!("{stale_operation}.part"))
        .exists());
}

#[test]
fn orientation_update_normalizes_persists_and_exposes_no_paths() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let state = SceneState::initialize(directory.path().to_owned()).expect("state");
    let source = directory.path().join("orientation.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let imported = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("import");

    let updated = state
        .database
        .update_orientation(
            &imported.id,
            SceneOrientation {
                quaternion: [2.0, 0.0, 0.0, 2.0],
            },
        )
        .expect("update orientation");
    let expected = std::f64::consts::FRAC_1_SQRT_2;
    assert!((updated.orientation.quaternion[0] - expected).abs() < 1.0e-12);
    assert!((updated.orientation.quaternion[3] - expected).abs() < 1.0e-12);
    let serialized = serde_json::to_string(&updated).expect("serialize record");
    assert!(!serialized.contains(directory.path().to_string_lossy().as_ref()));

    drop(state);
    let reopened = SceneState::initialize(directory.path().to_owned()).expect("reopen");
    let persisted = reopened
        .database
        .ready_by_id(&imported.id)
        .expect("query")
        .expect("record");
    assert_eq!(persisted.orientation, updated.orientation);
}

#[test]
fn orientation_update_rejects_invalid_missing_and_deleted_scenes() {
    for quaternion in [
        [0.0, 0.0, 0.0, 0.0],
        [f64::NAN, 0.0, 0.0, 1.0],
        [f64::INFINITY, 0.0, 0.0, 1.0],
    ] {
        assert_eq!(
            SceneOrientation { quaternion }
                .normalized()
                .unwrap_err()
                .code,
            "INVALID_INPUT"
        );
    }

    let (directory, state) = state();
    assert!(validate_uuid("../scene").is_err());
    let missing = Uuid::new_v4().hyphenated().to_string();
    assert_eq!(
        state
            .database
            .update_orientation(&missing, SceneOrientation::default())
            .unwrap_err()
            .code,
        "SCENE_NOT_FOUND"
    );

    let source = directory.path().join("delete-orientation.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let imported = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("import");
    state.database.begin_delete(&imported.id).expect("delete");
    assert_eq!(
        state
            .database
            .update_orientation(&imported.id, SceneOrientation::default())
            .unwrap_err()
            .code,
        "SCENE_NOT_FOUND"
    );
    assert!(!directory.path().join("auth.sqlite").exists());
}

#[test]
fn set_current_delete_and_invalid_ids_have_stable_behavior() {
    let (directory, state) = state();
    assert!(validate_uuid("../scene").is_err());
    let source = directory.path().join("scene.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let imported = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("import");
    assert_eq!(
        state.database.set_current(&imported.id).expect("set").id,
        imported.id
    );
    state
        .database
        .begin_delete(&imported.id)
        .expect("begin delete");
    fs::remove_dir_all(state.scenes_root.join(&imported.id)).expect("remove directory");
    state
        .database
        .finish_delete(&imported.id)
        .expect("finish delete");
    assert!(state.database.current().expect("current").is_none());
    assert_eq!(
        state.database.begin_delete(&imported.id).unwrap_err().code,
        "SCENE_NOT_FOUND"
    );
}

#[test]
fn protocol_enforces_origin_method_path_head_and_ready_scene() {
    let (directory, state) = state();
    let source = directory.path().join("scene.sog");
    write_valid_sog(&source, CompressionMethod::Stored);
    let imported = import_scene(
        &state,
        source.to_string_lossy().into(),
        operation_id(),
        channel(),
    )
    .expect("import");
    let path = format!("http://scene.localhost/{}/scene.sog", imported.id);

    let request = |method: &str, uri: &str, origin: &str| {
        http::Request::builder()
            .method(method)
            .uri(uri)
            .header(http::header::ORIGIN, origin)
            .body(Vec::new())
            .expect("request")
    };
    let get = build_response_for_test(&state, request("GET", &path, "http://tauri.localhost"));
    assert_eq!(get.status(), http::StatusCode::OK);
    assert_eq!(get.body().len() as u64, imported.byte_size);
    assert_eq!(get.headers()[http::header::CACHE_CONTROL], "no-store");

    let head = build_response_for_test(&state, request("HEAD", &path, "http://tauri.localhost"));
    assert_eq!(head.status(), http::StatusCode::OK);
    assert!(head.body().is_empty());
    assert_eq!(
        head.headers()[http::header::CONTENT_LENGTH],
        imported.byte_size.to_string()
    );

    assert_eq!(
        build_response_for_test(&state, request("POST", &path, "http://tauri.localhost")).status(),
        http::StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        build_response_for_test(
            &state,
            request(
                "GET",
                "http://scene.localhost/bad/scene.sog",
                "http://tauri.localhost"
            )
        )
        .status(),
        http::StatusCode::NOT_FOUND
    );
    assert_eq!(
        build_response_for_test(&state, request("GET", &path, "https://remote.example")).status(),
        http::StatusCode::FORBIDDEN
    );
}

#[test]
fn corrupt_crc_is_rejected_when_referenced_entry_is_read() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("crc.sog");
    write_valid_sog(&path, CompressionMethod::Stored);
    let mut archive = zip::ZipArchive::new(File::open(&path).expect("open")).expect("archive");
    let entry = archive.by_name("means_l.webp").expect("entry");
    let offset = entry.data_start();
    drop(entry);
    drop(archive);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("open writable");
    file.seek(SeekFrom::Start(offset)).expect("seek");
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte).expect("read");
    file.seek(SeekFrom::Start(offset)).expect("seek again");
    file.write_all(&[byte[0] ^ 0xff]).expect("corrupt");
    file.flush().expect("flush");
    assert_eq!(
        validate_sog(&path, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "INVALID_SOG"
    );
}
