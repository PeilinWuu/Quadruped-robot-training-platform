"""Verify an input archive before extracting into a new directory."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('archive', type=Path)
p.add_argument('--destination', type=Path, default=ROOT / 'data/research/office_01')
a = p.parse_args()
lock = json.loads((ROOT / 'research/inputs.lock.json').read_text())
if a.destination.exists(): p.error('Destination exists; choose a new directory to avoid overwriting experiments')
raw = a.archive.read_bytes()
if len(raw) != lock['bytes'] or hashlib.sha256(raw).hexdigest() != lock['sha256']: p.error('Archive does not match this Git revision')
with zipfile.ZipFile(a.archive) as z:
    if sorted(z.namelist()) != sorted(f['path'] for f in lock['files']): p.error('Unexpected archive entries')
    for entry in lock['files']:
        path = PurePosixPath(entry['path'])
        if path.is_absolute() or '..' in path.parts or '\\' in entry['path'] or ':' in entry['path']: p.error('Unsafe path')
        payload = z.read(entry['path'])
        if len(payload) != entry['bytes'] or hashlib.sha256(payload).hexdigest() != entry['sha256']: p.error('Entry hash mismatch')
    for entry in lock['files']:
        target = a.destination / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(z.read(entry['path']))
print(a.destination.resolve())
