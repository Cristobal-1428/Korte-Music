// URL de la API. En local apunta al backend de desarrollo; en producción (Vercel)
// reemplaza PRODUCTION_API por la URL pública del backend (p. ej. https://korte-music-api.onrender.com).
const PRODUCTION_API = "https://CAMBIA-ESTO.onrender.com";
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
window.API_URL = isLocal ? "http://127.0.0.1:8001" : PRODUCTION_API;
