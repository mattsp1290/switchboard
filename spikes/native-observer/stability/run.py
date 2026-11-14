#!/usr/bin/env python3
import errno
import hashlib
import json
import os
import re
import selectors
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
OUT = HERE / 'local' / str(time.time_ns())
DOCKER = '/opt/homebrew/bin/docker'
ZIG = '/opt/homebrew/bin/zig'
IMAGE = 'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54'
ENV = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
       'DOCKER_HOST': 'unix:///Users/lunus/.colima/default/docker.sock',
       'ZIG_LOCAL_CACHE_DIR': str(OUT / 'zig-local'),
       'ZIG_GLOBAL_CACHE_DIR': str(OUT / 'zig-global')}
commands = []
containers = {}
images = {}
tag = None
stage = 'identities'
CAPTURE_LIMIT = 16 * 1024 * 1024


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2) + '\n')


def _capture(args, timeout, binary):
    streams = {name: dict(prefix=bytearray(), observed=0, eof=False, pipe=None, nonblocking=False)
               for name in ('stdout', 'stderr')}
    selector, failure, secondary = None, None, []

    def read(stream):
        budget = CAPTURE_LIMIT + 1 - stream['observed']
        if stream['eof'] or not budget or not stream['nonblocking']:
            return
        try:
            data = os.read(stream['pipe'].fileno(), min(65536, budget))
        except BlockingIOError:
            return
        stream['observed'] += len(data)
        stream['prefix'].extend(data[:CAPTURE_LIMIT - len(stream['prefix'])])
        if not data:
            stream['eof'] = True

    proc = subprocess.Popen(args, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=not binary)
    try:
        deadline = None if timeout is None else time.monotonic() + timeout
        selector = selectors.DefaultSelector()
        for name, stream in streams.items():
            stream['pipe'] = getattr(proc, name)
            os.set_blocking(stream['pipe'].fileno(), False)
            stream['nonblocking'] = True
            selector.register(stream['pipe'], selectors.EVENT_READ, stream)

        while selector.get_map():
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise subprocess.TimeoutExpired(args, timeout)
            for key, events in selector.select(remaining):
                read(key.data)
                if key.data['eof']:
                    selector.unregister(key.fileobj)
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(args, timeout)
            if any(stream['observed'] > CAPTURE_LIMIT for stream in streams.values()):
                raise OSError(errno.EOVERFLOW, 'command capture limit exceeded')
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise subprocess.TimeoutExpired(args, timeout)
        proc.wait(timeout=remaining)
        if deadline is not None and time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(args, timeout)
    except BaseException as error:
        failure = error
    finally:
        if failure is not None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            except BaseException as error:
                secondary.append(error)
            for stream in streams.values():
                try:
                    read(stream)
                except BaseException as error:
                    secondary.append(error)
        for name, stream in streams.items():
            try:
                getattr(proc, name).close()
            except BaseException as error:
                secondary.append(error)
        if selector is not None:
            try:
                selector.close()
            except BaseException as error:
                secondary.append(error)
        try:
            proc.wait()
        except BaseException as error:
            secondary.append(error)
    if failure is None and secondary:
        failure = secondary.pop(0)
    if failure is not None and isinstance(failure, Exception) and not isinstance(failure, subprocess.TimeoutExpired):
        cause = failure
        failure = OSError(errno.EOVERFLOW, f'command capture refused: {cause}')
        failure.__cause__ = cause
    capture = dict(limitBytes=CAPTURE_LIMIT, complete=failure is None, incomplete=failure is not None,
                   overflow=any(s['observed'] > CAPTURE_LIMIT for s in streams.values()))
    for name, stream in streams.items():
        raw = bytes(stream['prefix'])
        capture[name] = dict(retainedBytes=len(raw), retainedSha256=hashlib.sha256(raw).hexdigest(),
                             observedBytes=stream['observed'], eof=stream['eof'])
    stdout, stderr = (bytes(streams[name]['prefix']) for name in ('stdout', 'stderr'))
    if failure is not None:
        for error in secondary:
            failure.add_note(f'capture cleanup error: {error!r}')
        failure.output, failure.stderr, failure.capture = stdout, stderr, capture
        if isinstance(failure, subprocess.TimeoutExpired):
            failure.cmd, failure.timeout = args, timeout
        else:
            capture['reason'] = str(failure)
        raise failure
    if not binary:
        stdout, stderr = (raw.decode(getattr(proc, name).encoding, getattr(proc, name).errors)
                          .replace('\r\n', '\n').replace('\r', '\n')
                          for name, raw in (('stdout', stdout), ('stderr', stderr)))
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr), capture


