import hashlib
import hmac
import os
import re
import secrets
import time
import unicodedata
from html import escape
from urllib.parse import quote
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from sqlalchemy import case, update
from sqlalchemy import delete as sql_delete
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from . import auth, storage
from .database import get_session, init_db
from .models import Artist, ArtistRead, Like, Song, SongRead
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

# Secreto con el que se firman los permisos temporales para escuchar canciones privadas.
SESSION_SECRET = os.getenv("SESSION_SECRET") or ADMIN_KEY or os.getenv("SUPABASE_SERVICE_KEY", "")
ADMIN_CONFIGURED = bool(ADMIN_KEY or auth.ADMIN_EMAILS)


def is_admin(key: str | None) -> bool:
    """True solo si hay ADMIN_KEY configurada y la clave coincide."""
    return bool(ADMIN_KEY) and secrets.compare_digest((key or "").encode(), ADMIN_KEY.encode())


async def admin_flag(
    x_admin_key: str | None = Header(default=None),
    user: auth.AuthUser | None = Depends(auth.current_user),
) -> bool:
    """Administrador: quien envía la clave ADMIN_KEY, o una cuenta con el correo confirmado y en ADMIN_EMAILS."""
    return is_admin(x_admin_key) or bool(user and user.is_admin)


def require_admin(admin: bool = Depends(admin_flag)) -> None:
    """Si hay administrador configurado (clave o correos), subir, editar y borrar lo exigen; si no, no hay restricción."""
    if ADMIN_CONFIGURED and not admin:
        raise HTTPException(401, "Solo el administrador puede hacer esto")


