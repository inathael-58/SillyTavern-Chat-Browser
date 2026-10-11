/*
 * Chat Browser — SillyTavern UI extension
 *
 * Every chat of every character and group in one list: open any of them in one tap,
 * see which chats continue one story, which persona a chat is tied to and how many
 * messages arrived since this device last looked. Pin, rename, delete, link parts of a
 * story, and run Sync / Clean Sync through Chat Auto Backup.
 */

import { buildEntries, cleanPreview, clip, compareText, fullTime, linkStories, relTime, renameInMeta, toMs } from './lib.js';

const MODULE = 'chat_browser';
const VERSION = '1.1.2'; // keep in sync with manifest.json
const LOG = '[ChatBrowser]';
const BASE_URL = new URL('.', import.meta.url);
const CACHE_KEY = 'cb_cache_v1';
const SEEN_KEY = 'cb_seen_v1';
const CHUNK = 80; // rows rendered at a time

const DEFAULTS = Object.freeze({
    view: 'normal',      // compact | normal | detail
    sort: 'recent',      // recent | character | name | size
    merge: true,         // one row per story
    pins: Object.freeze({}),
    pinsImported: false, // SillyTavern's own pinned chats copied in once
    launcher: true,      // floating button
    launcherPos: Object.freeze({ x: 0, y: 0.72, edge: 'left' }),
    launcherLook: null,  // filled from LOOK_DEFAULT
    topbar: true,        // icon in the top bar
});

const ctx = () => SillyTavern.getContext();

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = (v && typeof v === 'object') ? { ...v } : v;
    }
    return s;
}
const saveSettings = () => ctx().saveSettingsDebounced();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = {
    ok: (m, t) => globalThis.toastr?.success(m, t ?? 'Chat Browser'),
    info: (m, t) => globalThis.toastr?.info(m, t ?? 'Chat Browser'),
    warn: (m, t) => globalThis.toastr?.warning(m, t ?? 'Chat Browser'),
    err: (m, t) => globalThis.toastr?.error(m, t ?? 'Chat Browser'),
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const errText = e => String(e?.message ?? e);
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
const cab = () => (globalThis.ChatAutoBackup?.api >= 2 ? globalThis.ChatAutoBackup : null);

// SillyTavern functions that getContext() doesn't offer. Loaded on first use; each one
// has a plain-API fallback, so an older or newer SillyTavern without it still works.
let stMods = null;
async function st() {
    if (stMods) return stMods;
    stMods = {};
    try { Object.assign(stMods, await import('../../../../script.js')); } catch (e) { console.warn(LOG, 'script.js', e); }
    try {
        const g = await import('../../../group-chats.js');
        Object.assign(stMods, { openGroupById: g.openGroupById, editGroup: g.editGroup, deleteGroupChatByName: g.deleteGroupChatByName, renameGroupChat: g.renameGroupChat });
    } catch (e) { console.warn(LOG, 'group-chats.js', e); }
    return stMods;
}

// ---------------------------------------------------------------- display regex
//
// Presets and cards often print status lines (clock, scene, stats) that a regex script hides
// when the chat is shown. Previews run those hiding scripts too (the ones that replace their
// match with nothing). Scripts that turn the match into something — a status panel, a game
// widget with its own code — are skipped: the raw tags they work on are removed whole by
// cleanPreview, the same way Chat Auto Backup cleans its previews.

let regex = null; // { run, scriptsOf } once SillyTavern's regex engine is loaded
async function loadRegex() {
    if (regex) return regex;
    try {
        const m = await import('../../regex/engine.js');
        const base = () => {
            const list = [];
            try { list.push(...m.getScriptsByType(m.SCRIPT_TYPES.GLOBAL, { allowedOnly: true })); } catch { /* old ST */ }
            try { list.push(...m.getScriptsByType(m.SCRIPT_TYPES.PRESET, { allowedOnly: true })); } catch { /* no preset scripts */ }
            return list;
        };
        regex = {
            run: m.runRegexScript,
            base,
            scoped(avatar) {
                const ext = ctx().extensionSettings || {};
                if (!ext.character_allowed_regex?.includes?.(avatar)) return [];
                const sc = charOf(avatar)?.data?.extensions?.regex_scripts;
                return Array.isArray(sc) ? sc : [];
            },
        };
    } catch (e) {
        console.warn(LOG, 'regex engine not available', e);
        regex = { run: null };
    }
    return regex;
}

/** One pass of reading: the scripts that apply to display, computed once per list load. */
function displayRegexer() {
    if (!regex?.run) return (text) => text;
    const ok = s => s && !s.disabled && !s.promptOnly && Array.isArray(s.placement) && !String(s.replaceString ?? '').trim();
    const base = regex.base().filter(ok);
    const byAvatar = new Map();
    return (text, { avatar = null, user = false, name } = {}) => {
        let scripts = base;
        if (avatar) {
            if (!byAvatar.has(avatar)) byAvatar.set(avatar, [...base, ...regex.scoped(avatar).filter(ok)]);
            scripts = byAvatar.get(avatar);
        }
        const place = user ? 1 : 2; // USER_INPUT / AI_OUTPUT
        let out = String(text ?? '');
        for (const s of scripts) {
            if (!s.placement.includes(place)) continue;
            try { out = regex.run(s, out, { characterOverride: name }); } catch { /* a broken script: skip it */ }
        }
        return out;
    };
}

// ---------------------------------------------------------------- entities

function charOf(avatar) { return (ctx().characters || []).find(c => c.avatar === avatar); }
function charIndex(avatar) { return (ctx().characters || []).findIndex(c => c.avatar === avatar); }
function groupOf(id) { return (ctx().groups || []).find(g => String(g.id) === String(id)); }

function thumb(type, file) {
    try { return ctx().getThumbnailUrl(type, file); } catch { return ''; }
}

function personaName(id) {
    return ctx().powerUserSettings?.personas?.[id] || String(id ?? '').replace(/\.(png|webp|jpe?g)$/i, '');
}

/** The persona a chat is tied to: locked to the chat, or else connected to its character/group. */
function personaOf(c) {
    if (c.persona) return { id: c.persona, name: personaName(c.persona), locked: true };
    const descs = ctx().powerUserSettings?.persona_descriptions || {};
    for (const [id, d] of Object.entries(descs)) {
        if (d?.connections?.some(x => x?.id === c.entity && (x.type === (c.type === 'group' ? 'group' : 'character')))) {
            return { id, name: personaName(id), locked: false };
        }
    }
    return null;
}

function currentKey() {
    const c = ctx();
    const id = c.getCurrentChatId?.();
    if (!id) return null;
    if (c.groupId) return `g:${c.groupId}:${id}`;
    const ch = c.characters?.[c.characterId];
    return ch ? `c:${ch.avatar}:${id}` : null;
}

function isGenerating() {
    const el = document.getElementById('mes_stop');
    return !!el && getComputedStyle(el).display !== 'none';
}

// ---------------------------------------------------------------- data

const data = { chats: [], byKey: new Map(), at: 0, loading: null, error: '' };

function normalize(x, rx = t => t) {
    const c = ctx();
    const file = String(x?.file_name ?? '');
    const chatId = file.replace(/\.jsonl$/i, '');
    if (!chatId) return null;
    let type, entity, entityName;
    if (x.group) {
        const g = groupOf(x.group);
        if (!g) return null;
        type = 'group'; entity = String(g.id); entityName = g.name;
    } else {
        const ch = charOf(x.avatar);
        if (!ch) return null;
        type = 'character'; entity = ch.avatar; entityName = ch.name;
    }
    const meta = x.chat_metadata && typeof x.chat_metadata === 'object' ? x.chat_metadata : {};
    const mh = meta.memory_hub;
    const count = Number(x.chat_items) || 0;
    const raw = rx(String(x.mes ?? ''), { avatar: type === 'character' ? entity : null, name: entityName });
    const preview = count && !/^\[The (chat|message) is empty\]$/.test(raw) ? clip(cleanPreview(raw, { keepLines: true }).replace(/\n{2,}/g, '\n'), 1200) : '';
    const persona = typeof meta.persona === 'string' && meta.persona ? meta.persona : null;
    return {
        key: `${type === 'group' ? 'g' : 'c'}:${entity}:${chatId}`,
        type, entity, entityName, chatId,
        count,
        last: toMs(x.last_mes, c.timestampToMoment),
        size: String(x.file_size ?? ''),
        preview,
        noStory: !preview && count > 0 && !!raw.trim() && !/^\[The (chat|message) is empty\]$/.test(raw),
        persona,
        personaName: persona ? personaName(persona) : '',
        chain: Array.isArray(mh?.chain) ? mh.chain.map(String) : [],
        memories: Array.isArray(mh?.memories) ? mh.memories.length : 0,
        prev: typeof meta.chat_browser?.prev === 'string' ? meta.chat_browser.prev : null,
        mainChat: typeof meta.main_chat === 'string' && meta.main_chat ? meta.main_chat : null,
    };
}

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body ?? {}), cache: 'no-cache' });
    if (!res.ok) throw Object.assign(new Error(`${url} → ${res.status}`), { status: res.status });
    return res;
}

/** SillyTavern before 1.13 has no /api/chats/recent: ask per character and per group chat. */
async function fetchOldWay() {
    const c = ctx();
    const out = [];
    const jobs = [];
    for (const ch of c.characters || []) {
        jobs.push(async () => {
            const list = await (await post('/api/characters/chats', { avatar_url: ch.avatar, metadata: true })).json();
            if (Array.isArray(list)) for (const x of list) out.push({ ...x, avatar: ch.avatar });
        });
    }
    for (const g of c.groups || []) {
        for (const id of g.chats || []) {
            jobs.push(async () => {
                const x = await (await post('/api/chats/group/info', { id })).json();
                if (x?.file_name) out.push({ ...x, group: g.id });
            });
        }
    }
    const run = async () => { while (jobs.length) { try { await jobs.shift()(); } catch { /* skip that one */ } } };
    await Promise.all([run(), run(), run(), run()]);
    return out;
}

async function fetchChats() {
    let raw;
    try {
        raw = await (await post('/api/chats/recent', { metadata: true })).json();
    } catch (e) {
        if (e.status !== 404) throw e;
        raw = await fetchOldWay();
    }
    await loadRegex();
    const rx = displayRegexer();
    return (Array.isArray(raw) ? raw : []).map(x => normalize(x, rx)).filter(Boolean);
}

function setChats(list) {
    data.chats = list;
    data.byKey = new Map(list.map(x => [x.key, x]));
}

/** Reload the list from the server (one at a time; callers share the running load). */
function reload() {
    if (data.loading) return data.loading;
    ui.setLoading(true);
    data.loading = (async () => {
        try {
            const list = await fetchChats();
            setChats(list);
            data.at = Date.now();
            data.error = '';
            baselineSeen();
            lsSet(CACHE_KEY, { at: data.at, chats: list });
        } catch (e) {
            console.error(LOG, e);
            data.error = errText(e);
            toast.err(`โหลดรายชื่อแชทไม่สำเร็จ: ${data.error}`);
        } finally {
            data.loading = null;
            ui.setLoading(false);
            ui.render();
            updateLauncherBadge();
        }
    })();
    return data.loading;
}

function loadCache() {
    if (data.chats.length) return;
    const c = lsGet(CACHE_KEY, null);
    if (Array.isArray(c?.chats)) { setChats(c.chats); data.at = c.at || 0; }
}

// ---------------------------------------------------------------- unread (per device)
//
// For every chat, the number of messages it had when this device last had it open.
// The difference is what arrived since: from another device through sync, or from
// this one while the chat wasn't on screen.

const seen = lsGet(SEEN_KEY, null) ?? { init: 0, map: {} };
let seenTimer = null;
function saveSeen() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => lsSet(SEEN_KEY, seen), 400);
}

/** First load on this device: everything counts as read. Later, chats nobody looked at get a baseline. */
function baselineSeen() {
    const first = !seen.init;
    if (first) seen.init = Date.now();
    for (const c of data.chats) {
        if (seen.map[c.key] === undefined && (first || c.last <= seen.init)) seen.map[c.key] = c.count;
    }
    const cur = currentKey();
    if (cur) seen.map[cur] = ctx().chat?.length ?? seen.map[cur];
    saveSeen();
}

function unreadOf(c) {
    if (c.key === currentKey()) return 0;
    const s = seen.map[c.key];
    if (s === undefined) return seen.init && c.last > seen.init ? Math.max(1, c.count) : 0;
    return Math.max(0, c.count - s);
}

function markSeen(key, count) {
    if (!key) return;
    seen.map[key] = count;
    saveSeen();
}

function markCurrentSeen() {
    const key = currentKey();
    if (!key) return;
    const n = ctx().chat?.length ?? 0;
    markSeen(key, n);
    const c = data.byKey.get(key);
    if (c && n > c.count) c.count = n;
    updateLauncherBadge();
}

function totalUnread() {
    return data.chats.reduce((n, c) => n + (unreadOf(c) > 0 ? 1 : 0), 0);
}

// ---------------------------------------------------------------- reading / writing chat files

async function readChat(x) {
    if (x.type === 'group') return await (await post('/api/chats/group/get', { id: x.chatId })).json();
    const ch = charOf(x.entity);
    if (!ch) throw new Error('ไม่พบตัวละครของแชทนี้');
    const r = await (await post('/api/chats/get', { ch_name: ch.name, file_name: x.chatId, avatar_url: ch.avatar })).json();
    return Array.isArray(r) ? r : [];
}

