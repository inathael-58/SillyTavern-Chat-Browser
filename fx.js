/*
 * Reverie — effects on covers (the style is picked in Extensions → Reverie).
 *
 * An effect is on while a cover has the class rv_live (style.css draws it). It comes on:
 *   - while the mouse is over a cover (a touch screen has no hover, so a tap leaves nothing behind)
 *   - once, when a card page opens (the big cover)               setting hoverOpen
 *   - once, when a card scrolls into view in the gallery        setting hoverScroll
 *   - on the card page while the phone is tilted: the light     setting hoverGyro
 *     follows how it is held, like a trading card in the hand (every style)
 * --mx / --my say where the light falls and --rx / --ry how far the card leans.
 */

import { settings, saveSettings, ui, clamp, LOG } from './core.js';

export const HOVERS = [
    ['glint', 'แสงวาบ'],
    ['holo', 'ฟอยล์รุ้ง'],
    ['spot', 'สปอตไลต์'],
    ['glow', 'ขอบเรืองแสง'],
    ['glitter', 'กลิตเตอร์'],
    ['none', 'ไม่มี'],
];
/** The styles where the light has a place: they follow the mouse and sweep across when played once. */
export const FOLLOWS = new Set(['holo', 'spot', 'glitter']);

/**
 * The picked style. 2.8 dropped two: "tilt" became a switch that works with every style (hoverTilt),
 * and "bloom" looked too much like the spotlight. Either one picked before becomes the spotlight;
 * tilt keeps its lean by turning the switch on.
 */
export function hoverMode() {
    const s = settings();
    if (s.hover === 'tilt' || s.hover === 'bloom') {
        if (s.hover === 'tilt') s.hoverTilt = true;
        s.hover = 'spot';
        saveSettings();
        // the settings panel may already show the old choice
        const pick = document.getElementById('cb_set_hover'), lean = document.getElementById('cb_set_fxtilt');
        if (pick) pick.value = s.hover;
        if (lean) lean.checked = !!s.hoverTilt;
    }
    return HOVERS.some(([id]) => id === s.hover) ? s.hover : 'glint';
}
/** The card leans toward the light, with any style. */
const leans = () => !!settings().hoverTilt && hoverMode() !== 'none';
export function applyHover(root = ui.root) {
    if (!root) return;
    root.dataset.hover = hoverMode();
    root.toggleAttribute('data-tilt', leans());
    if (hoverMode() === 'glitter') glitterTextures();
}

// ---------------------------------------------------------------- glitter textures
//
// Sparkles at random places, drawn once on a canvas and used as a picture. A CSS pattern of dots
// repeats every few pixels, and the eye sees the rows (it looked like a grid). The same seed
// every time, so a card looks the same on every visit.

