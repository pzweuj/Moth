"""Run the built moth:dev image against disposable, isolated Compose mounts."""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / ".local" / ("container-smoke-" + secrets.token_hex(4))
RUN.mkdir(parents=True)
for name in ("books", "data"):
    (RUN / name).mkdir()
if os.name != "nt":
    # Only the disposable test data directory is made writable for UID 10001.
    (RUN / "data").chmod(0o777)
(RUN / "books" / "Smoke.txt").write_text("Chapter 1\n\nA small container fixture.\n", encoding="utf-8")
config = {
    "services": {"moth": {
        "image": "moth:dev",
        "ports": ["127.0.0.1::8080"],
        "environment": {"MOTH_COOKIE_SECURE": "false"},
        "volumes": [
            {"type": "bind", "source": str(RUN / "data"), "target": "/data"},
            {"type": "bind", "source": str(RUN / "books"), "target": "/books", "read_only": True},
        ],
    }}
}
compose_file = RUN / "compose.json"
compose_file.write_text(json.dumps(config), encoding="utf-8")
command = ["docker", "compose", "-p", RUN.name, "-f", str(compose_file)]


def compose(*args, check=True):
    return subprocess.run([*command, *args], check=check, text=True, capture_output=True)


cookies = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
url = ""


def request(path, method="GET", data=None, status=200):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url + path, body, {"Content-Type": "application/json"}, method=method)
    try:
        response = client.open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    assert response.status == status, f"{method} {path}: {response.status}, expected {status}"
    payload = response.read()
    return json.loads(payload) if payload and "application/json" in response.headers.get("Content-Type", "") else payload


def ready():
    global url
    address = compose("port", "moth", "8080").stdout.strip()
    url = "http://" + address
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if request("/api/v1/health")["status"] == "ok":
                return
        except (OSError, AssertionError):
            time.sleep(0.5)
    raise AssertionError("Container did not become ready")


try:
    compose("config")
    compose("up", "--no-build", "-d")
    ready()
    assert request("/api/v1/setup/status")["initialized"] is False
    credentials = {"username": "smoke", "password": secrets.token_hex(16)}
    request("/api/v1/setup", "POST", credentials, 201)
    request("/api/v1/setup", "POST", credentials, 409)
    request("/api/v1/session", "POST", {**credentials, "password": "incorrect-password"}, 401)
    request("/api/v1/session", "POST", credentials, 204)
    assert request("/api/v1/session")["authenticated"] is True
    session = next(c for c in cookies if c.name == "moth_session")
    assert session.has_nonstandard_attr("HttpOnly")
    assert session.get_nonstandard_attr("SameSite") == "Lax"
    assert session.path == "/"
    request("/reader/1")
    assert request("/api/v1/not-found", status=404)["error"]["code"] == "not_found"
    assert compose("exec", "-T", "moth", "id", "-u").stdout.strip() == "10001"
    cid = compose("ps", "-q", "moth").stdout.strip()
    container = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]
    mounts = {mount["Destination"]: mount for mount in container["Mounts"]}
    assert mounts["/books"]["RW"] is False and mounts["/data"]["RW"] is True
    assert compose("exec", "-T", "moth", "touch", "/books/must-not-write", check=False).returncode != 0
    compose("exec", "-T", "moth", "touch", "/data/write-check")
    compose("restart", "moth")
    ready()
    assert request("/api/v1/session")["authenticated"] is True
    compose("up", "--no-build", "--force-recreate", "-d")
    ready()
    assert request("/api/v1/setup/status")["initialized"] is True
    assert request("/api/v1/session")["authenticated"] is True
    assert (RUN / "data" / "write-check").exists()
    request("/api/v1/session", "DELETE", status=204)
    assert request("/api/v1/session")["authenticated"] is False
    started = time.monotonic()
    compose("stop", "-t", "10", "moth")
    assert time.monotonic() - started < 15
    cid = compose("ps", "-a", "-q", "moth").stdout.strip()
    state = json.loads(subprocess.check_output(["docker", "inspect", cid], text=True))[0]["State"]
    assert not state["Running"] and state["ExitCode"] == 0
    logs = compose("logs", "--no-color").stdout
    assert "panic" not in logs.lower()
    assert credentials["password"] not in logs and session.value not in logs
    (RUN / "result.txt").write_text("PASS: authentication, restart/recreate, mounts, non-root, SIGTERM\n")
    print("PASS: container smoke", RUN)
finally:
    logs = compose("logs", "--no-color", check=False)
    (RUN / "container.log").write_text(logs.stdout + logs.stderr, encoding="utf-8")
    compose("down", "--remove-orphans", check=False)
