#!/usr/bin/env python3
"""Secretless fork-only installed CLI proof; no GitHub writes or raw logs in artifacts."""

import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

HEAD = "fe376fb7d15377cc9ab870cd6acf58c4d57d3ffd"
FORK = "oshaughnessy-junior/openclaw"
BRANCH = "refs/heads/proof/pr205356-installed-cli-20261127"
SOURCE = "extensions/ollama/src/embedding-provider.runtime.ts"
SOURCE_SHA = "f86346e93785dd7161d1e9ddd206058a6ba098235d0335dfac4421d834cdd33a"
OLLAMA = "0.34.2"
OLLAMA_ARCHIVE = "e155b83589986d2c581fdbf1381ea3ebdb16549883679cd5a0627f7cdc05b12b"
REGISTRY = "https://registry.ollama.ai/v2/library/nomic-embed-text"
MODEL = "nomic-embed-text:latest"
MODEL_MANIFEST = "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f"
SENTINEL = "FINAL PUBLIC SYNTHETIC SENTINEL 205356"
FITTING = "Which lighthouse has the violet lamp?"
OVERSIZED = "public synthetic memory fixture " * 3000 + SENTINEL  # < Linux per-argument limit.
CONTEXT_ERROR = re.compile(r"input length exceeds the context length", re.I)


class ProofError(Exception):
    """Only fixed, sanitized proof messages may be written to the receipt."""


