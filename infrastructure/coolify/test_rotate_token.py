"""Token rotation tests use an in-memory fake API response and console."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name('rotate-token.py')
SPEC = importlib.util.spec_from_file_location('rotate_token', MODULE_PATH)
rotate_token = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rotate_token)


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class RotateTokenTests(unittest.TestCase):
    def setUp(self):
        tmp_root = Path(__file__).resolve().parents[2] / '.codex-tmp' / 'coolify-tests'
        tmp_root.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=tmp_root)
        self.destination = Path(self.tmp.name) / 'coolify-token'
        self.destination.write_text('old-token')
        self.config = {'token_file': str(self.destination), 'application_uuid': 'app-uuid'}
        self.commands = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake_console(self, code):
        self.commands.append(code)
        if len(self.commands) == 1:
            return {'token': 'new-secret-token', 'id': 42, 'previous': [7]}
        return {'revoked': 1}

    def test_validation_failure_revokes_new_token_and_keeps_old_file(self):
        def reject(request, timeout):
            self.assertEqual(request.get_header('Authorization'), 'Bearer new-secret-token')
            raise OSError('fake validation failure')

        with self.assertRaises(OSError):
            rotate_token.rotate(self.config, self.fake_console, reject)
        self.assertEqual(self.destination.read_text(), 'old-token')
        self.assertEqual(len(self.commands), 2)
        self.assertIn('where("id",42)', self.commands[1])
        self.assertNotIn('new-secret-token', self.commands[1])

    def test_valid_token_is_installed_then_previous_ids_are_revoked(self):
        def accept(request, timeout):
            return FakeResponse(json.dumps({'uuid': 'app-uuid'}).encode())

        rotate_token.rotate(self.config, self.fake_console, accept)
        self.assertEqual(self.destination.read_text(), 'new-secret-token')
        self.assertEqual(len(self.commands), 2)
        self.assertIn('whereIn("id",[7])', self.commands[1])
        if os.name != 'nt':
            self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
