/*!
 * Korte Music — intro de carga con corte
 * Uso: cargar korte-intro.js con un tag script normal (sin defer ni async) como PRIMER elemento dentro de body.
 * Corre sola al cargar. Para controlarla a mano: data-auto="false" y luego KorteIntro.play({...}).
 * Opciones: minDuration (ms, default 1000), oncePerSession (bool, default false), onDone (fn).
 * Movimiento: el disco gira mientras la app carga; cuando está por terminar frena con la K derecha,
 * el corte cruza el logo y la pantalla se parte para dejar entrar a la app.
 * Si el tag script lleva data-wait="app", el corte espera a que la app llame a KorteIntro.ready() (ya cargó sus datos),
 * con un tope de 25 s; mientras tanto el disco sigue girando. Así la app entra ya cargada.
 * Al terminar dispara el evento "korte:intro-done" en window.
 */
(function () {
  "use strict";
  var BG = "#0E0D0C", FG = "#F2EDE4", AC = "#FF4D1F";
  var ANGLE = 20; // grados del corte del disco
  var P = {"K": "M460.896 417.44V339.44H484.92V398.408L478.68 393.312L520.176 339.44H545.552L482.84000000000003 417.44ZM498.232 380.936 516.0160000000001 366.584 546.696 417.44H519.24Z", "WORD": "M221.67799999999997 800.0V701.0H252.16999999999996V775.844L244.24999999999994 769.376L296.91799999999995 701.0H329.126L249.52999999999997 800.0ZM269.066 753.668 291.638 735.452 330.578 800.0H295.72999999999996Z M393.5419999999999 802.244Q375.7219999999999 802.244 362.32399999999996 795.7760000000001Q348.92599999999993 789.308 341.46799999999996 777.692Q334.00999999999993 766.076 334.00999999999993 750.5Q334.00999999999993 734.924 341.46799999999996 723.308Q348.92599999999993 711.692 362.32399999999996 705.2239999999999Q375.7219999999999 698.756 393.5419999999999 698.756Q411.36199999999997 698.756 424.76 705.2239999999999Q438.15799999999996 711.692 445.616 723.308Q453.07399999999996 734.924 453.07399999999996 750.5Q453.07399999999996 766.076 445.616 777.692Q438.15799999999996 789.308 424.76 795.7760000000001Q411.36199999999997 802.244 393.5419999999999 802.244ZM393.5419999999999 774.92Q402.38599999999997 774.92 408.78799999999995 771.95Q415.18999999999994 768.98 418.62199999999996 763.502Q422.054 758.024 422.054 750.5Q422.054 742.976 418.62199999999996 737.498Q415.18999999999994 732.02 408.78799999999995 729.05Q402.38599999999997 726.08 393.5419999999999 726.08Q384.6979999999999 726.08 378.29599999999994 729.05Q371.89399999999995 732.02 368.46199999999993 737.498Q365.0299999999999 742.976 365.0299999999999 750.5Q365.0299999999999 758.024 368.46199999999993 763.502Q371.89399999999995 768.98 378.29599999999994 771.95Q384.6979999999999 774.92 393.5419999999999 774.92Z M487.3939999999999 743.768H521.9779999999998Q527.786 743.768 531.02 741.128Q534.2539999999999 738.488 534.2539999999999 733.472Q534.2539999999999 728.456 531.02 725.816Q527.786 723.176 521.9779999999998 723.176H483.0379999999999L496.8979999999999 708.92V800.0H466.1419999999999V701.0H526.598Q538.0819999999999 701.0 546.7939999999999 705.092Q555.5059999999999 709.184 560.3899999999999 716.444Q565.2739999999999 723.704 565.2739999999999 733.472Q565.2739999999999 742.976 560.3899999999999 750.302Q555.5059999999999 757.628 546.7939999999999 761.654Q538.0819999999999 765.68 526.598 765.68H487.3939999999999ZM500.5939999999999 753.668H534.7819999999999L568.838 800.0H533.5939999999999Z M610.814 714.332H641.5699999999999V800.0H610.814ZM574.1179999999999 701.0H678.266V728.324H574.1179999999999Z M775.9459999999999 739.676V761.324H702.4219999999999V739.676ZM723.41 750.5 717.2059999999999 788.78 705.194 775.448H780.5659999999999V800.0H686.7139999999999L694.106 750.5L686.7139999999999 701.0H779.906V725.552H705.194L717.2059999999999 712.22Z", "MUSIC": "M397.712 886.0V860.8H406.064L407.504 879.736V883.408H408.368V879.736L409.808 860.8H418.16V886.0H413.84000000000003V869.152L414.272 863.392H413.408L411.536 886.0H404.408L402.464 863.392H401.6L402.03200000000004 869.152V886.0Z M453.968 886.504Q449.504 886.504 447.20000000000005 884.038Q444.896 881.572 444.896 877.288V860.8H449.648V877.288Q449.648 879.484 450.71000000000004 880.762Q451.772 882.04 453.968 882.04Q456.2 882.04 457.244 880.762Q458.288 879.484 458.288 877.288V860.8H463.04V877.288Q463.04 881.572 460.754 884.038Q458.468 886.504 453.968 886.504Z M500.35999999999996 886.504Q497.048 886.504 494.798 885.298Q492.548 884.092 491.414 882.004Q490.28 879.916 490.28 877.288V876.208H495.032V877.072Q495.032 879.34 496.364 880.69Q497.69599999999997 882.04 500.43199999999996 882.04Q502.592 882.04 503.63599999999997 881.104Q504.67999999999995 880.168 504.67999999999995 878.872Q504.67999999999995 878.044 504.284 877.342Q503.888 876.64 502.84399999999994 876.1179999999999Q501.79999999999995 875.596 499.856 875.272Q497.33599999999996 874.84 495.37399999999997 874.012Q493.412 873.184 492.278 871.69Q491.144 870.196 491.144 867.712V867.496Q491.144 865.444 492.224 863.806Q493.304 862.168 495.26599999999996 861.232Q497.22799999999995 860.296 499.856 860.296Q502.844 860.296 504.89599999999996 861.376Q506.948 862.456 508.01 864.238Q509.072 866.02 509.072 868.072V869.368H504.32V868.504Q504.32 866.992 503.15 865.876Q501.97999999999996 864.76 499.856 864.76Q498.092 864.76 497.03 865.498Q495.96799999999996 866.236 495.96799999999996 867.496Q495.96799999999996 868.792 497.102 869.5840000000001Q498.236 870.376 501.368 870.952Q505.328 871.636 507.41599999999994 873.346Q509.50399999999996 875.056 509.50399999999996 878.368V878.8Q509.50399999999996 882.292 507.056 884.398Q504.608 886.504 500.35999999999996 886.504Z M537.608 886.0V881.464H543.656V865.336H537.608V860.8H554.4559999999999V865.336H548.408V881.464H554.4559999999999V886.0Z M592.136 886.504Q587.816 886.504 585.296 883.858Q582.776 881.212 582.776 876.208V870.592Q582.776 865.732 585.296 863.014Q587.816 860.296 592.136 860.296Q596.636 860.296 598.9939999999999 862.816Q601.352 865.336 601.352 869.656V870.304H596.6V869.656Q596.6 868.468 596.204 867.298Q595.808 866.128 594.836 865.3720000000001Q593.864 864.616 592.136 864.616Q590.552 864.616 589.5260000000001 865.39Q588.5 866.164 588.014 867.442Q587.528 868.72 587.528 870.232V876.568Q587.528 879.016 588.572 880.5999999999999Q589.616 882.184 592.136 882.184Q593.972 882.184 594.944 881.4639999999999Q595.916 880.744 596.258 879.5920000000001Q596.6 878.44 596.6 877.144V876.496H601.352V877.144Q601.352 881.608 598.9939999999999 884.056Q596.636 886.504 592.136 886.504Z"};

  function disc() {
    var rings = "";
    for (var r = 212; r > 100; r -= 16) rings += '<circle cx="500" cy="380" r="' + r + '" fill="none" stroke="' + BG + '" stroke-width="2.5" opacity=".45"/>';
    return '<circle cx="500" cy="380" r="232" fill="' + FG + '"/>' + rings +
      '<circle cx="500" cy="380" r="88" fill="' + AC + '"/><path d="' + P.K + '" fill="' + BG + '"/>';
  }
  // El disco dentro de un grupo que gira sobre su propio centro (500,380). Los recortes del corte quedan fuera
  // del giro, así la línea del corte no se mueve aunque el disco gire por debajo.
  function spinDisc() {
    return '<g transform="translate(500,380)"><g class="ki-spin"><g transform="translate(-500,-380)">' + disc() + '</g></g></g>';
  }
  function word() { return '<path d="' + P.WORD + '" fill="' + FG + '"/>'; }

  function logoSVG() {
    return '<svg class="ki-logo" viewBox="168 80 680 870" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Korte Music">' +
      '<defs>' +
      '<clipPath id="ki-dt"><polygon points="0,0 1000,0 1000,198 0,562"/></clipPath>' +
      '<clipPath id="ki-db"><polygon points="0,562 1000,198 1000,1000 0,1000"/></clipPath>' +
      '<clipPath id="ki-tt"><polygon points="0,0 1000,0 1000,760 0,790"/></clipPath>' +
      '<clipPath id="ki-tb"><polygon points="0,790 1000,760 1000,1000 0,1000"/></clipPath>' +
      '</defs>' +
      '<g clip-path="url(#ki-db)">' + spinDisc() + '</g>' +
      '<g class="ki-disc-top"><g clip-path="url(#ki-dt)">' + spinDisc() + '</g></g>' +
      '<g clip-path="url(#ki-tb)">' + word() + '</g>' +
      '<g class="ki-word-top"><g clip-path="url(#ki-tt)">' + word() + '</g></g>' +
      '<path d="' + P.MUSIC + '" fill="' + FG + '" opacity=".85"/>' +
      '<rect x="296" y="872" width="64" height="5" fill="' + AC + '"/><rect x="652" y="872" width="64" height="5" fill="' + AC + '"/>' +
      '</svg>';
  }

  var CSS =
    ".ki-overlay{position:fixed;inset:0;z-index:2147483647;overflow:hidden}" +
    ".ki-stage{position:absolute;inset:0;background:" + BG + ";display:flex;align-items:center;justify-content:center;will-change:transform}" +
    ".ki-logo{width:min(62vw,46vh,340px);aspect-ratio:680/870;height:auto;display:block;opacity:0}" +
    ".ki-blade{position:absolute;left:0;height:3px;background:" + AC + ";box-shadow:0 0 10px " + AC + ",0 0 28px rgba(255,77,31,.55);transform-origin:0 50%;pointer-events:none}";

  var running = false;
  var appReadyResolve;
  var appReadyPromise = new Promise(function (r) { appReadyResolve = r; });
  // Con waitForApp, espera el aviso KorteIntro.ready() (tope: waitMax ms, por si la app nunca avisa).
  function waitForApp(opts) {
    if (!opts.waitForApp) return Promise.resolve();
    return Promise.race([appReadyPromise, wait(opts.waitMax != null ? opts.waitMax : 25000)]);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pageLoaded(maxMs) {
    if (document.readyState === "complete") return Promise.resolve();
    return Promise.race([
      new Promise(function (r) { window.addEventListener("load", r, { once: true }); }),
      wait(maxMs)
    ]);
  }
  function finish(overlay, prevOverflow, opts) {
    overlay.remove();
    document.documentElement.style.overflow = prevOverflow;
    running = false;
    window.dispatchEvent(new CustomEvent("korte:intro-done"));
    if (typeof opts.onDone === "function") opts.onDone();
  }

  function play(opts) {
    opts = opts || {};
    if (running) return;
    var minDuration = opts.minDuration != null ? opts.minDuration : 1000;
    if (opts.oncePerSession) {
      try { if (sessionStorage.getItem("korte-intro-seen")) return; sessionStorage.setItem("korte-intro-seen", "1"); } catch (e) {}
    }
    running = true;

    if (!document.getElementById("ki-style")) {
      var st = document.createElement("style"); st.id = "ki-style"; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    var overlay = document.createElement("div");
    overlay.className = "ki-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = '<div class="ki-stage">' + logoSVG() + "</div>";
    (document.body || document.documentElement).appendChild(overlay);
    var prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    var stage = overlay.querySelector(".ki-stage");
    var logo = overlay.querySelector(".ki-logo");
    var discTop = overlay.querySelector(".ki-disc-top");
    var wordTop = overlay.querySelector(".ki-word-top");
    var start = Date.now();
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Movimiento reducido: aparece el logo y se desvanece, sin corte.
    if (reduced) {
      logo.style.opacity = "1";
      discTop.style.transform = "translate(13px,-11px)";
      wordTop.style.transform = "translate(12px,-4px)";
      pageLoaded(6000).then(function () { return waitForApp(opts); })
        .then(function () { return wait(Math.max(0, minDuration - (Date.now() - start))); })
        .then(function () { return overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished; })
        .then(function () { finish(overlay, prevOverflow, opts); });
      return;
    }

    // El disco gira desde el primer momento (las dos mitades del corte giran juntas, sincronizadas).
    var SPIN_MS = 900;   // una vuelta completa
    var BRAKE_MS = 500;  // lo que tarda en frenar
    var spins = overlay.querySelectorAll(".ki-spin");
    var spinning = [].map.call(spins, function (s) {
      return s.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: SPIN_MS, iterations: Infinity });
    });

    // 1. Entra el logo (entero, sin corte)
    logo.animate([{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "scale(1)" }],
      { duration: 550, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" }).finished
    // 2. Espera a que cargue la app (con tope de 6 s) y al tiempo mínimo
    .then(function () { return pageLoaded(6000); })
    .then(function () { return waitForApp(opts); })
    .then(function () { return wait(Math.max(0, minDuration - (Date.now() - start))); })
    // 3. Está por cargar: el disco frena de forma continua y se detiene con la K derecha
    .then(function () {
      return new Promise(function (resolve) {
        var v0 = 360 / SPIN_MS;                // velocidad del giro, en grados por ms
        var stopAt = 360 - v0 * BRAKE_MS / 2;  // ángulo desde el que, frenando parejo, queda exactamente derecho
        var armed = false;                     // solo frena en la vuelta siguiente, nunca de golpe
        (function tick() {
          var a = ((spinning[0].currentTime || 0) % SPIN_MS) * v0;
          if (a < stopAt) armed = true;
          if (!armed || a < stopAt) return requestAnimationFrame(tick);
          var ms = 2 * (360 - a) / v0;         // frenado uniforme: la velocidad llega a 0 justo al quedar derecho
          var braking = [].map.call(spins, function (s) {
            return s.animate([{ transform: "rotate(" + a + "deg)" }, { transform: "rotate(360deg)" }],
              { duration: ms, easing: "cubic-bezier(.333,.667,.667,1)", fill: "forwards" });
          });
          spinning.forEach(function (x) { x.cancel(); });
          Promise.all(braking.map(function (x) { return x.finished; })).then(resolve);
        })();
      });
    })
    // 4. El corte cruza la pantalla justo por la línea del disco
    .then(function () {
      var W = window.innerWidth, H = window.innerHeight;
      var pt = logo.createSVGPoint(); pt.x = 500; pt.y = 380;
      var c = pt.matrixTransform(logo.getScreenCTM());
      var t = Math.tan(ANGLE * Math.PI / 180);
      var y0 = c.y + t * c.x, yW = c.y - t * (W - c.x);
      var blade = document.createElement("div");
      blade.className = "ki-blade";
      blade.style.top = (y0 - 1.5) + "px";
      blade.style.width = Math.hypot(W, y0 - yW) + "px";
      overlay.appendChild(blade);
      var rot = "rotate(" + (-ANGLE) + "deg) ";
      return blade.animate([{ transform: rot + "scaleX(0)" }, { transform: rot + "scaleX(1)" }],
        { duration: 240, easing: "cubic-bezier(.7,0,.9,.5)", fill: "forwards" }).finished
        .then(function () { return { W: W, H: H, y0: y0, yW: yW, blade: blade }; });
    })
    // 5. El logo queda cortado (las mitades se desplazan) + pequeño golpe
    .then(function (g) {
      var a1 = discTop.animate([{ transform: "translate(0,0)" }, { transform: "translate(17px,-15px)", offset: .55 }, { transform: "translate(13px,-11px)" }],
        { duration: 280, easing: "ease-out", fill: "forwards" });
      var a2 = wordTop.animate([{ transform: "translate(0,0)" }, { transform: "translate(16px,-6px)", offset: .55 }, { transform: "translate(12px,-4px)" }],
        { duration: 280, easing: "ease-out", fill: "forwards" });
      stage.animate([{ transform: "translate(0,0)" }, { transform: "translate(-5px,4px)" }, { transform: "translate(3px,-2px)" }, { transform: "translate(0,0)" }],
        { duration: 220, easing: "ease-out" });
      return Promise.all([a1.finished, a2.finished]).then(function () {
        discTop.style.transform = "translate(13px,-11px)";
        wordTop.style.transform = "translate(12px,-4px)";
        a1.cancel(); a2.cancel();
        return wait(380);
      }).then(function () { return g; });
    })
    // 6. La pantalla se parte por el corte y deja entrar a la app
    .then(function (g) {
      overlay.style.pointerEvents = "none";
      var top = stage.cloneNode(true), bot = stage.cloneNode(true);
      top.style.clipPath = "polygon(0px 0px," + g.W + "px 0px," + g.W + "px " + g.yW + "px,0px " + g.y0 + "px)";
      bot.style.clipPath = "polygon(0px " + g.y0 + "px," + g.W + "px " + g.yW + "px," + g.W + "px " + g.H + "px,0px " + g.H + "px)";
      overlay.insertBefore(top, stage); overlay.insertBefore(bot, stage);
      stage.remove();
      var rad = ANGLE * Math.PI / 180, d = Math.hypot(g.W, g.H) * 0.8;
      var nx = -Math.sin(rad), ny = -Math.cos(rad); // normal hacia arriba
      var tx = Math.cos(rad), ty = -Math.sin(rad);  // dirección del corte
      var mv = function (s) { return "translate(" + (s * (nx + tx * .3) * d) + "px," + (s * (ny + ty * .3) * d) + "px)"; };
      var ease = { duration: 900, easing: "cubic-bezier(.7,0,.25,1)", fill: "forwards" };
      g.blade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: "forwards" });
      return Promise.all([
        top.animate([{ transform: "translate(0,0)" }, { transform: mv(1) }], ease).finished,
        bot.animate([{ transform: "translate(0,0)" }, { transform: mv(-1) }], ease).finished
      ]);
    })
    .then(function () { finish(overlay, prevOverflow, opts); })
    .catch(function () { finish(overlay, prevOverflow, opts); });
  }

  window.KorteIntro = { play: play, ready: function () { appReadyResolve(); } };
  var me = document.currentScript;
  if (!me || me.getAttribute("data-auto") !== "false") play({ waitForApp: !!me && me.getAttribute("data-wait") === "app" });
})();
