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

let songs = [];
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

function coverStyle(song) {
  const h = hue(song);
  return `background: linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 70% 25%))`;
}

function initial(song) {
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

function streamUrl(id) {
  return `${API_URL}/songs/${id}/stream`;
}

// Lee la duración pidiendo solo los metadatos (el servidor responde con Range).
function loadDuration(song, onReady) {
  if (durations.has(song.id)) return onReady(durations.get(song.id));
  const probe = new Audio();
  probe.preload = "metadata";
  probe.addEventListener("loadedmetadata", () => {
    durations.set(song.id, probe.duration);
    onReady(probe.duration);
  });
  probe.src = streamUrl(song.id);
}

/* ---------- Carga y rutas ---------- */

async function loadSongs() {
  const res = await fetch(`${API_URL}/songs`);
  if (!res.ok) throw new Error("No se pudo cargar la biblioteca");
  songs = await res.json();
  renderLibrary();
  route();
}

// Borra la canción (fila y audio). Si el servidor pide clave de administrador, la pregunta una vez y la recuerda.
async function deleteSong(song) {
  if (!confirm(`¿Eliminar "${song.title}" de ${song.artist}? Esta acción no se puede deshacer.`)) return;
  const send = () => {
    const key = localStorage.getItem("admin-key");
    return fetch(`${API_URL}/songs/${song.id}`, { method: "DELETE", headers: key ? { "X-Admin-Key": key } : {} });
  };
  try {
    let res = await send();
    if (res.status === 401) {
      const key = prompt("Clave de administrador:");
      if (!key) return;
      localStorage.setItem("admin-key", key);
      res = await send();
      if (res.status === 401) localStorage.removeItem("admin-key");
    }
    if (!res.ok && res.status !== 404) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || "No se pudo eliminar la canción");
    }
  } catch (e) {
    alert(e.message);
    return;
  }

  durations.delete(song.id);
  if (currentId === song.id) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    currentId = null;
    $("np-title").textContent = "Nada en reproducción";
    $("np-artist").innerHTML = "&nbsp;";
    $("np-cover").textContent = "";
    $("np-cover").style.cssText = "";
    $("time-dur").textContent = "0:00";
  }
  if (location.hash === `#/song/${song.id}`) location.hash = ""; // sale del detalle de la canción borrada
  await loadSongs().catch((e) => alert(e.message));
  updatePlayState();
}

function visibleSongs() {
  const q = search.value.trim().toLowerCase();
  if (!q) return songs;
  return songs.filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q));
}

function route() {
  const match = location.hash.match(/^#\/song\/(\d+)$/);
  const song = match && songs.find((s) => s.id === Number(match[1]));
  if (song) showDetail(song);
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
    const del = el("button", "li-delete", "✕");
    del.type = "button";
    del.title = "Eliminar canción";
    del.setAttribute("aria-label", `Eliminar ${song.title}`);
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // no abrir el detalle
      deleteSong(song);
    });
    li.append(cover, text, del);
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

  const list = visibleSongs();
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
  hello.append(
    el("h1", "", greeting()),
    el("p", "", `${songs.length} ${songs.length === 1 ? "canción" : "canciones"} en tu biblioteca`),
  );
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
  const shuffle = el("button", "viz-chip", "🔀 Aleatorio");
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
  stageCanvas = canvas;
  main.scrollTop = 0;
  markActive();
  syncViz();
}

/* ---------- Vista: detalle de canción (escenario) ---------- */

function showDetail(song) {
  detailId = song.id;
  deck = null;
  homeStage = null;
  $("nav-home").classList.remove("active");
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
  const chips = el("div", "chips");
  chips.append(
    el("span", "chip", String(new Date(song.created_at).getFullYear())),
    durChip,
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
  document.querySelectorAll(".card, #library-list li").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.id) === currentId);
  });
}

function updatePlayState() {
  playBtn.textContent = audio.paused ? "▶" : "⏸";
  // La canción "en pantalla" es la del disco central (inicio) o la del detalle.
  const shownId = deck ? deck.list[deck.index].id : detailId;
  const playingHere = currentId === shownId && !audio.paused;
  const big = $("big-play");
  if (big) big.textContent = playingHere ? "⏸ Pausar" : "▶ Reproducir";
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
  const song = songs.find((s) => s.id === id);
  if (!song) return;
  currentId = id;
  if (deck) deckGo(deck.list.findIndex((s) => s.id === id)); // la bandeja sigue a la canción que suena
  // El <audio> pide fragmentos con la cabecera Range automáticamente.
  audio.src = streamUrl(id);
  startPlayback();

  $("np-title").textContent = song.title;
  $("np-artist").textContent = song.artist;
  $("viz-title").textContent = song.title;
  $("viz-artist").textContent = song.artist;
  const cover = $("np-cover");
  cover.textContent = initial(song);
  cover.style.cssText = coverStyle(song);
  markActive();
  updatePlayState();
}

function step(delta) {
  if (songs.length === 0) return;
  const i = songs.findIndex((s) => s.id === currentId);
  playSong(songs[(i + delta + songs.length) % songs.length].id);
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
audio.addEventListener("ended", () => step(1));
audio.addEventListener("loadedmetadata", () => ($("time-dur").textContent = formatTime(audio.duration)));
audio.addEventListener("timeupdate", () => {
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

$("back").addEventListener("click", () => history.back());

/* ---------- Visualizador ---------- */

const viz = $("viz");

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

/* ---------- Subida ---------- */

function openUpload(e) {
  e?.preventDefault();
  uploadStatus.textContent = "";
  uploadStatus.className = "";
  dialog.showModal();
}
$("nav-upload").addEventListener("click", openUpload);
$("open-upload").addEventListener("click", openUpload);
$("cancel-upload").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  uploadStatus.className = "";
  uploadStatus.textContent = "Subiendo...";
  try {
    const res = await fetch(`${API_URL}/songs`, {
      method: "POST",
      body: new FormData(form), // multipart/form-data; el navegador fija el boundary
    });
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

loadSongs().catch((e) => {
  statusEl.className = "error";
  statusEl.textContent = `${e.message}. ¿Está corriendo la API en ${API_URL}?`;
});