def run(args, timeout=15, check=True, binary=False):
    try:
        result, capture = _capture(args, timeout, binary)
    except (subprocess.TimeoutExpired, OSError) as error:
        if not hasattr(error, 'capture'):
            raise
        stdout, stderr = error.output or b'', error.stderr or b''
        partial = {stream: f'command-{len(commands)}.{stream}.partial' for stream in ['stdout', 'stderr']}
        try:
            commands.append(dict(args=args, code=None, timedOut=isinstance(error, subprocess.TimeoutExpired),
                                 timeout=timeout, captureRefused=not isinstance(error, subprocess.TimeoutExpired),
                                 overflow=error.capture['overflow'], incomplete=True, capture=error.capture,
                                 partialFiles=partial,
                                 stdout={'prefixSha256': hashlib.sha256(stdout).hexdigest(), 'retainedBytes': len(stdout)}
                                 if binary else stdout.decode(errors='replace'), stderr=stderr.decode(errors='replace')))
            (OUT / partial['stdout']).write_bytes(stdout)
            (OUT / partial['stderr']).write_bytes(stderr)
            save('commands.json', commands)
        except OSError as evidence_error:
            if not isinstance(error, subprocess.TimeoutExpired):
                raise
            error.add_note(f'command evidence error: {evidence_error!r}')
        raise
    output = {'sha256': hashlib.sha256(result.stdout).hexdigest(), 'bytes': len(result.stdout)} if binary else result.stdout
    commands.append(dict(args=args, code=result.returncode, stdout=output,
                         stderr=result.stderr.decode() if binary else result.stderr, capture=capture))
    save('commands.json', commands)
    if check and result.returncode:
        raise RuntimeError(commands[-1])
    return result


def docker(*args, **kwargs):
    return run([DOCKER, '--config', str(OUT / 'docker-config'), *args], **kwargs)


def create(mode):
    cid = f'stability-prerequisite-{OUT.name}-{mode}'
    containers[cid] = 'uncertain'
    init_options = ['--env', 'TINI_VERBOSITY=3'] if mode.startswith('raw-') else []
    docker('create', '--name', cid, '--init', *init_options, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                 '--cap-add', 'SYS_CHROOT', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                 '--security-opt', 'no-new-privileges', '--security-opt', f'seccomp={HERE}/seccomp.json',
                 '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--ulimit', 'nofile=128:128',
                 '--workdir', '/', '--entrypoint', '/probe', tag, mode)
    containers[cid] = 'confirmed'
    started = docker('start', cid, check=False)
    if started.returncode:
        save(f'{mode}-failed-launch.json', json.loads(docker('inspect', cid).stdout))
        raise RuntimeError(started.stderr)
    return cid


def remove(cid, image=False):
    owned = images if image else containers
    inspect = ('image', 'inspect') if image else ('inspect',)
    removal = ('image', 'rm') if image else ('rm', '-f')
    missing = f'Error response from daemon: No such image: {cid}' if image else f'error: no such object: {cid}'
    for attempt in range(4):
        try:
            state = docker(*inspect, cid, check=False)
            if state.returncode == 0:
                owned[cid] = 'confirmed'
            elif (state.returncode == 1 and state.stdout.strip() == '[]'
                  and state.stderr.strip() == missing and owned[cid] == 'confirmed'):
                del owned[cid]
                return
        except (subprocess.TimeoutExpired, OSError):
            pass
        if attempt == 3:
            break
        try:
            if docker(*removal, cid, check=False).returncode == 0:
                owned[cid] = 'confirmed'
        except (subprocess.TimeoutExpired, OSError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f'Unresolved {"image" if image else "container"} ownership: {cid}')


def cleanup():
    errors = []
    for owned, image in [(containers, False), (images, True)]:
        for name in list(owned):
            try:
                remove(name, image=image)
            except Exception as error:
                errors.append(str(error))
    save('cleanup.json', {'containers': sorted(containers), 'image': tag if tag in images else None, 'errors': errors})


def check_notice_identity():
    recorded = json.loads((OUT / 'hashes.json').read_text())
    actual = {path.name: digest(path) for path in HERE.iterdir()
              if path.suffix in ('.c', '.py', '.json', '.md')}
    actual['prerequisite'] = digest(OUT / 'prerequisite')
    assert recorded == actual, 'notice source or binary changed'


