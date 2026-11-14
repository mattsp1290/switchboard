#!/usr/bin/env python3
import json
import re
import struct
import time
import run as resources

MODES = ('normal', 'inherited', 'bad-root', 'info-short', 'query-bad',
         'query-short', 'registration', 'deadline', 'death')
FAILURES = {'bad-root': 'link identity', 'info-short': 'raw syscall info size',
            'query-bad': 'robust absence query', 'query-short': 'rseq absence query',
            'registration': 'unsupported registration', 'deadline': 'raw deadline'}


def inspect_binary(binary):
    tool = '/Library/Developer/CommandLineTools/usr/bin/llvm-objdump'
    assert resources.digest(tool) == '1dcc1432db4d828cf8cd71a84cb8d9bf63a7ca80b5eeec711a9e5f13a3f5f98e'
    headers = resources.run([tool, '--private-headers', str(binary)]).stdout
    (resources.OUT / 'elf-headers.txt').write_text(headers)
    assert headers.rstrip().endswith('Dynamic Section:') and not re.search(r'^\s*INTERP ', headers, re.M)
    inventory = resources.run([tool, '--section-headers', '--syms', str(binary)]).stdout
    (resources.OUT / 'linked-inventory.txt').write_text(inventory)
    assembly = resources.run([tool, '--disassemble-symbols=raw_target', str(binary)]).stdout
    (resources.OUT / 'raw-target.disassembly').write_text(assembly)
    instructions = re.findall(r'^[ \t]*([0-9a-f]+):[ \t]+[0-9a-f]{8}[ \t]+([a-z0-9.]+)[ \t]*(.*)$', assembly, re.M)
    assert len(instructions) == 36, 'raw instruction inventory changed'
    assert [name for _, name, _ in instructions].count('svc') == 6
    addresses = {int(address, 16) for address, _, _ in instructions}
    calls = []
    for _, name, operands in instructions:
        assert name in ('mov', 'svc', 'cbz', 'adrp', 'add', 'nop', 'adr'), (name, operands)
        if name == 'cbz':
            assert int(re.search(r'0x([0-9a-f]+)', operands)[1], 16) in addresses, 'branch leaves raw body'
        if name == 'mov' and operands.startswith('w8,'):
            calls.append(int(re.search(r'#0x([0-9a-f]+)', operands)[1], 16))
    assert calls == [96, 172, 99, 63, 64, 93], calls
    resources.save('raw-instructions.json', {'toolSha256': resources.digest(tool),
                   'binarySha256': resources.digest(binary), 'syscalls': calls, 'instructions': len(instructions)})


_RAW_STOPS = dict(zip(MODES, ('EXEXEXET', '', '', 'S', 'EX', 'EX', 'EXEXE', 'EXEXE', 'EXE')))


