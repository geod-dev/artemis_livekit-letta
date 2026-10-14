"""Small, typed configuration shared by built-in device scopes."""
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ScopeSettings:
    firefox: str | None
    active_folder: Path