def verify_notices(cid):
    check_notice_identity()
    result = docker('exec', cid, '/probe', 'notice-tests', check=False)
    (OUT / 'notice-controls.stdout').write_text(result.stdout)
    (OUT / 'notice-controls.stderr').write_text(result.stderr)
    assert result.returncode == 0, 'notice controls exited unsuccessfully'
    rows = re.findall(r'^NOTICE_TEST (\d+) ([a-z-]+) result=(\d+)$', result.stdout, re.M)
    expected = list(range(165))
    assert [int(row[0]) for row in rows] == expected, 'incomplete notice controls'
    assert all(row[2] == '1' for row in rows), 'notice control failed'
    assert len({row[1] for row in rows}) == len(expected), 'duplicate notice control name'
    assert result.stdout.count('\n') == 166 and result.stdout.endswith('NOTICE_TESTS count=165 failed=0\n')
    assert not result.stderr, 'unexpected notice control diagnostics'
    check_notice_identity()
    save('notice-controls.json', {'controlIds': expected, 'nativeRoutineObserved': True,
                                  'stdoutSha256': digest(OUT / 'notice-controls.stdout'),
                                  'stderrSha256': digest(OUT / 'notice-controls.stderr'),
                                  'sourceInventorySha256': digest(OUT / 'hashes.json'),
                                  'binarySha256': digest(OUT / 'prerequisite')})


def check_notice(mode, evidence):
    rows = re.findall(r'^NOTICE_RECEIPT.*$', evidence, re.M)
    assert len(rows) == 1, 'notice receipt missing or duplicate'
    match = re.fullmatch(r'NOTICE_RECEIPT root=([1-9][0-9]*) ready=([01])', rows[0])
    assert match and int(match[2]) == int(mode in ('death', 'raw-death')), 'invalid notice receipt'
    reaped = re.findall(r'^REAPED.*$', evidence, re.M)
    assert len(reaped) == 1 and re.fullmatch(rf'REAPED {match[1]} SUPERVISOR [1-9][0-9]*', reaped[0])
    return match[1]


