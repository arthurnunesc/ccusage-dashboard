import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/deploy'))


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/deploy' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runtime, launcher, installer = (load(n) for n in ('runtime', 'launch', 'install'))


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        output = mock.patch('sys.stdout', new_callable=io.StringIO)
        output.start()
        self.addCleanup(output.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'home'
        self.home.mkdir()
        self.root = Path(self.tmp.name) / 'checkout'
        linux = mock.patch.object(installer.platform, 'system', return_value='Linux')
        linux.start()
        self.addCleanup(linux.stop)
        (self.root / 'scripts/deploy').mkdir(parents=True)
        (self.root / 'deploy/systemd').mkdir(parents=True)
        for name in ('manage.py', 'runtime.py', 'launch.py', 'install.py', 'readiness.py'):
            (self.root / 'scripts/deploy' / name).write_text(name)
        for p in (ROOT / 'deploy/systemd').iterdir():
            (self.root / 'deploy/systemd' / p.name).write_bytes(p.read_bytes())
        (self.root / 'deploy/dashboard.env.example').write_text('PORT=8766\n')

    def test_installer_dry_run_and_idempotence_and_edits(self):
        installer.install(self.home, root=self.root)
        self.assertFalse((self.home / '.local').exists())
        installer.install(self.home, True, self.root)
        env = self.home / '.config/ccusage-dashboard/dashboard.env'
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        env.write_text('PORT=9999\n')
        installer.install(self.home, True, self.root)
        self.assertEqual(env.read_text(), 'PORT=9999\n')
        target = self.home / '.local/lib/ccusage-dashboard/launch.py'
        target.write_text('user edit')
        with self.assertRaises(RuntimeError):
            installer.install(self.home, True, self.root)
        self.assertEqual(target.read_text(), 'user edit')

    def test_installer_refuses_symlink(self):
        (self.home / '.local').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            installer.install(self.home, True, self.root)

    def make_launch_tree(self):
        base = self.home / '.local/share/ccusage-dashboard'
        sha = 'a' * 40
        release = base / 'releases' / sha
        release.mkdir(parents=True)
        (release / '.bun-version').write_text('1.3.11\n')
        (release / '.deployment-release.json').write_text(json.dumps({'sha': sha, 'runtime': '1.3.11', 'ci_run_id': 1}))
        (release / 'src').mkdir()
        (release / 'src/server.js').write_text('// app')
        bun = base / 'runtimes/1.3.11/bin/bun'
        bun.parent.mkdir(parents=True)
        bun.write_bytes(b'binary')
        (bun.parent.parent / '.runtime.json').write_text(json.dumps({'version': '1.3.11', 'sha256': hashlib.sha256(b'binary').hexdigest()}))
        (base / 'current').symlink_to(release)
        config = self.home / '.config/ccusage-dashboard/dashboard.env'
        config.parent.mkdir(parents=True)
        config.write_text('PORT=8766\n')
        config.chmod(0o600)
        return base, release, bun

    def test_launch_resolves_once_and_checks_metadata(self):
        base, release, bun = self.make_launch_tree()
        with mock.patch.object(launcher.os, 'chdir') as chdir, mock.patch.object(launcher.os, 'execve') as execv, mock.patch.object(launcher.runtime.subprocess, 'run', return_value=mock.Mock(stdout='1.3.11\n')):
            launcher.launch(self.home)
        chdir.assert_called_once_with(release)
        binary = str(base / 'runtimes/1.3.11/bin/bun')
        execv.assert_called_once()
        args = execv.call_args.args
        self.assertEqual(args[:2], (binary, [binary, '--no-env-file', 'src/server.js']))
        self.assertEqual(args[2]['HOME'], str(self.home))
        self.assertNotIn('BUN_OPTIONS', args[2])
        (release / '.deployment-release.json').write_text('{}')
        with self.assertRaises(RuntimeError):
            launcher.launch(self.home)

    def test_launch_rejects_outside_release(self):
        base = self.home / '.local/share/ccusage-dashboard'
        (base / 'releases').mkdir(parents=True)
        (base / 'current').symlink_to(self.home)
        with self.assertRaises(RuntimeError):
            launcher.launch(self.home)

    def test_launch_rejects_tampered_runtime_without_download(self):
        base, release, bun = self.make_launch_tree()
        bun.write_bytes(b'tampered')
        with mock.patch.object(launcher.runtime.urllib.request, 'urlopen') as fetch, mock.patch.object(launcher.os, 'execve') as execute:
            with self.assertRaisesRegex(RuntimeError, 'integrity'):
                launcher.launch(self.home)
            fetch.assert_not_called()
            execute.assert_not_called()

    def test_launch_rejects_unsafe_paths(self):
        base, release, bun = self.make_launch_tree()
        for path in (base, release, release / 'src', release / 'src/server.js', base / 'runtimes', bun):
            with self.subTest(path=path):
                mode = path.stat().st_mode & 0o777
                path.chmod(mode | 0o020)
                try:
                    with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                        launcher.launch(self.home)
                finally:
                    path.chmod(mode)

    def test_launch_rejects_symlinked_runtime_and_release(self):
        base, release, bun = self.make_launch_tree()
        target = base / 'runtimes/1.3.11'
        renamed = target.with_name('saved')
        target.rename(renamed)
        target.symlink_to(renamed)
        with self.assertRaisesRegex(RuntimeError, 'unsafe'):
            launcher.launch(self.home)
        target.unlink()
        renamed.rename(target)
        renamed_release = release.with_name('saved')
        release.rename(renamed_release)
        release.symlink_to(renamed_release)
        with self.assertRaisesRegex(RuntimeError, 'unsafe'):
            launcher.launch(self.home)

    def test_launch_rejects_unowned_paths(self):
        self.make_launch_tree()
        with mock.patch.object(launcher.runtime.os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                launcher.launch(self.home)

    def test_installer_cleans_staging_on_publish_error(self):
        with mock.patch.object(installer.os, 'link', side_effect=OSError('publish failed')):
            with self.assertRaisesRegex(OSError, 'publish failed'):
                installer.install(self.home, True, self.root)
        control = self.home / '.local/lib/ccusage-dashboard'
        self.assertEqual(list(control.iterdir()), [])

    def test_installer_apply_rejects_non_linux(self):
        with mock.patch.object(installer.platform, 'system', return_value='Darwin'):
            installer.install(self.home, root=self.root)
            with self.assertRaisesRegex(RuntimeError, 'requires Linux'):
                installer.install(self.home, True, self.root)
        self.assertFalse((self.home / '.local').exists())

    def test_runtime_rejects_unsupported_platform(self):
        with mock.patch.object(runtime.platform, 'system', return_value='Linux'), mock.patch.object(runtime.platform, 'machine', return_value='aarch64'):
            with self.assertRaisesRegex(RuntimeError, 'unsupported'):
                runtime.ensure_runtime(self.home / 'base', '1.3.11', {})
        self.assertFalse((self.home / 'base').exists())

    def archive(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as z:
            z.writestr('bun-linux-x64-baseline/bun', b'binary')
        return output.getvalue()

    def test_runtime_verified_install_reuse_and_tamper(self):
        data = self.archive()
        releases = {'1.3.11': ('bun-linux-x64-baseline.zip', hashlib.sha256(data).hexdigest())}
        base = self.home / 'base'
        version_result = mock.Mock(stdout='1.3.11\n')
        with mock.patch.object(runtime, 'RELEASES', releases), mock.patch.object(runtime.platform, 'system', return_value='Linux'), mock.patch.object(runtime.platform, 'machine', return_value='x86_64'), mock.patch.object(runtime.urllib.request, 'urlopen', side_effect=lambda *a, **k: io.BytesIO(data)) as fetch, mock.patch.object(runtime.subprocess, 'run', return_value=version_result), mock.patch.object(runtime, '_publish', side_effect=os.rename):
            bun = runtime.ensure_runtime(base, '1.3.11', {})
            self.assertEqual(bun.read_bytes(), b'binary')
            self.assertEqual(runtime.ensure_runtime(base, '1.3.11', {}), bun)
            self.assertEqual(fetch.call_count, 1)
            bun.write_bytes(b'other')
            with self.assertRaises(RuntimeError):
                runtime.ensure_runtime(base, '1.3.11', {})

    def test_runtime_checksum_and_existing_target_fail_closed(self):
        base = self.home / 'base'
        with mock.patch.object(runtime.platform, 'system', return_value='Linux'), mock.patch.object(runtime.platform, 'machine', return_value='x86_64'), mock.patch.object(runtime.urllib.request, 'urlopen', return_value=io.BytesIO(b'invalid')):
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                runtime.ensure_runtime(base, '1.3.11', {})
            self.assertEqual(list((base / 'runtimes').iterdir()), [])
            (base / 'runtimes/1.3.11').mkdir()
            with self.assertRaises((RuntimeError, OSError)):
                runtime.ensure_runtime(base, '1.3.11', {})
            with self.assertRaisesRegex(RuntimeError, 'unreviewed'):
                runtime.ensure_runtime(base, '9.9.9', {})


if __name__ == '__main__':
    unittest.main()
