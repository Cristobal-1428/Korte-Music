// Visualizaciones estilo Windows Media Player. Todas reaccionan a la música:
// graves (bass), medios, agudos y un detector de golpes (beat).
// Requiere que el <audio> tenga crossorigin="anonymous" y que el servidor envíe CORS;
// si no, el analizador recibe silencio.
const Visualizer = (() => {
  const TAU = Math.PI * 2;
  const BANDS = 64; // bandas del espectro (escala cuadrática: más resolución en graves)

  // Cada paleta son dos tonos (HSL). "Arcoíris" rota con el tiempo.
  const PALETTES = [
    { id: "esmeralda", label: "Esmeralda", hues: [125, 185] },
    { id: "neon", label: "Neón", hues: [305, 185] },
    { id: "fuego", label: "Fuego", hues: [6, 48] },
    { id: "oceano", label: "Océano", hues: [205, 275] },
    { id: "arcoiris", label: "Arcoíris", hues: null },
  ];

  let audio, actx, analyser, timeData, freqData;
  let canvas, ctx, raf = 0, last = 0, observer;
  let modeId = "tunnel";
  let paletteId = "esmeralda";
  let onFrame = null; // función opcional que recibe el estado de audio en cada cuadro

  const spec = new Float32Array(BANDS); // espectro suavizado 0..1
  // Estado compartido que reciben todos los modos en cada cuadro.
  const g = {
    w: 0, h: 0, cx: 0, cy: 0, maxR: 0, dpr: 1,
    dt: 0, now: 0, playing: false,
    bass: 0, mid: 0, treble: 0,
    beat: 0, // 1 en el golpe, decae rápido
    beatNow: false, // true solo el cuadro en que se detecta
    avgBass: 0, lastBeat: 0,
    hueA: 125, hueB: 185,
    spec,
  };

  const hsla = (h, s, l, a) => `hsla(${h}, ${s}%, ${l}%, ${a})`;
  const lerp = (a, b, t) => a + (b - a) * t;
  // Índice espejado: el espectro se refleja para que el dibujo sea simétrico.
  const mirror = (k, n) => (k < n / 2 ? k : n - 1 - k);
  const band = (m, half) => spec[Math.min(BANDS - 1, Math.floor((m / half) * (BANDS - 1)))];

  /* ---------- Audio ---------- */

  // Debe llamarse desde un gesto del usuario (clic) la primera vez.
  function attach(el) {
    audio = el;
    if (actx) {
      if (actx.state === "suspended") actx.resume();
      return;
    }
    actx = new AudioContext();
    const source = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyser.connect(actx.destination);
    timeData = new Uint8Array(analyser.fftSize);
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  function avgBins(a, b) {
    let s = 0;
    for (let i = a; i < b; i++) s += freqData[i];
    return s / (b - a) / 255;
  }

  function analyze() {
    const now = g.now;
    g.beatNow = false;
    g.playing = !!(audio && !audio.paused && analyser);

    if (g.playing) {
      analyser.getByteTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);

      const bass = avgBins(0, 6); // ~0-260 Hz
      g.bass = g.bass * 0.5 + bass * 0.5;
      g.mid = g.mid * 0.6 + avgBins(6, 60) * 0.4;
      g.treble = g.treble * 0.6 + avgBins(60, 240) * 0.4;

      for (let b = 0; b < BANDS; b++) {
        const lo = Math.floor(1 + Math.pow(b / BANDS, 2) * 300);
        const hi = Math.max(lo + 1, Math.floor(1 + Math.pow((b + 1) / BANDS, 2) * 300));
        const v = avgBins(lo, hi);
        spec[b] = v > spec[b] ? v : spec[b] * 0.85 + v * 0.15; // ataque rápido, caída lenta
      }

      // Golpe: el bajo instantáneo supera claramente su promedio reciente.
      g.avgBass = g.avgBass * 0.96 + bass * 0.04;
      if (bass > g.avgBass * 1.3 && bass > 0.3 && now - g.lastBeat > 180) {
        g.beat = 1;
        g.beatNow = true;
        g.lastBeat = now;
      }
    } else {
      g.bass *= 0.92;
      g.mid *= 0.92;
      g.treble *= 0.92;
      for (let b = 0; b < BANDS; b++) spec[b] *= 0.9;
    }
    g.beat *= 0.9;

    const p = PALETTES.find((x) => x.id === paletteId);
    if (p.hues) {
      [g.hueA, g.hueB] = p.hues;
    } else {
      g.hueA = (now / 40) % 360;
      g.hueB = g.hueA + 150;
    }
  }

  /* ---------- Utilidades de dibujo ---------- */

  function fade(alpha) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(2, 6, 8, ${alpha})`;
    ctx.fillRect(0, 0, g.w, g.h);
    ctx.globalCompositeOperation = "lighter";
  }

  function glow(x, y, r, hue, alpha) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, hsla(hue, 85, 60, alpha));
    grad.addColorStop(1, hsla(hue, 85, 40, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /* ---------- Modos ---------- */

  // 1) Túnel: anillos con la forma de la onda que salen del centro; alternan los dos colores.
  const tunnel = (() => {
    const POINTS = 128;
    const SPACING = 0.045;
    let rings = [];
    let rot = 0;
    let n = 0;

    function spawn() {
      const amp = new Float32Array(POINTS);
      const half = POINTS / 2;
      for (let k = 0; k < POINTS; k++) {
        const idx = Math.floor((mirror(k, POINTS) / half) * (timeData.length - 1));
        amp[k] = (timeData[idx] - 128) / 128;
      }
      rings.push({ n: n++, z: 0, amp, xs: new Float32Array(POINTS), ys: new Float32Array(POINTS) });
    }

    return {
      id: "tunnel",
      label: "Túnel",
      init() { rings = []; },
      draw() {
        const { dt, playing, bass, maxR, dpr } = g;
        const speed = playing ? 0.3 + bass * 1.1 + g.beat * 0.4 : 0.05;
        for (const r of rings) r.z += speed * dt;
        while (rings.length && rings[0].z > 1.2) rings.shift();
        if (playing && (!rings.length || rings[rings.length - 1].z >= SPACING)) spawn();
        rot += dt * (0.12 + bass * 0.9);

        const cx = g.cx + Math.sin(g.now / 1800) * g.w * 0.03;
        const cy = g.cy + Math.cos(g.now / 2300) * g.h * 0.03;

        fade(0.3);
        glow(cx, cy, maxR * (0.08 + bass * 0.22), g.hueA, 0.1 + bass * 0.3);

        for (const ring of rings) {
          const r = maxR * Math.pow(ring.z, 2.2);
          const wobble = 0.04 + ring.z * 0.2;
          for (let k = 0; k < POINTS; k++) {
            const a = rot + (k / POINTS) * TAU;
            const rad = r * (1 + ring.amp[k] * wobble);
            ring.xs[k] = cx + Math.cos(a) * rad;
            ring.ys[k] = cy + Math.sin(a) * rad;
          }
        }

        // Vetas radiales entre anillos consecutivos, en el segundo color.
        ctx.lineWidth = 1;
        for (let i = 1; i < rings.length; i++) {
          const outer = rings[i - 1];
          const inner = rings[i];
          ctx.strokeStyle = hsla(g.hueB, 60, 50, Math.min(0.2, inner.z * 1.5));
          ctx.beginPath();
          for (let k = 0; k < POINTS; k += 4) {
            ctx.moveTo(outer.xs[k], outer.ys[k]);
            ctx.lineTo(inner.xs[k], inner.ys[k]);
          }
          ctx.stroke();
        }

        // Anillos alternando color A / color B.
        for (const ring of rings) {
          const alpha = Math.min(1, ring.z * 8) * (0.75 - Math.min(ring.z, 1) * 0.35);
          ctx.strokeStyle = hsla(ring.n % 2 ? g.hueB : g.hueA, 65, 45 + ring.z * 25, alpha);
          ctx.lineWidth = (0.6 + ring.z * 2) * dpr;
          ctx.beginPath();
          ctx.moveTo(ring.xs[0], ring.ys[0]);
          for (let k = 1; k < POINTS; k++) ctx.lineTo(ring.xs[k], ring.ys[k]);
          ctx.closePath();
          ctx.stroke();
        }
      },
    };
  })();

  // 2) Rayos: púas que salen del centro, alternando los dos colores; el largo sigue el espectro.
  const rays = (() => {
    const N = 96;
    let rot = 0;
    return {
      id: "rays",
      label: "Rayos",
      init() {},
      draw() {
        const { cx, cy, maxR, bass, dpr } = g;
        rot += g.dt * (0.1 + bass * 0.9);
        fade(0.26);

        const r0 = maxR * (0.04 + bass * 0.07);
        const pulse = 1 + g.beat * 0.3;
        for (let k = 0; k < N; k++) {
          const v = band(mirror(k, N), N / 2);
          const len = maxR * (0.1 + v * 0.95 + bass * 0.15) * pulse;
          const a = rot + (k / N) * TAU;
          const half = (TAU / N) * 0.38;
          const hue = k % 2 ? g.hueB : g.hueA;

          ctx.fillStyle = hsla(hue, 95, 58, 0.3 + v * 0.55);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a - half) * r0, cy + Math.sin(a - half) * r0);
          ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
          ctx.lineTo(cx + Math.cos(a + half) * r0, cy + Math.sin(a + half) * r0);
          ctx.closePath();
          ctx.fill();
        }

        glow(cx, cy, maxR * (0.1 + bass * 0.3), g.hueA, 0.35 + bass * 0.5);
        glow(cx, cy, maxR * (0.05 + bass * 0.15), g.hueB, 0.4 + g.beat * 0.4);
        ctx.lineWidth = dpr;
      },
    };
  })();

  // 3) Barras y ondas: espectro en barras con marcas de pico y la onda cruzando la pantalla.
  const bars = (() => {
    const N = 48;
    const peaks = new Float32Array(N);
    return {
      id: "bars",
      label: "Barras y ondas",
      init() { peaks.fill(0); },
      draw() {
        const { w, h, dpr, bass, dt } = g;
        fade(0.35);
        ctx.globalCompositeOperation = "source-over"; // el modo aditivo lava las barras hasta el blanco

        const bw = w / N;
        for (let i = 0; i < N; i++) {
          const v = spec[Math.min(BANDS - 1, Math.floor((i / N) * BANDS * 0.9))];
          const bh = Math.max(2 * dpr, v * h * 0.62);
          const hue = lerp(g.hueA, g.hueB, i / N);

          const grad = ctx.createLinearGradient(0, h, 0, h - bh);
          grad.addColorStop(0, hsla(hue, 90, 40, 0.9));
          grad.addColorStop(1, hsla(hue, 95, 65, 0.95));
          ctx.fillStyle = grad;
          ctx.fillRect(i * bw + dpr, h - bh, bw - 2 * dpr, bh);

          peaks[i] = Math.max(peaks[i] - dt * h * 0.2, bh);
          ctx.fillStyle = hsla(hue, 90, 80, 0.9);
          ctx.fillRect(i * bw + dpr, h - peaks[i] - 5 * dpr, bw - 2 * dpr, 3 * dpr);
        }

        // Onda: doble trazo (halo + línea fina).
        if (timeData) {
          const cy = h * 0.4;
          const amp = h * (0.1 + bass * 0.25);
          const step = 4;
          for (const [lw, alpha, l] of [[7, 0.18, 60], [2, 0.95, 75]]) {
            ctx.strokeStyle = hsla(g.hueB, 90, l, alpha);
            ctx.lineWidth = lw * dpr;
            ctx.beginPath();
            for (let i = 0; i < timeData.length; i += step) {
              const x = (i / (timeData.length - 1)) * w;
              const y = cy + ((timeData[i] - 128) / 128) * amp;
              i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
      },
    };
  })();

  // 4) Círculo (tipo "Battery"): espectro radial con degradado entre los dos colores.
  const circle = (() => {
    const N = 128;
    let rot = 0;
    return {
      id: "circle",
      label: "Círculo",
      init() {},
      draw() {
        const { cx, cy, w, h, dpr, bass } = g;
        const base = Math.min(w, h);
        rot += g.dt * (0.2 + bass * 0.5);
        fade(0.3);

        const R0 = base * 0.2 * (1 + bass * 0.25 + g.beat * 0.1);
        glow(cx, cy, R0 * 1.1, g.hueA, 0.25 + bass * 0.5);

        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(2, ((TAU * R0) / N) * 0.6);
        for (let k = 0; k < N; k++) {
          const m = mirror(k, N);
          const v = band(m, N / 2);
          const len = base * 0.3 * v + 3 * dpr;
          const a = rot + (k / N) * TAU;
          ctx.strokeStyle = hsla(lerp(g.hueA, g.hueB, m / (N / 2)), 95, 60, 0.9);
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * R0, cy + Math.sin(a) * R0);
          ctx.lineTo(cx + Math.cos(a) * (R0 + len), cy + Math.sin(a) * (R0 + len));
          ctx.stroke();
        }
        ctx.lineCap = "butt";

        // Anillo interior con la forma de la onda.
        if (timeData) {
          ctx.strokeStyle = hsla(g.hueB, 90, 70, 0.85);
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath();
          const M = 180;
          for (let k = 0; k <= M; k++) {
            const idx = Math.floor((mirror(k % M, M) / (M / 2)) * (timeData.length - 1));
            const rad = R0 * 0.75 * (1 + ((timeData[idx] - 128) / 128) * 0.4);
            const a = -rot + (k / M) * TAU;
            const x = cx + Math.cos(a) * rad;
            const y = cy + Math.sin(a) * rad;
            k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      },
    };
  })();

  // 5) Partículas: chispas que salen del centro; cada golpe de bajo lanza una ráfaga.
  const particles = (() => {
    const MAX = 900;
    let parts = [];
    const spawn = (n, boost) => {
      for (let i = 0; i < n && parts.length < MAX; i++) {
        const a = Math.random() * TAU;
        const speed = g.maxR * (0.15 + Math.random() * 0.5) * (0.6 + boost);
        const life = 1.1 + Math.random() * 1.2;
        parts.push({
          x: g.cx, y: g.cy,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
          life, max: life,
          hue: (Math.random() < 0.5 ? g.hueA : g.hueB) + (Math.random() - 0.5) * 24,
          size: (1 + Math.random() * 3) * g.dpr,
        });
      }
    };
    return {
      id: "particles",
      label: "Partículas",
      init() { parts = []; },
      draw() {
        const { dt, bass, dpr } = g;
        fade(0.22);
        if (g.playing) {
          spawn(Math.floor(g.treble * 8 + g.mid * 6), bass * 1.2);
          if (g.beatNow) spawn(90, 1.4);
        }
        glow(g.cx, g.cy, g.maxR * (0.06 + bass * 0.2), g.hueB, 0.25 + bass * 0.5);

        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.life -= dt;
          if (p.life <= 0) {
            parts.splice(i, 1);
            continue;
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.vx *= 0.995;
          p.vy *= 0.995;
          const t = p.life / p.max;
          ctx.fillStyle = hsla(p.hue, 95, 60, t * 0.9);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.5 + t), 0, TAU);
          ctx.fill();
        }
        ctx.lineWidth = dpr;
      },
    };
  })();

  // 6) Ambiente: manchas de luz suaves que orbitan y respiran con cada banda.
  const ambience = (() => {
    const N = 9;
    return {
      id: "ambience",
      label: "Ambiente",
      init() {},
      draw() {
        const { cx, cy, maxR, bass, now } = g;
        fade(0.22);
        for (let i = 0; i < N; i++) {
          const v = spec[Math.floor((i / N) * BANDS * 0.7)];
          const ang = now / (2600 + i * 380) + i * (TAU / N);
          const dist = maxR * (0.18 + 0.22 * Math.sin(now / 2100 + i * 1.7)) * (1 + bass * 0.35);
          const x = cx + Math.cos(ang) * dist;
          const y = cy + Math.sin(ang) * dist * 0.75;
          const r = maxR * (0.07 + v * 0.2 + bass * 0.06);
          glow(x, y, r, i % 2 ? g.hueB : g.hueA, 0.07 + v * 0.2);
        }
      },
    };
  })();

  const MODES = [tunnel, rays, bars, circle, particles, ambience];
  const currentMode = () => MODES.find((m) => m.id === modeId);

  /* ---------- Bucle ---------- */

  // Asignar canvas.width borra el dibujo, así que solo se hace si el tamaño cambió (o se fuerza).
  function resize(force = false) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (!force && w === canvas.width && h === canvas.height) return;
    canvas.width = w;
    canvas.height = h;
    g.dpr = dpr;
    g.w = canvas.width;
    g.h = canvas.height;
    g.cx = g.w / 2;
    g.cy = g.h / 2;
    g.maxR = Math.hypot(g.w, g.h) / 2;
    clear();
  }

  function clear() {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, g.w, g.h);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    g.dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    g.now = now;
    last = now;
    analyze();
    currentMode().draw();
    onFrame?.(g);
  }

  // Puede llamarse sobre otro canvas (escenario de la canción o pantalla completa).
  function start(el) {
    stop();
    canvas = el;
    ctx = canvas.getContext("2d");
    resize(true);
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
    currentMode().init();
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
    observer?.disconnect();
  }

  function setMode(id) {
    if (!MODES.some((m) => m.id === id)) return;
    modeId = id;
    currentMode().init();
    if (ctx) clear(); // sin restos de la estela del modo anterior
  }

  function setPalette(id) {
    if (PALETTES.some((p) => p.id === id)) paletteId = id;
  }

  return {
    attach, start, stop, setMode, setPalette,
    modes: MODES.map(({ id, label }) => ({ id, label })),
    palettes: PALETTES.map(({ id, label, hues }) => ({ id, label, hues })),
    set onFrame(fn) { onFrame = fn; },
    get mode() { return modeId; },
    get palette() { return paletteId; },
  };
})();
