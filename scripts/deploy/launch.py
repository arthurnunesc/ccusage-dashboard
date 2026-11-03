"""Launch the pinned runtime from one validated immutable release."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import runtime
from manage import read_environment


def launch(home=None):
    home = Path(home or os.environ['HOME']).absolute()
    base = home / '.local/share/ccusage-dashboard'
    releases = base / 'releases'
    for directory in (home, home / '.local', home / '.local/share', base, releases):
        runtime._owned(directory, True)
    current = base / 'current'
    if not current.is_symlink() or current.lstat().st_uid != os.getuid():
        raise RuntimeError('current is not a symlink')
    # Read the link once; reject aliases and symlinked release directories.
    link = os.readlink(current)
    release = Path(os.path.normpath(os.path.join(base, link)))
    if release.parent != releases or not re.fullmatch(r'[0-9a-f]{40}', release.name):
        raise RuntimeError('current is not a full-SHA release')
    for directory in (release, release / 'src'):
        runtime._owned(directory, True)
    for file in (release / '.bun-version', release / '.deployment-release.json', release / 'src/server.js'):
        runtime._owned(file)
    version = (release / '.bun-version').read_text().strip()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise RuntimeError('invalid runtime version')
    meta = json.loads((release / '.deployment-release.json').read_text())
    if (not isinstance(meta, dict) or set(meta) != {'sha', 'runtime', 'ci_run_id'}
            or meta['sha'] != release.name or meta['runtime'] != version
            or type(meta['ci_run_id']) is not int or meta['ci_run_id'] <= 0):
        raise RuntimeError('release metadata mismatch')
    if version not in runtime.RELEASES:
        raise RuntimeError('unreviewed runtime version')
    runtime._owned(base / 'runtimes', True)
    # Use the same restricted file parser as staging/readiness. Do not inherit
    # Bun options, credentials, or source-path overrides from the user manager.
    environment = read_environment(home / '.config/ccusage-dashboard/dashboard.env', home)
    binary = runtime._existing(base / 'runtimes' / version, version, environment)
    os.chdir(release)
    os.execve(str(binary), [str(binary), '--no-env-file', 'src/server.js'], environment)


if __name__ == '__main__':
    try:
        launch()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f'launch failed: {exc}', file=sys.stderr)
        sys.exit(1)