def main(raw=False):
    global tag, stage
    assert digest(DOCKER) == 'd79e988b423edbe34460a2e4d86ecc841997f16c5e2a2ee5263f679d0c483a84'
    assert digest(ZIG) == '9fb480d3398506f5e2bef77f175766a8de0ee191dbdfbfb0c117a1150f141c91'
    assert run([ZIG, 'version']).stdout.strip() == '0.17.0'
    version = json.loads(docker('version', '--format', '{{json .}}').stdout)
    save('version.json', version)
    assert version['Client']['Version'] == '29.5.2'
    assert version['Server']['Version'] == '29.2.1' and version['Server']['GitCommit'] == '6bc6209'
    assert version['Server']['KernelVersion'] == '6.8.0-100-generic'
    components = {row['Name']: row for row in version['Server']['Components']}
    assert components['runc']['Version'] == '1.3.4'
    assert components['runc']['Details']['GitCommit'] == 'v1.3.4-0-gd6d73eb8'
    assert components['docker-init']['Version'] == '0.19.0'
    assert components['docker-init']['Details']['GitCommit'] == 'de40ad0'
    base = json.loads(docker('image', 'inspect', IMAGE).stdout)[0]
    save('base-image.json', base)
    assert base['Id'] == IMAGE.removeprefix('node@')
    assert base['Architecture'] == 'arm64' and base['Os'] == 'linux'
    stage = 'build'
    binary = OUT / 'prerequisite'
    run([ZIG, 'cc', '-target', 'aarch64-linux-musl', '-static', '-O2', '-Wall', '-Wextra', '-Werror',
         str(HERE / 'prerequisite.c'), '-o', str(binary)], timeout=60)
    hashes = {path.name: digest(path) for path in [binary, *sorted(
        path for path in HERE.iterdir() if path.suffix in ('.c', '.py', '.json', '.md'))]}
    if raw:
        from run_admission import inspect_binary
        inspect_binary(binary)
    save('hashes.json', hashes)
    root = OUT / 'build' / 'root'
    for directory in ['sealed/fixture', 'sealed/proc', 'sealed/sys', 'sealed/dev', 'outside']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, root / 'probe')
    (root / 'sealed/fixture/allowed').write_text('allowed\n')
    (root / 'outside/sentinel').write_text('outside\n')
    (root / 'sealed/fixture/escape').symlink_to('/outside')
    inventory = []
    for path in sorted(root.rglob('*')):
        row = {'path': str(path.relative_to(root)), 'mode': oct(path.lstat().st_mode & 0o777)}
        if path.is_symlink():
            row.update(kind='symlink', target=os.readlink(path))
        elif path.is_file():
            row.update(kind='file', sha256=digest(path))
        else:
            row.update(kind='directory')
        inventory.append(row)
    save('inventory.json', inventory)
    (OUT / 'build' / 'Dockerfile').write_text('FROM scratch\nCOPY root/ /\n')
    tag = 'stability-prerequisite:' + OUT.name
    images[tag] = 'uncertain'
    docker('build', '--network', 'none', '--pull=false', '-t', tag, str(OUT / 'build'), timeout=30)
    images[tag] = 'confirmed'
    save('image.json', json.loads(docker('image', 'inspect', tag).stdout))
    stage = 'init-launch'
    cid = create('hold')
    (OUT / 'docker-init').write_bytes(docker('exec', cid, '/probe', 'init', binary=True).stdout)
    init_hash = digest(OUT / 'docker-init')
    assert init_hash == 'd286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1', 'init identity changed'
    save('init.json', {'sha256': init_hash, 'version': '0.19.0', 'commit': 'de40ad0'})
    stage = 'notice-controls'
    verify_notices(cid)
    remove(cid)
    if raw:
        from run_admission import MODES, collect
        cases = []
        for mode in MODES:
            stage = mode
            cases.append(collect(create('raw-' + mode), mode, init_hash))
        save('result.json', {'status': 'SUPPORTED_SINGLE_TARGET_ADMISSION', 'cases': cases,
                             'stability': 'INCONCLUSIVE', 'scope': 'Single raw target only.'})
        return
    cases = []
    for mode in ['normal', 'inherited', 'death']:
        stage = mode
        cid = create(mode)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            logs = docker('logs', cid)
            if 'REAPED ' in logs.stderr or 'FAIL ' in logs.stderr:
                break
            time.sleep(0.03)
        (OUT / f'{mode}.evidence').write_text(logs.stderr)
        (OUT / f'{mode}.target').write_text(logs.stdout)
        assert 'FAIL ' not in logs.stderr, logs.stderr
        assert 'REAPED ' in logs.stderr, 'independent cleanup absent'
        check_notice(mode, logs.stderr)
        assert ('PREREQUISITES_OBSERVED' in logs.stderr) == (mode == 'normal')
        assert ('REJECT_INHERITED_FD' in logs.stderr) == (mode == 'inherited')
        assert logs.stdout == ('allowed\n' if mode == 'normal' else '')
        state = json.loads(docker('inspect', cid).stdout)[0]
        assert state['State']['Running'], 'container ended before independent inspection'
        (OUT / f'{mode}-init').write_bytes(docker('exec', cid, '/probe', 'init', binary=True).stdout)
        assert digest(OUT / f'{mode}-init') == init_hash, 'init changed'
        top = docker('top', cid, '-eo', 'pid,ppid,stat,comm').stdout
        (OUT / f'{mode}.top').write_text(top)
        assert len(top.splitlines()) == 3, 'unexpected survivor or zombie'
        assert 'docker-init' in top and 'probe' in top
        assert docker('wait', cid, timeout=8).stdout.strip() == '0'
        remove(cid)
        cases.append({'mode': mode, 'cleanup': 'target absent with live init before removal',
                      'initReaping': 'inferred from orphan disappearance' if mode == 'death' else 'tracer waitpid observed'})
    save('result.json', {'status': 'INCONCLUSIVE', 'prerequisites': 'observed', 'cases': cases,
                         'reason': 'Finite stability mechanism is not implemented.'})


def execute(raw=False):
    OUT.mkdir(parents=True)
    (OUT / 'docker-config').mkdir()
    save('commands.json', commands)
    try:
        main(raw)
    except Exception as error:
        save('result.json', {'status': 'INCONCLUSIVE', 'prerequisites': 'unavailable',
                             'stage': stage, 'error': str(error),
                             'nativeCleanup': 'unverified; inspect retained evidence'})
    finally:
        cleanup()
        report = json.loads((OUT / 'cleanup.json').read_text())
        result = json.loads((OUT / 'result.json').read_text())
        if report['errors'] or report['containers'] or report['image']:
            result.update(status='INCONCLUSIVE', cleanup='unresolved ownership')
        result.update(commandsSha256=digest(OUT / 'commands.json'),
                      cleanupSha256=digest(OUT / 'cleanup.json'))
        if (OUT / 'notice-controls.json').exists():
            try:
                check_notice_identity()
            except Exception as error:
                result.update(status='INCONCLUSIVE', noticeIdentity=str(error))
            result['noticeControlsSha256'] = digest(OUT / 'notice-controls.json')
        save('result.json', result)
        print(OUT)
        print((OUT / 'result.json').read_text())
        print((OUT / 'cleanup.json').read_text())


if __name__ == '__main__':
    execute()
