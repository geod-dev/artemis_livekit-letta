"""Filesystem access using absolute paths across the device's filesystem."""
import json
from pathlib import Path

MAX_FILE_BYTES = 1_000_000


def register(args):
    active_folder = Path(args.active_folder).resolve()

    def resolve(user_path):
        if not isinstance(user_path, str) or '\x00' in user_path:
            raise ValueError('Path must be a valid absolute path')
        candidate = Path(user_path).expanduser()
        if not candidate.is_absolute():
            raise ValueError('Filesystem paths must be absolute')
        return candidate.resolve()

    def list_directory(arguments):
        path = resolve(arguments.get('path'))
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

    context = f'Active folder: {active_folder}. Use absolute paths; other locations on this PC are accessible too.'
    common = {'type': 'object', 'additionalProperties': False}
    tools = [
      {'name': 'filesystem_list', 'description': f'List a directory. {context}', 'inputSchema': {**common, 'properties': {'path': {'type': 'string', 'description': 'Absolute directory path'}}, 'required': ['path']}, 'annotations': {'readOnlyHint': True}},
      {'name': 'filesystem_read', 'description': f'Read a UTF-8 text file up to 1 MB. {context}', 'inputSchema': {**common, 'properties': {'path': {'type': 'string', 'description': 'Absolute file path'}}, 'required': ['path']}, 'annotations': {'readOnlyHint': True}},
      {'name': 'filesystem_write', 'description': f'Write a UTF-8 text file up to 1 MB; parent directory must exist. {context}', 'inputSchema': {**common, 'properties': {'path': {'type': 'string', 'description': 'Absolute file path'}, 'content': {'type': 'string'}}, 'required': ['path', 'content']}, 'annotations': {'readOnlyHint': False}},
    ]
    return tools, {'filesystem_list': list_directory, 'filesystem_read': read_file, 'filesystem_write': write_file}
