"""Export 16-frame V1 sofa/curtain playback from existing production simulations.

No physics or visual-profile changes. Each scenario retains its own world bounds.
"""
import argparse
import copy
import json
from pathlib import Path
import numpy as np
from export_fire_playback import load_field, union_active_bounds, quantize_pair, sha256, stage_for


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('D:/interiorgs_data/office_01'))
    parser.add_argument('--output-root', type=Path, default=Path('D:/interiorgs_data/office_01/fire_playback_room'))
    args = parser.parse_args()
    template = json.loads((args.root / 'fire_playback/table_high/metadata.json').read_text())
    indices = np.rint(np.linspace(0, len(template['frames'])-1, 16)).astype(int)
    selected = [template['frames'][i]['sourceFrame'] for i in indices]
    if args.output_root.exists():
        raise FileExistsError(f'Choose a new output root: {args.output_root}')
    for scenario in ('sofa_high', 'curtain_high'):
        root = args.root / 'production_regression' / scenario / 'sim_output'
        lower, upper, shape = union_active_bounds(root, selected, 1e-5, 2)
        dims = (upper-lower).tolist()
        crop = tuple(slice(int(lo),int(hi)) for lo,hi in zip(lower,upper))
        size = int(np.prod(dims))*2
        output = args.output_root / scenario
        output.mkdir(parents=True)
        m = copy.deepcopy(template)
        m['scenarioId'] = scenario
        m['playback'].update(frameCount=16, fps=8*15/71)
        m['grid'].update(sourceDimensions=list(shape),cropOrigin=lower.tolist(),dimensions=dims,
            worldLower=(np.array(m['grid']['sourceLower'])+lower*.05).tolist(),
            worldUpper=(np.array(m['grid']['sourceLower'])+upper*.05).tolist())
        m['encoding']['frameBytes'] = size
        m['frames'],m['chunks'] = [],[]
        for chunk,start in enumerate(range(0,16,4)):
            file = f'frames_{chunk:03d}.bin'
            with (output/file).open('wb') as stream:
                for local,frame in enumerate(selected[start:start+4]):
                    stream.write(quantize_pair(load_field(root,'fuel',frame)[crop],load_field(root,'temperature',frame)[crop]).tobytes())
                    m['frames'].append(dict(playbackIndex=start+local,sourceFrame=frame,stage=stage_for(frame),chunk=chunk,offset=local*size))
            m['chunks'].append(dict(index=chunk,file=file,firstPlaybackIndex=start,frameCount=4,byteLength=4*size,sha256=sha256(output/file)))
        m['source'].update(simulationDirectory=str(root),frameStep=0)
        m['prototype'] = {'description':'Independent existing scenario, superposed for room visualization; not a coupled multi-source simulation','selectedFrames':selected}
        (output/'metadata.json').write_text(json.dumps(m,indent=2),encoding='utf-8')
        print(json.dumps(dict(scenario=scenario,dimensions=dims,lower=m['grid']['worldLower'],upper=m['grid']['worldUpper'],bytes=16*size)),flush=True)


if __name__ == '__main__':
    main()
