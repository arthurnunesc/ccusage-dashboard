#!/usr/bin/env python3
"""CI-gated native releases. Uses only the standard library and host tools."""

import argparse
import contextlib
import fcntl
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from runtime import ensure_runtime
from readiness import validate_snapshot


REPOSITORY = "arthurnunesc/ccusage-dashboard"
ORIGIN = f"https://github.com/{REPOSITORY}.git"
UNIT = "ccusage-dashboard.service"
SHA = re.compile(r"[0-9a-f]{40}\Z")
VERSION = re.compile(r"\d+\.\d+\.\d+\Z")
ENV_KEYS = {
    "PORT", "CCUSAGE_BIND_ADDRESS", "CCUSAGE_ALLOWED_HOSTS", "CCUSAGE_CONFIG",
    "CCUSAGE_OFFLINE", "CCUSAGE_CACHE_TTL_MS", "CCUSAGE_TIMEOUT_MS",
    "CCUSAGE_MAX_OUTPUT_BYTES", "CCUSAGE_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
}


class DeploymentError(Exception):
    """An actionable error whose message contains no subprocess/source data."""


class Deferred(DeploymentError):
    """No eligible release; leave the healthy process alone."""


def owned(path, directory=False):
    """Never follow an unexpected symlink or accept another owner's target."""
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o022):
        raise DeploymentError(f"Refusing unsafe target: {path}")


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    owned(path, directory=True)


def atomic_write(path, value):
    if path.exists() or path.is_symlink():
        owned(path)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path):
    owned(path)
    if path.stat().st_size > 64 * 1024:
        raise DeploymentError(f"Oversized metadata: {path}")
    try:
        return json.loads(path.read_text())
    except (ValueError, UnicodeError) as error:
        raise DeploymentError(f"Invalid metadata: {path}") from error


def record_valid(record):
    return (isinstance(record, dict)
            and SHA.fullmatch(str(record.get("sha", ""))) is not None
            and VERSION.fullmatch(str(record.get("runtime", ""))) is not None
            and type(record.get("ci_run_id")) is int
            and record["ci_run_id"] > 0)


