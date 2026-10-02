const API_URL = window.API_URL; // definida en config.js

const $ = (id) => document.getElementById(id);
const view = $("view");
const main = document.querySelector(".main");
const libraryList = $("library-list");
const statusEl = $("status");
const search = $("search");
const audio = $("audio");
const playBtn = $("play");
const seek = $("seek");

const dialog = $("upload-dialog");
const form = $("upload-form");
const uploadStatus = $("upload-status");
const submitBtn = $("submit-upload");

// Cambia el dibujo de un botón que usa un ícono del sprite (#i-nombre) del HTML.
function setIcon(btn, name) {
  btn.querySelector("use").setAttribute("href", `#i-${name}`);
}

const isMobile = window.matchMedia("(max-width: 800px)");

let songs = []; // canciones públicas
let privateSongs = []; // canciones privadas: solo llegan con la clave de administrador
let privateToken = null; // permiso temporal para escucharlas (lo entrega /admin/session)
let currentId = null; // canción cargada en el reproductor
let detailId = null; // canción abierta en la vista de detalle
const durations = new Map(); // id -> segundos (la BD no guarda la duración)

/* ---------- Utilidades ---------- */

// Tono estable a partir del título: la BD no guarda portadas.
function hue(song) {
  let h = 0;
  for (const ch of song.title + song.artist) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function coverUrl(song) {
  const base = `${API_URL}/songs/${song.id}/cover`;
  return song.is_private ? `${base}?t=${encodeURIComponent(privateToken || "")}` : base;
}

// Con portada subida, la imagen se recorta sola para llenar el cuadro; el degradado queda de fondo mientras carga.
function coverStyle(song) {
  const h = hue(song);
  const gradient = `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 70% 25%))`;
  return song.has_cover
    ? `background: url("${coverUrl(song)}") center / cover no-repeat, ${gradient}`
    : `background: ${gradient}`;
}

function initial(song) {
  if (song.has_cover) return "";
  return song.title.trim().charAt(0).toUpperCase() || "♪";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent evita inyección HTML
  return node;
}

function streamUrl(song) {
  const base = `${API_URL}/songs/${song.id}/stream`;
  return song.is_private ? `${base}?t=${encodeURIComponent(privateToken || "")}` : base;
}

const findSong = (id) => songs.find((s) => s.id === id) || privateSongs.find((s) => s.id === id);

// Lee la duración pidiendo solo los metadatos (el servidor responde con Range).
function loadDuration(song, onReady) {
  if (durations.has(song.id)) return onReady(durations.get(song.id));
  const probe = new Audio();
  probe.preload = "metadata";
  probe.addEventListener("loadedmetadata", () => {
    durations.set(song.id, probe.duration);
    onReady(probe.duration);
  });
  probe.src = streamUrl(song);
}

/* ---------- Carga y rutas ---------- */

async function loadSongs() {
  await refreshAdminSession();
  const res = await fetch(`${API_URL}/songs`, { headers: privateToken ? authHeaders() : {} });
  if (!res.ok) throw new Error("No se pudo cargar la biblioteca");
  const all = await res.json();
  songs = all.filter((s) => !s.is_private);
  privateSongs = all.filter((s) => s.is_private);
  renderLibrary();
  route();
}

function authHeaders() {
  const key = pref.get("admin-key", "");
  return key ? { "X-Admin-Key": key } : {};
}

// Con la clave guardada pide el permiso para las canciones privadas; si la clave ya no sirve, la olvida.
async function refreshAdminSession() {
  privateToken = null;
  if (!pref.get("admin-key", "")) return;
  try {
    const res = await fetch(`${API_URL}/admin/session`, { headers: authHeaders() });
    if (res.ok) privateToken = (await res.json()).token;
    else if (res.status === 401) pref.set("admin-key", "");
  } catch { /* sin conexión: se reintenta en la próxima carga */ }
}

// fetch para las acciones de administrador (subir y borrar). Si el servidor pide la clave, la pregunta una vez
// y la recuerda en este navegador; si resulta incorrecta, la olvida para volver a preguntar la próxima vez.
async function adminFetch(url, options = {}) {
  const send = () => fetch(url, { ...options, headers: { ...options.headers, ...authHeaders() } });
  let res = await send();
  if (res.status === 401) {
    const key = prompt("Clave de administrador:");
    if (!key) return res;
    pref.set("admin-key", key);
    res = await send();
    if (res.status === 401) pref.set("admin-key", "");
  }
  return res;
}

// Detiene la reproducción y deja el reproductor vacío.
function resetPlayer() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  currentId = null;
  document.body.classList.add("no-track");
  setMediaMetadata(null);
  $("np-title").textContent = "Nada en reproducción";
  $("np-artist").innerHTML = "&nbsp;";
  $("np-cover").textContent = "";
  $("np-cover").style.cssText = "";
  $("time-dur").textContent = "0:00";
}

/* ---------- Menú ⋮ de cada canción (editar / eliminar) ---------- */

const songMenu = $("song-menu");
let menuSong = null;

function closeSongMenu() {
  songMenu.hidden = true;
  menuSong = null;
}

function menuButton(song, className) {
  const btn = el("button", className, "⋮");
  btn.type = "button";
  btn.title = "Más opciones";
  btn.setAttribute("aria-label", `Opciones de ${song.title}`);
  btn.setAttribute("aria-haspopup", "menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // no abrir el detalle ni reproducir
    if (menuSong === song && !songMenu.hidden) return closeSongMenu();
    menuSong = song;
    songMenu.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = songMenu.offsetWidth;
    const h = songMenu.offsetHeight;
    songMenu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    songMenu.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  });
  return btn;
}

document.addEventListener("click", (e) => { if (!songMenu.contains(e.target)) closeSongMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSongMenu(); });
addEventListener("scroll", closeSongMenu, true);
addEventListener("resize", closeSongMenu);
$("menu-delete").addEventListener("click", () => {
  const song = menuSong;
  closeSongMenu();
  if (song) deleteSong(song);
});
$("menu-edit").addEventListener("click", () => {
  const song = menuSong;
  closeSongMenu();
  if (song) openEdit(song);
});

const editDialog = $("edit-dialog");
const editForm = $("edit-form");
const editStatus = $("edit-status");
let editingSong = null;