def require(ok, message):
    if not ok:
        raise ProofError(message)


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def group_exists(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def listening(port):
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def child_receipt(payload, reply, status):
    # Keep hashes/lengths, not the body, model response, or headers.
    inputs = payload.get("input")
    inputs = [inputs] if isinstance(inputs, str) else inputs
    if not isinstance(inputs, list) or any(not isinstance(x, str) for x in inputs):
        raise ProofError("unexpected input at /api/embed")
    embeddings = reply.get("embeddings") or []
    return {
        "modelMatches": payload.get("model") in (MODEL, "nomic-embed-text"),
        "truncateFalse": payload.get("truncate") is False,
        "inputs": [{"sha256": sha_bytes(s.encode()), "utf8Bytes": len(s.encode()),
                    "terminalSentinel": s.endswith(SENTINEL)} for s in inputs],
        "httpStatus": status,
        "embeddingDimensions": [len(x) for x in embeddings],
        "contextLengthError": bool(CONTEXT_ERROR.search(str(reply.get("error", "")))),
    }


class Proof:
    def __init__(self, root, source, receipt):
        self.root, self.source, self.receipt = root, source, receipt
        self.trace = []
        self.phase = "idle"
        self.proxy = self.thread = None
        self.ollama_port = self.proxy_port = None
        self.groups = []
        self.marker = f"OPENCLAW_PROOF_OWNER={root.name}".encode()
        self.env = {
            "PATH": os.environ["PATH"], "CI": "true", "LANG": "C.UTF-8",
            "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
            "XDG_CONFIG_HOME": str(root / "xdg-config"), "XDG_CACHE_HOME": str(root / "xdg-cache"),
            "XDG_DATA_HOME": str(root / "xdg-data"), "XDG_STATE_HOME": str(root / "xdg-state"),
            "OPENCLAW_HOME": str(root / "home"), "OPENCLAW_STATE_DIR": str(root / "state"),
            "OPENCLAW_CONFIG_PATH": str(root / "state" / "openclaw.json"),
            "npm_config_cache": str(root / "npm-cache"),
            "npm_config_userconfig": str(root / "empty.npmrc"),
            "npm_config_globalconfig": str(root / "empty-global.npmrc"),
            "npm_config_registry": "https://registry.npmjs.org/",
            "COREPACK_HOME": str(root / "corepack"), "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "COREPACK_ENV_FILE": "0", "PNPM_HOME": str(root / "bin"),
            "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "OPENCLAW_PROOF_OWNER": root.name,
        }
        for name in ("home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state",
                     "state", "workspace", "bin", "npm-prefix", "package", "ollama", "models"):
            (root / name).mkdir(mode=0o700)
        for name in ("empty.npmrc", "empty-global.npmrc"):
            (root / name).touch()
        self.env["PATH"] = f"{root / 'bin'}:{self.env['PATH']}"

    def finish_group(self, child):
        pgid = child.pid  # Popen used start_new_session; never signal the workflow's group.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if not group_exists(pgid):
                break
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                break
            until = time.monotonic() + 4
            while time.monotonic() < until:
                child.poll()
                if not group_exists(pgid):
                    break
                time.sleep(0.1)
        child.wait(timeout=4)
        return not group_exists(pgid)

    def spawn(self, argv, log, cwd=None, env=None):
        child = subprocess.Popen(
            [str(x) for x in argv], env=self.env if env is None else env,
            cwd=cwd or self.root, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.groups.append(child)
        return child

    def run(self, step, argv, *, timeout=90, cwd=None, shown=None, expected=0, capture=False):
        self.receipt["stage"] = step
        info = {"step": step, "command": shown or [str(x).replace(str(self.root), "$SCRATCH")
                                                     for x in argv]}
        self.receipt["commands"].append(info)
        try:
            # Separate stdout for JSON. Raw logs never leave the disposable runner.
            with tempfile.TemporaryFile(dir=self.root) as out, tempfile.TemporaryFile(dir=self.root) as err:
                child = subprocess.Popen(
                    [str(x) for x in argv], cwd=cwd or self.root, env=self.env,
                    stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True,
                )
                self.groups.append(child)
                try:
                    info["exit"] = child.wait(timeout=timeout)
                finally:
                    info["groupJoined"] = self.finish_group(child)
                    if info["groupJoined"]:
                        self.groups.remove(child)
                require(info["groupJoined"], "owned command process group did not retire")
                out.seek(0)
                err.seek(0)
                stdout = out.read(1 << 20) if capture else b""
                stderr = err.read(1 << 20)
                info["stdoutBytes"] = out.seek(0, os.SEEK_END)
                info["stderrBytes"] = err.seek(0, os.SEEK_END)
                info["npmOfflineCacheMiss"] = b"ENOTCACHED" in stderr
                require(info["exit"] == expected, "unexpected command exit; see sanitized step receipt")
                return stdout, stderr
        except subprocess.TimeoutExpired as exc:
            info["timedOut"] = True
            raise ProofError("bounded command timed out") from exc

    def download(self, label, url, path, digest, size=None, limit=900):
        self.run(label, ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
                         "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", str(limit),
                         "--output", path, url], timeout=limit + 10)
        require(sha_file(path) == digest, "public download SHA-256 mismatch")
        require(size is None or path.stat().st_size == size, "public download size mismatch")
        return {"sha256": digest, "bytes": path.stat().st_size}

    def stage_ollama(self):
        archive = self.root / "ollama-linux-amd64.tar.zst"
        url = f"https://github.com/ollama/ollama/releases/download/v{OLLAMA}/{archive.name}"
        self.receipt["ollamaArchive"] = self.download("download Ollama", url, archive, OLLAMA_ARCHIVE)
        distro = self.root / "ollama"
        # Archived CPU libraries stay in their published relative paths; CUDA is unused here.
        self.run("extract verified Ollama CPU runtime", ["tar", "--zstd", "--no-same-owner",
                 "--exclude=./lib/ollama/cuda*", "--exclude=lib/ollama/cuda*", "-xf", archive,
                 "-C", distro], timeout=300)
        archive.unlink()
        binary = distro / "bin" / "ollama"
        require(binary.is_file() and os.access(binary, os.X_OK), "verified archive has no runnable Ollama binary")
        self.receipt["ollamaBinarySha256"] = sha_file(binary)
        model_root = self.root / "models"
        manifest = model_root / "manifests" / "registry.ollama.ai" / "library" / "nomic-embed-text" / "latest"
        manifest.parent.mkdir(parents=True)
        self.receipt["modelManifest"] = self.download("download model manifest", REGISTRY + "/manifests/latest",
                                                        manifest, MODEL_MANIFEST, limit=60)
        data = json.loads(manifest.read_bytes())
        receipt = []
        (model_root / "blobs").mkdir()
        for descriptor in [data["config"], *data["layers"]]:
            digest = descriptor["digest"]
            require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest), "invalid model blob digest")
            receipt.append(self.download("download verified model blob", REGISTRY + "/blobs/" + digest,
                                          model_root / "blobs" / digest.replace(":", "-"), digest[7:],
                                          size=descriptor["size"]))
        self.receipt["modelBlobs"] = receipt
        return binary, model_root

    def build_and_install(self):
        def git(*args):
            return self.run("inspect candidate Git source", ["git", *args], cwd=self.source,
                            capture=True)[0].decode().strip()
        require(git("rev-parse", "HEAD") == HEAD, "unexpected candidate Git head")
        self.receipt["source"] = {"commit": HEAD, "tree": git("rev-parse", "HEAD^{tree}"),
                                  "providerSha256": sha_file(self.source / SOURCE),
                                  "lockSha256": sha_file(self.source / "pnpm-lock.yaml")}
        require(self.receipt["source"]["providerSha256"] == SOURCE_SHA, "unexpected provider source bytes")
        require(not git("status", "--porcelain", "--untracked-files=no"), "candidate tracked worktree is dirty")
        package_manager = json.loads((self.source / "package.json").read_bytes())["packageManager"]
        require(package_manager.startswith("pnpm@12.15.0+sha512."), "unexpected repository pnpm pin")
        self.receipt["toolchain"] = {"node": self.run("Node version", ["node", "--version"], capture=True)[0].decode().strip(),
                                    "npm": self.run("npm version", ["npm", "--version"], capture=True)[0].decode().strip(),
                                    "pnpmPin": package_manager}
        require(self.receipt["toolchain"]["node"] == "v24.22.1", "unexpected Node version")
        self.run("prepare pinned pnpm shim", ["corepack", "enable", "--install-directory", self.root / "bin"])
        self.run("prepare repository pnpm pin", ["corepack", "prepare", package_manager, "--activate"],
                 cwd=self.source, timeout=180)
        self.run("frozen candidate dependencies", ["pnpm", "install", "--frozen-lockfile", "--store-dir",
                 self.root / "pnpm-store"], cwd=self.source, timeout=600)
        tgz = self.root / "package" / "openclaw-candidate.tgz"
        self.run("canonical build and package", ["node", "scripts/package-openclaw-for-docker.mjs", "--output-dir",
                 tgz.parent, "--output-name", tgz.name], cwd=self.source, timeout=1450)
        require(not git("status", "--porcelain", "--untracked-files=no"), "packaging changed tracked source")
        self.run("strict candidate tarball check", ["node", "scripts/check-openclaw-package-tarball.mjs",
                 "--require-bundled-workspace-deps", tgz], cwd=self.source, timeout=240)
        with tarfile.open(tgz, "r:gz") as archive:
            build_bytes = archive.extractfile("package/dist/build-info.json").read()
            entry_bytes = archive.extractfile("package/openclaw.mjs").read()
            package = json.load(archive.extractfile("package/package.json"))
        build = json.loads(build_bytes)
        require(build.get("commit") == HEAD and package.get("name") == "openclaw", "tarball source identity mismatch")
        self.receipt["artifact"] = {"sha256": sha_file(tgz), "bytes": tgz.stat().st_size,
                                    "version": package["version"], "buildCommit": build["commit"],
                                    "entrySha256": sha_bytes(entry_bytes), "buildInfoSha256": sha_bytes(build_bytes)}
        prefix = self.root / "npm-prefix"
        self.run("normal npm install to isolated prefix", ["npm", "install", "--global", "--prefix", prefix,
                 "--no-audit", "--no-fund", tgz], timeout=420)
        installed = prefix / "lib" / "node_modules" / "openclaw"
        cli = prefix / "bin" / "openclaw"
        require(cli.resolve() == (installed / "openclaw.mjs").resolve(), "npm CLI does not resolve to installed package")
        require(sha_file(installed / "openclaw.mjs") == sha_bytes(entry_bytes) and
                sha_file(installed / "dist" / "build-info.json") == sha_bytes(build_bytes),
                "installed CLI identity differs from checked archive")
        self.receipt["artifact"]["installedBytesMatch"] = True
        return cli

    def start_ollama(self, binary, model_root):
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            self.ollama_port = reserve.getsockname()[1]
        host = f"127.0.0.1:{self.ollama_port}"
        env = dict(self.env, OLLAMA_HOST=host, OLLAMA_MODELS=str(model_root), OLLAMA_NO_CLOUD="1",
                   OLLAMA_NUM_PARALLEL="1", OLLAMA_MAX_LOADED_MODELS="1",
                   CUDA_VISIBLE_DEVICES="-1", HIP_VISIBLE_DEVICES="-1")
        self.receipt["stage"] = "start owned Ollama"
        self.receipt["commands"].append({"step": "start owned Ollama", "command": ["$SCRATCH/ollama/bin/ollama", "serve"]})
        with tempfile.TemporaryFile(dir=self.root) as log:
            child = self.spawn([binary, "serve"], log, env=env)
        until = time.monotonic() + 55
        while time.monotonic() < until:
            require(child.poll() is None, "Ollama exited before readiness")
            try:
                status, reply = self.api("GET", "/api/version", timeout=2)
                if status == 200 and reply.get("version") == OLLAMA:
                    break
            except (OSError, http.client.HTTPException, ValueError):
                pass
            time.sleep(0.4)
        else:
            raise ProofError("Ollama version endpoint did not become ready")
        status, reply = self.api("GET", "/api/tags", timeout=10)
        require(status == 200 and any(x.get("name") == MODEL and
                str(x.get("digest", "")).removeprefix("sha256:") == MODEL_MANIFEST
                for x in reply.get("models", [])), "running Ollama did not load the pinned local model manifest")
        self.receipt["ollamaVersion"] = OLLAMA
        self.receipt["model"] = MODEL
        self.receipt["modelDigestConfirmedByServer"] = True

    def request(self, method, path, body=None, timeout=125):
        # Hard-bound destination. No redirects, arbitrary hosts, auth or caller headers.
        conn = http.client.HTTPConnection("127.0.0.1", self.ollama_port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers={"Content-Type": "application/json"} if body else {})
            response = conn.getresponse()
            raw = response.read((4 << 20) + 1)
            require(len(raw) <= (4 << 20), "oversized loopback Ollama response")
            return response.status, raw
        finally:
            conn.close()

    def api(self, method, path, payload=None, timeout=240):
        raw = json.dumps(payload).encode() if payload is not None else None
        status, result = self.request(method, path, raw, timeout=timeout)
        return status, json.loads(result)

    def start_observer(self):
        proof = self

        class Observer(http.server.BaseHTTPRequestHandler):
            def log_message(self, _fmt, *_args):
                return

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                allowed = {("GET", "/api/tags"), ("GET", "/api/version"),
                           ("POST", "/api/embed"), ("POST", "/api/show")}
                if (self.command, self.path) not in allowed:
                    self.send_error(404)
                    return
                try:
                    self.connection.settimeout(5)
                    count = int(self.headers.get("Content-Length", "0"))
                    require(0 <= count <= (1 << 20), "invalid synthetic request size")
                    raw = self.rfile.read(count) if count else None
                    status, response = proof.request(self.command, self.path, raw)
                    if self.path == "/api/embed":
                        # Forward bytes untouched; never store the query or vector.
                        fact = child_receipt(json.loads(raw), json.loads(response), status)
                        proof.trace.append({"phase": proof.phase, **fact})
                except (OSError, ValueError, TypeError, ProofError, http.client.HTTPException):
                    self.send_error(502)
                    return
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

        self.proxy = http.server.HTTPServer(("127.0.0.1", 0), Observer)
        self.proxy_port = self.proxy.server_port
        self.thread = threading.Thread(target=self.proxy.serve_forever, name="proof-loopback-observer", daemon=True)
        self.thread.start()

    def verify_cli(self, cli):
        self.receipt["stage"] = "real Ollama direct controls"
        controls = []
        self.receipt["ollamaControls"] = controls
        for name, payload in (
            ("fitting", {"model": MODEL, "input": FITTING, "truncate": False}),
            ("oversized-default", {"model": MODEL, "input": OVERSIZED}),
            ("oversized-explicit", {"model": MODEL, "input": OVERSIZED, "truncate": False}),
        ):
            status, reply = self.api("POST", "/api/embed", payload)
            controls.append({"case": name, **child_receipt(payload, reply, status)})
        require(all(x["httpStatus"] == 200 and x["embeddingDimensions"] == [768] for x in controls[:2]),
                "real Ollama fitting/default-truncation control failed")
        require(controls[2]["httpStatus"] == 400 and controls[2]["contextLengthError"],
                "real Ollama did not reject the full oversized control with context-length error")
        self.start_observer()
        workspace = self.root / "workspace"
        config = Path(self.env["OPENCLAW_CONFIG_PATH"])
        notes = workspace / "MEMORY.md"
        notes.write_text("# Public synthetic proof\n\nThe Nightjar lighthouse has a violet lamp.\n", encoding="utf8")
        fixture = {
            "agents": {"defaults": {"workspace": str(workspace)}},
            "memory": {"search": {"enabled": True, "provider": "ollama", "model": MODEL, "fallback": "none",
                                 "sources": ["memory"], "remote": {"baseUrl": f"http://127.0.0.1:{self.proxy_port}"},
                                 "inputFormat": {"query": "", "document": ""}, "cache": {"enabled": False}}},
            "plugins": {"allow": ["ollama", "memory-core"], "slots": {"memory": "memory-core"},
                        "entries": {"ollama": {"enabled": True}, "memory-core": {"enabled": True}}},
        }
        config.write_text(json.dumps(fixture) + "\n", encoding="utf8")
        paths = {"config": config, "memory": notes}
        before = {k: sha_file(p) for k, p in paths.items()}
        self.receipt["authoredFixture"] = {"before": before}
        try:
            version, _ = self.run("installed CLI version", [cli, "--version"], capture=True)
            require(self.receipt["artifact"]["version"] in version.decode(), "installed CLI version mismatch")
            self.phase = "index"
            self.run("installed memory index", [cli, "memory", "index", "--agent", "main", "--force"], timeout=180)
            self.phase = "fitting"
            stdout, _ = self.run("installed fitting memory search", [cli, "memory", "search", "--agent", "main",
                                 "--json", "--min-score", "0", "--query", FITTING], timeout=180, capture=True)
            result = json.loads(stdout)
            hit = any(row.get("path") == "MEMORY.md" and "Nightjar" in row.get("snippet", "") and
                      isinstance(row.get("score"), (int, float)) and row["score"] > 0
                      for row in result.get("results", []))
            self.receipt["fittingResult"] = {"matchedAuthoredMemory": hit, "stale": bool(result.get("stale"))}
            require(hit and not result.get("stale"), "fitting CLI search did not return the authored memory")
            self.phase = "oversized"
            query_hash = controls[2]["inputs"][0]["sha256"]
            argv = [cli, "memory", "search", "--agent", "main", "--json", "--query", OVERSIZED]
            stdout, stderr = self.run("installed oversized memory search", argv, expected=1, timeout=180,
                                      capture=True, shown=["$SCRATCH/npm-prefix/bin/openclaw", *argv[1:-1],
                                                           f"<synthetic query sha256:{query_hash}>"])
            rejected = bool(CONTEXT_ERROR.search((stdout + stderr).decode(errors="replace")))
            self.receipt["oversizedResult"] = {"contextLengthErrorVisible": rejected, "cliExit": 1}
            require(rejected, "CLI exit 1 did not show the context-length error")
            for phase in ("index", "fitting"):
                events = [e for e in self.trace if e["phase"] == phase]
                require(events and all(e["truncateFalse"] and e["modelMatches"] and e["httpStatus"] == 200 and
                                       e["embeddingDimensions"] and set(e["embeddingDimensions"]) == {768}
                                       for e in events), "index/search did not use successful real embeddings")
            fitting_digest = controls[0]["inputs"][0]["sha256"]
            require(any(e["phase"] == "fitting" and any(s["sha256"] == fitting_digest for s in e["inputs"])
                        for e in self.trace), "fitting CLI query was not observed at the real embed endpoint")
            oversized = [e for e in self.trace if e["phase"] == "oversized"]
            require(oversized and all(e["modelMatches"] and e["truncateFalse"] and e["httpStatus"] == 400 and
                                      e["contextLengthError"] and not e["embeddingDimensions"] and
                                      e["inputs"] == controls[2]["inputs"] for e in oversized),
                    "observed oversized CLI request did not match the entire synthetic control")
        finally:
            after = {k: sha_file(p) if p.is_file() else None for k, p in paths.items()}
            self.receipt["authoredFixture"].update(after=after, unchanged=(before == after))
            self.receipt["installedEmbedObservations"] = self.trace
        require(before == after, "authored config or memory changed")

    def cleanup(self):
        joined = True
        for child in reversed(self.groups):
            try:
                joined = self.finish_group(child) and joined
            except (OSError, subprocess.TimeoutExpired):
                joined = False
        observer_joined = True
        if self.proxy is not None:
            if self.thread is not None and self.thread.is_alive():
                self.proxy.shutdown()
                self.thread.join(timeout=5)
                observer_joined = not self.thread.is_alive()
            self.proxy.server_close()
        # Catch detached descendants that inherited the task marker; don't touch other jobs.
        leftovers = 0
        for process in Path("/proc").iterdir():
            if process.name.isdecimal():
                try:
                    if self.marker in (process / "environ").read_bytes().split(b"\0"):
                        leftovers += 1
                except OSError:
                    pass
        listeners_absent = all(not listening(p) for p in (self.ollama_port, self.proxy_port) if p is not None)
        return {"ownedGroupsJoined": joined, "observerJoined": observer_joined,
                "listenersAbsent": listeners_absent, "markedProcessesRemaining": leftovers,
                "complete": joined and observer_joined and listeners_absent and not leftovers}


