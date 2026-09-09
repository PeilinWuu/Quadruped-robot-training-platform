"""Read-only source PLY profile for the selected booth entrance step."""
import json
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/robot_motion'))
from build_ground_collision_proxy import read_xyz

points = read_xyz(Path('D:/interiorgs_data/office_01/3dgs_explicit.ply'))
records = []
for y in np.arange(.32, .641, .02):
    patch = points[(points[:, 0] > 3.2) & (points[:, 0] < 3.8)
                   & (points[:, 1] > y) & (points[:, 1] < y + .02)
                   & (points[:, 2] > -.02) & (points[:, 2] < .18)]
    if len(patch):
        records.append(dict(sourceY=round(float(y), 3), count=len(patch),
                            heightPercentiles=np.percentile(patch[:, 2], [10, 50, 90]).tolist()))
print(json.dumps(dict(sourceX=[3.2, 3.8], profiles=records), indent=2))