async function writeChat(x, arr) {
    if (x.type === 'group') return post('/api/chats/group/save', { id: x.chatId, chat: arr, force: true });
    const ch = charOf(x.entity);
    return post('/api/chats/save', { ch_name: ch.name, file_name: x.chatId, chat: arr, avatar_url: ch.avatar, force: true });
}

/** Change a chat's metadata (open chat: in memory; any other: in its file). mutate returns true if it changed something. */
async function editChatMeta(x, mutate) {
    if (x.key === currentKey()) {
        const c = ctx();
        if (!mutate(c.chatMetadata)) return false;
        await c.saveMetadata?.();
    } else {
        const arr = await readChat(x);
        if (!arr.length) throw new Error('อ่านแชทไม่ได้');
        if (!arr[0] || 'mes' in arr[0]) arr.unshift({ chat_metadata: {}, user_name: 'unused', character_name: 'unused' });
        arr[0].chat_metadata ??= {};
        if (!mutate(arr[0].chat_metadata)) return false;
        await writeChat(x, arr);
    }
    try { await cab()?.noteServerChange?.({ type: x.type, avatar: x.entity, groupId: x.entity, chatId: x.chatId }); } catch (e) { console.warn(LOG, e); }
    return true;
}

// ---------------------------------------------------------------- actions

async function openChat(x) {
    const c = ctx();
    if (isGenerating()) { toast.warn('กำลังสร้างข้อความอยู่ — รอให้เสร็จหรือกดหยุดก่อน'); return false; }
    if (x.key === currentKey()) return true;
    const s = await st();
    markSeen(x.key, x.count);
    if (x.type === 'group') {
        const g = groupOf(x.entity);
        if (!g) throw new Error('ไม่พบกลุ่มนี้แล้ว');
        if (String(c.groupId) === String(g.id)) {
            await c.openGroupChat(g.id, x.chatId);
        } else if (s.openGroupById) {
            // Point the group at the chat first, so only that chat loads.
            const before = g.chat_id;
            g.chat_id = x.chatId;
            const ok = await s.openGroupById(g.id);
            if (ok === false && String(ctx().groupId) !== String(g.id)) { g.chat_id = before; throw new Error('เปิดกลุ่มไม่ได้ตอนนี้'); }
            s.setActiveGroup?.(g.id);
            if (ctx().getCurrentChatId?.() !== x.chatId) await c.openGroupChat(g.id, x.chatId);
            else await s.editGroup?.(g.id, true, false); // remember it as the group's last chat
        } else {
            throw new Error('SillyTavern รุ่นนี้เปิดแชทกลุ่มจากที่นี่ไม่ได้');
        }
    } else {
        const idx = charIndex(x.entity);
        if (idx < 0) throw new Error('ไม่พบตัวละครนี้แล้ว');
        const ch = c.characters[idx];
        if (String(c.characterId) === String(idx) && !c.groupId) {
            await c.openCharacterChat(x.chatId);
        } else {
            // Point the character at the chat first, so only that chat loads.
            const before = ch.chat;
            ch.chat = x.chatId;
            await c.selectCharacterById(idx);
            const now = ctx();
            if (String(now.characterId) !== String(idx) || now.groupId) { ch.chat = before; throw new Error('เปลี่ยนตัวละครไม่ได้ตอนนี้ (กำลังบันทึกแชทอยู่?) ลองอีกครั้ง'); }
            s.setActiveCharacter?.(ch.avatar);
            if (now.getCurrentChatId?.() !== x.chatId) await now.openCharacterChat(x.chatId);
            else if (before !== x.chatId) await rememberCharacterChat(idx, x.chatId); // so a reload opens this chat too
        }
    }
    c.saveSettingsDebounced();
    return true;
}

async function rememberCharacterChat(idx, chatId) {
    const s = await st();
    if (s.updateRemoteChatName) return s.updateRemoteChatName(idx, chatId);
    const ch = ctx().characters[idx];
    ch.chat = chatId;
    await post('/api/characters/merge-attributes', { avatar: ch.avatar, chat: chatId }).catch(() => {});
}

function siblings(x) {
    return data.chats.filter(c => c.type === x.type && c.entity === x.entity && c.key !== x.key);
}

