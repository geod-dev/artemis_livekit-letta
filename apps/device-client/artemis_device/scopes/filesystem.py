"""Filesystem access using absolute paths across the device's filesystem."""

import json
from itertools import islice
from pathlib import Path

from .settings import ScopeSettings

MAX_FILE_BYTES = 1_000_000
MAX_EXPORT_BYTES = 25 * 1024 * 1024
MAX_LIST_ENTRIES = 500


def _sort_key(entry):
    try:
        return (not entry.is_dir(), entry.name.casefold())
    except OSError:
        return (True, entry.name.casefold())


def register(args: ScopeSettings):
    active_folder = Path(args.active_folder).resolve()

    def resolve(user_path):
        if not isinstance(user_path, str) or "\x00" in user_path:
            raise ValueError("Path must be a valid absolute path")
        candidate = Path(user_path).expanduser()
        if not candidate.is_absolute():
            raise ValueError("Filesystem paths must be absolute")
        return candidate.resolve()

    def list_directory(arguments):
        path = resolve(arguments.get("path"))
        if not path.is_dir():
            raise ValueError("Path is not a directory")
        # Stop iterating at the cap, so a huge directory is never fully read into memory.
        collected = list(islice(path.iterdir(), MAX_LIST_ENTRIES + 1))
        truncated = len(collected) > MAX_LIST_ENTRIES
        entries = []
        for item in sorted(collected[:MAX_LIST_ENTRIES], key=_sort_key):
            try:
                if item.is_symlink():
                    entries.append({"name": item.name, "type": "symlink", "size": None})
                    continue
                is_directory = item.is_dir()
                size = item.stat().st_size
            except OSError:
                # One unreadable entry must not fail the whole listing.
                entries.append({"name": item.name, "type": "unknown", "size": None})
                continue
            entries.append(
                {
                    "name": item.name,
                    "type": "directory" if is_directory else "file",
                    "size": size,
                }
            )
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {"path": str(path), "entries": entries, "truncated": truncated}
                    ),
                }
            ]
        }

    def read_file(arguments):
        path = resolve(arguments.get("path"))
        if not path.is_file():
            raise ValueError("Path is not a file")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 1 MB read limit")
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Only UTF-8 text files can be read") from error
        return {"content": [{"type": "text", "text": content}]}

    def write_file(arguments):
        path = resolve(arguments.get("path"))
        content = arguments.get("content")
        if not isinstance(content, str):
            raise ValueError("Content must be a string")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 1 MB write limit")
        if path.exists() and not path.is_file():
            raise ValueError("Path is not a regular file")
        if not path.parent.is_dir():
            raise ValueError("Parent directory must already exist")
        path.write_bytes(encoded)
        return {
            "content": [{"type": "text", "text": f"Wrote {len(encoded)} bytes to {path.name}."}]
        }

    def export_file(arguments, upload=None):
        path = resolve(arguments.get("path"))
        if not path.is_file():
            raise ValueError("Path is not a file")
        if path.stat().st_size > MAX_EXPORT_BYTES:
            raise ValueError("File exceeds the 25 MB export limit")
        if upload is None:
            raise ValueError("File transfer connection is unavailable")
        metadata = upload(path)
        return {"content": [{"type": "text", "text": json.dumps(metadata)}]}

    context = f"Active folder: {active_folder}. Use absolute paths; other locations on this PC are accessible too."
    common = {"type": "object", "additionalProperties": False}
    tools = [
        {
            "name": "filesystem_export",
            "description": f"Copy any file (PDF, image, Office document, etc.) up to 25 MB from this PC into the agent workspace. Returns only the saved path, size, checksum and downloadable link; file contents never enter the model context. Use this to share an existing local file in chat without reading it. {context}",
            "inputSchema": {
                **common,
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path of the local file to copy",
                    }
                },
                "required": ["path"],
            },
            "annotations": {"readOnlyHint": False},
        },
        {
            "name": "filesystem_list",
            "description": f"List a directory. {context}",
            "inputSchema": {
                **common,
                "properties": {
                    "path": {"type": "string", "description": "Absolute directory path"}
                },
                "required": ["path"],
            },
            "annotations": {"readOnlyHint": True},
        },
        {
            "name": "filesystem_read",
            "description": f"Read a UTF-8 text file up to 1 MB. {context}",
            "inputSchema": {
                **common,
                "properties": {"path": {"type": "string", "description": "Absolute file path"}},
                "required": ["path"],
            },
            "annotations": {"readOnlyHint": True},
        },
        {
            "name": "filesystem_write",
            "description": f"Write a UTF-8 text file up to 1 MB; parent directory must exist. {context}",
            "inputSchema": {
                **common,
                "properties": {
                    "path": {"type": "string", "description": "Absolute file path"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            "annotations": {"readOnlyHint": False},
        },
    ]
    return tools, {
        "filesystem_export": export_file,
        "filesystem_list": list_directory,
        "filesystem_read": read_file,
        "filesystem_write": write_file,
    }
