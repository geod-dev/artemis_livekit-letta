"""Filesystem access constrained to explicitly configured roots."""
import json
import os
from pathlib import Path

MAX_FILE_BYTES = 1_000_000

def make_rooted_access(root_paths):
    roots = [Path(path).expanduser().resolve() for path in (root_paths or [Path.cwd()])]
    def resolve(user_path):
        if not isinstance(user_path, str) or '\x00' in user_path: raise ValueError('Path must be a valid string')
        candidate = Path(user_path).expanduser()
        for root in roots:
            resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
            try:
                if os.path.commonpath((str(root), str(resolved))) == str(root): return resolved
            except ValueError: pass
        raise ValueError('Path is outside the configured filesystem roots')
    return roots, resolve

def register(args):
    roots, resolve = make_rooted_access(args.filesystem_root)
    def list_directory(arguments):
        path = resolve(arguments.get('path', '.'))
        if not path.is_dir(): raise ValueError('Path is not a directory')
        entries = []
        for item in sorted(path.iterdir(), key=lambda entry: (not entry.is_dir(), entry.name.casefold()))[:500]:
            if item.is_symlink():
                entries.append({'name': item.name, 'type': 'symlink', 'size': None})
                continue
            info = item.stat()
            entries.append({'name': item.name, 'type': 'directory' if item.is_dir() else 'file', 'size': info.st_size})
        return {'content': [{'type': 'text', 'text': json.dumps({'path': str(path), 'entries': entries})}]}
    def read_file(arguments):
        path = resolve(arguments.get('path'))
        if not path.is_file(): raise ValueError('Path is not a file')
        if path.stat().st_size > MAX_FILE_BYTES: raise ValueError('File exceeds the 1 MB read limit')
        try: content = path.read_text(encoding='utf-8')
        except UnicodeDecodeError as error: raise ValueError('Only UTF-8 text files can be read') from error
        return {'content': [{'type': 'text', 'text': content}]}
    def write_file(arguments):
        path = resolve(arguments.get('path'))
        content = arguments.get('content')
        if not isinstance(content, str): raise ValueError('Content must be a string')
        encoded = content.encode('utf-8')
        if len(encoded) > MAX_FILE_BYTES: raise ValueError('File exceeds the 1 MB write limit')
        if path.exists() and not path.is_file(): raise ValueError('Path is not a regular file')
        if not path.parent.is_dir(): raise ValueError('Parent directory must already exist')
        path.write_bytes(encoded)
        return {'content': [{'type': 'text', 'text': f'Wrote {len(encoded)} bytes to {path.name}.'}]}
    common = {'type': 'object', 'additionalProperties': False}
    tools = [
      {'name': 'filesystem_list', 'description': 'List files and directories under an allowed root.', 'inputSchema': {**common, 'properties': {'path': {'type': 'string', 'description': 'Directory path, relative to a configured root'}}}, 'annotations': {'readOnlyHint': True}},
      {'name': 'filesystem_read', 'description': 'Read a UTF-8 text file up to 1 MB under an allowed root.', 'inputSchema': {**common, 'properties': {'path': {'type': 'string'}}, 'required': ['path']}, 'annotations': {'readOnlyHint': True}},
      {'name': 'filesystem_write', 'description': 'Write a UTF-8 text file up to 1 MB under an allowed root; parent directory must exist.', 'inputSchema': {**common, 'properties': {'path': {'type': 'string'}, 'content': {'type': 'string'}}, 'required': ['path', 'content']}, 'annotations': {'readOnlyHint': False}},
    ]
    return tools, {'filesystem_list': list_directory, 'filesystem_read': read_file, 'filesystem_write': write_file}