function openEdit(song) {
  editingSong = song;
  editForm.reset();
  editForm.elements.title.value = song.title;
  editForm.elements.artist.value = song.artist;
  $("edit-remove-wrap").hidden = !song.has_cover;
  editStatus.textContent = "";
  editStatus.className = "";
  editDialog.showModal();
}
$("cancel-edit").addEventListener("click", () => editDialog.close());

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const song = editingSong;
  const submit = $("submit-edit");
  submit.disabled = true;
  editStatus.className = "";
  editStatus.textContent = "Guardando...";
  try {
    const body = new FormData(editForm);
    const coverFile = editForm.elements.cover.files[0];
    body.delete("cover");
    if (coverFile) {
      try {
        body.append("cover", await squareCover(coverFile), "cover.jpg");
      } catch {
        throw new Error("No se pudo leer la imagen de portada");
      }
    }
    const res = await adminFetch(`${API_URL}/songs/${song.id}`, { method: "PATCH", body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : "No se pudo guardar");
    }
    editDialog.close();
    await loadSongs();
    if (currentId === song.id && findSong(song.id)) {
      showInPlayer(findSong(song.id));
      syncNowPlaying();
    }
  } catch (e) {
    editStatus.className = "error";
    editStatus.textContent = e.message;
  } finally {
    submit.disabled = false;
  }
});

// Borra la canción (fila y audio).
async function deleteSong(song) {
  if (!confirm(`¿Eliminar "${song.title}" de ${song.artist}? Esta acción no se puede deshacer.`)) return;
  try {
    const res = await adminFetch(`${API_URL}/songs/${song.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || "No se pudo eliminar la canción");
    }
  } catch (e) {
    alert(e.message);
    return;
  }

  durations.delete(song.id);
  if (currentId === song.id) resetPlayer();
  if (location.hash === `#/song/${song.id}`) location.hash = ""; // sale del detalle de la canción borrada
  await loadSongs().catch((e) => alert(e.message));
  updatePlayState();
}

function visibleSongs() {
  const q = search.value.trim().toLowerCase();
  if (!q) return songs;
  return songs.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q));
}

let firstRoute = true;

function route() {
  if (firstRoute) {
    // Al abrir el link siempre se ve el inicio, aunque la dirección traiga una canción (#/song/…).
    // Dentro de la página, tocar una canción sí navega a ella.
    firstRoute = false;
    if (location.hash.startsWith("#/song/")) history.replaceState(null, "", location.pathname + location.search + "#/");
  }
  if (location.hash === "#/private") return showPrivate();
  const match = location.hash.match(/^#\/song\/(\d+)$/);
  const song = match && songs.find((s) => s.id === Number(match[1]));
  if (song && isMobile.matches) {
    // En el celular, el link de una canción abre la pantalla de reproducción (no la página del vinilo).
    history.replaceState(null, "", "#/"); // al cerrar la pantalla se queda en el inicio, sin links viejos
    showHome();
    if (currentId !== song.id) playSong(song.id); // si el navegador bloquea el autoplay, queda lista para dar play
    openNowPlaying();
  } else if (song) showDetail(song);
  else showHome();
}
window.addEventListener("hashchange", route);

let lastOpen = { id: null, t: 0 };

function openSong(id) {
  lastOpen = { id, t: performance.now() };
  location.hash = `#/song/${id}`;
}

// Doble clic sobre una canción: se reproduce. El primer clic ya abrió el detalle y cambió la pantalla,
// así que el doble clic puede caer sobre otro elemento; por eso se escucha en el documento
// y se asocia a la última canción abierta hace un instante.
document.addEventListener("dblclick", () => {
  if (lastOpen.id !== null && performance.now() - lastOpen.t < 600) {
    playSong(lastOpen.id);
    lastOpen = { id: null, t: 0 };
  }
});

/* ---------- Componentes ---------- */

function makeCard(song) {
  const card = el("article", "card");
  card.dataset.id = song.id;
  const cover = el("div", "card-cover", initial(song));
  cover.style.cssText = coverStyle(song);
  const play = el("button", "card-play", "▶");
  play.setAttribute("aria-label", `Reproducir ${song.title}`);
  play.addEventListener("click", (e) => {
    e.stopPropagation(); // el botón reproduce; el resto de la tarjeta abre el detalle
    playSong(song.id);
  });
  cover.append(play);
  card.append(cover, el("div", "card-title", song.title), el("div", "card-artist", song.artist));
  card.addEventListener("click", () => openSong(song.id));
  return card;
}

function renderLibrary() {
  libraryList.replaceChildren();
  const list = visibleSongs();
  if (list.length === 0) {
    libraryList.append(el("li", "empty", songs.length ? "Sin resultados." : "Aún no hay canciones."));
    return;
  }
  for (const song of list) {
    const li = el("li");
    li.dataset.id = song.id;
    const cover = el("div", "li-cover", initial(song));
    cover.style.cssText = coverStyle(song);
    const text = el("div", "li-text");
    text.append(el("span", "li-title", song.title), el("span", "li-artist", song.artist));
    li.append(cover, text, menuButton(song, "li-delete"));
    li.addEventListener("click", () => openSong(song.id));
    libraryList.append(li);
  }
  markActive();
}

/* ---------- Vista: inicio (bandeja de discos) ---------- */

let stageCanvas = null; // canvas de fondo de la vista abierta (null si no hay ninguna con visualizador)
let vinylWrap = null; // vinilo del detalle, que late con los graves
let homeStage = null; // contenedor del inicio: recibe --pulse para el disco del centro
let deck = null; // estado de la bandeja: { list, recs, index, stage, title, artist }

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "Buenas noches";
  if (h < 13) return "Buenos días";
  if (h < 20) return "Buenas tardes";
  return "Buenas noches";
}

// Un disco: funda al frente y vinilo detrás, que asoma cuando el disco está en el centro.
function makeRecord(song) {
  const sleeve = el("div", "rec-sleeve", initial(song));
  sleeve.style.cssText = coverStyle(song);
  const label = el("div", "rec-label");
  label.style.cssText = coverStyle(song);
  const disc = el("div", "rec-disc");
  disc.append(label);
  const vinyl = el("div", "rec-vinyl");
  vinyl.append(disc);
  const inner = el("div", "rec-inner");
  inner.append(vinyl, sleeve);
  const rec = el("div", "rec");
  rec.dataset.id = song.id;
  rec.append(inner);
  return rec;
}

// Coloca cada disco según su distancia al del centro (efecto "cover flow" en 3D).
function layoutDeck() {
  const { list, recs, index } = deck;
  const fade = [1, 0.92, 0.65, 0.35];
  recs.forEach((rec, i) => {
    const d = i - index;
    const a = Math.abs(d);
    const s = Math.sign(d);
    rec.style.setProperty("--x", d === 0 ? -0.18 : s * (1 + (a - 1) * 0.32));
    rec.style.setProperty("--z", d === 0 ? 0 : -0.35 - (a - 1) * 0.15);
    rec.style.setProperty("--ry", d === 0 ? 0 : -s * 48);
    rec.style.setProperty("--sc", d === 0 ? 1 : 0.9 - (a - 1) * 0.05);
    rec.style.opacity = a > 3 ? 0 : fade[a];
    rec.style.zIndex = 50 - a;
    rec.style.pointerEvents = a > 3 ? "none" : "auto";
    rec.classList.toggle("active", d === 0);
  });
  const song = list[index];
  deck.title.textContent = song.title;
  deck.artist.textContent = song.artist;
  deck.stage.style.setProperty("--h", hue(song));
  main.style.setProperty("--tint", `hsl(${hue(song)} 55% 20%)`);
  updatePlayState();
}

