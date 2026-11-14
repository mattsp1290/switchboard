import hashlib
import itertools
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run
import run_admission as admission

PLANS = {'normal': 'EXEXEXET', 'inherited': '', 'bad-root': '', 'info-short': 'S',
         'query-bad': 'EX', 'query-short': 'EX', 'registration': 'EXEXE', 'deadline': 'EXEXE', 'death': 'EXE'}
ERRORS = {'bad-root': 'link identity', 'info-short': 'raw syscall info size', 'query-bad': 'robust absence query',
          'query-short': 'rseq absence query', 'registration': 'unsupported registration', 'deadline': 'raw deadline'}
CORE = ('RAW_WAIT', 'RAW_INFO', 'RAW_ENTRY', 'RAW_EXIT')
INIT = "[DEBUG tini (1)] Reaped child with pid: '23'\n"
ENTRY_ANCHOR = ('01000000b70000c068a6010100000000a0b0daf4ffff00006000000000000000'
                '0000000000000000000000000000000000000000000000000000000000000000'
                '00000000000000000000000000000000')
EXIT_ANCHOR = '02000000b70000c068a6010100000000a0b0daf4ffff0000090000000000000000'


def stop(kind, step, values, padding=b'\0\0\0', ip=0x101a668, sp=0xfffff4dab0a0):
    entry = kind == 'E'
    data = struct.pack('<B3sIQQ', 1 if entry else 2, padding, 0xc00000b7, ip, sp)
    data += struct.pack('<7Q' if entry else '<qB', *values)
    summary = (f'RAW_ENTRY step={step} nr={values[0]} args=' + ','.join(map(str, values[1:])) if entry else (
        f'RAW_EXIT step={step} result={values[0]} error={values[1]}'))
    return ['RAW_WAIT status=34175\n',
            f'RAW_INFO requested=88 returned={80 if entry else 33} op={1 if entry else 2} arch=c00000b7\n',
            f'RAW_INFO_BYTES {data.hex()}\n', summary + '\n']


def fixture(mode):
    rows = ['SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0\n']
    if mode == 'deadline':
        rows += ['BLOCKED_PIPE pipe:[42] supervisor_writer=5 target_reader=0\n']
    rows += ['OWNED_TARGET 23\n', 'RAW_OPTIONS mask=1048577 result=0\n']
    for index, kind in enumerate(PLANS[mode]):
        step = index // 2
        if kind == 'T':
            rows += ['RAW_WAIT status=0\n', 'RAW_ADMISSION_OBSERVED\n']
        elif kind == 'S':
            rows += ['RAW_WAIT status=34175\n', 'RAW_INFO requested=1 returned=80 op=1 arch=0\n', 'RAW_INFO_BYTES 01\n']
        else:
            syscall = (96, 172, 64, 93)[step]
            args = (1, 0x1003270, 7) if step == 2 else (0, 0, 0)
            if step == 2 and mode in ('registration', 'deadline'):
                syscall, args = (99, (123, 456, 789)) if mode == 'registration' else (63, (0, 0x1046e30, 1))
            values = (syscall, *args, 0x123456789abcdef0, 0x8877665544332211, 0xffffffffffffffff)
            rows += stop(kind, step, values if kind == 'E' else (23 if step < 2 else 7, 0))
            if index == 1:
                rows += ['ROBUST result=-1 errno=14 pointer=0x1 size=0 expected=24\n' if mode == 'query-bad'
                         else 'ROBUST result=0 errno=1 pointer=0 size=24 expected=24\n']
                if mode != 'query-bad':
                    rows += [f'RSEQ requested={1 if mode == "query-short" else 24} returned=24 pointer=0 size=0 signature=0 flags=0 pad=0\n']
    if mode == 'inherited':
        rows += ['FD 9 /outside/sentinel\n', 'REJECT_INHERITED_FD\n']
    if mode == 'bad-root':
        rows += ['LINK cwd /sealed/fixture\n']
    if mode == 'registration':
        rows += ['RAW_REJECT_REGISTRATION_BEFORE_EXECUTION\n']
    if mode == 'deadline':
        rows += ['BLOCKED_READ nr=63 fd=0 pointer=1046e30 size=1\n', 'RAW_DEADLINE step=2 entering=0\n']
    if mode in ERRORS:
        rows += [f'FAIL {ERRORS[mode]} errno=14\n', 'RAW_CLEANUP target=23 reaped=23 status=9\n']
    rows += [f'NOTICE_RECEIPT root=23 ready={int(mode == "death")}\n',
             f'TRACER_TERMINAL 8 wait_status={9 if mode == "death" else 23040 if mode in ERRORS else 0}\n',
             'REAPED 23 SUPERVISOR 7\n', 'TARGET_BYTES ' + ('7 7261772d6f6b0a\n' if mode == 'normal' else '0 \n')]
    return ''.join(rows), INIT if mode == 'death' else ''


