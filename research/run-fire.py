"""Run an isolated solver smoke test from relocated office inputs (PyYAML required)."""
import argparse
from pathlib import Path
import subprocess
import sys
import yaml

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--solver', type=Path, default=ROOT / '.cache/research/FieryGS')
p.add_argument('--data', type=Path, required=True)
p.add_argument('--scenario', choices=[f'{obj}_{level}' for obj in ['table', 'sofa', 'curtain'] for level in ['low', 'medium', 'high']], default='table_high')
p.add_argument('--frames', type=int, default=1)
p.add_argument('--name', default='collaborator_smoke')
a = p.parse_args()
if a.frames < 1 or not a.name.replace('_', '').isalnum():
    p.error('Use positive frames and an alphanumeric/underscore name')
solver = a.solver.resolve()
output = solver / 'output' / a.name
if output.exists():
    p.error(f'Output already exists; choose a new --name: {output}')
prefix = 'D:/interiorgs_data/office_01/'
def relocate(value):
    if isinstance(value, dict): return {k: relocate(v) for k, v in value.items()}
    if isinstance(value, list): return [relocate(v) for v in value]
    if isinstance(value, str) and value.replace('\\', '/').startswith(prefix):
        return str(a.data.resolve() / value.replace('\\', '/')[len(prefix):])
    return value
config = relocate(yaml.safe_load((solver / f'adapter/fire_dataset/configs/{a.scenario}_production.yaml').read_text()))
config['scene'] = a.name
config['sim_frames'] = a.frames
for key in ['load_path', 'material_path', 'load_path_indices_pts_in_grids', 'load_path_mask_pts_in_grids']:
    if not Path(config[key]).is_file(): p.error(f'Missing {key}: {config[key]}')
mask = config.get('scenario_metadata', {}).get('exact_ignition_mask')
if mask and not Path(mask).is_file(): p.error(f'Missing ignition mask: {mask}')
output.mkdir(parents=True)
path = output / 'relocated-config.yaml'
path.write_text(yaml.safe_dump(config), encoding='utf-8')
subprocess.run([sys.executable, '-m', 'adapter.fire_scenario.run_scenario_solver', '--config-file', str(path), '--frames', str(a.frames), '--run-report', str(output / 'run-report.json')], cwd=solver, check=True)
print(f'Output: {output / "sim_output"}')
