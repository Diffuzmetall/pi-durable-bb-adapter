#!/usr/bin/env python3
"""Compatibility entrypoint for the corrected transitive input audit.
The original flat dependency list is superseded by lead-inputs-before/after.json.
"""
from pathlib import Path
import subprocess
import sys
script = Path(__file__).with_name('lead-audit-inputs.py')
raise SystemExit(subprocess.call([sys.executable, str(script), *(sys.argv[1:] or ['before'])]))
