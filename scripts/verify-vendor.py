"""Verify vendored files against the recorded upstream manifest."""
from pathlib import Path
import hashlib
import json

vendor = Path(__file__).resolve().parents[1] / 'web/vendor'
manifest = json.loads((vendor / 'manifest.json').read_text())
for name, expected in manifest.items():
    data = (vendor / name).read_bytes()
    if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
        raise SystemExit(f'Vendor checksum mismatch: {name}')
print(f'Verified {len(manifest)} vendored files.')