function deckGo(i) {
  if (!deck) return;
  deck.index = Math.max(0, Math.min(deck.list.length - 1, i));
  layoutDeck();
}

function showHome() {
  detailId = null;
  vinylWrap = null;
  deck = null;
  homeStage = null;
  stageCanvas = null;
  $("nav-home").classList.add("active");
  $("tab-home").classList.add("active");
  $("nav-private").classList.remove("active");
  $("tab-private").classList.remove("active");

  const list = visibleSongs();
  if (isMobile.matches && list.length) return showMobileHome(list);
  if (list.length === 0) {
    main.style.removeProperty("--tint");
    syncViz();
    const box = el("div", "empty-home");
    box.append(
      el("h1", "", songs.length ? "Sin resultados" : "Tu bandeja está vacía"),
      el("p", "empty", songs.length ? "Prueba con otra búsqueda." : "Sube tu primera canción para empezar."),
    );
    if (!songs.length) {
      const add = el("button", "big-play", "＋ Subir canción");
      add.addEventListener("click", openUpload);
      box.append(add);
    }
    view.replaceChildren(box);
    return;
  }

  // Cabecera: saludo y controles del visualizador de fondo.
  const hello = el("div", "home-hello");
  const helloStats = el("p", "");
  const helloPlays = el("span", "");
  helloPlays.dataset.playsTotal = "";
  helloStats.append(`${songs.length} ${songs.length === 1 ? "canción" : "canciones"} en tu biblioteca · `, helloPlays);
  hello.append(el("h1", "", greeting()), helloStats);
  const modes = el("div", "viz-modes");
  const palettes = el("div", "viz-palettes");
  fillVizControls(modes, palettes);
  const controls = el("div", "stage-viz");
  controls.append(modes, palettes);
  const head = el("div", "home-head");
  head.append(hello, controls);

  // Bandeja
  const track = el("div", "deck");
  const recs = list.map(makeRecord);
  track.append(...recs);

  // Información del disco elegido
  const title = el("h2", "stage-title deck-title");
  const artist = el("div", "stage-artist");
  const bigPlay = el("button", "big-play");
  bigPlay.id = "big-play";
  const shuffle = el("button", "viz-chip");
  shuffle.innerHTML = '<svg class="ic ic-sm"><use href="#i-shuffle"/></svg> Aleatorio';
  const detail = el("button", "viz-chip", "Ver detalle");
  shuffle.type = detail.type = "button";
  const actions = el("div", "actions");
  actions.append(bigPlay, shuffle, detail);
  const info = el("div", "deck-info");
  info.append(el("span", "stage-kind", "En la bandeja"), title, artist, actions);

  const content = el("div", "home-content");
  content.append(head, track, info);
  const canvas = el("canvas", "stage-canvas");
  const stage = el("section", "stage home-stage");
  stage.append(canvas, el("div", "stage-scrim"), content);
  view.replaceChildren(stage);
  refreshVizControls();

  const current = list.findIndex((s) => s.id === currentId);
  deck = { list, recs, index: current >= 0 ? current : 0, stage, title, artist, dragged: false };
  homeStage = stage;

  // Interacción: clic (centra o abre), arrastre, rueda y botones.
  recs.forEach((rec, i) =>
    rec.addEventListener("click", () => {
      if (deck.dragged) return;
      if (i === deck.index) openSong(list[i].id);
      else deckGo(i);
    }),
  );
  let startX = null;
  track.addEventListener("pointerdown", (e) => { startX = e.clientX; });
  track.addEventListener("pointerup", (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) {
      deck.dragged = true; // evita que el arrastre cuente como clic
      setTimeout(() => { if (deck) deck.dragged = false; }, 60);
      deckGo(deck.index + (dx < 0 ? 1 : -1));
    }
  });
  let wheelLock = false;
  track.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (wheelLock) return;
    wheelLock = true;
    setTimeout(() => (wheelLock = false), 180);
    deckGo(deck.index + Math.sign(e.deltaY || e.deltaX));
  }, { passive: false });

  bigPlay.addEventListener("click", () => {
    const song = deck.list[deck.index];
    if (currentId === song.id) togglePlay();
    else playSong(song.id);
  });
  detail.addEventListener("click", () => openSong(deck.list[deck.index].id));
  shuffle.addEventListener("click", () => {
    const others = songs.filter((s) => s.id !== currentId);
    const pool = others.length ? others : songs;
    playSong(pool[Math.floor(Math.random() * pool.length)].id);
  });

  layoutDeck();
  refreshPlays();
  stageCanvas = canvas;
  main.scrollTop = 0;
  markActive();
  syncViz();
}

/* ---------- Vista: inicio en el celular ---------- */

function playsText(n) {
  return `${n} ${n === 1 ? "reproducción" : "reproducciones"}`;
}

// Cada elemento con data-plays-for muestra el contador de esa canción; data-plays-total, el de toda la biblioteca.
function refreshPlays() {
  document.querySelectorAll("[data-plays-for]").forEach((node) => {
    const song = findSong(Number(node.dataset.playsFor));
    if (song) node.textContent = node.dataset.prefix ? `${node.dataset.prefix}${playsText(song.plays)}` : playsText(song.plays);
  });
  document.querySelectorAll("[data-plays-total]").forEach((node) => {
    node.textContent = playsText(songs.reduce((sum, s) => sum + s.plays, 0));
  });
  syncNowPlaying();
}

// Fila compacta: toca para reproducir; › abre el detalle y ⋮ abre editar / eliminar.
function makeRow(song, withDetail = true) {
  const cover = el("div", "m-cover", initial(song));
  cover.style.cssText = coverStyle(song);
  const meta = el("div", "m-meta");
  const sub = el("span", "m-sub");
  sub.append(`${song.artist} · `);
  const plays = el("span", "");
  plays.dataset.playsFor = song.id;
  plays.textContent = playsText(song.plays);
  sub.append(plays);
  meta.append(el("span", "m-title", song.title), sub);

  const detail = el("button", "m-btn", "›");
  detail.type = "button";
  detail.setAttribute("aria-label", `Ver detalle de ${song.title}`);
  detail.addEventListener("click", (e) => { e.stopPropagation(); openSong(song.id); });

  const row = el("div", "m-row");
  row.dataset.id = song.id;
  row.append(cover, meta, ...(withDetail ? [detail] : []), menuButton(song, "m-btn m-del"));
  row.addEventListener("click", () => (currentId === song.id ? togglePlay() : playSong(song.id)));
  return row;
}

