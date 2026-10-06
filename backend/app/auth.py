"""Cuentas: comprueba el token que entrega Supabase Auth y dice quién es la persona.

En vez de validar la firma del token a mano (el método cambia según el proyecto), se le pregunta a Supabase
"¿de quién es este token?" (GET /auth/v1/user). La respuesta se recuerda un minuto para no repetir la consulta.
"""

import os
import time
from dataclasses import dataclass

import httpx
from fastapi import Header

# SUPABASE_AUTH_URL permite apuntar a otro servidor de cuentas (por ejemplo uno falso para pruebas locales).
AUTH_URL = (os.getenv("SUPABASE_AUTH_URL") or os.getenv("SUPABASE_URL", "")).strip().rstrip("/")
# Clave pública del proyecto (sb_publishable_...). Si falta, se usa la secreta, que también sirve para esta consulta.
AUTH_APIKEY = (os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_SERVICE_KEY", "")).strip()
# Correos con permiso de administrador (separados por comas). Además el correo debe estar confirmado.
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}
ENABLED = bool(AUTH_URL and AUTH_APIKEY)
# Clave secreta del proyecto: solo la usa el administrador para buscar una cuenta por su correo.
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "").strip()

CACHE_SECONDS = 60


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str | None
    email_confirmed: bool

    @property
    def is_admin(self) -> bool:
        return self.email_confirmed and bool(self.email) and self.email.lower() in ADMIN_EMAILS

    @property
    def role(self) -> str:
        return "admin" if self.is_admin else "listener"


_cache: dict[str, tuple[float, AuthUser | None]] = {}


async def user_from_token(token: str) -> AuthUser | None:
    now = time.time()
    hit = _cache.get(token)
    if hit and hit[0] > now:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(
                f"{AUTH_URL}/auth/v1/user",
                headers={"apikey": AUTH_APIKEY, "Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError:
        return None  # sin conexión con Supabase: no se recuerda, se reintenta en la próxima petición
    user = None
    if res.status_code == 200:
        data = res.json()
        user = AuthUser(
            id=data["id"],
            email=data.get("email"),
            email_confirmed=bool(data.get("email_confirmed_at") or data.get("confirmed_at")),
        )
    if len(_cache) > 500:  # evita que crezca sin límite
        for key in [k for k, (exp, _) in _cache.items() if exp <= now]:
            _cache.pop(key, None)
    _cache[token] = (now + CACHE_SECONDS, user)
    return user


async def current_user(authorization: str | None = Header(default=None)) -> AuthUser | None:
    """Dependencia de FastAPI: la persona con sesión iniciada, o None si no hay sesión (o es inválida)."""
    if not ENABLED or not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return await user_from_token(token.strip())


class AccountLookupError(Exception):
    """No se pudo consultar la lista de cuentas (falta la clave secreta o Supabase no respondió)."""


async def find_user_by_email(email: str) -> AuthUser | None:
    """Busca una cuenta por su correo (API de administración de Supabase). None si no existe."""
    if not (AUTH_URL and SERVICE_KEY):
        raise AccountLookupError("No se pueden buscar cuentas: falta SUPABASE_SERVICE_KEY en el servidor")
    wanted = email.strip().lower()
    per_page = 200
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            for page in range(1, 26):  # hasta 5.000 cuentas
                res = await client.get(
                    f"{AUTH_URL}/auth/v1/admin/users",
                    params={"page": page, "per_page": per_page},
                    headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"},
                )
                if res.status_code != 200:
                    raise AccountLookupError(f"Supabase respondió {res.status_code} al buscar la cuenta")
                data = res.json()
                users = data.get("users", []) if isinstance(data, dict) else data
                for u in users:
                    if (u.get("email") or "").strip().lower() == wanted:
                        return AuthUser(
                            id=u["id"],
                            email=u.get("email"),
                            email_confirmed=bool(u.get("email_confirmed_at") or u.get("confirmed_at")),
                        )
                if len(users) < per_page:
                    break
    except httpx.HTTPError as exc:
        raise AccountLookupError(f"No se pudo consultar Supabase: {exc}") from exc
    return None
