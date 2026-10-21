"""Link a presentation to the single local Live Deck player."""
from pathlib import Path
import argparse
import json
import os


SHARED = ('index.html', 'studio.html', 'studio.css', 'src', 'style.css', 'vendor', 'docs', 'examples', 'live-deck.schema.json',
          'multi-panel.json', 'monitoring.json', 'context-preview.html')


def link_site(root: Path, site: Path, backup: Path | None = None) -> None:
    root, site = root.resolve(), site.resolve()
    web = root / 'web'
    if site == root or site == web or site in root.parents or root in site.parents:
        raise ValueError('Presentation must be separate from the player source directory')
    if not (site / 'deck.json').is_file():
        raise ValueError('Presentation directory must contain deck.json')
    targets = {name: web / name for name in SHARED}
    if (root / 'AGENTS.md').is_file():
        targets['AGENTS.md'] = root / 'AGENTS.md'
    conflicts = []
    for name, target in targets.items():
        if not target.exists():
            raise ValueError(f'Missing shared resource: {target}')
        destination = site / name
        if destination.is_symlink() and destination.resolve() == target:
            continue
        if destination.exists() or destination.is_symlink():
            conflicts.append(name)
        if destination.with_name(name + '.shared-new').exists() or destination.with_name(name + '.shared-new').is_symlink():
            raise ValueError(f'Unexpected pending link: {destination}')
    if conflicts and backup is None:
        raise ValueError('Existing player copies require --backup-dir; nothing changed')
    if backup is not None:
        backup = backup.resolve()
        if backup == site or site in backup.parents or backup in site.parents or backup == root or root in backup.parents or backup in root.parents:
            raise ValueError('Backup directory must be separate from the presentation and player')
        for name in (*conflicts, 'deployment.json'):
            if (backup / name).exists() or (backup / name).is_symlink():
                raise ValueError(f'Backup already exists: {backup / name}')
    config_path = site / 'deployment.json'
    shared_deployment = web / 'deployment.json'
    config = json.loads(shared_deployment.read_text()) if shared_deployment.is_file() else {}
    if not isinstance(config, dict):
        raise ValueError('Shared deployment.json must be an object')
    previous = config_path.read_bytes() if config_path.exists() else None
    if previous is not None:
        custom = json.loads(previous)
        if not isinstance(custom, dict):
            raise ValueError('Presentation deployment.json must be an object')
        config.update(custom)
    config['storageScope'] = 'deck'
    if (site / 'presentation.css').is_file() and not config.get('stylesheets'):
        config['stylesheets'] = ['./presentation.css']
    pending_config = config_path.with_name('deployment.json.shared-new')
    if pending_config.exists() or pending_config.is_symlink():
        raise ValueError(f'Unexpected pending config: {pending_config}')
    if backup is not None:
        backup.mkdir(parents=True, exist_ok=True)
        if previous is not None:
            (backup / 'deployment.json').write_bytes(previous)
    pending_config.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    os.replace(pending_config, config_path)
    # Link the entry page last so a reload gets the complete shared player.
    for name in (*[name for name in targets if name != 'index.html'], 'index.html'):
        target, destination = targets[name], site / name
        if destination.is_symlink() and destination.resolve() == target:
            continue
        pending = destination.with_name(name + '.shared-new')
        pending.symlink_to(target, target_is_directory=target.is_dir())
        if name in conflicts:
            destination.rename(backup / name)
        os.replace(pending, destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site-dir', type=Path, required=True)
    parser.add_argument('--backup-dir', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    link_site(root, args.site_dir, args.backup_dir)
    print(f'{args.site_dir.resolve()} -> shared player {root / "web"}')


if __name__ == '__main__':
    main()
