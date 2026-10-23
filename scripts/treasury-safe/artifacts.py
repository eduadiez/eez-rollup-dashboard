"""Download checksum-pinned Safe artifacts; never install packages or run their scripts."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent


def prepare_artifacts(directory):
    pins = json.loads((HERE/'artifacts.json').read_text())
    for name in ['contracts', 'factory']:
        pin = pins[name]
        archive = directory/(name+'.tgz')
        if not archive.exists():
            archive.write_bytes(urllib.request.urlopen(pin['url'], timeout=60).read())
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise RuntimeError(f'{name}: Safe artifact archive digest mismatch')
        target = directory/name
        target.mkdir(exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            tar.extractall(target, filter='data')
