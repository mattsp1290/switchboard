#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
OUT = HERE / 'local' / str(time.time_ns())
OUT.mkdir(parents=True)
(OUT / 'docker-config').mkdir()
DOCKER = '/opt/homebrew/bin/docker'
ZIG = '/opt/homebrew/bin/zig'
IMAGE = 'node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54'
ENV = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
       'DOCKER_HOST': 'unix:///Users/lunus/.colima/default/docker.sock',
       'ZIG_LOCAL_CACHE_DIR': str(OUT / 'zig-local'),
       'ZIG_GLOBAL_CACHE_DIR': str(OUT / 'zig-global')}
commands = []
containers = set()
tag = None
stage = 'identities'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2) + '\n')


def run(args, timeout=15, check=True, binary=False):
    result = subprocess.run(args, env=ENV, capture_output=True, text=not binary, timeout=timeout)
    output = {'sha256': hashlib.sha256(result.stdout).hexdigest(), 'bytes': len(result.stdout)} if binary else result.stdout
    commands.append(dict(args=args, code=result.returncode, stdout=output,
                         stderr=result.stderr.decode() if binary else result.stderr))
    save('commands.json', commands)
    if check and result.returncode:
        raise RuntimeError(commands[-1])
    return result


def docker(*args, **kwargs):
    return run([DOCKER, '--config', str(OUT / 'docker-config'), *args], **kwargs)


def create(mode):
    cid = docker('create', '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                 '--cap-add', 'SYS_CHROOT', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                 '--security-opt', 'no-new-privileges', '--security-opt', f'seccomp={HERE}/seccomp.json',
                 '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--ulimit', 'nofile=128:128',
                 '--workdir', '/', '--entrypoint', '/probe', tag, mode).stdout.strip()
    containers.add(cid)
    started = docker('start', cid, check=False)
    if started.returncode:
        save(f'{mode}-failed-launch.json', json.loads(docker('inspect', cid).stdout))
        raise RuntimeError(started.stderr)
    return cid


def remove(cid):
    docker('rm', '-f', cid)
    containers.remove(cid)
    assert docker('inspect', cid, check=False).returncode != 0, 'container still exists'


def main():
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
    hashes = {path.name: digest(path) for path in [HERE / 'prerequisite.c', HERE / 'run.py',
                                                HERE / 'seccomp.json', binary]}
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
    docker('build', '--network', 'none', '--pull=false', '-t', tag, str(OUT / 'build'), timeout=30)
    save('image.json', json.loads(docker('image', 'inspect', tag).stdout))
    stage = 'init-launch'
    cid = create('hold')
    (OUT / 'docker-init').write_bytes(docker('exec', cid, '/probe', 'init', binary=True).stdout)
    init_hash = digest(OUT / 'docker-init')
    assert init_hash == 'd286e5df628bc2ceafe66dfb82e57fdf6ff66995a1cad073c9347e9bccc3dfb1', 'init identity changed'
    save('init.json', {'sha256': init_hash, 'version': '0.19.0', 'commit': 'de40ad0'})
    remove(cid)
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


try:
    main()
except Exception as error:
    save('result.json', {'status': 'INCONCLUSIVE', 'prerequisites': 'unavailable',
                         'stage': stage, 'error': str(error)})
finally:
    for cid in list(containers):
        remove(cid)
    if tag:
        docker('image', 'rm', tag, check=False)
    print(OUT)
    print((OUT / 'result.json').read_text())
