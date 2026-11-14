from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run
import run_admission as admission
from test_admission import AdmissionTests


class NoticeTests(unittest.TestCase):
    def evidence(self):
        rows = [f'NOTICE_TEST {i} control-{chr(97+i//26)}{chr(97+i%26)} result=1\n' for i in range(165)]
        return ''.join(rows) + 'NOTICE_TESTS count=165 failed=0\n'

    def test_actual_control_collector_requires_complete_success_and_binding(self):
        good = self.evidence()
        variants = [('', ''), (good, 'unexpected'), (good.replace('result=1', 'result=0', 1), ''),
                    (good.replace('NOTICE_TEST 0 ', 'NOTICE_TEST 1 ', 1), ''),
                    (good.replace('count=165', 'count=164'), ''), (good + 'extra\n', '')]
        for line in good.splitlines(keepends=True):
            variants.extend(((good.replace(line, '', 1), ''), (good + line, ''),
                             (good.replace(line, line[:-2] + '\n', 1), '')))
        with tempfile.TemporaryDirectory() as directory, patch.object(run, 'OUT', Path(directory)):
            for name, data in [('hashes.json', b'{}'), ('prerequisite', b'unexecuted synthetic binary')]:
                (run.OUT / name).write_bytes(data)
            hashes = {p.name: run.digest(p) for p in run.HERE.iterdir() if p.suffix in ('.c', '.py', '.json', '.md')}
            hashes['prerequisite'] = run.digest(run.OUT / 'prerequisite')
            (run.OUT / 'hashes.json').write_text(json.dumps(hashes))
            with patch.object(run, 'docker', return_value=subprocess.CompletedProcess([], 0, good, '')):
                run.verify_notices('synthetic')
            report = json.loads((run.OUT / 'notice-controls.json').read_text())
            self.assertEqual(report['controlIds'], list(range(165)))
            for key, name in [('stdoutSha256', 'notice-controls.stdout'), ('stderrSha256', 'notice-controls.stderr'),
                              ('sourceInventorySha256', 'hashes.json'), ('binarySha256', 'prerequisite')]:
                self.assertEqual(report[key], run.digest(run.OUT / name))
            for stdout, stderr in variants:
                with self.subTest(stdout=stdout), patch.object(run, 'docker', return_value=
                        subprocess.CompletedProcess([], 0, stdout, stderr)), self.assertRaises(AssertionError):
                    run.verify_notices('synthetic')

    def test_source_and_binary_changes_refuse_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            source = out / 'source'
            source.mkdir()
            (source / 'probe.c').write_text('ordinary source')
            (out / 'prerequisite').write_bytes(b'unexecuted binary')
            with patch.multiple(run, HERE=source, OUT=out), patch.object(run, 'docker') as transport:
                run.save('hashes.json', {'probe.c': run.digest(source / 'probe.c'),
                                         'prerequisite': run.digest(out / 'prerequisite')})
                for path in (source / 'probe.c', out / 'prerequisite'):
                    original = path.read_bytes()
                    path.write_bytes(b'changed')
                    with self.assertRaisesRegex(AssertionError, 'source or binary changed'):
                        run.verify_notices('synthetic')
                    path.write_bytes(original)
                transport.assert_not_called()

    def test_final_source_change_downgrades_after_actual_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'evidence'

            def main(raw):
                run.save('result.json', {'status': 'SUPPORTED_SINGLE_TARGET_ADMISSION'})
                run.save('notice-controls.json', {'synthetic': True})
                run.save('hashes.json', {})
                (out / 'prerequisite').write_bytes(b'unexecuted binary')

            with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag=None), \
                    patch.object(run, 'main', main), patch.object(subprocess, 'Popen', side_effect=
                        AssertionError('unexpected transport')), redirect_stdout(io.StringIO()):
                run.execute(raw=True)
            result = json.loads((out / 'result.json').read_text())
            self.assertEqual(result['status'], 'INCONCLUSIVE')
            self.assertIn('source or binary changed', result['noticeIdentity'])
            for key, name in [('commandsSha256', 'commands.json'), ('cleanupSha256', 'cleanup.json'),
                              ('noticeControlsSha256', 'notice-controls.json')]:
                self.assertEqual(result[key], run.digest(out / name))

    def test_all_current_modes_require_one_complete_receipt_and_absence(self):
        for mode in ('normal', 'inherited', 'death', *('raw-' + m for m in admission.MODES)):
            ready = int(mode in ('death', 'raw-death'))
            row = f'NOTICE_RECEIPT root=23 ready={ready}\n'
            absent = 'REAPED 23 SUPERVISOR 7\n'
            evidence = row + absent
            self.assertEqual(run.check_notice(mode, evidence), '23')
            variants = [evidence.replace('root=23', 'root=0'), evidence.replace('root=23', 'root=-1'),
                        evidence.replace('root=23', 'root=24'), evidence.replace('SUPERVISOR 7', 'SUPERVISOR 0'),
                        evidence.replace('SUPERVISOR 7', 'SUPERVISOR -1'), evidence.replace('ready=', 'ready=9'),
                        evidence.replace(f'ready={ready}', f'ready={1-ready}'),
                        evidence + 'NOTICE_RECEIPTbroken\n', evidence + 'REAPED broken\n']
            for line in (row, absent):
                variants.extend((evidence.replace(line, ''), evidence + line,
                                 evidence.replace(line, line[:-2] + '\n')))
            for changed in variants:
                with self.subTest(mode=mode, evidence=changed), self.assertRaises(AssertionError):
                    run.check_notice(mode, changed)

    def test_raw_collector_binds_owned_identity_to_the_shared_receipt(self):
        evidence = AdmissionTests().death_evidence()
        witness = "Reaped child with pid: '23'\n"
        admission.check('death', evidence, witness)
        line = 'NOTICE_RECEIPT root=23 ready=1\n'
        variants = [evidence.replace(line, changed) for changed in ('', line * 2,
                    line + 'NOTICE_RECEIPT malformed\n', line.replace('23', '24'),
                    line.replace('ready=1', 'ready=0'), line[:-2] + '\n')]
        variants.extend((evidence.replace('OWNED_TARGET 23', 'OWNED_TARGET 24'),
                         evidence.replace('OWNED_TARGET 23', 'OWNED_TARGET 0'),
                         evidence + 'OWNED_TARGET malformed\n'))
        for changed in variants:
            with self.assertRaises(AssertionError):
                admission.check('death', changed, witness)


if __name__ == '__main__':
    unittest.main()
