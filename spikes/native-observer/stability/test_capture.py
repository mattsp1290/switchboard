import errno
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import run


class CaptureTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.multiple(run, OUT=Path(directory), commands=[], ENV={'PATH': '/usr/bin:/bin'}))
        self.children = []
        self.popen = subprocess.Popen
        self.enterContext(patch.object(run.subprocess, 'Popen', side_effect=self.launch))

    def launch(self, *args, **kwargs):
        child = self.popen(*args, **kwargs)
        child.wait = Mock(wraps=child.wait)
        child.kill = Mock(wraps=child.kill)
        self.children.append(child)
        return child

    def tearDown(self):
        for child in self.children:
            self.assertIsNotNone(child.returncode)
            self.assertTrue(child.wait.called)
            self.assertTrue(child.stdout.closed)
            self.assertTrue(child.stderr.closed)

    def command(self, source):
        return [sys.executable, '-c', source]

    def test_excess_output_is_refused_with_check_false(self):
        limit = 16 * 1024 * 1024
        with tempfile.TemporaryDirectory() as directory, \
                patch.multiple(run, OUT=Path(directory), commands=[], ENV={'PATH': '/usr/bin:/bin'}):
            args = [sys.executable, '-c', f'import os; os.write(1, b"A" * {limit + 1024 * 1024})']
            with self.assertRaises(OSError) as caught:
                run.run(args, timeout=5, check=False)
            self.assertEqual(caught.exception.errno, errno.EOVERFLOW)
            record = run.commands[-1]
            self.assertTrue(record['overflow'])
            self.assertTrue(record['incomplete'])
            self.assertLessEqual((run.OUT / record['partialFiles']['stdout']).stat().st_size, limit)

    def test_each_stream_below_exact_and_above_limit(self):
        with patch.object(run, 'CAPTURE_LIMIT', 32):
            for descriptor in (1, 2):
                for length in (31, 32, 33):
                    with self.subTest(descriptor=descriptor, length=length):
                        args = self.command(f'import os; os.write({descriptor}, b"a" * {length})')
                        if length <= 32:
                            result = run.run(args, binary=True)
                            self.assertEqual(result.stdout if descriptor == 1 else result.stderr, b'a' * length)
                            self.assertTrue(run.commands[-1]['capture']['stdout' if descriptor == 1 else 'stderr']['eof'])
                        else:
                            with self.assertRaises(OSError) as caught:
                                run.run(args, check=False, binary=True)
                            self.assertEqual(caught.exception.errno, errno.EOVERFLOW)
                            record = run.commands[-1]
                            self.assertTrue(record['captureRefused'])
                            self.assertTrue(record['overflow'])
                            name = 'stdout' if descriptor == 1 else 'stderr'
                            metadata = record['capture'][name]
                            self.assertEqual(metadata['observedBytes'], 33)
                            self.assertEqual(metadata['retainedBytes'], 32)
                            self.assertEqual(metadata['retainedSha256'], hashlib.sha256(b'a' * 32).hexdigest())
                            self.assertEqual((run.OUT / record['partialFiles'][name]).read_bytes(), b'a' * 32)
                            self.assertNotIn('sha256', record['stdout'])

    def test_simultaneous_stream_excess_has_bounded_prefixes(self):
        with patch.object(run, 'CAPTURE_LIMIT', 32), self.assertRaises(OSError):
            run.run(self.command('import os; os.write(1, b"a" * 33); os.write(2, b"b" * 33)'), binary=True)
        for name in ('stdout', 'stderr'):
            self.assertLessEqual(run.commands[-1]['capture'][name]['retainedBytes'], 32)
            self.assertLessEqual(run.commands[-1]['capture'][name]['observedBytes'], 33)

    def test_bytes_newlines_and_ordinary_nonzero_policy(self):
        result = run.run(self.command('import os; os.write(1, bytes([0, 255, 13, 10]))'), binary=True)
        self.assertEqual(result.stdout, b'\0\xff\r\n')
        result = run.run(self.command('import os; os.write(1, b"a\\r\\nb\\rc\\n")'))
        self.assertEqual(result.stdout, 'a\nb\nc\n')
        for check in (False, True):
            args = self.command('import sys; print("bad"); print("diagnostic", file=sys.stderr); sys.exit(7)')
            if check:
                with self.assertRaises(RuntimeError):
                    run.run(args)
            else:
                self.assertEqual(run.run(args, check=False).returncode, 7)
            record = json.loads((run.OUT / 'commands.json').read_text())[-1]
            self.assertEqual((record['code'], record['stdout'], record['stderr']), (7, 'bad\n', 'diagnostic\n'))

    def test_strict_decode_errors_keep_their_type(self):
        for binary, descriptor in ((False, 1), (True, 2)):
            with self.subTest(binary=binary), self.assertRaises(UnicodeDecodeError):
                run.run(self.command(f'import os; os.write({descriptor}, bytes([255]))'), binary=binary)

    def test_timeout_keeps_raw_partial_bytes_and_reaps_child(self):
        args = self.command('import os,time; os.write(1, b"out\\r\\n"); os.write(2, b"err\\xff"); time.sleep(5)')
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            run.run(args, timeout=0.2)
        self.assertEqual((caught.exception.cmd, caught.exception.timeout), (args, 0.2))
        self.assertEqual((caught.exception.output, caught.exception.stderr), (b'out\r\n', b'err\xff'))
        self.assertTrue(self.children[-1].kill.called)
        record = run.commands[-1]
        self.assertTrue(record['timedOut'])
        self.assertFalse(record['captureRefused'])
        self.assertFalse(record['overflow'])
        for name, expected in (('stdout', b'out\r\n'), ('stderr', b'err\xff')):
            self.assertEqual((run.OUT / record['partialFiles'][name]).read_bytes(), expected)

    def test_eof_before_child_exit_preserves_original_wait_timeout(self):
        original = subprocess.TimeoutExpired('internal-command', 99)
        launch = self.launch

        def timed_launch(*args, **kwargs):
            child = launch(*args, **kwargs)
            wait = child.wait
            def timed_wait(timeout=None):
                if timeout is not None:
                    raise original
                return wait()
            child.wait = Mock(side_effect=timed_wait)
            return child

        args = self.command('import os,time; os.close(1); os.close(2); time.sleep(5)')
        with patch.object(run.subprocess, 'Popen', side_effect=timed_launch), \
                patch.object(run, 'save', side_effect=OSError('receipt fault')), \
                self.assertRaises(subprocess.TimeoutExpired) as caught:
            run.run(args, timeout=1)
        self.assertIs(caught.exception, original)
        self.assertEqual((original.cmd, original.timeout, original.output, original.stderr), (args, 1, b'', b''))
        self.assertTrue(any('evidence error' in note for note in original.__notes__))

    def test_real_timeout_after_eof_still_kills_and_waits(self):
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            run.run(self.command('import os,time; os.close(1); os.close(2); time.sleep(5)'), timeout=0.2)
        self.assertEqual(caught.exception.timeout, 0.2)
        self.assertTrue(self.children[-1].kill.called)
        self.assertTrue(all(run.commands[-1]['capture'][name]['eof'] for name in ('stdout', 'stderr')))

    def test_inherited_idle_writer_cannot_extend_deadline(self):
        source = ('import os,time\n'
                  'if os.fork() == 0:\n    time.sleep(0.7)\n    os._exit(0)\n'
                  'os.write(1, b"parent"); os._exit(0)')
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            run.run(self.command(source), timeout=0.2)
        self.assertEqual(caught.exception.output, b'parent')
        self.assertEqual(self.children[-1].returncode, 0)
        self.assertFalse(run.commands[-1]['capture']['stdout']['eof'])

    def test_setup_registration_and_read_errors_refuse_and_close(self):
        selector = run.selectors.DefaultSelector
        set_blocking = run.os.set_blocking
        read = run.os.read
        for fault in ('selector', 'blocking', 'register', 'read'):
            with self.subTest(fault=fault):
                if fault == 'selector':
                    control = patch.object(run.selectors, 'DefaultSelector', side_effect=OSError('selector fault'))
                elif fault == 'blocking':
                    count = 0
                    def faulty_blocking(*args):
                        nonlocal count
                        count += 1
                        if count == 2:
                            raise OSError('blocking fault')
                        return set_blocking(*args)
                    control = patch.object(run.os, 'set_blocking', side_effect=faulty_blocking)
                elif fault == 'register':
                    instance = selector()
                    register = instance.register
                    def faulty_register(*args):
                        if instance.get_map():
                            raise OSError('register fault')
                        return register(*args)
                    instance.register = Mock(side_effect=faulty_register)
                    control = patch.object(run.selectors, 'DefaultSelector', return_value=instance)
                else:
                    def faulty_read(fd, size):
                        if any(not pipe.closed and fd == pipe.fileno() for child in self.children
                               for pipe in (child.stdout, child.stderr)):
                            raise OSError('read fault')
                        return read(fd, size)
                    control = patch.object(run.os, 'read', side_effect=faulty_read)
                with control, self.assertRaises(OSError) as caught:
                    run.run(self.command('import time; print("x", flush=True); time.sleep(5)'))
                self.assertEqual(caught.exception.errno, errno.EOVERFLOW)
                self.assertTrue(run.commands[-1]['captureRefused'])
                self.assertFalse(run.commands[-1]['overflow'])
                self.assertTrue(run.commands[-1]['incomplete'])

    def test_deadline_wins_over_same_batch_overflow(self):
        monotonic, read = run.time.monotonic, run.os.read
        expired = False

        def observed_read(*args):
            nonlocal expired
            data = read(*args)
            if len(data) > 32:
                expired = True
            return data

        with patch.object(run, 'CAPTURE_LIMIT', 32), \
                patch.object(run.os, 'read', side_effect=observed_read), \
                patch.object(run.time, 'monotonic', side_effect=lambda: monotonic() + (10 if expired else 0)), \
                self.assertRaises(subprocess.TimeoutExpired):
            run.run(self.command('import os; os.write(1, b"x" * 33)'), timeout=2)
        self.assertTrue(run.commands[-1]['overflow'])
        self.assertTrue(run.commands[-1]['timedOut'])

    def test_chosen_overflow_survives_later_deadline_and_interruption_is_preserved(self):
        monotonic, launch = run.time.monotonic, self.launch
        expired = False

        def delayed_kill_launch(*args, **kwargs):
            child = launch(*args, **kwargs)
            kill = child.kill
            def delayed_kill():
                nonlocal expired
                expired = True
                kill()
            child.kill = Mock(side_effect=delayed_kill)
            return child

        with patch.object(run, 'CAPTURE_LIMIT', 32), \
                patch.object(run.subprocess, 'Popen', side_effect=delayed_kill_launch), \
                patch.object(run.time, 'monotonic', side_effect=lambda: monotonic() + (10 if expired else 0)), \
                self.assertRaises(OSError) as caught:
            run.run(self.command('print("x" * 33)'), timeout=2)
        self.assertEqual(caught.exception.errno, errno.EOVERFLOW)
        self.assertFalse(run.commands[-1]['timedOut'])
        interruption, read = KeyboardInterrupt('interrupted'), run.os.read
        def interrupted_read(fd, size):
            if any(not pipe.closed and fd == pipe.fileno() for child in self.children
                   for pipe in (child.stdout, child.stderr)):
                raise interruption
            return read(fd, size)
        with patch.object(run.os, 'read', side_effect=interrupted_read), self.assertRaises(KeyboardInterrupt) as caught:
            run.run(self.command('print("ready")'))
        self.assertIs(caught.exception, interruption)

    def test_timeout_survives_partial_file_and_receipt_failures(self):
        for target in ('partial', 'receipt'):
            with self.subTest(target=target):
                control = (patch.object(Path, 'write_bytes', side_effect=OSError('partial fault')) if target == 'partial'
                           else patch.object(run, 'save', side_effect=OSError('receipt fault')))
                with control, self.assertRaises(subprocess.TimeoutExpired) as caught:
                    run.run(self.command('import time; time.sleep(5)'), timeout=0.1)
                self.assertTrue(any('evidence error' in note for note in caught.exception.__notes__))

    def test_secondary_kill_close_and_wait_errors_keep_timeout_and_finish_cleanup(self):
        launch = self.launch

        def faulty_launch(*args, **kwargs):
            child = launch(*args, **kwargs)
            kill, close, wait = child.kill, child.stdout.close, child.wait
            def faulty_kill():
                kill()
                raise OSError('kill diagnostic')
            def faulty_close():
                close()
                raise OSError('close diagnostic')
            def faulty_wait(timeout=None):
                result = wait(timeout=timeout)
                if timeout is None:
                    raise OSError('wait diagnostic')
                return result
            child.kill = Mock(side_effect=faulty_kill)
            child.stdout.close = Mock(side_effect=faulty_close)
            child.wait = Mock(side_effect=faulty_wait)
            return child

        with patch.object(run.subprocess, 'Popen', side_effect=faulty_launch), self.assertRaises(subprocess.TimeoutExpired) as caught:
            run.run(self.command('import time; time.sleep(5)'), timeout=0.1)
        for diagnostic in ('kill diagnostic', 'close diagnostic', 'wait diagnostic'):
            self.assertTrue(any(diagnostic in note for note in caught.exception.__notes__))
        self.assertTrue(self.children[-1].stderr.closed)
        self.assertIsNotNone(self.children[-1].returncode)

    def test_cleanup_failure_on_success_refuses_and_storage_error_remains_oserror(self):
        selector = run.selectors.DefaultSelector()
        close = selector.close
        def faulty_close():
            close()
            raise OSError('selector close diagnostic')
        selector.close = Mock(side_effect=faulty_close)
        with patch.object(run.selectors, 'DefaultSelector', return_value=selector), self.assertRaises(OSError) as caught:
            run.run(self.command('print("complete")'))
        self.assertEqual(caught.exception.errno, errno.EOVERFLOW)
        self.assertFalse(run.commands[-1]['overflow'])
        self.assertTrue(run.commands[-1]['captureRefused'])
        storage_error = OSError(errno.ENOSPC, 'receipt full')
        with patch.object(run, 'save', side_effect=storage_error), self.assertRaises(OSError) as caught:
            run.run(self.command('print("complete")'))
        self.assertIs(caught.exception, storage_error)
        with patch.object(run, 'CAPTURE_LIMIT', 32), patch.object(run, 'save', side_effect=storage_error), \
                self.assertRaises(OSError) as caught:
            run.run(self.command('print("x" * 33)'))
        self.assertIs(caught.exception, storage_error)

    def test_launch_failure_is_unchanged_and_regular_writes_are_unrestricted(self):
        original = FileNotFoundError('launch fault')
        with patch.object(run.subprocess, 'Popen', side_effect=original), self.assertRaises(FileNotFoundError) as caught:
            run.run(['missing'])
        self.assertIs(caught.exception, original)
        path = run.OUT / 'ordinary-file'
        source = f'from pathlib import Path\nPath({str(path)!r}).write_bytes(b"x" * 4096)'
        with patch.object(run, 'CAPTURE_LIMIT', 32):
            run.run(self.command(source))
        self.assertEqual(path.stat().st_size, 4096)

    def test_cleanup_retries_refusal_and_visits_later_resources(self):
        from test_cleanup import capture_transport
        calls = []

        def transport(args, **kwargs):
            calls.append(args[3:])
            if len(calls) == 1:
                error = OSError(errno.EOVERFLOW, 'capture refused')
                error.output, error.stderr = b'prefix', b''
                error.capture = {'overflow': True, 'incomplete': True}
                raise error
            name = args[-1]
            missing = f'Error response from daemon: No such image: {name}' if args[3] == 'image' else f'error: no such object: {name}'
            return subprocess.CompletedProcess(args, 1, '[]', missing)

        with patch.multiple(run, containers={'first': 'confirmed', 'later': 'confirmed'}, images={'image': 'confirmed'}), \
                patch.object(run, '_capture', capture_transport(transport)), patch.object(run.time, 'sleep'):
            run.cleanup()
            self.assertFalse(run.containers)
            self.assertFalse(run.images)
        self.assertGreater(sum(call[-1] == 'first' for call in calls), 1)
        self.assertTrue(any(call[-1] == 'later' for call in calls))
        self.assertTrue(any(call[:2] == ['image', 'inspect'] for call in calls))


if __name__ == '__main__':
    unittest.main()