// Tarjeta pequeña para el carrusel horizontal.
function makeMiniCard(song) {
  const cover = el("div", "m-card-cover", initial(song));
  cover.style.cssText = coverStyle(song);
  const card = el("div", "m-card");
  card.dataset.id = song.id;
  card.append(cover, el("div", "m-card-title", song.title), el("div", "m-card-artist", song.artist));
  card.addEventListener("click", () => (currentId === song.id ? togglePlay() : playSong(song.id)));
  return card;
}

function showMobileHome(list) {
  main.style.setProperty("--tint", "hsl(350 55% 18%)");
  syncViz(); // sin escenario no hay visualizador de fondo

  const hero = el("section", "m-hero");
  // Icono + texto en vez de logo.png: ese PNG trae fondo oscuro propio y se nota sobre el degradado.
  const mark = el("img", "m-mark");
  mark.src = "assets/logo-icon.svg";
  mark.alt = "";
  const logo = el("div", "m-logo");
  logo.append(mark, "Korte ", el("span", "m-korte", "Music"));
  const stats = el("p", "m-stats");
  const total = el("span", "");
  total.dataset.playsTotal = "";
  stats.append(`${songs.length} ${songs.length === 1 ? "canción" : "canciones"} · `, total);
  const title = el("h1", "m-welcome");
  title.append("Bienvenido", el("br"), "A darle el ", el("span", "m-korte", "korte"));
  const playAll = el("button", "big-play", "▶ Reproducir todo");
  const shuffle = el("button", "viz-chip");
  shuffle.innerHTML = '<svg class="ic ic-sm"><use href="#i-shuffle"/></svg> Aleatorio';
  playAll.type = shuffle.type = "button";
  playAll.addEventListener("click", () => playSong(list[0].id));
  shuffle.addEventListener("click", () => playSong(list[Math.floor(Math.random() * list.length)].id));
  const actions = el("div", "actions");
  actions.append(playAll, shuffle);
  hero.append(logo, title, stats, actions);

  view.replaceChildren(hero);

  // Carrusel: lo más escuchado (o lo más reciente si todavía nadie reproduce nada).
  const popular = [...list].sort((a, b) => b.plays - a.plays).filter((s) => s.plays > 0).slice(0, 8);
  const strip = popular.length ? popular : list.slice(0, 8);
  const carousel = el("div", "m-carousel");
  carousel.append(...strip.map(makeMiniCard));
  view.append(el("h2", "m-section", popular.length ? "Lo más escuchado" : "Recién subidas"), carousel);

  const rows = el("div", "m-rows");
  rows.append(...list.map(makeRow));
  view.append(el("h2", "m-section", "Tus canciones"), rows);

  main.scrollTop = 0;
  refreshPlays();
  markActive();
  updatePlayState();
}

// Al girar el teléfono o cambiar el ancho, la vista se rehace con el diseño que corresponda.
isMobile.addEventListener("change", () => route());

/* ---------- Sección privada ---------- */

function showPrivate() {
  detailId = null;
  vinylWrap = null;
  deck = null;
  homeStage = null;
  stageCanvas = null;
  main.style.setProperty("--tint", "hsl(260 30% 16%)");
  syncViz();
  $("nav-home").classList.remove("active");
  $("tab-home").classList.remove("active");
  $("nav-private").classList.add("active");
  $("tab-private").classList.add("active");
  view.replaceChildren(privateToken ? privateList() : privateLock());
  main.scrollTop = 0;
  markActive();
  updatePlayState();
}

// Pantalla del candado: pide la clave. Sin ella no se llega a ninguna canción privada.
function privateLock() {
  const icon = el("div", "priv-icon");
  icon.innerHTML = '<svg class="ic"><use href="#i-lock"/></svg>';
  const input = el("input");
  input.type = "password";
  input.placeholder = "Clave de administrador";
  input.autocomplete = "current-password";
  input.required = true;
  const enter = el("button", "big-play", "Entrar");
  enter.type = "submit";
  const msg = el("p", "priv-msg");
  msg.setAttribute("role", "status");
  const form = el("form", "priv-form");
  form.append(input, enter);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    enter.disabled = true;
    msg.className = "priv-msg";
    msg.textContent = "Comprobando…";
    pref.set("admin-key", input.value);
    await refreshAdminSession(); // si la clave es mala, la olvida
    enter.disabled = false;
    if (!privateToken) {
      msg.className = "priv-msg error";
      msg.textContent = "Clave incorrecta.";
      input.select();
      return;
    }
    await loadSongs().catch((err) => alert(err.message)); // trae las privadas y vuelve a dibujar esta vista
  });
  const box = el("section", "priv-lock");
  box.append(icon, el("h1", "", "Sección privada"), el("p", "empty", "Escribe la clave para ver tu música privada."), form, msg);
  return box;
}

function privateList() {
  const add = el("button", "big-play", "＋ Subir canción privada");
  add.type = "button";
  add.addEventListener("click", () => openUpload(null, true));
  const out = el("button", "viz-chip", "Cerrar sesión privada");
  out.type = "button";
  out.addEventListener("click", lockPrivate);
  const actions = el("div", "actions");
  actions.append(add, out);

  const box = el("section", "priv-list");
  box.append(
    el("h1", "page-title", "Privado"),
    el("p", "m-stats", `${privateSongs.length} ${privateSongs.length === 1 ? "canción privada" : "canciones privadas"} · solo tú las ves`),
    actions,
  );
  if (privateSongs.length === 0) {
    box.append(el("p", "empty", "Aún no hay canciones privadas."));
  } else {
    const rows = el("div", "m-rows");
    rows.append(...privateSongs.map((s) => makeRow(s, false)));
    box.append(rows);
  }
  return box;
}

// Olvida la clave en este navegador y vuelve al inicio.
function lockPrivate() {
  pref.set("admin-key", "");
  privateToken = null;
  if (privateSongs.some((s) => s.id === currentId)) resetPlayer(); // si sonaba una privada, se detiene
  privateSongs = [];
  location.hash = "#/";
}

/* ---------- Vista: detalle de canción (escenario) ---------- */

