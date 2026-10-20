"""Install Live Deck into an existing classic Jupyter custom-file route."""
from pathlib import Path
import argparse
import json
import os
import shlex
import shutil
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def render(value, replacements, key=None):
    if isinstance(value, dict):
        return {k: render(v, replacements, k) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, replacements, key) for v in value]
    if isinstance(value, str):
        for token, replacement in replacements.items():
            if key == 'command' and token != '{{LIVE_DECK_URL}}':
                replacement = shlex.quote(replacement)
            value = value.replace(token, replacement)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    config_dir = Path(os.environ.get('JUPYTER_CONFIG_DIR', Path.home() / '.jupyter'))
    parser.add_argument('--custom-dir', type=Path, default=config_dir / 'custom')
    parser.add_argument('--server-url', default=os.environ.get('JUPYTER_SERVER_URL', 'http://127.0.0.1:8888'))
    parser.add_argument('--base-url', help='Override the Jupyter URL prefix, for example /user/alice/.')
    parser.add_argument('--workspace-dir', type=Path, default=Path.home() / '.local/share/live-deck/workspaces')
    parser.add_argument('--model', help='Optional Codex model override; otherwise use the Codex configuration.')
    args = parser.parse_args()
    server = urlsplit(args.server_url)
    if server.scheme not in ('http', 'https') or not server.netloc or server.username or server.password or server.query or server.fragment:
        parser.error('--server-url must be an HTTP(S) server URL without credentials, query or fragment')
    base_url = '/' + (args.base_url if args.base_url is not None else server.path).strip('/')
    base_url = base_url.rstrip('/') + '/'
    target = args.custom_dir.expanduser().resolve() / 'live-deck'
    marker = target / '.live-deck-install'
    if target.is_symlink() or (target.exists() and (not target.is_dir() or not marker.is_file())):
        raise SystemExit(f'Refusing to replace an unmanaged path: {target}')
    if target == ROOT / 'web' or ROOT / 'web' in target.parents:
        raise SystemExit('The installation directory must be outside web/.')
    workspace = args.workspace_dir.expanduser().resolve()
    for name in ('terminal-1', 'terminal-2', 'multi-run', 'multi-logs', 'monitoring'):
        (workspace / name).mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / 'web', target, dirs_exist_ok=True)
    deck_url = f'{server.scheme}://{server.netloc}{base_url}custom/live-deck'
    replacements = {'{{LIVE_DECK_WORKSPACES}}': str(workspace), '{{LIVE_DECK_ROOT}}': str(ROOT), '{{LIVE_DECK_URL}}': deck_url}
    for path in [*target.glob('*.json'), *target.glob('examples/*.json')]:
        data = render(json.loads(path.read_text()), replacements)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    (target / 'deployment.json').write_text(json.dumps({'jupyterBaseUrl': base_url, 'advisorPath': str(ROOT / 'backend/advisor.py')}, indent=2) + '\n')
    settings_path = ROOT / 'backend/local-settings.json'
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    node = shutil.which('node')
    if node:
        settings['nodeDirectory'] = str(Path(node).parent)
    if args.model:
        settings['model'] = args.model
    settings_path.write_text(json.dumps(settings, indent=2) + '\n')
    marker.write_text('Live Deck managed static files\n')
    print(deck_url + '/index.html')


if __name__ == '__main__':
    main()