async function renameChat(x, wanted) {
    const name = String(wanted ?? '').trim();
    if (!name || name === x.chatId) return null;
    if (/[\\/:*?"<>|]/.test(name)) throw new Error('ชื่อแชทใช้ตัวอักษร \\ / : * ? " < > | ไม่ได้');
    if (siblings(x).some(c => c.chatId.toLowerCase() === name.toLowerCase())) throw new Error('มีแชทชื่อนี้อยู่แล้ว');
    const c = ctx();
    const isGroup = x.type === 'group';
    if (x.key === currentKey() && typeof c.renameChat === 'function') {
        await c.renameChat(x.chatId, name); // SillyTavern's own: reloads the open chat and announces the rename
        if (!c.eventTypes?.CHAT_RENAMED) await afterRename({ avatarId: isGroup ? undefined : x.entity, groupId: isGroup ? x.entity : undefined, oldFileName: `${x.chatId}.jsonl`, newFileName: `${name}.jsonl` }, true);
        return name;
    }
    const s = await st();
    const res = await post('/api/chats/rename', {
        is_group: isGroup,
        avatar_url: isGroup ? undefined : x.entity,
        original_file: `${x.chatId}.jsonl`,
        renamed_file: `${name}.jsonl`,
    }).catch(e => { throw new Error(e.status === 400 ? 'เปลี่ยนชื่อไม่ได้ (อาจมีแชทชื่อนี้อยู่แล้ว)' : errText(e)); });
    const out = await res.json().catch(() => ({}));
    if (out?.error) throw new Error('เปลี่ยนชื่อไม่สำเร็จ');
    const finalName = String(out?.sanitizedFileName || name);
    if (isGroup) {
        const g = groupOf(x.entity);
        if (s.renameGroupChat) await s.renameGroupChat(x.entity, x.chatId, finalName);
        else if (g) {
            g.chats = (g.chats || []).map(id => (id === x.chatId ? finalName : id));
            if (g.chat_id === x.chatId) g.chat_id = finalName;
            await post('/api/groups/edit', g);
        }
    } else {
        const idx = charIndex(x.entity);
        if (idx >= 0 && c.characters[idx].chat === x.chatId) await rememberCharacterChat(idx, finalName);
    }
    const ev = { avatarId: isGroup ? undefined : x.entity, groupId: isGroup ? x.entity : undefined, oldFileName: `${x.chatId}.jsonl`, newFileName: `${finalName}.jsonl` };
    if (c.eventTypes?.CHAT_RENAMED) await c.eventSource.emit(c.eventTypes.CHAT_RENAMED, ev);
    else await afterRename(ev, true);
    return finalName;
}

/**
 * After any rename (here or in SillyTavern): carry pins, unread state and story links over
 * to the new name. own: also tell Chat Auto Backup (SillyTavern without the rename event).
 */
async function afterRename({ avatarId, groupId, oldFileName, newFileName } = {}, own = false) {
    const strip = n => String(n ?? '').replace(/\.jsonl$/i, '');
    const oldId = strip(oldFileName), newId = strip(newFileName);
    if (!oldId || !newId || oldId === newId) return;
    const type = groupId ? 'group' : 'character';
    const entity = String(groupId || avatarId || '');
    const p = type === 'group' ? 'g' : 'c';
    const oldKey = `${p}:${entity}:${oldId}`, newKey = `${p}:${entity}:${newId}`;
    const s = settings();
    if (s.pins[oldKey]) { s.pins[newKey] = s.pins[oldKey]; delete s.pins[oldKey]; saveSettings(); }
    if (seen.map[oldKey] !== undefined) { seen.map[newKey] = seen.map[oldKey]; delete seen.map[oldKey]; saveSeen(); }
    const item = data.byKey.get(oldKey);
    if (item) { data.byKey.delete(oldKey); item.key = newKey; item.chatId = newId; data.byKey.set(newKey, item); }
    if (own) { try { await cab()?.onChatRenamed?.({ avatarId, groupId, oldFileName, newFileName }); } catch (e) { console.warn(LOG, e); } }
    // Chats that point at the old name (story parts, branches) now point at the new one.
    const refs = data.chats.filter(c => c.type === type && c.entity === entity && c.key !== newKey
        && (c.chain.includes(oldId) || c.prev === oldId || c.mainChat === oldId));
    for (const c of refs) {
        try {
            await editChatMeta(c, meta => renameInMeta(meta, oldId, newId));
            c.chain = c.chain.map(id => (id === oldId ? newId : id));
            if (c.prev === oldId) c.prev = newId;
            if (c.mainChat === oldId) c.mainChat = newId;
        } catch (e) {
            console.warn(LOG, 'relink', c.key, e);
            toast.warn(`แก้ลิงก์ภาคต่อในแชท "${c.chatId}" ไม่สำเร็จ: ${errText(e)}`);
        }
    }
    ui.render();
}

/** Leave the open chat before it is deleted: the newest other chat of the same character/group, or a new one. */
async function leaveChat(x) {
    const other = siblings(x).sort((a, b) => b.last - a.last)[0];
    if (other) { await openChat(other); return; }
    await ctx().executeSlashCommandsWithOptions('/newchat');
    for (let i = 0; i < 40 && currentKey() === x.key; i++) await wait(150);
}

async function deleteChat(x) {
    const s = await st();
    const c = ctx();
    if (x.key === currentKey()) {
        if (isGenerating()) throw new Error('กำลังสร้างข้อความในแชทนี้อยู่');
        await leaveChat(x);
        if (currentKey() === x.key) throw new Error('ออกจากแชทนี้ไม่ได้ จึงยังไม่ลบ');
    }
    if (x.type === 'group') {
        if (s.deleteGroupChatByName) await s.deleteGroupChatByName(x.entity, x.chatId);
        else {
            await post('/api/chats/group/delete', { id: x.chatId });
            const g = groupOf(x.entity);
            if (g) { g.chats = (g.chats || []).filter(id => id !== x.chatId); await post('/api/groups/edit', g); }
            await c.eventSource.emit(c.eventTypes.GROUP_CHAT_DELETED, x.chatId);
        }
    } else {
        const idx = charIndex(x.entity);
        if (s.deleteCharacterChatByName && idx >= 0) await s.deleteCharacterChatByName(String(idx), x.chatId);
        else {
            await post('/api/chats/delete', { chatfile: `${x.chatId}.jsonl`, avatar_url: x.entity });
            await c.eventSource.emit(c.eventTypes.CHAT_DELETED, x.chatId);
        }
    }
    const set = settings();
    if (set.pins[x.key]) { delete set.pins[x.key]; saveSettings(); }
    delete seen.map[x.key];
    saveSeen();
    setChats(data.chats.filter(c2 => c2.key !== x.key));
}

function togglePin(keys, on) {
    const s = settings();
    for (const k of keys) {
        if (on) s.pins[k] = Date.now(); else delete s.pins[k];
    }
    saveSettings();
}

async function setPrev(x, prevId) {
    await editChatMeta(x, meta => {
        if (prevId) {
            meta.chat_browser = { ...(meta.chat_browser || {}), prev: prevId };
        } else {
            if (!meta.chat_browser?.prev) return false;
            delete meta.chat_browser.prev;
        }
        return true;
    });
    x.prev = prevId || null;
}

/** Older SillyTavern pins (Recent Chats on the welcome screen) — copied in once. */
function importStPins() {
    const s = settings();
    if (s.pinsImported) return;
    s.pinsImported = true;
    try {
        const raw = ctx().accountStorage?.getItem?.('pinnedChats');
        const pins = raw ? JSON.parse(raw) : {};
        for (const p of Object.values(pins || {})) {
            const id = String(p?.file_name ?? '').replace(/\.jsonl$/i, '');
            if (!id) continue;
            const key = p.group ? `g:${p.group}:${id}` : p.avatar ? `c:${p.avatar}:${id}` : null;
            if (key && !s.pins[key]) s.pins[key] = Date.now();
        }
    } catch (e) { console.warn(LOG, 'pins', e); }
    saveSettings();
}

// ---------------------------------------------------------------- UI

const VIEWS = [
    ['compact', 'fa-solid fa-bars', 'กะทัดรัด — ชื่อแชทอย่างเดียว'],
    ['normal', 'fa-solid fa-list', 'ปกติ — ตัวอย่างเนื้อหา 2 บรรทัด'],
    ['detail', 'fa-solid fa-align-left', 'ละเอียด — อ่านข้อความล่าสุดได้ยาว'],
];
const SORTS = [['recent', 'ล่าสุด'], ['character', 'ตัวละคร'], ['name', 'ชื่อ'], ['size', 'ยาวสุด']];

const ui = {
    root: null,
    query: '',
    filter: 'all',      // all | unread | pinned | group
    entity: null,       // "type|entity" — only this character/group
    persona: null,
    selecting: false,
    selected: new Set(),
    collapsed: new Set(), // character sections folded
    expanded: new Set(),  // stories showing their older parts
    history: new Map(),   // key → loaded recent messages (detail view)
    entries: [],
    shown: 0,
    observer: null,
    busy: false,

    setLoading(on) {
        this.root?.querySelector('.cb_spin')?.toggleAttribute('hidden', !on);
    },

    render() {
        if (!this.root) return;
        const s = settings();
        this.root.dataset.view = s.view;
        this.root.classList.toggle('cb_selecting', this.selecting);
        this.entries = buildEntries(data.chats, {
            sort: s.sort, merge: s.merge, query: this.query, filter: this.filter,
            entity: this.entity, persona: this.persona, pins: s.pins, unreadOf,
        });
        this.renderControls();
        const list = this.root.querySelector('.cb_list');
        const top = list.scrollTop;
        this.observer?.disconnect();
        this.shown = 0;
        list.replaceChildren();
        if (!this.entries.length) {
            list.innerHTML = this.emptyHtml();
        } else {
            this.more();
        }
        list.scrollTop = top;
        this.renderSelbar();
    },

    emptyHtml() {
        if (!data.chats.length && (data.loading || !data.at)) return '<div class="cb_empty"><i class="fa-solid fa-circle-notch fa-spin"></i><span>กำลังโหลดรายชื่อแชท…</span></div>';
        if (data.error && !data.chats.length) return `<div class="cb_empty"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(data.error)}</span></div>`;
        if (this.query) return `<div class="cb_empty"><i class="fa-solid fa-magnifying-glass"></i><span>ไม่พบแชทที่ตรงกับ “${esc(this.query)}”</span></div>`;
        if (this.filter === 'unread') return '<div class="cb_empty"><i class="fa-solid fa-check-double"></i><span>อ่านครบทุกแชทแล้ว</span></div>';
        if (this.filter === 'pinned') return '<div class="cb_empty"><i class="fa-solid fa-thumbtack"></i><span>ยังไม่ได้ปักหมุดแชทไหน<br><small>กด ⋯ ที่แชทแล้วเลือก “ปักหมุด”</small></span></div>';
        return '<div class="cb_empty"><i class="fa-regular fa-comments"></i><span>ไม่มีแชท</span></div>';
    },

    /** Append the next chunk of rows; a sentinel at the end loads more while scrolling. */
    more() {
        const list = this.root.querySelector('.cb_list');
        list.querySelector('.cb_sentinel')?.remove();
        const from = this.shown;
        const to = Math.min(this.entries.length, from + CHUNK);
        let collapsedSection = null;
        // A folded character section hides its rows even across chunk boundaries.
        for (let i = from - 1; i >= 0; i--) {
            const e = this.entries[i];
            if (e.kind === 'section') { collapsedSection = this.collapsed.has(e.id) ? e.id : null; break; }
        }
        const html = [];
        for (let i = from; i < to; i++) {
            const e = this.entries[i];
            if (e.kind === 'section') {
                collapsedSection = this.collapsed.has(e.id) ? e.id : null;
                html.push(this.sectionHtml(e));
            } else if (!collapsedSection) {
                html.push(this.rowHtml(e));
            }
        }
        list.insertAdjacentHTML('beforeend', html.join(''));
        this.shown = to;
        if (to < this.entries.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'cb_sentinel';
            list.append(sentinel);
            this.observer ??= new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) this.more(); }, { root: list, rootMargin: '600px' });
            this.observer.observe(sentinel);
        }
    },

    sectionHtml(e) {
        const folded = this.collapsed.has(e.id);
        const ava = e.head ? this.avatarHtml(e.head, 'cb_sec_ava') : `<span class="cb_sec_icon"><i class="fa-solid ${e.id === 'pinned' ? 'fa-thumbtack' : e.id === 'all' ? 'fa-clock' : 'fa-folder'}"></i></span>`;
        const foldable = !!e.entity;
        return `<div class="cb_section${foldable ? ' cb_foldable' : ''}${folded ? ' cb_folded' : ''}" data-sec="${esc(e.id)}"${foldable ? ' role="button" tabindex="0"' : ''}>
            ${ava}<span class="cb_sec_title">${esc(e.title)}</span><span class="cb_sec_count">${e.count}</span>
            ${e.unread ? `<span class="cb_badge">${e.unread}</span>` : ''}
            ${foldable ? `<span class="cb_sec_only" data-only="${esc(e.entity)}" title="ดูเฉพาะ ${esc(e.title)}"><i class="fa-solid fa-filter"></i></span><i class="fa-solid fa-chevron-down cb_chev"></i>` : ''}
        </div>`;
    },

    avatarHtml(c, cls = 'cb_ava') {
        if (c.type === 'group') {
            const g = groupOf(c.entity);
            const url = g?.avatar_url;
            if (url && /^(data:|https?:|\/)/.test(url)) return `<div class="${cls}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></div>`;
            const members = (g?.members || []).slice(0, 4);
            return `<div class="${cls} cb_collage" data-n="${members.length}">${members.map(m => `<img src="${esc(thumb('avatar', m))}" alt="" loading="lazy" decoding="async">`).join('') || '<i class="fa-solid fa-users"></i>'}</div>`;
        }
        return `<div class="${cls}"><img src="${esc(thumb('avatar', c.entity))}" alt="" loading="lazy" decoding="async"></div>`;
    },

    rowHtml(e) {
        const c = e.chat;
        const s = settings();
        const cur = currentKey();
        const isOpen = c.key === cur || e.story?.parts.some(p => p.key === cur);
        const persona = personaOf(c);
        const part = e.part?.part > 1 || e.story ? e.part?.part : 0;
        const db = this.cloudHtml(c);
        const selected = this.selected.has(c.key);
        const pinned = !!s.pins[c.key] || e.pinned;
        const preview = c.preview || (c.count ? '' : 'แชทว่าง');
        const branchOf = c.mainChat && c.mainChat !== c.chatId ? c.mainChat : '';
        const expanded = this.expanded.has(c.key);
        const parts = e.story?.parts ?? [];
        const showParts = parts.length > 1;
        const compact = s.view === 'compact';
        const hist = this.history.get(c.key);
        return `<div class="cb_row${isOpen ? ' cb_isopen' : ''}${e.unread ? ' cb_unread' : ''}${selected ? ' cb_selected' : ''}" data-key="${esc(c.key)}" role="listitem" tabindex="0">
            <span class="cb_check"><i class="fa-solid fa-check"></i></span>
            ${this.avatarHtml(c)}
            <div class="cb_main">
                <div class="cb_l1">
                    <span class="cb_name" title="${esc(c.chatId)}">${pinned ? '<i class="fa-solid fa-thumbtack cb_pin"></i>' : ''}${esc(c.chatId)}</span>
                    ${part && e.story && !compact ? `<button class="cb_pill cb_part cb_partsbtn${expanded ? ' cb_on' : ''}" data-parts="1" title="เรื่องต่อเนื่อง ${parts.length} แชท · รวม ${e.story.total} ข้อความ — แตะเพื่อดูทุกภาค"><i class="fa-solid fa-link"></i>ภาค ${part}/${parts.length}<i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'} cb_pchev"></i></button>`
                        : part && !e.story ? '<span class="cb_pill cb_part" title="ภาคต่อของแชทก่อนหน้า (แชทก่อนหน้าถูกลบหรือเปลี่ยนชื่อแล้ว)"><i class="fa-solid fa-link"></i>ภาค ' + part + '</span>' : ''}
                    ${showParts && compact ? this.chipsHtml(parts, c, cur, true) : ''}
                    ${branchOf ? `<span class="cb_pill cb_branch" title="แตกกิ่งมาจาก ${esc(branchOf)}"><i class="fa-solid fa-code-branch"></i>กิ่ง</span>` : ''}
                    <span class="cb_time" title="${esc(fullTime(c.last))}">${esc(relTime(c.last))}</span>
                </div>
                <div class="cb_l2">
                    <span class="cb_char">${c.type === 'group' ? '<i class="fa-solid fa-users"></i>' : ''}${esc(c.entityName)}</span>
                    ${persona ? `<span class="cb_persona${persona.locked ? '' : ' cb_soft'}" title="${persona.locked ? 'แชทนี้ผูกกับ persona' : 'persona ที่ผูกกับตัวละครนี้ (แชทนี้ไม่ได้ล็อกไว้)'}: ${esc(persona.name)}"><img src="${esc(thumb('persona', persona.id))}" alt="" loading="lazy">${esc(persona.name)}</span>` : ''}
                    ${isOpen ? '<span class="cb_opentag">เปิดอยู่</span>' : ''}
                </div>
                ${preview ? `<div class="cb_preview">${esc(preview)}</div>`
                    : c.noStory ? '<div class="cb_preview cb_nostory">ข้อความล่าสุดไม่มีบทบรรยาย (หน้าจอเกมหรือข้อมูลระบบ) — กด “ดูข้อความก่อนหน้า”</div>' : ''}
                ${hist ? this.historyHtml(hist) : ''}
                ${showParts && !compact && !expanded ? this.chipsHtml(parts, c, cur, false) : ''}
                ${showParts && expanded ? this.partsListHtml(parts, cur) : ''}
                <div class="cb_meta">
                    <span><i class="fa-regular fa-message"></i>${c.count} ข้อความ${e.story ? ` · ทั้งเรื่อง ${e.story.total}` : ''}</span>
                    ${c.size ? `<span><i class="fa-regular fa-file"></i>${esc(c.size)}</span>` : ''}
                    ${c.memories ? `<span title="ความจำของ Memory Hub"><i class="fa-solid fa-brain"></i>${c.memories} ก้อน</span>` : ''}
                    ${db}
                    ${c.count > 1 && !hist ? '<button class="cb_hist" data-hist="1"><i class="fa-solid fa-clock-rotate-left"></i>ดูข้อความก่อนหน้า</button>' : ''}
                </div>
            </div>
            <div class="cb_side">
                ${e.unread ? `<span class="cb_badge" title="ข้อความใหม่ตั้งแต่เปิดแชทนี้ครั้งล่าสุดในเครื่องนี้">+${e.unread > 999 ? '999' : e.unread}</span>` : ''}
                ${db ? `<span class="cb_cloudmini">${db}</span>` : ''}
                <button class="cb_iconbtn cb_more" title="ตัวเลือก" aria-label="ตัวเลือก"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
        </div>`;
    },

    /** One button per part of the story; tap opens that part. */
    chipsHtml(parts, head, cur, short) {
        // Compact rows keep to one line: the last three parts, plus a button for the full list.
        const hidden = short && parts.length > 3 ? parts.length - 3 : 0;
        const shown = hidden ? parts.slice(-3) : parts;
        const more = short ? `<button class="cb_partchip cb_partsbtn${this.expanded.has(head.key) ? ' cb_on' : ''}" data-parts="1" title="ทุกภาค (${parts.length})">${hidden ? `+${hidden}` : '<i class="fa-solid fa-link"></i>'}</button>` : '';
        return `<div class="cb_parts${short ? ' cb_parts_inline' : ''}">${more}${shown.map(p => {
            const pp = linkInfo.get(p.key)?.part ?? 1;
            const u = unreadOf(p);
            return `<button class="cb_partchip${p.key === head.key ? ' cb_on' : ''}${p.key === cur ? ' cb_cur' : ''}" data-open="${esc(p.key)}" title="ภาค ${pp}: ${esc(p.chatId)} · ${p.count} ข้อความ · ${esc(relTime(p.last))}">${short ? '' : 'ภาค '}${pp}${u ? `<b>+${u}</b>` : ''}</button>`;
        }).join(short ? '' : '<i class="fa-solid fa-angle-right cb_partsep"></i>')}</div>`;
    },

    /** Every part with its name, size and age, newest first; tap opens it. */
    partsListHtml(parts, cur) {
        return `<div class="cb_partlist">${[...parts].reverse().map(p => {
            const pp = linkInfo.get(p.key)?.part ?? 1;
            const u = unreadOf(p);
            return `<button class="cb_partrow${p.key === cur ? ' cb_cur' : ''}" data-open="${esc(p.key)}">
                <span class="cb_pnum">${pp}</span>
                <span class="cb_pmain"><b>${esc(p.chatId)}</b><small>${p.count} ข้อความ · ${esc(relTime(p.last))}${p.key === cur ? ' · เปิดอยู่' : ''}</small></span>
                ${u ? `<span class="cb_badge">+${u}</span>` : ''}
                <i class="fa-solid fa-chevron-right cb_pgo"></i>
            </button>`;
        }).join('')}</div>`;
    },

    cloudHtml(c) {
        const info = cab()?.cloudInfo?.(c.key);
        if (!info?.sent) return '';
        const n = info.sent.count;
        const ok = n >= c.count;
        return `<span class="cb_cloud${ok ? ' cb_ok' : ''}" title="${ok ? `Dropbox มีครบถึงข้อความ #${n - 1}` : `Dropbox มีถึงข้อความ #${n - 1} (แชทนี้มีถึง #${c.count - 1})`}"><i class="fa-solid fa-cloud"></i>${ok ? '<i class="fa-solid fa-check"></i>' : `#${n - 1}`}</span>`;
    },

    historyHtml(h) {
        if (h === 'loading') return '<div class="cb_history"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
        if (typeof h === 'string') return `<div class="cb_history cb_err">${esc(h)}</div>`;
        return `<div class="cb_history">${h.map(m => `<div class="cb_hmsg${m.user ? ' cb_huser' : ''}"><b>${esc(m.name)}</b><span>${esc(m.text)}</span></div>`).join('')}</div>`;
    },

    renderControls() {
        const r = this.root;
        const s = settings();
        r.querySelectorAll('.cb_sort [data-sort]').forEach(b => b.classList.toggle('cb_on', b.dataset.sort === s.sort));
        r.querySelectorAll('.cb_view [data-view]').forEach(b => b.classList.toggle('cb_on', b.dataset.view === s.view));
        const unread = totalUnread();
        const groupsN = data.chats.filter(c => c.type === 'group').length;
        const pinsN = data.chats.filter(c => s.pins[c.key]).length;
        const cur = currentKey();
        const curChat = cur && data.byKey.get(cur);
        const ent = this.entity ? data.chats.find(c => `${c.type}|${c.entity}` === this.entity) : null;
        const personas = [...new Map(data.chats.filter(c => c.persona).map(c => [c.persona, c.personaName])).entries()].sort((a, b) => compareText(a[1], b[1]));
        const chip = (id, label, n, icon) => `<button class="cb_chip${this.filter === id ? ' cb_on' : ''}" data-filter="${id}">${icon ? `<i class="${icon}"></i>` : ''}${label}${n ? `<span>${n}</span>` : ''}</button>`;
        r.querySelector('.cb_chips').innerHTML = [
            chip('all', 'ทั้งหมด', 0),
            chip('unread', 'มีข้อความใหม่', unread, 'fa-solid fa-circle'),
            chip('pinned', 'ปักหมุด', pinsN, 'fa-solid fa-thumbtack'),
            groupsN ? chip('group', 'แชทกลุ่ม', 0, 'fa-solid fa-users') : '',
            ent ? `<button class="cb_chip cb_on cb_entchip" data-entity="">${esc(ent.entityName)}<i class="fa-solid fa-xmark"></i></button>`
                : curChat ? `<button class="cb_chip" data-entity="${esc(`${curChat.type}|${curChat.entity}`)}"><i class="fa-solid fa-user"></i>เฉพาะ ${esc(curChat.entityName)}</button>` : '',
            personas.length > 1 ? `<label class="cb_chip cb_selchip${this.persona ? ' cb_on' : ''}"><i class="fa-solid fa-masks-theater"></i><select class="cb_persona_sel"><option value="">ทุก persona</option>${personas.map(([id, n]) => `<option value="${esc(id)}"${this.persona === id ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : '',
            `<button class="cb_chip cb_toggle${s.merge ? ' cb_on' : ''}" data-merge="1" title="รวมแชทที่ต่อเรื่องกันเป็นแถวเดียว"><i class="fa-solid fa-link"></i>รวมภาคต่อ</button>`,
        ].join('');
        const shownChats = this.entries.filter(e => e.kind === 'chat').length;
        r.querySelector('.cb_total').textContent = shownChats === data.chats.length || !data.chats.length ? `${data.chats.length}` : `${shownChats}/${data.chats.length}`;
        this.renderSync();
    },

    renderSync() {
        const r = this.root;
        if (!r) return;
        const a = cab();
        const on = !!a?.dropboxConnected?.();
        const synced = on && a.syncInUse?.();
        const st0 = on ? a.syncState?.() : null;
        for (const b of r.querySelectorAll('.cb_sync, .cb_clean')) {
            b.hidden = !a;
            b.classList.toggle('cb_disabled', !on || (b.classList.contains('cb_clean') && !synced));
        }
        const syncBtn = r.querySelector('.cb_sync');
        syncBtn.title = !a ? '' : !on ? 'เชื่อมต่อ Dropbox ใน Chat Auto Backup ก่อน' : `ซิงค์กับ Dropbox ตามปกติ${st0?.lastAt ? ` · ล่าสุด ${new Date(st0.lastAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : ''}${st0?.decisions ? ` · รอเลือก ${st0.decisions} รายการ` : ''}`;
        syncBtn.classList.toggle('cb_working', !!st0?.running || this.busy === 'sync');
        syncBtn.querySelector('.cb_dot')?.toggleAttribute('hidden', !st0?.decisions && !st0?.error);
        r.querySelector('.cb_clean').title = !on ? 'เชื่อมต่อ Dropbox ใน Chat Auto Backup ก่อน' : !synced ? 'ใช้ได้เมื่อเปิดซิงค์แชทระหว่างเครื่องใน Chat Auto Backup แล้ว (กดซิงค์อย่างน้อยหนึ่งครั้ง)' : 'ทำให้ Dropbox และทุกเครื่องมีแชทเหมือนเครื่องนี้เป๊ะ';
    },

    renderSelbar() {
        const bar = this.root?.querySelector('.cb_selbar');
        if (!bar) return;
        bar.hidden = !this.selecting;
        if (!this.selecting) return;
        const n = this.selected.size;
        bar.querySelector('.cb_selcount').textContent = n ? `เลือก ${n} แชท` : 'แตะแชทเพื่อเลือก';
        bar.querySelectorAll('[data-bulk]').forEach(b => b.classList.toggle('cb_disabled', !n));
    },
};

let linkInfo = new Map(); // key → story info, refreshed with every render
const _render = ui.render.bind(ui);
ui.render = function () {
    linkInfo = linkStories(data.chats);
    _render();
};

function chatFromRow(row) {
    return row ? data.byKey.get(row.dataset.key) : null;
}

function openBrowser() {
    if (ui.root) { ui.root.querySelector('.cb_search')?.focus(); return; }
    loadCache();
    importStPins();
    const s = settings();
    const root = document.createElement('div');
    root.id = 'cb_root';
    root.className = 'cb_root';
    root.innerHTML = `
        <div class="cb_backdrop"></div>
        <section class="cb_panel" role="dialog" aria-modal="true" aria-label="Chat Browser">
            <header class="cb_head">
                <div class="cb_titlebar">
                    <div class="cb_title"><i class="fa-solid fa-comments"></i><b>แชท</b><span class="cb_total"></span><i class="fa-solid fa-circle-notch fa-spin cb_spin" hidden></i></div>
                    <div class="cb_tools">
                        <button class="cb_tool cb_sync" hidden><i class="fa-solid fa-rotate"></i><span>Sync</span><i class="cb_dot" hidden></i></button>
                        <button class="cb_tool cb_clean" hidden><i class="fa-solid fa-broom"></i><span>Clean Sync</span></button>
                        <button class="cb_tool cb_selectbtn" title="เลือกหลายแชท"><i class="fa-regular fa-square-check"></i></button>
                        <button class="cb_tool cb_closebtn" title="ปิด (Esc)" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <label class="cb_searchrow">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" class="cb_search" placeholder="ค้นหาชื่อแชท ตัวละคร persona หรือเนื้อหา" autocomplete="off" spellcheck="false">
                    <button class="cb_clearq" title="ล้าง" hidden><i class="fa-solid fa-circle-xmark"></i></button>
                </label>
                <div class="cb_controls">
                    <div class="cb_seg cb_sort" role="tablist">${SORTS.map(([id, label]) => `<button data-sort="${id}" role="tab">${label}</button>`).join('')}</div>
                    <div class="cb_seg cb_view">${VIEWS.map(([id, icon, tip]) => `<button data-view="${id}" title="${tip}" aria-label="${tip}"><i class="${icon}"></i></button>`).join('')}</div>
                </div>
                <div class="cb_chips"></div>
            </header>
            <div class="cb_list" role="list"></div>
            <footer class="cb_selbar" hidden>
                <span class="cb_selcount"></span>
                <button data-bulk="pin"><i class="fa-solid fa-thumbtack"></i>ปักหมุด</button>
                <button data-bulk="unpin">เลิกปัก</button>
                <button data-bulk="read"><i class="fa-solid fa-check-double"></i>อ่านแล้ว</button>
                <button data-bulk="delete" class="cb_danger"><i class="fa-solid fa-trash"></i>ลบ</button>
                <button data-bulk="done">เสร็จ</button>
            </footer>
            <div class="cb_layer"></div>
        </section>`;
    document.body.append(root);
    ui.root = root;
    fitViewport();
    root.dataset.view = s.view;
    wireBrowser(root);
    ui.render();
    requestAnimationFrame(() => root.classList.add('cb_in'));
    if (!matchMedia('(pointer: coarse)').matches) root.querySelector('.cb_search').focus();
    reload();
}

function closeBrowser() {
    const root = ui.root;
    if (!root) return;
    ui.root = null;
    ui.observer?.disconnect();
    ui.observer = null;
    ui.selecting = false;
    ui.selected.clear();
    ui.history.clear();
    window.visualViewport?.removeEventListener('resize', fitViewport);
    window.visualViewport?.removeEventListener('scroll', fitViewport);
    window.removeEventListener('resize', fitViewport);
    root.classList.remove('cb_in');
    root.classList.add('cb_out');
    setTimeout(() => root.remove(), 180);
}

/** Size the overlay to the visible viewport, so the on-screen keyboard never hides the list. */
function fitViewport() {
    const r = ui.root;
    if (!r) return;
    const vv = window.visualViewport;
    r.style.top = `${vv ? vv.offsetTop : 0}px`;
    r.style.left = `${vv ? vv.offsetLeft : 0}px`;
    r.style.width = `${vv ? vv.width : window.innerWidth}px`;
    r.style.height = `${vv ? vv.height : window.innerHeight}px`;
    if (!r.dataset.fitWired) {
        r.dataset.fitWired = '1';
        vv?.addEventListener('resize', fitViewport);
        vv?.addEventListener('scroll', fitViewport);
        window.addEventListener('resize', fitViewport);
    }
}

function wireBrowser(root) {
    const s = settings();
    const list = root.querySelector('.cb_list');
    const search = root.querySelector('.cb_search');
    const clearq = root.querySelector('.cb_clearq');

    root.querySelector('.cb_backdrop').addEventListener('click', closeBrowser);
    root.querySelector('.cb_closebtn').addEventListener('click', closeBrowser);

    let qTimer = null;
    search.addEventListener('input', () => {
        clearq.hidden = !search.value;
        clearTimeout(qTimer);
        qTimer = setTimeout(() => { ui.query = search.value; ui.render(); list.scrollTop = 0; }, 120);
    });
    clearq.addEventListener('click', e => { e.preventDefault(); search.value = ''; clearq.hidden = true; ui.query = ''; ui.render(); search.focus(); });

    root.querySelector('.cb_sort').addEventListener('click', e => {
        const b = e.target.closest('[data-sort]');
        if (!b) return;
        s.sort = b.dataset.sort; saveSettings(); ui.render(); list.scrollTop = 0;
    });
    root.querySelector('.cb_view').addEventListener('click', e => {
        const b = e.target.closest('[data-view]');
        if (!b) return;
        s.view = b.dataset.view; saveSettings(); ui.render();
    });
    root.querySelector('.cb_chips').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.filter) ui.filter = ui.filter === b.dataset.filter && b.dataset.filter !== 'all' ? 'all' : b.dataset.filter;
        else if (b.dataset.entity !== undefined) ui.entity = b.dataset.entity || null;
        else if (b.dataset.merge) { s.merge = !s.merge; saveSettings(); }
        ui.render();
        list.scrollTop = 0;
    });
    root.querySelector('.cb_chips').addEventListener('change', e => {
        if (!e.target.matches('.cb_persona_sel')) return;
        ui.persona = e.target.value || null;
        ui.render();
    });

    root.querySelector('.cb_sync').addEventListener('click', () => runSync());
    root.querySelector('.cb_clean').addEventListener('click', () => openCleanSync());
    root.querySelector('.cb_selectbtn').addEventListener('click', () => setSelecting(!ui.selecting));
    root.querySelector('.cb_selbar').addEventListener('click', e => {
        const b = e.target.closest('[data-bulk]');
        if (b && !b.classList.contains('cb_disabled')) bulk(b.dataset.bulk);
    });

    list.addEventListener('click', async e => {
        const t = e.target;
        const sec = t.closest('.cb_section');
        if (sec) {
            const only = t.closest('[data-only]');
            if (only) { ui.entity = only.dataset.only; ui.render(); list.scrollTop = 0; return; }
            if (!sec.classList.contains('cb_foldable')) return;
            const id = sec.dataset.sec;
            if (ui.collapsed.has(id)) ui.collapsed.delete(id); else ui.collapsed.add(id);
            ui.render();
            return;
        }
        const row = t.closest('.cb_row');
        const c = chatFromRow(row);
        if (!c) return;
        if (t.closest('.cb_more')) { e.stopPropagation(); openMenu(c, t.closest('.cb_more')); return; }
        if (t.closest('[data-parts]')) { if (ui.expanded.has(c.key)) ui.expanded.delete(c.key); else ui.expanded.add(c.key); ui.render(); return; }
        if (t.closest('[data-hist]')) { loadHistory(c); return; }
        const part = t.closest('[data-open]');
        if (part) { if (!ui.selecting) doOpen(data.byKey.get(part.dataset.open)); return; }
        if (t.closest('.cb_history')) return;
        if (ui.selecting) { toggleSelect(c.key); return; }
        doOpen(c);
    });

    // Long press on a row starts selecting (touch).
    let pressTimer = null, pressKey = null;
    list.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'touch' || ui.selecting) return;
        const row = e.target.closest('.cb_row');
        if (!row || e.target.closest('button')) return;
        pressKey = row.dataset.key;
        pressTimer = setTimeout(() => { pressTimer = null; setSelecting(true); toggleSelect(pressKey); navigator.vibrate?.(15); }, 550);
    });
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    list.addEventListener('pointerup', cancelPress);
    list.addEventListener('pointercancel', cancelPress);
    list.addEventListener('scroll', cancelPress, { passive: true });
    list.addEventListener('contextmenu', e => {
        const row = e.target.closest('.cb_row');
        if (!row || matchMedia('(pointer: coarse)').matches) return;
        e.preventDefault();
        openMenu(chatFromRow(row), row.querySelector('.cb_more'));
    });

    root.addEventListener('keydown', e => {
        const layer = root.querySelector('.cb_layer');
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (layer.firstChild) { layer.lastChild._close?.(); return; }
            if (ui.selecting) { setSelecting(false); return; }
            closeBrowser();
            return;
        }
        if (layer.firstChild) return;
        const inField = e.target.matches('input, select, textarea');
        if (e.key === '/' && !inField) { e.preventDefault(); search.focus(); search.select(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const rows = [...list.querySelectorAll('.cb_row')];
            if (!rows.length) return;
            e.preventDefault();
            const i = rows.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? rows[Math.min(rows.length - 1, i + 1)] : rows[Math.max(0, i - 1)];
            (i < 0 ? rows[0] : next).focus();
            return;
        }
        if (e.key === 'Enter') {
            if (e.target === search) { const first = list.querySelector('.cb_row'); if (first) doOpen(chatFromRow(first)); return; }
            const row = e.target.closest?.('.cb_row');
            if (row && e.target === row) { e.preventDefault(); ui.selecting ? toggleSelect(row.dataset.key) : doOpen(chatFromRow(row)); }
            const sec = e.target.closest?.('.cb_section.cb_foldable');
            if (sec && e.target === sec) sec.click();
        }
    });
}

