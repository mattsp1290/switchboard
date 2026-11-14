from contextlib import redirect_stdout
import hashlib
import io
import itertools
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run
import run_admission as admission
import repro_fd_inventory_eio as inventory
from test_cleanup import FakeDocker, capture_transport
from test_raw_evidence import fixture as raw_fixture

EXPECTED = {
    'raw/normal-first': (5, 0, 0, 0, 0),
    'raw/normal-stdio': (5, 7, 0, 0, 13),
    'raw/inherited-before9': (4, 7, 0, 0, 13),
    'raw/inherited-after9': (9, 15, 0, 0, 0),
    'raw/normal-open': (0, 7, 5, 0, 0),
    'raw/normal-entry': (0, 7, 0, 5, 13),
    'raw/inherited-open': (0, 15, 5, 0, 0),
    'raw/inherited-entry': (0, 15, 0, 5, 13),
    'prerequisite/normal-first': (5, 0, 0, 0, 0),
    'prerequisite/normal-stdio': (5, 7, 0, 0, 13),
    'prerequisite/inherited-before9': (4, 7, 0, 0, 13),
    'prerequisite/inherited-after9': (9, 15, 0, 0, 0),
    'prerequisite/normal-open': (0, 7, 5, 0, 0),
    'prerequisite/normal-entry': (0, 7, 0, 5, 13),
    'prerequisite/inherited-open': (0, 15, 5, 0, 0),
    'prerequisite/inherited-entry': (0, 15, 0, 5, 13),
}


def fixture(selector):
    error, final_mask, opened_errno, entry_errno, close_errno = EXPECTED[selector]
    raw, inherited = selector.startswith('raw/'), '/inherited-' in selector
    token = 'case=' + selector
    rows = ['SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0', 'STATUS 7']
    if raw:
        rows += ['OWNED_TARGET 23']
    rows += [f'FD_WAIT {token} actor=8 target=23 flags=1073741824 result=23 error=0 status=4991']
    if raw:
        rows += ['RAW_OPTIONS mask=1048577 result=0']
    rows += ['STATUS 8', 'STATUS 23', 'EVIDENCE_FD pipe:[41] OUTPUT_FD pipe:[42]',
             f'FD_OPEN {token} actor=8 parent=7 target=23 dir=0x123 result=1 error=0 planted={opened_errno}']
    entries = [] if final_mask == 0 else ['.', '..', '0', '1', '2'] + (['9'] if final_mask == 15 else [])
    mask = 0
    for ordinal, entry in enumerate(entries, 1):
        mask |= {'.': 0, '..': 0, '0': 1, '1': 2, '2': 4, '9': 8}[entry]
        rows += [f'FD_READ {token} actor=8 dir=0x123 ordinal={ordinal} input=0 name={entry} mask={mask} error=0 injected=0 planted={entry_errno}']
        if entry in ('0', '1', '2', '9'):
            link = '/dev/null' if entry == '0' else '/outside/sentinel' if entry == '9' else 'pipe:[42]'
            rows += [f'FD {entry} {link}']
    count = len(entries) + 1
    rows += [f'FD_READ {token} actor=8 dir=0x123 ordinal={count} input=0 name=NULL mask={final_mask} error={error} injected={int(bool(error))} planted=0',
             f'FD_CLOSE {token} actor=8 dir=0x123 reads={count} closes=1 terminal={count} input={error} result=0 error={error} output={close_errno}']
    if error:
        rows += [f'FAIL fd inventory complete errno={error}']
    else:
        rows += ['TARGET 23']
    if error or inherited:
        rows += [f'FD_KILL {token} actor=8 target=23 signal=9 result=0 error=0',
                 f'FD_WAIT {token} actor=8 target=23 flags=1073741824 result=23 error=0 status=9']
        if error and raw:
            rows += ['RAW_CLEANUP target=23 reaped=23 status=9']
        elif not error:
            rows += ['REJECT_INHERITED_FD']
        wait_count = 2
    elif raw:
        rows += ['MAP ffff0000-ffff1000 r-xp 00000000 00:00 0 [vdso]']
        baseline = raw_fixture('normal')[0].splitlines()
        start = baseline.index('RAW_WAIT status=34175')
        end = next(i for i, row in enumerate(baseline) if row.startswith('NOTICE_RECEIPT'))
        for row in baseline[start:end]:
            if row.startswith('RAW_WAIT'):
                state = row.split('=')[1]
                rows += [f'FD_WAIT {token} actor=8 target=23 flags=1073741825 result=23 error=0 status={state}']
            rows += [row]
        wait_count = 9
    else:
        for operation in (56, 63, 64, 57, 94):
            rows += [f'FD_WAIT {token} actor=8 target=23 flags=1073741824 result=23 error=0 status=34175',
                     f'ENTRY {operation} size=80 arch=c00000b7']
            if operation == 56:
                rows += ['PATH /fixture/allowed']
            if operation != 94:
                rows += [f'FD_WAIT {token} actor=8 target=23 flags=1073741824 result=23 error=0 status=34175',
                         f'EXIT {operation} result=0 size=33']
        rows += [f'FD_WAIT {token} actor=8 target=23 flags=1073741824 result=23 error=0 status=0', 'PREREQUISITES_OBSERVED']
        wait_count = 11
    rows += [f'FD_EXIT {token} actor=8 code={90 if error else 0} reads={count} closes=1 terminal={count} mask={final_mask} kills={int(bool(error or inherited))} waits={wait_count}']
    if error and not raw:
        rows += [f'FD_KILL {token} actor=7 target=8 signal=9 result=-1 error=3']
    rows += [f'FD_WAIT {token} actor=7 target=8 flags=1073741825 result=8 error=0 status={23040 if error else 0}']
    if error and not raw:
        rows += ['FAIL supervisor notices and cleanup errno=3']
    else:
        rows += ['NOTICE_RECEIPT root=23 ready=0', f'TRACER_TERMINAL 8 wait_status={23040 if error else 0}', 'REAPED 23 SUPERVISOR 7']
        if raw:
            rows += ['TARGET_BYTES ' + ('0 ' if error or inherited else '7 7261772d6f6b0a')]
    return '\n'.join(rows) + '\n', 'allowed\n' if not raw and not inherited and not error else '', 90 if error and not raw else 0


