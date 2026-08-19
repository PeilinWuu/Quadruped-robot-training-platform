#!/usr/bin/env bash
set -u
command -v ros2 >/dev/null || { echo 'FAIL: ros2 is not installed'; exit 1; }
mapfile -t topics < <(ros2 topic list 2>/dev/null)
pick(){ for x in "$@"; do printf '%s\n' "${topics[@]}" | grep -Fxq "$x" && { echo "$x"; return; }; done; echo ''; }
echo "SPORT_STATE_TOPIC=$(pick /sportmodestate /lf/sportmodestate)"
echo "LOW_STATE_TOPIC=$(pick /lowstate /lf/lowstate)"
echo "WIRELESS_TOPIC=$(pick /wirelesscontroller)"
echo "SPORT_REQUEST_TOPIC=$(pick /api/sport/request)"
echo "SPORT_RESPONSE_TOPIC=$(pick /api/sport/response)"
echo 'All discovered topics:'
printf '%s\n' "${topics[@]}"
