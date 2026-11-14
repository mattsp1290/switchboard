from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import itertools
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run
import run_admission as admission
from test_cleanup import BUILD, FakeDocker, capture_transport
from test_raw_evidence import fixture


class FinalizationTests(unittest.TestCase):
    def read_final(self, out):
        result = json.loads((out / 'result.json').read_text())
        for field, name in [('commandsSha256', 'commands.json'), ('cleanupSha256', 'cleanup.json')]:
            expected = hashlib.sha256((out / name).read_bytes()).hexdigest()
            self.assertEqual(result[field], expected)
        return result, json.loads((out / 'cleanup.json').read_text())

    def test_current_callers_stop_before_cases_or_finalize_success(self):
        for raw, fault in itertools.product((False, True), (None, 'incomplete', 'nonzero', 'raw-record')):
            if fault == 'raw-record' and not raw:
                continue
            with self.subTest(raw=raw, fault=fault), tempfile.TemporaryDirectory() as directory:
                out = Path(directory) / 'evidence'
                external, calls, modes, waited, inventories = set(), [], {}, set(), set()
                image = False
                real_digest = run.digest
                init_hash = 'd286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1'

                def digest(path):
                    pins = {run.DOCKER: 'd79e988b423edbe34460a2e4d86ecc841997f16c5e2a2ee5263f679d0c483a84',
                            run.ZIG: '9fb480d3398506f5e2bef77f175766a8de0ee191dbdfbfb0c117a1150f141c91'}
                    return pins.get(str(path)) or (init_hash if Path(path).name.endswith('init') else real_digest(path))

                def transport(args, **kwargs):
                    nonlocal image
                    code, stdout, stderr = 0, '', ''
                    if args[0] == run.ZIG:
                        if args[1] == 'version':
                            stdout = '0.17.0\n'
                        else:
                            Path(args[-1]).write_bytes(b'inert binary, never executed')
                    else:
                        command, name = args[3], args[-1]
                        calls.append(args[3:])
                        if command == 'version':
                            components = [dict(Name=n, Version=v, Details={'GitCommit': c}) for n, v, c in
                                          [('runc', '1.3.4', 'v1.3.4-0-gd6d73eb8'), ('docker-init', '0.19.0', 'de40ad0')]]
                            stdout = json.dumps({'Client': {'Version': '29.5.2'}, 'Server': {
                                'Version': '29.2.1', 'GitCommit': '6bc6209', 'KernelVersion': '6.8.0-100-generic',
                                'Components': components}})
                        elif command == 'build':
                            image = True
                        elif command == 'image':
                            if args[4] == 'rm':
                                image = False
                            elif name == run.IMAGE:
                                stdout = json.dumps([{'Id': run.IMAGE.removeprefix('node@'),
                                                      'Architecture': 'arm64', 'Os': 'linux'}])
                            elif image:
                                stdout = '[{}]'
                            else:
                                code, stdout, stderr = 1, '[]', f'Error response from daemon: No such image: {name}'
                        elif command == 'create':
                            cid = args[args.index('--name') + 1]
                            external.add(cid)
                            modes[cid] = name
                        elif command == 'start':
                            self.assertIn(name, external)
                        elif command == 'exec':
                            if name == 'notice-tests':
                                stdout = ''.join(f'NOTICE_TEST {i} control-{chr(97+i//26)}{chr(97+i%26)} result=1\n' for i in range(165))
                                stdout += 'NOTICE_TESTS count=165 failed=0\n'
                                if fault == 'incomplete':
                                    stdout = stdout.replace('NOTICE_TEST 0 control-aa result=1\n', '')
                                if fault == 'nonzero':
                                    code, stderr = 90, 'complete failure diagnostic\n'
                            else:
                                stdout, stderr = b'inert init', b''
                        elif command == 'logs':
                            mode = modes[name]
                            if mode.startswith('raw-'):
                                stdout, stderr = '', 'REAPED 23 SUPERVISOR 7\n'
                                if name in waited:
                                    stderr, stdout = fixture(mode.removeprefix('raw-'))
                                    if fault == 'raw-record' and mode == 'raw-death':
                                        stderr = stderr.replace('RAW_INFO_BYTES ', 'RAW_INFO_BYTES broken', 1)
                                return subprocess.CompletedProcess(args, code, stdout, stderr)
                            stdout = 'allowed\n' if mode == 'normal' else ''
                            stderr = f'REAPED 23 SUPERVISOR 7\nNOTICE_RECEIPT root=23 ready={int(mode == "death")}\n' + {
                                'normal': 'PREREQUISITES_OBSERVED\n', 'inherited': 'REJECT_INHERITED_FD\n', 'death': ''}[mode]
                        elif command == 'inspect':
                            if name in external:
                                stdout = '[{"State":{"Running":true}}]'
                            else:
                                code, stdout, stderr = 1, '[]', f'error: no such object: {name}'
                        elif command == 'top':
                            self.assertNotIn(args[4], waited)
                            inventories.add(args[4])
                            stdout = 'PID PPID STAT COMMAND\n1 0 S docker-init\n7 1 S probe\n'
                        elif command == 'wait':
                            self.assertIn(name, inventories)
                            waited.add(name)
                            stdout = '0'
                        elif command == 'rm':
                            external.remove(name)
                        else:
                            self.fail(f'unexpected transport {args}')
                    return subprocess.CompletedProcess(args, code, stdout, stderr)

                with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag=None, stage='identities'), \
                        patch.object(run, 'digest', digest), patch.object(run, '_capture', capture_transport(transport)), \
                        patch.object(run.time, 'sleep'), patch.object(admission, 'inspect_binary') as inspect, \
                        redirect_stdout(io.StringIO()):
                    run.execute(raw=raw)
                result, report = self.read_final(out)
                if fault == 'raw-record':
                    self.assertEqual(result['status'], 'INCONCLUSIVE')
                    self.assertEqual(result['stage'], 'death')
                    self.assertNotIn('cases', result)
                    self.assertIn('RAW_INFO_BYTES broken', (out / 'raw-death.evidence').read_text())
                    self.assertEqual((out / 'raw-death.init').read_text(), fixture('death')[1])
                    self.assertFalse(external)
                    self.assertFalse(image)
                    self.assertEqual(report, {'containers': [], 'image': None, 'errors': []})
                    continue
                if fault:
                    self.assertEqual(result['status'], 'INCONCLUSIVE')
                    self.assertEqual(result['stage'], 'notice-controls')
                    self.assertNotIn('cases', result)
                    self.assertEqual([c[0] for c in calls].count('create'), 1)
                    self.assertFalse(image)
                    self.assertFalse(external)
                    self.assertEqual(report, {'containers': [], 'image': None, 'errors': []})
                    records = json.loads((out / 'commands.json').read_text())
                    failed = next(r for r in records if r['args'][-1] == 'notice-tests')
                    self.assertEqual(failed['code'], 90 if fault == 'nonzero' else 0)
                    self.assertEqual((out / 'notice-controls.stdout').read_text(), failed['stdout'])
                    self.assertEqual((out / 'notice-controls.stderr').read_text(), failed['stderr'])
                    self.assertTrue(failed['stdout'].endswith('NOTICE_TESTS count=165 failed=0\n'))
                    self.assertEqual(failed['stderr'], 'complete failure diagnostic\n' if fault == 'nonzero' else '')
                    continue
                self.assertEqual(result['noticeControlsSha256'], real_digest(out / 'notice-controls.json'))
                self.assertEqual(result['status'], 'SUPPORTED_SINGLE_TARGET_ADMISSION' if raw else 'INCONCLUSIVE')
                self.assertEqual([c['mode'] for c in result['cases']], list(admission.MODES) if raw else ['normal', 'inherited', 'death'])
                self.assertEqual(len(waited), 9 if raw else 3)
                if raw:
                    for mode in admission.MODES:
                        evidence, init = fixture(mode)
                        self.assertEqual((out / f'raw-{mode}.evidence').read_text(), evidence)
                        self.assertEqual((out / f'raw-{mode}.init').read_text(), init)
                self.assertEqual(inspect.call_count, int(raw))
                if not raw:
                    self.assertEqual(result['prerequisites'], 'observed')
                self.assertEqual(report, {'containers': [], 'image': None, 'errors': []})
                self.assertFalse(image)
                self.assertFalse(external)
                self.assertEqual(calls[-3][0:2], ['image', 'inspect'])
                self.assertEqual(calls[-2][0:2], ['image', 'rm'])
                self.assertEqual(calls[-1][0:2], ['image', 'inspect'])

    def test_all_nine_resource_faults_bind_failed_results_for_both_callers(self):
        faults = ('created', 'late', 'remove-timeout', 'daemon', 'unseen', 'verify-daemon',
                  'image-unseen', 'image-late', 'image-remove-timeout')
        for raw, failure in itertools.product((False, True), repeat=2):
            for fault in faults:
                with self.subTest(raw=raw, failure=failure, fault=fault), tempfile.TemporaryDirectory() as directory:
                    out = Path(directory) / 'evidence'
                    fake = FakeDocker(fault)
                    fake.image = fault != 'image-unseen' and fault != 'image-late'

                    def main(requested):
                        self.assertEqual(requested, raw)
                        try:
                            if fault.startswith('image-'):
                                exec(compile(BUILD, run.__file__, 'exec'), vars(run))
                            else:
                                run.create('raw-normal' if requested else 'normal')
                        except subprocess.TimeoutExpired:
                            if failure:
                                raise
                        run.save('result.json', {'status': 'SUPPORTED_SINGLE_TARGET_ADMISSION', 'cases': []})

                    with patch.multiple(run, OUT=out, commands=[], containers={}, images={} if fault.startswith('image-')
                                        else {'owned-image': 'confirmed'}, tag='owned-image', stage='fault'), \
                            patch.object(run, 'main', main), patch.object(run, '_capture', capture_transport(fake.run)), \
                            patch.object(run.time, 'sleep'), redirect_stdout(io.StringIO()):
                        run.execute(raw=raw)
                    result, report = self.read_final(out)
                    records = json.loads((out / 'commands.json').read_text())
                    unresolved = fault in ('daemon', 'unseen', 'verify-daemon', 'image-unseen')
                    self.assertEqual(result['status'], 'INCONCLUSIVE' if failure or unresolved else 'SUPPORTED_SINGLE_TARGET_ADMISSION')
                    self.assertEqual(result.get('stage'), 'fault' if failure else None)
                    self.assertEqual(result.get('cleanup'), 'unresolved ownership' if unresolved else None)
                    self.assertEqual(bool(report['errors']), unresolved)
                    self.assertEqual(bool(fake.external), fault == 'daemon')
                    self.assertEqual(fake.image, fault == 'daemon')
                    for stream in ('stdout', 'stderr'):
                        self.assertEqual((out / records[0]['partialFiles'][stream]).read_bytes(),
                                         b'partial-id\n' if stream == 'stdout' else b'partial-error\n')
                    self.assertEqual(sum(r.get('timedOut', False) for r in records), 2 if 'remove-timeout' in fault else 1)
                    self.assertLessEqual(len(fake.calls), 15)

    def test_cleanup_errors_alone_downgrade_success_and_bind_final_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'evidence'

            def main(raw):
                run.save('result.json', {'status': 'SUPPORTED_SINGLE_TARGET_ADMISSION', 'cases': [],
                                         'commandsSha256': 'stale', 'cleanupSha256': 'stale'})

            def remove(name, image=False):
                del run.containers[name]
                raise OSError('inert cleanup error after resource release')

            with patch.multiple(run, OUT=out, commands=[], containers={'synthetic': 'confirmed'}, images={}, tag=None), \
                    patch.object(run, 'main', main), patch.object(run, 'remove', remove), \
                    patch.object(run.subprocess, 'Popen', side_effect=AssertionError('unexpected transport')), redirect_stdout(io.StringIO()):
                run.execute(raw=True)
            result, report = self.read_final(out)
            self.assertEqual(result['status'], 'INCONCLUSIVE')
            self.assertEqual(result['cleanup'], 'unresolved ownership')
            self.assertEqual(report, {'containers': [], 'image': None,
                                      'errors': ['inert cleanup error after resource release']})
            self.assertEqual(json.loads((out / 'commands.json').read_text()), [])

    def test_failure_before_first_transport_still_binds_empty_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'evidence'
            with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag=None, stage='identities'), \
                    patch.object(run, 'main', side_effect=RuntimeError('inert identity failure')), \
                    patch.object(run.subprocess, 'Popen', side_effect=AssertionError('unexpected transport')), redirect_stdout(io.StringIO()):
                run.execute()
            result, report = self.read_final(out)
            self.assertEqual(result['status'], 'INCONCLUSIVE')
            self.assertEqual(result['stage'], 'identities')
            self.assertEqual(result['error'], 'inert identity failure')
            self.assertEqual(report, {'containers': [], 'image': None, 'errors': []})
            self.assertEqual(json.loads((out / 'commands.json').read_text()), [])

    def test_both_modules_import_without_transport_or_directory_creation(self):
        for source in (Path(run.__file__), Path(admission.__file__)):
            specification = importlib.util.spec_from_file_location('inert_import', source)
            with self.subTest(source=source.name), \
                    patch.object(subprocess, 'Popen', side_effect=AssertionError('transport during import')), \
                    patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir during import')):
                specification.loader.exec_module(importlib.util.module_from_spec(specification))


if __name__ == '__main__':
    unittest.main()
