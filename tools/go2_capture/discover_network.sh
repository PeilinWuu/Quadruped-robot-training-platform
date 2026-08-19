#!/usr/bin/env bash
set -u
echo 'Go2 Real Robot Preflight'
for d in /sys/class/net/*; do
  i=${d##*/}; [ "$i" = lo ] && continue; [ -r "$d/operstate" ] || continue; [ "$(cat "$d/operstate")" = down ] && continue
  echo "Interface: $i"; ip -o -4 addr show dev "$i" 2>/dev/null | awk '{print "IPv4: " $4}'
done
echo "RMW: ${RMW_IMPLEMENTATION:-UNSET}"; echo "ROS_DOMAIN_ID: ${ROS_DOMAIN_ID:-UNSET}"; echo "ROS_LOCALHOST_ONLY: ${ROS_LOCALHOST_ONLY:-UNSET}"; echo "CycloneDDS interface: ${CYCLONEDDS_URI:-UNSET}"
[ "${ROS_LOCALHOST_ONLY:-}" = 1 ] && echo 'Status: NOT READY (localhost-only)' || echo 'Status: READY (verify robot subnet before recording)'
