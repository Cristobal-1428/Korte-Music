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
    cover_path: str | None = None  # imagen de portada (opcional), mismo almacenamiento que el audio
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def has_cover(self) -> bool:
        return bool(self.cover_path)


class Like(SQLModel, table=True):
    """Un "me gusta" de una persona (user_id viene de Supabase Auth) a una canción: solo uno por par."""

    user_id: str = Field(primary_key=True)
    song_id: int = Field(primary_key=True, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Artist(SQLModel, table=True):
    """Datos extra de un artista (biografía y foto). Sus canciones se agrupan por el nombre que traen."""

    id: int | None = Field(default=None, primary_key=True)
    key: str = Field(index=True, unique=True)  # nombre sin tildes ni mayúsculas: "benjita de la 22"
    name: str
    bio: str | None = None
    image_path: str | None = None
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def has_image(self) -> bool:
        return bool(self.image_path)

    @property
    def version(self) -> int:
        """Cambia al editar el perfil; va en la URL de la foto para que el navegador no use una vieja."""
        return int(self.updated_at.timestamp())


class ArtistRead(SQLModel):
    name: str
    bio: str | None = None
    has_image: bool = False
    version: int = 0


class SongRead(SQLModel):
    """Lo que devuelve la API (no expone rutas internas del disco)."""

    id: int
    title: str
    artist: str
    plays: int = 0
    likes: int = 0
    is_private: bool = False
    has_cover: bool = False
    created_at: datetime
