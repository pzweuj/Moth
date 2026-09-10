"""Compare isolated Linux images under 512 MiB and zero additional swap.

Measure first scan, three unchanged scans and concurrent HTTP reading, with
idle samples at 30/120 seconds after every phase. Never changes production
containers or the supplied read-only library. Results include raw samples.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import http.cookiejar
import json
from pathlib import Path
import secrets
import subprocess
import threading
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--images", nargs="+", required=True)
parser.add_argument("--books", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--idle-seconds", default="30,120")
args = parser.parse_args()
books = args.books.resolve(strict=True)
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
idle_seconds = sorted(int(value) for value in args.idle_seconds.split(","))


def docker(*command, check=True):
    return subprocess.run(["docker", *command], check=check, capture_output=True, text=True, encoding="utf-8")


def measure(name):
    result = docker("exec", name, "cat", "/proc/1/status", "/sys/fs/cgroup/memory.stat", "/sys/fs/cgroup/memory.events", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.swap.current")
    lines = result.stdout.splitlines()
    fields = {parts[0].rstrip(":"): int(parts[1]) for line in lines[:-3] if len(parts := line.split()) >= 2 and parts[1].isdigit()}
    return {"time": time.time(), "rss": fields["VmRSS"] * 1024, "rss_hwm": fields["VmHWM"] * 1024, "anon": fields["anon"], "file": fields["file"], "cgroup": int(lines[-3]), "cgroup_peak_lifetime": int(lines[-2]), "swap": int(lines[-1]), "oom_kill": fields["oom_kill"]}


for image in args.images:
    name = "moth-memory-" + secrets.token_hex(4)
    directory = output / image.replace(":", "-").replace("/", "-")
    directory.mkdir()
    data = directory / "data"
    data.mkdir()
    samples, phases = [], []
    stop = threading.Event()
    sampler = None
    report = {"image": image, "books": str(books), "memory_limit": 512 * 1024 * 1024, "swap_limit": 0, "sample_interval_seconds": 0.5, "phases": phases}
    cookies = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    try:
        started = time.monotonic()
        docker("run", "-d", "--name", name, "--memory=512m", "--memory-swap=512m", "--cpus=2", "-p", "127.0.0.1::8080", "--mount", f"type=bind,source={books},target=/books,readonly", "--mount", f"type=bind,source={data},target=/data", image)
        info = json.loads(docker("inspect", name).stdout)[0]
        report["image_id"] = info["Image"]
        report["environment"] = info["Config"]["Env"]
        assert info["HostConfig"]["Memory"] == info["HostConfig"]["MemorySwap"] == 512 * 1024 * 1024
        assert docker("exec", name, "cat", "/sys/fs/cgroup/memory.swap.max").stdout.strip() == "0"
        url = "http://" + docker("port", name, "8080").stdout.strip()

        def sample():
            while not stop.is_set():
                try:
                    samples.append(measure(name))
                except subprocess.CalledProcessError:
                    if not stop.is_set(): report["sampling_error"] = True
                stop.wait(0.5)

        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()

        def request(path, method="GET", body=None):
            req = urllib.request.Request(url + path, None if body is None else json.dumps(body).encode(), {"Content-Type": "application/json"}, method=method)
            with client.open(req, timeout=120) as response:
                raw = response.read()
                return json.loads(raw) if raw else None

        deadline = time.monotonic() + 60
        while True:
            try:
                request("/api/v1/health")
                break
            except OSError:
                if time.monotonic() > deadline: raise
                time.sleep(0.2)
        credentials = {"username": "benchmark", "password": secrets.token_hex(20)}
        request("/api/v1/setup", "POST", credentials)
        request("/api/v1/session", "POST", credentials)

        def end_phase(label, since, first_sample):
            finished = time.monotonic()
            active = samples[first_sample:] or [measure(name)]
            record = {"name": label, "seconds": round(finished - since, 3), "peak_sampled": {key: max(row[key] for row in active) for key in ["rss", "anon", "file", "cgroup"]}, "end": measure(name), "idle": {}}
            phases.append(record)
            print(image, label, "completed", record["seconds"], "seconds; collecting idle samples", flush=True)
            for idle in idle_seconds:
                remaining = idle - (time.monotonic() - finished)
                if remaining > 0: time.sleep(remaining)
                record["idle"][str(idle)] = measure(name)
                (directory / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(image, label, f"idle {idle}s", json.dumps(record["idle"][str(idle)]), flush=True)

        for scan in range(4):
            first_sample = 0 if scan == 0 else len(samples)
            if scan:
                started = time.monotonic()
                request("/api/v1/scan", "POST")
            deadline = time.monotonic() + 1800
            while True:
                status = request("/api/v1/scan/status")
                if not status["scanning"] and status["discovery_complete"]: break
                if time.monotonic() > deadline: raise TimeoutError("Scan did not complete")
                time.sleep(0.2)
            assert status["errors"] == 0, status
            report["last_scan"] = status
            end_phase("first_scan" if not scan else f"repeat_{scan}", started, first_sample)

        publications = request("/api/v1/browse")["publications"]
        epub = next(book for book in publications if book["filename"] == "book-0000.epub")
        cbz = next(book for book in publications if book["source_format"] == "cbz")
        mobi = next(book for book in publications if book["source_format"] == "mobi")
        cookie_header = "; ".join(f"{cookie.name}={cookie.value}" for cookie in cookies)

        def consume(path):
            req = urllib.request.Request(url + path, headers={"Cookie": cookie_header})
            with urllib.request.urlopen(req, timeout=120) as response:
                count = 0
                while chunk := response.read(64 * 1024): count += len(chunk)
                assert count == int(response.headers.get("Content-Length", count))
                return count

        started, first_sample = time.monotonic(), len(samples)
        request(f"/api/v1/publications/{cbz['id']}")
        request(f"/api/v1/publications/{mobi['id']}/conversion", "POST")
        paths = [f"/api/v1/publications/{epub['id']}/file"] * 4
        paths += [f"/api/v1/publications/{cbz['id']}/pages/{page}" for page in range(8)]
        paths += [f"/api/v1/publications/{cbz['id']}/pages/{page}/thumbnail" for page in range(8)]
        with ThreadPoolExecutor(max_workers=8) as pool:
            report["reading_bytes"] = sum(pool.map(consume, paths))
        while request(f"/api/v1/publications/{mobi['id']}/conversion")["status"] == "preparing": time.sleep(0.2)
        consume(f"/api/v1/publications/{mobi['id']}/file")
        end_phase("reading_and_exit", started, first_sample)
        repeated = [phase["idle"][str(idle_seconds[-1])] for phase in phases[1:4]]
        report["repeat_idle_growth"] = {key: repeated[-1][key] - repeated[0][key] for key in ["rss", "anon"]}
        report["oom_kill"] = max(row["oom_kill"] for row in samples)
        assert report["oom_kill"] == 0 and all(row["swap"] == 0 for row in samples)
    finally:
        stop.set()
        if sampler: sampler.join(timeout=10)
        (directory / "samples.json").write_text(json.dumps(samples), encoding="utf-8")
        (directory / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        logs = docker("logs", name, check=False)
        (directory / "server.log").write_text(logs.stdout + logs.stderr, encoding="utf-8")
        report["container_state"] = json.loads(docker("inspect", name).stdout)[0]["State"]
        (directory / "result.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        docker("stop", "-t", "10", name, check=False)
        docker("rm", name, check=False)
print("Memory comparison complete:", output, flush=True)