class RawEvidenceTests(unittest.TestCase):
    def reject(self, mode, rows):
        with self.subTest(mode=mode, evidence=''.join(rows)), self.assertRaises(AssertionError):
            admission.check(mode, ''.join(rows), INIT)

    def test_all_modes_and_literal_retained_layout(self):
        self.assertEqual(tuple(PLANS), admission.MODES)
        self.assertEqual(tuple(admission._RAW_STOPS), admission.MODES)
        self.assertEqual(admission._RAW_STOPS, PLANS)
        for mode in PLANS:
            evidence, init = fixture(mode)
            self.assertEqual(admission.check(mode, evidence, init)['mode'], mode)
            self.assertEqual(admission.check(mode, evidence.replace('\n', '\nSTATUS unrelated\n'), init)['mode'], mode)
            for diagnostic in ('STATUS unrelated RAW_ENTRY diagnostic\n', 'STATUS unrelated RAW_EXIT step=2 diagnostic\n',
                               'STATUS unrelated RAW_ADMISSION_OBSERVED\n'):
                with self.subTest(mode=mode, diagnostic=diagnostic):
                    changed = evidence.replace('RAW_OPTIONS mask=1048577 result=0\n',
                                               'RAW_OPTIONS mask=1048577 result=0\n' + diagnostic)
                    self.assertEqual(admission.check(mode, changed, init)['mode'], mode)
            self.reject(mode, [evidence, 'STATUS unrelated SUPERVISOR_DEADLINE diagnostic\n'])
        for mode, row in (('inherited', 'FD 9 /outside/sentinel\n'), ('bad-root', 'LINK cwd /sealed/fixture\n')):
            self.reject(mode, [fixture(mode)[0].replace(row, '')])
        self.assertEqual(stop('E', 0, (96, 0, 0, 0, 0, 0, 0))[2], f'RAW_INFO_BYTES {ENTRY_ANCHOR}\n')
        self.assertEqual(stop('X', 0, (9, 0))[2], f'RAW_INFO_BYTES {EXIT_ANCHOR}\n')
        evidence, _ = fixture('death')
        for token in ('OWNED_TARGET 23', 'root=23', 'REAPED 23'):
            evidence = evidence.replace(token, token.replace('23', '9'))
        rows = evidence.splitlines(keepends=True)
        first = rows.index('RAW_WAIT status=34175\n')
        rows[first:first + 8] = stop('E', 0, (96, 0, 0, 0, 0, 0, 0)) + stop('X', 0, (9, 0))
        admission.check('death', ''.join(rows), INIT.replace('23', '9'))
        from test_admission import AdmissionTests
        self.reject('death', AdmissionTests().old_death_evidence())

    def test_every_required_row_framing_inventory_and_movement(self):
        for mode in PLANS:
            rows = fixture(mode)[0].splitlines(keepends=True)
            for index, row in enumerate(rows):
                if row.startswith(('FD ', 'LINK ')):
                    continue
                for replacement in ('', row * 2, ' ' + row, '\t' + row, row[:-1] + 'garbage\n',
                                    row[:-1] + '\r\n', row[:-1], row[:len(row) // 2] + '\n', row.rstrip('\n').split(' ')[0] + 'broken\n'):
                    self.reject(mode, rows[:index] + [replacement] + rows[index + 1:])
                moved = rows[:index] + rows[index + 1:] + [row]
                if moved != rows:
                    self.reject(mode, moved)
            core = [i for i, row in enumerate(rows) if row.startswith(CORE)]
            for left, right in zip(core, core[1:]):
                changed = rows.copy()
                changed[left], changed[right] = changed[right], changed[left]
                if changed != rows:
                    self.reject(mode, changed)
            if core:
                self.reject(mode, [r for r in rows if not r.startswith('RAW_WAIT')] +
                            [r for r in rows if r.startswith('RAW_WAIT')])
            for extra in ('RAW_WAIT status=0\n', *stop('E', 3, (93, 0, 0, 0, 1, 2, 3)), *stop('X', 2, (7, 0))):
                self.reject(mode, rows + [extra])
            later = {'normal': ('X', 3), 'registration': ('X', 2), 'deadline': ('X', 2), 'death': ('X', 1)}
            kind, step = later.get(mode, ('E', 0))
            self.reject(mode, rows + stop(kind, step, (23, 0) if kind == 'X' else (96, 0, 0, 0, 1, 2, 3)))
            if not core:
                for row in stop('E', 0, (96, 0, 0, 0, 1, 2, 3)) + stop('X', 0, (23, 0)):
                    for changed in (row, ' ' + row, row[:-1], row[:-1] + '\r\n', row.rstrip('\n').split(' ')[0] + 'broken\n'):
                        self.reject(mode, rows + [changed])

    def test_full_block_source_anchors_and_wrong_mode_witnesses(self):
        anchor_names = ('ROBUST', 'RSEQ', 'RAW_ADMISSION', 'RAW_REJECT', 'BLOCKED_READ', 'BLOCKED_PIPE',
                        'RAW_DEADLINE', 'REJECT_INHERITED', 'RAW_CLEANUP', 'FAIL')
        for mode in PLANS:
            rows = fixture(mode)[0].splitlines(keepends=True)
            for other in PLANS:
                for row in fixture(other)[0].splitlines(keepends=True):
                    if row.startswith(anchor_names) and row not in rows:
                        self.reject(mode, rows + [row])
            starts = [i for i, row in enumerate(rows) if row.startswith('RAW_WAIT')]
            for index, start in enumerate(starts):
                count = 1 if rows[start] == 'RAW_WAIT status=0\n' else 3 if mode == 'info-short' else 4
                block = rows[start:start + count]
                remainder = rows[:start] + rows[start + count:]
                for anchor, row in enumerate(remainder):
                    if row.startswith(('RAW_OPTIONS', 'ROBUST', 'RSEQ', 'RAW_ADMISSION', 'RAW_REJECT',
                                       'BLOCKED_READ', 'RAW_DEADLINE', 'FAIL', 'RAW_CLEANUP', 'NOTICE_RECEIPT')):
                        insert = anchor if anchor < start else anchor + 1
                        changed = remainder[:insert] + block + remainder[insert:]
                        if changed != rows:
                            self.reject(mode, changed)
            summaries = [i for i, row in enumerate(rows) if row.startswith(('RAW_ENTRY', 'RAW_EXIT'))]
            for left, right in itertools.combinations(summaries, 2):
                changed = rows.copy()
                changed[left - 1:left + 1], changed[right - 1:right + 1] = rows[right - 1:right + 1], rows[left - 1:left + 1]
                self.reject(mode, changed)

    def test_header_hex_wait_and_short_boundaries(self):
        for mode in PLANS:
            rows = fixture(mode)[0].splitlines(keepends=True)
            for index, row in enumerate(rows):
                variants = []
                if row.startswith('RAW_WAIT'):
                    variants = [f'RAW_WAIT status={value}\n' for value in (4991, 1407, 99711, 9, 256, -1, 0, 34175)]
                elif row.startswith('RAW_INFO requested'):
                    for field in ('requested', 'returned', 'op', 'arch'):
                        start = row.index(field + '=') + len(field) + 1
                        end = row.find(' ', start)
                        end = len(row) - 1 if end < 0 else end
                        variants += [row[:start] + value + row[end:] for value in
                                     ('-1', '0', '1', '2', '3', '24', '32', '33', '34', '79', '80', '81', '87', '88', '89', 'c00000b7', 'C00000B7')]
                elif row.startswith('RAW_INFO_BYTES'):
                    data = row.split()[1]
                    variants = [f'RAW_INFO_BYTES {value}\n' for value in
                                ('', data[:-1], data[:-2], data + '00', data.upper(), 'gg' + data[2:], data[:2] + ' ' + data[2:])]
                for changed in variants:
                    if changed != row:
                        self.reject(mode, rows[:index] + [changed] + rows[index + 1:])

    def test_payload_summary_agreement_independent_recipe_and_authority(self):
        for mode in PLANS:
            rows = fixture(mode)[0].splitlines(keepends=True)
            for index, row in enumerate(rows):
                if not row.startswith(('RAW_ENTRY', 'RAW_EXIT')):
                    continue
                entry = row.startswith('RAW_ENTRY')
                step = int(row.split('step=')[1].split()[0])
                payload = bytes.fromhex(rows[index - 1].split()[1])
                values = struct.unpack('<7Q' if entry else '<qB', payload[24:])
                for field in range(len(values)):
                    changed = list(values)
                    changed[field] ^= 1
                    replacement = stop('E' if entry else 'X', step, changed)
                    for position, replacement_row in ((index - 1, replacement[2]), (index, replacement[3])):
                        self.reject(mode, rows[:position] + [replacement_row] + rows[position + 1:])
                    coordinated = rows[:index - 3] + replacement + rows[index + 1:]
                    unconstrained = entry and (field >= 4 or (step == 2 and mode == 'registration' and field > 0)
                                                or (step == 2 and mode == 'normal' and field == 2))
                    if unconstrained:
                        admission.check(mode, ''.join(coordinated), INIT)
                    else:
                        self.reject(mode, coordinated)
                for offset in (0, 4, 7):
                    data = bytearray(payload)
                    data[offset] ^= 1
                    self.reject(mode, rows[:index - 1] + [f'RAW_INFO_BYTES {data.hex()}\n'] + rows[index:])
                for padding, ip, sp in ((b'\xff\x01\x80', 0, 1), (b'abc', 2**64 - 1, 2**64 - 2)):
                    replacement = stop('E' if entry else 'X', step, values, padding, ip, sp)
                    admission.check(mode, ''.join(rows[:index - 3] + replacement + rows[index + 1:]), INIT)
                for token in ('+0', '00', '-1', str(2**64), str(-2**63 - 1)):
                    changed = row.replace('step=' + str(step), 'step=' + token)
                    self.reject(mode, rows[:index] + [changed] + rows[index + 1:])
                    for field in range(len(values)):
                        tokens = list(map(str, values))
                        tokens[field] = token
                        summary = (f'RAW_ENTRY step={step} nr={tokens[0]} args=' + ','.join(tokens[1:]) if entry else
                                   f'RAW_EXIT step={step} result={tokens[0]} error={tokens[1]}')
                        self.reject(mode, rows[:index] + [summary + '\n'] + rows[index + 1:])
                if entry:
                    for changed in (row.rstrip() + ',0\n', row.rsplit(',', 1)[0] + '\n', row.replace(',', ';', 1)):
                        self.reject(mode, rows[:index] + [changed] + rows[index + 1:])
                else:
                    for result, error in itertools.product((-2**63, -1, 2**63 - 1, values[0]), (0, 1, 2, 255)):
                        if (result, error) != values:
                            self.reject(mode, rows[:index - 3] + stop('X', step, (result, error)) + rows[index + 1:])

    def test_partial_orders_bind_whole_blocks_and_same_unique_witness(self):
        for mode in ('normal', 'registration', 'deadline', 'death'):
            rows = fixture(mode)[0].splitlines(keepends=True)
            moves = [('RAW_WAIT', 'RAW_OPTIONS'), ('RAW_ENTRY step=1', 'RSEQ'), ('RAW_EXIT step=0', 'ROBUST')]
            for subject, anchor in moves:
                start = next(i for i, row in enumerate(rows) if row.startswith(subject))
                if subject == 'RAW_ENTRY step=1':
                    start -= 3
                moved = rows[start]
                remainder = rows[:start] + rows[start + 1:]
                index = next(i for i, row in enumerate(remainder) if row.startswith(anchor))
                if subject == 'RAW_EXIT step=0':
                    index += 1
                self.reject(mode, remainder[:index] + [moved] + remainder[index:])
            for anchor in ('ROBUST', 'RSEQ'):
                index = next(i for i, row in enumerate(rows) if row.startswith(anchor))
                ambiguous = rows[index].replace('pointer=0', 'pointer=1')
                self.reject(mode, rows[:index] + [ambiguous] + rows[index:])
            evidence = ''.join(rows)
            for errno in (0, 14, 2147483647):
                admission.check(mode, evidence.replace('errno=1 pointer=0', f'errno={errno} pointer=0'), INIT)
        for mode, marker in (('normal', 'RAW_ADMISSION'), ('registration', 'RAW_REJECT'),
                             ('deadline', 'BLOCKED_READ'), ('death', 'NOTICE_RECEIPT'), ('info-short', 'FAIL')):
            rows = fixture(mode)[0].splitlines(keepends=True)
            last = max(i for i, row in enumerate(rows) if row.startswith(CORE))
            moved = rows.pop(last)
            anchor = next(i for i, row in enumerate(rows) if row.startswith(marker)) + 1
            self.reject(mode, rows[:anchor] + [moved] + rows[anchor:])
        rows = fixture('deadline')[0].splitlines(keepends=True)
        index = next(i for i, row in enumerate(rows) if row.startswith('BLOCKED_READ'))
        for pointer in ('0', '01046e30', '1046E30', '10000000000000000', '1046e31'):
            changed = rows[index].replace('1046e30', pointer)
            self.reject('deadline', rows[:index] + [changed] + rows[index + 1:])
            self.reject('deadline', rows[:index] + [changed] + rows[index:])

    def test_actual_collect_uses_final_stream_and_live_identity_for_every_mode(self):
        for mode, fault in itertools.product(PLANS, (None, 'late', 'invalid-final', 'init', 'survivor', 'death-init')):
            if fault == 'death-init' and mode != 'death':
                continue
            with self.subTest(mode=mode, fault=fault), tempfile.TemporaryDirectory() as directory:
                evidence, init = fixture(mode)
                final = evidence.replace('RAW_OPTIONS mask=1048577', 'RAW_OPTIONS mask=0') if fault == 'invalid-final' else evidence
                final_init = '' if fault == 'death-init' else init
                live = 'REAPED 23 SUPERVISOR 7\n' if fault == 'late' else evidence
                exited, exists, inventoried = False, True, False

                def transport(args, **kwargs):
                    nonlocal exited, exists, inventoried
                    command, code, stdout, stderr = args[3], 0, '', ''
                    if command == 'logs':
                        stdout, stderr = (final_init, final) if exited else ('live init stream\n', live)
                    elif command == 'inspect':
                        code, stdout, stderr = (0, '[{"State":{"Running":true}}]', '') if exists else (1, '[]', 'error: no such object: synthetic')
                    elif command == 'exec':
                        stdout, stderr = b'changed' if fault == 'init' else b'init', b''
                    elif command == 'top':
                        self.assertFalse(exited)
                        inventoried = True
                        stdout = 'PID PPID STAT COMMAND\n1 0 S docker-init\n7 1 S probe\n' + ('8 7 Z target\n' if fault == 'survivor' else '')
                    elif command == 'wait':
                        self.assertTrue(inventoried)
                        exited, stdout = True, '0'
                    elif command == 'rm':
                        exists = False
                    else:
                        self.fail(f'unexpected transport {args}')
                    return subprocess.CompletedProcess(args, code, stdout, stderr)

                with patch.multiple(run, OUT=Path(directory), commands=[], containers={'synthetic': 'confirmed'}, images={}, tag=None), \
                        patch.object(subprocess, 'run', transport), patch.object(run.time, 'sleep'):
                    if fault in (None, 'late'):
                        self.assertEqual(admission.collect('synthetic', mode, hashlib.sha256(b'init').hexdigest())['mode'], mode)
                    else:
                        with self.assertRaises(AssertionError):
                            admission.collect('synthetic', mode, hashlib.sha256(b'init').hexdigest())
                        self.assertIn('synthetic', run.containers)
                    run.cleanup()
                    self.assertFalse(exists)
                    self.assertFalse(run.containers)
                    if exited:
                        self.assertEqual((run.OUT / f'raw-{mode}.evidence').read_text(), final)
                        self.assertEqual((run.OUT / f'raw-{mode}.init').read_text(), final_init)
                    self.assertEqual(json.loads((run.OUT / f'raw-{mode}-live-logs.json').read_text()),
                                     {'stdout': 'live init stream\n', 'stderr': live})


if __name__ == '__main__':
    unittest.main()