let glitterDone = false;
function seeded(seed) {
    return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function texture(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    return `url("${c.toDataURL('image/png')}")`;
}
function glitterTextures() {
    if (glitterDone || typeof document === 'undefined') return;
    glitterDone = true;
    try {
        const colors = ['255,255,255', '255,255,255', '255,226,150', '255,184,230', '170,238,255', '255,240,200'];
        // drawn at twice the size they are shown, so they stay crisp on phone screens
        const dot = (g, x, y, r, rgb, a = 1) => {
            const grad = g.createRadialGradient(x, y, 0, x, y, r * 2.4);
            grad.addColorStop(0, `rgba(${rgb},${a})`);
            grad.addColorStop(0.4, `rgba(${rgb},${a * 0.55})`);
            grad.addColorStop(1, `rgba(${rgb},0)`);
            g.fillStyle = grad;
            g.fillRect(x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
        };
        const fine = texture(640, (g, n) => {
            const rnd = seeded(7);
            for (let i = 0; i < 420; i++) dot(g, rnd() * n, rnd() * n, 1 + rnd() * 1.8, colors[Math.floor(rnd() * colors.length)], 0.7 + rnd() * 0.3);
        });
        const big = texture(640, (g, n) => {
            const rnd = seeded(23);
            for (let i = 0; i < 26; i++) {
                const x = rnd() * n, y = rnd() * n, r = 2.4 + rnd() * 2.2, rgb = colors[Math.floor(rnd() * colors.length)];
                dot(g, x, y, r, rgb);
                // a thin four-point flash, as light catches a flake
                g.strokeStyle = `rgba(${rgb},0.75)`;
                g.lineWidth = 1;
                g.beginPath();
                g.moveTo(x - r * 4, y); g.lineTo(x + r * 4, y);
                g.moveTo(x, y - r * 4); g.lineTo(x, y + r * 4);
                g.stroke();
            }
        });
        // where the light catches: soft patches at random places; sliding it over the sparkles as
        // the light moves makes some flakes light up and others go out
        const catchMask = texture(320, (g, n) => {
            const rnd = seeded(41);
            for (let i = 0; i < 70; i++) {
                const x = rnd() * n, y = rnd() * n, r = 10 + rnd() * 22;
                const grad = g.createRadialGradient(x, y, 0, x, y, r);
                grad.addColorStop(0, 'rgba(0,0,0,1)');
                grad.addColorStop(0.6, 'rgba(0,0,0,0.8)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = grad;
                g.fillRect(x - r, y - r, r * 2, r * 2);
            }
        });
        const s = document.documentElement.style;
        s.setProperty('--rv-glitter-fine', fine);
        s.setProperty('--rv-glitter-big', big);
        s.setProperty('--rv-glitter-catch', catchMask);
    } catch (e) {
        console.warn(LOG, 'glitter', e);
    }
}
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const COVER = '.cb_tile, .cb_heroimg';

/** Light at (fx, fy) of the cover, 0…1; `lean` scales how far the card tilts toward it. */
function setLight(el, fx, fy, lean = 1) {
    el.style.setProperty('--mx', `${(fx * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(fy * 100).toFixed(1)}%`);
    el.style.setProperty('--ry', `${((fx - 0.5) * 14 * lean).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${((0.5 - fy) * 14 * lean).toFixed(2)}deg`);
    // which way the light lies from the middle: the glowing border turns its light toward it
    el.style.setProperty('--ga', `${(Math.atan2(fy - 0.5, fx - 0.5) * 180 / Math.PI + 90).toFixed(1)}deg`);
}
function settle(el) {
    for (const p of ['--mx', '--my', '--rx', '--ry', '--ga']) el.style.removeProperty(p);
}

/**
 * Switch the effect off. The light fades out where it is: its place is reset only once it has faded
 * (style.css fades it in about 0.35 s). Resetting at once made it jump to the middle while fading.
 */
const fading = new WeakMap();
function fadeOut(el) {
    el.classList.remove('rv_live');
    clearTimeout(fading.get(el));
    fading.set(el, setTimeout(() => { if (!el.classList.contains('rv_live')) settle(el); }, 500));
}

// ---------------------------------------------------------------- mouse

/** Hover with a mouse (also a trackpad or mouse on an iPad); the light follows it, once per frame. */
export function wireCoverFx(list) {
    let frame = 0, last = null;
    list.addEventListener('pointerover', e => {
        if (e.pointerType !== 'mouse' || hoverMode() === 'none') return;
        const el = e.target.closest?.(COVER);
        if (el && !el.contains(e.relatedTarget)) { el.dataset.mouse = '1'; el.classList.add('rv_live'); }
    }, { passive: true });
    list.addEventListener('pointerout', e => {
        if (e.pointerType !== 'mouse') return;
        const el = e.target.closest?.(COVER);
        if (!el || el.contains(e.relatedTarget)) return;
        delete el.dataset.mouse;
        if (el.dataset.playing || el.dataset.gyro) return;
        fadeOut(el);
    }, { passive: true });
    list.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse' || (!FOLLOWS.has(hoverMode()) && !leans())) return;
        const el = e.target.closest?.(COVER);
        if (!el || el.dataset.playing) return;
        last = { el, x: e.clientX, y: e.clientY };
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            const r = last.el.getBoundingClientRect();
            setLight(last.el, clamp((last.x - r.left) / r.width, 0, 1), clamp((last.y - r.top) / r.height, 0, 1));
        });
    }, { passive: true });
}

// ---------------------------------------------------------------- once (a card page opens, a card scrolls in)

/** Run the picked effect once on a cover: what a mouse passing over it would show. */
export function playCover(el) {
    const mode = hoverMode();
    if (!el?.isConnected || mode === 'none' || reduced() || el.dataset.playing) return;
    if (el.dataset.mouse) return; // the mouse is on it already
    el.dataset.playing = '1';
    const done = () => {
        delete el.dataset.playing;
        el.classList.remove('rv_play');
        // (a touch screen keeps :hover after a tap, so the mouse is tracked by hand)
        if (!el.dataset.gyro && !el.dataset.mouse) fadeOut(el);
    };
    if (mode === 'glint' || mode === 'glow') {
        el.classList.remove('rv_play');
        void el.offsetWidth; // start the animation again
        el.classList.add('rv_play');
        const dur = mode === 'glint' ? 1150 : 1600;
        setTimeout(done, dur);
        // with the lean switched on, the card tips along with the light as it passes
        if (leans()) sweep(el, dur - 100);
        return;
    }
    // foil, spotlight, glitter: the light crosses from the upper left to the lower right (and the card leans with it)
    el.classList.add('rv_live');
    sweep(el, 1400, done);
}

/** The light (and the lean) crosses the cover once, from the upper left to the lower right. */
function sweep(el, dur, done) {
    const t0 = performance.now();
    const step = now => {
        if (!el.isConnected) return;
        const k = Math.min(1, (now - t0) / dur);
        const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
        setLight(el, 0.1 + 0.8 * e, 0.3 + 0.4 * e, Math.sin(k * Math.PI));
        if (k < 1) requestAnimationFrame(step); else done?.();
    };
    requestAnimationFrame(step);
}

