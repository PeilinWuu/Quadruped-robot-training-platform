# Go2 real-robot day-one read-only procedure

Phase 0: connect only the cable, keep the robot stationary, run `preflight.sh`, `discover_network.sh`, and `discover_topics.sh`. Stop if `ROS_LOCALHOST_ONLY=1`.

Phase 1: with the official remote controller only, record 30–60 seconds standing. Mark `TRIAL_START`, command starts/stops, anomalies, and `TRIAL_END`.

Phase 2: continue read-only recording during low-speed official-controller motion. Record fixed external video and use a visible MARK/clap gesture for `sync_event`.

Do not publish `/lowcmd` or `/api/sport/request`; do not use LowCmd, MotorCmd, SportClient, custom MPC, or any motion command. Unknown serial, firmware, battery and surface fields must be filled manually, never invented.
