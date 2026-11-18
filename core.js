/*
 * Reverie — shared state and helpers used by every part (list, gallery, card editor).
 */

import { isAvatarUrl, withVersion, versionOf } from './lib.js';

export const MODULE = 'chat_browser';
export const VERSION = '2.4.0'; // keep in sync with manifest.json
export const LOG = '[Reverie]';
export const BASE_URL = new URL('.', import.meta.url);
export const CACHE_KEY = 'cb_cache_v1';
export const SEEN_KEY = 'cb_seen_v1';
export const CHUNK = 80; // rows rendered at a time

export const DEFAULTS = Object.freeze({
    view: 'normal',      // compact | normal | detail | gallery
    sort: 'recent',      // recent | character | name | size
    merge: true,         // one row per story
    pins: Object.freeze({}),
    pinsImported: false, // SillyTavern's own pinned chats copied in once
    launcher: true,      // floating button
    launcherPos: Object.freeze({ x: 0, y: 0.72, edge: 'left' }),
    launcherLook: null,  // filled from LOOK_DEFAULT
    topbar: true,        // icon in the top bar
    topbarLook: null,    // filled from TOP_DEFAULT
    cardButton: 'off',   // off | hold | tap — ST's Card button: hold (or tap) opens Reverie
    scheme: 'theme',     // theme | light | dark — colours of the browser window
    gallerySize: 'large', // large | compact — cover size in the gallery
    galleryTags: Object.freeze([]), // gallery: only cards with every one of these tags
    galleryFav: false,   // gallery: only favourites
    pageCards: 0,        // gallery: cards per page (0 = all on one page)
    pageChats: 0,        // list: chats per page (0 = all on one page)
});

export const ctx = () => SillyTavern.getContext();

export function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = Array.isArray(v) ? [...v] : (v && typeof v === 'object') ? { ...v } : v;
    }
    if (!Array.isArray(s.galleryTags)) s.galleryTags = [];
    return s;
}
export const saveSettings = () => ctx().saveSettingsDebounced();

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const toast = {
    ok: (m, t, o) => globalThis.toastr?.success(m, t ?? 'Reverie', o),
    info: (m, t, o) => globalThis.toastr?.info(m, t ?? 'Reverie', o),
    warn: (m, t, o) => globalThis.toastr?.warning(m, t ?? 'Reverie', o),
    err: (m, t, o) => globalThis.toastr?.error(m, t ?? 'Reverie', o),
};
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const errText = e => String(e?.message ?? e);
export const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
export const cab = () => (globalThis.ChatAutoBackup?.api >= 2 ? globalThis.ChatAutoBackup : null);

// SillyTavern functions that getContext() doesn't offer. Loaded on first use; each one
// has a plain-API fallback, so an older or newer SillyTavern without it still works.
let stMods = null;
export async function st() {
    if (stMods) return stMods;
    stMods = {};
    try { Object.assign(stMods, await import('../../../../script.js')); } catch (e) { console.warn(LOG, 'script.js', e); }
    try {
        const g = await import('../../../group-chats.js');
        Object.assign(stMods, { openGroupById: g.openGroupById, editGroup: g.editGroup, deleteGroupChatByName: g.deleteGroupChatByName, renameGroupChat: g.renameGroupChat });
    } catch (e) { console.warn(LOG, 'group-chats.js', e); }
    return stMods;
}

// ---------------------------------------------------------------- entities

export function charOf(avatar) { return (ctx().characters || []).find(c => c.avatar === avatar); }
export function charIndex(avatar) { return (ctx().characters || []).findIndex(c => c.avatar === avatar); }
export function groupOf(id) { return (ctx().groups || []).find(g => String(g.id) === String(id)); }

export function thumb(type, file) {
    let url;
    try { url = ctx().getThumbnailUrl(type, file); } catch { return ''; }
    return type === 'avatar' ? withVersion(url, avatarVersions.get(file)) : url;
}

/** A character's full card picture. */
export const fullAvatar = file => withVersion(`/characters/${encodeURIComponent(file)}`, avatarVersions.get(file));

// ---------------------------------------------------------------- a changed card picture, shown everywhere
//
// SillyTavern serves a card picture at the same URL after it changes, and the browser keeps
// showing the copy it already has (iPhone Safari above all) — the picture "doesn't change".
// After a change: the browser's cached copies are fetched again, and every <img> of that card on
// the page — Reverie's, SillyTavern's and other extensions' — gets the URL with ?rv=<version>.
// Pictures drawn later in this session (SillyTavern redrawing its list or chat) get it too.

const avatarVersions = new Map(); // avatar file → version (this page session)
let avatarObserver = null;

function versionImg(img) {
    if (!avatarVersions.size || img.tagName !== 'IMG') return;
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    for (const [avatar, v] of avatarVersions) {
        if (isAvatarUrl(src, avatar, location.href)) {
            if (versionOf(src) !== String(v)) img.setAttribute('src', withVersion(src, v));
            return;
        }
    }
}

function watchAvatars() {
    if (avatarObserver || typeof MutationObserver !== 'function') return;
    avatarObserver = new MutationObserver(list => {
        for (const m of list) {
            if (m.type === 'attributes') { versionImg(m.target); continue; }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.tagName === 'IMG') versionImg(n);
                else if (n.firstElementChild) n.querySelectorAll('img').forEach(versionImg);
            }
        }
    });
    avatarObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
}

