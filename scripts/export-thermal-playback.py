"""Export existing solid temperature frames; never run or modify a simulation."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np


def export(playback):
    metadata = json.loads((playback / 'metadata.json').read_text())
    source = Path(metadata['source']['simulationDirectory']) / 'wood_temperature'
    frames = [f['sourceFrame'] for f in metadata['frames']]
    shape = np.array(metadata['grid']['sourceDimensions'])
    lower, upper = shape.copy(), np.zeros(3, dtype=int)
    for frame in frames:
        data = np.load(source / f'wood_temperature_{frame}.npz')['arr_0']
        if tuple(data.shape) != tuple(shape) or not np.isfinite(data).all():
            raise ValueError('Invalid solid temperature grid')
        points = np.argwhere(data > .001)
        if points.size:
            lower = np.minimum(lower, points.min(axis=0))
            upper = np.maximum(upper, points.max(axis=0) + 1)
    if np.any(upper <= lower):
        raise ValueError('No solid heat in selected frames')
    lower, upper = np.maximum(0, lower - 2), np.minimum(shape, upper + 2)
    slices = tuple(slice(int(a), int(b)) for a, b in zip(lower, upper))
    records = []
    for frame in frames:
        data = np.load(source / f'wood_temperature_{frame}.npz')['arr_0'][slices]
        payload = np.rint(np.clip(data / 1.2, 0, 1) * 255).astype('uint8').tobytes()
        name = f'thermal_{frame:03d}.bin'
        (playback / name).write_bytes(payload)
        records.append(dict(sourceFrame=frame, file=name, sha256=hashlib.sha256(payload).hexdigest()))
    result = dict(schema='fierygs-solid-thermal-v1', scenarioId=metadata['scenarioId'],
                  dimensions=(upper-lower).tolist(),
                  lower=(np.array(metadata['grid']['sourceLower']) + lower * metadata['grid']['voxelSize']).tolist(),
                  extent=((upper-lower) * metadata['grid']['voxelSize']).tolist(),
                  layout='source-c-order-xyz', normalizedMaximum=1.2,
                  units='relative-model-temperature-not-celsius', frames=records)
    (playback / 'thermal.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(playback, 'dimensions', result['dimensions'], 'frames', len(frames), 'bytes/frame', len(payload))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('playback', nargs='+', type=Path)
    for directory in parser.parse_args().playback:
        export(directory)