def main():
    source, output = map(lambda s: Path(s).resolve(), sys.argv[1:])
    receipt = {"schema": "pr205356-installed-ollama-v1", "status": "incomplete", "stage": "host admission",
               "commands": [], "proofBranchCommit": os.getenv("GITHUB_SHA"), "runId": os.getenv("GITHUB_RUN_ID"),
               "runAttempt": os.getenv("GITHUB_RUN_ATTEMPT"), "versionUpgradeProven": False,
               "upstreamCIOrApprovalSatisfied": False, "productApprovalGranted": False}
    root = proof = None

    def interrupted(_sig, _frame):
        raise ProofError("workflow interrupted before completion")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(48 * 60)  # Preserve cleanup time before the hosted workflow deadline.
    try:
        require(os.getenv("GITHUB_REPOSITORY") == FORK and os.getenv("GITHUB_REF") == BRANCH and
                os.getenv("GITHUB_EVENT_NAME") == "push" and os.getenv("RUNNER_ENVIRONMENT") == "github-hosted" and
                sys.platform == "linux" and os.uname().machine == "x86_64",
                "requires owned GitHub-hosted Linux fork proof branch")
        os.umask(0o077)
        root = Path(tempfile.mkdtemp(prefix="pr205356-", dir=output.parent))
        proof = Proof(root, source, receipt)
        cli = proof.build_and_install()
        binary, model_root = proof.stage_ollama()
        proof.start_ollama(binary, model_root)
        proof.verify_cli(cli)
        receipt["status"] = "pass"
        receipt["stage"] = "verified and ready for cleanup"
    except ProofError as exc:
        receipt["failure"] = str(exc)
    except Exception as exc:
        # Never put process output, config contents, request URLs, or exception text in artifacts.
        receipt["failureType"] = type(exc).__name__
    finally:
        signal.alarm(0)
        if root is not None:
            if proof is None:
                receipt["cleanup"] = {"complete": True, "noProcessesStarted": True}
            else:
                try:
                    receipt["cleanup"] = proof.cleanup()
                except Exception as exc:
                    receipt["cleanup"] = {"complete": False, "failureType": type(exc).__name__}
            receipt["cleanup"]["scratchRemoved"] = False
            if receipt["cleanup"]["complete"]:
                try:
                    shutil.rmtree(root)
                    receipt["cleanup"]["scratchRemoved"] = not root.exists()
                except OSError:
                    pass
            if not (receipt["cleanup"]["complete"] and receipt["cleanup"]["scratchRemoved"]):
                receipt["status"] = "incomplete"
        output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf8")
        print(f"PR 205356 installed Ollama proof: {receipt['status']} ({receipt['stage']})")
    return 0 if receipt["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