def _raw_evidence(mode, evidence, owned_pid):
    assert mode in _RAW_STOPS, 'unknown raw mode'
    number = r'(?:0|[1-9][0-9]*)'
    queried = mode in ('normal', 'query-bad', 'query-short', 'registration', 'deadline', 'death')
    anchors = {
        'RAW_OPTIONS': r'RAW_OPTIONS mask=1048577 result=0',
        'SUPERVISOR': r'SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0',
        'ROBUST': (r'ROBUST result=-1 errno=14 pointer=0x1 size=0 expected=24' if mode == 'query-bad'
                   else rf'ROBUST result=0 errno={number} pointer=0 size=24 expected=24') if queried else None,
        'RSEQ': (f'RSEQ requested={1 if mode == "query-short" else 24} returned=24 '
                 'pointer=0 size=0 signature=0 flags=0 pad=0') if queried and mode != 'query-bad' else None,
        'RAW_ADMISSION_OBSERVED': 'RAW_ADMISSION_OBSERVED' if mode == 'normal' else None,
        'RAW_REJECT_REGISTRATION_BEFORE_EXECUTION': 'RAW_REJECT_REGISTRATION_BEFORE_EXECUTION'
                                                   if mode == 'registration' else None,
        'BLOCKED_READ': r'BLOCKED_READ nr=63 fd=0 pointer=(0|[1-9a-f][0-9a-f]{0,15}) size=1' if mode == 'deadline' else None,
        'BLOCKED_PIPE': r'BLOCKED_PIPE pipe:\[[1-9][0-9]*\] supervisor_writer=[1-9][0-9]* target_reader=0'
                        if mode == 'deadline' else None,
        'RAW_DEADLINE': 'RAW_DEADLINE step=2 entering=0' if mode == 'deadline' else None,
        'REJECT_INHERITED_FD': 'REJECT_INHERITED_FD' if mode == 'inherited' else None,
        'FAIL': rf'FAIL {FAILURES[mode]} errno={number}' if mode in FAILURES else None,
        'RAW_CLEANUP': f'RAW_CLEANUP target={owned_pid} reaped={owned_pid} status=9' if mode in FAILURES else None,
        'NOTICE_RECEIPT': f'NOTICE_RECEIPT root={owned_pid} ready={int(mode == "death")}',
        'TRACER_TERMINAL': rf'TRACER_TERMINAL [1-9][0-9]* wait_status={9 if mode == "death" else 23040 if mode in FAILURES else 0}',
        'REAPED': rf'REAPED {owned_pid} SUPERVISOR [1-9][0-9]*',
        'OWNED_TARGET': f'OWNED_TARGET {owned_pid}',
        'TARGET_BYTES': 'TARGET_BYTES ' + ('7 7261772d6f6b0a' if mode == 'normal' else '0 '),
    }
    core = ('RAW_INFO_BYTES', 'RAW_INFO', 'RAW_WAIT', 'RAW_ENTRY', 'RAW_EXIT')
    rows, witnesses = [], {}
    lines = evidence.split('\n')
    for position, row in enumerate(lines):
        terminated = position < len(lines) - 1
        candidate = row.lstrip()
        if candidate.startswith(core):
            assert row == candidate and terminated and '\r' not in row, ('raw row framing', position)
            rows.append((position, row))
        else:
            for prefix, pattern in anchors.items():
                if candidate.startswith(prefix):
                    match = re.fullmatch(pattern, row) if pattern is not None else None
                    assert terminated and match and prefix not in witnesses, ('raw witness', prefix, position)
                    witnesses[prefix] = (position, match)
                    break
    assert set(witnesses) == {key for key, pattern in anchors.items() if pattern is not None}, 'raw witness inventory'
    spans, cursor = [], 0
    for index, kind in enumerate(_RAW_STOPS[mode]):
        count = 1 if kind == 'T' else 3 if kind == 'S' else 4
        block = rows[cursor:cursor + count]
        assert len(block) == count, ('missing raw block', mode, index)
        lines = tuple(row for _, row in block)
        assert lines[0] == f'RAW_WAIT status={0 if kind == "T" else 34175}', ('raw wait', block[0][0])
        if kind == 'S':
            assert lines[1:] == ('RAW_INFO requested=1 returned=80 op=1 arch=0', 'RAW_INFO_BYTES 01'), 'short info'
        elif kind != 'T':
            entry, step = kind == 'E', index // 2
            size, operation = (80, 1) if entry else (33, 2)
            assert lines[1] == f'RAW_INFO requested=88 returned={size} op={operation} arch=c00000b7', 'raw header'
            encoded = re.fullmatch(rf'RAW_INFO_BYTES ([0-9a-f]{{{size * 2}}})', lines[2])
            assert encoded, 'raw byte grammar'
            payload = bytes.fromhex(encoded[1])
            observed_op, _padding, arch, _ip, _sp = struct.unpack_from('<B3sIQQ', payload)
            assert observed_op == operation and arch == 0xc00000b7, 'raw layout'
            if entry:
                words = struct.unpack_from('<7Q', payload, 24)
                syscall, args = words[0], words[1:]
                assert lines[3] == f'RAW_ENTRY step={step} nr={syscall} args=' + ','.join(map(str, args)), 'raw entry agreement'
                expected = 99 if mode == 'registration' and step == 2 else 63 if mode == 'deadline' and step == 2 else (96, 172, 64, 93)[step]
                assert syscall == expected, 'raw syscall recipe'
                if not (mode == 'registration' and step == 2):
                    pointer = int(witnesses['BLOCKED_READ'][1][1], 16) if mode == 'deadline' and step == 2 else args[1]
                    expected_args = (0, pointer, 1) if mode == 'deadline' else (1, pointer, 7)
                    assert tuple(args[:3]) == (expected_args if step == 2 else (0, 0, 0)), 'raw argument recipe'
            else:
                result, error = struct.unpack_from('<qB', payload, 24)
                assert error in (0, 1), 'raw error representation'
                assert lines[3] == f'RAW_EXIT step={step} result={result} error={error}', 'raw exit agreement'
                assert result == (owned_pid if step < 2 else 7) and error == 0, 'raw result recipe'
        spans.append((block[0][0], block[-1][0]))
        cursor += count
    assert cursor == len(rows), 'extra raw records'
    positions = {name: value[0] for name, value in witnesses.items()}
    assert positions['SUPERVISOR'] < positions['OWNED_TARGET'] < positions['RAW_OPTIONS'], 'raw setup order'
    if mode == 'deadline':
        assert positions['SUPERVISOR'] < positions['BLOCKED_PIPE'] < positions['OWNED_TARGET'], 'blocked pipe order'
    if spans:
        assert positions['RAW_OPTIONS'] < spans[0][0], 'options after raw wait'
    if queried:
        assert spans[1][1] < positions['ROBUST'], 'query before clear exit'
        if mode != 'query-bad':
            assert positions['ROBUST'] < positions['RSEQ'], 'rseq before robust'
        if len(spans) > 2:
            assert positions['RSEQ'] < spans[2][0], 'query after next wait'
    end = spans[-1][1] if spans else positions['RAW_OPTIONS']
    tail = []
    if mode == 'query-bad':
        tail = ['ROBUST']
    elif mode == 'query-short':
        tail = ['ROBUST', 'RSEQ']
    elif mode == 'normal':
        tail = ['RAW_ADMISSION_OBSERVED']
    elif mode == 'inherited':
        tail = ['REJECT_INHERITED_FD']
    elif mode == 'registration':
        tail = ['RAW_REJECT_REGISTRATION_BEFORE_EXECUTION']
    elif mode == 'deadline':
        tail = ['BLOCKED_READ', 'RAW_DEADLINE']
    if mode in FAILURES:
        tail += ['FAIL', 'RAW_CLEANUP']
    tail += ['NOTICE_RECEIPT', 'TRACER_TERMINAL', 'REAPED', 'TARGET_BYTES']
    order = [end, *(positions[name] for name in tail)]
    assert all(left < right for left, right in zip(order, order[1:])), 'raw completion order'