function showDetail(song) {
  detailId = song.id;
  deck = null;
  homeStage = null;
  $("nav-home").classList.remove("active");
  $("tab-home").classList.remove("active");
  $("nav-private").classList.remove("active");
  $("tab-private").classList.remove("active");
  const h = hue(song);
  main.style.setProperty("--tint", `hsl(${h} 55% 20%)`);

  // Vinilo con la portada como etiqueta.
  const label = el("div", "vinyl-label");
  label.style.cssText = coverStyle(song);
  label.append(el("span", "", initial(song)));
  const vinyl = el("div", "vinyl");
  vinyl.id = "vinyl";
  vinyl.append(label);
  const wrap = el("div", "vinyl-wrap");
  wrap.append(vinyl);

  // Datos
  const durChip = el("span", "chip", "⏱ –:––");
  const playsChip = el("span", "chip");
  playsChip.dataset.playsFor = song.id;
  playsChip.dataset.prefix = "▶ ";
  const chips = el("div", "chips");
  chips.append(
    el("span", "chip", String(new Date(song.created_at).getFullYear())),
    durChip,
    playsChip,
    el("span", "chip", `Subida el ${formatDate(song.created_at)}`),
  );

  // Acciones
  const bigPlay = el("button", "big-play");
  bigPlay.id = "big-play";
  bigPlay.addEventListener("click", () => {
    if (currentId === song.id) togglePlay();
    else playSong(song.id);
  });
  const full = el("button", "viz-chip", "⛶ Pantalla completa");
  full.type = "button";
  full.addEventListener("click", () => {
    openViz();
    viz.requestFullscreen?.().catch(() => {}); // si el navegador lo rechaza, queda el visualizador normal
  });
  const actions = el("div", "actions");
  actions.append(bigPlay, full);

  // Modelo y colores del visualizador de fondo.
  const modes = el("div", "viz-modes");
  const palettes = el("div", "viz-palettes");
  fillVizControls(modes, palettes);
  const controls = el("div", "stage-viz");
  controls.append(modes, palettes);

  const info = el("div", "stage-info");
  info.append(
    el("span", "stage-kind", "Canción"),
    el("h1", "stage-title", song.title),
    el("div", "stage-artist", song.artist),
    chips,
    actions,
    controls,
  );
  const content = el("div", "stage-content");
  content.append(wrap, info);

  const canvas = el("canvas", "stage-canvas");
  const stage = el("section", "stage");
  stage.style.setProperty("--h", h);
  stage.append(canvas, el("div", "stage-scrim"), content);
  view.replaceChildren(stage);
  refreshVizControls(); // los botones ya están en la página: marca el modelo y la paleta activos

  // Más del mismo artista
  const more = songs.filter((s) => s.artist === song.artist && s.id !== song.id);
  if (more.length) {
    const grid = el("section", "grid");
    more.forEach((s) => grid.append(makeCard(s)));
    view.append(el("h2", "section-title", `Más de ${song.artist}`), grid);
  }

  refreshPlays();
  loadDuration(song, (secs) => {
    if (detailId !== song.id) return; // el usuario ya navegó a otra vista
    durChip.textContent = `⏱ ${formatTime(secs)}`;
  });

  stageCanvas = canvas;
  vinylWrap = wrap;
  main.scrollTop = 0;
  markActive();
  updatePlayState();
  syncViz();
}

/* ---------- Estado activo / play ---------- */

function markActive() {
  document.querySelectorAll(".card, #library-list li, .m-row, .m-card").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.id) === currentId);
  });
}

function updatePlayState() {
  setIcon(playBtn, audio.paused ? "play" : "pause");
  syncMediaState();
  syncNowPlaying();
  // La canción "en pantalla" es la del disco central (inicio) o la del detalle.
  const shownId = deck ? deck.list[deck.index].id : detailId;
  const playingHere = currentId === shownId && !audio.paused;
  const big = $("big-play");
  if (big) big.innerHTML = `<svg class="ic fill ic-sm"><use href="#i-${playingHere ? "pause" : "play"}"/></svg> ${playingHere ? "Pausar" : "Reproducir"}`;
  $("vinyl")?.classList.toggle("playing", playingHere);
  document.querySelectorAll(".rec").forEach((r) => {
    r.classList.toggle("playing", Number(r.dataset.id) === currentId && !audio.paused);
  });
}

/* ---------- Reproductor ---------- */

// Conecta el analizador (necesita un gesto del usuario) y reproduce.
function startPlayback() {
  Visualizer.attach(audio);
  audio.play().catch(() => {});
}

function togglePlay() {
  if (audio.paused) startPlayback();
  else audio.pause();
}

function playSong(id) {
  const song = findSong(id);
  if (!song) return;
  currentId = id;
  document.body.classList.remove("no-track");
  listened = 0;
  lastTime = 0;
  playCounted = false;
  if (deck) deckGo(deck.list.findIndex((s) => s.id === id)); // la bandeja sigue a la canción que suena
  // El <audio> pide fragmentos con la cabecera Range automáticamente.
  audio.src = streamUrl(song);
  startPlayback();

  showInPlayer(song);
  markActive();
  updatePlayState();
}

// Pinta título, artista y portada de la canción cargada en la barra, el visualizador y la notificación.
function showInPlayer(song) {
  $("np-title").textContent = song.title;
  $("np-artist").textContent = song.artist;
  $("viz-title").textContent = song.title;
  $("viz-artist").textContent = song.artist;
  const cover = $("np-cover");
  cover.textContent = initial(song);
  cover.style.cssText = coverStyle(song);
  artCache.delete(song.id);
  setMediaMetadata(song);
}

function step(delta) {
  // La cola es la sección de la canción que suena: escuchar privadas no mezcla las públicas.
  const list = privateSongs.some((s) => s.id === currentId) ? privateSongs : songs;
  if (list.length === 0) return;
  if (shuffleOn && delta > 0 && list.length > 1) {
    const others = list.filter((s) => s.id !== currentId);
    return playSong(others[Math.floor(Math.random() * others.length)].id);
  }
  const i = list.findIndex((s) => s.id === currentId);
  playSong(list[(i + delta + list.length) % list.length].id);
}

playBtn.addEventListener("click", () => {
  if (currentId === null) {
    if (songs.length) playSong(songs[0].id);
    return;
  }
  togglePlay();
});
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));

audio.addEventListener("play", updatePlayState);
audio.addEventListener("pause", updatePlayState);
audio.addEventListener("ended", () => {
  if (!repeatOne) return step(1);
  audio.currentTime = 0; // repetir la misma canción: vuelve a contar como una reproducción nueva
  listened = 0;
  lastTime = 0;
  playCounted = false;
  audio.play().catch(() => {});
});
audio.addEventListener("loadedmetadata", () => ($("time-dur").textContent = formatTime(audio.duration)));

/* ---------- Notificación y pantalla de bloqueo (Media Session) ---------- */
// Le cuenta al teléfono qué suena para que la notificación y la pantalla de bloqueo muestren título,
// artista y portada, con anterior / pausa / siguiente y la barra de tiempo (como YouTube Music).
// Los botones "me gusta" y "aleatorio" de esas notificaciones no existen para páginas web.

const hasMediaSession = "mediaSession" in navigator;
const artCache = new Map(); // id de canción -> portada como imagen (data URL)