async function doOpen(c) {
    if (!c) return;
    if (c.key === currentKey()) { closeBrowser(); return; }
    if (isGenerating()) { toast.warn('กำลังสร้างข้อความอยู่ — รอให้เสร็จหรือกดหยุดก่อน'); return; }
    closeBrowser();
    try { await openChat(c); } catch (e) {
        console.error(LOG, e);
        toast.err(`เปิดแชทไม่สำเร็จ: ${errText(e)}`);
    }
}

function setSelecting(on) {
    ui.selecting = on;
    if (!on) ui.selected.clear();
    ui.root?.querySelector('.cb_selectbtn')?.classList.toggle('cb_on', on);
    ui.render();
}

function toggleSelect(key) {
    if (ui.selected.has(key)) ui.selected.delete(key); else ui.selected.add(key);
    ui.root?.querySelector(`.cb_row[data-key="${CSS.escape(key)}"]`)?.classList.toggle('cb_selected', ui.selected.has(key));
    ui.renderSelbar();
}

async function bulk(action) {
    const list = [...ui.selected].map(k => data.byKey.get(k)).filter(Boolean);
    if (action === 'done') { setSelecting(false); return; }
    if (!list.length) return;
    if (action === 'pin' || action === 'unpin') { togglePin(list.map(c => c.key), action === 'pin'); setSelecting(false); return; }
    if (action === 'read') { for (const c of list) markSeen(c.key, c.count); setSelecting(false); updateLauncherBadge(); return; }
    if (action === 'delete') {
        const total = list.reduce((n, c) => n + c.count, 0);
        const ok = await sheetConfirm({
            title: `ลบ ${list.length} แชท?`,
            body: `<ul class="cb_dellist">${list.slice(0, 30).map(c => `<li><b>${esc(c.chatId)}</b><span>${esc(c.entityName)} · ${c.count} ข้อความ</span></li>`).join('')}${list.length > 30 ? `<li>… อีก ${list.length - 30} แชท</li>` : ''}</ul>
                <p class="cb_note">รวม ${total} ข้อความ ${deleteNote()}</p>`,
            ok: `ลบ ${list.length} แชท`, danger: true,
        });
        if (!ok) return;
        let done = 0;
        for (const c of list) {
            try { await deleteChat(c); done++; } catch (e) { toast.err(`ลบ "${c.chatId}" ไม่สำเร็จ: ${errText(e)}`); }
        }
        toast.ok(`ลบแล้ว ${done} แชท`);
        setSelecting(false);
    }
}

