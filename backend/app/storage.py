"""Dónde se guardan los audios: Supabase Storage si está configurado, si no el disco local.

Las canciones públicas van a un bucket público (cualquiera con el link puede escucharlas).
Las privadas van a otro bucket NO público: solo se escuchan con un link temporal firmado.
"""

import os

import httpx

from .database import UPLOAD_DIR

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()
BUCKET = os.getenv("SUPABASE_BUCKET", "songs")
PRIVATE_BUCKET = os.getenv("SUPABASE_PRIVATE_BUCKET", "songs-private")
USE_SUPABASE = bool(SUPABASE_URL and SUPABASE_KEY)

# Las claves nuevas (sb_secret_...) no son JWT: van solo en "apikey". La clave clásica service_role sí lleva Bearer.
_AUTH = {"apikey": SUPABASE_KEY}
if not SUPABASE_KEY.startswith("sb_"):
    _AUTH["Authorization"] = f"Bearer {SUPABASE_KEY}"

LOCAL_PRIVATE_DIR = UPLOAD_DIR / "private"


def local_path(name: str, private: bool = False):
    return (LOCAL_PRIVATE_DIR if private else UPLOAD_DIR) / name


def init_storage() -> None:
    """Prepara el destino: crea los buckets en Supabase o las carpetas locales."""
    if not USE_SUPABASE:
        LOCAL_PRIVATE_DIR.mkdir(parents=True, exist_ok=True)
        return
    # Si el bucket ya existe, Supabase responde 4xx y se ignora.
    for bucket, public in ((BUCKET, True), (PRIVATE_BUCKET, False)):
        httpx.post(
            f"{SUPABASE_URL}/storage/v1/bucket",
            headers=_AUTH,
            json={"id": bucket, "name": bucket, "public": public},
            timeout=15,
        )


async def save(name: str, data: bytes, content_type: str, private: bool = False) -> None:
    if not USE_SUPABASE:
        path = local_path(name, private)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    bucket = PRIVATE_BUCKET if private else BUCKET
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/{bucket}/{name}",
            headers={**_AUTH, "Content-Type": content_type},
            content=data,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Supabase Storage rechazó la subida ({res.status_code}): {res.text}")


async def delete(name: str, private: bool = False) -> None:
    if not USE_SUPABASE:
        local_path(name, private).unlink(missing_ok=True)
        return
    bucket = PRIVATE_BUCKET if private else BUCKET
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.delete(f"{SUPABASE_URL}/storage/v1/object/{bucket}/{name}", headers=_AUTH)
    # 404: el archivo ya no estaba, el resultado buscado es el mismo.
    if res.status_code >= 400 and res.status_code != 404:
        raise RuntimeError(f"Supabase Storage rechazó el borrado ({res.status_code}): {res.text}")


def public_url(name: str) -> str:
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{name}"


async def signed_url(name: str, expires_in: int = 3600) -> str:
    """Link temporal para escuchar un audio privado."""
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            f"{SUPABASE_URL}/storage/v1/object/sign/{PRIVATE_BUCKET}/{name}",
            headers=_AUTH,
            json={"expiresIn": expires_in},
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Supabase Storage no pudo firmar el link ({res.status_code}): {res.text}")
    return f"{SUPABASE_URL}/storage/v1{res.json()['signedURL']}"
