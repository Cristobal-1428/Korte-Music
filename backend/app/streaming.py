from pathlib import Path
from typing import Iterator

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

CHUNK_SIZE = 64 * 1024


def _parse_range(header: str, file_size: int) -> tuple[int, int]:
    """Convierte 'bytes=inicio-fin' en (inicio, fin) inclusivos. Soporta 'bytes=500-', 'bytes=-500'."""
    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or "," in spec:
        raise ValueError("Range no soportado")
    start_s, _, end_s = spec.strip().partition("-")
    if start_s == "":  # sufijo: últimos N bytes
        length = int(end_s)
        if length <= 0:
            raise ValueError("Range inválido")
        return max(file_size - length, 0), file_size - 1
    start = int(start_s)
    end = int(end_s) if end_s else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise ValueError("Range fuera de rango")
    return start, end


def _iter_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as f:
        f.seek(start)
        while remaining > 0:
            chunk = f.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def range_response(path: Path, range_header: str | None, media_type: str) -> StreamingResponse:
    file_size = path.stat().st_size
    base_headers = {"Accept-Ranges": "bytes"}

    if not range_header:
        return StreamingResponse(
            _iter_file(path, 0, file_size - 1),
            media_type=media_type,
            headers={**base_headers, "Content-Length": str(file_size)},
        )

    try:
        start, end = _parse_range(range_header, file_size)
    except ValueError:
        raise HTTPException(
            status_code=416,
            detail="Range no satisfacible",
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    return StreamingResponse(
        _iter_file(path, start, end),
        status_code=206,
        media_type=media_type,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(end - start + 1),
        },
    )
