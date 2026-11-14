#!/usr/bin/env python3
import json
import re

import run as resources
import run_admission as admission

SCENARIOS = {
    'normal-first': ('normal', 0, 5, 0, 0, 0),
    'normal-stdio': ('normal', 7, 5, 0, 0, 13),
    'inherited-before9': ('inherited', 7, 4, 0, 0, 13),
    'inherited-after9': ('inherited', 15, 9, 0, 0, 0),
    'normal-open': ('normal', 7, 0, 5, 0, 0),
    'normal-entry': ('normal', 7, 0, 0, 5, 13),
    'inherited-open': ('inherited', 15, 0, 5, 0, 0),
    'inherited-entry': ('inherited', 15, 0, 0, 5, 13),
}
CASES = tuple(f'{family}/{name}' for family in ('raw', 'prerequisite') for name in SCENARIOS)
BASELINE_MODES = ('normal', 'inherited', 'bad-root', 'info-short', 'query-bad',
                  'query-short', 'registration', 'deadline', 'death')
HOLD_WAIT_TIMEOUT = 12
OUTCOME_RECORDS = {
    ('raw', 'refused'): 'RAW_OPTIONS RAW_CLEANUP OWNED_TARGET TARGET_BYTES',
    ('raw', 'inherited rejected'): 'RAW_OPTIONS OWNED_TARGET TARGET_BYTES TARGET REJECT_INHERITED_FD',
    ('raw', 'completed'): ('RAW_OPTIONS OWNED_TARGET TARGET_BYTES TARGET RAW_WAIT RAW_INFO RAW_INFO_BYTES '
                           'RAW_ENTRY RAW_EXIT ROBUST RSEQ MAP RAW_ADMISSION_OBSERVED'),
    ('prerequisite', 'refused'): '',
    ('prerequisite', 'inherited rejected'): 'TARGET REJECT_INHERITED_FD',
    ('prerequisite', 'completed'): 'TARGET ENTRY EXIT PATH PREREQUISITES_OBSERVED',
}
GOVERNED = ('RAW_', 'OWNED_TARGET', 'TARGET', 'REJECT_INHERITED_FD', 'PREREQUISITES_OBSERVED',
            'ROBUST', 'RSEQ', 'MAP', 'BLOCKED', 'ENTRY', 'EXIT', 'PATH', 'SUPERVISOR_DEADLINE')
SCHEMAS = {
    'FD_OPEN': 'actor parent target dir result error planted',
    'FD_READ': 'actor dir ordinal input name mask error injected planted',
    'FD_CLOSE': 'actor dir reads closes terminal input result error output',
    'FD_KILL': 'actor target signal result error',
    'FD_WAIT': 'actor target flags result error status',
    'FD_EXIT': 'actor code reads closes terminal mask kills waits',
}