def read_environment(path, home):
    owned(path)
    if path.stat().st_mode & 0o077:
        raise DeploymentError("dashboard.env must have mode 0600")
    env = {"HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin", "TZ": "UTC",
           "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
           "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus"}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if (not separator or key not in ENV_KEYS or value != value.strip()
                or any(char in value for char in "\x00\"'\\$`%") or key in env):
            raise DeploymentError("dashboard.env requires unique, unquoted supported KEY=value lines")
        env[key] = value
    # Native source discovery must use stable absolute paths, not a staging cwd.
    for key in ("CCUSAGE_CONFIG", "CCUSAGE_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
                "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
        if key in env and not Path(env[key]).is_absolute():
            raise DeploymentError(f"{key} must be an absolute path in dashboard.env")
    return env


class Deployer:
    def __init__(self, home=None):
        self.home = Path(home or Path.home()).resolve()
        self.base = self.home / ".local/share/ccusage-dashboard"
        self.releases = self.base / "releases"
        self.cache = self.base / "repository.git"
        self.state_dir = self.home / ".local/state/ccusage-dashboard"
        self.state_path = self.state_dir / "deployment.json"
        self.pause_path = self.state_dir / "update-paused"
        self.config_path = self.home / ".config/ccusage-dashboard/dashboard.env"
        self.env = {"HOME": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin"}

    def initialize(self):
        for target in (self.base, self.state_dir, self.config_path.parent):
            path = target
            while path != self.home:
                if path.exists() or path.is_symlink():
                    owned(path, directory=True)
                path = path.parent
            owned(self.home, directory=True)
        for path in (self.base, self.releases, self.state_dir):
            private_directory(path)
        self.env = read_environment(self.config_path, self.home)

    @contextlib.contextmanager
    def lock(self):
        path = self.state_dir / "deploy.lock"
        if path.exists() or path.is_symlink():
            owned(path)
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Deferred("Another deployment operation holds deploy.lock") from error
            yield
        finally:
            os.close(fd)

    def state(self):
        if not self.state_path.exists() and not self.state_path.is_symlink():
            return {"schema_version": 1, "active": None, "previous": None,
                    "pending": None, "failed_sha": None, "defer_until": 0,
                    "observed_main": None}
        value = read_json(self.state_path)
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            raise DeploymentError("Unsupported deployment state; inspect deployment.json")
        for key in ("active", "previous"):
            if key not in value or (value[key] is not None and not record_valid(value[key])):
                raise DeploymentError("Invalid release in deployment state")
        pending = value.get("pending")
        if pending is not None and (not isinstance(pending, dict)
                or not record_valid(pending.get("candidate"))
                or pending.get("previous") != value["active"]):
            raise DeploymentError("Invalid pending deployment transaction")
        if value.get("failed_sha") is not None and not SHA.fullmatch(str(value["failed_sha"])):
            raise DeploymentError("Invalid failed SHA in state")
        if (type(value.get("defer_until")) not in (int, float)
                or not math.isfinite(value["defer_until"]) or value["defer_until"] < 0):
            raise DeploymentError("Invalid retry time in state")
        value.setdefault("observed_main", None)
        if value["observed_main"] is not None and not SHA.fullmatch(str(value["observed_main"])):
            raise DeploymentError("Invalid observed main SHA in state")
        return value

    def save(self, state):
        atomic_write(self.state_path, json.dumps(state, sort_keys=True) + "\n")

    def run(self, args, cwd=None, timeout=60, check=True, env=None):
        environment = dict(env or self.env)
        environment.update({"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/bin/false",
                            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"})
        process = subprocess.Popen(args, cwd=cwd, env=environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            output, _ = process.communicate(timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
        if check and process.returncode:
            raise DeploymentError(f"{Path(args[0]).name} failed (exit {process.returncode}); current release unchanged unless rollback was required")
        return subprocess.CompletedProcess(args, process.returncode, output)

    def git(self, *args, check=True):
        return self.run(["git", "-c", "core.hooksPath=/dev/null", "--git-dir", str(self.cache),
                         *args], timeout=120, check=check)

    def fetch(self):
        if not self.cache.exists() and not self.cache.is_symlink():
            # Publish only a complete cache. An interrupted init must not leave a
            # permanent, apparently unrelated repository.git in the live slot.
            with tempfile.TemporaryDirectory(prefix=".cache-", dir=self.base) as temporary:
                stage = Path(temporary)
                self.mark_stage(stage, "cache", origin=ORIGIN)
                self.run(["git", "-c", "core.hooksPath=/dev/null", "init", "--bare", str(stage)])
                self.run(["git", "--git-dir", str(stage), "remote", "add", "origin", ORIGIN])
                atomic_write(stage / ".deployment-cache", ORIGIN + "\n")
                if self.cache.exists() or self.cache.is_symlink():
                    raise DeploymentError("Git cache appeared during initialization; inspect before retry")
                os.rename(stage, self.cache)
        owned(self.cache, directory=True)
        marker = self.cache / ".deployment-cache"
        owned(marker)
        if marker.read_text().strip() != ORIGIN:
            raise DeploymentError("Refusing unrelated Git cache")
        if self.git("remote", "get-url", "origin").stdout.decode().strip() != ORIGIN:
            raise DeploymentError("Git cache origin changed; manual review required")
        self.git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
        sha = self.git("rev-parse", "refs/remotes/origin/main^{commit}").stdout.decode().strip()
        if not SHA.fullmatch(sha):
            raise DeploymentError("Git returned an invalid commit SHA")
        return sha

    def observe_main(self, state):
        sha = self.fetch()
        previous = state["observed_main"] or (state["active"]["sha"] if state["active"] else None)
        if previous and previous != sha and self.git("merge-base", "--is-ancestor", previous, sha,
                                                      check=False).returncode != 0:
            raise DeploymentError("Non-fast-forward main requires manual review")
        # Track the accepted branch head even if CI/staging later fails, and do
        # not rewind it during manual release rollback.
        state["observed_main"] = sha
        self.save(state)
        return sha

    def github_page(self, url):
        request = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "ccusage-dashboard-updater",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read(2 * 1024 * 1024 + 1)
                if len(data) > 2 * 1024 * 1024:
                    raise DeploymentError("GitHub response exceeds the metadata limit")
                return json.loads(data)
        except urllib.error.HTTPError as error:
            if error.code in (403, 429):
                now = time.time()
                try:
                    delay = float(error.headers.get("Retry-After", "0"))
                    reset = float(error.headers.get("X-RateLimit-Reset", "0"))
                except ValueError:
                    delay, reset = 300, now + 300
                state = self.state()
                state["defer_until"] = max(now + 300, now + delay, reset)
                self.save(state)
                raise Deferred("GitHub access/rate limit: waiting before retry; confirm public Actions read access") from error
            raise DeploymentError("GitHub metadata request failed; no unchecked deployment") from error
        except (ValueError, OSError) as error:
            raise DeploymentError("Cannot read GitHub metadata; running release unchanged") from error

    def eligible(self, sha):
        runs = []
        total = None
        # The endpoint caps filtered results at 1000. Fail closed above that.
        for page in range(1, 11):
            query = urllib.parse.urlencode({"branch": "main", "event": "push", "head_sha": sha,
                                            "per_page": 100, "page": page})
            payload = self.github_page(f"https://api.github.com/repos/{REPOSITORY}/actions/workflows/ci.yml/runs?{query}")
            if (not isinstance(payload, dict) or type(payload.get("total_count")) is not int
                    or not isinstance(payload.get("workflow_runs"), list)):
                raise DeploymentError("Malformed workflow-runs response")
            if total is None:
                total = payload["total_count"]
            if total != payload["total_count"] or not 0 <= total <= 1000:
                raise Deferred("Workflow run list changed or exceeds the limit; retry later")
            runs.extend(payload["workflow_runs"])
            if len(runs) >= total:
                break
            if not payload["workflow_runs"]:
                raise DeploymentError("Incomplete workflow-runs response")
        if not runs:
            raise Deferred("No Checks push run exists for current main")
        for run in runs:
            if (not isinstance(run, dict) or run.get("head_sha") != sha
                    or run.get("head_branch") != "main" or run.get("event") != "push"
                    or run.get("path") != ".github/workflows/ci.yml"
                    or not isinstance(run.get("repository"), dict)
                    or not isinstance(run.get("head_repository"), dict)
                    or run.get("repository", {}).get("full_name") != REPOSITORY
                    or run.get("head_repository", {}).get("full_name") != REPOSITORY
                    or any(type(run.get(key)) is not int or run[key] < 1
                           for key in ("id", "run_number", "run_attempt"))):
                raise DeploymentError("Workflow run identity mismatch; refusing deployment")
        latest = max(runs, key=lambda run: (run["run_number"], run["run_attempt"], run["id"]))
        if latest.get("status") != "completed" or latest.get("conclusion") != "success":
            raise Deferred("Latest Checks run/attempt for current main is not successful")
        return latest["id"]

    def release_path(self, record):
        if not record_valid(record):
            raise DeploymentError("Invalid release record")
        path = self.releases / record["sha"]
        owned(path, directory=True)
        if read_json(path / ".deployment-release.json") != record:
            raise DeploymentError("Release ownership/metadata mismatch")
        if (path / ".bun-version").read_text().strip() != record["runtime"]:
            raise DeploymentError("Release runtime pin changed")
        return path

    def link_record(self, name):
        path = self.base / name
        if not path.is_symlink():
            if path.exists():
                raise DeploymentError(f"Refusing non-symlink {name} target")
            return None
        target = path.resolve(strict=True)
        if target.parent != self.releases.resolve() or not SHA.fullmatch(target.name):
            raise DeploymentError(f"Refusing unrelated {name} link")
        record = read_json(target / ".deployment-release.json")
        if not record_valid(record) or record["sha"] != target.name:
            raise DeploymentError(f"Refusing mismatched {name} release metadata")
        self.release_path(record)
        return record

    def switch(self, name, record):
        self.link_record(name)  # Refuse overwriting unrelated files/links.
        path = self.base / name
        if record is None:
            if path.is_symlink():
                path.unlink()
            return
        release = self.release_path(record)
        temporary = self.base / f".{name}-{os.getpid()}"
        if temporary.exists() or temporary.is_symlink():
            raise DeploymentError("Unexpected temporary activation link")
        try:
            temporary.symlink_to(release)
            os.replace(temporary, path)
            directory = os.open(self.base, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if temporary.is_symlink():
                temporary.unlink()

    def stage(self, sha, ci_run_id):
        target = self.releases / sha
        if target.exists() or target.is_symlink():
            record = read_json(target / ".deployment-release.json")
            self.release_path(record)
            if record["sha"] != sha:
                raise DeploymentError("Existing staged release has mismatched SHA")
            if record["ci_run_id"] == ci_run_id:
                return record
            # A new successful run can supersede the receipt of an inactive
            # staged release. Restage it, never edit an active/rollback release.
            state = self.state()
            retained = [state["active"], state["previous"]]
            if state["pending"]:
                retained.append(state["pending"]["candidate"])
            if any(item and item["sha"] == sha for item in retained):
                raise DeploymentError("Cannot restage an active or rollback release")
            shutil.rmtree(target)
        # Leave enough room for a production install without evicting rollback.
        if shutil.disk_usage(self.base).free < 1024 * 1024 * 1024:
            raise DeploymentError("Less than 1 GiB free; preserve current/rollback and free space manually")
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=self.releases) as temporary:
            stage = Path(temporary)
            self.mark_stage(stage, "release", sha=sha)
            archive = self.git("archive", "--format=tar", sha).stdout
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                members = source.getmembers()
                for member in members:
                    parts = Path(member.name).parts
                    if (Path(member.name).is_absolute() or ".." in parts
                            or not (member.isfile() or member.isdir())):
                        raise DeploymentError("Release archive contains unsupported paths or links")
                # Python 3.11 preserves Git archive's 0775/0664 modes by default;
                # newer Python filters may change them. Set private modes here
                # explicitly so the exact same release passes launcher checks.
                for member in members:
                    destination = stage / member.name
                    if destination.name in {".deployment-stage.json", ".deployment-release.json"}:
                        raise DeploymentError("Release archive contains reserved deployment metadata")
                    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if member.isdir():
                        destination.mkdir(mode=0o700, exist_ok=True)
                    else:
                        with source.extractfile(member) as contents, destination.open("xb") as output:
                            shutil.copyfileobj(contents, output)
                        destination.chmod(0o700 if member.mode & 0o111 else 0o600)
            version = (stage / ".bun-version").read_text().strip()
            if not VERSION.fullmatch(version):
                raise DeploymentError("Release requires an exact Bun version")
            package = json.loads((stage / "package.json").read_text())
            if package.get("dependencies", {}).get("ccusage") != "20.0.33":
                raise DeploymentError("ccusage pin changed; update the reviewed deployment contract first")
            bun = ensure_runtime(self.base, version, self.env)
            self.run([str(bun), "install", "--no-env-file", "--production", "--frozen-lockfile"],
                     cwd=stage, timeout=600)
            # Imports validate configuration/native resolution, but never scan real data.
            self.run([str(bun), "--no-env-file", "--eval",
                      'import {loadConfig} from "./src/config.js"; '
                      'import {resolveBinary} from "./src/ccusage.js"; '
                      'import {accessSync,constants} from "node:fs"; '
                      'const c=loadConfig(); accessSync(c.binary ?? resolveBinary(),constants.X_OK);'],
                     cwd=stage)
            record = {"sha": sha, "runtime": version, "ci_run_id": ci_run_id}
            atomic_write(stage / ".deployment-release.json", json.dumps(record) + "\n")
            os.rename(stage, target)
            # TemporaryDirectory cleans its now-absent original path only.
            return record

    def mark_stage(self, path, purpose, **details):
        atomic_write(path / ".deployment-stage.json", json.dumps({
            "schema_version": 1, "purpose": purpose, "owner_uid": os.getuid(), **details,
        }) + "\n")

    def cleanup_staging(self):
        # The updater lock excludes another active transaction. Markers distinguish
        # our interrupted installs from arbitrary files in the dedicated roots.
        for root, prefix, purpose in ((self.releases, ".stage-", "release"),
                                      (self.base, ".cache-", "cache")):
            for path in root.iterdir():
                if not path.name.startswith(prefix) or path.is_symlink() or not path.is_dir():
                    continue
                marker = path / ".deployment-stage.json"
                if not marker.exists():
                    continue
                owned(path, directory=True)
                if path.stat().st_mode & 0o077:
                    continue  # Not a private staging tree; leave it for review.
                data = read_json(marker)
                if (not isinstance(data, dict) or data.get("schema_version") != 1
                        or data.get("purpose") != purpose or data.get("owner_uid") != os.getuid()
                        or (purpose == "release" and not SHA.fullmatch(str(data.get("sha", ""))))
                        or (purpose == "cache" and data.get("origin") != ORIGIN)):
                    continue
                shutil.rmtree(path)

    def restart(self):
        self.run(["systemctl", "--user", "reset-failed", UNIT], check=False)
        self.run(["systemctl", "--user", "restart", UNIT])

    def stop(self):
        self.run(["systemctl", "--user", "stop", UNIT])

    def http_json(self, path, timeout):
        host = self.env.get("CCUSAGE_BIND_ADDRESS", "127.0.0.1")
        port = self.env.get("PORT", "8766")
        # Local readiness must not use a user's HTTP proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        authority = self.env.get("CCUSAGE_ALLOWED_HOSTS", f"127.0.0.1:{port}").split(",")[0].strip()
        request = urllib.request.Request(f"http://{host}:{port}{path}", headers={"Host": authority})
        with opener.open(request, timeout=timeout) as response:
            size = int(self.env.get("CCUSAGE_MAX_OUTPUT_BYTES", "67108864")) * 2
            data = response.read(size + 1)
            if len(data) > size:
                raise DeploymentError("Readiness response exceeds the configured limit")
            return json.loads(data)

    def ready(self, record):
        expected = self.release_path(record).resolve()
        deadline = time.monotonic() + 30
        while True:
            try:
                pid = int(self.run(["systemctl", "--user", "show", UNIT,
                                    "--property=MainPID", "--value"]).stdout.strip())
                health = self.http_json("/api/health", 5)
                if (not isinstance(health, dict)
                        or pid <= 0 or Path(f"/proc/{pid}/cwd").resolve() != expected
                        or health.get("status") != "ok" or health.get("schemaVersion") != 1
                        or health.get("ccusageVersion") != "20.0.33"):
                    raise DeploymentError("Running process/health does not match selected release")
                break
            except (OSError, ValueError, DeploymentError):
                if time.monotonic() >= deadline:
                    raise DeploymentError("App did not become live in its selected release")
                time.sleep(1)
        usage = self.http_json("/api/usage", int(self.env.get("CCUSAGE_TIMEOUT_MS", "120000")) / 1000 + 15)
        try:
            validate_snapshot(usage)
        except ValueError as error:
            raise DeploymentError("App usage readiness failed; empty valid history is allowed") from error

    def recover(self, state):
        pending = state["pending"]
        if pending is None:
            return
        # Persist failure before touching links so interrupted recovery is repeatable.
        state["failed_sha"] = pending["candidate"]["sha"]
        self.save(state)
        try:
            self.switch("current", pending["previous"])
            if pending["previous"]:
                self.restart()
                self.ready(pending["previous"])
            else:
                self.stop()
            self.switch("previous", state["previous"])
            state["pending"] = None
            self.save(state)
        except Exception as error:
            atomic_write(self.pause_path, "Rollback failed; inspect deployment.json and journal before resume.\n")
            self.stop()
            raise DeploymentError("Rollback failed: updates paused. Inspect deployment.json and journalctl --user -u ccusage-dashboard.service; repair the last healthy release before resume") from error

    def activate(self, state, candidate):
        state["pending"] = {"candidate": candidate, "previous": state["active"]}
        self.save(state)
        try:
            self.switch("current", candidate)
            self.restart()
            self.ready(candidate)
        except Exception as error:
            self.recover(state)
            raise DeploymentError("Candidate activation failed; restored last healthy release (or stopped failed first install)") from error
        state["previous"], state["active"] = state["active"], candidate
        # Update the convenience pointer before committing state; pending recovery
        # restores both pointers if interrupted here.
        self.switch("previous", state["previous"])
        state["pending"] = None
        state["failed_sha"] = None
        self.save(state)

    def cleanup(self, state):
        keep = {record["sha"] for record in (state["active"], state["previous"]) if record}
        for path in self.releases.iterdir():
            if path.name in keep or not SHA.fullmatch(path.name):
                continue  # Never sweep arbitrary files or interrupted staging trees.
            record = read_json(path / ".deployment-release.json")
            if record["sha"] != path.name:
                raise DeploymentError("Refusing cleanup of unrelated release")
            self.release_path(record)
            shutil.rmtree(path)  # Only a validated, owned release; never native history.
        # Runtimes stay installed: the runbook supplies explicit reviewed cleanup.

    def update(self, state):
        if self.pause_path.exists():
            return {"status": "paused"}
        self.recover(state)
        self.cleanup_staging()
        if time.time() < state["defer_until"]:
            raise Deferred("Waiting for the recorded network retry time")
        # Validate all pointers before staging or starting any process.
        for name in ("current", "previous"):
            if self.link_record(name) != state[name if name == "previous" else "active"]:
                raise DeploymentError("Release links differ from state; inspect before deploying")
        sha = self.observe_main(state)
        if state["active"] and sha == state["active"]["sha"]:
            return {"status": "unchanged", "sha": sha}
        if sha == state["failed_sha"]:
            raise Deferred("This SHA previously failed; use retry or wait for a new commit")
        ci_run_id = self.eligible(sha)
        try:
            candidate = self.stage(sha, ci_run_id)
        except (urllib.error.URLError, TimeoutError, subprocess.TimeoutExpired) as error:
            state["defer_until"] = time.time() + 300
            self.save(state)
            raise Deferred("Staging transport/timeout failure; current release unchanged, retry after five minutes") from error
        except Exception:
            state["failed_sha"] = sha
            self.save(state)
            raise
        if self.observe_main(state) != sha or self.eligible(sha) != ci_run_id:
            raise Deferred("main or its Checks run changed during staging; deferred activation")
        self.activate(state, candidate)
        self.cleanup(state)
        return {"status": "deployed", **candidate}

    def rollback(self, state):
        atomic_write(self.pause_path, "Manual rollback: automatic updates paused.\n")
        self.recover(state)
        if not state["previous"]:
            raise DeploymentError("No healthy previous release exists; updates remain paused")
        self.release_path(state["previous"])
        self.activate(state, state["previous"])
        return {"status": "rolled-back", "sha": state["active"]["sha"], "updates": "paused"}


def parser():
    result = argparse.ArgumentParser(description=__doc__, epilog=(
        "Examples:\n  python3 scripts/deploy/manage.py update --dry-run\n"
        "  python3 ~/.local/lib/ccusage-dashboard/manage.py update\n"
        "  python3 ~/.local/lib/ccusage-dashboard/manage.py pause\n"
        "  python3 ~/.local/lib/ccusage-dashboard/manage.py rollback"),
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = result.add_subparsers(dest="command", required=True)
    for name, description in {
        "update": "Deploy exact main only after Checks succeeds",
        "status": "Read recorded deployment state without changing anything",
        "pause": "Pause automatic updates without stopping the app",
        "resume": "Resume checks; does not deploy immediately",
        "retry": "Clear the failed SHA; run update separately after resume",
        "rollback": "Pause updates and activate the previous healthy release",
    }.items():
        command = sub.add_parser(name, description=description, help=description,
                                 epilog=f"Example: python3 ~/.local/lib/ccusage-dashboard/manage.py {name}")
        if name == "update":
            command.add_argument("--dry-run", action="store_true", help="Show intended steps without network, files, or service changes")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    deployer = Deployer()
    try:
        if args.command == "status":
            print(json.dumps({**deployer.state(), "paused": deployer.pause_path.exists()}, sort_keys=True))
            return 0
        if args.command == "update" and args.dry_run:
            print(json.dumps({"status": "dry-run", "origin": ORIGIN, "branch": "main",
                              "base": str(deployer.base), "steps": ["verify latest Checks", "stage frozen production dependencies", "activate", "health and usage readiness", "rollback on failure"]}))
            return 0
        deployer.initialize()
        with deployer.lock():
            state = deployer.state()
            if args.command == "update":
                output = deployer.update(state)
            elif args.command == "rollback":
                output = deployer.rollback(state)
            elif args.command == "pause":
                atomic_write(deployer.pause_path, "Operator paused updates.\n")
                output = {"status": "paused"}
            elif args.command == "resume":
                if state["pending"]:
                    deployer.recover(state)
                if deployer.pause_path.exists():
                    owned(deployer.pause_path)
                    deployer.pause_path.unlink()
                output = {"status": "resumed"}
            else:
                state["failed_sha"] = None
                deployer.save(state)
                output = {"status": "retry-enabled", "next": "resume if paused, then update"}
            print(json.dumps(output, sort_keys=True))
        return 0
    except Deferred as error:
        print(json.dumps({"status": "deferred", "reason": str(error)}))
        return 0
    except (DeploymentError, OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not expose source paths from subprocess diagnostics or response bodies.
        message = str(error) if isinstance(error, DeploymentError) else "Deployment operation failed; inspect owned files and prerequisites"
        print(json.dumps({"status": "error", "reason": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Deployment interrupted; next update recovers recorded pending activation", file=sys.stderr)
        sys.exit(130)
