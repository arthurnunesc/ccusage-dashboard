"""Install only reviewed Bun releases into the private deployment tree."""
import hashlib
import ctypes
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import tempfile
import time
import urllib.request
import zipfile

# Official GitHub release asset digest, reviewed with the runtime pin:
# https://github.com/oven-sh/bun/releases/expanded_assets/bun-v1.3.11
RELEASES = {'1.3.11': ('bun-linux-x64-baseline.zip', 'abe346f63414547cdf6b35b7a649a490c728b93d006226156923918a84c0e59b')}
MAX_ARCHIVE = 150 * 1024 * 1024
MAX_BINARY = 300 * 1024 * 1024


def _owned(path, directory=False):
    st = path.lstat()
    if st.st_uid != os.getuid() or (not stat.S_ISDIR(st.st_mode) if directory else not stat.S_ISREG(st.st_mode)) or st.st_mode & 0o022:
        raise RuntimeError(f'unsafe runtime path: {path}')


def _version(binary, version, env):
    result = subprocess.run([str(binary), '--version'], env=env, capture_output=True, text=True, timeout=15, check=True)
    if result.stdout.strip() != version:
        raise RuntimeError('runtime version mismatch')


def _existing(target, version, env):
    _owned(target, True)
    _owned(target / 'bin', True)
    binary = target / 'bin' / 'bun'
    marker = target / '.runtime.json'
    _owned(binary)
    _owned(marker)
    meta = json.loads(marker.read_text())
    if meta != {'version': version, 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}:
        raise RuntimeError('runtime integrity mismatch')
    _version(binary, version, env)
    return binary


def _publish(source, target):
    # Linux renameat2 prevents replacement even if a target appears concurrently.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def ensure_runtime(base: Path, version: str, env: dict) -> Path:
    base = Path(base).absolute()
    if version not in RELEASES:
        raise RuntimeError(f'unreviewed Bun version: {version}')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise RuntimeError('unsupported runtime platform')
    runtimes = base / 'runtimes'
    runtimes.mkdir(mode=0o700, parents=True, exist_ok=True)
    _owned(base, True)
    _owned(runtimes, True)
    target = runtimes / version
    if os.path.lexists(target):
        return _existing(target, version, env)
    name, digest = RELEASES[version]
    url = f'https://github.com/oven-sh/bun/releases/download/bun-v{version}/{name}'
    # TemporaryDirectory owns only this unique staging tree, and removes it on failure.
    with tempfile.TemporaryDirectory(prefix='.runtime-', dir=runtimes) as tmp:
        stage = Path(tmp)
        archive = stage / 'archive.zip'
        h = hashlib.sha256()
        deadline = time.monotonic() + 120
        with urllib.request.urlopen(url, timeout=30) as response, archive.open('wb') as out:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if time.monotonic() > deadline:
                    raise RuntimeError('runtime download timed out')
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE:
                    raise RuntimeError('runtime download too large')
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != digest:
            raise RuntimeError('runtime archive checksum mismatch')
        install = stage / 'install'
        (install / 'bin').mkdir(mode=0o700, parents=True)
        binary = install / 'bin' / 'bun'
        with zipfile.ZipFile(archive) as z:
            expected = name[:-4] + '/bun'
            matches = [item for item in z.infolist() if item.filename == expected]
            if len(matches) != 1 or matches[0].file_size > MAX_BINARY or matches[0].is_dir():
                raise RuntimeError('invalid runtime archive')
            with z.open(matches[0]) as source, binary.open('wb') as dest:
                shutil.copyfileobj(source, dest, 1024 * 1024)
        binary.chmod(0o700)
        _version(binary, version, env)
        (install / '.runtime.json').write_text(json.dumps({'version': version, 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}))
        (install / '.runtime.json').chmod(0o600)
        _publish(install, target)
    return target / 'bin' / 'bun'
