use super::{models::STORED_FILENAME, validate_uuid, SceneState};
use std::{fs, io::Read};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};

const ALLOWED_ORIGINS: [&str; 2] = ["http://tauri.localhost", "http://localhost:5173"];

pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let Some(state) = context.app_handle().try_state::<SceneState>() else {
        responder.respond(error_response(StatusCode::INTERNAL_SERVER_ERROR));
        return;
    };
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let response =
            tauri::async_runtime::spawn_blocking(move || build_response(&state, request))
                .await
                .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR));
        responder.respond(response);
    });
}

fn build_response(state: &SceneState, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let Some(origin) = origin.filter(|value| ALLOWED_ORIGINS.contains(value)) else {
        return error_response(StatusCode::FORBIDDEN);
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return response_with_origin(StatusCode::METHOD_NOT_ALLOWED, origin, Vec::new(), None);
    }
    if request.uri().query().is_some() {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    }
    let Some(scene_id) = parse_path(request.uri().path()) else {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    };
    let Ok(Some(record)) = state.database.ready_by_id(scene_id) else {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    };
    let path = state.scenes_root.join(scene_id).join(STORED_FILENAME);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != record.byte_size
    {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    }
    if request.method() == Method::HEAD {
        return response_with_origin(StatusCode::OK, origin, Vec::new(), Some(record.byte_size));
    }
    let Ok(mut file) = fs::File::open(path) else {
        return response_with_origin(StatusCode::NOT_FOUND, origin, Vec::new(), None);
    };
    let Ok(capacity) = usize::try_from(record.byte_size) else {
        return response_with_origin(StatusCode::INTERNAL_SERVER_ERROR, origin, Vec::new(), None);
    };
    let mut body = Vec::with_capacity(capacity);
    if file.read_to_end(&mut body).is_err() || body.len() as u64 != record.byte_size {
        return response_with_origin(StatusCode::INTERNAL_SERVER_ERROR, origin, Vec::new(), None);
    }
    response_with_origin(StatusCode::OK, origin, body, Some(record.byte_size))
}

fn parse_path(path: &str) -> Option<&str> {
    let path = path.strip_prefix('/')?;
    let (scene_id, filename) = path.split_once('/')?;
    if filename != STORED_FILENAME || scene_id.contains('%') || validate_uuid(scene_id).is_err() {
        return None;
    }
    Some(scene_id)
}

fn response_with_origin(
    status: StatusCode,
    origin: &str,
    body: Vec<u8>,
    content_length: Option<u64>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(header::VARY, "Origin");
    if let Some(length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, length.to_string());
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
pub(super) fn build_response_for_test(
    state: &SceneState,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    build_response(state, request)
}
