#!/usr/bin/env bash
set -u
dir="${2:-}"
[ "${1:-}" = --trial-dir ] && [ -n "$dir" ] || { echo 'usage: stop_capture.sh --trial-dir <trial>'; exit 2; }
if [ -f "$dir/.rosbag_pid" ]; then
  kill -INT "$(cat "$dir/.rosbag_pid")" 2>/dev/null || true
  rm -f "$dir/.rosbag_pid"
fi
date -Is > "$dir/stop_time.txt"
echo "Capture stopped: $dir"
