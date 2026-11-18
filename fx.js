/*
 * Reverie — effects on covers (the style is picked in Extensions → Reverie).
 *
 * An effect is on while a cover has the class rv_live (style.css draws it). It comes on:
 *   - while the mouse is over a cover (a touch screen has no hover, so a tap leaves nothing behind)
 *   - once, when a card page opens (the big cover)               setting hoverOpen
 *   - once, when a card scrolls into view in the gallery        setting hoverScroll
 *   - on the card page while the phone is tilted: the light     setting hoverGyro
 *     follows how it is held, like a trading card in the hand (foil, tilt and spotlight)
 * --mx / --my say where the light falls and --rx / --ry how far the card leans.
 */

import { settings, ui, clamp, LOG } from './core.js';

export const HOVERS = [
    ['glint', 'แสงวาบ'],
    ['holo', 'ฟอยล์รุ้ง'],
    ['tilt', 'เอียงตามเมาส์'],
    ['spot', 'สปอตไลต์'],
    ['glow', 'ขอบเรืองแสง'],
    ['bloom', 'สว่างนุ่ม'],
    ['none', 'ไม่มี'],
];
/** The styles where the light has a place: they follow the mouse, and the phone when it tilts. */
export const FOLLOWS = new Set(['holo', 'tilt', 'spot']);

export const hoverMode = () => (HOVERS.some(([id]) => id === settings().hover) ? settings().hover : 'glint');
export function applyHover(root = ui.root) {
    if (root) root.dataset.hover = hoverMode();
}
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const COVER = '.cb_tile, .cb_heroimg';

/** Light at (fx, fy) of the cover, 0…1; `lean` scales how far the card tilts toward it. */
function setLight(el, fx, fy, lean = 1) {
    el.style.setProperty('--mx', `${(fx * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(fy * 100).toFixed(1)}%`);
    el.style.setProperty('--ry', `${((fx - 0.5) * 14 * lean).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${((0.5 - fy) * 14 * lean).toFixed(2)}deg`);
}
function settle(el) {
    for (const p of ['--mx', '--my', '--rx', '--ry']) el.style.removeProperty(p);
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
        el.classList.remove('rv_live');
        settle(el);
    }, { passive: true });
    list.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse' || !FOLLOWS.has(hoverMode())) return;
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
        if (!el.dataset.gyro && !el.dataset.mouse) { el.classList.remove('rv_live'); settle(el); }
    };
    if (mode === 'glint' || mode === 'glow') {
        el.classList.remove('rv_play');
        void el.offsetWidth; // start the animation again
        el.classList.add('rv_play');
        setTimeout(done, mode === 'glint' ? 1150 : 1600);
        return;
    }
    if (mode === 'bloom') {
        el.classList.add('rv_live');
        setTimeout(done, 1000);
        return;
    }
    // foil, tilt, spotlight: the light crosses from the upper left to the lower right and the card leans with it
    el.classList.add('rv_live');
    const t0 = performance.now(), dur = 1400;
    const step = now => {
        if (!el.isConnected) return;
        const k = Math.min(1, (now - t0) / dur);
        const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
        setLight(el, 0.1 + 0.8 * e, 0.3 + 0.4 * e, Math.sin(k * Math.PI));
        if (k < 1) requestAnimationFrame(step); else done();
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
    const on = el && reading && FOLLOWS.has(hoverMode()) && !reduced();
    for (const old of ui.root?.querySelectorAll('[data-gyro]') ?? []) {
        if (old !== el || !on) { delete old.dataset.gyro; old.classList.remove('rv_live'); settle(old); }
    }
    if (!on) return;
    // the screen's own axes: turned sideways, the phone's tilt left/right is its front/back
    const angle = globalThis.screen?.orientation?.angle ?? globalThis.orientation ?? 0;
    let x = reading.gamma, y = reading.beta;
    if (angle === 90) { x = reading.beta; y = -reading.gamma; } else if (angle === 270 || angle === -90) { x = -reading.beta; y = reading.gamma; } else if (angle === 180) { x = -reading.gamma; y = -reading.beta; }
    if (!base || base.el !== el) base = { el, x, y };
    // held still for a while, that becomes the new straight: the light drifts back to the middle
    base.x += (x - base.x) * 0.006;
    base.y += (y - base.y) * 0.006;
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
