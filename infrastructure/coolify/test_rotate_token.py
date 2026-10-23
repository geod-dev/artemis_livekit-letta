"""Token rotation tests use an in-memory fake API response and console."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
from unittest import mock
import unittest

MODULE_PATH = Path(__file__).with_name('rotate_token.py')
SPEC = importlib.util.spec_from_file_location('rotate_token', MODULE_PATH)
rotate_token = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rotate_token)

RENEWED_MESSAGE = 'Local read/deploy token renewed for 90 days; previous tokens revoked.'


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class RotateTokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix='rotate-token-test-')
        self.addCleanup(shutil.rmtree, self.tmp_dir, ignore_errors=True)
        self.destination = Path(self.tmp_dir) / 'coolify-token'
        self.destination.write_text('old-token')
        self.config = {'token_file': str(self.destination), 'application_uuid': 'app-uuid'}
        self.commands = []
        # Any unmocked docker call (the real console) must fail the test, never run.
        real_run = mock.patch.object(rotate_token.subprocess, 'run',
                                     side_effect=AssertionError('real docker call during test'))
        real_run.start()
        self.addCleanup(real_run.stop)

    def rotate_quietly(self, open_url):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rotate_token.rotate(self.config, self.fake_console, open_url)
        return output.getvalue()

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
            self.rotate_quietly(reject)
        self.assertEqual(self.destination.read_text(), 'old-token')
        self.assertEqual(len(self.commands), 2)
        self.assertIn('where("id",42)', self.commands[1])
        self.assertNotIn('new-secret-token', self.commands[1])

    def test_valid_token_is_installed_then_previous_ids_are_revoked(self):
        def accept(request, timeout):
            return FakeResponse(json.dumps({'uuid': 'app-uuid'}).encode())

        output = self.rotate_quietly(accept)
        self.assertEqual(output.strip(), RENEWED_MESSAGE)
        self.assertEqual(self.destination.read_text(), 'new-secret-token')
        self.assertEqual(len(self.commands), 2)
        self.assertIn('whereIn("id",[7])', self.commands[1])
        if os.name != 'nt':
            self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
