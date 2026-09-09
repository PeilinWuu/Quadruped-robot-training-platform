"""Smooth an existing occupancy surface for display occlusion; no simulation changes."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.measure import marching_cubes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    metadata = json.loads(Path('D:/interiorgs_data/office_01/fire_playback/table_high/metadata.json').read_text())
    source = Path(metadata['source']['simulationDirectory']) / 'occupancy/occupancy_0.npz'
    with np.load(source) as data:
        solid = (np.abs(data[data.files[0]]) > .1).astype(np.float32)
    # Pad so exterior surfaces remain closed. Mild filtering rounds voxel corners;
    # 0.4 retains thin occupied sheets better than the 0.5 binary midpoint.
    field = gaussian_filter(np.pad(solid, 2), sigma=.6)
    vertices, faces, _, _ = marching_cubes(field, level=.4, allow_degenerate=False)
    vertices = (vertices - 2 + .5) * metadata['grid']['voxelSize'] + np.array(metadata['grid']['sourceLower'])
    vertices = vertices[:, [0, 2, 1]]
    vertices[:, 2] *= -1
    payload = vertices[faces].astype('<f4').tobytes()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(payload)
    report = dict(source=str(source), triangles=len(faces), bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
                  sigma_voxels=.6, isovalue=.4, limitation='Smoothed 5 cm occupancy, not exact Gaussian surface depth')
    args.output.with_suffix('.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
