import { useEffect, useRef } from 'react';

// The "Forest" ASCII effect from 21st.dev/community/ascii, reimplemented on
// Canvas2D from the published recipe rather than lifted from their code.
//
// The recipe expects a source photograph. We draw one instead: a procedural
// conifer ridge with atmospheric depth. That keeps a public repo free of stock
// imagery and its licensing, costs nothing to ship, and gives the effect what it
// actually needs - a clear subject with a wide tonal range for the glyph ramp to
// bite on.
//
// The recipe's parameters, verbatim, so the render below can be read against it.
export const FOREST = {
  renderMode: 'characters',
  bgMode: 'blur', bgBlur: 2, bgOpacity: 90,
  cellSize: 10, coverage: 100, invert: false,
  charSet: 'standard',
  brightness: 0, contrast: 128, edgeEmphasis: 0, density: 0,
  tint: '#3ca6ff', tintOpacity: 0, overlayBlend: 'multiply',
  saturation: 0, grayscale: 100,
  blurType: 'tilt', blurAmount: 30, tiltFocus: 35, tiltPosition: 50, tiltFeather: 15,
  pfx: {
    vignette:  { enabled: false, intensity: 58 },
    scanLines: { enabled: false, intensity: 40 },
    chromatic: { enabled: true,  intensity: 20 },
    bloom:     { enabled: false, intensity: 25 },
    filmGrain: { enabled: false, intensity: 32 },
    glitch:    { enabled: false, intensity: 20 },
    pixelate:  { enabled: false, intensity: 15 },
    halftone:  { enabled: true,  intensity: 20 },
    filmDust:  { enabled: true,  intensity: 20 },
  },
  animated: true,
  animStyle: 'shimmer',
  animSpeed: { enabled: true, intensity: 100 },
  animIntensity: { enabled: true, intensity: 60 },
  lights: { enabled: false, points: [] },
  mask: { enabled: false, invert: false, dataUrl: null },
};

// Dark glyph first: on a light page the ramp runs from ink to paper, so a dense
// character stands for a dark cell. `invert` flips it.
const CHAR_SETS = {
  standard: '@%#*+=-:. ',
  blocks:   '█▓▒░ ',
  minimal:  '#+-. ',
};

const LEVELS = 10;          // luminance buckets; also how many fillStyle changes
const TARGET_FPS = 30;      // a background has no business running at 60
const MAX_CELLS = 9000;     // beyond this the glyph loop starts costing real time

