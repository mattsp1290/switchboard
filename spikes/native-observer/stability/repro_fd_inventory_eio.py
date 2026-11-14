#!/usr/bin/env python3
import json
import re


def check_refusal(mode, evidence, init):
    assert mode == 'normal', 'only raw-normal is covered'
    lines = evidence.split('\n')

    def witness(prefix, pattern):
        rows = [(index, row) for index, row in enumerate(lines)
                if row.lstrip().startswith(prefix)]
        assert len(rows) == 1, ('missing or duplicate witness', prefix)
        index, row = rows[0]
        match = re.fullmatch(pattern, row)
        assert index < len(lines) - 1 and match, ('invalid witness', prefix)
        return index, match

    injection, _ = witness('FD_INVENTORY_INJECTED_EIO', 'FD_INVENTORY_INJECTED_EIO stdio=7')
    descriptors = [(index, re.fullmatch(r'FD ([0-2]) (.+)', row))
                   for index, row in enumerate(lines) if row.lstrip().startswith('FD ')]
    assert len(descriptors) == 3 and all(match for _, match in descriptors), 'stdio inventory'
    assert {match[1] for _, match in descriptors} == {'0', '1', '2'}, 'stdio descriptor identities'
    assert all(index < injection for index, _ in descriptors), 'injection preceded stdio inspection'
    assert 'RAW_ADMISSION_OBSERVED' not in evidence, 'injected fd inventory error was admitted'
    ownership, owned = witness('OWNED_TARGET', r'OWNED_TARGET ([1-9][0-9]*)')
    pid = owned[1]
    import run as resources
    assert resources.check_notice('raw-normal', evidence) == pid, 'notice ownership differs'
    patterns = {
        'SUPERVISOR': r'SUPERVISOR subreaper=0 SIGCHLD=default NOCLDWAIT=0',
        'RAW_OPTIONS': r'RAW_OPTIONS mask=1048577 result=0',
        'FAIL': r'FAIL fd inventory complete errno=5',
        'RAW_CLEANUP': f'RAW_CLEANUP target={pid} reaped={pid} status=9',
        'NOTICE_RECEIPT': f'NOTICE_RECEIPT root={pid} ready=0',
        'TRACER_TERMINAL': r'TRACER_TERMINAL [1-9][0-9]* wait_status=23040',
        'REAPED': rf'REAPED {pid} SUPERVISOR [1-9][0-9]*',
        'TARGET_BYTES': r'TARGET_BYTES 0 ',
    }
    positions = {prefix: witness(prefix, pattern)[0] for prefix, pattern in patterns.items()}
    order = [positions['SUPERVISOR'], ownership, positions['RAW_OPTIONS'],
             *(index for index, _ in descriptors), injection,
             *(positions[prefix] for prefix in tuple(patterns)[2:])]
    assert all(left < right for left, right in zip(order, order[1:])), 'refusal witness order'
    forbidden = ('RAW_WAIT', 'RAW_INFO', 'RAW_ENTRY', 'RAW_EXIT', 'RAW_DEADLINE',
                 'RAW_REJECT', 'ROBUST', 'RSEQ', 'MAP ', 'TARGET ', 'BLOCKED_',
                 'REJECT_INHERITED_FD', 'PREREQUISITES_OBSERVED', 'SUPERVISOR_DEADLINE')
    assert not any(row.lstrip().startswith(forbidden) for row in lines), 'work preceded refusal'
    return {'mode': mode, 'outcome': 'fd inventory EIO refused before raw work',
            'cleanup': 'same target waitpid and independent disappearance with live init'}


def main():
    import run as resources
    import run_admission as admission

    original_run, original_save = resources.run, resources.save
    shim = resources.HERE / 'fd_inventory_eio.c'
    compile_count = 0

    def run_with_injection(args, **kwargs):
        nonlocal compile_count
        if args[:2] == [resources.ZIG, 'cc']:
            assert compile_count == 0, 'unexpected second compilation'
            assert args.count(str(resources.HERE / 'prerequisite.c')) == 1, 'wrong native helper'
            compile_count += 1
            args = [*args, str(shim), '-Wl,--wrap=readdir']
        return original_run(args, **kwargs)

    def save_scoped(name, data):
        if name == 'result.json':
            data = dict(data)
            if data.get('status') == 'SUPPORTED_SINGLE_TARGET_ADMISSION':
                assert compile_count == 1 and len(data['cases']) == 1, 'unexpected regression case count'
                data['status'] = 'FD_INVENTORY_ERROR_REFUSED'
            data.update(regression='readdir EIO after real stdio entries',
                        scope='Injected raw-normal inventory failure only. Stability remains inconclusive.')
        return original_save(name, data)

    resources.run = run_with_injection
    resources.save = save_scoped
    admission.MODES = ('normal',)
    admission.check = check_refusal
    resources.execute(raw=True)
    result = json.loads((resources.OUT / 'result.json').read_text())
    return 0 if result['status'] == 'FD_INVENTORY_ERROR_REFUSED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
