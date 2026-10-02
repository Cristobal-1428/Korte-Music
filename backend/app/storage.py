"""Dónde se guardan los audios: Supabase Storage si está configurado, si no el disco local."""

import os

import httpx

from .database import UPLOAD_DIR

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
BUCKET = os.getenv("SUPABASE_BUCKET", "songs")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)

_AUTH = {"Authorization": f"Bearer {SUPABASE_KEY}", "apikey": SUPABASE_KEY}


def init_storage() -> None:
    """Prepara el destino: crea el bucket público en Supabase o la carpeta local."""
    if not USE_SUPABASE:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return
    # Si el bucket ya existe, Supabase responde 4xx y se ignora.
    httpx.post(
        f"{SUPABASE_URL}/storage/v1/bucket",
        headers=_AUTH,
        json={"id": BUCKET, "name": BUCKET, "public": True},
        timeout=15,
    )


async def save(name: str, data: bytes, content_type: str) -> None:
    if not USE_SUPABASE:
        (UPLOAD_DIR / name).write_bytes(data)
        return
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}",
            headers={**_AUTH, "Content-Type": content_type},
            content=data,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Supabase Storage rechazó la subida ({res.status_code}): {res.text}")


def public_url(name: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{name}"
