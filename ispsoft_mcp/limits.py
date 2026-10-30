"""Bounded file I/O for offline transformations, never in-place project edits."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import tempfile
from typing import Any
import zlib

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 512
MAX_ITEM_CHARS = 60_000
MAX_RESPONSE_CHARS = 180_000


class FileTransformError(ValueError):
    """Unsupported, malformed or unsafe file operation."""


def read_bytes(path: str | Path, limit: int = MAX_FILE_BYTES) -> bytes:
    path = Path(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise FileTransformError(f"Not a regular file within {limit} bytes: {path}")
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise FileTransformError('File exceeds size limit')
    return data


def read_text(path: str | Path) -> str:
    return read_bytes(path, MAX_SOURCE_BYTES).decode('utf-8-sig')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inflate(data: bytes) -> tuple[bytes, int]:
    decoder = zlib.decompressobj(-15)
    try:
        raw = decoder.decompress(data, MAX_SOURCE_BYTES + 1)
    except zlib.error as exc:
        raise FileTransformError('Invalid raw DEFLATE stream') from exc
    if len(raw) > MAX_SOURCE_BYTES or decoder.unconsumed_tail:
        raise FileTransformError('Decompressed source exceeds size limit')
    if not decoder.eof:
        raise FileTransformError('Truncated DEFLATE stream')
    return raw, len(data) - len(decoder.unused_data)


def safe_member(name: str) -> str:
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise FileTransformError(f'Unsafe member path: {name!r}')
    posix, windows = PurePosixPath(name), PureWindowsPath(name)
    if posix.is_absolute() or windows.is_absolute() or any(p in ('', '.', '..') for p in name.split('/')):
        raise FileTransformError(f'Unsafe member path: {name!r}')
    for part in posix.parts:
        if part.endswith((' ', '.')) or any(ord(c) < 32 for c in part):
            raise FileTransformError('Unsafe Windows file name')
        stem = part.split('.')[0].upper()
        if stem in {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'} or (
            len(stem) == 4 and stem[:3] in ('COM', 'LPT') and stem[3] in '123456789¹²³'
        ):
            raise FileTransformError('Reserved Windows file name')
    return posix.as_posix()


def contained(directory: Path, name: str) -> Path:
    result = (directory / safe_member(name)).resolve()
    if not result.is_relative_to(directory.resolve()):
        raise FileTransformError('Workspace member escapes its directory')
    return result


def output_path(path: str | Path, inputs: tuple[Path, ...] = ()) -> Path:
    result = Path(path).absolute()
    if result.exists() or result.is_symlink():
        raise FileTransformError('Output must be a new path; overwrites are not supported')
    if result.resolve() in [p.resolve() for p in inputs]:
        raise FileTransformError('Original input cannot be overwritten')
    if not result.parent.is_dir():
        raise FileTransformError('Output parent directory must already exist')
    return result


def atomic_write(path: str | Path, data: bytes, inputs: tuple[Path, ...] = ()) -> Path:
    if len(data) > MAX_FILE_BYTES:
        raise FileTransformError('Output exceeds size limit')
    target = output_path(path, inputs)
    temp: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.plc-', delete=False) as stream:
            temp = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Rename on the same volume publishes the complete file atomically. On
        # Windows os.rename fails when the target already exists, preserving the
        # no-overwrite contract without requiring hard-link privileges (which
        # are commonly unavailable in managed Windows environments).
        if os.name == 'nt':
            os.rename(temp, target)
        else:
            # POSIX rename replaces an existing destination, so use a hard link
            # as the atomic create-if-absent operation there.
            os.link(temp, target)
        return target
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def compute_content_hash(format_prefix: str, content: str | bytes) -> str:
    """Compute standard SHA-256 content hash with format prefix."""
    raw = content.encode("utf-8") if isinstance(content, str) else content
    digest = hashlib.sha256(raw).hexdigest()
    prefix = format_prefix.strip().rstrip(":")
    if not prefix:
        return f"sha256:{digest}"
    if prefix.endswith("sha256"):
        return f"{prefix}:{digest}"
    return f"{prefix}:sha256:{digest}"


def enforce_value_budget(
    text: str,
    name: str = "payload",
    max_chars: int = MAX_ITEM_CHARS,
    narrowing_hint: str = "",
) -> dict[str, Any] | str:
    """Enforce whole-value omission if a string payload exceeds max_chars."""
    if len(text) <= max_chars:
        return text
    return {
        "_omitted": True,
        "field": name,
        "character_count": len(text),
        "budget_limit": max_chars,
        "reason": f"Value for '{name}' ({len(text)} chars) exceeds item budget ({max_chars} chars). Whole value omitted to preserve client token window.",
        "narrowing_guidance": narrowing_hint or f"Query individual sections or elements of '{name}' using dedicated read tools.",
    }


def budget_payload(
    payload: dict[str, Any],
    max_item_chars: int = MAX_ITEM_CHARS,
    max_response_chars: int = MAX_RESPONSE_CHARS,
) -> dict[str, Any]:
    """Apply value budgeting across dict items and ensure overall JSON response fits budget."""
    result = dict(payload)
    for k, v in list(result.items()):
        if isinstance(v, str) and len(v) > max_item_chars:
            result[k] = enforce_value_budget(v, name=k, max_chars=max_item_chars)
    serialized = json.dumps(result, default=str)
    if len(serialized) > max_response_chars:
        largest_field = None
        largest_len = 0
        for k, v in result.items():
            if isinstance(v, str) and len(v) > largest_len:
                largest_field = k
                largest_len = len(v)
        if largest_field and largest_len > 1000:
            result[largest_field] = enforce_value_budget(
                result[largest_field],
                name=largest_field,
                max_chars=1000,
                narrowing_hint="Response size exceeded total response budget limit (180k chars).",
            )
    return result
