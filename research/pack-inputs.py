"""Package only audited scene/solver inputs; excludes full simulation outputs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--data', type=Path, required=True)
p.add_argument('--solver', type=Path, default=ROOT / 'FieryGS')
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
names = {'3dgs_explicit.ply', 'labels.json', 'structure.json', 'occupancy.json', 'fire_roi.json', 'viewer_settings.json', 'semantic_bridge_all/objects_material_catalog.json'}
for config in (a.solver / 'adapter/fire_dataset/configs').glob('*_production.yaml'):
    for value in re.findall(r'D:/interiorgs_data/office_01/([^\s\x27\x22]+)', config.read_text()):
        if not value.endswith('sim_output'): names.add(value)
for path in (a.data / 'fierygs').glob('*.json'): names.add(path.relative_to(a.data).as_posix())
records = []
a.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(a.output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for name in sorted(names):
        path = a.data / name
        if not path.is_file() or path.is_symlink(): raise ValueError(f'Missing/invalid source {path}')
        payload = path.read_bytes()
        records.append({'path': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
        z.writestr(name, payload)
lock = {'schema': 1, 'bytes': a.output.stat().st_size, 'sha256': hashlib.sha256(a.output.read_bytes()).hexdigest(), 'files': records}
(ROOT / 'research/inputs.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(f'{a.output}: {lock["bytes"]} bytes, {len(records)} inputs')
