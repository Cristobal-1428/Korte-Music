import hashlib
import hmac
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import case, update
from sqlmodel import Session, select

from . import storage
from .database import get_session, init_db
from .models import Song, SongRead
from .streaming import range_response

ALLOWED_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
}
COVER_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
MAX_COVER_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024
UPLOAD_CHUNK = 1024 * 1024
ADMIN_KEY = os.getenv("ADMIN_KEY", "")
SESSION_SECONDS = 12 * 3600  # duración del permiso para escuchar canciones privadas


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    storage.init_storage()
    yield


app = FastAPI(title="Musica API", lifespan=lifespan)

# El frontend se sirve desde otro origen (Live Server, http.server, etc.).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://localhost:8080",
        # Orígenes extra (p. ej. el dominio de Vercel), separados por comas.
        *filter(None, (o.strip().rstrip("/") for o in os.getenv("CORS_ORIGINS", "").split(","))),
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
)


# ---------------------------------------------------------------- administrador

def is_admin(key: str | None) -> bool:
    """True solo si hay ADMIN_KEY configurada y la clave coincide."""
    return bool(ADMIN_KEY) and secrets.compare_digest((key or "").encode(), ADMIN_KEY.encode())


def require_admin(x_admin_key: str | None = Header(default=None)) -> None:
    """Si ADMIN_KEY está definida, subir y borrar canciones exigen la cabecera X-Admin-Key; si no, no hay restricción."""
    if ADMIN_KEY and not is_admin(x_admin_key):
        raise HTTPException(401, "Clave de administrador incorrecta")


