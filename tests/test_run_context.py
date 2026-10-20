import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'backend/run_context.py'


class RunContextTest(unittest.TestCase):
    def invoke(self, code):
        # No controlling terminal: capture the protocol separately from a real browser test.
        result = subprocess.run([sys.executable, str(HELPER), 'run', '--set', 'instance=node-a', '--', sys.executable, '-u', '-c', code], capture_output=True, start_new_session=True)
        events = [json.loads(base64.b64decode(value)) for value in re.findall(rb'\x1b\]777;live-deck;([^\x07]+)\x07', result.stdout)]
        return result, events

    def test_live_publication_and_exit_code(self):
        result, events = self.invoke(f'import subprocess,sys; subprocess.run([sys.executable,{str(HELPER)!r},"publish","--event","ready","--set","task_id=123","--monitoring-start-now"],check=True); print("actual-output"); sys.exit(7)')
        self.assertEqual(result.returncode, 7)
        self.assertEqual([e['event'] for e in events], ['started', 'ready', 'finished'])
        self.assertEqual(len({e['run_id'] for e in events}), 1)
        self.assertEqual(events[1]['fields']['task_id'], '123')
        self.assertIsInstance(events[1]['fields']['monitoring_started_at_ms'], int)
        self.assertEqual(events[-1]['exit_code'], 7)
        self.assertIn(b'actual-output', result.stdout)

    def test_startup_failure_reports_finished(self):
        result = subprocess.run([sys.executable,str(HELPER),'run','--','/no-such-livedeck-command'],capture_output=True,start_new_session=True)
        self.assertEqual(result.returncode,127)
        self.assertIn(b'No such file',result.stderr)


if __name__ == '__main__':
    unittest.main()
