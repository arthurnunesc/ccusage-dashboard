"""Copy reviewed deployment controls; never enable or start services."""
import argparse
import os
from pathlib import Path
import platform
import stat
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def _check_dir(path):
    if os.path.lexists(path):
        st = path.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise RuntimeError(f'unsafe directory: {path}')


def install(home, apply=False, root=ROOT):
    if apply and platform.system() != 'Linux':
        raise RuntimeError('bootstrap apply requires Linux')
    home = Path(home).absolute()
    control = home / '.local/lib/ccusage-dashboard'
    config = home / '.config/ccusage-dashboard'
    units = home / '.config/systemd/user'
    base = home / '.local/share/ccusage-dashboard'
    state = home / '.local/state/ccusage-dashboard'
    sources = sorted((root / 'scripts/deploy').glob('*.py'))
    if not {'manage.py', 'runtime.py', 'launch.py', 'install.py', 'readiness.py'}.issubset({p.name for p in sources}):
        raise RuntimeError('reviewed checkout is missing deployment control sources')
    mapping = [(p, control / p.name) for p in sources]
    mapping += [(p, units / p.name) for p in sorted((root / 'deploy/systemd').glob('ccusage-dashboard*'))]
    if len(mapping) != len(sources) + 3:
        raise RuntimeError('reviewed checkout is missing systemd units')
    envfile = config / 'dashboard.env'
    dirs = {control, config, units, base, state}
    for d in dirs:
        p = d
        while p != home:
            _check_dir(p)
            p = p.parent
        _check_dir(home)
    existing = set()
    for src, dst in mapping + [(root / 'deploy/dashboard.env.example', envfile)]:
        if not src.is_file() or src.is_symlink():
            raise RuntimeError(f'unsafe source: {src}')
        if os.path.lexists(dst):
            existing.add(dst)
            st = dst.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
                raise RuntimeError(f'unsafe installed file: {dst}')
            if dst != envfile and dst.read_bytes() != src.read_bytes():
                raise RuntimeError(f'installed file differs; maintenance required: {dst}')
    for src, dst in mapping + [(root / 'deploy/dashboard.env.example', envfile)]:
        print(f'{"install" if apply else "would install"}: {dst}')
    if not apply:
        return
    for d in dirs:
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
    for src, dst in mapping + [(root / 'deploy/dashboard.env.example', envfile)]:
        if dst in existing:
            continue
        # Publish a complete file without replacing a target that appears in a race.
        fd, name = tempfile.mkstemp(prefix='.bootstrap-', dir=dst.parent)
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(src.read_bytes())
            os.link(name, dst)
        finally:
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog='Examples: python3 scripts/deploy/install.py --dry-run; python3 scripts/deploy/install.py --apply')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true', help='show planned copies (default)')
    group.add_argument('--apply', action='store_true', help='copy reviewed controls without starting services')
    args = parser.parse_args(argv)
    try:
        install(Path.home(), args.apply)
    except (OSError, RuntimeError) as exc:
        print(f'bootstrap failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