def check_case(selector, evidence, output, code):
    assert selector in CASES, 'unknown selector'
    family, name = selector.split('/')
    mode, expected_mask, error, plant_open, plant_entry, close_error = SCENARIOS[name]
    raw, inherited = family == 'raw', mode == 'inherited'
    outcome = 'refused' if error else 'inherited rejected' if inherited else 'completed'
    allowed = set(OUTCOME_RECORDS[family, outcome].split())
    lines = evidence.split('\n')

    def witness(prefix, pattern):
        rows = [(index, row) for index, row in enumerate(lines)
                if row.lstrip().startswith(prefix)]
        assert len(rows) == 1, ('missing or duplicate witness', prefix)
        index, row = rows[0]
        match = re.fullmatch(pattern, row)
        assert index < len(lines) - 1 and match, ('invalid witness', prefix)
        return index, match

    events = {kind: [] for kind in SCHEMAS}
    for position, row in enumerate(lines):
        if row.lstrip().startswith(GOVERNED):
            assert row == row.lstrip() and position < len(lines) - 1 and '\r' not in row, 'native record framing'
            assert row.split(' ', 1)[0] in allowed, ('wrong family or outcome record', row)
        if row.lstrip().startswith('NOTICE'):
            assert row.split(' ', 1)[0] == 'NOTICE_RECEIPT', ('unknown native record', row)
        if not row.lstrip().startswith('FD_'):
            continue
        kind = row.split(' ', 1)[0]
        assert kind in SCHEMAS, ('unknown inventory record', row)
        fields = SCHEMAS[kind].split()
        grammar = {'dir': r'0x[1-9a-f][0-9a-f]*', 'name': r'(?:\.|\.\.|0|1|2|9|NULL)'}
        pattern = kind + ' case=' + re.escape(selector) + ''.join(
            ' ' + key + '=(' + grammar.get(key, r'(?:0|[1-9][0-9]*|-[1-9][0-9]*)') + ')'
            for key in fields)
        match = re.fullmatch(pattern, row)
        assert position < len(lines) - 1 and match, ('inventory framing', row)
        values = {key: value if key in grammar else int(value) for key, value in zip(fields, match.groups())}
        events[kind].append((position, values))

    def single(kind):
        assert len(events[kind]) == 1, ('inventory multiplicity', kind)
        return events[kind][0]

    opened, opening = single('FD_OPEN')
    closed, closing = single('FD_CLOSE')
    exited, ending = single('FD_EXIT')
    tracer, supervisor, target = (opening[key] for key in ('actor', 'parent', 'target'))
    assert len({tracer, supervisor, target}) == 3 and min(tracer, supervisor, target) > 0, 'process identities'
    assert opening['result'] == 1 and opening['error'] >= 0 and opening['planted'] == plant_open, 'actual open contamination'
    for kind in ('FD_READ', 'FD_CLOSE', 'FD_EXIT'):
        assert all(row['actor'] == tracer for _, row in events[kind]), 'inventory actor'
    assert all(row['dir'] == opening['dir'] for _, row in events['FD_READ'] + events['FD_CLOSE']), 'directory identity'
    reads = events['FD_READ']
    assert reads and opened < reads[0][0] < closed < exited, 'inventory lifetime'
    mask, names, descriptor_reads = 0, [], []
    for ordinal, (position, row) in enumerate(reads, 1):
        assert row['ordinal'] == ordinal and row['input'] == 0 and position < closed, 'read boundary'
        assert not names or names[-1] != 'NULL', 'read after termination'
        entry = row['name']
        if entry != 'NULL':
            assert entry not in names and row['injected'] == 0 and row['error'] == 0, 'real unique entry'
            assert row['planted'] == plant_entry, 'actual successful-entry contamination'
            if entry not in ('.', '..'):
                mask |= {'0': 1, '1': 2, '2': 4, '9': 8}[entry]
                descriptor_reads.append((position, entry))
        else:
            assert ordinal == len(reads) and row['error'] == error, 'terminal errno'
            assert row['injected'] == int(bool(error)) and row['planted'] == 0, 'actual trigger'
        assert row['mask'] == mask, 'observed mask'
        names.append(entry)
    terminal = reads[-1][0]
    assert names[-1] == 'NULL' and mask == expected_mask, 'complete selected inventory'
    if not error:
        assert {'.', '..'} <= set(names), 'natural directory entries'
    if name == 'normal-first':
        assert names == ['NULL'], 'before first entry'
    assert closing['error'] >= 0, 'close errno representation'
    assert closing == dict(actor=tracer, dir=opening['dir'], reads=len(reads), closes=1,
                           terminal=len(reads), input=error, result=0, error=closing['error'], output=close_error), 'single successful close'
    assert ending == dict(actor=tracer, code=90 if error else 0, reads=len(reads), closes=1,
                          terminal=len(reads), mask=mask, kills=ending['kills'], waits=ending['waits']), 'final scan totals'
    descriptors = [(i, re.fullmatch(r'FD (0|1|2|9) (.+)', row))
                   for i, row in enumerate(lines) if row.lstrip().startswith('FD')
                   and not row.lstrip().startswith(('FD_', 'FDSize:'))]
    assert len(descriptors) == len(descriptor_reads) and all(m and i < len(lines) - 1 for i, m in descriptors), 'descriptor inventory'
    channel_at, channel = witness('EVIDENCE_FD', r'EVIDENCE_FD (pipe:\[[1-9][0-9]*\]) OUTPUT_FD (pipe:\[[1-9][0-9]*\])')
    assert channel_at < opened, 'channel before open'
    assert channel[1] != channel[2], 'separate evidence writer'
    for (position, fd), (printed, match) in zip(descriptor_reads, descriptors):
        next_read = next(i for i, _ in reads if i > position)
        assert position < printed < next_read and match[1] == fd, 'actual entry inspected before next read'
        assert match[2] == ('/dev/null' if fd == '0' else '/outside/sentinel' if fd == '9' else channel[2]), 'descriptor identity'
        assert match[2] != channel[1], 'target evidence writer'
    status_rows = [(i, re.fullmatch(r'STATUS ([1-9][0-9]*)', row))
                   for i, row in enumerate(lines) if row.lstrip().startswith('STATUS')]
    assert len(status_rows) == 3 and all(m and i < len(lines) - 1 for i, m in status_rows), 'status inventory'
    assert {int(m[1]) for _, m in status_rows} == {tracer, supervisor, target}, 'status identities'
    assert all(i < opened for i, m in status_rows if int(m[1]) != supervisor), 'status before scan'
    waits = events['FD_WAIT']
    tracer_waits = [(i, row) for i, row in waits if row['actor'] == tracer]
    supervisor_waits = [(i, row) for i, row in waits if row['actor'] == supervisor]
    assert len(waits) == len(tracer_waits) + len(supervisor_waits), 'unexpected wait actor'
    assert len(supervisor_waits) == 1 and len(tracer_waits) >= 2, 'actual waits'
    for i, row in waits:
        owner = target if row['actor'] == tracer else tracer
        assert row['target'] == row['result'] == owner and row['error'] >= 0, 'wait ownership'
    initial, first = tracer_waits[0]
    assert first['flags'] == 1073741824 and first['status'] == 4991 and initial < opened, 'initial target stop'
    reaped, last = tracer_waits[-1]
    assert closed < reaped < exited and last['status'] == (9 if error or inherited else 0), 'target terminal wait'
    waited, supervisor_wait = supervisor_waits[0]
    assert supervisor_wait['flags'] == 1073741825 and supervisor_wait['status'] == (23040 if error else 0), 'tracer terminal wait'
    assert exited < waited, 'tracer exit before supervisor wait'
    assert ending['waits'] == len(tracer_waits), 'final wait totals'
    kills = events['FD_KILL']
    tracer_kills = [(i, row) for i, row in kills if row['actor'] == tracer]
    assert ending['kills'] == len(tracer_kills) == int(bool(error or inherited)), 'final kill totals'
    if error or inherited:
        assert len(tracer_waits) == 2 and last['flags'] == 1073741824, 'refusal waits'
        killed, kill = tracer_kills[0]
        assert closed < killed < reaped and kill['target'] == target and kill['signal'] == 9 and kill['result'] == 0 and kill['error'] >= 0, 'target kill'
    else:
        assert not kills, 'unexpected clean kill'
        for i, row in tracer_waits[1:-1]:
            assert closed < i < reaped and row['status'] == 34175, 'syscall stop'
        assert all(row['flags'] == (1073741825 if raw else 1073741824) for _, row in tracer_waits[1:]), 'work wait flags'
    setup, _ = witness('SUPERVISOR', r'SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0')
    assert setup < initial, 'supervisor setup'
    if error:
        failures = [(i, row) for i, row in enumerate(lines) if row.lstrip().startswith('FAIL')]
        assert len(failures) == (1 if raw else 2) and all(i < len(lines) - 1 for i, _ in failures), 'failure inventory'
        failed, failure = failures[0]
        assert failure == f'FAIL fd inventory complete errno={error}' and terminal < closed < failed < killed, 'original read refusal'
    else:
        assert not any(row.lstrip().startswith(('FAIL', 'SUPERVISOR_DEADLINE')) for row in lines), 'clean failure'
        continued, _ = witness('TARGET ', f'TARGET {target}')
        assert closed < continued < (killed if inherited else tracer_waits[1][0]), 'complete inventory continuation'
    if error and not raw:
        assert len(kills) == 2, 'fallback kill inventory'
        fallback, kill = next((i, row) for i, row in kills if row['actor'] == supervisor)
        assert exited < fallback < waited and kill['target'] == tracer and kill['signal'] == 9, 'actual fallback kill'
        assert (kill['result'] == 0 and kill['error'] >= 0) or (kill['result'], kill['error']) == (-1, 3), 'fallback result'
        assert failures[1][0] > waited and re.fullmatch(r'FAIL supervisor notices and cleanup errno=(0|[1-9][0-9]*)', failures[1][1]), 'supervisor refusal'
        assert not any(row.lstrip().startswith(('NOTICE', 'REAPED', 'TRACER_TERMINAL', 'OWNED_TARGET', 'RAW_', 'TARGET_BYTES')) for row in lines), 'false prerequisite receipt'
    else:
        assert len(kills) == len(tracer_kills), 'unexpected process operation'
        receipt, _ = witness('NOTICE_RECEIPT', f'NOTICE_RECEIPT root={target} ready=0')
        status, _ = witness('TRACER_TERMINAL', f'TRACER_TERMINAL {tracer} wait_status={23040 if error else 0}')
        absent, _ = witness('REAPED', f'REAPED {target} SUPERVISOR {supervisor}')
        assert waited < receipt < status < absent, 'completion receipts'
        assert resources.check_notice('raw-' + mode if raw else mode, evidence) == str(target), 'notice binding'
        if inherited and not error:
            rejected, _ = witness('REJECT_INHERITED_FD', 'REJECT_INHERITED_FD')
            assert reaped < rejected < exited, 'inherited refusal'
        if raw:
            ownership, _ = witness('OWNED_TARGET', f'OWNED_TARGET {target}')
            options, _ = witness('RAW_OPTIONS', r'RAW_OPTIONS mask=1048577 result=0')
            assert setup < ownership < initial < options < opened, 'raw setup'
            bytes_at, _ = witness('TARGET_BYTES', 'TARGET_BYTES ' + ('0 ' if error or inherited else '7 7261772d6f6b0a'))
            assert absent < bytes_at, 'target output framing'
            if error:
                cleaned, _ = witness('RAW_CLEANUP', f'RAW_CLEANUP target={target} reaped={target} status=9')
                assert reaped < cleaned < exited, 'actual raw cleanup'
            else:
                admission.check(mode, evidence, '')
                if not inherited:
                    maps = [(i, re.fullmatch(r'MAP ([0-9a-f]+)-([0-9a-f]+) [r-][w-][x-][ps] [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ (?:0|[1-9][0-9]*)(?: +(?:/[^\s]+|\[[a-z]+\]))? *', row))
                            for i, row in enumerate(lines) if row.startswith('MAP')]
                    assert maps and all(match for _, match in maps), 'map record framing'
                    previous_end = 0
                    for i, match in maps:
                        start, end = int(match[1], 16), int(match[2], 16)
                        assert continued < i < tracer_waits[1][0] and previous_end <= start < end, 'map inventory order'
                        previous_end = end
                    native_waits = [(i, int(row.split('=')[1])) for i, row in enumerate(lines) if row.startswith('RAW_WAIT status=')]
                    assert len(native_waits) == len(tracer_waits) - 1, 'raw wrapper coverage'
                    for (i, value), (before, row), (after, _) in zip(native_waits, tracer_waits[1:], tracer_waits[2:] + [(exited, {})]):
                        assert before < i < after and value == row['status'], 'raw native wait agreement'
        elif not inherited:
            complete, _ = witness('PREREQUISITES_OBSERVED', 'PREREQUISITES_OBSERVED')
            assert reaped < complete < exited, 'prerequisite completion'
            operations = [(i, row) for i, row in enumerate(lines) if row.lstrip().startswith(('ENTRY', 'EXIT'))]
            assert len(operations) == len(tracer_waits) - 2 and operations, 'prerequisite wrapper coverage'
            path_at, _ = witness('PATH', 'PATH /fixture/allowed')
            open_at, _ = witness('ENTRY 56 ', 'ENTRY 56 size=80 arch=c00000b7')
            current = None
            for ordinal, ((i, row), (before, _), (after, _)) in enumerate(zip(operations, tracer_waits[1:-1], tracer_waits[2:])):
                assert before < i < after, 'prerequisite wait before operation'
                pattern = r'ENTRY (56|57|63|64|94) size=80 arch=c00000b7' if ordinal % 2 == 0 else r'EXIT (56|57|63|64) result=(-?(?:0|[1-9][0-9]*)) size=33'
                match = re.fullmatch(pattern, row)
                assert match and i < len(lines) - 1, 'prerequisite operation framing'
                if ordinal % 2 == 0:
                    current = match[1]
                    if i == open_at:
                        assert i < path_at < after, 'pathname before open exit wait'
                else:
                    assert match[1] == current, 'prerequisite operation pairing'
            assert current == '94' and len(operations) % 2 == 1, 'prerequisite exit operation'
    assert code == (90 if error and not raw else 0), 'exec status'
    assert output == ('allowed\n' if not raw and not inherited and not error else ''), 'target output'
    return {'selector': selector, 'outcome': outcome,
            'tracer': tracer, 'supervisor': supervisor, 'target': target}


