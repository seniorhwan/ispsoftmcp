"""Bounded file I/O for offline transformations, never in-place project edits."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import tempfile
import zlib

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 512


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
        # A hard link publishes the complete file and fails atomically if another
        # writer created the destination. Unlike replace(), it never overwrites.
        os.link(temp, target)
        return target
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
