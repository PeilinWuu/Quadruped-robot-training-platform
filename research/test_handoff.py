"""Portable installer and source-manifest checks; no GPU or real data needed."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class HandoffTests(unittest.TestCase):
    def test_source_manifest(self):
        lock = json.loads((ROOT / 'research/fierygs/source-lock.json').read_text())
        self.assertEqual(len(lock['upstreamBase']), 40)
        for record in lock['handoffFiles']:
            self.assertEqual(hashlib.sha256((ROOT / record['path']).read_bytes()).hexdigest(), record['sha256'])

    def test_input_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            research = root / 'research'
            research.mkdir()
            script = research / 'install-inputs.py'
            shutil.copyfile(ROOT / 'research/install-inputs.py', script)
            archive = root / 'input.zip'
            payload = b'research fixture'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('nested/input.bin', payload)
            raw = archive.read_bytes()
            lock = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'files': [{'path': 'nested/input.bin', 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}]}
            (research / 'inputs.lock.json').write_text(json.dumps(lock))
            destination = root / 'installed'
            def run():
                return subprocess.run([sys.executable, str(script), str(archive), '--destination', str(destination)], capture_output=True, text=True)
            self.assertEqual(run().returncode, 0)
            self.assertEqual((destination / 'nested/input.bin').read_bytes(), payload)
            self.assertNotEqual(run().returncode, 0)
            shutil.rmtree(destination)
            archive.write_bytes(b'corrupt')
            self.assertNotEqual(run().returncode, 0)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