class InventoryEvidenceTests(unittest.TestCase):
    def reject(self, selector, evidence, output=None, code=None):
        _, default_output, default_code = fixture(selector)
        with self.subTest(selector=selector, evidence=evidence), self.assertRaises((AssertionError, ValueError, StopIteration)):
            inventory.check_case(selector, evidence, default_output if output is None else output,
                                 default_code if code is None else code)

    def test_literal_matrix_and_both_caller_outcomes(self):
        self.assertEqual(inventory.CASES, tuple(EXPECTED))
        self.assertEqual(len(EXPECTED), 16)
        for selector in EXPECTED:
            result = inventory.check_case(selector, *fixture(selector))
            self.assertEqual(result['selector'], selector)
            self.assertEqual((result['tracer'], result['supervisor'], result['target']), (8, 7, 23))
        selector = 'prerequisite/normal-stdio'
        evidence, output, code = fixture(selector)
        inventory.check_case(selector, evidence.replace('signal=9 result=-1 error=3', 'signal=9 result=0 error=5'), output, code)
        for selector in ('raw/normal-open', 'raw/normal-entry'):
            evidence, output, code = fixture(selector)
            evidence = evidence.replace('MAP ffff0000', 'MAP fffe0000-fffe1000 rw-p 00000000 00:00 0\nMAP ffff0000')
            inventory.check_case(selector, evidence, output, code)

    def test_every_governed_row_inventory_framing_and_fields(self):
        for selector in EXPECTED:
            rows = fixture(selector)[0].splitlines(keepends=True)
            for index, row in enumerate(rows):
                for replacement in ('', row * 2, ' ' + row, '\t' + row, row[:-1] + 'garbage\n',
                                    row[:-1] + '\r\n', row[:-1], row[:len(row) // 2] + '\n'):
                    self.reject(selector, ''.join(rows[:index] + [replacement] + rows[index + 1:]))
                if row.startswith('FD_'):
                    for match in re.finditer(r' (\w+)=([^ ]+)', row.rstrip('\n')):
                        field, value = match.groups()
                        changed = 'unknown' if field == 'case' else '0x999' if field == 'dir' else 'broken' if field == 'name' else '-999'
                        replacement = row[:match.start(2)] + changed + row[match.end(2):]
                        self.reject(selector, ''.join(rows[:index] + [replacement] + rows[index + 1:]))
            self.reject(selector, ''.join(rows) + 'FD_UNKNOWN case=unavailable\n')
            self.reject(selector, ''.join(rows) + ' FDbroken\n')

    def test_required_order_boundaries_and_late_operations(self):
        anchors = ('FD_OPEN', 'FD_READ', 'FD_CLOSE', 'FAIL fd', 'FD_KILL', 'FD_WAIT', 'FD_EXIT',
                   'RAW_CLEANUP', 'NOTICE_RECEIPT', 'TRACER_TERMINAL', 'REAPED', 'TARGET_BYTES',
                   'TARGET ', 'REJECT_INHERITED_FD', 'PREREQUISITES_OBSERVED', 'MAP', 'PATH')
        for selector in EXPECTED:
            rows = fixture(selector)[0].splitlines(keepends=True)
            indices = [i for i, row in enumerate(rows) if row.startswith(anchors)]
            for left, right in zip(indices, indices[1:]):
                changed = rows.copy()
                changed[left], changed[right] = changed[right], changed[left]
                if changed != rows:
                    self.reject(selector, ''.join(changed))
            for prefix in ('FD_OPEN', 'FD_CLOSE', 'FD_READ', 'FD_WAIT', 'FD_KILL', 'FD_EXIT'):
                selected = [row for row in rows if row.startswith(prefix)]
                if selected:
                    self.reject(selector, ''.join(rows + [selected[0]]))
            for before, after in (('input=0', 'input=5'), ('closes=1', 'closes=2'), ('reads=6', 'reads=7'),
                                  ('status=23040', 'status=9'), ('name=NULL', 'name=.'),
                                  ('injected=1', 'injected=0'), ('planted=5', 'planted=0')):
                evidence = ''.join(rows)
                if before in evidence:
                    self.reject(selector, evidence.replace(before, after, 1))
            self.reject(selector, ''.join(rows), output='unexpected\n')
            self.reject(selector, ''.join(rows), code=17)

    def test_failure_work_and_false_prerequisite_receipts(self):
        forbidden = ('RAW_WAIT status=0', 'RAW_INFO bad', 'RAW_ENTRY bad', 'RAW_EXIT bad', 'RAW_DEADLINE',
                     'RAW_REJECT_REGISTRATION_BEFORE_EXECUTION', 'ROBUST bad', 'RSEQ bad', 'MAP bad',
                     'TARGET 23', 'BLOCKED_READ bad', 'ENTRY 56', 'EXIT 56', 'PATH /fixture/allowed',
                     'REJECT_INHERITED_FD', 'PREREQUISITES_OBSERVED', 'RAW_ADMISSION_OBSERVED', 'SUPERVISOR_DEADLINE')
        for selector, values in EXPECTED.items():
            if not values[0]:
                continue
            evidence = fixture(selector)[0]
            for row in forbidden:
                for variant in (row + '\n', ' ' + row + '\n', row):
                    self.reject(selector, evidence + variant)
            if selector.startswith('prerequisite/'):
                for row in ('NOTICE_RECEIPT root=23 ready=0', 'REAPED 23 SUPERVISOR 7',
                            'TRACER_TERMINAL 8 wait_status=23040', 'OWNED_TARGET 23', 'TARGET_BYTES 0 '):
                    self.reject(selector, evidence + row + '\n')

    def test_conflicting_family_and_outcome_records(self):
        raw_rows = ('RAW_OPTIONS mask=1048577 result=0', 'RAW_CLEANUP target=23 reaped=23 status=9',
                    'RAW_ADMISSION_OBSERVED', 'RAW_WAIT status=0', 'RAW_INFO bad', 'RAW_INFO_BYTES 01',
                    'RAW_ENTRY bad', 'RAW_EXIT bad', 'OWNED_TARGET 23', 'TARGET_BYTES 0 ')
        for selector, values in EXPECTED.items():
            rows = list(raw_rows) if selector.startswith('prerequisite/') else []
            if selector.startswith('prerequisite/') or values[0] or '/inherited-' in selector:
                rows += ['MAP ffff0000-ffff1000 r-xp 00000000 00:00 0 [vdso]']
            if selector.startswith('raw/') or values[0] or '/inherited-' in selector:
                rows += ['PATH /fixture/allowed']
            if not values[0]:
                rows += ['RAW_CLEANUP target=23 reaped=23 status=9']
            if '/normal-' in selector:
                rows += ['REJECT_INHERITED_FD']
            else:
                rows += ['ENTRY 56', 'EXIT 56', 'PREREQUISITES_OBSERVED']
            evidence = fixture(selector)[0]
            for row in rows:
                for variant in (row + '\n', ' ' + row + '\n', '\t' + row + '\n', row,
                                row.split(' ', 1)[0] + 'broken\n'):
                    self.reject(selector, evidence + variant)


class InventoryCollectorTests(unittest.TestCase):
    def test_actual_collector_capture_and_live_ownership_schedules(self):
        faults = (None, 'late', 'incomplete', 'bad-init', 'survivor', 'zombie', 'ended', 'exec', 'missed', 'hold', 'short-wait')
        for selector, fault in itertools.product(EXPECTED, faults):
            with self.subTest(selector=selector, fault=fault), tempfile.TemporaryDirectory() as directory:
                out = Path(directory)
                external, waited = set(), False
                evidence, output, code = fixture(selector)
                if fault == 'short-wait' and code != 90:
                    continue
                elapsed, hold_end = 0.0, 10.0
                if fault == 'missed':
                    evidence = evidence.replace('injected=1', 'injected=0').replace('planted=5', 'planted=0')
                if fault == 'exec':
                    code = 17
                calls = []

                def transport(args, **kwargs):
                    nonlocal waited, elapsed
                    calls.append(args)
                    command, name = args[3], args[-1]
                    stdout, stderr, status = '', '', 0
                    if command == 'create':
                        cid = args[args.index('--name') + 1]
                        self.assertFalse(external)
                        external.add(cid)
                    elif command == 'start':
                        self.assertIn(name, external)
                    elif command == 'exec' and '--env' in args:
                        self.assertEqual(args[args.index('--env') + 1], 'FD_INVENTORY_CASE=' + selector)
                        self.assertEqual(kwargs['timeout'], 8)
                        self.assertFalse(kwargs['text'])
                        elapsed += 0.1 if code == 90 else 3.1
                        if fault == 'incomplete':
                            raise subprocess.TimeoutExpired(args, 8, output.encode(), evidence[:-12].encode())
                        stdout, stderr, status = output.encode(), evidence.encode(), code
                        if fault == 'late':
                            stderr += b'FD_INVALID late-final-bytes\n'
                    elif command == 'exec':
                        self.assertLess(elapsed, hold_end)
                        stdout, stderr = b'changed' if fault == 'bad-init' else b'init', b''
                    elif command == 'inspect':
                        if name in external:
                            stdout = json.dumps([{'State': {'Running': fault != 'ended'}}])
                        else:
                            status, stdout, stderr = 1, '[]', f'error: no such object: {name}'
                    elif command == 'top':
                        self.assertFalse(waited)
                        self.assertLess(elapsed, hold_end)
                        stdout = 'PID PPID STAT COMMAND\n1 0 S docker-init\n7 1 S probe\n'
                        if fault == 'survivor':
                            stdout += '8 7 S target\n'
                        if fault == 'zombie':
                            stdout = stdout.replace('7 1 S', '7 1 Z')
                    elif command == 'wait':
                        self.assertEqual(kwargs['timeout'], 8 if fault == 'short-wait' else 12)
                        remaining = hold_end - elapsed
                        if kwargs['timeout'] <= remaining:
                            elapsed += kwargs['timeout']
                            raise subprocess.TimeoutExpired(args, kwargs['timeout'])
                        elapsed = hold_end
                        waited, stdout = True, '90' if fault == 'hold' else '0'
                    elif command == 'logs':
                        self.assertTrue(waited)
                        stdout, stderr = b'', b'LINK exe /sbin/docker-init\n'
                    elif command == 'rm':
                        external.remove(name)
                    else:
                        self.fail(f'unexpected transport {args}')
                    return subprocess.CompletedProcess(args, status, stdout, stderr)

                with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag='inert'), \
                        patch.object(run, '_capture', capture_transport(transport)), patch.object(run.time, 'sleep'), \
                        patch.object(inventory, 'HOLD_WAIT_TIMEOUT', 8 if fault == 'short-wait' else inventory.HOLD_WAIT_TIMEOUT):
                    if fault is None:
                        result = inventory.collect_case(selector, hashlib.sha256(b'init').hexdigest())
                        self.assertEqual(result['selector'], selector)
                        self.assertEqual(result['commandRange'], [0, len(run.commands)])
                        for name, expected in result['evidence'].items():
                            self.assertEqual(run.digest(out / name), expected)
                        self.assertFalse(external)
                        self.assertEqual(elapsed, hold_end)
                    else:
                        with self.assertRaises((AssertionError, subprocess.TimeoutExpired)):
                            inventory.collect_case(selector, hashlib.sha256(b'init').hexdigest())
                        self.assertTrue(run.containers)
                        if fault == 'short-wait':
                            self.assertFalse(waited)
                            self.assertAlmostEqual(elapsed, 8.1)
                            self.assertTrue(run.commands[-1]['incomplete'])
                        if fault == 'incomplete':
                            self.assertTrue(run.commands[-1]['incomplete'])
                            self.assertTrue((out / run.commands[-1]['partialFiles']['stderr']).exists())
                        else:
                            retained = (out / ('fd-' + selector.replace('/', '-') + '.stderr')).read_bytes()
                            self.assertEqual(retained, evidence.encode() + (b'FD_INVALID late-final-bytes\n' if fault == 'late' else b''))
                    run.cleanup()
                    self.assertFalse(run.containers)
                    self.assertFalse(external)


class InventoryFinalizationTests(unittest.TestCase):
    def exercise(self, fault):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'evidence'
            containers, modes, waited = set(), {}, set()
            image_present, matrix_count, compiled = False, 0, 0
            real_digest, real_save = run.digest, run.save
            identities = run.main, run.run, run.save, admission.MODES, admission.check
            initial_hash = 'd286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1'
            tool = '/Library/Developer/CommandLineTools/usr/bin/llvm-objdump'
            publications, selectors, baseline_modes = [], [], []

            def digest(path):
                pins = {run.DOCKER: 'd79e988b423edbe34460a2e4d86ecc841997f16c5e2a2ee5263f679d0c483a84',
                        run.ZIG: '9fb480d3398506f5e2bef77f175766a8de0ee191dbdfbfb0c117a1150f141c91',
                        tool: '1dcc1432db4d828cf8cd71a84cb8d9bf63a7ca80b5eeec711a9e5f13a3f5f98e'}
                name = Path(path).name
                if matrix_count == 16:
                    if fault == 'source' and name == 'prerequisite.c':
                        return 'source changed'
                    if fault == 'binary' and name == 'prerequisite':
                        return 'binary changed'
                    if fault == 'commands-hash' and name == 'commands.json':
                        raise OSError('command digest failed')
                    if fault == 'cleanup-hash' and name == 'cleanup.json':
                        raise OSError('cleanup digest failed')
                if name == 'docker-init' or name.endswith('-init'):
                    return initial_hash if Path(path).read_bytes() == b'inert init' else real_digest(path)
                return pins.get(str(path)) or real_digest(path)

            def save(name, data):
                if name in ('result.json', 'fd-inventory-publication.pending'):
                    publications.append(dict(data))
                    if fault == 'callback-before' and data['status'] == 'FD_INVENTORY_CONTROLS_OBSERVED':
                        raise OSError('final callback refused')
                real_save(name, data)
                if name == 'fd-inventory-publication.pending' and fault == 'callback-after':
                    raise OSError('final callback failed after write')
                if name == 'cleanup.json' and fault == 'cleanup-callback':
                    raise OSError('owner callback failed')

            def transport(args, **kwargs):
                nonlocal image_present, matrix_count, compiled
                code, stdout, stderr = 0, '', ''
                if args[0] == run.ZIG:
                    if args[1] == 'version':
                        if fault == 'original-main':
                            raise RuntimeError('original main failed')
                        stdout = '0.17.0\n'
                    else:
                        compiled += 1
                        self.assertEqual(args.count(str(run.HERE / 'prerequisite.c')), 1)
                        self.assertEqual(args[-6:], [f'-Wl,--wrap={name}' for name in ('opendir', 'readdir', 'closedir', 'kill', 'waitpid', '_exit')])
                        Path(args[args.index('-o') + 1]).write_bytes(b'inert binary, never executed')
                elif args[0] == tool:
                    if '--private-headers' in args:
                        stdout = 'Dynamic Section:\n'
                    elif '--section-headers' in args:
                        stdout = 'inert section inventory\n'
                    else:
                        instructions = [f'mov w8, #0x{number:x}' for number in (96, 172, 99, 63, 64, 93)]
                        instructions += ['svc #0'] * 6 + ['nop'] * 24
                        stdout = ''.join(f'{4096 + 4 * i:x}: 00000000 {line}\n' for i, line in enumerate(instructions))
                else:
                    command, name = args[3], args[-1]
                    if command == 'version':
                        components = [dict(Name=n, Version=v, Details={'GitCommit': c}) for n, v, c in
                                      [('runc', '1.3.4', 'v1.3.4-0-gd6d73eb8'), ('docker-init', '0.19.0', 'de40ad0')]]
                        stdout = json.dumps({'Client': {'Version': '29.5.2'}, 'Server': {
                            'Version': '29.2.1', 'GitCommit': '6bc6209', 'KernelVersion': '6.8.0-100-generic', 'Components': components}})
                    elif command == 'build':
                        image_present = True
                    elif command == 'image':
                        if name == run.IMAGE:
                            stdout = json.dumps([{'Id': run.IMAGE.removeprefix('node@'), 'Architecture': 'arm64', 'Os': 'linux'}])
                        elif fault == 'ownership' and matrix_count == 16:
                            code, stdout, stderr = 1, '[]', 'daemon unavailable'
                        elif args[4] == 'rm':
                            image_present = False
                        elif image_present:
                            stdout = '[{}]'
                        else:
                            code, stdout, stderr = 1, '[]', f'Error response from daemon: No such image: {name}'
                    elif command == 'create':
                        cid = args[args.index('--name') + 1]
                        self.assertNotIn(cid, containers, 'reused hold name before verified absence')
                        containers.add(cid)
                        modes[cid] = name
                        waited.discard(cid)
                        if name.startswith('raw-'):
                            baseline_modes.append(name)
                    elif command == 'start':
                        self.assertIn(name, containers)
                    elif command == 'exec':
                        if '--env' in args:
                            selector = args[args.index('--env') + 1].split('=', 1)[1]
                            selectors.append(selector)
                            matrix_count += 1
                            evidence, output, code = fixture(selector)
                            if fault == 'matrix' and matrix_count == 4:
                                evidence += 'FD_INVALID injected matrix failure\n'
                            stdout, stderr = output.encode(), evidence.encode()
                        elif name == 'notice-tests':
                            stdout = ''.join(f'NOTICE_TEST {i} control-{chr(97+i//26)}{chr(97+i%26)} result=1\n' for i in range(165))
                            stdout += 'NOTICE_TESTS count=165 failed=0\n'
                        else:
                            stdout, stderr = b'inert init', b''
                    elif command == 'logs':
                        mode = modes[name]
                        if mode == 'hold':
                            stdout, stderr = b'', b'LINK exe /sbin/docker-init\n'
                        elif name in waited:
                            stderr, stdout = raw_fixture(mode.removeprefix('raw-'))
                        else:
                            stderr = 'REAPED 23 SUPERVISOR 7\n'
                    elif command == 'inspect':
                        if name in containers:
                            stdout = '[{"State":{"Running":true}}]'
                        else:
                            code, stdout, stderr = 1, '[]', f'error: no such object: {name}'
                    elif command == 'top':
                        self.assertNotIn(args[4], waited)
                        stdout = 'PID PPID STAT COMMAND\n1 0 S docker-init\n7 1 S probe\n'
                    elif command == 'wait':
                        waited.add(name)
                        stdout = '0'
                    elif command == 'rm':
                        containers.remove(name)
                        if matrix_count == 16:
                            changed = {'notice': 'notice-controls.stdout', 'receipt': 'notice-controls.json',
                                       'evidence': 'fd-raw-normal-first.stderr', 'init': 'docker-init',
                                       'instructions': 'raw-instructions.json', 'raw-evidence': 'raw-normal.evidence'}
                            if fault in changed:
                                path = out / changed[fault]
                                path.write_bytes(path.read_bytes() + b'\n')
                    else:
                        self.fail(f'unexpected transport {args}')
                return subprocess.CompletedProcess(args, code, stdout, stderr)

            failure = None
            with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag=None, stage='identities'), \
                    patch.object(run, 'digest', digest), patch.object(run, 'save', save), \
                    patch.object(run, '_capture', capture_transport(transport)), patch.object(run.time, 'sleep'), \
                    redirect_stdout(io.StringIO()):
                patched_identities = run.main, run.run, run.save, admission.MODES, admission.check
                try:
                    code = inventory.main()
                except (AssertionError, OSError, RuntimeError) as error:
                    failure, code = error, 1
                self.assertEqual((run.main, run.run, run.save, admission.MODES, admission.check), patched_identities)
                result = json.loads((out / 'result.json').read_text())
                if fault is None:
                    self.assertEqual(code, 0)
                    self.assertIsNone(failure)
                    self.assertEqual(result['status'], 'FD_INVENTORY_CONTROLS_OBSERVED')
                    self.assertEqual(selectors, list(EXPECTED))
                    self.assertEqual(baseline_modes, ['raw-' + name for name in
                                     ('normal', 'inherited', 'bad-root', 'info-short', 'query-bad', 'query-short', 'registration', 'deadline', 'death')])
                    self.assertEqual(compiled, 1)
                    self.assertFalse(run.containers)
                    self.assertFalse(run.images)
                    self.assertEqual([row['status'] for row in publications[:-1]], ['INCONCLUSIVE', 'INCONCLUSIVE'])
                    self.assertEqual(json.loads((out / 'notice-controls.json').read_text())['controlIds'], list(range(165)))
                    self.assertEqual(json.loads((out / 'raw-instructions.json').read_text())['instructions'], 36)
                    for field, name in [('commandsSha256', 'commands.json'), ('cleanupSha256', 'cleanup.json')]:
                        self.assertEqual(result[field], real_digest(out / name))
                    for case in result['inventoryCases']:
                        for name, expected in case['evidence'].items():
                            self.assertEqual(digest(out / name), expected)
                else:
                    self.assertNotEqual(code, 0)
                    self.assertEqual(result['status'], 'INCONCLUSIVE')
                    self.assertTrue(failure or 'error' in result or 'refusal' in result)
                if fault == 'ownership':
                    self.assertTrue(run.images)
                    self.assertTrue(image_present)
                else:
                    self.assertFalse(run.images)
                    self.assertFalse(image_present)
                self.assertFalse(containers)
                self.assertFalse(run.containers)
            self.assertEqual((run.main, run.run, run.save, admission.MODES, admission.check), identities)

    def test_actual_main_execute_and_final_publication(self):
        for fault in (None, 'original-main', 'matrix', 'callback-before', 'callback-after', 'source', 'binary',
                      'notice', 'receipt', 'evidence', 'commands-hash', 'cleanup-hash', 'ownership',
                      'cleanup-callback', 'init', 'instructions', 'raw-evidence'):
            with self.subTest(fault=fault):
                self.exercise(fault)

    def test_owner_create_uncertainty_still_restores_every_adapter(self):
        for fault in ('created', 'late', 'remove-timeout', 'daemon', 'unseen', 'verify-daemon'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                fake = FakeDocker(fault)
                fake.image = False
                out = Path(directory) / 'evidence'

                def baseline(raw):
                    self.assertIs(raw, True)
                    run.create('hold')

                with patch.multiple(run, OUT=out, commands=[], containers={}, images={}, tag='inert'), \
                        patch.object(run, 'main', baseline), patch.object(run, '_capture', capture_transport(fake.run)), \
                        patch.object(run.time, 'sleep'), redirect_stdout(io.StringIO()):
                    originals = run.main, run.run, run.save, admission.MODES, admission.check
                    with self.assertRaises(AssertionError):
                        inventory.main()
                    self.assertEqual((run.main, run.run, run.save, admission.MODES, admission.check), originals)
                    self.assertEqual(json.loads((out / 'result.json').read_text())['status'], 'INCONCLUSIVE')
                    self.assertEqual(bool(run.containers), fault in ('daemon', 'unseen', 'verify-daemon'))
                    self.assertTrue(run.commands[0]['incomplete'])


if __name__ == '__main__':
    unittest.main()