def make_session_token() -> tuple[str, int]:
    """Permiso temporal para escuchar privadas. El <audio> no puede enviar cabeceras, por eso va en la URL."""
    expires = int(time.time()) + SESSION_SECONDS
    sig = hmac.new(SESSION_SECRET.encode(), f"private:{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}.{sig}", expires


def valid_session_token(token: str | None) -> bool:
    if not SESSION_SECRET or not token or "." not in token:
        return False
    expires_s, _, sig = token.partition(".")
    if not expires_s.isdigit() or int(expires_s) < time.time():
        return False
    expected = hmac.new(SESSION_SECRET.encode(), f"private:{expires_s}".encode(), hashlib.sha256).hexdigest()
    return secrets.compare_digest(sig.encode(), expected.encode())


@app.get("/admin/session")
def admin_session(admin: bool = Depends(admin_flag)):
    """Comprueba que es el administrador (clave o cuenta) y entrega el permiso temporal para escuchar privadas."""
    if not admin or not SESSION_SECRET:
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
    if is_private and not ADMIN_CONFIGURED:
        raise HTTPException(400, "Para subir canciones privadas hay que configurar ADMIN_KEY o ADMIN_EMAILS en el servidor")
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
def list_songs(admin: bool = Depends(admin_flag), session: Session = Depends(get_session)):
    # Las privadas solo se entregan al administrador; con una clave o sesión inválida se ven solo las públicas.
    query = select(Song).order_by(Song.created_at.desc())
    if not admin:
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
    session.exec(sql_delete(Like).where(Like.song_id == song_id))  # sus "me gusta" se van con ella
    session.delete(song)
    session.commit()


def _only_visible(statement, admin: bool):
    """Las canciones privadas no existen para quien no tenga la clave (también para los contadores)."""
    return statement if admin else statement.where(Song.is_private == False)  # noqa: E712


@app.post("/songs/{song_id}/play")
def count_play(
    song_id: int,
    admin: bool = Depends(admin_flag),
    session: Session = Depends(get_session),
):
    """Suma una reproducción (el frontend la avisa tras escuchar unos segundos)."""
    # UPDATE atómico: dos oyentes a la vez no pisan el contador del otro.
    statement = _only_visible(update(Song).where(Song.id == song_id).values(plays=Song.plays + 1), admin)
    if session.exec(statement).rowcount == 0:
        raise HTTPException(404, "Canción no encontrada")
    session.commit()
    return {"plays": session.exec(select(Song.plays).where(Song.id == song_id)).one()}


def _set_like(session: Session, song_id: int, user: auth.AuthUser | None, admin: bool, add: bool) -> dict:
    """Cada persona puede dar un solo "me gusta" por canción. Quitarlo resta uno, sin bajar de 0."""
    if user is None:
        raise HTTPException(401, "Inicia sesión para dar me gusta")
    visible = select(Song.id).where(Song.id == song_id)
    if not admin:
        visible = visible.where(Song.is_private == False)  # noqa: E712
    if session.exec(visible).first() is None:
        raise HTTPException(404, "Canción no encontrada")
    existing = session.get(Like, (user.id, song_id))
    if add and existing is None:
        try:
            session.add(Like(user_id=user.id, song_id=song_id))
            session.exec(update(Song).where(Song.id == song_id).values(likes=Song.likes + 1))
            session.commit()
        except IntegrityError:
            session.rollback()  # el mismo "me gusta" llegó dos veces a la vez: ya contaba
    elif not add and existing is not None:
        session.delete(existing)
        session.exec(update(Song).where(Song.id == song_id).values(likes=case((Song.likes > 0, Song.likes - 1), else_=0)))
        session.commit()
    return {"likes": session.exec(select(Song.likes).where(Song.id == song_id)).one()}


@app.post("/songs/{song_id}/like")
def like_song(
    song_id: int,
    user: auth.AuthUser | None = Depends(auth.current_user),
    admin: bool = Depends(admin_flag),
    session: Session = Depends(get_session),
):
    return _set_like(session, song_id, user, admin, add=True)


@app.delete("/songs/{song_id}/like")
def unlike_song(
    song_id: int,
    user: auth.AuthUser | None = Depends(auth.current_user),
    admin: bool = Depends(admin_flag),
    session: Session = Depends(get_session),
):
    return _set_like(session, song_id, user, admin, add=False)


@app.get("/me")
def me(user: auth.AuthUser | None = Depends(auth.current_user)):
    """Quién es la persona con sesión iniciada y qué puede hacer."""
    if user is None:
        raise HTTPException(401, "Sin sesión")
    return {"id": user.id, "email": user.email, "role": user.role, "is_admin": user.is_admin}


@app.get("/me/likes", response_model=list[int])
def my_likes(user: auth.AuthUser | None = Depends(auth.current_user), session: Session = Depends(get_session)):
    """Ids de las canciones a las que esta persona dio me gusta."""
    if user is None:
        raise HTTPException(401, "Sin sesión")
    return session.exec(select(Like.song_id).where(Like.user_id == user.id)).all()


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


# ----------------------------------------------------------------------- artistas

def artist_key(name: str) -> str:
    """Misma normalización que el frontend: sin tildes, en minúsculas y con espacios simples."""
    plain = "".join(c for c in unicodedata.normalize("NFD", name) if not unicodedata.combining(c))
    return " ".join(plain.lower().split())


def _clean_instagram(value: str) -> str | None:
    """Acepta @usuario, usuario o un enlace de instagram.com y lo deja como enlace completo (vacío = sin Instagram)."""
    value = value.strip()
    if not value:
        return None
    match = re.fullmatch(r"(?:https?://)?(?:www\.)?instagram\.com/([A-Za-z0-9._]{1,30})/?(?:\?.*)?", value)
    handle = match.group(1) if match else value.lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
        raise HTTPException(400, "El Instagram debe ser un @usuario o un enlace de instagram.com")
    return f"https://www.instagram.com/{handle}/"


@app.get("/artists", response_model=list[ArtistRead])
def list_artists(session: Session = Depends(get_session)):
    return session.exec(select(Artist)).all()


@app.put("/artists", response_model=ArtistRead, dependencies=[Depends(require_admin)])
async def save_artist(
    name: str = Form(..., min_length=1, max_length=200),
    bio: str = Form("", max_length=2000),
    instagram: str = Form("", max_length=200),
    remove_image: bool = Form(False),
    image: UploadFile | None = File(None),
    session: Session = Depends(get_session),
):
    """Crea o actualiza el perfil de un artista: biografía y foto (opcional)."""
    name = " ".join(name.split())  # espacios simples, sin los de los extremos
    key = artist_key(name)
    if not key:
        raise HTTPException(400, "Falta el nombre del artista")
    instagram_url = _clean_instagram(instagram)
    artist = session.exec(select(Artist).where(Artist.key == key)).first()
    image_name, image_data, image_ext = await _read_cover(image)
    old_image = artist.image_path if artist else None
    if artist is None:
        artist = Artist(key=key, name=name)
    if image_name:
        try:
            await storage.save(image_name, image_data, COVER_TYPES[image_ext], private=False)
        except Exception as exc:
            raise HTTPException(502, f"No se pudo guardar la foto: {exc}")
        artist.image_path = image_name
    elif remove_image:
        artist.image_path = None
    artist.name = name
    artist.bio = bio.replace("\r\n", "\n").strip() or None
    artist.instagram = instagram_url
    artist.updated_at = datetime.now(timezone.utc)
    session.add(artist)
    session.commit()
    session.refresh(artist)
    if old_image and old_image != artist.image_path:
        try:
            await storage.delete(old_image, private=False)
        except Exception:
            pass  # una foto vieja que no se pudo borrar no invalida el cambio
    return artist


@app.delete("/artists", status_code=204, dependencies=[Depends(require_admin)])
async def delete_artist(name: str = Query(...), session: Session = Depends(get_session)):
    """Borra el perfil (biografía y foto). Las canciones no se tocan: el artista sigue existiendo por ellas."""
    artist = session.exec(select(Artist).where(Artist.key == artist_key(name))).first()
    if artist is None:
        raise HTTPException(404, "Perfil no encontrado")
    if artist.image_path:
        try:
            await storage.delete(artist.image_path, private=False)
        except Exception as exc:
            raise HTTPException(502, f"No se pudo borrar la foto: {exc}")
    session.delete(artist)
    session.commit()


@app.get("/artists/image")
async def artist_image(name: str = Query(...), session: Session = Depends(get_session)):
    artist = session.exec(select(Artist).where(Artist.key == artist_key(name))).first()
    if artist is None or not artist.image_path:
        raise HTTPException(404, "Foto no encontrada")
    if storage.USE_SUPABASE:
        return RedirectResponse(storage.public_url(artist.image_path), status_code=302, headers={"Cache-Control": "public, max-age=86400"})
    path = storage.local_path(artist.image_path)
    if not path.is_file():
        raise HTTPException(404, "Foto no encontrada en disco")
    return FileResponse(path, media_type=COVER_TYPES.get(path.suffix.lower(), "image/jpeg"))


# ------------------------------------------------------------------- compartir
# Los rastreadores de WhatsApp, Instagram, etc. no ejecutan JavaScript ni leen el #, así que el enlace que se
# comparte apunta a la API: devuelve una página con la vista previa (Open Graph) y redirige a la app.

FRONTEND_URL = os.getenv("FRONTEND_URL", "https://korte-music-frontend.vercel.app").rstrip("/")
API_PUBLIC_URL = os.getenv("API_PUBLIC_URL", "https://korte-music.onrender.com").rstrip("/")


def _share_page(title: str, description: str, image: str | None, target: str, page_url: str) -> HTMLResponse:
    t, d, u, g = escape(title, True), escape(description, True), escape(target, True), escape(page_url, True)
    img = f'<meta property="og:image" content="{escape(image, True)}"><meta name="twitter:card" content="summary_large_image">' if image else '<meta name="twitter:card" content="summary">'
    body = (
        f'<!doctype html><html lang="es"><head><meta charset="utf-8"><title>{t}</title>'
        f'<meta property="og:type" content="music.song"><meta property="og:site_name" content="Korte Music">'
        f'<meta property="og:title" content="{t}"><meta property="og:description" content="{d}">'
        f'<meta property="og:url" content="{g}">{img}'
        f'<meta http-equiv="refresh" content="0;url={u}"></head>'
        f'<body><a href="{u}">Abrir en Korte Music</a></body></html>'
    )
    return HTMLResponse(body, headers={"Cache-Control": "public, max-age=300"})


@app.get("/share/song/{song_id}")
def share_song(song_id: int, session: Session = Depends(get_session)):
    song = session.get(Song, song_id)
    if song is None or song.is_private:  # lo privado nunca se anuncia
        return RedirectResponse(FRONTEND_URL, status_code=302)
    image = f"{API_PUBLIC_URL}/songs/{song.id}/cover" if song.cover_path else None
    return _share_page(
        f"{song.title} – {song.artist}", "Escúchala en Korte Music", image,
        f"{FRONTEND_URL}/#/song/{song.id}", f"{API_PUBLIC_URL}/share/song/{song.id}",
    )


@app.get("/share/artist")
def share_artist(name: str = Query(...), session: Session = Depends(get_session)):
    artist = session.exec(select(Artist).where(Artist.key == artist_key(name))).first()
    display = artist.name if artist else name
    image = f"{API_PUBLIC_URL}/artists/image?name={quote(display)}" if artist and artist.image_path else None
    return _share_page(
        display, "Su música en Korte Music", image,
        f"{FRONTEND_URL}/#/artist/{quote(display, safe='')}", f"{API_PUBLIC_URL}/share/artist?name={quote(display)}",
    )
