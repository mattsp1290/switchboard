import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run
import run_admission as admission
from test_cleanup import CleanupTests


class AdmissionTests(unittest.TestCase):
    def test_import_has_no_transport_or_filesystem_side_effect(self):
        specification = importlib.util.spec_from_file_location('inert_import', run.__file__)
        with patch.object(subprocess, 'run', side_effect=AssertionError('transport during import')), \
                patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir during import')):
            specification.loader.exec_module(importlib.util.module_from_spec(specification))

    def test_raw_create_uses_actual_shared_owner_after_uncertainty(self):
        for fault in ('created', 'unseen', 'late', 'daemon', 'remove-timeout', 'verify-daemon'):
            with self.subTest(fault=fault):
                fake, records, report, owned = CleanupTests().exercise(fault, mode='raw-normal')
                self.assertEqual(bool(owned), fault in ('unseen', 'daemon', 'verify-daemon'))
                self.assertIn('TINI_VERBOSITY=3', fake.calls[0])
                self.assertEqual(records[0]['stdout'], 'partial-id\n')
                self.assertEqual(records[0]['stderr'], 'partial-error\n')

    def death_evidence(self):
        return ('OWNED_TARGET 23\nREAPED 23 SUPERVISOR 7\nNOTICE_RECEIPT root=23 ready=1\n'
                'SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0\n'
                'TARGET_BYTES 0 \nTRACER_TERMINAL 8 wait_status=9\n'
                'RAW_OPTIONS mask=1048577 result=0\nRAW_ENTRY step=0 nr=96 args=0,0,0,0,0,0\n'
                'RAW_EXIT step=0 result=23 error=0\n'
                'ROBUST result=0 errno=0 pointer=0 size=24 expected=24\n'
                'RSEQ requested=24 returned=24 pointer=0 size=0 signature=0 flags=0 pad=0\n')

    def test_death_requires_complete_matched_init_record_and_separate_output(self):
        evidence = self.death_evidence()
        witness = "[DEBUG tini (1)] Reaped child with pid: '23'\n"
        self.assertEqual(admission.check('death', evidence, witness)['initReaping'], 'matched actual init waitpid log')
        for bad in ('', witness.replace("'23'", "'24'"), witness.rstrip()[:-1], witness * 2):
            with self.assertRaises(AssertionError):
                admission.check('death', evidence, bad)
        for bad in (evidence.replace('TARGET_BYTES 0 ', 'TARGET_BYTES 1 78'),
                    evidence.replace('returned=24', 'returned=1'), evidence.replace('size=24 expected=24', 'size=8 expected=24')):
            with self.assertRaises(AssertionError):
                admission.check('death', bad, witness)

    def test_collector_uses_flushed_init_logs_after_live_inventory(self):
        for witness in (True, False):
            with self.subTest(witness=witness), tempfile.TemporaryDirectory() as directory:
                exited, exists = False, True

                def transport(args, **kwargs):
                    nonlocal exited, exists
                    command = args[3]
                    code, stdout, stderr = 0, '', ''
                    if command == 'logs':
                        stderr = self.death_evidence()
                        if exited and witness:
                            stdout = "[DEBUG tini (1)] Reaped child with pid: '23'\n"
                    elif command == 'inspect':
                        if exists:
                            stdout = '[{"State":{"Running":true}}]'
                        else:
                            code, stdout, stderr = 1, '[]', 'error: no such object: synthetic'
                    elif command == 'exec':
                        stdout, stderr = b'init', b''
                    elif command == 'top':
                        self.assertFalse(exited)
                        stdout = 'PID PPID STAT COMMAND\n1 0 S docker-init\n7 1 S probe\n'
                    elif command == 'wait':
                        exited, stdout = True, '0'
                    elif command == 'rm':
                        exists = False
                    else:
                        self.fail(f'unexpected transport {command}')
                    return subprocess.CompletedProcess(args, code, stdout, stderr)
                with patch.multiple(run, OUT=Path(directory), commands=[], containers={'synthetic': 'confirmed'}, images={}), \
                        patch.object(subprocess, 'run', transport), patch.object(run.time, 'sleep'):
                    if witness:
                        admission.collect('synthetic', 'death', hashlib.sha256(b'init').hexdigest())
                    else:
                        with self.assertRaisesRegex(AssertionError, 'actual init reaping witness absent'):
                            admission.collect('synthetic', 'death', hashlib.sha256(b'init').hexdigest())
                    run.cleanup()
                    self.assertFalse(exists)
                    self.assertTrue((run.OUT / 'raw-death.top').exists())
                    self.assertEqual(bool((run.OUT / 'raw-death.init').read_text()), witness)


if __name__ == '__main__':
    unittest.main()