def collect_case(selector, init_hash):
    prefix = 'fd-' + selector.replace('/', '-')
    first_command = len(resources.commands)
    cid = resources.create('hold')
    family, name = selector.split('/')
    mode = SCENARIOS[name][0]
    actual_mode = 'raw-' + mode if family == 'raw' else mode
    command_index = len(resources.commands)
    completed = resources.docker('exec', '--env', 'FD_INVENTORY_CASE=' + selector,
                                 cid, '/probe', actual_mode, check=False, timeout=8, binary=True)
    (resources.OUT / (prefix + '.stdout')).write_bytes(completed.stdout)
    (resources.OUT / (prefix + '.stderr')).write_bytes(completed.stderr)
    result = check_case(selector, completed.stderr.decode('ascii'), completed.stdout.decode('ascii'), completed.returncode)
    resources.save(prefix + '-exec.json', {'code': completed.returncode, 'command': command_index, 'container': cid})
    state = json.loads(resources.docker('inspect', cid).stdout)[0]
    resources.save(prefix + '-state.json', state)
    assert state['State']['Running'], 'init ended before live inventory'
    init = resources.OUT / (prefix + '-init')
    init.write_bytes(resources.docker('exec', cid, '/probe', 'init', binary=True).stdout)
    assert resources.digest(init) == init_hash, 'executed init changed'
    top = resources.docker('top', cid, '-eo', 'pid,ppid,stat,comm').stdout
    (resources.OUT / (prefix + '.top')).write_text(top)
    rows = top.splitlines()
    assert len(rows) == 3 and rows[0].split() == ['PID', 'PPID', 'STAT', 'COMMAND'], 'process inventory'
    processes = [row.split() for row in rows[1:]]
    assert all(len(row) == 4 and re.fullmatch(r'[1-9][0-9]*', row[0]) and re.fullmatch(r'[0-9]+', row[1])
               and re.fullmatch(r'[RS][<Ns+l]*', row[2]) for row in processes), 'survivor or zombie'
    assert [row[3] for row in processes] == ['docker-init', 'probe'], 'live init and hold only'
    assert processes[1][1] == processes[0][0] and processes[0][0] != processes[1][0], 'hold parent identity'
    assert resources.docker('wait', cid, timeout=HOLD_WAIT_TIMEOUT).stdout.strip() == '0', 'hold failed'
    logs = resources.docker('logs', cid, binary=True)
    (resources.OUT / (prefix + '-hold.stdout')).write_bytes(logs.stdout)
    (resources.OUT / (prefix + '-hold.stderr')).write_bytes(logs.stderr)
    resources.remove(cid)
    assert cid not in resources.containers, 'hold ownership unresolved'
    result.update(container=cid, command=command_index, commandRange=[first_command, len(resources.commands)],
                  evidence={path.name: resources.digest(path) for path in sorted(resources.OUT.glob(prefix + '*'))})
    return result


