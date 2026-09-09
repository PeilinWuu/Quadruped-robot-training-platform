"""Export ONLY the 16-frame playback-v2 prototype from existing simulation files.

The native XYZ -> CAT02 -> linear RGB transform is baked before quantization.
Gamma and legacy clipping remain after ray integration, as in the native renderer.
No simulation, scene mutation, or display-HDR experiment is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import numpy as np


def native_linear_rgb_table() -> np.ndarray:
    # The same 101-sample CIE/Planck table, CAT02 white and matrices as
    # simulation/color_mapping.py, evaluated in float64 for the export.
    cie = np.loadtxt(Path(__file__).resolve().parents[2] / 'simulation/cie-cmf.txt', usecols=(1, 2, 3))
    wl = np.linspace(380, 780, 81) * 1e-9
    def spectrum(t):
        with np.errstate(over='ignore'):
            return (2 * 6.62607015e-34 * 299792458**2 / wl**5) / np.expm1(6.62607015e-34 * 299792458 / (wl * 1.380649e-23 * t))
    cat = np.array([[.7328,.4296,-.1624],[-.7036,1.6975,.0061],[.003,.0136,.9834]])
    srgb = np.array([[3.2406,-1.5372,-.4986],[-.9689,1.8758,.0415],[.0557,-.204,1.057]])
    white = (spectrum(12273) * 1e-9 @ cie) @ cat.T
    xyz = spectrum((273 + np.linspace(0, 1, 101) * 12000)[:, None]) @ cie
    return ((xyz @ cat.T / white) @ np.linalg.inv(cat).T @ srgb.T) * .005


def bake(fuel: np.ndarray, table: np.ndarray) -> np.ndarray:
    temperature = np.maximum(.4 - (.6 / .09) * (fuel - 1) * (fuel - .4), 0) * .12
    scaled = np.clip(temperature, 0, 1) * 100
    lo = np.minimum(scaled.astype(int), 99)
    return table[lo] + (table[lo + 1] - table[lo]) * (scaled - lo)[..., None]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--v1-metadata', type=Path, default=Path('D:/interiorgs_data/office_01/fire_playback/table_high/metadata.json'))
    parser.add_argument('--output-dir', type=Path, default=Path('D:/interiorgs_data/office_01/fire_playback_v2/table_high_test'))
    args = parser.parse_args()
    metadata = json.loads(args.v1_metadata.read_text())
    # Refuse existing directories, including V1, even on accidental reruns.
    if args.output_dir.exists():
        raise FileExistsError(f'Choose a NEW prototype directory: {args.output_dir}')
    root = Path(metadata['source']['simulationDirectory'])
    chosen = [metadata['frames'][i]['sourceFrame'] for i in np.rint(np.linspace(0, len(metadata['frames']) - 1, 16)).astype(int)]
    origin, dims = metadata['grid']['cropOrigin'], metadata['grid']['dimensions']
    crop = tuple(slice(o, o+d) for o, d in zip(origin, dims))
    def field(name, frame):
        with np.load(root / name / f'{name}_{frame}.npz') as data:
            value = data[data.files[0]]
        if tuple(value.shape[:3]) != tuple(metadata['grid']['sourceDimensions']) or not np.isfinite(value).all():
            raise ValueError(f'Invalid {name} at {frame}')
        return value[crop]
    table = native_linear_rgb_table()
    lower = np.zeros(3)
    upper = np.zeros(3)
    for frame in chosen:
        emission = bake(field('fuel', frame), table)
        lower = np.minimum(lower, emission.min(axis=(0,1,2)))
        upper = np.maximum(upper, emission.max(axis=(0,1,2)))
    # Signed quantization uses exactly representable zero (code 128). This
    # prevents tiny negative/positive emission bias in empty interpolated cells.
    scale = np.maximum(np.abs(lower), np.abs(upper)) / 127
    scale = np.maximum(scale, 1e-12)
    frame_bytes = int(np.prod(dims)) * 8
    args.output_dir.mkdir(parents=True)
    records, chunks, errors = [], [], []
    for chunk_index, start in enumerate(range(0, 16, 4)):
        payloads = []
        for i in range(start, start + 4):
            frame = chosen[i]
            fuel = field('fuel', frame)
            rgb = bake(fuel, table)
            smoke = field('color', frame)
            if smoke.shape != (*dims, 3):
                raise ValueError(f'Invalid color shape: {smoke.shape}')
            output = np.empty((*dims, 8), dtype=np.uint8)
            output[..., :3] = np.rint(rgb / scale + 128).clip(1,255).astype(np.uint8)
            output[..., 3] = (fuel > 0).astype(np.uint8) * 255
            output[..., 4:7] = np.rint(smoke.clip(0,1) * 255).astype(np.uint8)
            density = np.where(fuel > .6, 0, np.where(fuel > .001, 1, np.maximum(fuel,0)))
            output[..., 7] = np.rint(density * 255).clip(0,255).astype(np.uint8)
            errors.append(float(np.abs((output[..., :3].astype(float)-128)*scale-rgb).max()))
            payloads.append(output.tobytes())
            records.append(dict(playbackIndex=i, sourceFrame=frame, stage='established' if frame <= 69 else 'spread' if frame <= 141 else 'late', chunk=chunk_index, offset=(i-start)*frame_bytes))
        payload = b''.join(payloads)
        filename = f'frames_{chunk_index:03d}.bin'
        (args.output_dir / filename).write_bytes(payload)
        chunks.append(dict(index=chunk_index,file=filename,firstPlaybackIndex=start,frameCount=4,byteLength=len(payload),sha256=hashlib.sha256(payload).hexdigest()))
        print(f'Exported {start+4}/16', flush=True)
    metadata['schema'] = 'fierygs-fire-playback-v2'
    metadata['playback']['frameCount'] = 16
    # Preserve duration. Source indices are explicit; spacing differs by <=2 frames.
    metadata['playback']['fps'] = metadata['playback']['fps'] * 15 / (len(metadata['frames'])-1)
    metadata['frames'], metadata['chunks'] = records, chunks
    metadata['encoding'] = dict(layout='source-c-order-xyz-rgba-rgba', channels=['emissionR','emissionG','emissionB','extinction','smokeR','smokeG','smokeB','smokeDensity'],componentType='uint8-unorm',bytesPerVoxel=8,frameBytes=frame_bytes,quantization=dict(minimum=0,maximum=1), emissionScale=scale.tolist(), emissionZero=128, colorSpace='native-cat02-linear-srgb-signed', strengthBaked=True)
    metadata['source']['frameStep'] = 0
    metadata['prototype'] = dict(frameLimit=16,sourceMapping='explicit frames[].sourceFrame',nativePhong=False,carbonization=False,quantizationMaxAbsoluteError=max(errors), note='Emission interpolation approximates nonlinear native temperature sampling; extinction uses stable exponential integration. Final legacy gamma/clipping and smoke-path ACES retained.')
    (args.output_dir / 'metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    print(json.dumps(dict(output=str(args.output_dir),frames=chosen,frameBytes=frame_bytes,totalBytes=frame_bytes*16,emissionScale=scale.tolist(),maxError=max(errors)), indent=2))


if __name__ == '__main__':
    main()
