import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get('LIVE_DECK_TEST_ARTIFACTS', ROOT / 'artifacts'))


class InstallTest(unittest.TestCase):
    def setUp(self):
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ARTIFACTS)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source with spaces'
        self.source.mkdir()
        shutil.copy2(ROOT / 'install_local.py', self.source)
        shutil.copytree(ROOT / 'web', self.source / 'web')
        (self.source / 'backend').mkdir()
        shutil.copy2(ROOT / 'backend/metrics.py', self.source / 'backend/metrics.py')
        self.custom = self.base / 'config/custom'
        self.command = [sys.executable, str(self.source / 'install_local.py'),
                        '--custom-dir', str(self.custom),
                        '--workspace-dir', str(self.base / 'demo workspaces'),
                        '--server-url', 'http://localhost:8888/user/presenter/']

    def invoke(self, *args):
        return subprocess.run([*self.command, *args], capture_output=True, text=True)

    def test_install_renders_examples_and_keeps_sources_portable(self):
        result = self.invoke('--model', 'example-model')
        self.assertEqual(result.returncode, 0, result.stderr)
        served = self.custom / 'live-deck'
        deployment = json.loads((served / 'deployment.json').read_text())
        self.assertEqual(deployment['jupyterBaseUrl'], '/user/presenter/')
        self.assertEqual(deployment['advisorPath'], str(self.source / 'backend/advisor.py'))
        monitoring = json.loads((served / 'monitoring.json').read_text())
        self.assertNotIn('{{LIVE_DECK_', json.dumps(monitoring))
        self.assertIn("'" + str(self.source) + "'", monitoring['terminals']['runner']['commands'][0]['command'])
        self.assertTrue(Path(monitoring['terminals']['runner']['cwd']).is_dir())
        self.assertTrue(monitoring['dashboards']['latency']['url'].startswith('http://localhost:8888/user/presenter/custom/live-deck/'))
        self.assertIn('{{LIVE_DECK_', (self.source / 'web/monitoring.json').read_text())
        self.assertFalse((self.source / 'web/deployment.json').exists())
        self.assertEqual(self.invoke().returncode, 0)
        self.assertEqual(json.loads((self.source / 'backend/local-settings.json').read_text())['model'], 'example-model')

    def test_unmanaged_directory_or_symlink_is_not_replaced(self):
        target = self.custom / 'live-deck'
        target.mkdir(parents=True)
        sentinel = target / 'keep.txt'
        sentinel.write_text('keep')
        self.assertNotEqual(self.invoke().returncode, 0)
        self.assertEqual(sentinel.read_text(), 'keep')
        alternate = self.base / 'other'
        alternate.mkdir()
        (alternate / 'live-deck').symlink_to(target, target_is_directory=True)
        result = self.invoke('--custom-dir', str(alternate))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_link_mode_keeps_player_code_live_from_the_checkout(self):
        result = self.invoke('--link')
        self.assertEqual(result.returncode, 0, result.stderr)
        served = self.custom / 'live-deck'
        self.assertTrue((served / '.live-deck-install').is_file())
        self.assertTrue((served / 'src').is_symlink())
        self.assertEqual((served / 'src').resolve(), self.source / 'web/src')
        self.assertTrue((served / 'studio.html').is_symlink())
        self.assertFalse((served / 'deck.json').is_symlink())
        self.assertNotIn('{{LIVE_DECK_', (served / 'deck.json').read_text())
        deployment = json.loads((served / 'deployment.json').read_text())
        self.assertEqual(deployment['advisorPath'], str(self.source / 'backend/advisor.py'))
        self.assertEqual(deployment['metricsPath'], str(self.source / 'backend/metrics.py'))
        self.assertEqual(self.invoke('--link').returncode, 0)

    def test_server_credentials_are_not_written_to_static_files(self):
        result = self.invoke('--server-url', 'https://name:example-password@example.org')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.custom / 'live-deck').exists())


if __name__ == '__main__':
    unittest.main()