function deleteNote() {
    const a = cab();
    if (!a) return '· ลบแล้วกู้คืนไม่ได้';
    if (a.syncInUse?.()) return '· Chat Auto Backup ยังเก็บสำเนาไว้ในเครื่องนี้ · ลบออกจาก Dropbox และเครื่องอื่นจะลบตามตอนซิงค์ (ถ้าเปิด “ลบแล้วลบใน Dropbox และเครื่องอื่นด้วย” ไว้)';
    return '· Chat Auto Backup ยังเก็บสำเนาไว้ในเครื่องนี้ กู้คืนได้จากรายการ backup';
}

// ---------------------------------------------------------------- row menu

function openMenu(c, anchor) {
    const layer = ui.root.querySelector('.cb_layer');
    layer.querySelector('.cb_menu')?._close?.();
    const s = settings();
    const pinned = !!s.pins[c.key];
    const info = linkInfo.get(c.key);
    const isOpen = c.key === currentKey();
    const items = [
        ['open', isOpen ? 'fa-solid fa-eye' : 'fa-solid fa-arrow-right-to-bracket', isOpen ? 'กลับไปที่แชทนี้' : 'เปิดแชทนี้'],
        ...(info?.size > 1 ? info.parts.filter(p => p.key !== c.key).reverse().map(p => [`part:${p.key}`, 'fa-solid fa-book-bookmark', `เปิดภาค ${linkInfo.get(p.key)?.part ?? '?'} · ${p.chatId}`]) : []),
        ['pin', 'fa-solid fa-thumbtack', pinned ? 'เลิกปักหมุด' : 'ปักหมุด'],
        ['rename', 'fa-solid fa-pen', 'เปลี่ยนชื่อ'],
        ['read', 'fa-solid fa-check-double', 'ทำเครื่องหมายว่าอ่านแล้ว', unreadOf(c) > 0],
        ['link', 'fa-solid fa-link', c.prev ? 'เปลี่ยนภาคก่อนหน้า…' : 'ตั้งเป็นภาคต่อของ…'],
        ['unlink', 'fa-solid fa-link-slash', 'ยกเลิกการผูกภาคต่อ', !!c.prev],
        ['only', 'fa-solid fa-filter', `ดูเฉพาะแชทของ ${c.entityName}`],
        ['delete', 'fa-solid fa-trash', 'ลบแชท', true, true],
    ].filter(x => x[3] !== false);
    const menu = document.createElement('div');
    menu.className = 'cb_menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="cb_menuhead"><b>${esc(c.chatId)}</b><span>${esc(c.entityName)} · ${c.count} ข้อความ${info?.size > 1 ? ` · ภาค ${info.part} จาก ${info.size} แชท` : ''}</span></div>`
        + items.map(([id, icon, label, , danger]) => `<button role="menuitem" data-act="${esc(id)}"${danger ? ' class="cb_danger"' : ''}><i class="${icon}"></i>${esc(label)}</button>`).join('');
    layer.append(menu);
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    menu._close = close;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);

    // Beside the button on wide screens, a bottom sheet on phones.
    const panel = ui.root.querySelector('.cb_panel').getBoundingClientRect();
    if (panel.width > 560 && anchor) {
        const r = anchor.getBoundingClientRect();
        menu.classList.add('cb_pop');
        const h = menu.offsetHeight;
        const top = Math.min(panel.bottom - h - 8, Math.max(panel.top + 8, r.bottom + 4));
        menu.style.top = `${top - panel.top}px`;
        menu.style.right = `${Math.max(8, panel.right - r.right)}px`;
    } else {
        menu.classList.add('cb_sheetmenu');
    }
    menu.querySelector('button')?.focus();

    menu.addEventListener('click', async e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        close();
        try { await menuAction(b.dataset.act, c); } catch (err) { console.error(LOG, err); toast.err(errText(err)); }
    });
}

async function menuAction(act, c) {
    if (act === 'open') return doOpen(c);
    if (act.startsWith('part:')) return doOpen(data.byKey.get(act.slice(5)));
    if (act === 'pin') { togglePin([c.key], !settings().pins[c.key]); ui.render(); return; }
    if (act === 'read') { markSeen(c.key, c.count); ui.render(); updateLauncherBadge(); return; }
    if (act === 'only') { ui.entity = `${c.type}|${c.entity}`; ui.render(); return; }
    if (act === 'rename') {
        const name = await sheetPrompt({ title: 'เปลี่ยนชื่อแชท', value: c.chatId, ok: 'เปลี่ยนชื่อ', hint: `${esc(c.entityName)} · แชทที่อ้างถึงชื่อนี้ (ภาคต่อ กิ่ง) จะถูกแก้ตาม${cab()?.dropboxConnected?.() ? ' · ไฟล์ใน Dropbox ย้ายไปชื่อใหม่ และเครื่องอื่นเปลี่ยนตามตอนซิงค์' : ''}` });
        if (name == null) return;
        const done = await renameChat(c, name);
        if (done) { toast.ok(`เปลี่ยนชื่อเป็น "${done}" แล้ว`); ui.render(); reload(); }
        return;
    }
    if (act === 'delete') {
        const ok = await sheetConfirm({
            title: 'ลบแชทนี้?',
            body: `<div class="cb_delone">${ui.avatarHtml(c)}<div><b>${esc(c.chatId)}</b><span>${esc(c.entityName)} · ${c.count} ข้อความ · ${esc(relTime(c.last))}</span></div></div>
                ${c.key === currentKey() ? '<p class="cb_note">แชทนี้เปิดอยู่ — จะสลับไปแชทล่าสุดอื่นของตัวละครนี้ก่อนลบ</p>' : ''}
                <p class="cb_note">${deleteNote()}</p>`,
            ok: 'ลบแชท', danger: true,
        });
        if (!ok) return;
        await deleteChat(c);
        toast.ok(`ลบ "${c.chatId}" แล้ว`);
        ui.render();
        return;
    }
    if (act === 'unlink') {
        await setPrev(c, null);
        toast.ok('ยกเลิกการผูกแล้ว');
        ui.render();
        return;
    }
    if (act === 'link') {
        const parent = await pickPrev(c);
        if (!parent) return;
        await setPrev(c, parent.chatId);
        toast.ok(`ตั้ง "${c.chatId}" เป็นภาคต่อของ "${parent.chatId}" แล้ว`);
        ui.render();
    }
}

/** Chats of the same character/group that this one could continue (not itself or a later part). */
async function pickPrev(c) {
    const later = new Set();
    const walk = k => {
        for (const x of data.chats) {
            if (later.has(x.key) || x.type !== c.type || x.entity !== c.entity) continue;
            const from = data.byKey.get(k);
            if (x.prev === from?.chatId || x.chain.includes(from?.chatId)) { later.add(x.key); walk(x.key); }
        }
    };
    walk(c.key);
    const options = siblings(c).filter(x => !later.has(x.key)).sort((a, b) => b.last - a.last);
    if (!options.length) { toast.info('ตัวละครนี้ไม่มีแชทอื่นให้เลือก'); return null; }
    return await sheetPick({
        title: `"${c.chatId}" ต่อจากแชทไหน?`,
        hint: 'แชทที่เลือกจะเป็นภาคก่อนหน้า — ใช้กับแชทที่ต่อเรื่องเองด้วยมือ (แชทที่สร้างด้วย “เริ่มแชทใหม่ต่อเรื่อง” ของ Memory Hub ผูกให้อัตโนมัติอยู่แล้ว)',
        items: options.map(x => ({ value: x, html: `<b>${esc(x.chatId)}</b><span>${x.count} ข้อความ · ${esc(relTime(x.last))}${linkInfo.get(x.key)?.size > 1 ? ` · ภาค ${linkInfo.get(x.key).part}` : ''}</span>`, selected: x.chatId === c.prev })),
    });
}

async function loadHistory(c) {
    ui.history.set(c.key, 'loading');
    ui.render();
    try {
        const arr = await readChat(c);
        const msgs = arr.filter(m => m && 'mes' in m && !m.is_system).slice(-6);
        await loadRegex();
        const rx = displayRegexer();
        const avatar = c.type === 'character' ? c.entity : null;
        ui.history.set(c.key, msgs.map(m => ({
            name: m.name ?? '',
            user: !!m.is_user,
            text: clip(cleanPreview(rx(m.mes, { avatar: m.is_user ? null : avatar, user: !!m.is_user, name: c.entityName }), { keepLines: true }), 700) || '…',
        })));
    } catch (e) {
        ui.history.set(c.key, `โหลดไม่สำเร็จ: ${errText(e)}`);
    }
    ui.render();
}

// ---------------------------------------------------------------- sheets (small dialogs inside the panel)

function sheet({ title, body, buttons, wide = false, onMount }) {
    return new Promise(resolve => {
        const layer = ui.root.querySelector('.cb_layer');
        const el = document.createElement('div');
        el.className = 'cb_sheetwrap';
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

function sheetConfirm({ title, body, ok = 'ตกลง', danger = false }) {
    return sheet({
        title, body,
        buttons: [
            { label: 'ยกเลิก', run: a => a.close(false) },
            { label: esc(ok), primary: !danger, danger, run: a => a.close(true) },
        ],
    });
}

function sheetPrompt({ title, value = '', ok = 'ตกลง', hint = '' }) {
    return sheet({
        title,
        body: `<input class="cb_input" type="text" value="${esc(value)}" spellcheck="false" autocomplete="off">${hint ? `<p class="cb_note">${hint}</p>` : ''}`,
        buttons: [
            { label: 'ยกเลิก', run: a => a.close(null) },
            { label: esc(ok), primary: true, run: a => a.close(a.body.querySelector('input').value) },
        ],
        onMount: a => {
            const input = a.body.querySelector('input');
            setTimeout(() => { input.focus(); input.select(); }, 50);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); a.close(input.value); } });
        },
    });
}

