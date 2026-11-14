import errno
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import run


class CaptureTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
