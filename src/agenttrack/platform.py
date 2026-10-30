"""Every operating-system difference lives here: where files go, how processes are listed, how machine load is read.

Nothing outside this module touches sys.platform, /proc, or a platform-specific base directory.
"""

import os
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import quote
from typing import Mapping, NamedTuple, Protocol

APP = "agent-track"


class Proc(NamedTuple):
    pid: int
    name: str
    mem: int  # private resident bytes


class ProcessProbe(Protocol):
    name: str
    available: bool
    # True when start_time() returns the same string an agent recorded for its own pid (Linux /proc starttime ticks).
    exact_start_time: bool

    def processes(self) -> tuple[int | None, list[Proc]]:
        """(count of all processes, the ones owned by this user). Other users' processes are counted, never opened."""

    def find(self, names: tuple[str, ...]) -> list[int] | None:
        """Pids whose process name is one of names or starts with name + "-". None when processes cannot be listed."""

    def start_time(self, pid: int) -> str | None: ...

    def open_files(self, pid: int) -> list[str]: ...

    def cwd(self, pid: int) -> str | None: ...


class MachineMetrics(Protocol):
    name: str
    available: bool

    def read(self) -> dict:
        """mem_total, mem_available, mem_used, swap_total, swap_used, cpu_pct, load (3 floats or None), cpus, uptime_s.
        A value the platform does not report is None. cpu_pct needs two reads, so the first is None."""


def _matches(name: str, names: tuple[str, ...]) -> bool:
    return any(name == n or name.startswith(n + "-") for n in names)


def parse_meminfo(text: str) -> dict[str, int]:
    """Field name to value, kB fields converted to bytes."""
    fields = {}
    for line in text.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            fields[name] = int(parts[0]) * (1024 if parts[1:] == ["kB"] else 1)
    return fields


def parse_stat(text: str) -> tuple[int | None, int | None, int | None]:
    """(busy jiffies, total jiffies, cpu count) from the aggregate 'cpu' line and the per-cpu lines."""
    busy = total = None
    cpus = 0
    for line in text.splitlines():
        if line.startswith("cpu "):
            values = [int(v) for v in line.split()[1:9]]
            total = sum(values)
            busy = total - values[3] - (values[4] if len(values) > 4 else 0)
        elif line.startswith("cpu"):
            cpus += 1
    return busy, total, cpus or None


def parse_loadavg(text: str) -> list[float] | None:
    parts = text.split()
    return [float(v) for v in parts[:3]] if len(parts) >= 3 else None


def parse_uptime(text: str) -> int | None:
    parts = text.split()
    return int(float(parts[0])) if parts else None