function sheetPick({ title, hint, items }) {
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

// ---------------------------------------------------------------- Sync / Clean Sync

async function runSync() {
    const a = cab();
    if (!a?.dropboxConnected?.()) { toast.info('เชื่อมต่อ Dropbox ในแผง Chat Auto Backup ก่อน (Extensions → Chat Auto Backup)'); return; }
    if (ui.busy) return;
    ui.busy = 'sync';
    ui.renderSync();
    try {
        const r = await a.syncNow();
        if (r?.busy) toast.info('Dropbox กำลังทำงานอื่นอยู่ ลองอีกครั้งในอีกสักครู่', 'Sync');
    } catch (e) {
        toast.err(errText(e), 'Sync');
    } finally {
        ui.busy = false;
        ui.renderSync();
    }
    await reload();
}

const fmtDate = ms => new Date(ms).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtBytes = n => (!n ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

async function openCleanSync() {
    const a = cab();
    if (!a?.dropboxConnected?.()) { toast.info('เชื่อมต่อ Dropbox ในแผง Chat Auto Backup ก่อน'); return; }
    if (!a.syncInUse?.()) { toast.info('เปิด “ซิงค์แชทระหว่างเครื่อง” ใน Chat Auto Backup และกดซิงค์อย่างน้อยหนึ่งครั้งก่อน'); return; }
    if (ui.busy) return;
    const logN = (a.cleanLog?.() || []).reduce((n, e) => n + e.removed.filter(x => !x.restored).length, 0);
    await sheet({
        title: 'Clean Sync',
        wide: true,
        body: `<div class="cb_clean_intro">
            <div class="cb_clean_icon"><i class="fa-solid fa-broom"></i></div>
            <p><b>ใช้รายชื่อแชทในเครื่องนี้เป็นหลัก</b> — ทำให้ Dropbox และทุกเครื่องที่ซิงค์มีแชทเหมือนเครื่องนี้เป๊ะ</p>
            <ol>
                <li>ซิงค์ตามปกติหนึ่งรอบก่อน (แชทที่อีกเครื่องเพิ่งสร้างจะถูกดึงมา ไม่ถูกลบ)</li>
                <li>แชทที่มีใน Dropbox แต่<b>ไม่มีในเครื่องนี้</b> → ลบออกจาก Dropbox และเครื่องอื่นลบตามตอนซิงค์</li>
                <li>แชทที่เครื่องอื่นลบไปแต่เครื่องนี้ยังมี → เก็บไว้ ส่งกลับขึ้น Dropbox</li>
                <li>แชทในเครื่องนี้ที่ยังไม่เคยขึ้น Dropbox → ส่งขึ้นไป (ยกเว้นแชทที่มีแค่ข้อความทักทาย)</li>
            </ol>
            <p class="cb_note"><i class="fa-solid fa-shield-halved"></i> ยังไม่ลบอะไรจนกว่าจะกดยืนยันในหน้าถัดไป · ไฟล์ที่ลบกู้คืนได้จากหน้านี้ภายในประมาณ 30 วัน (Dropbox เก็บไฟล์ที่ลบไว้ช่วงหนึ่ง)</p>
        </div>`,
        buttons: [
            ...(logN ? [{ label: `<i class="fa-solid fa-clock-rotate-left"></i>ประวัติการลบ (${logN})`, run: api => showCleanHistory(api) }] : []),
            { label: 'ยกเลิก', run: api => api.close(null) },
            { label: '<i class="fa-solid fa-magnifying-glass"></i>ตรวจดูก่อน', primary: true, run: api => cleanPlanStep(api) },
        ],
    });
}

function progressHtml(text) {
    return `<div class="cb_progress"><i class="fa-solid fa-circle-notch fa-spin"></i><span>${esc(text)}</span></div>`;
}

async function cleanPlanStep(api) {
    const a = cab();
    ui.busy = 'clean';
    api.setButtons([]);
    api.body.innerHTML = progressHtml('กำลังเตรียม…');
    const progress = t => { const s = api.body.querySelector('.cb_progress span'); if (s) s.textContent = t; };
    let plan;
    try {
        plan = await a.cleanSyncPlan(progress);
    } catch (e) {
        ui.busy = false;
        api.body.innerHTML = `<div class="cb_empty"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(errText(e))}</span></div>`;
        api.setButtons([{ label: 'ปิด', run: x => x.close(null) }]);
        return;
    }
    ui.busy = false;
    reload();
    renderPlan(api, plan);
}

function renderPlan(api, plan) {
    const nothing = !plan.remove.length && !plan.keep.length && !plan.upload.length;
    api.setTitle('Clean Sync — ตรวจแล้ว');
    if (nothing) {
        api.body.innerHTML = `<div class="cb_clean_done"><i class="fa-solid fa-circle-check"></i><b>Dropbox ตรงกับเครื่องนี้แล้ว</b><span>${plan.localCount} แชทในเครื่องนี้ ไม่มีอะไรต้องลบหรือส่งเพิ่ม</span>
            ${plan.pendingChoices ? `<p class="cb_note">ยังมี ${plan.pendingChoices} แชทที่แก้ทั้งสองฝั่ง รอเลือกว่าจะใช้ฉบับไหน</p>` : ''}</div>`;
        api.setButtons([
            ...(plan.pendingChoices ? [{ label: 'เลือกฉบับ', run: x => { x.close(null); cab()?.showSyncDecisions?.(); } }] : []),
            { label: 'ปิด', primary: true, run: x => x.close(null) },
        ]);
        return;
    }
    const byEntity = new Map();
    for (const x of plan.remove) (byEntity.get(x.label) ?? byEntity.set(x.label, []).get(x.label)).push(x);
    const removeHtml = [...byEntity.entries()].map(([label, list]) => `
        <div class="cb_cgroup">
            <label class="cb_cgrouphead"><input type="checkbox" data-group="${esc(label)}" checked><b>${esc(label)}</b><span>${list.length} แชท${list[0].why === 'noentity' ? ' · <em>ไม่มีตัวละคร/กลุ่มนี้ในเครื่องนี้</em>' : ''}</span></label>
            ${list.map(x => `<label class="cb_citem"><input type="checkbox" data-key="${esc(x.key)}" data-g="${esc(label)}" checked><span class="cb_cname">${esc(x.chatId)}</span><span class="cb_cinfo">${x.when ? esc(relTime(x.when)) : ''}${x.size ? ` · ${fmtBytes(x.size)}` : ''}</span></label>`).join('')}
        </div>`).join('');
    api.body.innerHTML = `
        <div class="cb_cstats">
            <div class="cb_cstat cb_red"><b>${plan.remove.length}</b><span>ลบจาก Dropbox<br>และทุกเครื่อง</span></div>
            <div class="cb_cstat"><b>${plan.keep.length}</b><span>เก็บไว้<br>(เครื่องอื่นลบไป)</span></div>
            <div class="cb_cstat"><b>${plan.upload.length}</b><span>ส่งขึ้น Dropbox<br>(ยังไม่เคยส่ง)</span></div>
        </div>
        ${plan.pulled.applied ? `<p class="cb_note"><i class="fa-solid fa-rotate"></i> ซิงค์ปกติแล้ว อัปเดต ${plan.pulled.applied} แชทจากเครื่องอื่น</p>` : ''}
        ${plan.pulled.errors?.length ? `<p class="cb_note cb_warn">ซิงค์ปกติมีปัญหา: ${esc(plan.pulled.errors.slice(0, 2).join(' · '))}</p>` : ''}
        ${plan.remove.length ? `<h4>จะลบออกจาก Dropbox <small>(เอาเครื่องหมายออกเพื่อเก็บไว้)</small></h4><div class="cb_clist">${removeHtml}</div>` : ''}
        ${plan.keep.length ? `<h4>จะเก็บไว้ทุกเครื่อง</h4><div class="cb_clist cb_plain">${plan.keep.map(x => `<div class="cb_citem"><span class="cb_cname">${esc(x.chatId)}</span><span class="cb_cinfo">${esc(x.label)} · ${x.count} ข้อความ</span></div>`).join('')}</div>` : ''}
        ${plan.upload.length ? `<h4>จะส่งขึ้น Dropbox</h4><label class="cb_citem cb_uploadall"><input type="checkbox" class="cb_doupload" checked><span class="cb_cname">ส่ง ${plan.upload.length} แชทที่ยังไม่มีบน Dropbox</span><span class="cb_cinfo">เครื่องอื่นจะได้แชทเหล่านี้ตอนซิงค์</span></label>
            <details class="cb_more_list"><summary>ดูรายชื่อ</summary>${plan.upload.map(x => `<div class="cb_citem"><span class="cb_cname">${esc(x.chatId)}</span><span class="cb_cinfo">${esc(x.label)} · ${x.count} ข้อความ</span></div>`).join('')}</details>` : ''}
        ${plan.pendingChoices ? `<p class="cb_note">ยังมี ${plan.pendingChoices} แชทที่แก้ทั้งสองฝั่ง — Clean Sync ไม่ตัดสินเนื้อหาแทน เลือกฉบับเองได้ที่ “เลือกฉบับ” ของ Chat Auto Backup</p>` : ''}
        <p class="cb_note"><i class="fa-solid fa-shield-halved"></i> กู้คืนแชทที่ลบได้จากประวัติ Clean Sync ภายในประมาณ 30 วัน (ถึง ${fmtDate(Date.now() + 30 * 86_400_000)})</p>`;

    const count = () => api.body.querySelectorAll('input[data-key]:checked').length;
    const refresh = () => {
        const n = count();
        const up = api.body.querySelector('.cb_doupload')?.checked ? plan.upload.length : 0;
        const parts = [n ? `ลบ ${n}` : '', plan.keep.length ? `เก็บ ${plan.keep.length}` : '', up ? `ส่ง ${up}` : ''].filter(Boolean);
        for (const g of api.body.querySelectorAll('input[data-group]')) {
            const items = [...api.body.querySelectorAll(`input[data-g="${CSS.escape(g.dataset.group)}"]`)];
            const on = items.filter(i => i.checked).length;
            g.checked = on === items.length;
            g.indeterminate = on > 0 && on < items.length;
        }
        api.setButtons([
            { label: 'ยกเลิก', run: x => x.close(null) },
            { label: `<i class="fa-solid fa-broom"></i>${parts.length ? `ยืนยัน: ${parts.join(' · ')}` : 'ไม่มีอะไรต้องทำ'}`, danger: n > 0, primary: !n, disabled: !parts.length, run: x => cleanApplyStep(x, plan) },
        ]);
    };
    api.body.addEventListener('change', e => {
        if (e.target.dataset.group) {
            for (const i of api.body.querySelectorAll(`input[data-g="${CSS.escape(e.target.dataset.group)}"]`)) i.checked = e.target.checked;
        }
        refresh();
    });
    refresh();
}

async function cleanApplyStep(api, plan) {
    const a = cab();
    const only = [...api.body.querySelectorAll('input[data-key]:checked')].map(i => i.dataset.key);
    const upload = !!api.body.querySelector('.cb_doupload')?.checked;
    ui.busy = 'clean';
    api.setButtons([]);
    api.body.innerHTML = progressHtml('กำลังเริ่ม…');
    const progress = t => { const s = api.body.querySelector('.cb_progress span'); if (s) s.textContent = t; };
    let r;
    try {
        r = await a.cleanSyncApply(plan, { only, upload, progress });
    } catch (e) {
        ui.busy = false;
        api.body.innerHTML = `<div class="cb_empty"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(errText(e))}</span></div>`;
        api.setButtons([{ label: 'ปิด', run: x => x.close(null) }]);
        return;
    }
    ui.busy = false;
    reload();
    api.setTitle('Clean Sync — เสร็จแล้ว');
    const until = fmtDate(Date.now() + 30 * 86_400_000);
    api.body.innerHTML = `
        <div class="cb_clean_done"><i class="fa-solid fa-circle-check"></i><b>Dropbox ตรงกับเครื่องนี้แล้ว</b>
            <span>ลบ ${r.removed.length} · เก็บไว้ ${r.kept.length} · ส่งขึ้น ${r.uploaded.length} แชท · เครื่องอื่นจะทำตามตอนซิงค์ครั้งถัดไป</span></div>
        ${r.errors.length ? `<p class="cb_note cb_warn">ทำไม่สำเร็จ ${r.errors.length} รายการ: ${esc(r.errors.slice(0, 3).join(' · '))}</p>` : ''}
        ${r.removed.length ? `<h4>ลบออกไปแล้ว <small>กู้คืนได้ถึงประมาณ ${until}</small></h4>${restoreListHtml(r.removed)}` : ''}`;
    wireRestore(api, r.removed);
    api.setButtons([{ label: 'เสร็จ', primary: true, run: x => x.close(null) }]);
}

function restoreListHtml(list) {
    return `<div class="cb_clist cb_plain">${list.map((x, i) => `<div class="cb_citem cb_restorable">
        <span class="cb_cname">${esc(x.chatId)}</span>
        <span class="cb_cinfo">${esc(x.label)}${x.count ? ` · ${x.count} ข้อความ` : ''}</span>
        ${x.restored ? '<span class="cb_restored"><i class="fa-solid fa-check"></i>กู้แล้ว</span>' : `<button class="cb_btn cb_small" data-restore="${i}"><i class="fa-solid fa-rotate-left"></i>กู้คืน</button>`}
    </div>`).join('')}</div>`;
}

function wireRestore(api, list) {
    api.body.addEventListener('click', async e => {
        const b = e.target.closest('[data-restore]');
        if (!b || b.disabled) return;
        const x = list[Number(b.dataset.restore)];
        b.disabled = true;
        b.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
        try {
            const r = await cab().cleanRestore(x);
            x.restored = Date.now();
            b.outerHTML = '<span class="cb_restored"><i class="fa-solid fa-check"></i>กู้แล้ว</span>';
            toast.ok(r.created ? `กู้ "${x.chatId}" กลับมาแล้ว ทั้งในเครื่องนี้และ Dropbox` : `กู้ "${x.chatId}" กลับมาใน Dropbox แล้ว`);
            reload();
        } catch (err) {
            b.disabled = false;
            b.innerHTML = '<i class="fa-solid fa-rotate-left"></i>กู้คืน';
            toast.err(errText(err));
        }
    });
}

function showCleanHistory(api) {
    const log = cab()?.cleanLog?.() || [];
    api.setTitle('ประวัติ Clean Sync');
    const flat = [];
    api.body.innerHTML = log.length ? log.map(e => {
        const start = flat.length;
        flat.push(...e.removed);
        const html = restoreListHtml(e.removed).replace(/data-restore="(\d+)"/g, (_, i) => `data-restore="${start + Number(i)}"`);
        const left = Math.ceil((e.ts + 30 * 86_400_000 - Date.now()) / 86_400_000);
        return `<h4>${esc(fullTime(e.ts))} <small>ลบ ${e.removed.length} แชท · ${left > 0 ? `กู้ได้อีกประมาณ ${left} วัน` : 'อาจกู้ไม่ได้แล้ว'}</small></h4>${html}`;
    }).join('') : '<div class="cb_empty"><span>ยังไม่มีประวัติ</span></div>';
    wireRestore(api, flat);
    api.setButtons([{ label: 'ปิด', primary: true, run: x => x.close(null) }]);
}

// ---------------------------------------------------------------- launcher look
//
// The floating button is a decoration as much as a button: a shape (or a mask such as a
// heart or a star, or no shape at all for a sticker), an icon, an emoji or a picture,
// colours from the theme or picked, a size, and an idle animation.

const LOOK_DEFAULT = Object.freeze({
    shape: 'circle',    // circle squircle bubble pill heart flower star cloud sticker
    icon: 'fa-comments',
    emoji: '',          // overrides the icon
    image: '',          // data: URL or link; overrides icon and emoji
    fit: 'cover',       // cover | contain
    size: 46,
    iconSize: 42,       // % of the button
    bg: 'theme',        // theme | custom | none
    bgColor: '#2a2633',
    fg: 'theme',        // theme | custom
    fgColor: '#ffd38a',
    border: true,
    shadow: true,
    anim: 'none',       // none float sway pulse spin glow nudge
    opacity: 100,
    label: 'แชท',       // pill only
    badge: true,
});

const svgMask = d => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>${d}</svg>`)}")`;
const MASKS = {
    heart: { mask: svgMask("<path d='M50 90C22 70 3 53 3 31 3 15 15 4 29 4c9 0 17 5 21 13 4-8 12-13 21-13 14 0 26 11 26 27 0 22-19 39-47 59z'/>"), nudge: '-6%' },
    star: { mask: svgMask("<path d='M50 3l13.6 30.2 32.9 3.6-24.6 22.2 7 32.4L50 75 21.1 91.4l7-32.4L3.5 36.8l32.9-3.6z' stroke='black' stroke-width='5' stroke-linejoin='round'/>"), nudge: '5%' },
    flower: { mask: svgMask(`${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<circle cx='${(50 + 30 * Math.cos(a * Math.PI / 180)).toFixed(1)}' cy='${(50 + 30 * Math.sin(a * Math.PI / 180)).toFixed(1)}' r='20'/>`).join('')}<circle cx='50' cy='50' r='34'/>`), nudge: '0' },
    cloud: { mask: svgMask("<path d='M27 84C13 84 3 74 3 61c0-12 9-22 21-23 2-17 15-29 31-29 13 0 24 8 29 20 9 2 16 10 16 21 0 19-13 34-32 34z'/>"), nudge: '4%' },
};
const SHAPES = [
    ['circle', 'วงกลม'], ['squircle', 'มนเหลี่ยม'], ['bubble', 'บับเบิลแชท'], ['pill', 'แคปซูล + ข้อความ'],
    ['heart', 'หัวใจ'], ['flower', 'ดอกไม้'], ['star', 'ดาว'], ['cloud', 'ก้อนเมฆ'], ['sticker', 'สติกเกอร์ (ไม่มีพื้น)'],
];
const LOOK_ICONS = ['fa-comments', 'fa-comment-dots', 'fa-book-open', 'fa-scroll', 'fa-feather-pointed', 'fa-heart', 'fa-star', 'fa-moon',
    'fa-cat', 'fa-paw', 'fa-ghost', 'fa-dragon', 'fa-crown', 'fa-wand-magic-sparkles', 'fa-envelope', 'fa-mug-hot', 'fa-music', 'fa-seedling'];
const ANIMS = [['none', 'นิ่ง'], ['float', 'ลอยขึ้นลง'], ['sway', 'โยกเบา ๆ'], ['pulse', 'เต้นตุบ ๆ'], ['spin', 'หมุนช้า ๆ'], ['glow', 'เรืองแสง'], ['nudge', 'ดุ๊กดิ๊กเมื่อมีข้อความใหม่']];
const LOOK_PRESETS = [
    ['คลาสสิก', {}],
    ['หัวใจ', { shape: 'heart', icon: 'fa-comment-dots', bg: 'custom', bgColor: '#f06292', fg: 'custom', fgColor: '#ffffff', border: false, anim: 'pulse', size: 52 }],
    ['ดาวเรือง', { shape: 'star', icon: 'fa-moon', bg: 'custom', bgColor: '#f5c451', fg: 'custom', fgColor: '#4a3200', border: false, anim: 'glow', size: 56, iconSize: 34 }],
    ['ดอกไม้', { shape: 'flower', icon: 'fa-seedling', bg: 'custom', bgColor: '#b7e4c7', fg: 'custom', fgColor: '#2d6a4f', border: false, anim: 'sway', size: 54 }],
    ['บับเบิล', { shape: 'bubble', icon: 'fa-comments', anim: 'float' }],
    ['แคปซูล', { shape: 'pill', icon: 'fa-book-open', label: 'แชท', size: 40, iconSize: 45 }],
    ['ก้อนเมฆ', { shape: 'cloud', icon: 'fa-envelope', bg: 'custom', bgColor: '#e8eefc', fg: 'custom', fgColor: '#5468a8', border: false, anim: 'float', size: 58, iconSize: 32 }],
    ['สติกเกอร์', { shape: 'sticker', emoji: '💌', anim: 'nudge', size: 52 }],
];

function look() {
    const s = settings();
    s.launcherLook = { ...LOOK_DEFAULT, ...(s.launcherLook && typeof s.launcherLook === 'object' ? s.launcherLook : {}) };
    return s.launcherLook;
}

/** Draw the button (the real one or the preview) from a look. */
function applyLook(el, L = look()) {
    const mask = MASKS[L.shape];
    el.dataset.shape = SHAPES.some(x => x[0] === L.shape) ? L.shape : 'circle';
    el.dataset.masked = mask ? '1' : '';
    el.dataset.anim = L.anim;
    el.dataset.fit = L.fit;
    el.dataset.border = L.border && !mask && L.shape !== 'sticker' && L.bg !== 'none' ? '1' : '';
    el.dataset.shadow = L.shadow ? '1' : '';
    const size = clamp(Number(L.size) || 46, 24, 160);
    el.style.setProperty('--cb-lsize', `${size}px`);
    el.style.setProperty('--cb-licon', `${Math.round(size * clamp(Number(L.iconSize) || 42, 20, 100) / 100)}px`);
    el.style.setProperty('--cb-lop', String(clamp(Number(L.opacity) || 100, 20, 100) / 100));
    if (L.bg === 'custom') el.style.setProperty('--cb-lbg', L.bgColor);
    else if (L.bg === 'none') el.style.setProperty('--cb-lbg', 'transparent');
    else el.style.removeProperty('--cb-lbg');
    if (L.fg === 'custom') el.style.setProperty('--cb-lfg', L.fgColor); else el.style.removeProperty('--cb-lfg');
    if (mask) { el.style.setProperty('--cb-lmask', mask.mask); el.style.setProperty('--cb-lnudge', mask.nudge); }
    let inner = el.querySelector('.cb_lshape');
    if (!inner) {
        inner = document.createElement('div');
        inner.className = 'cb_lshape';
        el.prepend(inner);
    }
    const label = L.shape === 'pill' && String(L.label ?? '').trim() ? `<span class="cb_llabel">${esc(L.label)}</span>` : '';
    const face = L.image ? `<img class="cb_limg" src="${esc(L.image)}" alt="" draggable="false">`
        : String(L.emoji ?? '').trim() ? `<span class="cb_lemoji">${esc(String(L.emoji).trim().slice(0, 8))}</span>`
        : `<i class="fa-solid ${esc(/^fa-[\w-]+$/.test(L.icon) ? L.icon : 'fa-comments')} cb_licon"></i>`;
    inner.innerHTML = face + label;
    if (!el.querySelector('.cb_launch_badge')) el.insertAdjacentHTML('beforeend', '<span class="cb_launch_badge" hidden></span>');
    el.classList.toggle('cb_nobadge', !L.badge);
}

/** A picture for the button: small images (and GIFs) as they are, bigger ones scaled down. */
async function imageToDataUrl(file) {
    const read = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
    if (file.size <= 160_000 || (file.type === 'image/gif' && file.size <= 500_000)) return await read(file);
    if (file.type === 'image/gif') throw new Error('GIF ใหญ่เกิน 500 KB');
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------- launcher button & entry points

function updateLauncherBadge() {
    const n = totalUnread();
    for (const el of document.querySelectorAll('.cb_launch_badge')) {
        if (el.closest('.cb_look_stage')) continue; // the preview shows a sample number
        el.textContent = n > 99 ? '99+' : String(n);
        el.hidden = !n || !!el.closest('.cb_nobadge');
    }
    const btn = document.getElementById('cb_launcher');
    if (btn) btn.dataset.unread = n ? '1' : '';
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function placeLauncher(el = document.getElementById('cb_launcher')) {
    if (!el || el.hidden || el.classList.contains('cb_dragging')) return;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const p = settings().launcherPos || DEFAULTS.launcherPos;
    const m = 8, w = el.offsetWidth, h = el.offsetHeight;
    let left = m + clamp(Number(p.x) || 0, 0, 1) * Math.max(0, vw - w - 2 * m);
    let top = m + clamp(Number(p.y) || 0, 0, 1) * Math.max(0, vh - h - 2 * m);
    if (p.edge === 'left') left = m;
    if (p.edge === 'right') left = vw - w - m;
    if (p.edge === 'top') top = m;
    if (p.edge === 'bottom') top = vh - h - m;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.dataset.edge = p.edge ?? '';
}

function renderLauncher() {
    let el = document.getElementById('cb_launcher');
    if (!settings().launcher) { el?.remove(); return; }
    if (el) return;
    el = document.createElement('div');
    el.id = 'cb_launcher';
    el.className = 'cb_launch';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = 'Chat Browser — แชททั้งหมด';
    applyLook(el);
    document.body.append(el);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBrowser(); } });

    let start = null, moved = false;
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
        moved = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        el.classList.add('cb_dragging');
        el.style.left = `${clamp(start.left + dx, 0, window.innerWidth - el.offsetWidth)}px`;
        el.style.top = `${clamp(start.top + dy, 0, window.innerHeight - el.offsetHeight)}px`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        if (!moved) { if (e.type === 'pointerup') openBrowser(); return; }
        el.classList.remove('cb_dragging');
        const vw = window.visualViewport?.width ?? window.innerWidth;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const r = el.getBoundingClientRect();
        const dist = { left: r.left, right: vw - r.right, top: r.top, bottom: vh - r.bottom };
        const edge = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
        settings().launcherPos = {
            x: clamp((r.left - 8) / Math.max(1, vw - r.width - 16), 0, 1),
            y: clamp((r.top - 8) / Math.max(1, vh - r.height - 16), 0, 1),
            edge,
        };
        saveSettings();
        placeLauncher(el);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => placeLauncher());
    window.visualViewport?.addEventListener('resize', () => placeLauncher());
    placeLauncher(el);
    updateLauncherBadge();
}

function renderTopbar() {
    let el = document.getElementById('cb_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return;
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'cb_topbar';
    el.className = 'drawer';
    el.innerHTML = '<div class="drawer-toggle-cb"><div class="drawer-icon fa-solid fa-comments fa-fw closedIcon interactable" title="Chat Browser — แชททั้งหมด" tabindex="0"></div><span class="cb_launch_badge" hidden></span></div>';
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); openBrowser(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openBrowser(); });
    updateLauncherBadge();
}

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cb_wand')) return;
    const item = document.createElement('div');
    item.id = 'cb_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-comments extensionsMenuExtensionButton"></div><span>Chat Browser</span>';
    item.addEventListener('click', () => openBrowser());
    menu.append(item);
}

function renderSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('cb_settings')) return;
    const s = settings();
    host.insertAdjacentHTML('beforeend', `
    <div id="cb_settings" class="cb_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Browser <small class="cb_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cb_setbtns"><div id="cb_set_open" class="menu_button"><i class="fa-solid fa-comments"></i> เปิด Chat Browser</div></div>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_launcher"> ปุ่มลอยบนจอ (ลากไปวางตรงไหนก็ได้ หรือเก็บเข้า Quick Dock)</label>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_topbar"> ไอคอนบนแถบด้านบน</label>
                <details class="cb_look">
                    <summary>หน้าตาปุ่มลอย</summary>
                    <div id="cb_look_body"></div>
                </details>
                <div class="cb_setbtns">
                    <div id="cb_set_resetpos" class="menu_button"><i class="fa-solid fa-crosshairs"></i> รีเซ็ตตำแหน่งปุ่มลอย</div>
                    <div id="cb_set_readall" class="menu_button"><i class="fa-solid fa-check-double"></i> ทุกแชทอ่านแล้ว</div>
                </div>
                <small class="cb_setnote">เปิดได้จากปุ่มลอย ไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/chats</code> · จำนวนข้อความใหม่นับแยกในแต่ละเครื่อง · ปุ่ม Sync และ Clean Sync ใช้ Chat Auto Backup ที่เชื่อมต่อ Dropbox ไว้</small>
            </div>
        </div>
    </div>`);
    const $ = id => document.getElementById(id);
    $('cb_set_launcher').checked = !!s.launcher;
    $('cb_set_topbar').checked = !!s.topbar;
    $('cb_set_launcher').addEventListener('change', e => { s.launcher = e.target.checked; saveSettings(); renderLauncher(); });
    $('cb_set_topbar').addEventListener('change', e => { s.topbar = e.target.checked; saveSettings(); renderTopbar(); });
    $('cb_set_open').addEventListener('click', () => openBrowser());
    $('cb_set_resetpos').addEventListener('click', () => { s.launcherPos = { ...DEFAULTS.launcherPos }; saveSettings(); if (!s.launcher) { s.launcher = true; $('cb_set_launcher').checked = true; renderLauncher(); } placeLauncher(); });
    renderLookEditor($('cb_look_body'));
    $('cb_set_readall').addEventListener('click', async () => {
        if (!data.at) await reload();
        for (const c of data.chats) seen.map[c.key] = c.count;
        saveSeen();
        updateLauncherBadge();
        ui.render();
        toast.ok('ทุกแชทอ่านแล้ว');
    });
}

/** The look editor in the Extensions panel: every change shows on the real button and the preview at once. */
function renderLookEditor(box) {
    if (!box) return;
    const L = look();
    const opt = (list, cur) => list.map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
    box.innerHTML = `
        <div class="cb_look_top">
            <div class="cb_look_stage"><div class="cb_launch" id="cb_look_preview"></div></div>
            <div>
                <span class="cb_look_label" style="margin-top:0">สไตล์สำเร็จรูป</span>
                <div class="cb_look_presets">${LOOK_PRESETS.map(([n], i) => `<div class="menu_button" data-preset="${i}">${esc(n)}</div>`).join('')}</div>
            </div>
        </div>
        <span class="cb_look_label">รูปทรง</span>
        <div class="cb_look_grid" data-group="shape">${SHAPES.map(([v, t]) => `<button type="button" data-v="${v}" title="${esc(t)}" class="${L.shape === v ? 'cb_on' : ''}">${shapeSwatch(v)}</button>`).join('')}</div>
        <span class="cb_look_label">ไอคอน (หรือพิมพ์อีโมจิ / ใช้รูป ด้านล่าง)</span>
        <div class="cb_look_grid" data-group="icon">${LOOK_ICONS.map(v => `<button type="button" data-v="${v}" class="${!L.emoji && !L.image && L.icon === v ? 'cb_on' : ''}"><i class="fa-solid ${v}"></i></button>`).join('')}</div>
        <div class="cb_look_rows">
            <span>อีโมจิ</span><input type="text" class="text_pole" data-k="emoji" maxlength="8" placeholder="เช่น 💌 🐱 ✨" value="${esc(L.emoji)}">
            <span>รูปภาพ</span>
            <div class="cb_look_imgbtns">
                <div class="menu_button" data-img="upload"><i class="fa-solid fa-image"></i> เลือกรูป</div>
                <div class="menu_button" data-img="url"><i class="fa-solid fa-link"></i> ลิงก์รูป</div>
                <div class="menu_button" data-img="clear"${L.image ? '' : ' hidden'}><i class="fa-solid fa-xmark"></i> เอารูปออก</div>
                <select class="text_pole" data-k="fit" style="width:auto"${L.image ? '' : ' hidden'}>${opt([['cover', 'เต็มกรอบ'], ['contain', 'ทั้งรูป']], L.fit)}</select>
                <input type="file" accept="image/*" hidden>
            </div>
            <span>ข้อความ</span><input type="text" class="text_pole" data-k="label" maxlength="16" value="${esc(L.label)}" title="แสดงเมื่อเลือกรูปทรงแคปซูล">
            <span>ขนาด</span><input type="range" data-k="size" min="28" max="140" step="1" value="${L.size}">
            <span>ไอคอน</span><input type="range" data-k="iconSize" min="20" max="100" step="1" value="${L.iconSize}">
            <span>ความทึบ</span><input type="range" data-k="opacity" min="20" max="100" step="5" value="${L.opacity}" title="ตอนไม่ได้แตะ — แตะหรือชี้แล้วชัดเต็ม">
            <span>พื้น</span>
            <div class="cb_look_inline"><select class="text_pole" data-k="bg" style="width:auto">${opt([['theme', 'สีธีม'], ['custom', 'เลือกสี'], ['none', 'โปร่งใส']], L.bg)}</select><input type="color" data-k="bgColor" value="${esc(L.bgColor)}"></div>
            <span>สีไอคอน</span>
            <div class="cb_look_inline"><select class="text_pole" data-k="fg" style="width:auto">${opt([['theme', 'สีธีม (Quote)'], ['custom', 'เลือกสี']], L.fg)}</select><input type="color" data-k="fgColor" value="${esc(L.fgColor)}"></div>
            <span>เคลื่อนไหว</span><select class="text_pole" data-k="anim">${opt(ANIMS, L.anim)}</select>
        </div>
        <div class="cb_look_checks">
            <label class="checkbox_label"><input type="checkbox" data-k="border"${L.border ? ' checked' : ''}> ขอบ</label>
            <label class="checkbox_label"><input type="checkbox" data-k="shadow"${L.shadow ? ' checked' : ''}> เงา</label>
            <label class="checkbox_label"><input type="checkbox" data-k="badge"${L.badge ? ' checked' : ''}> ตัวเลขข้อความใหม่</label>
        </div>
        <div class="cb_setbtns"><div class="menu_button" data-reset="1"><i class="fa-solid fa-rotate-left"></i> กลับเป็นแบบเดิม</div></div>`;

    const preview = box.querySelector('#cb_look_preview');
    const refresh = () => {
        const cur = look();
        applyLook(preview, cur);
        const pb = preview.querySelector('.cb_launch_badge');
        pb.textContent = '3';
        pb.hidden = !cur.badge;
        const real = document.getElementById('cb_launcher');
        if (real) { applyLook(real, cur); placeLauncher(real); updateLauncherBadge(); }
        box.querySelectorAll('[data-group="shape"] button').forEach(b => b.classList.toggle('cb_on', b.dataset.v === cur.shape));
        box.querySelectorAll('[data-group="icon"] button').forEach(b => b.classList.toggle('cb_on', !cur.emoji && !cur.image && b.dataset.v === cur.icon));
        box.querySelector('[data-img="clear"]').hidden = !cur.image;
        box.querySelector('[data-k="fit"]').hidden = !cur.image;
        box.querySelector('[data-k="bgColor"]').hidden = cur.bg !== 'custom';
        box.querySelector('[data-k="fgColor"]').hidden = cur.fg !== 'custom';
    };
    const set = patch => { Object.assign(look(), patch); saveSettings(); refresh(); };
    const sync = () => {
        const cur = look();
        for (const el of box.querySelectorAll('[data-k]')) {
            const k = el.dataset.k;
            if (el.type === 'checkbox') el.checked = !!cur[k]; else el.value = cur[k] ?? '';
        }
        refresh();
    };

    box.addEventListener('click', async e => {
        const b = e.target.closest('button, .menu_button');
        if (!b) return;
        const group = b.closest('[data-group]')?.dataset.group;
        if (group === 'shape') return set({ shape: b.dataset.v });
        if (group === 'icon') { set({ icon: b.dataset.v, emoji: '', image: '' }); return sync(); }
        if (b.dataset.preset) { settings().launcherLook = { ...LOOK_DEFAULT, ...LOOK_PRESETS[b.dataset.preset][1] }; saveSettings(); return sync(); }
        if (b.dataset.reset) { settings().launcherLook = { ...LOOK_DEFAULT }; saveSettings(); return sync(); }
        if (b.dataset.img === 'upload') return box.querySelector('input[type="file"]').click();
        if (b.dataset.img === 'clear') { set({ image: '' }); return sync(); }
        if (b.dataset.img === 'url') {
            const url = prompt('ลิงก์รูป (https://… ใช้ PNG พื้นใสหรือ GIF ได้)', /^https?:/.test(look().image) ? look().image : '');
            if (url == null) return;
            if (url && !/^https?:\/\//i.test(url.trim())) { toast.warn('ใส่ลิงก์ที่ขึ้นต้นด้วย https://'); return; }
            set({ image: url.trim(), fit: look().shape === 'sticker' ? 'contain' : look().fit });
            sync();
        }
    });
    box.querySelector('input[type="file"]').addEventListener('change', async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
            set({ image: await imageToDataUrl(f) });
            sync();
        } catch (err) { toast.err(`ใช้รูปนี้ไม่ได้: ${errText(err)}`); }
    });
    const onField = e => {
        const el = e.target.closest('[data-k]');
        if (!el) return;
        const k = el.dataset.k;
        const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        set({ [k]: v, ...(k === 'emoji' && v ? { image: '' } : {}) });
    };
    box.addEventListener('input', onField);
    box.addEventListener('change', onField);
    sync();
}

function shapeSwatch(shape) {
    const m = MASKS[shape];
    if (m) return `<span class="cb_shapeswatch" style="${esc(`-webkit-mask:${m.mask} center/100% 100% no-repeat;mask:${m.mask} center/100% 100% no-repeat`)}"></span>`;
    const radius = { circle: '50%', squircle: '30%', bubble: '50% 50% 50% 14%', pill: '999px' }[shape];
    if (radius) return `<span class="cb_shapeswatch" style="border-radius:${radius};${shape === 'pill' ? 'width:28px;height:14px' : ''}"></span>`;
    return '<i class="fa-solid fa-note-sticky"></i>';
}

function registerCommand() {
    const c = ctx();
    try {
        if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'chats',
                callback: () => { openBrowser(); return ''; },
                helpString: 'เปิด Chat Browser — แชททั้งหมดของทุกตัวละครและกลุ่ม',
            }));
        } else {
            c.registerSlashCommand?.('chats', () => { openBrowser(); return ''; }, [], 'เปิด Chat Browser', true, true);
        }
    } catch (e) { console.warn(LOG, 'slash command', e); }
}

// ---------------------------------------------------------------- events

let refreshTimer = null;
/**
 * Something changed on the server: refresh quietly. Closed browser: only when `background`
 * (a sync brought chats in — the launcher's unread count should show it); otherwise on next open.
 */
function staleSoon(delay = 800, { background = false } = {}) {
    clearTimeout(refreshTimer);
    if (!ui.root && !background) return;
    refreshTimer = setTimeout(() => reload(), ui.root ? delay : Math.max(delay, 3000));
}

function wireEvents() {
    const { eventSource, eventTypes: E0, event_types } = ctx();
    const E = E0 ?? event_types;
    const onMsg = () => { markCurrentSeen(); if (ui.root) ui.render(); };
    for (const ev of [E.MESSAGE_SENT, E.MESSAGE_RECEIVED, E.MESSAGE_DELETED, E.MESSAGE_SWIPED].filter(Boolean)) eventSource.on(ev, onMsg);
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, () => { markCurrentSeen(); if (ui.root) ui.render(); });
    if (E.CHAT_RENAMED) eventSource.on(E.CHAT_RENAMED, ev => { afterRename(ev).catch(e => console.warn(LOG, e)); staleSoon(); });
    for (const ev of [E.CHAT_DELETED, E.GROUP_CHAT_DELETED, E.CHAT_CREATED, E.GROUP_CHAT_CREATED].filter(Boolean)) eventSource.on(ev, () => staleSoon());
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { addWandItem(); renderTopbar(); });
    document.addEventListener('chatautobackup:synced', () => staleSoon(300, { background: true }));
    // Keep the Sync button's state live while the panel is open.
    setInterval(() => { if (ui.root) ui.renderSync(); }, 2000);
    // Back in the app after a while: recount unread for the launcher badge.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - data.at > 5 * 60_000) staleSoon(1500, { background: true });
    });
    // Esc closes the topmost thing in the browser, wherever the focus is.
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !ui.root || ui.root.contains(e.target)) return;
        e.stopPropagation();
        const layer = ui.root.querySelector('.cb_layer');
        if (layer.lastChild) layer.lastChild._close?.();
        else if (ui.selecting) setSelecting(false);
        else closeBrowser();
    }, true);
}

// ---------------------------------------------------------------- stale-code check (iOS home-screen apps rarely reload)

let versionChecked = false;
async function checkForNewVersion() {
    if (versionChecked) return;
    versionChecked = true;
    try {
        const res = await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' });
        const remote = String((await res.json())?.version ?? '');
        if (!remote || remote === VERSION) return;
        globalThis.toastr?.info(`ติดตั้ง v${remote} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION}<br>แตะเพื่อโหลดเวอร์ชันใหม่`, 'Chat Browser', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false,
            onclick: async () => {
                await Promise.all(['index.js', 'lib.js', 'style.css', 'manifest.json'].map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
                location.reload();
            },
        });
    } catch { /* offline */ }
}

async function init() {
    settings();
    renderSettingsPanel();
    renderLauncher();
    renderTopbar();
    addWandItem();
    registerCommand();
    wireEvents();
    loadCache();
    updateLauncherBadge();
    setTimeout(() => { reload().catch(() => {}); }, 4000); // badge counts; after the app has settled
    setTimeout(checkForNewVersion, 5000);
    console.log(LOG, 'loaded', VERSION);
}

globalThis.ChatBrowser = { open: openBrowser, close: closeBrowser, reload, data, VERSION };

if (typeof jQuery === 'function') jQuery(init); else init();