// ---------------------------------------------------------------- the "photo"
//
// A ridge of conifers in fog. Nearer ranks are darker and larger, which is what
// makes the ASCII ramp read as depth rather than noise.
function paintForest(ctx, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#ffffff');
  sky.addColorStop(0.55, '#e9e9ec');
  sky.addColorStop(1, '#cfcfd4');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // A low sun behind the ridge gives the shimmer something to catch.
  const glow = ctx.createRadialGradient(w * 0.62, h * 0.42, 0, w * 0.62, h * 0.42, h * 0.9);
  glow.addColorStop(0, 'rgba(255,255,255,0.95)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Deterministic noise: the ridge must be identical across resizes and reloads,
  // or the background reshuffles itself every time the window moves.
  let seed = 20260830;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const conifer = (x, baseY, height, width, fill) => {
    ctx.fillStyle = fill;
    const tiers = 5;
    for (let t = 0; t < tiers; t++) {
      const top = baseY - height + (height / tiers) * t * 0.72;
      const halfW = (width / 2) * (0.42 + (t / tiers) * 0.72);
      const bottom = top + height / tiers + height * 0.1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x + halfW, bottom);
      ctx.lineTo(x - halfW, bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(x - width * 0.045, baseY - height * 0.1, width * 0.09, height * 0.12);
  };

  // Four ranks, far to near. Fog lifts the distant ones toward the sky value.
  const ranks = [
    { y: 0.54, h: 0.20, w: 0.030, step: 0.022, tone: 0.72 },
    { y: 0.64, h: 0.28, w: 0.044, step: 0.032, tone: 0.52 },
    { y: 0.76, h: 0.40, w: 0.062, step: 0.047, tone: 0.30 },
    { y: 0.88, h: 0.54, w: 0.088, step: 0.070, tone: 0.12 },
  ];

  for (const r of ranks) {
    const g = Math.round(r.tone * 255);
    for (let x = -0.04; x < 1.06; x += r.step) {
      const jitterX = (rand() - 0.5) * r.step * 0.55;
      const jitterH = 0.78 + rand() * 0.5;
      conifer(
        (x + jitterX) * w,
        r.y * h,
        r.h * h * jitterH,
        r.w * w,
        `rgb(${g},${g + 2},${g + 1})`,
      );
    }
    // A band of fog between ranks: this is what separates them tonally.
    const fog = ctx.createLinearGradient(0, (r.y - r.h * 0.5) * h, 0, (r.y + 0.06) * h);
    fog.addColorStop(0, 'rgba(255,255,255,0)');
    fog.addColorStop(1, 'rgba(255,255,255,0.42)');
    ctx.fillStyle = fog;
    ctx.fillRect(0, (r.y - r.h * 0.5) * h, w, r.h * 0.5 * h + 0.06 * h);
  }
}

// ------------------------------------------------------------ tone adjustments
//
// Recipe step 4, in its stated order. brightness is an offset around 0,
// contrast is a percentage around 100, and grayscale/saturation are moot here
// because the source is painted in greys - kept anyway so the knobs still work.
function tone(lum, cfg) {
  let v = lum / 255;
  v += cfg.brightness / 100;
  v = (v - 0.5) * (cfg.contrast / 100) + 0.5;
  return Math.max(0, Math.min(1, v));
}

export default function AsciiBackground({ config = FOREST, className = '' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const cfg = { ...FOREST, ...config, pfx: { ...FOREST.pfx, ...(config.pfx ?? {}) } };
    const chars = CHAR_SETS[cfg.charSet] ?? CHAR_SETS.standard;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let raf = 0, last = 0, stopped = false;
    let cols = 0, rows = 0, cell = cfg.cellSize;
    let sharp = null, blurred = null, tiltW = null;   // cached grid samples
    let scratch = null, tint = null, halftone = null, dust = null;

    // ---------------------------------------------------------------- sampling
    //
    // The source never changes, so the grid is sampled once per resize and the
    // animation works on the cached values. Without this every frame would pay
    // for a downscale plus a getImageData.
    function build() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));

      // Device pixels are wasted on glyphs this size; 1x keeps the loop honest.
      canvas.width = w;
      canvas.height = h;

      cell = cfg.cellSize;
      while ((w / cell) * (h / cell) > MAX_CELLS) cell += 1;
      cols = Math.ceil(w / cell);
      rows = Math.ceil(h / cell);

      const src = document.createElement('canvas');
      src.width = w; src.height = h;
      paintForest(src.getContext('2d'), w, h);

      // Two grid samples: one sharp, one blurred. The tilt weight per row picks
      // between them, which is a cheap stand-in for a true tilt-shift and is
      // indistinguishable once everything is glyphs.
      const grab = (blurPx) => {
        const g = document.createElement('canvas');
        g.width = cols; g.height = rows;
        const gx = g.getContext('2d', { willReadFrequently: true });
        if (blurPx) gx.filter = `blur(${blurPx}px)`;
        gx.drawImage(src, 0, 0, cols, rows);
        return gx.getImageData(0, 0, cols, rows).data;
      };
      sharp = grab(0);
      blurred = grab(Math.max(1, (cfg.blurAmount / 100) * 3));

      // Rows inside the focus band stay sharp; the feather ramps to fully blurred.
      tiltW = new Float32Array(rows);
      const focusC = (cfg.tiltPosition / 100) * rows;
      const halfBand = ((cfg.tiltFocus / 100) * rows) / 2;
      const feather = Math.max(1, (cfg.tiltFeather / 100) * rows);
      for (let y = 0; y < rows; y++) {
        const d = Math.abs(y + 0.5 - focusC) - halfBand;
        tiltW[y] = d <= 0 ? 0 : Math.min(1, d / feather);
      }

      scratch = document.createElement('canvas');
      scratch.width = w; scratch.height = h;
      tint = document.createElement('canvas');
      tint.width = w; tint.height = h;

      halftone = cfg.pfx.halftone?.enabled ? makeHalftone(cell) : null;
      dust = cfg.pfx.filmDust?.enabled ? makeDust(w, h) : null;
    }

    // A tiling dot screen. Built once, then stamped as a pattern.
    function makeHalftone(size) {
      const t = document.createElement('canvas');
      t.width = t.height = size;
      const c = t.getContext('2d');
      c.fillStyle = 'rgba(0,0,0,0.5)';
      c.beginPath();
      c.arc(size / 2, size / 2, Math.max(0.6, size * 0.12), 0, Math.PI * 2);
      c.fill();
      return ctx.createPattern(t, 'repeat');
    }

    // Specks and hairline scratches, drawn once and reused. Regenerating these
    // per frame is what makes naive film-dust look like static.
    function makeDust(w, h) {
      const frames = [];
      for (let f = 0; f < 3; f++) {
        const t = document.createElement('canvas');
        t.width = w; t.height = h;
        const c = t.getContext('2d');
        c.fillStyle = 'rgba(0,0,0,0.5)';
        for (let i = 0; i < 26; i++) {
          const x = Math.random() * w, y = Math.random() * h;
          c.fillRect(x, y, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
        }
        c.strokeStyle = 'rgba(0,0,0,0.28)';
        c.lineWidth = 0.7;
        for (let i = 0; i < 2; i++) {
          const x = Math.random() * w;
          c.beginPath();
          c.moveTo(x, Math.random() * h * 0.3);
          c.lineTo(x + (Math.random() - 0.5) * 18, h * (0.5 + Math.random() * 0.5));
          c.stroke();
        }
        frames.push(t);
      }
      return frames;
    }

    // ------------------------------------------------------------------ render
    function draw(now) {
      if (!sharp || !scratch) return;   // nothing sampled yet
      const w = canvas.width, h = canvas.height;
      const t = now / 1000;

      ctx.clearRect(0, 0, w, h);

      // Recipe step 1: bgMode "blur" - a soft wash of the source behind the
      // glyphs, so the grid sits on tone rather than on nothing.
      if (cfg.bgMode === 'blur' && cfg.bgOpacity > 0) {
        ctx.save();
        ctx.globalAlpha = (cfg.bgOpacity / 100) * 0.16;
        ctx.filter = `blur(${cfg.bgBlur * 4}px)`;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const i = (y * cols + x) * 4;
            const v = Math.round(tone(sharp[i], cfg) * 255);
            ctx.fillStyle = `rgb(${v},${v},${v})`;
            ctx.fillRect(x * cell, y * cell, cell, cell);
          }
        }
        ctx.restore();
      }

      // Glyph layer, drawn into scratch so the post-effects have something to
      // offset and screen against.
      const g = scratch.getContext('2d');
      g.clearRect(0, 0, w, h);
      g.font = `${Math.round(cell * 1.02)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';

      const animOn = cfg.animated && !reduced;
      const amp = animOn ? (cfg.animIntensity.intensity / 100) * 0.17 : 0;
      const speed = (cfg.animSpeed.intensity / 100) * 1.5;

      // Bucket the cells by luminance, then draw a bucket at a time. Colour and
      // glyph both follow luminance, so this collapses thousands of fillStyle
      // changes into LEVELS of them.
      const buckets = Array.from({ length: LEVELS }, () => []);
      for (let y = 0; y < rows; y++) {
        const wgt = tiltW[y];
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const lum = sharp[i] * (1 - wgt) + blurred[i] * wgt;
          let v = tone(lum, cfg);

          // animStyle "shimmer": a travelling interference of two waves, so the
          // grid glitters unevenly instead of pulsing as one sheet.
          if (amp) {
            const s = Math.sin((x * 0.42 + y * 0.28) - t * speed * 2.1)
                    * Math.cos((x * 0.13 - y * 0.37) + t * speed * 1.3);
            v = Math.max(0, Math.min(1, v + s * amp));
          }
          if (cfg.invert) v = 1 - v;

          const b = Math.min(LEVELS - 1, Math.max(0, Math.round(v * (LEVELS - 1))));
          buckets[b].push(x * cell + cell / 2, y * cell + cell / 2);
        }
      }

      for (let b = 0; b < LEVELS; b++) {
        const pts = buckets[b];
        if (!pts.length) continue;
        const ch = chars[Math.min(chars.length - 1, Math.round((b / (LEVELS - 1)) * (chars.length - 1)))];
        if (ch === ' ') continue;
        // Darker cells are inkier; lighter ones fade toward the page.
        const shade = Math.round(28 + (b / (LEVELS - 1)) * 150);
        g.fillStyle = `rgba(${shade},${shade},${shade + 4},${1 - (b / (LEVELS - 1)) * 0.55})`;
        for (let p = 0; p < pts.length; p += 2) g.fillText(ch, pts[p], pts[p + 1]);
      }

      ctx.drawImage(scratch, 0, 0);

      // Recipe step 5, the three enabled post-effects.
      //
      // chromatic: split the layer into red and cyan copies a pixel apart and
      // screen them back. Cheaper than a per-pixel channel shift and, on a grey
      // source, visually the same thing.
      const chroma = cfg.pfx.chromatic;
      if (chroma?.enabled) {
        const d = (chroma.intensity / 100) * 3;
        const tc = tint.getContext('2d');
        // Red and cyan are complements, so the two offset copies recombine to
        // the original wherever they overlap and fringe only at the edges -
        // which is exactly what chromatic aberration looks like.
        for (const [colour, dx] of [['#ff2200', -d], ['#00ddff', d]]) {
          tc.globalCompositeOperation = 'source-over';
          tc.clearRect(0, 0, w, h);
          tc.drawImage(scratch, 0, 0);
          tc.globalCompositeOperation = 'multiply';
          tc.fillStyle = colour;
          tc.fillRect(0, 0, w, h);
          // Keep the split inside the glyphs rather than smearing over the page.
          tc.globalCompositeOperation = 'destination-in';
          tc.drawImage(scratch, 0, 0);

          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = 0.55;
          ctx.drawImage(tint, dx, 0);
          ctx.restore();
        }
      }

      if (halftone) {
        ctx.save();
        ctx.globalAlpha = (cfg.pfx.halftone.intensity / 100) * 0.22;
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = halftone;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      if (dust) {
        ctx.save();
        ctx.globalAlpha = (cfg.pfx.filmDust.intensity / 100) * 0.5;
        ctx.drawImage(dust[Math.floor(t * 6) % dust.length], 0, 0);
        ctx.restore();
      }

      // Not in the recipe: the hero has words over it, and they have to win.
      // The headline sits over the top third, so the effect is held back there
      // and allowed to come up under the ridge, then dissolves into the page
      // before the product shot rather than colliding with it.
      const fade = ctx.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0.00, 'rgba(0,0,0,0.22)');
      fade.addColorStop(0.30, 'rgba(0,0,0,0.70)');
      fade.addColorStop(0.60, 'rgba(0,0,0,1)');
      fade.addColorStop(0.90, 'rgba(0,0,0,0.85)');
      fade.addColorStop(1.00, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    function loop(now) {
      if (stopped) return;
      if (now - last >= 1000 / TARGET_FPS) { last = now; draw(now); }
      raf = requestAnimationFrame(loop);
    }

    // The canvas is sized by CSS, and on first paint that box can still measure
    // zero - which produced a 1px-wide canvas that rendered nothing visible.
    // Observing the element means the grid is built from the size it actually
    // has, whenever it actually gets one, and re-built when the window changes.
    // ResizeObserver fires once on observe(), so this covers the first paint too.
    let resizeTimer = 0;
    let lastW = 0, lastH = 0;
    const sizeTo = (w, h) => {
      if (w < 2 || h < 2) return;
      if (Math.round(w) === lastW && Math.round(h) === lastH) return;
      lastW = Math.round(w); lastH = Math.round(h);
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { build(); draw(performance.now()); }, 90);
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) sizeTo(r.width, r.height);
    });
    ro.observe(canvas);

    const first = canvas.getBoundingClientRect();
    if (first.width >= 2 && first.height >= 2) {
      lastW = Math.round(first.width); lastH = Math.round(first.height);
      build();
      draw(0);
    }
    if (cfg.animated && !reduced) raf = requestAnimationFrame(loop);

    // A background animating in a tab nobody is looking at is pure waste.
    const onVisibility = () => {
      if (document.hidden) { stopped = true; cancelAnimationFrame(raf); }
      else if (cfg.animated && !reduced) { stopped = false; last = 0; raf = requestAnimationFrame(loop); }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [config]);

  return <canvas ref={canvasRef} className={`ascii-bg ${className}`} aria-hidden="true" />;
}
