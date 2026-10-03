// URL de la API. En local apunta al backend de desarrollo; en producción (Vercel)
// reemplaza PRODUCTION_API por la URL pública del backend (p. ej. https://korte-music-api.onrender.com).
const PRODUCTION_API = "https://korte-music.onrender.com";
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
window.API_URL = isLocal ? "http://127.0.0.1:8001" : PRODUCTION_API;

// Cuentas (Supabase Auth). Aquí va la clave PÚBLICA del proyecto (Project Settings → API Keys → "Publishable key",
// empieza con sb_publishable_…): es seguro que se vea en la página. NUNCA pegues aquí la clave secreta.
window.AUTH_CONFIG = { url: "https://seslebmaaimyeldfgptf.supabase.co", anonKey: "sb_publishable_K3B04CDa9xaBj8c62sw6SQ_4AyeWo0X" };
if (isLocal) {
  // Solo para pruebas en tu computador: ?authurl=http://127.0.0.1:9999 usa un servidor de cuentas falso.
  const fakeAuth = new URLSearchParams(location.search).get("authurl");
  if (fakeAuth) window.AUTH_CONFIG = { url: fakeAuth, anonKey: "clave-de-prueba" };
}
