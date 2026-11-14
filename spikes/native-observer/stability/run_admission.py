#!/usr/bin/env python3
import json
import re
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


def check(mode, evidence, init):
    owned = re.findall(r'^OWNED_TARGET.*$', evidence, re.M)
    assert len(owned) == 1, 'missing or duplicate target ownership'
    ownership = re.fullmatch(r'OWNED_TARGET ([1-9][0-9]*)', owned[0])
    assert ownership, 'invalid target ownership'
    pid = ownership[1]
    assert resources.check_notice('raw-' + mode, evidence) == pid, 'notice ownership differs'
    assert 'SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0\n' in evidence
    assert 'SUPERVISOR_DEADLINE' not in evidence, 'supervisor deadline expired'
    errors = re.findall(r'^FAIL (.*?) errno=\d+$', evidence, re.M)
    assert errors == ([FAILURES[mode]] if mode in FAILURES else []), errors
    expected = '7 7261772d6f6b0a' if mode == 'normal' else '0 '
    assert re.findall(r'^TARGET_BYTES (.*)$', evidence, re.M) == [expected], 'target output differs'
    terminals = re.findall(r'^TRACER_TERMINAL \d+ wait_status=(\d+)$', evidence, re.M)
    assert terminals == [str(9 if mode == 'death' else 90 << 8 if mode in FAILURES else 0)]
    if mode in FAILURES:
        assert re.search(rf'^RAW_CLEANUP target={pid} reaped={pid} status=9$', evidence, re.M)
    if mode == 'inherited':
        assert 'FD 9 /outside/sentinel\n' in evidence and 'REJECT_INHERITED_FD\n' in evidence
    if mode == 'bad-root':
        assert 'LINK cwd /sealed/fixture\n' in evidence and 'RAW_ENTRY ' not in evidence
    if mode == 'inherited':
        assert 'RAW_ENTRY ' not in evidence
    if mode == 'info-short':
        assert 'RAW_INFO requested=1 returned=80 op=1 arch=0\n' in evidence
        assert 'RAW_INFO_BYTES 01\n' in evidence
    if mode == 'query-bad':
        assert re.search(r'^ROBUST result=-1 errno=14 ', evidence, re.M)
    if mode == 'query-short':
        assert 'RSEQ requested=1 returned=24 ' in evidence
    if mode in ('normal', 'registration', 'deadline', 'death', 'query-bad', 'query-short'):
        assert 'RAW_OPTIONS mask=1048577 result=0\n' in evidence
        assert re.search(r'^RAW_ENTRY step=0 nr=96 args=0,0,0,', evidence, re.M)
        assert re.search(rf'^RAW_EXIT step=0 result={pid} error=0$', evidence, re.M)
    if mode in ('normal', 'registration', 'deadline', 'death'):
        assert re.search(r'^ROBUST result=0 errno=\d+ pointer=0 size=24 expected=24$', evidence, re.M)
        assert 'RSEQ requested=24 returned=24 pointer=0 size=0 signature=0 flags=0 pad=0\n' in evidence
    if mode == 'registration':
        assert 'RAW_REJECT_REGISTRATION_BEFORE_EXECUTION\n' in evidence
        assert 'RAW_EXIT step=2 ' not in evidence
    if mode == 'deadline':
        assert 'RAW_DEADLINE step=2 entering=0\n' in evidence
        assert re.search(r'^BLOCKED_READ nr=63 fd=0 pointer=[0-9a-f]+ size=1$', evidence, re.M)
        assert re.search(r'^BLOCKED_PIPE pipe:\[\d+\] supervisor_writer=\d+ target_reader=0$', evidence, re.M)
        assert 'RAW_EXIT step=2 ' not in evidence
    if mode == 'normal':
        assert 'RAW_ADMISSION_OBSERVED\n' in evidence
        assert 'RAW_EXIT step=2 result=7 error=0\n' in evidence
    else:
        assert 'RAW_ADMISSION_OBSERVED\n' not in evidence
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
