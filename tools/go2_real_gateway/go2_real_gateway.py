#!/usr/bin/env python3
"""Fail-closed one-shot Sport API gateway for a Unitree Go2.

Dry-run is the default. Live publishing requires --live and the explicit
GO2_REAL_GATEWAY_LIVE=1 environment variable.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

STOP_API = 1003
STAND_UP_API = 1004
STAND_DOWN_API = 1005
MOVE_API = 1008
LIDAR_TOPIC = "/utlidar/switch"
PROTOCOL_VERSION = 1


@dataclass(frozen=True)
class Limits:
    max_forward: float = 0.30
    max_lateral: float = 0.30
    max_yaw: float = 0.50
    max_duration_ms: int = 3000


class GatewayError(ValueError):
    pass


class SportPublisher:
    def __init__(self, live: bool, emit: Callable[[str, dict[str, Any]], None]) -> None:
        self.live = live
        self._publisher: Any = None
        self._request_type: Any = None
        self._lidar_publisher: Any = None
        self._string_type: Any = None
        self._lock = threading.RLock()
        self._emit = emit
        self._last_telemetry_emit = 0.0
        self._latest_low: dict[str, Any] | None = None
        self._latest_sport: dict[str, Any] | None = None
        self._last_telemetry_received = 0.0
        if live:
            if os.environ.get("GO2_REAL_GATEWAY_LIVE") != "1":
                raise GatewayError("live mode requires GO2_REAL_GATEWAY_LIVE=1")
            try:
                import rclpy  # type: ignore
                from rclpy.node import Node  # type: ignore
                from unitree_api.msg import Request  # type: ignore
                from unitree_go.msg import LowState, SportModeState  # type: ignore
                from std_msgs.msg import String  # type: ignore
            except ImportError as exc:
                raise GatewayError(f"ROS 2 live dependencies unavailable: {exc}") from exc
            rclpy.init()
            self._rclpy = rclpy
            self._node = Node("go2_real_sport_gateway")
            self._request_type = Request
            self._publisher = self._node.create_publisher(Request, "/api/sport/request", 10)
            self._string_type = String
            self._lidar_publisher = self._node.create_publisher(String, LIDAR_TOPIC, 10)
            self._subscriptions = [
                self._node.create_subscription(LowState, "/lowstate", self._on_low_state, 10),
                self._node.create_subscription(LowState, "/lf/lowstate", self._on_low_state, 10),
                self._node.create_subscription(SportModeState, "/sportmodestate", self._on_sport_state, 10),
                self._node.create_subscription(SportModeState, "/lf/sportmodestate", self._on_sport_state, 10),
            ]
            self._executor = rclpy.executors.SingleThreadedExecutor()
            self._executor.add_node(self._node)
            self._spin_thread = threading.Thread(target=self._executor.spin, name="go2-telemetry", daemon=True)
            self._spin_thread.start()

    def close(self) -> None:
        if self.live:
            self._executor.shutdown()
            self._spin_thread.join(timeout=1.0)
            self._node.destroy_node()
            self._rclpy.shutdown()

    def _request(self, api_id: int, parameter: str = "{}") -> None:
        if not self.live:
            return
        with self._lock:
            msg = self._request_type()
            msg.header.identity.id = time.monotonic_ns()
            msg.header.identity.api_id = api_id
            msg.header.lease.id = 0
            msg.header.policy.priority = 0
            msg.header.policy.noreply = True
            msg.parameter = parameter
            self._publisher.publish(msg)

    def stop(self) -> None:
        with self._lock:
            for _ in range(3):
                self._request(STOP_API)
                time.sleep(0.10)

    def move(self, x: float, y: float, yaw: float) -> None:
        self._request(MOVE_API, json.dumps({"x": x, "y": y, "z": yaw}, separators=(",", ":")))

    def simple(self, api_id: int) -> None:
        self._request(api_id)

    def lidar(self, enabled: bool) -> None:
        if not self.live:
            return
        for _ in range(30):
            with self._lock:
                msg = self._string_type()
                msg.data = "ON" if enabled else "OFF"
                self._lidar_publisher.publish(msg)
            time.sleep(0.05)

    def _on_low_state(self, msg: Any) -> None:
        self._last_telemetry_received = time.monotonic()
        self._latest_low = {
            "tick": int(msg.tick), "batterySoc": int(msg.bms_state.soc),
            "powerVoltage": float(msg.power_v), "powerCurrent": float(msg.power_a),
            "rpy": [float(value) for value in msg.imu_state.rpy],
            "gyroscope": [float(value) for value in msg.imu_state.gyroscope],
            "accelerometer": [float(value) for value in msg.imu_state.accelerometer],
            "footForce": [int(value) for value in msg.foot_force],
            "joints": [{"position": float(joint.q), "velocity": float(joint.dq), "torque": float(joint.tau_est), "temperature": int(joint.temperature)} for joint in msg.motor_state[:12]],
        }
        self._emit_telemetry()

    def _on_sport_state(self, msg: Any) -> None:
        self._last_telemetry_received = time.monotonic()
        self._latest_sport = {
            "errorCode": int(msg.error_code), "mode": int(msg.mode), "gaitType": int(msg.gait_type),
            "position": [float(value) for value in msg.position],
            "velocity": [float(value) for value in msg.velocity],
            "bodyHeight": float(msg.body_height), "yawSpeed": float(msg.yaw_speed),
        }
        self._emit_telemetry()

    def _emit_telemetry(self) -> None:
        now = time.monotonic()
        if now - self._last_telemetry_emit < 0.2:
            return
        self._last_telemetry_emit = now
        self._emit("telemetry", {"lowState": self._latest_low, "sportModeState": self._latest_sport})

    def robot_online(self) -> bool:
        return not self.live or time.monotonic() - self._last_telemetry_received <= 1.0


class Gateway:
    def __init__(self, publisher: SportPublisher, emit: Callable[[str, dict[str, Any]], None], limits: Limits = Limits()) -> None:
        self.publisher = publisher
        self.emit = emit
        self.limits = limits
        self.control_enabled = False
        self.active_move = False
        self._move_cancel: threading.Event | None = None
        self._move_thread: threading.Thread | None = None
        self._move_lock = threading.Lock()

    def _number(self, payload: dict[str, Any], key: str, limit: float) -> float:
        value = payload.get(key, 0.0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise GatewayError(f"invalid {key}")
        if abs(value) > limit:
            raise GatewayError(f"{key} exceeds safety limit {limit}")
        return float(value)

    def _duration(self, payload: dict[str, Any]) -> int:
        value = payload.get("durationMs", 0)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > self.limits.max_duration_ms:
            raise GatewayError(f"durationMs must be 1..{self.limits.max_duration_ms}")
        return value

    def _stop_move(self) -> None:
        with self._move_lock:
            if self._move_cancel is not None:
                self._move_cancel.set()
            self._move_cancel = None
            self.publisher.stop()
            self.active_move = False

    def handle(self, frame: dict[str, Any]) -> None:
        if frame.get("protocolVersion", PROTOCOL_VERSION) != PROTOCOL_VERSION:
            raise GatewayError("unsupported protocol version")
        kind = frame.get("type")
        payload = frame.get("payload", {})
        if not isinstance(payload, dict):
            raise GatewayError("payload must be an object")
        if kind == "configure":
            self.control_enabled = bool(payload.get("controlEnabled", False))
            if not self.control_enabled:
                self._stop_move()
            self.emit("status", self.status())
        elif kind == "control_enable":
            self.control_enabled = payload.get("enabled") is True
            if not self.control_enabled:
                self._stop_move()
            self.emit("status", self.status())
        elif kind == "move_once":
            if not self.control_enabled:
                raise GatewayError("real control source is disabled")
            if not self.publisher.robot_online():
                raise GatewayError("real robot telemetry is stale or unavailable")
            x = self._number(payload, "forwardVelocity", self.limits.max_forward)
            y = self._number(payload, "lateralVelocity", self.limits.max_lateral)
            yaw = self._number(payload, "yawRate", self.limits.max_yaw)
            duration = self._duration(payload)
            with self._move_lock:
                if self.active_move:
                    raise GatewayError("a move is already active; send stop first")
                self.active_move = True
                cancel = threading.Event()
                self._move_cancel = cancel
                self.publisher.move(x, y, yaw)
            self.emit("action", {"action": "move_started", "durationMs": duration})
            self._move_thread = threading.Thread(target=self._finish_move, args=(duration, cancel), daemon=True)
            self._move_thread.start()
        elif kind == "keyboard_motion":
            if not self.control_enabled:
                raise GatewayError("real control source is disabled")
            if not self.publisher.robot_online():
                raise GatewayError("real robot telemetry is stale or unavailable")
            x = self._number(payload, "forwardVelocity", self.limits.max_forward)
            y = self._number(payload, "lateralVelocity", self.limits.max_lateral)
            yaw = self._number(payload, "yawRate", self.limits.max_yaw)
            if x == 0.0 and y == 0.0 and yaw == 0.0:
                raise GatewayError("zero keyboard motion must use stop")
            with self._move_lock:
                if self._move_cancel is not None:
                    self._move_cancel.set()
                self.active_move = True
                cancel = threading.Event()
                self._move_cancel = cancel
                self.publisher.move(x, y, yaw)
            self.emit("action", {"action": "keyboard_move_started"})
        elif kind == "stop":
            self._stop_move()
            self.emit("action", {"action": "stopped"})
        elif kind == "stand_up":
            if not self.control_enabled:
                raise GatewayError("real control source is disabled")
            self.publisher.simple(STAND_UP_API)
            self.emit("action", {"action": "stand_up"})
        elif kind == "stand_down":
            if not self.control_enabled:
                raise GatewayError("real control source is disabled")
            self.publisher.simple(STAND_DOWN_API)
            self.emit("action", {"action": "stand_down"})
        elif kind == "lidar":
            if self.active_move:
                raise GatewayError("lidar switching is blocked while a move is active")
            self.publisher.lidar(payload.get("enabled") is True)
            self.emit("action", {"action": "lidar", "enabled": payload.get("enabled") is True})
        elif kind == "shutdown":
            self._stop_move()
            self.control_enabled = False
        else:
            raise GatewayError(f"unknown command: {kind}")

    def status(self) -> dict[str, Any]:
        return {"controlEnabled": self.control_enabled, "activeMove": self.active_move, "watchdogState": "one_shot"}

    def _finish_move(self, duration_ms: int, cancel: threading.Event) -> None:
        deadline = time.monotonic() + duration_ms / 1000.0
        reason = "duration_elapsed"
        while not cancel.wait(min(0.1, max(0.0, deadline - time.monotonic()))):
            if not self.publisher.robot_online():
                reason = "telemetry_timeout"
                break
            if time.monotonic() >= deadline:
                break
        stopped = False
        with self._move_lock:
            if not cancel.is_set() and self._move_cancel is cancel:
                self.publisher.stop()
                self._move_cancel = None
                self.active_move = False
                stopped = True
        if stopped:
            self.emit("action", {"action": "move_stopped", "reason": reason})

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="publish to the real robot; requires GO2_REAL_GATEWAY_LIVE=1")
    args = parser.parse_args()
    output_lock = threading.Lock()
    def emit(kind: str, payload: dict[str, Any]) -> None:
        with output_lock:
            print(json.dumps({"protocolVersion": PROTOCOL_VERSION, "type": kind, "payload": payload}, separators=(",", ":")), flush=True)
    try:
        publisher = SportPublisher(args.live, emit)
    except GatewayError as exc:
        print(json.dumps({"protocolVersion": PROTOCOL_VERSION, "type": "protocol_error", "payload": {"code": "NOT_READY", "message": str(exc), "recoverable": False}}), flush=True)
        return 2

    gateway = Gateway(publisher, emit)
    emit("ready", {"bridgeVersion": "go2-real-gateway-0.1.0", "watchdogMs": 300, "live": args.live})
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                frame = json.loads(line)
                gateway.handle(frame)
                if frame.get("type") == "shutdown":
                    break
            except (GatewayError, json.JSONDecodeError, TypeError, ValueError) as exc:
                emit("protocol_error", {"code": "INVALID_COMMAND", "message": str(exc), "recoverable": True})
    finally:
        try:
            publisher.stop()
        finally:
            publisher.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
