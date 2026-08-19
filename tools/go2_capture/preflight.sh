#!/usr/bin/env bash
set -u
fail=0
report(){ printf '%-24s %s\n' "$1" "${2:-UNKNOWN}"; }
echo 'Go2 Read-only ROS2 Preflight'
report ubuntu "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo unavailable)"
report ROS_DISTRO "${ROS_DISTRO:-UNSET}"
if command -v ros2 >/dev/null; then report ros2 "$(command -v ros2)"; else report ros2 MISSING; fail=1; fi
for p in rmw_cyclonedds_cpp unitree_go unitree_api; do
  if command -v ros2 >/dev/null && ros2 pkg prefix "$p" >/dev/null 2>&1; then report "$p" "$(ros2 pkg prefix "$p")"; else report "$p" MISSING; [ "$p" = rmw_cyclonedds_cpp ] && fail=1; fi
done
if command -v ros2 >/dev/null && ros2 bag --help >/dev/null 2>&1; then report ros2_bag READY; else report ros2_bag MISSING; fail=1; fi
report python "$(python3 --version 2>&1)"; report disk_free "$(df -h . | awk 'NR==2 {print $4}')"
report interfaces "$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | paste -sd, - || echo unavailable)"
report ipv4 "$(ip -o -4 addr show 2>/dev/null | awk '{print $2"=" $4}' | paste -sd, - || echo unavailable)"
report RMW_IMPLEMENTATION "${RMW_IMPLEMENTATION:-UNSET}"; report ROS_DOMAIN_ID "${ROS_DOMAIN_ID:-UNSET}"
report ROS_LOCALHOST_ONLY "${ROS_LOCALHOST_ONLY:-UNSET}"; report CYCLONEDDS_URI "${CYCLONEDDS_URI:-UNSET}"
if [ "${ROS_LOCALHOST_ONLY:-}" = 1 ]; then echo 'FAIL: real robot discovery cannot use localhost-only mode'; fail=1; fi
if [ "$fail" -ne 0 ]; then echo 'Status: NOT READY (observation tools remain fail-closed)'; exit 1; fi
echo 'Status: READY'
