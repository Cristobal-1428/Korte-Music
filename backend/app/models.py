from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


class Song(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    title: str
    artist: str
    file_path: str  # nombre del archivo dentro de uploads/
    content_type: str = "audio/mpeg"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SongRead(SQLModel):
    """Lo que devuelve la API (no expone rutas internas del disco)."""

    id: int
    title: str
    artist: str
    created_at: datetime
