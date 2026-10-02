"""Dónde se guardan los audios: Supabase Storage si está configurado, si no el disco local."""

import os

import httpx

from .database import UPLOAD_DIR

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
BUCKET = os.getenv("SUPABASE_BUCKET", "songs")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)

# Las claves nuevas (sb_secret_...) no son JWT: van solo en "apikey". La clave clásica service_role sí lleva Bearer.
_AUTH = {"apikey": SUPABASE_KEY}
if not SUPABASE_KEY.startswith("sb_"):
    _AUTH["Authorization"] = f"Bearer {SUPABASE_KEY}"


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


async def delete(name: str) -> None:
    if not USE_SUPABASE:
        (UPLOAD_DIR / name).unlink(missing_ok=True)
        return
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.delete(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{name}", headers=_AUTH)
    # 404: el archivo ya no estaba, el resultado buscado es el mismo.
    if res.status_code >= 400 and res.status_code != 404:
        raise RuntimeError(f"Supabase Storage rechazó el borrado ({res.status_code}): {res.text}")


def public_url(name: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{name}"
