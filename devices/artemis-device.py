#!/usr/bin/env python3
"""Backward-compatible launcher for :mod:`artemis_device`."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artemis_device.cli import main

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Disconnected.', flush=True)
