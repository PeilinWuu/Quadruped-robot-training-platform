#!/usr/bin/env bash
set -u
trial=''; fixture=0
while [ $# -gt 0 ]; do
  case "$1" in
    --trial) trial=${2:-}; shift 2;;
    --local-fixture) fixture=1; shift;;
    *) echo "unknown option: $1"; exit 2;;
  esac
done
[ -n "$trial" ] || { echo 'usage: start_capture.sh --trial <name> [--local-fixture]'; exit 2; }
stamp=$(date -u +%Y%m%d_%H%M%S); dir="data/go2_capture/${stamp}_${trial}"
mkdir -p "$dir/bag" "$dir/raw" "$dir/processed" "$dir/analysis"
python3 tools/go2_capture/tests/make_manifest.py "$dir" "$stamp" "$trial"
if ! tools/go2_capture/preflight.sh > "$dir/preflight.txt" 2>&1; then
  if [ "$fixture" != 1 ]; then
    echo 'FAIL: preflight failed; no real-robot capture started' >&2
    exit 1
  fi
fi
{ date -u --iso-8601=seconds; uname -a; env | grep -E '^(ROS_|RMW_|CYCLONEDDS)' | sort || true; } > "$dir/environment.txt"
if [ "$fixture" = 1 ]; then
  python3 tools/go2_capture/tests/fake_fixture.py --trial-dir "$dir" --seconds 30
  echo LOCAL_TEST_ONLY > "$dir/LOCAL_TEST_ONLY"
else
  command -v ros2 >/dev/null || { echo 'FAIL: ros2 missing; no capture started'; exit 1; }
  ros2 topic list > "$dir/topics.all.txt"
  : > "$dir/topics.txt"
  for t in /sportmodestate /lf/sportmodestate /lowstate /lf/lowstate /wirelesscontroller /api/sport/request /api/sport/response; do
    grep -Fxq "$t" "$dir/topics.all.txt" && echo "$t" >> "$dir/topics.txt"
  done
  mapfile -t selected < "$dir/topics.txt"
  { date -u --iso-8601=seconds; for t in "${selected[@]}"; do ros2 topic hz "$t" -w 5 2>&1 | head -n 8; done; } > "$dir/topic_rates.txt" &
  (ros2 bag record -o "$dir/bag" "${selected[@]}" > "$dir/rosbag.log" 2>&1) & echo $! > "$dir/.rosbag_pid"
fi
echo "Capture started: $dir"
