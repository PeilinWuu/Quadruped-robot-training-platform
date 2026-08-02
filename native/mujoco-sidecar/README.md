# Quadruped simulation sidecar

This C++17 executable is the D4B process-management test sidecar. It implements
only protocol version 1 `hello`, `ping`, and `shutdown` commands over NDJSON.
It does not contain MuJoCo, simulation, model-loading, networking, or child
process functionality.

Build it from the repository root with `npm run build:sidecar`. The script
configures an isolated CMake build, runs CTest, and copies only the Release EXE
to the fixed Tauri resource directory.

The vendored nlohmann/json 3.12.0 single header is covered by the MIT license in
`LICENSES/nlohmann-json-MIT.txt`.
