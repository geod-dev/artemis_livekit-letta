"""Fake Coolify API checks for deployment revision state handling."""
import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).with_name('poll-deploy.py')
SPEC = importlib.util.spec_from_file_location('poll_deploy', MODULE_PATH)
poll_deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(poll_deploy)

REQUESTED = 'a' * 40
ACTUAL = 'b' * 40
APP = 'app-uuid'


class FakeCoolify:
    def __init__(self, deployment=None, history=None, queued=None):
        self.deployment = deployment or {}
        self.history = history or {'deployments': []}
        self.queued = queued or {'deployments': [
            {'resource_uuid': APP, 'deployment_uuid': 'deployment-uuid'}
        ]}
        self.calls = []

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path == '/deployments/deployment-uuid':
            return self.deployment
        if path.startswith('/deployments/applications/'):
            return self.history
        if path == '/deploy':
            return self.queued
        raise AssertionError(f'Unexpected fake API request: {method} {path}')


class PollDeployTests(unittest.TestCase):
    def test_queues_latest_commit_and_records_requested_revision(self):
        api = FakeCoolify()
        state = poll_deploy.poll({}, REQUESTED, APP, api)
        self.assertEqual(state['pending'], {'uuid': 'deployment-uuid', 'commit': REQUESTED})
        self.assertEqual(api.calls[-1], ('POST', '/deploy', {'uuid': APP, 'force': False}))

    def test_only_exact_reported_revision_is_success(self):
        state = {'pending': {'uuid': 'deployment-uuid', 'commit': REQUESTED}}
        api = FakeCoolify(deployment={'status': 'finished', 'commit': REQUESTED})
        result = poll_deploy.poll(state, REQUESTED, APP, api)
        self.assertEqual(result['deployed'], REQUESTED)
        self.assertNotIn('pending', result)
        self.assertNotIn('failed', result)

    def test_missing_or_mismatched_revision_is_held_as_failed(self):
        for deployment in ({'status': 'finished'}, {'status': 'finished', 'commit': ACTUAL}):
            state = {'pending': {'uuid': 'deployment-uuid', 'commit': REQUESTED}}
            api = FakeCoolify(deployment=deployment)
            result = poll_deploy.poll(state, REQUESTED, APP, api)
            self.assertNotIn('deployed', result)
            self.assertEqual(result['failed'], REQUESTED)
            self.assertEqual(len(api.calls), 1)

    def test_failed_revision_does_not_retry_until_branch_moves(self):
        api = FakeCoolify()
        result = poll_deploy.poll({'failed': REQUESTED}, REQUESTED, APP, api)
        self.assertEqual(result, {'failed': REQUESTED})
        self.assertEqual(api.calls, [])

    def test_active_pending_deployment_is_left_untouched(self):
        pending = {'uuid': 'deployment-uuid', 'commit': REQUESTED}
        state = {'pending': pending}
        api = FakeCoolify(deployment={'status': 'running'})
        result = poll_deploy.poll(state, ACTUAL, APP, api)
        self.assertEqual(result['pending'], pending)
        self.assertEqual(len(api.calls), 1)


if __name__ == '__main__':
    unittest.main()