// La base de datos no guarda imágenes: la portada se dibuja con los mismos colores que se ven en la app.
function coverArt(song) {
  if (artCache.has(song.id)) return artCache.get(song.id);
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const h = hue(song);
  const gradient = g.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, `hsl(${h} 70% 45%)`);
  gradient.addColorStop(1, `hsl(${(h + 50) % 360} 70% 25%)`);
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#fff";
  g.font = "800 260px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgb(0 0 0 / 0.35)";
  g.shadowBlur = 24;
  g.fillText(initial(song), size / 2, size / 2 + 12);
  const url = canvas.toDataURL("image/png");
  artCache.set(song.id, url);
  return url;
}

function setMediaMetadata(song) {
  if (!hasMediaSession) return;
  navigator.mediaSession.metadata = song
    ? new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: "Korte Music",
        artwork: [song.has_cover ? { src: coverUrl(song), sizes: "600x600" } : { src: coverArt(song), sizes: "512x512", type: "image/png" }],
      })
    : null;
}

function syncMediaState() {
  if (!hasMediaSession) return;
  navigator.mediaSession.playbackState = currentId === null ? "none" : audio.paused ? "paused" : "playing";
}

let lastMediaPos = -1;
function syncMediaPosition(force) {
  if (!hasMediaSession || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const pos = Math.floor(audio.currentTime);
  if (!force && pos === lastMediaPos) return; // una vez por segundo basta
  lastMediaPos = pos;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* algunos navegadores rechazan valores fuera de rango mientras carga */ }
}
for (const ev of ["loadedmetadata", "timeupdate", "seeked", "play", "pause"]) {
  audio.addEventListener(ev, () => syncMediaPosition(ev !== "timeupdate"));
}

if (hasMediaSession) {
  const handle = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* acción no soportada */ }
  };
  handle("play", () => startPlayback());
  handle("pause", () => audio.pause());
  handle("previoustrack", () => step(-1));
  handle("nexttrack", () => step(1));
  handle("seekto", (d) => {
    if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(d.seekTime, audio.duration);
  });
}

// Cuenta una reproducción cuando se han escuchado 10 s de verdad (o la mitad, si la canción es más corta).
// Se suman solo avances normales: saltar la barra de progreso no cuenta como escuchar.
let listened = 0;
let lastTime = 0;
let playCounted = false;

async function countPlay(id) {
  try {
    const res = await fetch(`${API_URL}/songs/${id}/play`, { method: "POST", headers: authHeaders() });
    if (!res.ok) return;
    const song = findSong(id);
    if (song) song.plays = (await res.json()).plays;
    refreshPlays();
  } catch { /* el contador es secundario: si falla, no molesta */ }
}

audio.addEventListener("timeupdate", () => {
  const delta = audio.currentTime - lastTime;
  lastTime = audio.currentTime;
  if (!audio.paused && delta > 0 && delta < 1.5) listened += delta;
  if (!playCounted && currentId !== null && listened >= Math.min(10, (audio.duration || 20) / 2)) {
    playCounted = true;
    countPlay(currentId);
  }
  $("time-cur").textContent = formatTime(audio.currentTime);
  if (!seeking && audio.duration) seek.value = (audio.currentTime / audio.duration) * 100;
});

let seeking = false;
seek.addEventListener("input", () => {
  seeking = true;
  if (audio.duration) $("time-cur").textContent = formatTime((seek.value / 100) * audio.duration);
});
seek.addEventListener("change", () => {
  if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
  seeking = false;
});

$("volume").addEventListener("input", (e) => (audio.volume = Number(e.target.value)));


/* ---------- Visualizador ---------- */

const viz = $("viz");

// Sin visualizador (iPhone/iPad): se esconden sus botones para que la música siga sonando en segundo plano.
if (!Visualizer.supported) document.documentElement.classList.add("no-viz");

// Guarda la elección entre visitas; si el navegador bloquea localStorage, se ignora.
const pref = {
  get(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* sin almacenamiento */ }
  },
};

function paletteBackground(p) {
  if (!p.hues) return "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)";
  return `linear-gradient(135deg, hsl(${p.hues[0]} 90% 55%) 50%, hsl(${p.hues[1]} 90% 55%) 50%)`;
}

// Los controles existen en dos sitios (escenario y pantalla completa); se refrescan juntos.
function refreshVizControls() {
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === Visualizer.mode));
  document.querySelectorAll("[data-palette]").forEach((b) => b.classList.toggle("active", b.dataset.palette === Visualizer.palette));
}

function fillVizControls(modesEl, palettesEl) {
  for (const m of Visualizer.modes) {
    const b = el("button", "viz-chip", m.label);
    b.type = "button";
    b.dataset.mode = m.id;
    b.addEventListener("click", () => chooseMode(m.id));
    modesEl.append(b);
  }
  for (const p of Visualizer.palettes) {
    const b = el("button", "viz-swatch");
    b.type = "button";
    b.dataset.palette = p.id;
    b.title = p.label;
    b.setAttribute("aria-label", `Paleta ${p.label}`);
    b.style.background = paletteBackground(p);
    b.addEventListener("click", () => choosePalette(p.id));
    palettesEl.append(b);
  }
  refreshVizControls();
}

function chooseMode(id) {
  Visualizer.setMode(id);
  pref.set("viz-mode", Visualizer.mode);
  refreshVizControls();
}

function choosePalette(id) {
  Visualizer.setPalette(id);
  pref.set("viz-palette", Visualizer.palette);
  refreshVizControls();
}

Visualizer.setMode(pref.get("viz-mode", Visualizer.mode));
Visualizer.setPalette(pref.get("viz-palette", Visualizer.palette));
fillVizControls($("viz-modes"), $("viz-palettes"));

// El visualizador dibuja en un solo canvas a la vez: la pantalla completa si está abierta,
// si no el escenario de la canción, y si tampoco hay escenario, se detiene.
function syncViz() {
  if (!viz.hidden) Visualizer.start($("viz-canvas"));
  else if (stageCanvas) Visualizer.start(stageCanvas);
  else Visualizer.stop();
}

function openViz() {
  viz.hidden = false; // el canvas necesita tamaño antes de iniciar
  Visualizer.attach(audio);
  syncViz();
}

function closeViz() {
  if (document.fullscreenElement) document.exitFullscreen();
  viz.hidden = true;
  syncViz();
}

// El vinilo late con los graves y el golpe del ritmo.
Visualizer.onFrame = (g) => {
  const pulse = 1 + g.bass * 0.07 + g.beat * 0.03;
  if (vinylWrap) vinylWrap.style.transform = `scale(${pulse})`;
  if (homeStage) homeStage.style.setProperty("--pulse", pulse);
};

