"""Build a conservative ground-only heightfield from an InteriorGS explicit PLY.

InteriorGS uses right/back/up coordinates. The exported heightfield is in the
viewer convention [x, up, -back], so it can be queried beside the Go2 overlay.
This intentionally models only the dominant floor band; furniture and walls
are left for the later camera-depth obstacle pipeline.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def read_xyz(path: Path) -> np.ndarray:
    with path.open("rb") as stream:
        vertex_count = None
        property_count = 0
        while True:
            line = stream.readline()
            if not line:
                raise ValueError("PLY header is incomplete")
            text = line.decode("ascii", "strict").strip()
            if text.startswith("element vertex "):
                vertex_count = int(text.split()[-1])
            elif text.startswith("property "):
                property_count += 1
            elif text == "end_header":
                break
        if vertex_count is None or property_count < 3:
            raise ValueError("PLY does not contain a vertex xyz record")
        values = np.fromfile(stream, dtype="<f4", count=vertex_count * property_count)
    if values.size != vertex_count * property_count:
        raise ValueError("PLY vertex payload is truncated")
    return values.reshape(vertex_count, property_count)[:, :3]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ply", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cell-size", type=float, default=0.10)
    args = parser.parse_args()
    xyz = read_xyz(args.ply)
    # The dominant floor band is around z=0 in InteriorGS office_01. Reject
    # floaters and furniture while retaining small reconstruction variation.
    floor = xyz[(xyz[:, 2] >= -0.12) & (xyz[:, 2] <= 0.12)]
    if len(floor) < 1000:
        raise ValueError(f"too few floor candidates: {len(floor)}")
    lower = np.percentile(floor[:, :2], 0.5, axis=0)
    upper = np.percentile(floor[:, :2], 99.5, axis=0)
    cell = args.cell_size
    shape = np.ceil((upper - lower) / cell).astype(int) + 1
    heights = np.full((shape[0], shape[1]), np.nan, dtype=np.float32)
    counts = np.zeros_like(heights, dtype=np.uint16)
    ij = np.floor((floor[:, :2] - lower) / cell).astype(int)
    valid = (ij[:, 0] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[1])
    for i, j, z in zip(ij[valid, 0], ij[valid, 1], floor[valid, 2]):
        if np.isnan(heights[i, j]): heights[i, j] = z
        else: heights[i, j] = (heights[i, j] * counts[i, j] + z) / (counts[i, j] + 1)
        counts[i, j] = min(int(counts[i, j]) + 1, np.iinfo(np.uint16).max)
    # Fill sparse holes with the robust global floor estimate, never with a
    # furniture height. Confidence remains zero for these filled cells.
    global_floor = float(np.median(floor[:, 2]))
    valid_mask = np.isfinite(heights) & (counts >= 3)
    heights[~np.isfinite(heights)] = global_floor
    heights = np.clip(heights, global_floor - 0.08, global_floor + 0.08)
    args.output.mkdir(parents=True, exist_ok=True)
    np.save(args.output / "floor_height.npy", heights)
    np.save(args.output / "valid_mask.npy", valid_mask)
    np.save(args.output / "sample_count.npy", counts)
    heights.astype("<f4").tofile(args.output / "floor_height.bin")
    valid_mask.astype("u1").tofile(args.output / "valid_mask.bin")
    metadata = {
        "schema": "gs-ground-collision-v1", "source": str(args.ply),
        "sourceCoordinateSystem": "InteriorGS right/back/up metres",
        "viewerCoordinateSystem": "PlayCanvas x/up/-back", "cellSize": cell,
        "originXY": lower.tolist(), "shape": shape.tolist(),
        "globalFloorHeight": global_floor, "candidateCount": int(len(floor)),
        "validCellCount": int(valid_mask.sum()), "filledCellCount": int((~valid_mask).sum()),
        "scope": "ground-only; no furniture or wall collision",
    }
    (args.output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
