import time
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from go2_real_gateway import Gateway, Limits  # noqa: E402


class FakePublisher:
    def __init__(self):
        self.calls = []

    def move(self, x, y, yaw): self.calls.append(("move", x, y, yaw))
    def stop(self): self.calls.append(("stop",))
    def simple(self, api): self.calls.append(("simple", api))
    def lidar(self, enabled): self.calls.append(("lidar", enabled))
    def robot_online(self): return True


def test_move_is_one_shot_and_stopped():
    p = FakePublisher(); out = []
    g = Gateway(p, lambda kind, payload: out.append((kind, payload)), Limits(max_duration_ms=100))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "move_once", "payload": {"forwardVelocity": .1, "durationMs": 10}})
    time.sleep(0.03)
    assert p.calls == [("move", .1, 0.0, 0.0), ("stop",)]
    assert out[-1][1]["action"] == "move_stopped"


def test_disabled_and_out_of_bounds_commands_are_rejected():
    p = FakePublisher(); g = Gateway(p, lambda *_: None)
    try: g.handle({"type": "move_once", "payload": {"durationMs": 1}})
    except ValueError as exc: assert "disabled" in str(exc)
    else: assert False
    g.control_enabled = True
    try: g.handle({"type": "move_once", "payload": {"forwardVelocity": .31, "durationMs": 1}})
    except ValueError as exc: assert "safety limit" in str(exc)
    else: assert False


def test_stopped_old_timer_cannot_stop_a_new_move():
    p = FakePublisher(); g = Gateway(p, lambda *_: None, Limits(max_duration_ms=100))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "move_once", "payload": {"forwardVelocity": .1, "durationMs": 50}})
    g.handle({"type": "stop", "payload": {}})
    g.handle({"type": "move_once", "payload": {"forwardVelocity": .2, "durationMs": 90}})
    time.sleep(0.06)
    assert g.active_move
    assert p.calls == [("move", .1, 0.0, 0.0), ("stop",), ("move", .2, 0.0, 0.0)]
    g.handle({"type": "stop", "payload": {}})


def test_keyboard_motion_replaces_intent_without_an_intermediate_stop():
    p = FakePublisher(); out = []
    g = Gateway(p, lambda kind, payload: out.append((kind, payload)), Limits(max_duration_ms=100))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "keyboard_motion", "payload": {"forwardVelocity": .1}})
    g.handle({"type": "keyboard_motion", "payload": {"lateralVelocity": .1, "yawRate": -.2}})
    time.sleep(0.15)
    assert g.active_move
    assert p.calls == [("move", .1, 0.0, 0.0), ("move", 0.0, .1, -.2)]
    assert [payload["action"] for kind, payload in out if kind == "action"] == ["keyboard_move_started", "keyboard_move_started"]
    g.handle({"type": "stop", "payload": {}})
    assert not g.active_move
    assert p.calls[-1] == ("stop",)


def test_keyboard_motion_rejects_zero_and_obeys_safety_limits():
    p = FakePublisher(); g = Gateway(p, lambda *_: None)
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    for payload, message in [
        ({}, "must use stop"),
        ({"forwardVelocity": .31}, "safety limit"),
    ]:
        try: g.handle({"type": "keyboard_motion", "payload": payload})
        except ValueError as exc: assert message in str(exc)
        else: assert False
    assert p.calls == []


def test_keyboard_motion_has_no_duration_or_telemetry_timeout():
    class OnlinePublisher(FakePublisher):
        online = True
        def robot_online(self): return self.online
    p = OnlinePublisher(); out = []
    g = Gateway(p, lambda kind, payload: out.append((kind, payload)), Limits(max_duration_ms=20))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "keyboard_motion", "payload": {"forwardVelocity": .1}})
    time.sleep(0.08)
    assert g.active_move
    assert p.calls == [("move", .1, 0.0, 0.0)]
    p.online = False
    time.sleep(0.13)
    assert g.active_move
    assert p.calls == [("move", .1, 0.0, 0.0)]
    try: g.handle({"type": "keyboard_motion", "payload": {"lateralVelocity": .1}})
    except ValueError as exc: assert "telemetry" in str(exc)
    else: assert False
    assert g.active_move
    g.handle({"type": "stop", "payload": {}})
    assert not g.active_move
    assert p.calls[-1] == ("stop",)


def test_telemetry_loss_stops_active_move_early():
    class OnlinePublisher(FakePublisher):
        online = True
        def robot_online(self): return self.online
    p = OnlinePublisher(); out = []
    g = Gateway(p, lambda kind, payload: out.append((kind, payload)), Limits(max_duration_ms=500))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "move_once", "payload": {"forwardVelocity": .1, "durationMs": 400}})
    p.online = False
    time.sleep(0.13)
    assert p.calls[-1] == ("stop",)
    assert out[-1][1]["reason"] == "telemetry_timeout"


def test_lidar_switch_is_rejected_during_move():
    p = FakePublisher(); g = Gateway(p, lambda *_: None, Limits(max_duration_ms=500))
    g.handle({"type": "control_enable", "payload": {"enabled": True}})
    g.handle({"type": "move_once", "payload": {"forwardVelocity": .1, "durationMs": 400}})
    try: g.handle({"type": "lidar", "payload": {"enabled": True}})
    except ValueError as exc: assert "blocked" in str(exc)
    else: assert False
    g.handle({"type": "stop", "payload": {}})


def test_cli_dry_run_never_requires_ros():
    proc = subprocess.run([sys.executable, str(ROOT / "go2_real_gateway.py")], input='{"type":"configure","payload":{"controlEnabled":false}}\n', text=True, capture_output=True, check=True)
    assert '"type":"ready"' in proc.stdout
    assert '"type":"status"' in proc.stdout