/** The card page just opened: its big cover runs the effect once (after it has slid in). */
export function playCardPage() {
    if (!settings().hoverOpen) return;
    setTimeout(() => playCover(ui.root?.querySelector('.cb_heroimg')), 460);
}

let played = new Set();   // cards that ran the effect on scrolling in since the browser opened
let queue = [];
let pumping = 0;
let io = null;

/** A newly opened browser plays every card again as it scrolls in. */
export function resetScrollFx() {
    played = new Set();
    queue = [];
}

/** Gallery grid drawn: each card runs the effect once when most of it is on screen, one after another. */
export function watchTilesFx(list) {
    io?.disconnect();
    io = null;
    if (!settings().hoverScroll || hoverMode() === 'none' || reduced() || typeof IntersectionObserver !== 'function') return;
    io = new IntersectionObserver(entries => {
        for (const x of entries) {
            if (!x.isIntersecting) continue;
            io.unobserve(x.target);
            const id = x.target.dataset.card;
            if (!id || played.has(id)) continue;
            played.add(id);
            queue.push(x.target);
        }
        pump();
    }, { root: list, threshold: 0.6 });
    list.querySelectorAll('.cb_tile').forEach(t => io.observe(t));
}
function pump() {
    if (pumping || !queue.length) return;
    // a card every 110 ms: a screenful lights up in a quick wave, not all at once
    pumping = setTimeout(() => {
        pumping = 0;
        const t = queue.shift();
        if (t?.isConnected && !ui.selecting && !ui.card) playCover(t);
        pump();
    }, 110);
}

// ---------------------------------------------------------------- tilting the phone (card page)

let gyroOn = false;
let base = null;   // how the phone was held when this cover appeared: that counts as straight
let reading = null;
let gFrame = 0;

/** Phones and tablets that can tell how they are held. */
export const gyroSupported = () => typeof globalThis.DeviceOrientationEvent === 'function';

/**
 * iPhone and iPad ask the user before a page may read the motion sensors, and only from a tap.
 * Call it straight from one. Returns 'granted', 'denied' or 'unsupported'.
 */
export async function askGyro() {
    const D = globalThis.DeviceOrientationEvent;
    if (typeof D !== 'function') return 'unsupported';
    if (typeof D.requestPermission !== 'function') return 'granted';
    try { return await D.requestPermission(); } catch (e) { console.warn(LOG, 'motion sensors', e); return 'denied'; }
}

function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    reading = e;
    gFrame ||= requestAnimationFrame(applyGyro);
}

function applyGyro() {
    gFrame = 0;
    const el = ui.root?.querySelector('.cb_heroimg');
    // every style follows the phone: the glint slides, the border light turns, the foil and glitter shimmer
    // (and with the lean switched on, the card tips toward the light)
    const on = el && reading && hoverMode() !== 'none' && !reduced();
    for (const old of ui.root?.querySelectorAll('[data-gyro]') ?? []) {
        if (old !== el || !on) { delete old.dataset.gyro; fadeOut(old); }
    }
    if (!on) return;
    // the screen's own axes: turned sideways, the phone's tilt left/right is its front/back
    const angle = globalThis.screen?.orientation?.angle ?? globalThis.orientation ?? 0;
    let x = reading.gamma, y = reading.beta;
    if (angle === 90) { x = reading.beta; y = -reading.gamma; } else if (angle === 270 || angle === -90) { x = -reading.beta; y = reading.gamma; } else if (angle === 180) { x = -reading.gamma; y = -reading.beta; }
    if (!base || base.el !== el) base = { el, x, y, sx: x, sy: y };
    // A phone held still still reports tiny changes; they made the light (and the glitter) quiver.
    // The reading is smoothed, and the light moves only once the phone has really turned a little.
    base.sx += (x - base.sx) * 0.25;
    base.sy += (y - base.sy) * 0.25;
    if (base.lx !== undefined && Math.abs(base.sx - base.lx) < 0.4 && Math.abs(base.sy - base.ly) < 0.4 && el.dataset.gyro) return;
    base.lx = base.sx;
    base.ly = base.sy;
    x = base.sx;
    y = base.sy;
    if (el.dataset.playing) return;
    el.dataset.gyro = '1';
    el.classList.add('rv_live');
    setLight(el, 0.5 + clamp((x - base.x) / 50, -0.5, 0.5), 0.5 + clamp((y - base.y) / 50, -0.5, 0.5));
}

/** Listen to the sensors only while the browser is open and the setting is on. */
export function syncGyro() {
    const want = !!settings().hoverGyro && !!ui.root && gyroSupported();
    if (want === gyroOn) return;
    gyroOn = want;
    if (want) {
        globalThis.addEventListener('deviceorientation', onOrient);
    } else {
        globalThis.removeEventListener('deviceorientation', onOrient);
        base = null;
        reading = null;
    }
}
