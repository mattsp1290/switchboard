import ast
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name('run.py')
TREE = ast.parse(SOURCE.read_text())
DEFINITIONS = ast.Module([n for n in TREE.body if isinstance(n, (
    ast.Import, ast.ImportFrom, ast.Assign, ast.FunctionDef))], type_ignores=[])
FINALIZER = ast.Module(next(n.finalbody for n in TREE.body if isinstance(n, ast.Try)), type_ignores=[])


class FakeDocker:
    def __init__(self, fault):
        self.fault, self.external, self.calls = fault, set(), []
        self.inspections = 0
        self.image = True

    def run(self, args, **kwargs):
        self.calls.append(args[3:])
        command, name = args[3], args[-1]
        code, stdout, stderr = 0, '', ''
        if command == 'create':
            self.name = args[args.index('--name') + 1] if '--name' in args else 'unnamed'
            if self.fault not in ('late', 'unseen'):
                self.external.add(self.name)
            raise subprocess.TimeoutExpired(args, kwargs['timeout'], b'partial-id\n', b'partial-error\n')
        if command == 'inspect':
            self.inspections += 1
            if self.fault == 'late' and self.inspections == 2:
                self.external.add(self.name)
            if self.fault == 'daemon' or (self.fault == 'verify-daemon' and self.inspections > 1):
                code, stdout, stderr = 1, '[]\n', 'daemon unavailable\n'
            elif name in self.external:
                stdout = '[{"Id":"fake"}]\n'
            else:
                code, stdout, stderr = 1, '[]\n', f'error: no such object: {name}\n'
        elif command == 'rm':
            if self.fault == 'daemon':
                code, stderr = 1, 'daemon unavailable\n'
            elif name in self.external:
                self.external.remove(name)
                if self.fault == 'remove-timeout':
                    raise subprocess.TimeoutExpired(args, kwargs['timeout'], b'', b'lost removal reply\n')
            else:
                code, stderr = 1, f'Error response from daemon: No such container: {name}\n'
        elif command == 'image':
            if args[4] == 'rm' and not self.external:
                self.image = False
            if self.image:
                code, stderr = 1, 'image still in use\n'
            elif args[4] == 'inspect':
                code, stdout, stderr = 1, '[]\n', f'Error response from daemon: No such image: {name}\n'
        else:
            raise AssertionError(f'Unexpected fake command: {args}')
        return subprocess.CompletedProcess(args, code, stdout, stderr)


class CleanupTests(unittest.TestCase):
    def exercise(self, fault):
        ns = {'__file__': str(SOURCE)}
        exec(compile(DEFINITIONS, str(SOURCE), 'exec'), ns)
        fake = FakeDocker(fault)
        with tempfile.TemporaryDirectory() as directory:
            ns['OUT'], ns['tag'] = Path(directory), 'owned-image'
            ns['save']('result.json', {'status': 'INCONCLUSIVE'})
            with patch.object(subprocess, 'run', fake.run), patch.object(ns['time'], 'sleep'), redirect_stdout(io.StringIO()):
                with self.assertRaises(subprocess.TimeoutExpired):
                    ns['create']('normal')
                exec(compile(FINALIZER, str(SOURCE), 'exec'), ns)
            records = json.loads((ns['OUT'] / 'commands.json').read_text()) if (ns['OUT'] / 'commands.json').exists() else []
            report = json.loads((ns['OUT'] / 'cleanup.json').read_text()) if (ns['OUT'] / 'cleanup.json').exists() else {}
            if records and records[0].get('timedOut'):
                for stream, expected in [('stdout', b'partial-id\n'), ('stderr', b'partial-error\n')]:
                    self.assertEqual((ns['OUT'] / records[0]['partialFiles'][stream]).read_bytes(), expected)
        self.assertTrue(any(call[:2] == ['image', 'rm'] for call in fake.calls), 'image cleanup was skipped')
        return fake, records, report, ns['containers']

    def test_create_side_effect_before_timeout_is_removed_and_recorded(self):
        for fault in ('created', 'late', 'remove-timeout'):
            with self.subTest(fault=fault):
                fake, records, report, owned = self.exercise(fault)
                self.assertFalse(fake.external, 'container leaked after uncertain create')
                self.assertFalse(fake.image)
                self.assertFalse(owned)
                record = records[0]
                self.assertIn('--name', record['args'])
                self.assertEqual(record['stdout'], 'partial-id\n')
                self.assertEqual(record['stderr'], 'partial-error\n')
                self.assertTrue(record['timedOut'])
                self.assertEqual(report['containers'], [])
                self.assertFalse(report['image'])

    def test_unknown_or_unreachable_creation_retains_reported_ownership(self):
        for fault in ('daemon', 'unseen', 'verify-daemon'):
            with self.subTest(fault=fault):
                fake, records, report, owned = self.exercise(fault)
                self.assertTrue(owned, 'uncertain ownership was discarded')
                self.assertEqual(report['containers'], list(owned))
                self.assertEqual(report['image'], 'owned-image' if fake.image else None)
                self.assertLessEqual(len(fake.calls), 12, 'cleanup was not bounded')


if __name__ == '__main__':
    unittest.main()