def main():
    shim = resources.HERE / 'fd_inventory_eio.c'
    compile_args = [str(shim), *(f'-Wl,--wrap={name}' for name in
                               ('opendir', 'readdir', 'closedir', 'kill', 'waitpid', '_exit'))]
    anchors = {}

    def inventory_suite(raw):
        nonlocal anchors
        assert raw is True, 'raw baseline required'
        baseline = resources.main(raw=True, compile_args=compile_args)
        assert baseline and baseline['status'] == 'SUPPORTED_SINGLE_TARGET_ADMISSION', 'raw baseline unavailable'
        assert admission.MODES == BASELINE_MODES, 'original raw inventory changed'
        assert [row['mode'] for row in baseline['cases']] == list(BASELINE_MODES), 'all nine raw controls required'
        init = json.loads((resources.OUT / 'init.json').read_text())
        assert resources.digest(resources.OUT / 'docker-init') == init['sha256'], 'retained init identity'
        names = ['hashes.json', 'prerequisite', 'notice-controls.json', 'notice-controls.stdout',
                 'notice-controls.stderr', 'raw-instructions.json', 'init.json', 'docker-init']
        names += [path.name for path in resources.OUT.glob('raw-*') if path.is_file()]
        anchors = {name: resources.digest(resources.OUT / name) for name in names}
        matrix = []
        result = dict(baseline, status='INCONCLUSIVE', inventoryCases=matrix)
        try:
            for selector in CASES:
                resources.stage = selector
                matrix.append(collect_case(selector, init['sha256']))
        except Exception as error:
            result.update(error=str(error), stage=resources.stage)
        return result

    def validate_inventory_result(data):
        assert not any(key in data for key in ('error', 'noticeIdentity', 'cleanup', 'nativeCleanup', 'refusal')), 'owner refused'
        matrix = data['inventoryCases']
        ledger = json.loads((resources.OUT / 'commands.json').read_text())
        compilations = [row for row in ledger if row['args'][:2] == [resources.ZIG, 'cc']]
        assert len(compilations) == 1 and compilations[0]['code'] == 0, 'exactly one successful compilation required'
        args = compilations[0]['args']
        assert args.count(str(resources.HERE / 'prerequisite.c')) == 1 and args[-len(compile_args):] == compile_args, 'native compile inputs'
        assert [row['mode'] for row in data['cases']] == list(BASELINE_MODES), 'final raw inventory'
        assert [row['selector'] for row in matrix] == list(CASES), 'exact inventory matrix'
        assert not resources.containers and not resources.images, 'unresolved ownership'
        cleanup = json.loads((resources.OUT / 'cleanup.json').read_text())
        assert cleanup == {'containers': [], 'image': None, 'errors': []}, 'cleanup refused'
        for field, path in [('commandsSha256', 'commands.json'), ('cleanupSha256', 'cleanup.json'),
                            ('noticeControlsSha256', 'notice-controls.json')]:
            assert data[field] == resources.digest(resources.OUT / path), ('final digest', path)
        resources.check_notice_identity()
        notice = json.loads((resources.OUT / 'notice-controls.json').read_text())
        assert notice['controlIds'] == list(range(165)) and notice['nativeRoutineObserved'] is True, 'notice inventory'
        for field, path in [('stdoutSha256', 'notice-controls.stdout'), ('stderrSha256', 'notice-controls.stderr'),
                            ('sourceInventorySha256', 'hashes.json'), ('binarySha256', 'prerequisite')]:
            assert notice[field] == resources.digest(resources.OUT / path), ('notice identity', path)
        instructions = json.loads((resources.OUT / 'raw-instructions.json').read_text())
        assert instructions['instructions'] == 36 and instructions['syscalls'] == [96, 172, 99, 63, 64, 93], 'instruction inventory'
        assert instructions['binarySha256'] == resources.digest(resources.OUT / 'prerequisite'), 'instruction binary'
        for name, expected in anchors.items():
            assert resources.digest(resources.OUT / name) == expected, ('baseline evidence changed', name)
        for case in matrix:
            assert case['evidence'], 'case evidence missing'
            for name, expected in case['evidence'].items():
                assert resources.digest(resources.OUT / name) == expected, ('inventory evidence changed', name)
        data.update(status='FD_INVENTORY_CONTROLS_OBSERVED', evidence=anchors,
                    sourceInventory='hashes.json', binary='prerequisite', init='init.json',
                    notices='notice-controls.json', commands='commands.json', cleanupReport='cleanup.json',
                    scope='Sixteen injected inventory controls. Separate current-source prerequisite run required.')
        return data

    result = resources.execute(raw=True, suite=inventory_suite, finalize=validate_inventory_result)
    return 0 if result['status'] == 'FD_INVENTORY_CONTROLS_OBSERVED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
