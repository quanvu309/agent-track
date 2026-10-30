"""Settings: defaults, then config.toml in the OS config dir, then AGENT_TRACK_* environment variables.

config.toml keys: db, host, port, and a [homes] table of adapter id to data directory. Environment: AGENT_TRACK_DB,
AGENT_TRACK_HOST, AGENT_TRACK_PORT, AGENT_TRACK_HOME_<ADAPTER ID in capitals>. A command-line flag beats all of them.
"""

import tomllib
from dataclasses import dataclass
from pathlib import Path

from .platform import Env

PREFIX = "AGENT_TRACK_"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3874


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Config:
    path: Path
    exists: bool
    db: Path
    host: str
    port: int
    homes: dict[str, Path]


def load(env: Env) -> Config:
    path = env.config_path
    data: dict = {}
    if path.is_file():
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
            raise ConfigError(f"cannot read {path}: {exc}") from exc
    homes = data.get("homes", {})
    if not isinstance(homes, dict):
        raise ConfigError(f"{path}: [homes] must be a table")
    resolved = {str(k): Path(str(v)).expanduser() for k, v in homes.items()}
    for key, value in env.environ.items():
        if key.startswith(PREFIX + "HOME_") and value:
            resolved[key.removeprefix(PREFIX + "HOME_").lower()] = Path(value).expanduser()

    def pick(name: str, default):
        return env.environ.get(PREFIX + name.upper()) or data.get(name) or default

    try:
        port = int(pick("port", DEFAULT_PORT))
    except (TypeError, ValueError) as exc:
        raise ConfigError("port must be an integer") from exc
    return Config(path, path.is_file(), Path(str(pick("db", env.default_db))).expanduser(), str(pick("host", DEFAULT_HOST)), port, resolved)
