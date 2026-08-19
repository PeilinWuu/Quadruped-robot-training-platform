# Go2 read-only black-box capture

These tools are observation-only and fail-closed. They discover and record Unitree ROS 2 topics but never publish to `/lowcmd` or `/api/sport/request`, and never call a SportClient motion API. Raw captures live under `data/go2_capture/` and are ignored by Git. Validation and analysis write only derived files.

Field workflow: preflight, network/topic discovery, `start_capture.sh --trial standing_baseline`, event markers, `stop_capture.sh`, validation, then summary. Use `--local-fixture` for the deterministic no-robot test.
