import os
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select

from . import storage
from .database import UPLOAD_DIR, get_session, init_db
from .models import Song, SongRead
from .streaming import range_response

ALLOWED_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
}
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024
UPLOAD_CHUNK = 1024 * 1024
ADMIN_KEY = os.getenv("ADMIN_KEY", "")


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


@app.post("/songs", response_model=SongRead, status_code=201)
async def upload_song(
    title: str = Form(..., min_length=1, max_length=200),
    artist: str = Form(..., min_length=1, max_length=200),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_TYPES:
        raise HTTPException(400, f"Formato no permitido. Usa: {', '.join(ALLOWED_TYPES)}")

    # Nombre generado en el servidor: evita colisiones y path traversal.
    stored_name = f"{uuid.uuid4().hex}{ext}"

    chunks: list[bytes] = []
    size = 0
    while chunk := await file.read(UPLOAD_CHUNK):
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise HTTPException(413, f"Archivo demasiado grande (máx. {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)")
        chunks.append(chunk)

    try:
        await storage.save(stored_name, b"".join(chunks), ALLOWED_TYPES[ext])
    except Exception as exc:
        raise HTTPException(502, f"No se pudo guardar el audio: {exc}")

    song = Song(
        title=title.strip(),
        artist=artist.strip(),
        file_path=stored_name,
        content_type=ALLOWED_TYPES[ext],
    )
    session.add(song)
    session.commit()
    session.refresh(song)
    return song


@app.get("/songs", response_model=list[SongRead])
def list_songs(session: Session = Depends(get_session)):
    return session.exec(select(Song).order_by(Song.created_at.desc())).all()


def require_admin(x_admin_key: str | None = Header(default=None)) -> None:
    """Si ADMIN_KEY está definida, borrar exige la cabecera X-Admin-Key; si no, no hay restricción."""
    if ADMIN_KEY and not secrets.compare_digest(x_admin_key or "", ADMIN_KEY):
        raise HTTPException(401, "Clave de administrador incorrecta")


@app.delete("/songs/{song_id}", status_code=204, dependencies=[Depends(require_admin)])
async def delete_song(song_id: int, session: Session = Depends(get_session)):
    song = session.get(Song, song_id)
    if song is None:
        raise HTTPException(404, "Canción no encontrada")
    # Primero el audio: si el almacenamiento falla, la fila queda y se puede reintentar sin dejar huérfanos.
    try:
        await storage.delete(song.file_path)
    except Exception as exc:
        raise HTTPException(502, f"No se pudo borrar el audio: {exc}")
    session.delete(song)
    session.commit()


@app.get("/songs/{song_id}/stream")
def stream_song(
    song_id: int,
    range: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    song = session.get(Song, song_id)
    if song is None:
        raise HTTPException(404, "Canción no encontrada")
    if storage.USE_SUPABASE:
        # El navegador pide el audio (con Range) directamente al almacenamiento.
        return RedirectResponse(storage.public_url(song.file_path), status_code=302)
    path = UPLOAD_DIR / song.file_path
    if not path.is_file():
        raise HTTPException(404, "Archivo de audio no encontrado en disco")
    return range_response(path, range, song.content_type)
