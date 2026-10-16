#!/usr/bin/env python3
"""Pure entrypoint checks. Never executes bwrap, Node, BB, or a namespace."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / 'launcher.py'


class Plans(unittest.TestCase):
    def call(self, *args, payload=None):
        with tempfile.TemporaryDirectory(prefix='unit-', dir=HERE) as home:
            result = subprocess.run(
                [sys.executable, '-I', '-B', str(LAUNCHER), *args],
                input=None if payload is None else json.dumps(payload),
                text=True, capture_output=True, close_fds=True,
                env={'HOME': home, 'TMPDIR': home, 'PATH': '/usr/bin:/bin',
                     'LANG': 'C.UTF-8'}, cwd=home)
            return result

    def plan(self):
        result = self.call('plan', '--fixture-id', 'source-v1')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_valid_plan_and_determinism(self):
        p = self.plan()
        self.assertEqual(p, self.plan())
        self.assertEqual(p['ports'], {'server': 40886, 'daemon': 40887})
        self.assertEqual(p['network'], 'host-shared-NOT-network-isolation')
        self.assertTrue(p['dataDir'].endswith('/fs-private.source-v1/bb-data'))
        self.assertEqual(p['runtimeCapability'], 'UNAVAILABLE')
        self.assertEqual(self.call('validate', payload=p).returncode, 0)
        self.assertNotIn('--unshare-net', p['argv'])
        self.assertIn('--clearenv', p['argv'])
        self.assertIn('--unshare-pid', p['argv'])
        self.assertEqual(p['spawn']['close_fds'], True)
        self.assertEqual(p['spawn']['stdin'], 'DEVNULL')
        self.assertNotIn('LD_PRELOAD', p['spawn']['env'])
        self.assertFalse(p['futureTransport']['ownerDatabaseMounted'])

    def test_refuse_tampering(self):
        p = self.plan()
        mutations = [
            ('foreign root', lambda x: x.update(root='/home/ubuntu/.pi')),
            ('old data', lambda x: x.update(dataDir=str(HERE.parents[2] / '.test-bb'))),
            ('alternate ports', lambda x: x['ports'].update(server=40999)),
            ('wrong numeric type', lambda x: x['ports'].update(server=40886.0)),
            ('boolean schema', lambda x: x.update(schemaVersion=True)),
            ('host env', lambda x: x['spawn']['env'].update(LD_PRELOAD='/evil')),
            ('root bind', lambda x: x['argv'].extend(['--ro-bind', '/', '/'])),
            ('home bind', lambda x: x['mounts'].append({'source':'/home','destination':'/home','mode':'ro'})),
            ('native sqlite', lambda x: x['mounts'].append({'source':x['futureTransport']['C'],'destination':x['futureTransport']['C'],'mode':'rw'})),
            ('network change', lambda x: x['argv'].insert(1, '--unshare-net')),
            ('pid escape', lambda x: x['argv'].remove('--unshare-pid')),
            ('extra fd', lambda x: x['spawn'].update(pass_fds=[7])),
            ('fake pass', lambda x: x.update(runtimeCapability='PASS')),
        ]
        for label, change in mutations:
            with self.subTest(label=label):
                bad = copy.deepcopy(p)
                change(bad)
                r = self.call('validate', payload=bad)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_refuse_bad_ids_and_launch(self):
        for name in ['../old', '/tmp/foreign', 'Upper', 'x' * 33, '', 'a/../b']:
            with self.subTest(name=name):
                self.assertEqual(self.call('plan', '--fixture-id', name).returncode, 2)
        result = self.call('launch', '--fixture-id', 'source-v1')
        self.assertEqual(result.returncode, 2)
        self.assertIn('runtime GO unavailable', result.stderr)

    def test_pre_execution_refusal_gates(self):
        acknowledgements = ['--runtime-go', '--stage1-accepted', '--old-owned-instance-retired']
        for n in range(1, 4):
            with self.subTest(acknowledgements=n):
                result = self.call('launch', *acknowledgements[:n])
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        result = self.call('launch', *acknowledgements, '--reviewed-plan-sha256', '0' * 64)
        self.assertEqual(result.returncode, 2)
        self.assertIn('reviewed plan SHA256', result.stderr)
        self.assertEqual(self.call('plan', '--runtime-go').returncode, 2)

    def test_symlink_missing_and_overlapping_mount_refusal(self):
        p = self.plan()
        with tempfile.TemporaryDirectory(prefix='links-', dir=HERE) as h:
            link = Path(h) / 'private-donor-link'
            link.symlink_to('/home/ubuntu/.pi')
            for source in [str(link), str(Path(h) / 'missing'), p['root'], '/proc', '/run', '/tmp']:
                with self.subTest(source=source):
                    bad = copy.deepcopy(p)
                    bad['mounts'][0]['source'] = source
                    self.assertEqual(self.call('validate', payload=bad).returncode, 2)

    def test_bad_json_and_unknown_fields(self):
        self.assertEqual(self.call('validate', payload=[]).returncode, 2)
        p = self.plan()
        p['arbitraryShell'] = '/bin/evil'
        self.assertEqual(self.call('validate', payload=p).returncode, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