def parse_status(text: str) -> tuple[str, int]:
    """(process name as in /proc/<pid>/comm, private resident bytes). RssAnon when the kernel reports it, else VmRSS
    minus its file and shared-memory parts, else VmRSS. Kernel threads have none of them, so 0."""
    name, kb = "", {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key == "Name":
            name = rest.strip()
        elif key in ("RssAnon", "RssFile", "RssShmem", "VmRSS"):
            kb[key] = int(rest.split()[0])
    if "RssAnon" in kb:
        private = kb["RssAnon"]
    else:
        private = max(0, kb.get("VmRSS", 0) - kb.get("RssFile", 0) - kb.get("RssShmem", 0))
    return name, private * 1024


def _difference(fields: dict, whole: str, part: str) -> int | None:
    return fields[whole] - fields[part] if whole in fields and part in fields else None


class LinuxProc:
    name = "LinuxProc"
    available = True
    exact_start_time = True

    def __init__(self, root: Path = Path("/proc"), visible=None):
        self.root = Path(root)
        self.visible = visible or self._owned_by_me

    def _owned_by_me(self, pid: int) -> bool:
        try:
            return os.stat(self.root / str(pid)).st_uid == os.getuid()
        except OSError:
            return False

    def _read(self, *parts) -> str | None:
        try:
            with open(self.root.joinpath(*parts), errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def _pids(self) -> list[int] | None:
        try:
            return [int(entry.name) for entry in os.scandir(self.root) if entry.name.isdigit()]
        except OSError:
            return None

    def processes(self) -> tuple[int | None, list[Proc]]:
        pids = self._pids()
        if pids is None:
            return None, []
        mine = []
        for pid in pids:
            if not self.visible(pid):
                continue
            status = self._read(str(pid), "status")
            if status is None:
                continue
            name, mem = parse_status(status)
            mine.append(Proc(pid, name, mem))
        return len(pids), mine

    def find(self, names: tuple[str, ...]) -> list[int] | None:
        pids = self._pids()
        if pids is None:
            return None
        return [pid for pid in pids if _matches((self._read(str(pid), "comm") or "").strip(), names)]

    def start_time(self, pid: int) -> str | None:
        """Field 22 of /proc/<pid>/stat. The comm field may hold spaces and parentheses, so split after the last ')'."""
        text = self._read(str(pid), "stat")
        try:
            return text[text.rindex(")") + 1:].split()[19] if text else None
        except (ValueError, IndexError):
            return None

    def open_files(self, pid: int) -> list[str]:
        try:
            fds = list(os.scandir(self.root / str(pid) / "fd"))
        except OSError:
            return []
        found = []
        for fd in fds:
            try:
                found.append(os.readlink(fd.path))
            except OSError:
                continue
        return found

    def cwd(self, pid: int) -> str | None:
        try:
            target = os.readlink(self.root / str(pid) / "cwd")
        except OSError:
            return None
        return None if target.startswith("/proc/") else target  # sandboxed Chrome sits in /proc/<pid>/fdinfo


class LinuxMetrics:
    name = "LinuxMetrics"
    available = True

    def __init__(self, root: Path = Path("/proc")):
        self.root = Path(root)
        self._cpu: tuple[int, int] | None = None

    def _read(self, name: str) -> str:
        try:
            with open(self.root / name, errors="replace") as f:
                return f.read()
        except OSError:
            return ""

    def read(self) -> dict:
        mem = parse_meminfo(self._read("meminfo"))
        busy, total, cpus = parse_stat(self._read("stat"))
        pct = None
        if self._cpu is not None and total is not None and total > self._cpu[1]:
            pct = round(100 * (busy - self._cpu[0]) / (total - self._cpu[1]), 1)
        self._cpu = (busy, total) if total is not None else None
        return {
            "mem_total": mem.get("MemTotal"),
            "mem_used": _difference(mem, "MemTotal", "MemAvailable"),
            "mem_available": mem.get("MemAvailable"),
            "swap_total": mem.get("SwapTotal"),
            "swap_used": _difference(mem, "SwapTotal", "SwapFree"),
            "cpu_pct": pct,
            "load": parse_loadavg(self._read("loadavg")),
            "cpus": cpus,
            "uptime_s": parse_uptime(self._read("uptime")),
        }


class NullProbe:
    name = "NullProbe"
    available = False
    exact_start_time = False

    def processes(self):
        return None, []

    def find(self, names):
        return None

    def start_time(self, pid):
        return None

    def open_files(self, pid):
        return []

    def cwd(self, pid):
        return None


class NullMetrics:
    name = "NullMetrics"
    available = False

    def read(self) -> dict:
        return {k: None for k in ("mem_total", "mem_used", "mem_available", "swap_total", "swap_used", "cpu_pct", "load", "cpus", "uptime_s")}


def readonly_uri(path) -> str:
    """SQLite read-only URI that survives ?, # and % in the path (a bare f"file:{path}" does not)."""
    posix = Path(path).absolute().as_posix()
    return "file://" + ("" if posix.startswith("/") else "/") + quote(posix) + "?mode=ro"


def _bare(name: str) -> str:
    return name[:-4] if name.lower().endswith(".exe") else name


class PsutilProbe:
    """Cross-platform probe over the optional psutil package. Construct only when psutil imports."""

    name = "PsutilProbe"
    available = True
    exact_start_time = False

    def __init__(self, psutil=None):
        if psutil is None:
            import psutil
        self.psutil = psutil
        try:
            self._me = psutil.Process().username()
        except Exception:
            self._me = None

    def _safe(self, pid: int, attr: str):
        try:
            return getattr(self.psutil.Process(pid), attr)()
        except Exception:
            return None

    def processes(self) -> tuple[int | None, list[Proc]]:
        total, mine = 0, []
        for p in self.psutil.process_iter(["pid", "name", "username"]):
            total += 1
            info = p.info
            if self._me is not None and info.get("username") != self._me:
                continue
            try:
                full = p.memory_full_info()
                mem = getattr(full, "uss", None) or full.rss
            except Exception:
                try:
                    mem = p.memory_info().rss
                except Exception:
                    continue
            mine.append(Proc(info["pid"], _bare(info.get("name") or ""), int(mem)))
        return total, mine

    def find(self, names: tuple[str, ...]) -> list[int] | None:
        try:
            return [p.info["pid"] for p in self.psutil.process_iter(["pid", "name"]) if _matches(_bare(p.info.get("name") or ""), names)]
        except Exception:
            return None

    def start_time(self, pid: int) -> str | None:
        created = self._safe(pid, "create_time")
        return None if created is None else str(int(created))

    def open_files(self, pid: int) -> list[str]:
        files = self._safe(pid, "open_files") or []
        return [f.path for f in files]

    def cwd(self, pid: int) -> str | None:
        return self._safe(pid, "cwd")


class PsutilMetrics:
    name = "PsutilMetrics"
    available = True

    def __init__(self, psutil=None):
        if psutil is None:
            import psutil
        self.psutil = psutil
        psutil.cpu_percent(None)

    def read(self) -> dict:
        ps = self.psutil
        mem, swap = ps.virtual_memory(), ps.swap_memory()
        try:
            load = [round(v, 2) for v in os.getloadavg()]
        except (OSError, AttributeError):
            load = None
        return {
            "mem_total": mem.total,
            "mem_used": mem.total - mem.available,
            "mem_available": mem.available,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "cpu_pct": round(ps.cpu_percent(None), 1),
            "load": load,
            "cpus": ps.cpu_count(),
            "uptime_s": int(time.time() - ps.boot_time()),
        }


def _import_psutil():
    try:
        import psutil
        return psutil
    except ImportError:
        return None


def _os_name(platform: str) -> str:
    if platform.startswith("win"):
        return "windows"
    return "darwin" if platform == "darwin" else "linux"


@dataclass(frozen=True)
class Env:
    os: str  # linux | darwin | windows
    home: Path
    xdg_data: Path
    app_support: Path
    appdata: Path
    probe: ProcessProbe
    metrics: MachineMetrics
    xdg_config: Path = field(default=Path("."))
    environ: Mapping[str, str] = field(default_factory=dict)
    home_overrides: Mapping[str, Path] = field(default_factory=dict)

    @property
    def data_dir(self) -> Path:
        base = {"linux": self.xdg_data, "darwin": self.app_support, "windows": self.appdata}[self.os]
        return base / APP

    @property
    def config_dir(self) -> Path:
        base = {"linux": self.xdg_config, "darwin": self.app_support, "windows": self.appdata}[self.os]
        return base / APP

    @property
    def config_path(self) -> Path:
        return self.config_dir / "config.toml"

    @property
    def default_db(self) -> Path:
        return self.data_dir / "agent-track.sqlite"

    def with_overrides(self, homes: Mapping[str, Path]) -> "Env":
        return replace(self, home_overrides={**self.home_overrides, **homes})

    @classmethod
    def current(cls, environ: Mapping[str, str] | None = None, platform: str | None = None, home: Path | None = None) -> "Env":
        environ = os.environ if environ is None else environ
        name = _os_name(sys.platform if platform is None else platform)
        home = Path(home) if home else Path.home()
        psutil = _import_psutil()
        if name == "linux" and Path("/proc/self").exists():
            probe, metrics = LinuxProc(), LinuxMetrics()
        elif psutil is not None:
            probe, metrics = PsutilProbe(psutil), PsutilMetrics(psutil)
        else:
            probe, metrics = NullProbe(), NullMetrics()
        return cls(
            os=name,
            home=home,
            xdg_data=Path(environ.get("XDG_DATA_HOME") or home / ".local" / "share"),
            xdg_config=Path(environ.get("XDG_CONFIG_HOME") or home / ".config"),
            app_support=home / "Library" / "Application Support",
            appdata=Path(environ.get("APPDATA") or home / "AppData" / "Roaming"),
            probe=probe,
            metrics=metrics,
            environ=dict(environ),
        )
