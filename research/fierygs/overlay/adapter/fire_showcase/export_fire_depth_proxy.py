"""Build static world-space occlusion geometry from existing occupancy_0, never a camera depth image."""
import argparse
import json
from pathlib import Path
import numpy as np


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--metadata', type=Path, default=Path('D:/interiorgs_data/office_01/fire_playback_v2/table_high_test/metadata.json'))
    args = p.parse_args()
    m = json.loads(args.metadata.read_text())
    path = args.metadata.parent / 'proxy.bin'
    if path.exists():
        raise FileExistsError(path)
    root = Path(m['source']['simulationDirectory'])
    with np.load(root / 'occupancy/occupancy_0.npz') as data:
        solid = np.abs(data[data.files[0]]) > .1
    # Keep native 5 cm resolution: conservative pooling would thicken thin desks.
    faces = []
    for axis in range(3):
        others = [i for i in range(3) if i != axis]
        for sign in (-1, 1):
            neighbor = np.roll(solid, -sign, axis=axis)
            edge = [slice(None)] * 3
            edge[axis] = -1 if sign == 1 else 0
            neighbor[tuple(edge)] = False
            cells = np.argwhere(solid & ~neighbor).astype(np.float32)
            offsets = np.zeros((4,3), dtype=np.float32)
            offsets[:, axis] = 1 if sign == 1 else 0
            offsets[:, others[0]] = [0,1,1,0]
            offsets[:, others[1]] = [0,0,1,1]
            vertices = (cells[:,None,:] + offsets[None,:,:])[:, [0,1,2,0,2,3], :].reshape(-1,3)
            vertices = vertices * m['grid']['voxelSize'] + np.array(m['grid']['sourceLower'])
            vertices = vertices[:, [0,2,1]]
            vertices[:,2] *= -1
            faces.append(vertices.astype('<f4'))
    vertices = np.concatenate(faces)
    path.write_bytes(vertices.tobytes())
    report = dict(vertices=len(vertices), triangles=len(vertices)//3, bytes=path.stat().st_size,
                  source='occupancy_0 absolute > 0.1; exposed 5 cm voxel faces; static full room',
                  limitation='Approximate occupied surfaces, no Gaussian opacity or dynamic carbonization. Independent opt-in.')
    (args.metadata.parent / 'proxy-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
