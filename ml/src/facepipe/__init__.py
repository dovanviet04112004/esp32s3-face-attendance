"""Training, quantization and export for the face attendance kiosk."""

from pathlib import Path

__version__ = "0.1.0"

ML_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ML_ROOT.parent
