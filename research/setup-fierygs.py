"""Restore the audited solver without changing an existing FieryGS checkout."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = 'f70fbe2'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', default='https://github.com/PKU-VCL-Geometry/FieryGS.git', help='Git URL or local checkout for offline installation')
parser.add_argument('--destination', type=Path, default=ROOT / '.cache/research/FieryGS')
args = parser.parse_args()
target = args.destination.resolve()
if target.exists():
    raise SystemExit(f'Refusing to overwrite existing directory: {target}')
def run(*cmd):
    subprocess.run(cmd, check=True)
manifest = json.loads((ROOT / 'research/fierygs/source-lock.json').read_text())
for entry in manifest['handoffFiles']:
    if hashlib.sha256((ROOT / entry['path']).read_bytes()).hexdigest() != entry['sha256']:
        raise SystemExit(f"Handoff file mismatch: {entry['path']}")
run('git', '-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', args.source, str(target))
run('git', '-C', str(target), 'config', 'core.autocrlf', 'false')
run('git', '-C', str(target), 'checkout', '--detach', manifest['upstreamBase'])
patch = str(ROOT / 'research/fierygs/local-production.patch')
run('git', '-C', str(target), 'apply', '--check', patch)
run('git', '-C', str(target), 'apply', patch)
overlay = ROOT / 'research/fierygs/overlay'
for file in overlay.rglob('*'):
    if file.is_file():
        dest = target / file.relative_to(overlay)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)
print(f'Restored working source: {target}\nLocal adaptations are intentionally visible as uncommitted changes. Do not discard them.')
