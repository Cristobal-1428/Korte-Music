from datetime import datetime, timezone

from sqlalchemy import false
from sqlmodel import Field, SQLModel


class Song(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str
    artist: str
    file_path: str  # nombre del archivo dentro de uploads/
    content_type: str = "audio/mpeg"
    plays: int = Field(default=0, sa_column_kwargs={"server_default": "0"})
    likes: int = Field(default=0, sa_column_kwargs={"server_default": "0"})
    # Privada: solo la ve quien tenga la clave de administrador; su audio va a un almacenamiento no público.
    is_private: bool = Field(default=False, sa_column_kwargs={"server_default": false()})
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SongRead(SQLModel):
    """Lo que devuelve la API (no expone rutas internas del disco)."""

    id: int
    title: str
    artist: str
    plays: int = 0
    likes: int = 0
    is_private: bool = False
    created_at: datetime