def make_session_token() -> tuple[str, int]:
    """Permiso temporal para escuchar privadas. El <audio> no puede enviar cabeceras, por eso va en la URL."""
    expires = int(time.time()) + SESSION_SECONDS
    sig = hmac.new(ADMIN_KEY.encode(), f"private:{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}", expires


def valid_session_token(token: str | None) -> bool:
    if not ADMIN_KEY or not token or "." not in token:
        return False
    expires_s, _, sig = token.partition(".")
    if not expires_s.isdigit() or int(expires_s) < time.time():
        return False
    expected = hmac.new(ADMIN_KEY.encode(), f"private:{expires_s}".encode(), hashlib.sha256).hexdigest()
    return secrets.compare_digest(sig.encode(), expected.encode())


@app.get("/admin/session")
def admin_session(x_admin_key: str | None = Header(default=None)):
    """Comprueba la clave y entrega el permiso temporal para reproducir canciones privadas."""
    if not is_admin(x_admin_key):
        raise HTTPException(401, "Clave de administrador incorrecta")
    token, expires = make_session_token()
    return {"token": token, "expires": expires}


# ----------------------------------------------------------------------- canciones

async def _read_cover(cover: UploadFile | None) -> tuple[str | None, bytes | None, str]:
    """Valida la portada opcional; un campo de archivo vacío llega sin nombre y se ignora."""
    if not cover or not cover.filename:
        return None, None, ""
    ext = Path(cover.filename).suffix.lower()
    if ext not in COVER_TYPES:
        raise HTTPException(400, f"Formato de portada no permitido. Usa: {', '.join(COVER_TYPES)}")
    data = await cover.read(MAX_COVER_BYTES + 1)
    if len(data) > MAX_COVER_BYTES:
        raise HTTPException(413, f"Portada demasiado grande (máx. {MAX_COVER_BYTES // (1024 * 1024)} MB)")
    return f"cover-{uuid.uuid4().hex}{ext}", data, ext


@app.post("/songs", response_model=SongRead, status_code=201, dependencies=[Depends(require_admin)])
async def upload_song(
    title: str = Form(..., min_length=1, max_length=200),
    artist: str = Form(..., min_length=1, max_length=200),
    is_private: bool = Form(False),
    file: UploadFile = File(...),
    cover: UploadFile | None = File(None),
    session: Session = Depends(get_session),
):
    if is_private and not ADMIN_KEY:
        raise HTTPException(400, "Para subir canciones privadas hay que configurar ADMIN_KEY en el servidor")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_TYPES:
        raise HTTPException(400, f"Formato no permitido. Usa: {', '.join(ALLOWED_TYPES)}")

    # Nombre generado en el servidor: evita colisiones y path traversal.
    stored_name = f"{uuid.uuid4().hex}{ext}"

    cover_name, cover_data, cover_ext = await _read_cover(cover)

    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(UPLOAD_CHUNK):
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Archivo demasiado grande (máx. {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
        chunks.append(chunk)

    try:
        await storage.save(stored_name, b"".join(chunks), ALLOWED_TYPES[ext], private=is_private)
    except Exception as exc:
        raise HTTPException(502, f"No se pudo guardar el audio: {exc}")

    if cover_name:
        try:
            await storage.save(cover_name, cover_data, COVER_TYPES[cover_ext], private=is_private)
        except Exception as exc:
            await storage.delete(stored_name, private=is_private)  # sin portada guardada no se deja el audio huérfano
            raise HTTPException(502, f"No se pudo guardar la portada: {exc}")

    song = Song(
        title=title.strip(),
        artist=artist.strip(),
        file_path=stored_name,
        content_type=ALLOWED_TYPES[ext],
        is_private=is_private,
        cover_path=cover_name,
    )
    session.add(song)
    session.commit()
    session.refresh(song)
    return song


@app.patch("/songs/{song_id}", response_model=SongRead, dependencies=[Depends(require_admin)])
async def edit_song(
    song_id: int,
    title: str = Form(..., min_length=1, max_length=200),
    artist: str = Form(..., min_length=1, max_length=200),
    remove_cover: bool = Form(False),
    cover: UploadFile | None = File(None),
    session: Session = Depends(get_session),
):
    """Cambia título y artista; la portada se reemplaza si llega una nueva, o se quita con remove_cover."""
    song = session.get(Song, song_id)
    if song is None:
        raise HTTPException(404, "Canción no encontrada")
    cover_name, cover_data, cover_ext = await _read_cover(cover)
    old_cover = song.cover_path
    if cover_name:
        try:
            await storage.save(cover_name, cover_data, COVER_TYPES[cover_ext], private=song.is_private)
        except Exception as exc:
            raise HTTPException(502, f"No se pudo guardar la portada: {exc}")
        song.cover_path = cover_name
    elif remove_cover:
        song.cover_path = None
    song.title = title.strip()
    song.artist = artist.strip()
    session.add(song)
    session.commit()
    session.refresh(song)
    if old_cover and old_cover != song.cover_path:
        try:
            await storage.delete(old_cover, private=song.is_private)
        except Exception:
            pass  # una portada vieja que no se pudo borrar no invalida el cambio
    return song


@app.get("/songs", response_model=list[SongRead])
def list_songs(x_admin_key: str | None = Header(default=None), session: Session = Depends(get_session)):
    # Las privadas solo se entregan con la clave de administrador; con una clave mala se ven solo las públicas.
    query = select(Song).order_by(Song.created_at.desc())
    if not is_admin(x_admin_key):
        query = query.where(Song.is_private == False)  # noqa: E712 (SQLAlchemy necesita el ==)
    return session.exec(query).all()


@app.delete("/songs/{song_id}", status_code=204, dependencies=[Depends(require_admin)])
async def delete_song(song_id: int, session: Session = Depends(get_session)):
    song = session.get(Song, song_id)
    if song is None:
        raise HTTPException(404, "Canción no encontrada")
    # Primero el audio: si el almacenamiento falla, la fila queda y se puede reintentar sin dejar huérfanos.
    try:
        await storage.delete(song.file_path, private=song.is_private)
    except Exception as exc:
        raise HTTPException(502, f"No se pudo borrar el audio: {exc}")
    if song.cover_path:
        try:
            await storage.delete(song.cover_path, private=song.is_private)
        except Exception:
            pass  # una portada huérfana no impide borrar la canción
    session.delete(song)
    session.commit()


def _only_visible(statement, admin: bool):
    """Las canciones privadas no existen para quien no tenga la clave (también para los contadores)."""
    return statement if admin else statement.where(Song.is_private == False)  # noqa: E712


@app.post("/songs/{song_id}/play")
def count_play(
    song_id: int,
    x_admin_key: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    """Suma una reproducción (el frontend la avisa tras escuchar unos segundos)."""
    # UPDATE atómico: dos oyentes a la vez no pisan el contador del otro.
    statement = _only_visible(update(Song).where(Song.id == song_id).values(plays=Song.plays + 1), is_admin(x_admin_key))
    if session.exec(statement).rowcount == 0:
        raise HTTPException(404, "Canción no encontrada")
    session.commit()
    return {"plays": session.exec(select(Song.plays).where(Song.id == song_id)).one()}


def _change_likes(session: Session, song_id: int, delta: int, admin: bool) -> dict:
    # UPDATE atómico; al quitar un "me gusta" el contador nunca baja de 0.
    new_value = Song.likes + 1 if delta > 0 else case((Song.likes > 0, Song.likes - 1), else_=0)
    statement = _only_visible(update(Song).where(Song.id == song_id).values(likes=new_value), admin)
    if session.exec(statement).rowcount == 0:
        raise HTTPException(404, "Canción no encontrada")
    session.commit()
    return {"likes": session.exec(select(Song.likes).where(Song.id == song_id)).one()}


@app.post("/songs/{song_id}/like")
def like_song(
    song_id: int,
    x_admin_key: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    return _change_likes(session, song_id, +1, is_admin(x_admin_key))


@app.delete("/songs/{song_id}/like")
def unlike_song(
    song_id: int,
    x_admin_key: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    return _change_likes(session, song_id, -1, is_admin(x_admin_key))


@app.get("/songs/{song_id}/stream")
async def stream_song(
    song_id: int,
    t: str | None = Query(default=None),
    range: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    song = session.get(Song, song_id)
    # Una privada sin permiso responde igual que una que no existe.
    if song is None or (song.is_private and not valid_session_token(t)):
        raise HTTPException(404, "Canción no encontrada")
    if storage.USE_SUPABASE:
        # El navegador pide el audio (con Range) directamente al almacenamiento.
        if song.is_private:
            try:
                url = await storage.signed_url(song.file_path)
            except Exception as exc:
                raise HTTPException(502, f"No se pudo preparar el audio privado: {exc}")
        else:
            url = storage.public_url(song.file_path)
        return RedirectResponse(url, status_code=302)
    path = storage.local_path(song.file_path, private=song.is_private)
    if not path.is_file():
        raise HTTPException(404, "Archivo de audio no encontrado en disco")
    return range_response(path, range, song.content_type)


@app.get("/songs/{song_id}/cover")
async def song_cover(song_id: int, t: str | None = Query(default=None), session: Session = Depends(get_session)):
    song = session.get(Song, song_id)
    if song is None or not song.cover_path or (song.is_private and not valid_session_token(t)):
        raise HTTPException(404, "Portada no encontrada")
    if storage.USE_SUPABASE:
        if song.is_private:
            try:
                url = await storage.signed_url(song.cover_path)
            except Exception as exc:
                raise HTTPException(502, f"No se pudo preparar la portada privada: {exc}")
            return RedirectResponse(url, status_code=302, headers={"Cache-Control": "private, max-age=600"})
        return RedirectResponse(storage.public_url(song.cover_path), status_code=302, headers={"Cache-Control": "public, max-age=86400"})
    path = storage.local_path(song.cover_path, private=song.is_private)
    if not path.is_file():
        raise HTTPException(404, "Portada no encontrada en disco")
    return FileResponse(path, media_type=COVER_TYPES.get(path.suffix.lower(), "image/jpeg"))