/** After a card picture changed: fresh copies in the browser cache, and every picture of it on the page redrawn. */
export async function avatarChanged(avatar) {
    const plain = [`/characters/${encodeURIComponent(avatar)}`];
    try { plain.push(ctx().getThumbnailUrl('avatar', avatar)); } catch { /* old SillyTavern */ }
    // the plain URLs too: whatever SillyTavern draws after a page reload must not get the old copy
    await Promise.allSettled(plain.map(u => fetch(u, { cache: 'reload' })));
    avatarVersions.set(avatar, Date.now().toString(36));
    watchAvatars();
    document.querySelectorAll('img').forEach(versionImg);
}

export function personaName(id) {
    return ctx().powerUserSettings?.personas?.[id] || String(id ?? '').replace(/\.(png|webp|jpe?g)$/i, '');
}

/** The persona a chat is tied to: locked to the chat, or else connected to its character/group. */
export function personaOf(c) {
    if (c.persona) return { id: c.persona, name: personaName(c.persona), locked: true };
    const descs = ctx().powerUserSettings?.persona_descriptions || {};
    for (const [id, d] of Object.entries(descs)) {
        if (d?.connections?.some(x => x?.id === c.entity && (x.type === (c.type === 'group' ? 'group' : 'character')))) {
            return { id, name: personaName(id), locked: false };
        }
    }
    return null;
}

export function currentKey() {
    const c = ctx();
    const id = c.getCurrentChatId?.();
    if (!id) return null;
    if (c.groupId) return `g:${c.groupId}:${id}`;
    const ch = c.characters?.[c.characterId];
    return ch ? `c:${ch.avatar}:${id}` : null;
}

export function isGenerating() {
    const el = document.getElementById('mes_stop');
    return !!el && getComputedStyle(el).display !== 'none';
}

export const data = { chats: [], byKey: new Map(), at: 0, loading: null, error: '' };

export async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body ?? {}), cache: 'no-cache' });
    if (!res.ok) throw Object.assign(new Error(`${url} → ${res.status}`), { status: res.status });
    return res;
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** The browser window's state and drawing; index.js and gallery.js add its methods. */
export const ui = {};

/** Functions owned by index.js that the other parts call (filled in by index.js at load). */
export const app = {};

// ---------------------------------------------------------------- sheets (small dialogs inside the panel)

export function sheet({ title, body, buttons, wide = false, typing = false, onMount }) {
    return new Promise(resolve => {
        const layer = ui.root.querySelector('.cb_layer');
        const el = document.createElement('div');
        // a sheet you type into sits at the top, where the on-screen keyboard never covers it
        el.className = `cb_sheetwrap${typing ? ' cb_typing' : ''}`;
        el.innerHTML = `<div class="cb_sheet${wide ? ' cb_wide' : ''}" role="dialog" aria-modal="true">
            <div class="cb_sheethead"><b>${esc(title)}</b><button class="cb_iconbtn" data-x aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button></div>
            <div class="cb_sheetbody">${body}</div>
            <div class="cb_sheetfoot"></div>
        </div>`;
        layer.append(el);
        const close = v => { el.classList.add('cb_out'); setTimeout(() => el.remove(), 150); resolve(v); };
        el._close = () => close(null);
        el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-x]')) close(null); });
        const api = {
            el, close,
            body: el.querySelector('.cb_sheetbody'),
            setButtons(list) {
                const foot = el.querySelector('.cb_sheetfoot');
                foot.replaceChildren(...list.map(b => {
                    const btn = document.createElement('button');
                    btn.className = `cb_btn${b.primary ? ' cb_primary' : ''}${b.danger ? ' cb_dangerbtn' : ''}`;
                    btn.innerHTML = b.label;
                    if (b.disabled) btn.disabled = true;
                    btn.addEventListener('click', () => b.run(api, btn));
                    return btn;
                }));
            },
            setTitle(t) { el.querySelector('.cb_sheethead b').textContent = t; },
        };
        api.setButtons(buttons ?? []);
        onMount?.(api);
        requestAnimationFrame(() => el.classList.add('cb_in'));
    });
}

export function sheetConfirm({ title, body, ok = 'ตกลง', danger = false }) {
    return sheet({
        title, body,
        buttons: [
            { label: 'ยกเลิก', run: a => a.close(false) },
            { label: esc(ok), primary: !danger, danger, run: a => a.close(true) },
        ],
    });
}

export function sheetPrompt({ title, value = '', ok = 'ตกลง', hint = '' }) {
    return sheet({
        title,
        typing: true,
        body: `<input class="cb_input" type="text" value="${esc(value)}" spellcheck="false" autocomplete="off">${hint ? `<p class="cb_note">${hint}</p>` : ''}`,
        buttons: [
            { label: 'ยกเลิก', run: a => a.close(null) },
            { label: esc(ok), primary: true, run: a => a.close(a.body.querySelector('input').value) },
        ],
        onMount: a => {
            const input = a.body.querySelector('input');
            setTimeout(() => { input.focus({ preventScroll: true }); input.select(); }, 50);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); a.close(input.value); } });
        },
    });
}

export function sheetPick({ title, hint, items }) {
    return sheet({
        title,
        body: `${hint ? `<p class="cb_note">${hint}</p>` : ''}<div class="cb_picklist">${items.map((x, i) => `<button class="cb_pick${x.selected ? ' cb_on' : ''}" data-i="${i}">${x.html}</button>`).join('')}</div>`,
        buttons: [{ label: 'ยกเลิก', run: a => a.close(null) }],
        onMount: a => a.body.addEventListener('click', e => {
            const b = e.target.closest('[data-i]');
            if (b) a.close(items[Number(b.dataset.i)].value);
        }),
    });
}
