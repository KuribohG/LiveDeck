import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('link_site', ROOT / 'scripts/link-site.py')
link_site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(link_site)


class LinkSiteTest(unittest.TestCase):
    def test_links_presentation_to_one_checkout_and_rewrites_backend_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source, site = base / 'source', base / 'site'
            web = source / 'web'
            (web / 'src').mkdir(parents=True)
            (web / 'vendor').mkdir()
            (web / 'docs').mkdir()
            (web / 'examples').mkdir()
            (web / 'studio.html').write_text('studio')
            (web / 'studio.css').write_text('css')
            (web / 'style.css').write_text('css')
            (web / 'multi-panel.json').write_text('{}')
            (web / 'monitoring.json').write_text('{}')
            (web / 'context-preview.html').write_text('preview')
            (web / 'index.html').write_text('player')
            (web / 'live-deck.schema.json').write_text('{}')
            (source / 'backend').mkdir()
            (source / 'backend/advisor.py').write_text('')
            (source / 'backend/metrics.py').write_text('')
            site.mkdir()
            (site / 'deck.json').write_text('{}')
            (site / 'deployment.json').write_text(json.dumps({
                'jupyterBaseUrl':'/user/presenter/',
                'advisorPath':'/old/advisor.py',
                'metricsPath':'/old/metrics.py',
            }))

            link_site.link_site(source, site)

            self.assertTrue((site / 'index.html').is_symlink())
            self.assertTrue((site / 'studio.html').is_symlink())
            self.assertTrue((site / 'src').is_symlink())
            self.assertEqual((site / 'src').resolve(), web / 'src')
            deployment = json.loads((site / 'deployment.json').read_text())
            self.assertEqual(deployment['jupyterBaseUrl'], '/user/presenter/')
            self.assertEqual(deployment['advisorPath'], str(source / 'backend/advisor.py'))
            self.assertEqual(deployment['metricsPath'], str(source / 'backend/metrics.py'))
            self.assertEqual(deployment['storageScope'], 'deck')
            self.assertFalse((site / 'AGENTS.md').exists())


if __name__ == '__main__':
    unittest.main()
