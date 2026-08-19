# D6 Chromium/Electron runtime POC

Development-only renderer A/B harness. It reuses the production `RobotPanel`, Zustand store,
telemetry types, `RobotTelemetryBuffer`, formatting, and CSS. It does not spawn MuJoCo, ROS,
or implement keyboard control.

```bash
npm run electron:poc
npm run electron:poc:static
```

The equivalent WebKitGTK routes use the exact same Vite entry and generator:

```bash
npm run webkit:poc
npm run webkit:poc:static
```

Security: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. The preload only
exposes a read-only version query. Renderer diagnostics are written by the main process to `/tmp`.