$("viz-open").addEventListener("click", () => (viz.hidden ? openViz() : closeViz()));
$("viz-close").addEventListener("click", closeViz);
$("viz-full").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else viz.requestFullscreen();
});
document.addEventListener("keydown", (e) => {
  // Bandeja del inicio: flechas para pasar de disco (si el visualizador a pantalla completa no está abierto).
  if (viz.hidden && deck && (e.key === "ArrowRight" || e.key === "ArrowLeft") && !(e.target instanceof HTMLInputElement)) {
    deckGo(deck.index + (e.key === "ArrowRight" ? 1 : -1));
    return;
  }
  if (viz.hidden) return;
  if (e.key === "Escape" && !document.fullscreenElement) closeViz();
  // Flechas: cambian de modelo (no interfieren con la barra de progreso, que tiene el foco propio).
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !(e.target instanceof HTMLInputElement)) {
    const ids = Visualizer.modes.map((m) => m.id);
    const i = ids.indexOf(Visualizer.mode);
    chooseMode(ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length]);
  }
});

search.addEventListener("input", () => {
  renderLibrary();
  if (detailId !== null) location.hash = "#/"; // buscar lleva al inicio; hashchange renderiza
  else showHome();
});

/* ---------- Pantalla de reproducción (estilo YouTube Music) ---------- */

const npf = $("nowplaying");
const snakeCanvas = $("npf-snake");
const snakeCtx = snakeCanvas.getContext("2d");

let shuffleOn = pref.get("shuffle", "0") === "1";
let repeatOne = pref.get("repeat", "0") === "1";
// Sin cuentas, cada navegador recuerda qué canciones marcó con "me gusta".
const liked = new Set(
  (() => {
    try { return JSON.parse(pref.get("liked", "[]")); } catch { return []; }
  })(),
);

const currentSong = () => findSong(currentId);

function syncNowPlaying() {
  if (npf.hidden) return;
  const song = currentSong();
  if (!song) return hideNowPlaying(); // la canción se eliminó o aún no hay ninguna
  npf.style.setProperty("--h", hue(song));
  const cover = $("npf-cover");
  cover.textContent = initial(song);
  cover.style.cssText = coverStyle(song);
  $("npf-title").textContent = song.title;
  $("npf-artist").textContent = song.artist;
  $("npf-plays").textContent = playsText(song.plays ?? 0);
  const isLiked = liked.has(song.id);
  $("npf-like").classList.toggle("on", isLiked);
  $("npf-like").setAttribute("aria-pressed", String(isLiked));
  $("npf-likes").textContent = song.likes ?? 0;
  setIcon($("npf-play"), audio.paused ? "play" : "pause");
  $("npf-shuffle").classList.toggle("on", shuffleOn);
  $("npf-shuffle").setAttribute("aria-pressed", String(shuffleOn));
  $("npf-repeat").classList.toggle("on", repeatOne);
  $("npf-repeat").setAttribute("aria-pressed", String(repeatOne));
  setIcon($("npf-repeat"), repeatOne ? "repeat1" : "repeat");
}

function openNowPlaying() {
  if (currentId === null || !npf.hidden) return;
  npf.hidden = false;
  document.body.classList.add("npf-open");
  syncNowPlaying();
  startSnake();
  history.pushState({ npf: true }, ""); // el botón "atrás" del teléfono cierra la pantalla, no la app
}

function hideNowPlaying() {
  npf.hidden = true;
  document.body.classList.remove("npf-open");
  stopSnake();
}

function closeNowPlaying() {
  if (npf.hidden) return;
  hideNowPlaying();
  if (history.state?.npf) history.back();
}
window.addEventListener("popstate", () => {
  if (!npf.hidden) hideNowPlaying();
});

async function toggleLike() {
  const song = currentSong();
  if (!song) return;
  const was = liked.has(song.id);
  const apply = (on) => {
    on ? liked.add(song.id) : liked.delete(song.id);
    pref.set("liked", JSON.stringify([...liked]));
  };
  apply(!was);
  song.likes = Math.max(0, (song.likes ?? 0) + (was ? -1 : 1)); // optimista: se corrige con la respuesta
  syncNowPlaying();
  try {
    const res = await fetch(`${API_URL}/songs/${song.id}/like`, { method: was ? "DELETE" : "POST", headers: authHeaders() });
    if (!res.ok) throw new Error();
    song.likes = (await res.json()).likes;
  } catch {
    apply(was);
    song.likes = Math.max(0, (song.likes ?? 0) + (was ? 1 : -1));
  }
  syncNowPlaying();
}

async function shareSong() {
  const song = currentSong();
  if (!song) return;
  const url = location.origin + location.pathname; // el link abre el inicio de la app
  const label = $("npf-share-label");
  try {
    if (navigator.share) await navigator.share({ title: song.title, text: `${song.title} – ${song.artist}`, url });
    else {
      await navigator.clipboard.writeText(url);
      label.textContent = "Link copiado";
      setTimeout(() => (label.textContent = "Compartir"), 1500);
    }
  } catch { /* el usuario canceló el diálogo de compartir */ }
}

document.querySelector(".np").addEventListener("click", openNowPlaying);
$("npf-close").addEventListener("click", closeNowPlaying);
$("npf-like").addEventListener("click", toggleLike);
$("npf-share").addEventListener("click", shareSong);
$("npf-viz").addEventListener("click", () => {
  closeNowPlaying();
  openViz();
});
$("npf-play").addEventListener("click", togglePlay);
$("npf-prev").addEventListener("click", () => step(-1));
$("npf-next").addEventListener("click", () => step(1));
$("npf-shuffle").addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  pref.set("shuffle", shuffleOn ? "1" : "0");
  syncNowPlaying();
});
$("npf-repeat").addEventListener("click", () => {
  repeatOne = !repeatOne;
  pref.set("repeat", repeatOne ? "1" : "0");
  syncNowPlaying();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !npf.hidden) closeNowPlaying();
});

/* ---------- La serpiente: barra de progreso ---------- */
// La cabeza de la serpiente es la posición actual: va comiendo los puntos del camino y deja atrás un cuerpo
// recto sobre la línea. Solo la punta se mueve, apenas, un poco más con los graves. Arrastrarla adelanta o atrasa la canción.

const snake = { w: 0, h: 0, dpr: 1, raf: 0, last: 0, t: 0, head: -1, amp: 1.2, bass: 0, speed: 1, dragging: false, ratio: 0 };
const SNAKE_PAD = 16;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function snakeResize() {
  const rect = snakeCanvas.getBoundingClientRect();
  snake.dpr = window.devicePixelRatio || 1;
  snake.w = rect.width;
  snake.h = rect.height;
  snakeCanvas.width = Math.round(rect.width * snake.dpr);
  snakeCanvas.height = Math.round(rect.height * snake.dpr);
}
window.addEventListener("resize", () => !npf.hidden && snakeResize());

