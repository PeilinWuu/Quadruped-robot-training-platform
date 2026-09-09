"""Convert one Kine2Go reference trajectory to compact Go2 playback assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


JOINT_NAMES = (
    "FL_hip_joint", "FL_thigh_joint", "FL_calf_joint",
    "FR_hip_joint", "FR_thigh_joint", "FR_calf_joint",
    "RL_hip_joint", "RL_thigh_joint", "RL_calf_joint",
    "RR_hip_joint", "RR_thigh_joint", "RR_calf_joint",
)

# Genesis floating-base DOFs 6:18 are grouped by joint type for this asset:
# FR/FL/RR/RL hip, then thigh, then calf. Reorder to the application's rig.
SOURCE_TO_RIG = (1, 5, 9, 0, 4, 8, 3, 7, 11, 2, 6, 10)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--clip-id", default="solo8_walk")
    parser.add_argument("--fps", type=float, default=60.0)
    args = parser.parse_args()

    motion = np.load(args.input, allow_pickle=False)
    if motion.ndim != 2 or motion.shape[1] != 61 or motion.shape[0] < 2:
        raise ValueError(f"Expected Kine2Go (T, 61), got {motion.shape}")
    if not np.isfinite(motion).all():
        raise ValueError("Motion contains non-finite values")

    # Kine2Go: joints are [FR, FL, RR, RL], quaternion is [w,x,y,z], Z-up.
    # Runtime asset stays in source Z-up; the browser adapter performs the
    # documented source-to-viewer conversion and rig joint reordering.
    joints = motion[:, 6:18][:, SOURCE_TO_RIG]
    frames = np.concatenate(
        (motion[:, 48:51], motion[:, 52:55], motion[:, 51:52], joints),
        axis=1,
    ).astype("<f4", copy=False)
    output = args.output_dir
    output.mkdir(parents=True, exist_ok=True)
    (output / "frames.bin").write_bytes(frames.tobytes(order="C"))
    metadata = {
        "schema": "go2-motion-playback-v1",
        "clipId": args.clip_id,
        "displayName": "Go2 Solo8 Walk",
        "fps": args.fps,
        "frameCount": int(frames.shape[0]),
        "loopMode": "loop",
        "frameLayout": ["root_x", "root_y", "root_z", "quat_x", "quat_y", "quat_z", "quat_w", *JOINT_NAMES],
        "componentType": "float32-little-endian",
        "componentsPerFrame": 19,
        "frameBytes": 76,
        "coordinateSystem": "source-z-up-x-forward-y-left",
        "jointOrder": list(JOINT_NAMES),
        "cycleDeltaPosition": (motion[-1, 48:51] - motion[0, 48:51]).tolist(),
        "source": {
            "dataset": "MIMUW-Robotics/kine2go",
            "clip": args.clip_id,
            "subset": "cassi / Solo8",
            "license": "BSD-3-Clause",
            "url": f"https://huggingface.co/datasets/MIMUW-Robotics/kine2go/tree/main/data/{args.clip_id}",
        },
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"status": "complete", "shape": list(motion.shape), "frames": int(frames.shape[0]), "output": str(output)}, indent=2))


if __name__ == "__main__":
    main()