def check(mode, evidence, init):
    owned = re.findall(r'^OWNED_TARGET.*$', evidence, re.M)
    assert len(owned) == 1, 'missing or duplicate target ownership'
    ownership = re.fullmatch(r'OWNED_TARGET ([1-9][0-9]*)', owned[0])
    assert ownership, 'invalid target ownership'
    pid = ownership[1]
    assert resources.check_notice('raw-' + mode, evidence) == pid, 'notice ownership differs'
    _raw_evidence(mode, evidence, int(pid))
    assert 'SUPERVISOR_DEADLINE' not in evidence, 'supervisor deadline expired'
    if mode == 'inherited':
        assert 'FD 9 /outside/sentinel\n' in evidence
    if mode == 'bad-root':
        assert 'LINK cwd /sealed/fixture\n' in evidence
    if mode == 'death':
        assert len(re.findall(rf"Reaped child with pid: '{pid}'(?:\r?\n|$)", init)) == 1, 'actual init reaping witness absent'
    return {'mode': mode, 'outcome': 'admitted' if mode == 'normal' else 'control observed',
            'cleanup': 'independent disappearance and live-init inventory',
            'initReaping': 'matched actual init waitpid log' if mode == 'death' else 'tracer waitpid'}


def collect(cid, mode, init_hash):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        logs = resources.docker('logs', cid)
        if 'REAPED ' in logs.stderr:
            break
        time.sleep(0.03)
    resources.save(f'raw-{mode}-live-logs.json', {'stdout': logs.stdout, 'stderr': logs.stderr})
    assert 'REAPED ' in logs.stderr, 'cleanup not observed before deadline'
    state = json.loads(resources.docker('inspect', cid).stdout)[0]
    resources.save(f'raw-{mode}-live-state.json', state)
    assert state['State']['Running'], 'init ended before live inventory'
    init_path = resources.OUT / f'raw-{mode}-init'
    init_path.write_bytes(resources.docker('exec', cid, '/probe', 'init', binary=True).stdout)
    assert resources.digest(init_path) == init_hash, 'executed init changed'
    top = resources.docker('top', cid, '-eo', 'pid,ppid,stat,comm').stdout
    (resources.OUT / f'raw-{mode}.top').write_text(top)
    assert len(top.splitlines()) == 3 and 'docker-init' in top and 'probe' in top, 'survivor or zombie'
    assert resources.docker('wait', cid, timeout=8).stdout.strip() == '0', 'supervisor failure'
    complete = resources.docker('logs', cid)
    (resources.OUT / f'raw-{mode}.init').write_text(complete.stdout)
    (resources.OUT / f'raw-{mode}.evidence').write_text(complete.stderr)
    result = check(mode, complete.stderr, complete.stdout)
    resources.remove(cid)
    return result


if __name__ == '__main__':
    resources.execute(raw=True)
