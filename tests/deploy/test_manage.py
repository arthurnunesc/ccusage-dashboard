"""Deployment transactions against disposable files; no host services or history."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'deploy'))
import manage
import launch

A, B, C = ('a' * 40, 'b' * 40, 'c' * 40)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.d = manage.Deployer(self.home)
        self.d.config_path.parent.mkdir(parents=True)
        self.d.config_path.write_text('PORT=8766\n')
        self.d.config_path.chmod(0o600)
        self.d.initialize()
        # Guard against accidental host subprocesses and network, including in new tests.
        for name in ('run', 'github_page'):
            patcher = mock.patch.object(self.d, name, side_effect=AssertionError('unmocked ' + name))
            patcher.start()
            self.addCleanup(patcher.stop)

    def release(self, sha, run=1):
        record = {'sha': sha, 'runtime': '1.3.11', 'ci_run_id': run}
        path = self.d.releases / sha
        path.mkdir(mode=0o700)
        (path / '.bun-version').write_text(record['runtime'] + '\n')
        marker = path / '.deployment-release.json'
        marker.write_text(json.dumps(record))
        marker.chmod(0o600)
        return record

    def active(self):
        record = self.release(A)
        state = self.d.state()
        state['active'] = record
        self.d.switch('current', record)
        self.d.save(state)
        return state, record

    def workflow(self, sha=B, **changes):
        run = {'head_sha': sha, 'head_branch': 'main', 'event': 'push',
               'path': '.github/workflows/ci.yml',
               'repository': {'full_name': manage.REPOSITORY},
               'head_repository': {'full_name': manage.REPOSITORY},
               'id': 1, 'run_number': 1, 'run_attempt': 1,
               'status': 'completed', 'conclusion': 'success'}
        run.update(changes)
        return run

    def set_pages(self, *pages):
        self.d.github_page.side_effect = list(pages)

    @staticmethod
    def page(*runs):
        return {'total_count': len(runs), 'workflow_runs': list(runs)}

    def update_stubs(self, sha=B):
        self.d.fetch = mock.Mock(return_value=sha)
        self.d.git = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.d.eligible = mock.Mock(return_value=2)
        self.d.restart = mock.Mock()
        self.d.stop = mock.Mock()
        self.d.ready = mock.Mock()

    def test_environment_private_and_strict(self):
        env = self.d.config_path
        self.assertEqual(manage.read_environment(env, self.home)['HOME'], str(self.home))
        for text in ('PORT=1\nPORT=2\n', 'HOME=/tmp\n', 'PORT="1"\n',
                     'PORT=$X\n', 'CCUSAGE_CONFIG=relative\n', 'PORT= 1\n', 'export PORT=1\n'):
            with self.subTest(text=text):
                env.write_text(text)
                with self.assertRaises(manage.DeploymentError):
                    manage.read_environment(env, self.home)
        env.write_text('PORT=8766\n')
        env.chmod(0o644)
        with self.assertRaises(manage.DeploymentError):
            manage.read_environment(env, self.home)
        env.unlink()
        env.symlink_to(self.home / 'missing')
        with self.assertRaises(manage.DeploymentError):
            manage.read_environment(env, self.home)

    def test_cleanup_preserves_non_private_staging(self):
        path = self.d.releases / '.stage-readable'
        path.mkdir(mode=0o755)
        self.d.mark_stage(path, 'release', sha=B)
        self.d.cleanup_staging()
        self.assertTrue(path.exists())

    def test_readiness_connects_to_bind_address_with_allowed_dns_host(self):
        self.d.env.update({'CCUSAGE_BIND_ADDRESS': '192.168.1.52',
                           'CCUSAGE_ALLOWED_HOSTS': 'dashboard.test:8766'})
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(b'{"status":"ok"}')
        with mock.patch.object(manage.urllib.request, 'build_opener', return_value=opener):
            self.assertEqual(self.d.http_json('/api/health', 5), {'status': 'ok'})
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://192.168.1.52:8766/api/health')
        self.assertEqual(request.get_header('Host'), 'dashboard.test:8766')

    def test_observed_main_does_not_rewind_with_release_rollback(self):
        state, _ = self.active()
        state['observed_main'] = B  # B was deployed, then manually rolled back to A.
        self.d.save(state)
        self.update_stubs(C)
        self.d.git.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        self.d.git.assert_called_once_with('merge-base', '--is-ancestor', B, C, check=False)
        self.d.eligible.assert_not_called()
        self.assertEqual(self.d.state()['observed_main'], B)
        # A rewrite back to the active SHA must also stop, not take the no-op path.
        self.d.fetch.return_value = A
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)

    def test_default_readiness_host_for_other_loopback_address(self):
        self.d.env['CCUSAGE_BIND_ADDRESS'] = '127.0.0.2'
        opener = mock.Mock()
        opener.open.return_value = io.BytesIO(b'{}')
        with mock.patch.object(manage.urllib.request, 'build_opener', return_value=opener):
            self.d.http_json('/api/health', 5)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'http://127.0.0.2:8766/api/health')
        self.assertEqual(request.get_header('Host'), '127.0.0.1:8766')

    def test_observed_main_survives_pending_ci(self):
        state, _ = self.active()
        self.update_stubs(B)
        self.d.eligible.side_effect = manage.Deferred('checks pending')
        with self.assertRaises(manage.Deferred):
            self.d.update(state)
        self.assertEqual(self.d.state()['observed_main'], B)
        self.d.fetch.return_value = C
        self.d.git.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaises(manage.DeploymentError):
            self.d.update(self.d.state())
        self.assertEqual(self.d.eligible.call_count, 1)

    def test_staging_transport_failure_retries_without_suppressing_sha(self):
        state, old = self.active()
        self.update_stubs(B)
        self.d.stage = mock.Mock(side_effect=manage.urllib.error.URLError('offline'))
        with mock.patch.object(manage.time, 'time', return_value=1000):
            with self.assertRaises(manage.Deferred):
                self.d.update(state)
            saved = self.d.state()
            self.assertIsNone(saved['failed_sha'])
            self.assertEqual(saved['defer_until'], 1300)
            self.assertEqual(self.d.link_record('current'), old)
            with self.assertRaises(manage.Deferred):
                self.d.update(saved)
        self.d.restart.assert_not_called()

    def test_invalid_state_and_symlink_are_rejected(self):
        state = self.d.state()
        for key, value in [('active', {'sha': '../bad'}), ('failed_sha', 'bad'),
                           ('pending', {'candidate': {}, 'previous': None}), ('defer_until', '0')]:
            with self.subTest(key=key):
                bad = dict(state, **{key: value})
                self.d.save(bad)
                with self.assertRaises(manage.DeploymentError):
                    self.d.state()
        self.d.state_path.unlink()
        self.d.state_path.symlink_to(self.home / 'other')
        with self.assertRaises(manage.DeploymentError):
            self.d.state()

    def test_ci_query_has_no_status_filter_and_selects_latest_attempt(self):
        self.set_pages(self.page(self.workflow(id=8, run_attempt=2, conclusion='failure'),
                                 self.workflow(id=7, run_attempt=1)))
        with self.assertRaises(manage.Deferred):
            self.d.eligible(B)
        query = parse_qs(urlparse(self.d.github_page.call_args.args[0]).query)
        self.assertNotIn('status', query)
        self.assertEqual(query['head_sha'], [B])

    def test_ci_pagination_and_order(self):
        runs = [self.workflow(id=i, run_number=i) for i in range(1, 101)]
        self.set_pages({'total_count': 101, 'workflow_runs': runs},
                       {'total_count': 101, 'workflow_runs': [self.workflow(id=101, run_number=101)]})
        self.assertEqual(self.d.eligible(B), 101)
        self.assertEqual(parse_qs(urlparse(self.d.github_page.call_args.args[0]).query)['page'], ['2'])

    def test_ci_rejects_identity_mismatch_and_non_success(self):
        for changes in ({'head_sha': A}, {'head_branch': 'other'}, {'event': 'pull_request'},
                        {'path': 'other'}, {'repository': {'full_name': 'other'}},
                        {'head_repository': {'full_name': 'other'}}):
            with self.subTest(changes=changes):
                self.set_pages(self.page(self.workflow(**changes)))
                with self.assertRaises(manage.DeploymentError):
                    self.d.eligible(B)
        for status, conclusion in [('queued', None), ('completed', 'failure'), ('completed', 'cancelled')]:
            with self.subTest(status=status, conclusion=conclusion):
                self.set_pages(self.page(self.workflow(status=status, conclusion=conclusion)))
                with self.assertRaises(manage.Deferred):
                    self.d.eligible(B)
        self.set_pages(self.page())
        with self.assertRaises(manage.Deferred):
            self.d.eligible(B)

    def test_rate_limit_persists_retry_and_blocks_fetch(self):
        self.d.github_page.side_effect = None
        self.d.github_page.wraps = None
        error = HTTPError('https://example.invalid', 429, 'limit',
                          {'Retry-After': '900', 'X-RateLimit-Reset': '1500'}, None)
        self.addCleanup(error.close)
        with mock.patch.object(manage.urllib.request, 'urlopen', side_effect=error), \
             mock.patch.object(manage.time, 'time', return_value=1000):
            with self.assertRaises(manage.Deferred):
                manage.Deployer.github_page(self.d, 'https://example.invalid')
            self.assertEqual(self.d.state()['defer_until'], 1900)
            self.d.fetch = mock.Mock()
            with self.assertRaises(manage.Deferred):
                self.d.update(self.d.state())
            self.d.fetch.assert_not_called()

    def test_same_sha_and_offline_leave_current_unchanged(self):
        state, old = self.active()
        self.update_stubs(A)
        self.assertEqual(self.d.update(state)['status'], 'unchanged')
        self.d.eligible.assert_not_called()
        self.d.restart.assert_not_called()
        self.d.fetch.side_effect = manage.DeploymentError('offline')
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        self.assertEqual(self.d.link_record('current'), old)
        self.assertEqual(self.d.state()['active'], old)

    def test_lock_contention(self):
        with self.d.lock():
            with self.assertRaises(manage.Deferred):
                with self.d.lock():
                    self.fail('acquired held lock')

    def test_unsafe_links_and_permissions_refused(self):
        state, old = self.active()
        self.update_stubs()
        (self.d.base / 'current').unlink()
        (self.d.base / 'current').symlink_to(self.home)
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        self.d.fetch.assert_not_called()
        (self.d.base / 'current').unlink()
        (self.d.base / 'current').write_text('unrelated')
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        (self.d.base / 'current').unlink()
        self.d.switch('current', old)
        (self.d.releases / A).chmod(0o777)
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)

    def test_link_target_must_match_its_own_release_metadata(self):
        state, old = self.active()
        self.release(B, 2)
        # The marker in B claims A, even though A itself is a valid release.
        (self.d.releases / B / '.deployment-release.json').write_text(json.dumps(old))
        (self.d.base / 'current').unlink()
        (self.d.base / 'current').symlink_to(self.d.releases / B)
        self.update_stubs()
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        self.d.fetch.assert_not_called()

    def test_paused_and_branch_rewrite(self):
        state, old = self.active()
        self.update_stubs()
        self.d.pause_path.write_text('paused')
        self.assertEqual(self.d.update(state)['status'], 'paused')
        self.d.fetch.assert_not_called()
        self.d.pause_path.unlink()
        self.d.git.return_value = subprocess.CompletedProcess([], 1)
        with self.assertRaises(manage.DeploymentError):
            self.d.update(state)
        self.d.eligible.assert_not_called()
        self.assertEqual(self.d.link_record('current'), old)

    def test_stage_failure_suppresses_sha_and_preserves_active(self):
        for reason in ('install failed', 'disk full'):
            with self.subTest(reason=reason):
                state, old = (self.active() if not (self.d.releases / A).exists() else (self.d.state(), self.d.link_record('current')))
                self.update_stubs()
                self.d.stage = mock.Mock(side_effect=manage.DeploymentError(reason))
                with self.assertRaises(manage.DeploymentError):
                    self.d.update(state)
                self.assertEqual(self.d.state()['failed_sha'], B)
                self.assertEqual(self.d.link_record('current'), old)
                self.d.restart.assert_not_called()
                with self.assertRaises(manage.Deferred):
                    self.d.update(self.d.state())
                self.assertEqual(self.d.stage.call_count, 1)
                state['failed_sha'] = None
                self.d.save(state)

    def test_real_disk_check_refuses_before_git(self):
        self.d.git = mock.Mock()
        with mock.patch.object(manage.shutil, 'disk_usage', return_value=mock.Mock(free=0)):
            with self.assertRaises(manage.DeploymentError):
                self.d.stage(B, 2)
        self.d.git.assert_not_called()
        self.assertFalse((self.d.releases / B).exists())

    def test_real_install_failure_removes_staging(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as tar:
            for name, body in [('.bun-version', b'1.3.11\n'),
                               ('package.json', b'{"dependencies":{"ccusage":"20.0.33"}}')]:
                info = tarfile.TarInfo(name)
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
        self.d.git = mock.Mock(return_value=subprocess.CompletedProcess([], 0, data.getvalue()))
        self.d.run.side_effect = manage.DeploymentError('install failed')
        with mock.patch.object(manage.shutil, 'disk_usage', return_value=mock.Mock(free=2**31)), \
             mock.patch.object(manage, 'ensure_runtime', return_value=Path('/fake/bun')):
            with self.assertRaises(manage.DeploymentError):
                self.d.stage(B, 2)
        self.assertEqual(list(self.d.releases.iterdir()), [])

    def stage_archive(self):
        # Git archives can preserve group-writable directory modes.
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as tar:
            directory = tarfile.TarInfo('src')
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o775
            tar.addfile(directory)
            for name, body in [('.bun-version', b'1.3.11\n'),
                               ('package.json', b'{"dependencies":{"ccusage":"20.0.33"}}'),
                               ('src/server.js', b'// server\n')]:
                info = tarfile.TarInfo(name)
                info.mode = 0o664
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
        self.d.git = mock.Mock(return_value=subprocess.CompletedProcess([], 0, data.getvalue()))
        self.d.run.side_effect = None
        self.d.run.return_value = subprocess.CompletedProcess([], 0)

    def test_stage_archive_permissions_are_accepted_by_launcher(self):
        self.stage_archive()
        with mock.patch.object(manage.shutil, 'disk_usage', return_value=mock.Mock(free=2**31)), \
             mock.patch.object(manage, 'ensure_runtime', return_value=Path('/fake/bun')):
            record = self.d.stage(B, 2)
        release = self.d.releases / B
        for path in (release, release / 'src', release / '.bun-version',
                     release / 'package.json', release / 'src/server.js'):
            with self.subTest(path=path):
                self.assertEqual(path.stat().st_mode & 0o022, 0)
        self.assertEqual(self.d.run.call_count, 2)
        self.d.switch('current', record)
        (self.d.base / 'runtimes').mkdir(mode=0o700)
        # Launcher changes cwd before exec; keep the test runner's cwd intact.
        with mock.patch.object(launch.runtime, '_existing', return_value=Path('/fake/bun')), \
             mock.patch.object(launch.os, 'chdir') as chdir, \
             mock.patch.object(launch.os, 'execve') as execve:
            launch.launch(self.d.home)
        chdir.assert_called_once_with(release)
        execve.assert_called_once_with('/fake/bun', ['/fake/bun', '--no-env-file', 'src/server.js'],
                                       manage.read_environment(self.d.config_path, self.d.home))

    def test_restage_inactive_sha_for_new_ci_run(self):
        self.stage_archive()
        with mock.patch.object(manage.shutil, 'disk_usage', return_value=mock.Mock(free=2**31)), \
             mock.patch.object(manage, 'ensure_runtime', return_value=Path('/fake/bun')):
            first = self.d.stage(B, 2)
            second = self.d.stage(B, 3)
        self.assertEqual(first['ci_run_id'], 2)
        self.assertEqual(second['ci_run_id'], 3)
        self.assertEqual(json.loads((self.d.releases / B / '.deployment-release.json').read_text()), second)

    def test_restage_never_relabels_active_or_previous(self):
        state, active = self.active()
        previous = self.release(B, 2)
        state['previous'] = previous
        self.d.switch('previous', previous)
        self.d.save(state)
        for record in (active, previous):
            with self.subTest(sha=record['sha']):
                path = self.d.releases / record['sha']
                before = (path / '.deployment-release.json').read_bytes()
                with self.assertRaises(manage.DeploymentError):
                    self.d.stage(record['sha'], record['ci_run_id'] + 10)
                self.assertTrue(path.is_dir())
                self.assertEqual((path / '.deployment-release.json').read_bytes(), before)
        self.assertEqual(self.d.link_record('current'), active)
        self.assertEqual(self.d.link_record('previous'), previous)

    def test_update_cleans_only_private_valid_staging_directories(self):
        def staging(parent, name, marker=None, mode=0o700):
            path = parent / name
            path.mkdir(mode=0o700)
            path.chmod(mode)
            if marker is not None:
                file = path / '.deployment-stage.json'
                file.write_text(json.dumps(marker))
                file.chmod(0o600)
            return path

        release_marker = {'schema_version': 1, 'purpose': 'release', 'owner_uid': os.getuid(), 'sha': B}
        cache_marker = {'schema_version': 1, 'purpose': 'cache', 'owner_uid': os.getuid(), 'origin': manage.ORIGIN}
        owned_release = staging(self.d.releases, '.stage-owned', release_marker)
        owned_cache = staging(self.d.base, '.cache-owned', cache_marker)
        unknown = [staging(self.d.releases, '.stage-unmarked'),
                   staging(self.d.base, '.cache-unmarked'),
                   staging(self.d.releases, '.stage-bad-sha', dict(release_marker, sha='bad')),
                   staging(self.d.base, '.cache-bad-origin', dict(cache_marker, origin='other')),
                   staging(self.d.releases, '.stage-bad-owner', dict(release_marker, owner_uid=os.getuid() + 1)),
                   staging(self.d.releases, 'unrelated', release_marker)]
        unrelated_file = self.d.base / '.cache-file'
        unrelated_file.write_text('keep')
        state, _ = self.active()
        self.update_stubs(A)
        with self.d.lock():
            self.d.update(state)
        self.assertFalse(owned_release.exists())
        self.assertFalse(owned_cache.exists())
        for path in [*unknown, unrelated_file]:
            with self.subTest(path=path):
                self.assertTrue(path.exists())

    def test_cleanup_does_not_remove_writable_staging(self):
        path = self.d.base / '.cache-writable'
        path.mkdir(mode=0o700)
        (path / '.deployment-stage.json').write_text(json.dumps({
            'schema_version': 1, 'purpose': 'cache', 'owner_uid': os.getuid(), 'origin': manage.ORIGIN}))
        (path / '.deployment-stage.json').chmod(0o600)
        path.chmod(0o777)
        with self.d.lock():
            try:
                self.d.cleanup_staging()
            except manage.DeploymentError:
                pass  # Refusing the update is also safe.
        self.assertTrue(path.is_dir())

    def test_failed_cache_initialization_does_not_publish_cache(self):
        def fail_init(args, **kwargs):
            self.assertIn('init', args)
            stages = list(self.d.base.glob('.cache-*'))
            self.assertEqual(len(stages), 1)
            marker = json.loads((stages[0] / '.deployment-stage.json').read_text())
            self.assertEqual(marker, {'schema_version': 1, 'purpose': 'cache',
                                      'owner_uid': os.getuid(), 'origin': manage.ORIGIN})
            self.assertFalse(self.d.cache.exists())
            raise manage.DeploymentError('git init failed')

        self.d.run.side_effect = fail_init
        with self.assertRaises(manage.DeploymentError):
            self.d.fetch()
        self.assertFalse(self.d.cache.exists())
        self.assertFalse(self.d.cache.is_symlink())

    def test_initialize_rejects_symlinked_ancestor(self):
        home = self.home / 'other-home'
        home.mkdir(mode=0o700)
        (home / '.local').symlink_to(self.home / '.local', target_is_directory=True)
        with self.assertRaises(manage.DeploymentError):
            manage.Deployer(home).initialize()

    def test_successful_transaction_records_atomic_links_and_state(self):
        state, old = self.active()
        candidate = self.release(B, 2)
        self.update_stubs()
        self.d.stage = mock.Mock(return_value=candidate)
        result = self.d.update(state)
        self.assertEqual(result['status'], 'deployed')
        self.assertEqual(self.d.link_record('current'), candidate)
        self.assertEqual(self.d.link_record('previous'), old)
        saved = self.d.state()
        self.assertEqual((saved['active'], saved['previous'], saved['pending']), (candidate, old, None))
        self.assertEqual(self.d.fetch.call_count, 2)
        self.assertEqual(self.d.eligible.call_count, 2)
        self.d.ready.assert_called_once_with(candidate)

    def test_changed_head_or_ci_after_staging_defers_activation(self):
        state, old = self.active()
        candidate = self.release(B, 2)
        self.update_stubs()
        self.d.stage = mock.Mock(return_value=candidate)
        self.d.fetch.side_effect = [B, C]
        with self.assertRaises(manage.Deferred):
            self.d.update(state)
        self.assertEqual(self.d.link_record('current'), old)
        self.d.restart.assert_not_called()
        self.d.fetch.side_effect = [B, B]
        self.d.eligible.side_effect = [2, 3]
        with self.assertRaises(manage.Deferred):
            self.d.update(state)
        self.assertEqual(self.d.link_record('current'), old)
        self.d.restart.assert_not_called()

    def test_ready_requires_fresh_valid_usage_even_when_health_is_ok(self):
        record = self.release(A)
        expected = self.d.release_path(record).resolve()
        original_resolve = Path.resolve

        def resolve(path, *args, **kwargs):
            if str(path) == '/proc/123/cwd':
                return expected
            return original_resolve(path, *args, **kwargs)

        health = {'status': 'ok', 'schemaVersion': 1, 'ccusageVersion': '20.0.33'}
        valid = {'schemaVersion': 1, 'stale': False, 'days': [],
                 'generatedAt': '2026-11-03T00:00:00.000Z', 'warnings': [],
                 'metadata': {'ccusageVersion': '20.0.33', 'offline': True,
                              'pricingMode': 'auto', 'limitations': []}}
        self.d.run.side_effect = None
        self.d.run.return_value = subprocess.CompletedProcess([], 0, b'123')
        with mock.patch.object(Path, 'resolve', resolve):
            for usage in (dict(valid, stale=True), dict(valid, error='failed'),
                          dict(valid, days=None), dict(valid, schemaVersion=2)):
                with self.subTest(usage=usage):
                    self.d.http_json = mock.Mock(side_effect=[health, usage])
                    with self.assertRaises(manage.DeploymentError):
                        self.d.ready(record)
            self.d.http_json = mock.Mock(side_effect=[health, valid])
            self.d.ready(record)

    def test_startup_or_usage_failure_rolls_back_and_records_failure(self):
        for failure in ('restart', 'ready'):
            with self.subTest(failure=failure):
                state, old = self.active() if not (self.d.releases / A).exists() else (self.d.state(), self.d.link_record('current'))
                candidate = {'sha': B, 'runtime': '1.3.11', 'ci_run_id': 2}
                if not (self.d.releases / B).exists():
                    self.release(B, 2)
                self.update_stubs()
                getattr(self.d, failure).side_effect = [manage.DeploymentError(failure), None]
                with self.assertRaises(manage.DeploymentError):
                    self.d.activate(state, candidate)
                self.assertEqual(self.d.link_record('current'), old)
                saved = self.d.state()
                self.assertEqual(saved['active'], old)
                self.assertIsNone(saved['pending'])
                self.assertEqual(saved['failed_sha'], B)
                self.d.ready.assert_called_with(old)

    def test_failed_rollback_pauses_and_stops(self):
        state, _ = self.active()
        candidate = self.release(B, 2)
        self.update_stubs()
        self.d.ready.side_effect = manage.DeploymentError('not ready')
        with self.assertRaises(manage.DeploymentError):
            self.d.activate(state, candidate)
        self.assertTrue(self.d.pause_path.exists())
        self.d.stop.assert_called_once()
        self.assertIsNotNone(self.d.state()['pending'])

    def test_first_install_failure_stops(self):
        candidate = self.release(B, 2)
        self.update_stubs()
        self.d.ready.side_effect = manage.DeploymentError('bad usage')
        with self.assertRaises(manage.DeploymentError):
            self.d.activate(self.d.state(), candidate)
        self.d.stop.assert_called_once()
        self.assertIsNone(self.d.link_record('current'))
        self.assertIsNone(self.d.state()['active'])
        self.assertEqual(self.d.state()['failed_sha'], B)

    def test_interrupted_pending_recovers_before_same_sha_noop(self):
        state, old = self.active()
        candidate = self.release(B, 2)
        state['pending'] = {'candidate': candidate, 'previous': old}
        self.d.save(state)
        self.d.switch('current', candidate)
        self.update_stubs(A)
        self.assertEqual(self.d.update(self.d.state())['status'], 'unchanged')
        self.assertEqual(self.d.link_record('current'), old)
        self.assertEqual(self.d.state()['failed_sha'], B)
        self.assertIsNone(self.d.state()['pending'])
        self.d.ready.assert_called_once_with(old)

    def test_manual_rollback_pauses_timer(self):
        state, old = self.active()
        candidate = self.release(B, 2)
        self.update_stubs()
        self.d.activate(state, candidate)
        result = self.d.rollback(state)
        self.assertEqual(result['status'], 'rolled-back')
        self.assertTrue(self.d.pause_path.exists())
        self.assertEqual(self.d.link_record('current'), old)
        self.assertEqual(self.d.link_record('previous'), candidate)
        self.assertEqual(self.d.update(self.d.state())['status'], 'paused')

    def test_cleanup_only_validated_owned_releases(self):
        state, old = self.active()
        previous = self.release(B, 2)
        state['previous'] = previous
        extra = self.release(C, 3)
        arbitrary = self.d.releases / 'do-not-touch'
        arbitrary.mkdir()
        (arbitrary / 'data').write_text('keep')
        self.d.cleanup(state)
        self.assertTrue((self.d.releases / A).exists())
        self.assertTrue((self.d.releases / B).exists())
        self.assertFalse((self.d.releases / extra['sha']).exists())
        self.assertTrue((arbitrary / 'data').exists())
        bad = self.d.releases / C
        bad.mkdir()
        (bad / '.deployment-release.json').write_text(json.dumps(old))
        with self.assertRaises(manage.DeploymentError):
            self.d.cleanup(state)
        self.assertTrue(bad.exists())


if __name__ == '__main__':
    unittest.main()
