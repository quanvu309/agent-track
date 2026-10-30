"""Transcript tail reading shared by adapters that decide a session's live state from the end of a log."""

import os
from pathlib import Path

from .model import norm_ts

TAIL_START = 64 * 1024
TAIL_GROWTH = 4
TAIL_MAX = 8 * 1024 * 1024


def ts(value) -> str | None:
    try:
        return norm_ts(value) if value else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def tail_lines(path: Path):
    """Complete lines from the end of a file, newest first, reading 64 KiB then 4x more per round up to 8 MiB.

    Yields one list per round; each round holds every complete line of the larger chunk.
    """
    with open(path, "rb") as fh:
        size = fh.seek(0, os.SEEK_END)
        window = TAIL_START
        while True:
            start = max(0, size - window)
            fh.seek(start)
            lines = fh.read(size - start).split(b"\n")
            if start > 0:
                lines = lines[1:]  # the first line of a chunk that does not begin the file is cut off
            yield [line.decode("utf-8", "replace") for line in reversed(lines) if line.strip()]
            if start == 0 or window >= TAIL_MAX:
                return
            window *= TAIL_GROWTH


def decide_from_tail(path: Path, decide, default):
    """First decisive record scanning backwards, else default."""
    try:
        for lines in tail_lines(path):
            for line in lines:
                found = decide(line)
                if found:
                    return found
    except OSError:
        pass
    return default
