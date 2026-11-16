/*
 * Reverie — shared state and helpers used by every part (list, gallery, card editor).
 */

export const MODULE = 'chat_browser';
export const VERSION = '1.5.0'; // keep in sync with manifest.json
export const LOG = '[ChatBrowser]';
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
    scheme: 'theme',     // theme | light | dark — colours of the browser window
    gallerySize: 'large', // large | compact — cover size in the gallery
});

export const ctx = () => SillyTavern.getContext();

export function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    return s;
}
export const saveSettings = () => ctx().saveSettingsDebounced();

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const toast = {
    ok: (m, t) => globalThis.toastr?.success(m, t ?? 'Chat Browser'),
    info: (m, t) => globalThis.toastr?.info(m, t ?? 'Chat Browser'),
    warn: (m, t) => globalThis.toastr?.warning(m, t ?? 'Chat Browser'),
    err: (m, t) => globalThis.toastr?.error(m, t ?? 'Chat Browser'),
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
    try { return ctx().getThumbnailUrl(type, file); } catch { return ''; }
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
