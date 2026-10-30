"""Machine reality sampled through the platform layer: memory, CPU, load, disk and private resident memory per harness. Never reads command lines."""

import shutil
import sys
import threading
import time
from pathlib import Path

from . import store
from .model import norm_ts
from .platform import MachineMetrics, ProcessProbe

INTERVAL_SECONDS = 15
RETENTION_DAYS = 7
TOP = 12
OTHER = "other"
SAMPLE_COLUMNS = ("ts", "mem_total", "mem_used", "mem_available", "swap_total", "swap_used", "cpu_pct",
                  "load1", "load5", "load15", "disk_used", "disk_total", "procs")


def project_of(cwd: str) -> str | None:
    """Last two path segments only, so the snapshot never carries a full home path."""
    parts = Path(cwd).parts[1:]
    return "/".join(parts[-2:]) if parts else None


def harness_of(comm: str, adapters) -> str | None:
    for adapter in adapters:
        if any(comm == name or comm.startswith(name + "-") for name in adapter.process_names):
            return adapter.id
    return None


class Sampler:
    """Samples every INTERVAL_SECONDS. Keeps the latest snapshot in memory and writes history with its own short transactions."""

    def __init__(self, db_path, probe: ProcessProbe, metrics: MachineMetrics, adapters=(), clock=time.time, log=lambda msg: print(msg, file=sys.stderr)):
        self.db_path, self.probe, self.metrics, self.adapters, self.clock, self.log = Path(db_path), probe, metrics, tuple(adapters), clock, log
        self.latest: dict | None = None
        self._stop = threading.Event()

    def _project(self, pid: int) -> str | None:
        cwd = self.probe.cwd(pid)
        return project_of(cwd) if cwd else None

    def sample(self) -> dict:
        ts = norm_ts(self.clock())
        reading = self.metrics.read()
        try:
            disk = shutil.disk_usage(self.db_path.parent)
        except OSError:
            disk = None
        procs, owned = self.probe.processes()
        mine = [{"pid": p.pid, "comm": p.name, "harness": harness_of(p.name, self.adapters), "project": None, "mem": p.mem} for p in owned]
        agents = {a.id: {"harness": a.id, "mem": 0, "procs": 0} for a in self.adapters if a.process_names}
        agents[OTHER] = {"harness": OTHER, "mem": 0, "procs": 0}
        for p in mine:
            agent = agents[p["harness"] or OTHER]
            agent["mem"] += p["mem"]
            agent["procs"] += 1
        top = sorted(mine, key=lambda p: (-p["mem"], p["pid"]))[:TOP]
        for p in top:
            p["project"] = self._project(p["pid"])
        return {
            "ts": ts,
            **reading,
            "disk_used": disk.used if disk else None,
            "disk_total": disk.total if disk else None,
            "procs": procs,
            "agents": list(agents.values()),
            "top": top,
        }

    def record(self, now: dict) -> None:
        """Upserts one sample and prunes past retention, in one transaction, so a rerun converges."""
        load = now["load"] or [None, None, None]
        row = {**now, "load1": load[0], "load5": load[1], "load15": load[2]}
        cutoff = norm_ts(self.clock() - RETENTION_DAYS * 86400)
        conn = store.connect(self.db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(f"INSERT OR REPLACE INTO machine_samples ({','.join(SAMPLE_COLUMNS)}) VALUES ({','.join('?' * len(SAMPLE_COLUMNS))})",
                         [row[c] for c in SAMPLE_COLUMNS])
            conn.executemany("INSERT OR REPLACE INTO machine_agent (ts, harness, mem, procs) VALUES (?,?,?,?)",
                             [(now["ts"], a["harness"], a["mem"], a["procs"]) for a in now["agents"]])
            conn.execute("DELETE FROM machine_samples WHERE ts < ?", (cutoff,))
            conn.execute("DELETE FROM machine_agent WHERE ts < ?", (cutoff,))
            conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()

    def tick(self) -> dict:
        now = self.sample()
        self.latest = now
        try:
            self.record(now)
        except Exception as exc:
            self.log(f"machine sample not stored: {exc!r}")
        return now

    def _safe_tick(self) -> None:
        try:
            self.tick()
        except Exception as exc:
            self.log(f"machine sample failed: {exc!r}")

    def loop(self) -> None:
        while not self._stop.wait(INTERVAL_SECONDS):
            self._safe_tick()

    def start(self) -> None:
        """Samples once before returning, so the first request already has `now`."""
        self._safe_tick()
        threading.Thread(target=self.loop, name="machine", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
