#!/usr/bin/env python3
"""Expose the existing native relay's owned barrier directory to the invoice fixture.

The original, pinned relay is copied next to this wrapper by the integration
runner. Its execution and proof/DA handling are unchanged. This wrapper only
records the path that testkit supplied; no process discovery or shared paths.
"""
import json
import os
from pathlib import Path
import runpy
import sys

if __name__ == '__main__':
    directory = Path(os.environ['TREASURY_EVIDENCE_DIR'])
    control = Path(sys.argv[sys.argv.index('--test-control-dir') + 1]).resolve()
    (directory / 'relay-control.json').write_text(json.dumps({'directory': str(control)}))
    runpy.run_path(str(Path(__file__).with_name('builder-stub-core.py')), run_name='__main__')