function startSnake() {
  cancelAnimationFrame(snake.raf);
  snakeResize();
  snake.head = -1; // la primera vez se coloca directamente sobre la posición actual
  snake.last = performance.now();
  snake.raf = requestAnimationFrame(snakeFrame);
}

function stopSnake() {
  cancelAnimationFrame(snake.raf);
  snake.dragging = false;
}

function setText(id, text) {
  const node = $(id);
  if (node.textContent !== text) node.textContent = text;
}

function snakeFrame(now) {
  snake.raf = requestAnimationFrame(snakeFrame);
  const dt = Math.min(0.05, (now - snake.last) / 1000);
  snake.last = now;
  const { w, h, dpr } = snake;
  const ctx = snakeCtx;
  const playing = !audio.paused;
  const dur = audio.duration || 0;
  // Todo se acerca a su valor con un suavizado exponencial: nada salta ni se corta de golpe.
  const ease = (rate) => 1 - Math.exp(-rate * dt);

  const ratio = snake.dragging ? snake.ratio : dur ? Math.min(1, audio.currentTime / dur) : 0;
  const span = Math.max(1, w - SNAKE_PAD * 2);
  const target = SNAKE_PAD + ratio * span;
  snake.head = snake.head < 0 ? target : snake.head + (target - snake.head) * ease(snake.dragging ? 14 : 4);

  const level = playing ? Visualizer.level() : 0;
  snake.bass += (level - snake.bass) * ease(2.5);
  snake.amp += ((playing ? 1.6 + snake.bass * 2.2 : 0.4) - snake.amp) * ease(1.2);
  snake.speed += ((playing ? 1 : 0.2) - snake.speed) * ease(1.5);
  if (!reducedMotion) snake.t += dt * snake.speed;

  const shownTime = snake.dragging ? ratio * dur : audio.currentTime;
  setText("npf-cur", formatTime(shownTime));
  setText("npf-dur", formatTime(dur));
  const pct = String(Math.round(ratio * 100));
  if (snakeCanvas.getAttribute("aria-valuenow") !== pct) snakeCanvas.setAttribute("aria-valuenow", pct);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const midY = h / 2;
  const headX = snake.head;

  // Camino: puntos por comer (cada sexto es más grande). Los que quedan atrás ya se comieron.
  for (let x = SNAKE_PAD, k = 0; x <= w - SNAKE_PAD + 0.5; x += 16, k++) {
    if (x <= headX + 8) continue;
    const big = k % 6 === 5;
    ctx.beginPath();
    ctx.fillStyle = big ? "rgb(255 255 255 / 0.8)" : "rgb(255 255 255 / 0.22)";
    ctx.arc(x, midY, big ? 2.6 : 1.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Cuerpo largo: cubre todo el camino recorrido y queda recto sobre la línea, fino atrás y más grueso y
  // brillante cerca de la cabeza. Solo se mueve un poquito la punta (el término "live"); al quedar atrás
  // se aquieta del todo y el cuerpo se queda quieto sobre la línea.
  const step = 1.5;
  const thick = 1 + snake.bass * 0.1 + (snake.dragging ? 0.25 : 0);
  const n = Math.ceil((headX - SNAKE_PAD) / step);
  for (let i = 0; i <= n; i++) {
    const x = Math.min(headX, SNAKE_PAD + i * step);
    const d = headX - x; // distancia hasta la cabeza
    const live = Math.sin(snake.t * 2 - d * 0.08) * snake.amp * Math.exp(-(d * d) / 800);
    const r = (1.1 + 3.9 * Math.pow(Math.max(0, 1 - d / 70), 1.5)) * thick;
    ctx.beginPath();
    ctx.fillStyle = `hsl(0 0% ${66 + 34 * Math.max(0, 1 - d / 100)}%)`;
    ctx.arc(x, midY + live, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function snakeRatio(e) {
  const rect = snakeCanvas.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left - SNAKE_PAD) / Math.max(1, rect.width - SNAKE_PAD * 2)));
}

snakeCanvas.addEventListener("pointerdown", (e) => {
  if (!audio.duration) return;
  snake.dragging = true;
  snake.ratio = snakeRatio(e);
  snakeCanvas.setPointerCapture(e.pointerId);
});
snakeCanvas.addEventListener("pointermove", (e) => {
  if (snake.dragging) snake.ratio = snakeRatio(e);
});
const endDrag = () => {
  if (!snake.dragging) return;
  snake.dragging = false;
  if (audio.duration) audio.currentTime = snake.ratio * audio.duration;
};
snakeCanvas.addEventListener("pointerup", endDrag);
snakeCanvas.addEventListener("pointercancel", endDrag);
snakeCanvas.addEventListener("keydown", (e) => {
  if (!audio.duration) return;
  const jump = { ArrowRight: 5, ArrowLeft: -5 }[e.key];
  if (jump === undefined) return;
  e.preventDefault();
  audio.currentTime = Math.min(audio.duration, Math.max(0, audio.currentTime + jump));
});

/* ---------- Subida ---------- */

function openUpload(e, isPrivate = false) {
  e?.preventDefault();
  form.elements.is_private.checked = isPrivate === true;
  uploadStatus.textContent = "";
  uploadStatus.className = "";
  dialog.showModal();
}
$("nav-upload").addEventListener("click", openUpload);
$("tab-upload").addEventListener("click", openUpload);
$("open-upload").addEventListener("click", openUpload);
$("cancel-upload").addEventListener("click", () => dialog.close());

// Recorta la imagen al centro en un cuadrado de 600 px y la comprime: cualquier foto queda con el mismo formato y peso liviano.
async function squareCover(file) {
  const size = 600;
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas
    .getContext("2d")
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("No se pudo procesar la imagen");
  return blob;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  uploadStatus.className = "";
  uploadStatus.textContent = "Subiendo...";
  try {
    const body = new FormData(form); // multipart/form-data; el navegador fija el boundary
    const coverFile = form.elements.cover.files[0];
    body.delete("cover");
    if (coverFile) {
      try {
        body.append("cover", await squareCover(coverFile), "cover.jpg");
      } catch {
        throw new Error("No se pudo leer la imagen de portada");
      }
    }
    const res = await adminFetch(`${API_URL}/songs`, { method: "POST", body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : "Error al subir");
    }
    form.reset();
    dialog.close();
    await loadSongs();
  } catch (e) {
    uploadStatus.className = "error";
    uploadStatus.textContent = e.message;
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---------- Inicio ---------- */

loadSongs()
  .catch((e) => {
    statusEl.className = "error";
    statusEl.textContent = `${e.message}. ¿Está corriendo la API en ${API_URL}?`;
  })
  .finally(() => document.getElementById("splash")?.classList.add("hide"));
