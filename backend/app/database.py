import os
from pathlib import Path

from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

BASE_DIR = Path(__file__).resolve().parent.parent
# En local los audios y SQLite viven en DATA_DIR (por defecto, la carpeta backend).
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR))
UPLOAD_DIR = DATA_DIR / "uploads"


def _database_url() -> str | None:
    """DATABASE_URL (Postgres en producción); Supabase la entrega como postgresql://."""
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        return None
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


DATABASE_URL = _database_url()

if DATABASE_URL:
    # pool_pre_ping: el pooler de Supabase cierra conexiones inactivas.
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
else:
    # check_same_thread=False: FastAPI atiende peticiones desde varios hilos.
    engine = create_engine(
        f"sqlite:///{DATA_DIR / 'musica.db'}", connect_args={"check_same_thread": False}
    )


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    # create_all no agrega columnas a tablas que ya existen: la base de producción se actualiza aquí.
    existing = {c["name"] for c in inspect(engine).get_columns("song")}
    new_columns = {
        "plays": "INTEGER NOT NULL DEFAULT 0",
        "likes": "INTEGER NOT NULL DEFAULT 0",
        "is_private": "BOOLEAN NOT NULL DEFAULT FALSE",
        "cover_path": "VARCHAR",
        "lyrics": "TEXT",
    }
    for column, definition in new_columns.items():
        if column not in existing:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE song ADD COLUMN {column} {definition}"))
    existing_artist = {c["name"] for c in inspect(engine).get_columns("artist")}
    for column in ("instagram", "city", "owner_id"):
        if column not in existing_artist:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE artist ADD COLUMN {column} VARCHAR"))
    # Un perfil por cuenta. Los NULL (perfiles del administrador) no chocan entre sí.
    with engine.begin() as conn:
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_artist_owner_id ON artist (owner_id)"))


def get_session():
    with Session(engine) as session:
        yield session
