/*
 * Reverie (formerly Chat Browser) — SillyTavern UI extension
 *
 * Every chat of every character and group in one list: open any of them in one tap,
 * see which chats continue one story, which persona a chat is tied to and how many
 * messages arrived since this device last looked. Pin, rename, delete, link parts of a
 * story, and run Sync / Clean Sync through Chat Auto Backup.
 *
 * The gallery (gallery.js) is a library of every character and group card, and each
 * character can be edited on a phone with the card editor (editor.js).
 *
 * Settings stay under the key "chat_browser" and the CSS prefix "cb_", so pins, unread
 * counts and the launcher's look carry over from Chat Browser.
 */

import { installThemePalette } from './theme-palette.js';
import { installNightAccent } from './night-palette.js';
import { floatColors, COLOR_MODE_LABELS } from './float-colors.js';
import { buildCards, buildEntries, cardButtonAction, cleanPreview, clip, compareText, fileName, fullTime, chatSig, linkStories, mergeChats, pageEntries, pageRange, PAGE_SIZES, relTime, renameInMeta, toMs, windowSettled } from './lib.js';
import {
    VERSION, LOG, BASE_URL, CACHE_KEY, SEEN_KEY, CHUNK, DEFAULTS, ctx, settings, saveSettings, esc, toast, wait, errText, lsGet, lsSet, loadChatCache, saveChatCache, cab, st,
    charOf, charIndex, groupOf, thumb, personaName, personaOf, currentKey, isGenerating, data, post, clamp, ui, app,
    sheet, sheetConfirm, sheetPrompt, sheetPick,
} from './core.js';
import { galleryUi, cardSearchText, openCard, closeCard, setGallerySize, stepCard, zoomCover, galleryEntities, pickTags, startNewChat, bulkAvailable, handOffToBulk, updateFromFile } from './gallery.js';
import { openEditor, editorOpen, closeEditor, closeEditorGuarded } from './editor.js';
import { HOVERS, applyHover, askGyro, gyroSupported, hoverMode, resetScrollFx, syncGyro, watchTilesFx, wireCoverFx } from './fx.js';

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
    // Depth as SillyTavern counts it: 0 = the newest message. Scripts limited to older
    // messages (minDepth) must not touch the newest one.
    const inDepth = (s, depth) => {
        const min = Number(s.minDepth), max = Number(s.maxDepth);
        if (s.minDepth !== null && s.minDepth !== '' && Number.isFinite(min) && min >= -1 && depth < min) return false;
        if (s.maxDepth !== null && s.maxDepth !== '' && Number.isFinite(max) && max >= 0 && depth > max) return false;
        return true;
    };
    return (text, { avatar = null, user = false, name, depth = 0 } = {}) => {
        let scripts = base;
        if (avatar) {
            if (!byAvatar.has(avatar)) byAvatar.set(avatar, [...base, ...regex.scoped(avatar).filter(ok)]);
            scripts = byAvatar.get(avatar);
        }
        const place = user ? 1 : 2; // USER_INPUT / AI_OUTPUT
        let out = String(text ?? '');
        for (const s of scripts) {
            if (!s.placement.includes(place) || !inDepth(s, depth)) continue;
            try { out = regex.run(s, out, { characterOverride: name }); } catch { /* a broken script: skip it */ }
        }
        return out;
    };
}

/**
 * The story text of a message. Hiding scripts run first, but they never get to erase the
 * story: when their result is empty or far shorter than the message cleaned on its own
 * (a script matching much more than its status line), the message cleaned on its own wins.
 */
function storyOf(text, rx, opts) {
    const plain = cleanPreview(text, { keepLines: true });
    let hidden = plain;
    try { hidden = cleanPreview(rx(text, opts), { keepLines: true }); } catch { /* a broken script */ }
    return hidden && hidden.length >= plain.length * 0.5 ? hidden : plain;
}

/**
 * A chat from the server as the list keeps it. `ents` looks characters and groups up by id (a
 * linear search per chat is too slow with thousands of cards). `old` is the cached row of the
 * same chat: unchanged, its cleaned preview is kept and the message is not cleaned again.
 */
function normalize(x, rx, ents, old = null) {
    const c = ctx();
    const file = String(x?.file_name ?? '');
    const chatId = file.replace(/\.jsonl$/i, '');
    if (!chatId) return null;
    let type, entity, entityName;
    if (x.group) {
        const g = ents.groups.get(String(x.group));
        if (!g) return null;
        type = 'group'; entity = String(g.id); entityName = g.name;
    } else {
        const ch = ents.chars.get(x.avatar);
        if (!ch) return null;
        type = 'character'; entity = ch.avatar; entityName = ch.name;
    }
    const meta = x.chat_metadata && typeof x.chat_metadata === 'object' ? x.chat_metadata : {};
    const mh = meta.memory_hub;
    const count = Number(x.chat_items) || 0;
    const persona = typeof meta.persona === 'string' && meta.persona ? meta.persona : null;
    const row = {
        key: `${type === 'group' ? 'g' : 'c'}:${entity}:${chatId}`,
        type, entity, entityName, chatId,
        count,
        last: toMs(x.last_mes, c.timestampToMoment),
        size: String(x.file_size ?? ''),
        preview: '',
        noStory: false,
        persona,
        personaName: persona ? personaName(persona) : '',
        chain: Array.isArray(mh?.chain) ? mh.chain.map(String) : [],
        memories: Array.isArray(mh?.memories) ? mh.memories.length : 0,
        prev: typeof meta.chat_browser?.prev === 'string' ? meta.chat_browser.prev : null,
        mainChat: typeof meta.main_chat === 'string' && meta.main_chat ? meta.main_chat : null,
    };
    if (old && old.key === row.key && chatSig(old) === chatSig(row)) {
        row.preview = old.preview;
        row.noStory = old.noStory;
        return row;
    }
    const raw = String(x.mes ?? '');
    const empty = /^\[The (chat|message) is empty\]$/.test(raw);
    row.preview = count && !empty ? clip(storyOf(raw, rx, { avatar: type === 'character' ? entity : null, name: entityName }).replace(/\n{2,}/g, '\n'), 1200) : '';
    row.noStory = !row.preview && count > 0 && !!raw.trim() && !empty;
    row.cleaned = true; // for normalizeAll's pacing; not kept
    return row;
}

/** Characters and groups by id, built once per load. */
function entityMaps() {
    const c = ctx();
    return {
        chars: new Map((c.characters || []).filter(ch => ch?.avatar).map(ch => [ch.avatar, ch])),
        groups: new Map((c.groups || []).filter(g => g?.id != null).map(g => [String(g.id), g])),
    };
}

/**
 * Every row through normalize, a batch at a time: cleaning thousands of messages in one go
 * froze the screen for seconds on a phone. Between batches the page gets to draw and respond.
 */
async function normalizeAll(raw, rx, reuse) {
    const ents = entityMaps();
    const out = [];
    let cleaned = 0;
    for (const x of Array.isArray(raw) ? raw : []) {
        const file = String(x?.file_name ?? '').replace(/\.jsonl$/i, '');
        const key = x?.group ? `g:${x.group}:${file}` : `c:${x?.avatar}:${file}`;
        const row = normalize(x, rx, ents, reuse.get(key));
        if (!row) continue;
        if (row.cleaned) { delete row.cleaned; if (++cleaned % 150 === 0) await wait(0); }
        out.push(row);
    }
    return out;
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

/**
 * The newest-modified `max` chats (0 = all of them). SillyTavern reads every file it returns to
 * the end to count the messages, so asking for all of them is the slow part with many chats.
 * null: this SillyTavern has no such endpoint.
 */
async function fetchRecent(max) {
    try {
        const raw = await (await post('/api/chats/recent', max ? { metadata: true, max } : { metadata: true })).json();
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

const FIRST_WINDOW = 40;     // chats asked for on a quick refresh
const MAX_WINDOW = 2000;     // past this, a full scan is the cheaper way
const FULL_EVERY = 24 * 3_600_000; // a full scan at least once a day: chats deleted elsewhere, changed cards

/** Which display scripts and cleaning made the cached previews: when this changes, they are made again. */
function previewKey() {
    try {
        const list = regex?.base?.() ?? [];
        return `${VERSION}|${list.map(x => `${x.id}:${x.disabled ? 0 : 1}:${x.findRegex}:${x.replaceString ?? ''}:${(x.placement || []).join(',')}`).join('|')}`;
    } catch { return VERSION; }
}

/**
 * The chat list from the server: a quick refresh (only the chats changed since the cache) when
 * it can, or every chat. Returns { list, complete, key }.
 */
async function fetchChats(full) {
    await loadRegex();
    const rx = displayRegexer();
    const key = previewKey();
    if (key !== data.rxKey) full = true; // previews made with other scripts: clean everything again
    const reuse = new Map(data.byKey);
    if (!full) {
        for (let asked = FIRST_WINDOW; asked <= MAX_WINDOW; asked *= 5) {
            const raw = await fetchRecent(asked);
            if (!raw) break; // an old SillyTavern: the full way
            const fresh = await normalizeAll(raw, rx, reuse);
            // a server that ignored max returned everything
            const state = raw.length > asked ? 'complete' : windowSettled(fresh, data.byKey, asked);
            if (state === 'complete') return { list: fresh, complete: true, key };
            if (state === 'settled') {
                const changed = fresh.filter(r => { const old = data.byKey.get(r.key); return !old || chatSig(old) !== chatSig(r) || old.preview !== r.preview; });
                return { list: changed.length ? mergeChats(data.chats, fresh) : data.chats, complete: false, changed, key };
            }
            for (const r of fresh) reuse.set(r.key, r); // the next, bigger window keeps what was cleaned
        }
    }
    const raw = (await fetchRecent(0)) ?? await fetchOldWay();
    return { list: await normalizeAll(raw, rx, reuse), complete: true, key };
}

/** Rows of characters or groups that no longer exist go; renamed ones get their new name. */
function reconcile(list) {
    const { chars, groups } = entityMaps();
    const dropped = [], renamed = [];
    if (!chars.size && !groups.size) return { list, dropped, renamed }; // SillyTavern has not loaded its cards yet
    const kept = list.filter(c => {
        const e = c.type === 'group' ? groups.get(c.entity) : chars.get(c.entity);
        if (!e) { dropped.push(c.key); return false; }
        if (e.name && e.name !== c.entityName) { c.entityName = e.name; renamed.push(c); }
        return true;
    });
    return { list: dropped.length ? kept : list, dropped, renamed };
}

function setChats(list) {
    data.rev++;
    data.chats = list;
    data.byKey = new Map(list.map(x => [x.key, x]));
}

/** Save to IndexedDB: `touched` = keys of the rows that changed or went (null after a full read: all). */
function saveCache(touched = null) {
    saveChatCache({ v: 2, at: data.at, fullAt: data.fullAt, rxKey: data.rxKey }, data.chats, touched);
}

/**
 * Bring the list up to date (callers share the running load). `full`: read every chat again —
 * after a rename or a Clean Sync, where a quick refresh would miss chats that went away.
 */
function reload({ full = false } = {}) {
    if (full) data.wantFull = true;
    if (data.loading) {
        // a full scan asked for during a quick one runs right after it
        return full && !data.loadingFull ? data.loading.then(() => reload({ full: true })) : data.loading;
    }
    ui.setLoading(true);
    data.loading = (async () => {
        try {
            await cacheReady;
            const doFull = data.wantFull || !data.fullAt || !data.chats.length || Date.now() - data.fullAt > FULL_EVERY;
            data.wantFull = false;
            data.loadingFull = doFull;
            const r = await fetchChats(doFull);
            const rec = reconcile(r.list);
            if (rec.list !== data.chats) setChats(rec.list);
            data.at = Date.now();
            if (r.complete) data.fullAt = data.at;
            data.rxKey = r.key;
            data.error = '';
            baselineSeen();
            saveCache(r.complete ? null : [...r.changed.map(c => c.key), ...rec.renamed.map(c => c.key), ...rec.dropped]);
        } catch (e) {
            console.error(LOG, e);
            data.error = errText(e);
            toast.err(`โหลดรายชื่อแชทไม่สำเร็จ: ${data.error}`);
        } finally {
            data.loading = null;
            data.loadingFull = false;
            ui.setLoading(false);
            ui.render();
            updateLauncherBadge();
        }
    })();
    return data.loading;
}

/**
 * The list saved last time, shown at once while the server is asked. Kept in IndexedDB; a list
 * from an older version in localStorage is moved over once (and the space freed).
 */
const cacheReady = (async () => {
    const { meta, rows } = await loadChatCache();
    let c = meta && rows.length ? { ...meta, chats: rows } : null;
    const old = lsGet(CACHE_KEY, null);
    if (old) {
        if (!c && Array.isArray(old.chats)) c = { at: old.at || 0, fullAt: old.at || 0, rxKey: null, chats: old.chats };
        try { localStorage.removeItem(CACHE_KEY); } catch { /* blocked */ }
    }
    if (Array.isArray(c?.chats) && !data.chats.length) {
        setChats(c.chats);
        data.at = c.at || 0;
        data.fullAt = c.fullAt || 0;
        data.rxKey = c.rxKey ?? null;
    }
})().catch(e => console.warn(LOG, 'cache', e));

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
    if (item) { data.byKey.delete(oldKey); item.key = newKey; item.chatId = newId; data.byKey.set(newKey, item); data.rev++; }
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
            data.rev++;
        } catch (e) {
            console.warn(LOG, 'relink', c.key, e);
            toast.warn(`แก้ลิงก์ตอนต่อในแชท "${c.chatId}" ไม่สำเร็จ: ${errText(e)}`);
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
    saveCache([x.key]);
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
    data.rev++;
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
    ['gallery', 'fa-solid fa-table-cells-large', 'แกลเลอรี — ปกการ์ด แตะเพื่อดูรายละเอียดและแชทของการ์ดนั้น'],
];
// 'character' is the list's own (sections per character); 'added' is the gallery's (cards by date added)
const SORTS = [['recent', 'ล่าสุด'], ['character', 'ตัวละคร'], ['added', 'เพิ่มล่าสุด'], ['name', 'ชื่อ'], ['size', 'ยาวสุด']];
/** The sort that applies in the current view: each view lacks one of the sorts. */
const sortFor = (s, gallery) => (gallery ? (s.sort === 'character' ? 'name' : s.sort) : (s.sort === 'added' ? 'recent' : s.sort));

Object.assign(ui, {
    root: null,
    query: '',
    filter: 'all',      // all | unread | pinned | group
    entity: null,       // "type|entity" — only this character/group
    persona: null,
    selecting: false,
    selected: new Set(),
    selCards: new Set(), // gallery: cards picked for Bulk Manager ("type|entity")
    collapsed: new Set(), // character sections folded
    expanded: new Set(),  // stories showing their older parts
    history: new Map(),   // key → loaded recent messages (detail view)
    entries: [],
    shown: 0,
    shownN: 0,          // chats on screen, for the counter in the title
    observer: null,
    busy: false,
    // gallery
    cards: [],          // cards on the grid, in order (also prev / next on a card page)
    card: null,         // "type|entity" of the card page on screen, or null for the grid
    gridTop: 0,         // grid scroll position, restored on the way back
    noteOpen: false,    // creator's note shown in full
    animate: false,     // tiles fade in one after another on the next grid render (not on every refresh)
    imgObserver: null,
    // pages
    page: 1,            // page on screen (grid or list)
    pageKey: '',        // what the page counts through: a new search, filter, sort or page size starts at page 1
    pageInfo: null,     // { page, pages, total, kind: 'cards' | 'chats' } of the grid or list on screen

    setLoading(on) {
        this.root?.querySelector('.cb_spin')?.toggleAttribute('hidden', !on);
    },

    render() {
        if (!this.root) return;
        const s = settings();
        const gallery = s.view === 'gallery';
        this.root.dataset.view = s.view;
        this.root.classList.toggle('cb_selecting', this.selecting);
        const opts = { query: this.query, filter: this.filter, entity: this.entity, persona: this.persona, pins: s.pins, unreadOf };
        let card = null;
        if (gallery) {
            // every character and group, also those without a chat yet
            const entities = galleryEntities();
            this.cards = buildCards(data.chats, { ...opts, sort: sortFor(s, true), extraText: cardSearchText, entities, tags: s.galleryTags, fav: s.galleryFav });
            // the card page keeps the grid's page, so "back" lands where it was
            if (!this.card) this.turnTo('cards', this.cards.length, s);
            // A card page lists every chat of that card, whatever the grid is filtered by.
            if (this.card) card = buildCards(data.chats, { entity: this.card, pins: s.pins, unreadOf, entities })[0] ?? null;
            if (!card) this.card = null;
            const chatSort = sortFor(s, false);
            this.entries = card
                ? buildEntries(data.chats, { sort: chatSort === 'character' ? 'recent' : chatSort, merge: s.merge, entity: this.card, pins: s.pins, unreadOf, stories: linkInfo })
                : [];
            this.shownN = card ? card.count : this.cards.reduce((n, x) => n + x.count, 0);
        } else {
            this.card = null;
            const all = buildEntries(data.chats, { ...opts, sort: sortFor(s, false), merge: s.merge, stories: linkInfo });
            this.shownN = all.filter(e => e.kind === 'chat').length;
            const pe = pageEntries(all, s.pageChats, this.pageFor('chats', s));
            this.page = pe.page;
            this.pageInfo = { page: pe.page, pages: pe.pages, total: this.shownN, kind: 'chats' };
            this.entries = pe.entries;
        }
        this.root.classList.toggle('cb_oncard', !!card);
        this.root.querySelector('.cb_cardnav').hidden = !card;
        this.renderControls();
        const list = this.root.querySelector('.cb_list');
        const top = list.scrollTop;
        this.observer?.disconnect();
        this.imgObserver?.disconnect();
        this.shown = 0;
        list.replaceChildren();
        if (card) {
            list.innerHTML = this.cardHtml(card);
            if (this.entries.length) this.more();
            this.fitNote();
        } else if (gallery) {
            const anim = this.animate && this.cards.length ? ' cb_anim' : '';
            if (anim) this.animate = false;
            const size = s.gallerySize === 'compact' ? 'compact' : 'large';
            const sizeBtn = (id, icon, tip) => `<button data-gsize="${id}" class="${size === id ? 'cb_on' : ''}" title="${tip}" aria-label="${tip}"><i class="${icon}"></i></button>`;
            const pg = this.pageInfo;
            const r = pageRange(this.cards.length, s.pageCards, pg.page);
            const count = pg.pages > 1 ? `${r.from + 1}–${r.to} จาก ${this.cards.length.toLocaleString('th-TH')} การ์ด` : `${this.cards.length.toLocaleString('th-TH')} การ์ด`;
            list.innerHTML = this.cards.length
                ? `<div class="cb_gridbar"><span>${count}</span><div class="rv_pgtools">${this.pagerHtml(true)}<div class="cb_seg cb_gsize">${sizeBtn('large', 'fa-solid fa-table-cells-large', 'ภาพใหญ่')}${sizeBtn('compact', 'fa-solid fa-table-cells', 'กะทัดรัด — เห็นการ์ดได้มากขึ้น')}</div></div></div>
                    <div class="cb_grid cb_g_${size}${anim}" style="--step:${size === 'compact' ? 12 : 28}ms">${this.cards.slice(r.from, r.to).map((x, i) => this.tileHtml(x, i)).join('')}</div>
                    ${this.pagerHtml()}`
                : this.emptyHtml();
            this.watchCovers();
            watchTilesFx(list);
        } else if (!this.entries.length) {
            list.innerHTML = this.emptyHtml();
        } else {
            list.insertAdjacentHTML('beforeend', this.listBarHtml());
            this.more();
        }
        list.scrollTop = top;
        this.renderSelbar();
    },

    /** The page to show of `kind`: page 1 again once the search, filters, sort or page size changed. */
    pageFor(kind, s) {
        const size = kind === 'cards' ? s.pageCards : s.pageChats;
        const key = [kind, size, this.query, this.filter, this.entity, this.persona, sortFor(s, kind === 'cards'), s.merge, s.galleryTags.join('\u0001'), s.galleryFav].join('\u0000');
        if (key !== this.pageKey) { this.pageKey = key; this.page = 1; }
        return this.page;
    },

    /** The grid's page: which page and how many, clamped to what there is now. */
    turnTo(kind, total, s) {
        const r = pageRange(total, s.pageCards, this.pageFor(kind, s));
        this.page = r.page;
        this.pageInfo = { page: r.page, pages: r.pages, total, kind };
    },

    /**
     * Pager. `top`: ‹ 3/42 › and how many per page, above the grid or list (the size picker only once
     * there are more items than the smallest page). At the end: ‹ หน้า 3 / 42 ›, only with more than one page.
     */
    pagerHtml(top = false) {
        const p = this.pageInfo;
        if (!p) return '';
        const s = settings();
        const sizes = PAGE_SIZES[p.kind];
        const size = p.kind === 'cards' ? s.pageCards : s.pageChats;
        const nav = p.pages > 1 ? `<div class="rv_pgnav">
                <button class="cb_iconbtn" data-pg="-1"${p.page > 1 ? '' : ' disabled'} title="หน้าก่อน" aria-label="หน้าก่อน"><i class="fa-solid fa-chevron-left"></i></button>
                <button class="rv_pgnum" data-pgjump="1" title="ไปหน้าที่…" aria-label="หน้า ${p.page} จาก ${p.pages} — แตะเพื่อเลือกหน้า">${top ? '' : 'หน้า '}${p.page}<span>/${p.pages}</span></button>
                <button class="cb_iconbtn" data-pg="1"${p.page < p.pages ? '' : ' disabled'} title="หน้าถัดไป" aria-label="หน้าถัดไป"><i class="fa-solid fa-chevron-right"></i></button>
            </div>` : '';
        if (!top) return nav ? `<div class="rv_pager">${nav}</div>` : '';
        if (p.total <= sizes[1] && !size) return nav;
        const unit = p.kind === 'cards' ? 'การ์ด' : 'แชท';
        const opts = sizes.map(n => `<option value="${n}"${n === size ? ' selected' : ''}>${n ? `${n} ต่อหน้า` : 'แสดงทั้งหมด'}</option>`).join('');
        return `${nav}<select data-pgsize="${p.kind}" class="rv_pgselect" aria-label="จำนวน${unit}ต่อหน้า" title="จำนวน${unit}ต่อหน้า">${opts}</select>`;
    },

    /** The bar above the list: how many chats, ‹ › and per page (nothing for a short list). */
    listBarHtml() {
        const p = this.pageInfo;
        const pager = this.pagerHtml(true);
        if (!p || !pager) return '';
        const r = pageRange(p.total, settings().pageChats, p.page);
        const count = p.pages > 1 ? `${r.from + 1}–${r.to} จาก ${p.total.toLocaleString('th-TH')} แชท` : `${p.total.toLocaleString('th-TH')} แชท`;
        return `<div class="rv_pagetop"><span>${count}</span><div class="rv_pgtools">${pager}</div></div>`;
    },

    emptyHtml() {
        if (!data.chats.length && (data.loading || !data.at)) return '<div class="cb_empty"><i class="fa-solid fa-circle-notch fa-spin"></i><span>กำลังโหลดรายชื่อแชท…</span></div>';
        if (data.error && !data.chats.length) return `<div class="cb_empty"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(data.error)}</span></div>`;
        if (this.query) return `<div class="cb_empty"><i class="fa-solid fa-magnifying-glass"></i><span>ไม่พบแชทที่ตรงกับ “${esc(this.query)}”</span></div>`;
        if (this.filter === 'unread') return '<div class="cb_empty"><i class="fa-solid fa-check-double"></i><span>อ่านครบทุกแชทแล้ว</span></div>';
        if (this.filter === 'pinned') return '<div class="cb_empty"><i class="fa-solid fa-thumbtack"></i><span>ยังไม่ได้ปักหมุดแชทไหน<br><small>กด ⋯ ที่แชทแล้วเลือก “ปักหมุด”</small></span></div>';
        const s = settings();
        if (s.view === 'gallery' && (s.galleryTags.length || s.galleryFav)) return '<div class="cb_empty"><i class="fa-solid fa-filter-circle-xmark"></i><span>ไม่มีการ์ดที่ตรงกับตัวกรอง<br><button class="cb_btn rv_clearfilters" data-clearfilters="1">ล้างตัวกรอง</button></span></div>';
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
        // the list's last rows end with the pager (on the card page the list is that card's chats: no pages)
        if (to === this.entries.length && !this.card) html.push(this.pagerHtml());
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
            ${ava}<span class="cb_sec_title">${esc(e.title)}${e.cont ? '<small class="rv_cont"> (ต่อ)</small>' : ''}</span><span class="cb_sec_count">${e.count}</span>
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
                    ${part && e.story && !compact ? `<button class="cb_pill cb_part cb_partsbtn${expanded ? ' cb_on' : ''}" data-parts="1" title="เรื่องต่อเนื่อง ${parts.length} แชท · รวม ${e.story.total} ข้อความ — แตะเพื่อดูทุกตอน"><i class="fa-solid fa-link"></i>ตอน ${part}/${parts.length}<i class="fa-solid fa-chevron-${expanded ? 'up' : 'down'} cb_pchev"></i></button>`
                        : part && !e.story ? '<span class="cb_pill cb_part" title="ตอนต่อของแชทก่อนหน้า (แชทก่อนหน้าถูกลบหรือเปลี่ยนชื่อแล้ว)"><i class="fa-solid fa-link"></i>ตอน ' + part + '</span>' : ''}
                    ${showParts && compact ? this.chipsHtml(parts, c, cur, true) : ''}
                    ${branchOf ? `<span class="cb_pill cb_branch" title="แตกกิ่งมาจาก ${esc(branchOf)}"><i class="fa-solid fa-code-branch"></i>กิ่ง</span>` : ''}
                    ${this.countHtml(c, e.story)}
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

    /** How many messages the chat has, on the row's first line (the detail view says it in its own line). */
    countHtml(c, story) {
        const n = Number(c.count) || 0;
        const label = `${n} ข้อความ${story ? ` · ทั้งเรื่อง ${story.total}` : ''}`;
        return `<span class="cb_count" title="${label}" aria-label="${label}"><i class="fa-regular fa-message"></i>${n.toLocaleString('th-TH')}</span>`;
    },

    /** One button per part of the story; tap opens that part. */
    chipsHtml(parts, head, cur, short) {
        // Compact rows keep to one line: the last three parts, plus a button for the full list.
        const hidden = short && parts.length > 3 ? parts.length - 3 : 0;
        const shown = hidden ? parts.slice(-3) : parts;
        const more = short ? `<button class="cb_partchip cb_partsbtn${this.expanded.has(head.key) ? ' cb_on' : ''}" data-parts="1" title="ทุกตอน (${parts.length})">${hidden ? `+${hidden}` : '<i class="fa-solid fa-link"></i>'}</button>` : '';
        return `<div class="cb_parts${short ? ' cb_parts_inline' : ''}">${more}${shown.map(p => {
            const pp = linkInfo.get(p.key)?.part ?? 1;
            const u = unreadOf(p);
            return `<button class="cb_partchip${p.key === head.key ? ' cb_on' : ''}${p.key === cur ? ' cb_cur' : ''}" data-open="${esc(p.key)}" title="ตอน ${pp}: ${esc(p.chatId)} · ${p.count} ข้อความ · ${esc(relTime(p.last))}">${short ? '' : 'ตอน '}${pp}${u ? `<b>+${u}</b>` : ''}</button>`;
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
        const gallery = s.view === 'gallery';
        const sort = sortFor(s, gallery);
        r.querySelectorAll('.cb_sort [data-sort]').forEach(b => {
            b.classList.toggle('cb_on', b.dataset.sort === sort);
            b.hidden = b.dataset.sort === (gallery ? 'character' : 'added');
        });
        // the gallery's select button picks cards: mark them read, or hand them to Bulk Manager when installed
        const sel = r.querySelector('.cb_selectbtn');
        const cardsMode = gallery && !this.card;
        sel.title = cardsMode ? 'เลือกหลายการ์ด' : 'เลือกหลายแชท';
        r.querySelectorAll('.cb_view [data-view]').forEach(b => b.classList.toggle('cb_on', b.dataset.view === s.view));
        const unread = totalUnread();
        const groupsN = gallery ? (ctx().groups || []).length : data.chats.filter(c => c.type === 'group').length;
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
            gallery ? `<button class="cb_chip cb_toggle${s.galleryFav ? ' cb_on' : ''}" data-fav="1" title="เฉพาะตัวละครและกลุ่มที่ติดดาวไว้"><i class="fa-solid fa-star"></i>โปรด</button>` : '',
            gallery ? `<button class="cb_chip rv_tagchip${s.galleryTags.length ? ' cb_on' : ''}" data-tags="1" aria-haspopup="dialog" title="กรองตามแท็ก"><i class="fa-solid fa-tags"></i><b>${s.galleryTags.length ? esc(s.galleryTags.length > 2 ? `${s.galleryTags.slice(0, 2).join(', ')} +${s.galleryTags.length - 2}` : s.galleryTags.join(', ')) : 'แท็ก'}</b>${s.galleryTags.length ? '<i class="fa-solid fa-xmark" data-cleartags="1"></i>' : '<i class="fa-solid fa-chevron-down cb_chipchev"></i>'}</button>` : '',
            groupsN ? chip('group', gallery ? 'กลุ่ม' : 'แชทกลุ่ม', 0, 'fa-solid fa-users') : '',
            ent ? `<button class="cb_chip cb_on cb_entchip" data-entity="">${esc(ent.entityName)}<i class="fa-solid fa-xmark"></i></button>`
                : curChat ? `<button class="cb_chip" data-entity="${esc(`${curChat.type}|${curChat.entity}`)}"><i class="fa-solid fa-user"></i>${s.view === 'gallery' ? '' : 'เฉพาะ '}${esc(curChat.entityName)}</button>` : '',
            personas.length > 1 ? `<button class="cb_chip cb_personachip${this.persona ? ' cb_on' : ''}" data-personas="1" aria-haspopup="menu">${this.persona ? `<img src="${esc(thumb('persona', this.persona))}" alt="">` : '<i class="fa-solid fa-masks-theater"></i>'}<b>${esc(this.persona ? personas.find(([id]) => id === this.persona)?.[1] ?? this.persona : 'ทุก persona')}</b><i class="fa-solid fa-chevron-down cb_chipchev"></i></button>` : '',
            `<button class="cb_chip cb_toggle${s.merge ? ' cb_on' : ''}" data-merge="1" title="รวมแชทที่ต่อเรื่องกันเป็นแถวเดียว"><i class="fa-solid fa-link"></i>รวมตอนต่อ</button>`,
        ].join('');
        const shownChats = this.shownN;
        r.querySelector('.cb_title b').textContent = gallery ? 'การ์ด' : 'แชท';
        r.querySelector('.cb_title > i').className = gallery ? 'fa-solid fa-id-card' : 'fa-solid fa-comments';
        if (gallery && !this.card) {
            const all = galleryEntities().length;
            r.querySelector('.cb_total').textContent = this.cards.length === all ? `${all}` : `${this.cards.length}/${all}`;
        } else {
            r.querySelector('.cb_total').textContent = shownChats === data.chats.length || !data.chats.length ? `${data.chats.length}` : `${shownChats}/${data.chats.length}`;
        }
        this.renderSync();
    },

    renderSync() {
        const r = this.root;
        if (!r) return;
        const a = cab();
        const on = !!a?.dropboxConnected?.();
        const synced = on && a.syncInUse?.();
        const st0 = on ? a.syncState?.() : null;
        // shown only with Chat Auto Backup installed and connected to Dropbox
        for (const b of r.querySelectorAll('.cb_sync, .cb_clean')) {
            b.hidden = !on;
            b.classList.toggle('cb_disabled', b.classList.contains('cb_clean') && !synced);
        }
        if (!on) return;
        const syncBtn = r.querySelector('.cb_sync');
        syncBtn.title = `ซิงค์กับ Dropbox ตามปกติ${st0?.lastAt ? ` · ล่าสุด ${new Date(st0.lastAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : ''}${st0?.decisions ? ` · รอเลือก ${st0.decisions} รายการ` : ''}`;
        syncBtn.classList.toggle('cb_working', !!st0?.running || this.busy === 'sync');
        syncBtn.querySelector('.cb_dot')?.toggleAttribute('hidden', !st0?.decisions && !st0?.error);
        r.querySelector('.cb_clean').title = !synced ? 'ใช้ได้เมื่อเปิดซิงค์แชทระหว่างเครื่องใน Chat Auto Backup แล้ว (กดซิงค์อย่างน้อยหนึ่งครั้ง)' : 'ทำให้ Dropbox และทุกเครื่องมีแชทเหมือนเครื่องนี้เป๊ะ';
    },

    /** What select mode picks here: cards on the gallery grid, chats everywhere else. */
    selectsCards() {
        return settings().view === 'gallery' && !this.card;
    },

    renderSelbar() {
        const bar = this.root?.querySelector('.cb_selbar');
        if (!bar) return;
        bar.hidden = !this.selecting;
        if (!this.selecting) return;
        const cards = this.selectsCards();
        bar.classList.toggle('rv_cardsel', cards);
        const n = cards ? this.selCards.size : this.selected.size;
        bar.querySelector('.cb_selcount').textContent = cards ? (n ? `${n} การ์ด` : 'แตะเลือกการ์ด') : (n ? `เลือก ${n} แชท` : 'แตะแชทเพื่อเลือก');
        const bm = bulkAvailable();
        // Bulk Manager takes characters only: its buttons wait for one among the picked cards
        const chars = cards && [...this.selCards].some(id => id.startsWith('character|'));
        bar.querySelectorAll('[data-bulk]').forEach(b => {
            const forCards = b.hasAttribute('data-cards');
            const forBm = b.hasAttribute('data-bm');
            b.hidden = b.dataset.bulk !== 'done' && (forCards !== cards || (forBm && !bm));
            b.classList.toggle('cb_disabled', b.dataset.bulk !== 'done' && (!n || (forBm && !chars)));
        });
    },
});
Object.assign(ui, galleryUi);

let linkInfo = new Map(); // key → story info, made again when the list or a link in it changed
let linkRev = -1;
const _render = ui.render.bind(ui);
ui.render = function () {
    if (linkRev !== data.rev) { linkInfo = linkStories(data.chats); linkRev = data.rev; }
    _render();
};

/** Cards or chats per page (0 = all), from the pager or the settings panel. */
function setPageSize(kind, n) {
    const s = settings();
    const key = kind === 'cards' ? 'pageCards' : 'pageChats';
    s[key] = PAGE_SIZES[kind]?.includes(n) ? n : 0;
    saveSettings();
    const box = document.getElementById(kind === 'cards' ? 'cb_set_pagecards' : 'cb_set_pagechats');
    if (box) box.value = String(s[key]);
    if (ui.root) ui.render();
}

function chatFromRow(row) {
    return row ? data.byKey.get(row.dataset.key) : null;
}

// theme colours, or a light / dark look that ignores the theme
const SCHEMES = [
    ['theme', 'fa-solid fa-palette', 'สีตามธีม'],
    ['light', 'fa-solid fa-sun', 'กลางวัน'],
    ['dark', 'fa-solid fa-moon', 'กลางคืน'],
];

function applyScheme(root = ui.root) {
    if (!root) return;
    const s = settings();
    const i = Math.max(0, SCHEMES.findIndex(x => x[0] === s.scheme));
    const [id, icon, label] = SCHEMES[i];
    const next = SCHEMES[(i + 1) % SCHEMES.length][2];
    if (id === 'theme') delete root.dataset.scheme; else root.dataset.scheme = id;
    const b = root.querySelector('.cb_scheme');
    if (!b) return;
    b.innerHTML = `<i class="${icon}"></i>`;
    b.title = `สี: ${label} — แตะเพื่อเปลี่ยนเป็น${next}`;
    b.setAttribute('aria-label', b.title);
}

// ---------------------------------------------------------------- diagnostics (phones have no console)

const diagLog = [];
function diag(msg) {
    diagLog.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
    if (diagLog.length > 30) diagLog.shift();
}

/** Show an error on screen as well as in the console. */
function reportError(where, err) {
    console.error(LOG, where, err);
    diag(`ERROR ${where}: ${err?.stack || err}`);
    try { globalThis.toastr?.error(`${where}: ${err?.message ?? err}`, 'Reverie', { timeOut: 15000, extendedTimeOut: 15000 }); } catch { /* ignore */ }
}

window.addEventListener('error', e => {
    if (String(e.filename || '').startsWith(BASE_URL.href)) diag(`window error ${e.message} @${String(e.filename).slice(BASE_URL.href.length)}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', e => {
    if (String(e.reason?.stack || '').includes(BASE_URL.href)) diag(`unhandled ${e.reason?.message ?? e.reason}`);
});

function elName(el) {
    if (!el) return 'null';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName?.toLowerCase()}${el.id ? '#' + el.id : ''}${cls}`;
}

/** Ancestors whose style makes position:fixed follow them instead of the screen, or that hide everything. */
function fixedBreakers(el) {
    const out = [];
    for (let n = el?.parentElement; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const bad = ['transform', 'perspective', 'filter', 'backdropFilter', 'contain', 'willChange']
            .filter(k => cs[k] && !['none', 'normal', 'auto', ''].includes(cs[k]))
            .map(k => `${k}:${cs[k]}`);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') bad.push(`display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity}`);
        if (bad.length) out.push(`${elName(n)} {${bad.join('; ')}}`);
    }
    return out;
}

/** Open the browser, measure what is really on screen, close it again, and return a report. */
async function runDiagnostics() {
    const lines = [];
    const add = (k, v) => lines.push(`${k}: ${v}`);
    let remote = '?';
    try { remote = String((await (await fetch(new URL('manifest.json', BASE_URL), { cache: 'no-store' })).json())?.version ?? '?'); } catch { /* offline */ }
    add('version', `v${VERSION} (server ${remote})`);
    add('ua', navigator.userAgent);
    const vv = window.visualViewport;
    add('viewport', `${innerWidth}x${innerHeight} · vv ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} @${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)} scale ${vv.scale}` : '-'} · dpr ${devicePixelRatio}`);
    add('scroll', `window ${scrollX},${scrollY} · html ${document.documentElement.scrollTop} · body ${document.body.scrollTop}`);
    const s = settings();
    add('settings', `view=${s.view} launcher=${s.launcher} topbar=${s.topbar} cardButton=${s.cardButton} scheme=${s.scheme ?? '-'}`);

    const before = diagLog.length;
    const wasOpen = !!ui.root;
    if (!wasOpen) openBrowser();
    await new Promise(r => setTimeout(r, 700));
    const o = ui.root;
    add('overlay', o ? `inDOM=${document.body.contains(o)} parent=${elName(o.parentElement)} class="${o.className}"` : 'ไม่มี');
    if (o) {
        const cs = getComputedStyle(o), r = o.getBoundingClientRect();
        add('overlay style', `display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity} position:${cs.position} z:${cs.zIndex} transform:${cs.transform}`);
        add('overlay rect', `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        const p = o.querySelector('.cb_panel');
        if (p) { const rp = p.getBoundingClientRect(), cp = getComputedStyle(p); add('panel', `${Math.round(rp.left)},${Math.round(rp.top)} ${Math.round(rp.width)}x${Math.round(rp.height)} opacity:${cp.opacity} transform:${cp.transform}`); }
        add('list', `${o.querySelector('.cb_list')?.children.length ?? '-'} children`);
        add('ที่จุดบนจอ', [0.15, 0.5, 0.85].map(fy => {
            const el = document.elementFromPoint(innerWidth / 2, innerHeight * fy);
            return `${Math.round(fy * 100)}%=${o.contains(el) ? 'แผง' : elName(el)}`;
        }).join(' · '));
        const br = fixedBreakers(o);
        add('ตัวบัง fixed', br.length ? br.join(' | ') : 'ไม่มี');
    }
    add('log', '');
    lines.push(...diagLog.slice(Math.max(0, before - 8)).map(x => '  ' + x));
    if (!wasOpen) closeBrowser();
    return lines.join('\n');
}

function openBrowser() {
    diag('open');
    if (ui.root) { ui.root.querySelector('.cb_search')?.focus(); return; }
    ui.openedAt = Date.now();
    ui.query = '';
    ui.animate = true;
    importStPins();
    const s = settings();
    const root = document.createElement('div');
    root.id = 'cb_root';
    root.className = 'cb_root';
    root.innerHTML = `
        <div class="cb_backdrop"></div>
        <section class="cb_panel" role="dialog" aria-modal="true" aria-label="Reverie">
            <header class="cb_head">
                <div class="cb_titlebar">
                    <div class="cb_title"><i class="fa-solid fa-comments"></i><b>แชท</b><span class="cb_total"></span><i class="fa-solid fa-circle-notch fa-spin cb_spin" hidden></i></div>
                    <div class="cb_tools">
                        <button class="cb_tool cb_sync" hidden><i class="fa-solid fa-rotate"></i><span>Sync</span><i class="cb_dot" hidden></i></button>
                        <button class="cb_tool cb_clean" hidden><i class="fa-solid fa-broom"></i><span>Clean Sync</span></button>
                        <button class="cb_tool cb_scheme"></button>
                        <button class="cb_tool cb_selectbtn" title="เลือกหลายแชท"><i class="fa-regular fa-square-check"></i></button>
                        <button class="cb_tool cb_closebtn" title="ปิด (Esc)" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="cb_headmore"><div class="cb_headin">
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
                </div></div>
            </header>
            <nav class="cb_cardnav" hidden></nav>
            <div class="cb_list" role="list"></div>
            <footer class="cb_selbar" hidden>
                <span class="cb_selcount"></span>
                <button data-bulk="pin"><i class="fa-solid fa-thumbtack"></i>ปักหมุด</button>
                <button data-bulk="unpin">เลิกปัก</button>
                <button data-bulk="read"><i class="fa-solid fa-check-double"></i>อ่านแล้ว</button>
                <button data-bulk="delete" class="cb_danger"><i class="fa-solid fa-trash"></i>ลบ</button>
                <button data-bulk="cread" data-cards title="ทุกแชทของการ์ดที่เลือกอ่านแล้ว"><i class="fa-solid fa-check-double"></i>อ่านแล้ว</button>
                <button data-bulk="cdelete" data-cards data-bm class="cb_danger" title="เปิด Bulk Manager พร้อมการ์ดที่เลือก"><i class="fa-solid fa-trash"></i>ลบ</button>
                <button data-bulk="cbackup" data-cards data-bm title="เปิด Bulk Manager พร้อมการ์ดที่เลือก"><i class="fa-solid fa-box-archive"></i>สำรอง</button>
                <button data-bulk="ccopy" data-cards data-bm title="เปิด Bulk Manager พร้อมการ์ดที่เลือก"><i class="fa-solid fa-clone"></i>คัดลอก</button>
                <button data-bulk="done">เสร็จ</button>
            </footer>
            <div class="cb_layer"></div>
        </section>`;
    document.body.append(root);
    ui.root = root;
    // effects on covers: cards play again as they scroll in; the motion sensors are asked for from this tap
    resetScrollFx();
    if (settings().hoverGyro) askGyro();
    syncGyro();
    // Visible first, then filled: if drawing fails the panel still shows (with its close button) and says why.
    requestAnimationFrame(() => root.classList.add('cb_in'));
    try {
        fitViewport();
        root.dataset.view = s.view;
        applyScheme(root);
        applyHover(root);
        wireBrowser(root);
        ui.render();
    } catch (err) {
        reportError('วาด Reverie ไม่ได้', err);
    }
    if (!matchMedia('(pointer: coarse)').matches) root.querySelector('.cb_search').focus();
    // the saved list as soon as it is read, then the changes from the server
    if (!data.at) cacheReady.then(() => { if (ui.root === root && data.at) ui.render(); });
    reload();
}

function closeBrowser() {
    const root = ui.root;
    if (!root) return;
    diag(`close ${Date.now() - (ui.openedAt || 0)}ms หลังเปิด · ${(new Error().stack || '').split('\n').slice(1, 4).map(x => x.trim()).join(' < ')}`);
    closeEditor();      // its unsaved edits stay as a draft
    ui.root = null;
    syncGyro();
    ui.query = '';      // the next open starts with an empty search box, so no hidden filter is left behind
    ui.observer?.disconnect();
    ui.observer = null;
    ui.imgObserver?.disconnect();
    ui.imgObserver = null;
    ui.card = null;
    ui.selecting = false;
    ui.selected.clear();
    ui.history.clear();
    window.visualViewport?.removeEventListener('resize', fitViewportSoon);
    window.visualViewport?.removeEventListener('scroll', fitViewport);
    window.removeEventListener('resize', fitViewportSoon);
    window.removeEventListener('scroll', fitViewport);
    document.removeEventListener('focusin', fitViewportSoon);
    document.removeEventListener('focusout', fitViewportSoon);
    fitTimers.forEach(clearTimeout);
    root.classList.remove('cb_in');
    root.classList.add('cb_out');
    setTimeout(() => root.remove(), 180);
}

/**
 * The page under the browser never scrolls in SillyTavern, but iOS scrolls it to bring a focused
 * field above the keyboard, which drags the whole browser up and off the screen. Undo that.
 */
function keepPageStill() {
    const se = document.scrollingElement || document.documentElement;
    if (window.scrollX || window.scrollY || se.scrollTop || se.scrollLeft || document.body.scrollTop) {
        window.scrollTo(0, 0);
        se.scrollTop = 0;
        se.scrollLeft = 0;
        document.body.scrollTop = 0;
    }
}

/** Fit again now and as the keyboard finishes sliding in or out (iOS reports it in steps). */
let fitTimers = [];
function fitViewportSoon() {
    fitViewport();
    fitTimers.forEach(clearTimeout);
    fitTimers = [80, 250, 500].map(ms => setTimeout(fitViewport, ms));
}

/** Size the overlay to the visible viewport, so the on-screen keyboard never hides the list. */
function fitViewport() {
    const r = ui.root;
    if (!r) return;
    keepPageStill();
    const vv = window.visualViewport;
    r.style.top = `${vv ? vv.offsetTop : 0}px`;
    r.style.left = `${vv ? vv.offsetLeft : 0}px`;
    r.style.width = `${vv ? vv.width : window.innerWidth}px`;
    r.style.height = `${vv ? vv.height : window.innerHeight}px`;
    if (!r.dataset.fitWired) {
        r.dataset.fitWired = '1';
        vv?.addEventListener('resize', fitViewportSoon);
        vv?.addEventListener('scroll', fitViewport);
        window.addEventListener('resize', fitViewportSoon);
        window.addEventListener('scroll', fitViewport, { passive: true });
        document.addEventListener('focusin', fitViewportSoon);
        document.addEventListener('focusout', fitViewportSoon);
    }
}

function wireBrowser(root) {
    const s = settings();
    const list = root.querySelector('.cb_list');
    const search = root.querySelector('.cb_search');
    const clearq = root.querySelector('.cb_clearq');
    wireCoverFx(list);

    // Ignore a click that arrives right after opening: it belongs to the tap that opened the browser.
    // with the card editor open, unsaved edits are asked about first
    const tryClose = async () => { if (editorOpen() && !(await closeEditorGuarded())) return; closeBrowser(); };
    root.querySelector('.cb_backdrop').addEventListener('click', () => { if (Date.now() - (ui.openedAt || 0) > 450) tryClose(); });
    root.querySelector('.cb_closebtn').addEventListener('click', tryClose);

    let qTimer = null;
    search.addEventListener('input', () => {
        clearq.hidden = !search.value;
        clearTimeout(qTimer);
        qTimer = setTimeout(() => {
            if (ui.root !== root) return;   // closed before the debounce fired
            ui.query = search.value; ui.card = null; ui.render(); list.scrollTop = 0;
        }, 120);
    });
    clearq.addEventListener('click', e => { e.preventDefault(); search.value = ''; clearq.hidden = true; ui.query = ''; ui.card = null; ui.render(); search.focus(); });
    const searchFor = text => {
        search.value = text;
        clearq.hidden = !text;
        ui.query = text;
        ui.card = null;
        ui.render();
        list.scrollTop = 0;
    };

    root.querySelector('.cb_sort').addEventListener('click', e => {
        const b = e.target.closest('[data-sort]');
        if (!b) return;
        s.sort = b.dataset.sort; saveSettings(); ui.render(); list.scrollTop = 0;
    });
    root.querySelector('.cb_view').addEventListener('click', e => {
        const b = e.target.closest('[data-view]');
        if (!b || b.dataset.view === s.view) return;
        const toGallery = b.dataset.view === 'gallery' || s.view === 'gallery';
        if (ui.selecting) { ui.selecting = false; ui.selected.clear(); ui.selCards.clear(); root.querySelector('.cb_selectbtn').classList.remove('cb_on'); }
        s.view = b.dataset.view; saveSettings(); ui.card = null; ui.animate = true; ui.render();
        if (toGallery) list.scrollTop = 0;
    });
    root.querySelector('.cb_chips').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.personas) { openPersonaMenu(b); return; }
        if (b.dataset.tags) {
            if (e.target.closest('[data-cleartags]')) { s.galleryTags = []; saveSettings(); ui.card = null; ui.render(); list.scrollTop = 0; return; }
            pickTags();
            return;
        }
        if (b.dataset.fav) { s.galleryFav = !s.galleryFav; saveSettings(); ui.card = null; ui.animate = true; ui.render(); list.scrollTop = 0; return; }
        // in the gallery, the current character's chip goes straight to its card
        if (s.view === 'gallery' && b.dataset.entity) { openCard(b.dataset.entity); return; }
        if (b.dataset.filter) ui.filter = ui.filter === b.dataset.filter && b.dataset.filter !== 'all' ? 'all' : b.dataset.filter;
        else if (b.dataset.entity !== undefined) ui.entity = b.dataset.entity || null;
        else if (b.dataset.merge) { s.merge = !s.merge; saveSettings(); }
        if (!b.dataset.merge) { ui.card = null; ui.animate = true; }
        ui.render();
        if (!ui.card) list.scrollTop = 0;
    });

    root.querySelector('.cb_cardnav').addEventListener('click', e => {
        if (e.target.closest('[data-back]')) closeCard();
        else if (e.target.closest('[data-step]:not(:disabled)')) stepCard(Number(e.target.closest('[data-step]').dataset.step));
    });
    root.querySelector('.cb_sync').addEventListener('click', () => runSync());
    root.querySelector('.cb_clean').addEventListener('click', () => openCleanSync());
    root.querySelector('.cb_selectbtn').addEventListener('click', () => setSelecting(!ui.selecting));
    root.querySelector('.cb_scheme').addEventListener('click', () => {
        const order = SCHEMES.map(x => x[0]);
        s.scheme = order[(order.indexOf(s.scheme) + 1) % order.length];
        saveSettings();
        applyScheme(root);
    });
    root.querySelector('.cb_selbar').addEventListener('click', e => {
        const b = e.target.closest('[data-bulk]');
        if (b && !b.classList.contains('cb_disabled')) bulk(b.dataset.bulk);
    });

    // A long press ends with a click on the same spot: that one click must not undo what the press did.
    let skipClick = false;
    list.addEventListener('click', e => {
        if (!skipClick) return;
        skipClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    // pages: ‹ ›, tap the page number to pick a page, and how many per page
    const goPage = p => { ui.page = p; ui.animate = false; ui.render(); list.scrollTop = 0; };
    list.addEventListener('change', e => {
        const sel = e.target.closest?.('[data-pgsize]');
        if (!sel) return;
        setPageSize(sel.dataset.pgsize, Number(sel.value));
        list.scrollTop = 0;
    });

    list.addEventListener('click', async e => {
        const t = e.target;
        const pgBtn = t.closest('[data-pg]');
        if (pgBtn) { if (!pgBtn.disabled) goPage(ui.page + Number(pgBtn.dataset.pg)); return; }
        if (t.closest('[data-pgjump]')) {
            const pages = ui.pageInfo?.pages ?? 1;
            const v = await sheetPrompt({ title: 'ไปหน้าที่', value: String(ui.page), ok: 'ไป', hint: `พิมพ์เลขหน้า 1–${pages}` });
            const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10);
            if (n && ui.root === root) goPage(Math.min(pages, Math.max(1, n)));
            return;
        }
        if (t.closest('.rv_pager, .rv_pgselect')) return;
        if (t.closest('[data-clearfilters]')) { s.galleryTags = []; s.galleryFav = false; saveSettings(); ui.render(); return; }
        const tile = t.closest('.cb_tile');
        if (tile) {
            if (ui.selecting && ui.selectsCards()) toggleSelectCard(tile.dataset.card);
            else openCard(tile.dataset.card);
            return;
        }
        const gsize = t.closest('[data-gsize]');
        if (gsize) { setGallerySize(gsize.dataset.gsize); return; }
        const card = t.closest('[data-cardpage]');
        if (card) {
            const id = card.dataset.cardpage;
            if (t.closest('[data-zoom]')) zoomCover(id);
            else if (t.closest('[data-tag]')) searchFor(t.closest('[data-tag]').dataset.tag);
            else if (t.closest('[data-continue]')) doOpen(data.byKey.get(t.closest('[data-continue]').dataset.continue));
            else if (t.closest('[data-newchat]')) startNewChat(id);
            else if (t.closest('[data-edit]')) openEditor(id.slice(id.indexOf('|') + 1));
            // straight from the tap, nothing awaited first: iOS opens the file picker only inside a user gesture
            else if (t.closest('[data-cuupdate]')) updateFromFile(id.slice(id.indexOf('|') + 1));
            else if (t.closest('[data-note]')) {
                ui.noteOpen = !ui.noteOpen;
                const box = card.querySelector('.cb_cnote');
                box.classList.toggle('cb_open', ui.noteOpen);
                const more = box.querySelector('.cb_notemore');
                more.innerHTML = ui.noteOpen ? 'ย่อ<i class="fa-solid fa-chevron-up"></i>' : 'อ่านต่อ<i class="fa-solid fa-chevron-down"></i>';
                if (!ui.noteOpen && box.getBoundingClientRect().top < list.getBoundingClientRect().top) box.scrollIntoView({ block: 'start' });
            }
            return;
        }
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

    // Long press on a row or a gallery card starts selecting: a finger, a pen, or holding the left
    // mouse button (moving while holding cancels it, so dragging a scrollbar or text doesn't).
    let pressTimer = null, pressAt = null;
    list.addEventListener('pointerdown', e => {
        skipClick = false;
        if (ui.selecting || (e.pointerType === 'mouse' && e.button !== 0)) return;
        pressAt = { x: e.clientX, y: e.clientY };
        const row = e.target.closest('.cb_row');
        const tile = !row && ui.selectsCards() ? e.target.closest('.cb_tile') : null;
        if ((!row && !tile) || e.target.closest('button')) return;
        const key = row ? row.dataset.key : tile.dataset.card;
        pressTimer = setTimeout(() => {
            pressTimer = null;
            skipClick = true;
            setSelecting(true);
            if (row) toggleSelect(key); else toggleSelectCard(key);
            navigator.vibrate?.(15);
        }, 550);
    });
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    list.addEventListener('pointermove', e => {
        if (pressTimer && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) cancelPress();
    }, { passive: true });

    // Phones: the search, sort and filter rows fold away while scrolling down and come back on the way up.
    const small = matchMedia('(max-width: 600px)');
    let lastY = 0, foldLock = 0;
    list.addEventListener('scroll', () => {
        const y = list.scrollTop;
        if (performance.now() < foldLock) { lastY = y; return; }  // the list just changed height: not the user
        const d = y - lastY;
        if (y > 8 && Math.abs(d) < 12) return;   // small moves add up until they count
        lastY = y;
        const fold = small.matches && y > 8 && d > 0 && document.activeElement !== search
            && list.scrollHeight - list.clientHeight > 240; // not worth it for a short list
        if (fold === root.classList.contains('cb_headfold')) return;
        root.classList.toggle('cb_headfold', fold);
        foldLock = performance.now() + 320;
    }, { passive: true });
    search.addEventListener('focus', () => root.classList.remove('cb_headfold'));
    small.addEventListener?.('change', () => { if (!small.matches) root.classList.remove('cb_headfold'); });

    // Full covers fade in over their thumbnail once loaded; the blurred thumbnail under it then stops being drawn.
    list.addEventListener('load', e => {
        if (!e.target.matches?.('img.cb_full')) return;
        e.target.classList.add('cb_loaded');
        const under = e.target.previousElementSibling;
        if (under?.matches('img.cb_thumb')) under.classList.add('cb_under');
    }, true);
    list.addEventListener('error', e => { if (e.target.matches?.('img.cb_full') && e.target.hasAttribute('src')) e.target.classList.add('cb_failed'); }, true);

    // On a card page, swiping sideways goes to the next / previous card.
    let swipe = null;
    list.addEventListener('touchstart', e => {
        const p = e.touches[0];
        swipe = ui.card && e.touches.length === 1 && !e.target.closest('.cb_parts, .cb_tags, .cb_members') ? { x: p.clientX, y: p.clientY, at: Date.now() } : null;
    }, { passive: true });
    list.addEventListener('touchend', e => {
        if (!swipe || !ui.card) return;
        const p = e.changedTouches[0];
        const dx = p.clientX - swipe.x, dy = p.clientY - swipe.y;
        const quick = Date.now() - swipe.at < 700;
        swipe = null;
        if (quick && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) { cancelPress(); stepCard(dx < 0 ? 1 : -1); }
    }, { passive: true });
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
            if (ui.card) { closeCard(); return; }
            closeBrowser();
            return;
        }
        if (layer.firstChild) return;
        const inField = e.target.matches('input, select, textarea');
        if (e.key === '/' && !inField) { e.preventDefault(); search.focus(); search.select(); return; }
        if (ui.card && !inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepCard(e.key === 'ArrowRight' ? 1 : -1); return; }
        if (!ui.card && !inField && settings().view === 'gallery' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            const tiles = [...list.querySelectorAll('.cb_tile')];
            const i = tiles.indexOf(document.activeElement);
            const next = tiles[i < 0 ? 0 : Math.max(0, Math.min(tiles.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
            if (next) { e.preventDefault(); next.focus(); }
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const rows = [...list.querySelectorAll('.cb_row, .cb_tile')];
            if (!rows.length) return;
            e.preventDefault();
            const i = rows.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? rows[Math.min(rows.length - 1, i + 1)] : rows[Math.max(0, i - 1)];
            (i < 0 ? rows[0] : next).focus();
            return;
        }
        if (e.key === 'Enter') {
            if (e.target === search) {
                const tile = list.querySelector('.cb_tile');
                if (tile) { openCard(tile.dataset.card); return; }
                const first = list.querySelector('.cb_row');
                if (first) doOpen(chatFromRow(first));
                return;
            }
            if (e.target.matches?.('.cb_tile')) {
                e.preventDefault();
                if (ui.selecting && ui.selectsCards()) toggleSelectCard(e.target.dataset.card); else openCard(e.target.dataset.card);
                return;
            }
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
    if (!on) { ui.selected.clear(); ui.selCards.clear(); }
    ui.root?.querySelector('.cb_selectbtn')?.classList.toggle('cb_on', on);
    ui.render();
}

function toggleSelect(key) {
    if (ui.selected.has(key)) ui.selected.delete(key); else ui.selected.add(key);
    ui.root?.querySelector(`.cb_row[data-key="${CSS.escape(key)}"]`)?.classList.toggle('cb_selected', ui.selected.has(key));
    ui.renderSelbar();
}

/** Gallery: pick a card for Bulk Manager (characters only — groups are not in Bulk Manager's characters tab). */
function toggleSelectCard(id) {
    if (ui.selCards.has(id)) ui.selCards.delete(id); else ui.selCards.add(id);
    ui.root?.querySelector(`.cb_tile[data-card="${CSS.escape(id)}"]`)?.classList.toggle('cb_selected', ui.selCards.has(id));
    ui.renderSelbar();
}

async function bulk(action) {
    if (action === 'cread') {
        // every chat of the picked cards (characters and groups)
        const list = data.chats.filter(c => ui.selCards.has(`${c.type}|${c.entity}`));
        for (const c of list) markSeen(c.key, c.count);
        const cards = ui.selCards.size;
        setSelecting(false);
        updateLauncherBadge();
        toast.ok(`อ่านแล้ว ${list.length.toLocaleString('th-TH')} แชท จาก ${cards.toLocaleString('th-TH')} การ์ด`);
        return;
    }
    if (action.startsWith('c')) {
        const avatars = [...ui.selCards].filter(id => id.startsWith('character|')).map(id => id.slice('character|'.length));
        if (!avatars.length) { toast.info('Bulk Manager รับเฉพาะตัวละคร (ยังไม่รองรับกลุ่ม)'); return; }
        await handOffToBulk(avatars, { cdelete: 'delete', cbackup: 'backup', ccopy: 'copy' }[action]);
        return;
    }
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
    const s = settings();
    const pinned = !!s.pins[c.key];
    const info = linkInfo.get(c.key);
    const isOpen = c.key === currentKey();
    const items = [
        ['open', isOpen ? 'fa-solid fa-eye' : 'fa-solid fa-arrow-right-to-bracket', isOpen ? 'กลับไปที่แชทนี้' : 'เปิดแชทนี้'],
        ...(info?.size > 1 ? info.parts.filter(p => p.key !== c.key).reverse().map(p => [`part:${p.key}`, 'fa-solid fa-book-bookmark', `เปิดตอน ${linkInfo.get(p.key)?.part ?? '?'} · ${p.chatId}`]) : []),
        ['pin', 'fa-solid fa-thumbtack', pinned ? 'เลิกปักหมุด' : 'ปักหมุด'],
        ['rename', 'fa-solid fa-pen', 'เปลี่ยนชื่อ'],
        ['export', 'fa-solid fa-file-export', 'ส่งออกไฟล์แชท…'],
        ['read', 'fa-solid fa-check-double', 'ทำเครื่องหมายว่าอ่านแล้ว', unreadOf(c) > 0],
        ['link', 'fa-solid fa-link', c.prev ? 'เปลี่ยนตอนก่อนหน้า…' : 'ตั้งเป็นตอนต่อของ…'],
        ['unlink', 'fa-solid fa-link-slash', 'ยกเลิกการผูกตอนต่อ', !!c.prev],
        ['only', settings().view === 'gallery' ? 'fa-solid fa-id-card' : 'fa-solid fa-filter', settings().view === 'gallery' ? `ดูการ์ด ${c.entityName}` : `ดูเฉพาะแชทของ ${c.entityName}`, !(settings().view === 'gallery' && ui.card === `${c.type}|${c.entity}`)],
        ['delete', 'fa-solid fa-trash', 'ลบแชท', true, true],
    ].filter(x => x[3] !== false);
    const head = `<div class="cb_menuhead"><b>${esc(c.chatId)}</b><span>${esc(c.entityName)} · ${c.count} ข้อความ${info?.size > 1 ? ` · ตอน ${info.part} จาก ${info.size} แชท` : ''}</span></div>`;
    popMenu(head + items.map(([id, icon, label, , danger]) => `<button role="menuitem" data-act="${esc(id)}"${danger ? ' class="cb_danger"' : ''}><i class="${icon}"></i>${esc(label)}</button>`).join(''), anchor, async act => {
        try { await menuAction(act, c); } catch (err) { console.error(LOG, err); toast.err(errText(err)); }
    });
}

/** Which persona's chats to show: the browser's own menu, not the system's select list. */
function openPersonaMenu(anchor) {
    const counts = new Map();
    const names = new Map();
    for (const c of data.chats) {
        if (!c.persona) continue;
        counts.set(c.persona, (counts.get(c.persona) || 0) + 1);
        names.set(c.persona, c.personaName || c.persona);
    }
    const list = [...names.entries()].sort((a, b) => compareText(a[1], b[1]));
    const row = (id, ava, label, n) => `<button role="menuitemradio" aria-checked="${(ui.persona || '') === id}" data-act="${esc(id)}"${(ui.persona || '') === id ? ' class="cb_on"' : ''}>
        ${ava}<span class="cb_mname">${esc(label)}</span>${n ? `<small>${n}</small>` : ''}<i class="fa-solid fa-check cb_mtick"></i></button>`;
    popMenu(`<div class="cb_menuhead"><b>Persona</b><span>แสดงเฉพาะแชทที่ผูกกับ persona ที่เลือก</span></div>`
        + row('', '<i class="fa-solid fa-masks-theater"></i>', 'ทุก persona', 0)
        + list.map(([id, name]) => row(id, `<img class="cb_mava" src="${esc(thumb('persona', id))}" alt="" loading="lazy">`, name, counts.get(id))).join(''),
    anchor, id => {
        ui.persona = id || null;
        ui.card = null;
        ui.animate = true;
        ui.render();
        ui.root.querySelector('.cb_list').scrollTop = 0;
    }, { cls: 'cb_scrollmenu' });
}

/** A menu beside its button on wide screens, a bottom sheet on phones; onPick gets the item's data-act. */
function popMenu(html, anchor, onPick, { cls = '' } = {}) {
    const layer = ui.root.querySelector('.cb_layer');
    layer.querySelector('.cb_menu')?._close?.();
    const menu = document.createElement('div');
    menu.className = `cb_menu${cls ? ` ${cls}` : ''}`;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = html;
    layer.append(menu);
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!menu.contains(e.target)) close(); };
    menu._close = close;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);

    const panel = ui.root.querySelector('.cb_panel').getBoundingClientRect();
    if (panel.width > 560 && anchor) {
        const r = anchor.getBoundingClientRect();
        menu.classList.add('cb_pop');
        const h = menu.offsetHeight, w = menu.offsetWidth;
        const top = Math.min(panel.bottom - h - 8, Math.max(panel.top + 8, r.bottom + 4));
        menu.style.top = `${top - panel.top}px`;
        // under the button, its right edge lined up with the button's, kept inside the window
        menu.style.left = `${clamp(r.right - panel.left - w, 8, panel.width - w - 8)}px`;
    } else {
        menu.classList.add('cb_sheetmenu');
    }
    const first = menu.querySelector('button.cb_on') || menu.querySelector('button');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView?.({ block: 'nearest' });

    menu.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        close();
        onPick(b.dataset.act);
    });
    return menu;
}

async function menuAction(act, c) {
    if (act === 'open') return doOpen(c);
    if (act.startsWith('part:')) return doOpen(data.byKey.get(act.slice(5)));
    if (act === 'pin') { togglePin([c.key], !settings().pins[c.key]); ui.render(); return; }
    if (act === 'read') { markSeen(c.key, c.count); ui.render(); updateLauncherBadge(); return; }
    if (act === 'only') {
        if (settings().view === 'gallery') { openCard(`${c.type}|${c.entity}`); return; }
        ui.entity = `${c.type}|${c.entity}`; ui.render(); return;
    }
    if (act === 'export') return openExport(c);
    if (act === 'rename') {
        const name = await sheetPrompt({ title: 'เปลี่ยนชื่อแชท', value: c.chatId, ok: 'เปลี่ยนชื่อ', hint: `${esc(c.entityName)} · แชทที่อ้างถึงชื่อนี้ (ตอนต่อ กิ่ง) จะถูกแก้ตาม${cab()?.dropboxConnected?.() ? ' · ไฟล์ใน Dropbox ย้ายไปชื่อใหม่ และเครื่องอื่นเปลี่ยนตามตอนซิงค์' : ''}` });
        if (name == null) return;
        const done = await renameChat(c, name);
        if (done) { toast.ok(`เปลี่ยนชื่อเป็น "${done}" แล้ว`); ui.render(); reload({ full: true }); }
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
        toast.ok(`ตั้ง "${c.chatId}" เป็นตอนต่อของ "${parent.chatId}" แล้ว`);
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
        hint: 'แชทที่เลือกจะเป็นตอนก่อนหน้า — ใช้กับแชทที่ต่อเรื่องเองด้วยมือ (แชทที่สร้างด้วย “เริ่มแชทใหม่ต่อเรื่อง” ของ Memory Hub ผูกให้อัตโนมัติอยู่แล้ว)',
        items: options.map(x => ({ value: x, html: `<b>${esc(x.chatId)}</b><span>${x.count} ข้อความ · ${esc(relTime(x.last))}${linkInfo.get(x.key)?.size > 1 ? ` · ตอน ${linkInfo.get(x.key).part}` : ''}</span>`, selected: x.chatId === c.prev })),
    });
}

async function loadHistory(c) {
    ui.history.set(c.key, 'loading');
    ui.render();
    try {
        const arr = await readChat(c);
        const all = arr.filter(m => m && 'mes' in m);
        const depthOf = m => all.length - 1 - all.indexOf(m);
        const msgs = all.filter(m => !m.is_system).slice(-6);
        await loadRegex();
        const rx = displayRegexer();
        const avatar = c.type === 'character' ? c.entity : null;
        ui.history.set(c.key, msgs.map(m => ({
            name: m.name ?? '',
            user: !!m.is_user,
            text: clip(storyOf(String(m.mes ?? ''), rx, { avatar: m.is_user ? null : avatar, user: !!m.is_user, name: c.entityName, depth: depthOf(m) }), 700) || '…',
        })));
    } catch (e) {
        ui.history.set(c.key, `โหลดไม่สำเร็จ: ${errText(e)}`);
    }
    ui.render();
}

// ---------------------------------------------------------------- export

/** Hand a file to the user: the system share sheet where it can take files (phones), else a download. */
async function saveFile(name, text, { share = false } = {}) {
    const type = name.endsWith('.txt') ? 'text/plain;charset=utf-8' : 'application/octet-stream';
    if (share) {
        const file = new File([text], name, { type: 'text/plain' });
        if (navigator.canShare?.({ files: [file] })) {
            try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e?.name === 'AbortError') return false; }
        }
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
}

/** Messages of a chat as readable text: who, when, and what was said. */
function chatToText(c, arr, rx, clean) {
    const msgs = arr.filter(m => m && typeof m === 'object' && 'mes' in m);
    const avatar = c.type === 'character' ? c.entity : null;
    const out = [];
    msgs.forEach((m, i) => {
        const raw = String(m.mes ?? '');
        const text = clean
            ? storyOf(raw, rx, { avatar: m.is_user ? null : avatar, user: !!m.is_user, name: c.entityName, depth: msgs.length - 1 - i })
            : raw.trim();
        if (!text) return;
        const when = fullTime(toMs(m.send_date, ctx().timestampToMoment));
        out.push(`【${m.name || (m.is_user ? 'User' : c.entityName)}】${when ? `  ${when}` : ''}\n${text}`);
    });
    return out.join('\n\n');
}

function exportHead(title, lines) {
    return `${title}\n${lines.filter(Boolean).join(' · ')}\n${'═'.repeat(40)}\n\n`;
}

async function openExport(c) {
    const info = linkInfo.get(c.key);
    const parts = info?.size > 1 ? info.parts : [c];
    const hasStory = parts.length > 1;
    let format = 'jsonl', clean = true;
    // Read the chats as the sheet opens, so the share button runs straight from the tap
    // (Safari shares only from a tap, not after waiting on the network).
    const files = new Map(); // key → chat file as an array
    const loading = (async () => {
        if ([c, ...parts].some(p => p.key === currentKey())) { try { await ctx().saveChat?.(); } catch { /* saved on its own anyway */ } }
        await loadRegex();
        for (const p of hasStory ? parts : [c]) files.set(p.key, await readChat(p));
    })();
    let ready = false;
    loading.then(() => { ready = true; }, () => {});
    const option = (id, icon, title, sub) => `<button class="cb_pick cb_expopt${format === id ? ' cb_on' : ''}" data-fmt="${id}">
        <i class="${icon}"></i><span><b>${title}</b><small>${sub}</small></span><i class="fa-solid fa-circle-check cb_tick"></i></button>`;
    const canShare = !!navigator.canShare && matchMedia('(pointer: coarse)').matches;
    const build = () => {
        const rx = displayRegexer();
        const now = fullTime(Date.now());
        if (format === 'jsonl') {
            const arr = files.get(c.key) || [];
            return { name: fileName(c.chatId, 'jsonl'), text: `${arr.map(x => JSON.stringify(x)).join('\n')}\n` };
        }
        const list = format === 'story' ? parts : [c];
        const total = list.reduce((n, p) => n + (p.count || 0), 0);
        let text = exportHead(format === 'story' ? `${c.entityName} — ทั้งเรื่อง (${list.length} ตอน)` : c.chatId,
            [c.entityName, `${total} ข้อความ`, c.personaName ? `persona: ${c.personaName}` : '', `ส่งออกเมื่อ ${now}`]);
        text += list.map(p => {
            const body = chatToText(p, files.get(p.key) || [], rx, clean);
            return format === 'story' ? `──── ตอน ${linkInfo.get(p.key)?.part ?? '?'} · ${p.chatId} ────\n\n${body}` : body;
        }).join('\n\n\n');
        return { name: fileName(format === 'story' ? `${c.entityName} - ทั้งเรื่อง ${list.length} ตอน` : c.chatId, 'txt'), text: `${text}\n` };
    };
    const run = async (a, btn, share) => {
        try {
            if (!ready) btn.disabled = true;
            await loading;
            const f = build();
            if (await saveFile(f.name, f.text, { share })) { toast.ok(`ส่งออก "${f.name}" แล้ว`); a.close(true); }
        } catch (e) {
            console.error(LOG, e);
            toast.err(`ส่งออกไม่สำเร็จ: ${errText(e)}`);
            btn.disabled = false;
        }
    };
    await sheet({
        title: 'ส่งออกแชท',
        body: `<div class="cb_delone">${ui.avatarHtml(c)}<div><b>${esc(c.chatId)}</b><span>${esc(c.entityName)} · ${c.count} ข้อความ${hasStory ? ` · ตอน ${info.part} จาก ${parts.length}` : ''}</span></div></div>
            <div class="cb_picklist cb_expopts">
                ${option('jsonl', 'fa-solid fa-file-code', 'ไฟล์แชท .jsonl', 'ไฟล์ต้นฉบับของ SillyTavern ครบทุกอย่าง นำเข้ากลับได้ที่ Manage chat files → Import')}
                ${option('txt', 'fa-solid fa-file-lines', 'ข้อความอ่านง่าย .txt', 'ชื่อ เวลา และข้อความ ทีละข้อความ เปิดอ่านในแอปไหนก็ได้')}
                ${hasStory ? option('story', 'fa-solid fa-book', `ทั้งเรื่อง ${parts.length} ตอน .txt`, 'รวมทุกตอนของเรื่องนี้เป็นไฟล์เดียว เรียงจากตอนแรก') : ''}
            </div>
            <label class="cb_expclean" hidden><input type="checkbox" checked><span>เหลือแค่บทบรรยายและบทพูด<small>ตัด &lt;think&gt; แผงสเตตัส HTML และข้อมูลระบบออก</small></span></label>
            <p class="cb_note cb_expstate"><i class="fa-solid fa-circle-notch fa-spin"></i>กำลังอ่านแชท…</p>`,
        buttons: [
            { label: 'ยกเลิก', run: a => a.close(null) },
            ...(canShare ? [{ label: '<i class="fa-solid fa-arrow-up-from-bracket"></i>แชร์ / บันทึกลงไฟล์', run: (a, b) => run(a, b, true) }] : []),
            { label: '<i class="fa-solid fa-download"></i>ดาวน์โหลด', primary: true, run: (a, b) => run(a, b, false) },
        ],
        onMount: a => {
            const cleanBox = a.body.querySelector('.cb_expclean');
            a.body.addEventListener('click', e => {
                const b = e.target.closest('[data-fmt]');
                if (!b) return;
                format = b.dataset.fmt;
                a.body.querySelectorAll('[data-fmt]').forEach(x => x.classList.toggle('cb_on', x === b));
                cleanBox.hidden = format === 'jsonl';
            });
            cleanBox.querySelector('input').addEventListener('change', e => { clean = e.target.checked; });
            const state = a.body.querySelector('.cb_expstate');
            loading.then(
                () => { state.remove(); },
                e => { state.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>อ่านแชทไม่สำเร็จ: ${esc(errText(e))}`; state.classList.add('cb_warn'); },
            );
        },
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
            ${list.map(x => `<label class="cb_citem"><input type="checkbox" data-key="${esc(x.key)}" data-g="${esc(label)}" checked><span class="cb_cname">${esc(x.chatId)}</span><span class="cb_cinfo">${[x.count ? `${x.count} ข้อความ` : '', x.when ? esc(relTime(x.when)) : '', x.size ? fmtBytes(x.size) : ''].filter(Boolean).join(' · ')}</span></label>`).join('')}
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
    reload({ full: true }); // chats were deleted: a quick refresh would not see them go
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
            reload({ full: true }); // a restored file keeps its old date: only a full read finds it
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
// colours that adapt to the theme (always readable) or are picked, a size, and an idle animation.

let palette = null; // theme-palette.js handle

const LOOK_DEFAULT = Object.freeze({
    shape: 'circle',    // circle squircle bubble pill heart flower star cloud sticker
    icon: 'fa-comments',
    emoji: '',          // overrides the icon
    image: '',          // data: URL or link; overrides icon and emoji
    fit: 'cover',       // cover | contain
    size: 46,
    iconSize: 42,       // % of the button
    bg: 'auto',         // auto (adapts to the theme palette) | custom | none
    bgColor: '#2a2633',
    fg: 'auto',         // auto | custom
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
    const L = s.launcherLook = { ...LOOK_DEFAULT, ...(s.launcherLook && typeof s.launcherLook === 'object' ? s.launcherLook : {}) };
    // 1.5: "theme colours" became the adaptive mode
    if (!['auto', 'custom', 'none'].includes(L.bg)) L.bg = 'auto';
    if (!['auto', 'custom'].includes(L.fg)) L.fg = 'auto';
    return L;
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
    el.dataset.bg = L.bg;
    // adaptive colours: from the theme palette, readable on the button's real background (float-colors.js)
    const c = floatColors(palette?.current, { bg: L.bg === 'custom' ? L.bgColor : null, fg: L.fg === 'custom' ? L.fgColor : null });
    const prop = (k, v) => (v ? el.style.setProperty(k, v) : el.style.removeProperty(k));
    prop('--cb-lbg', L.bg === 'custom' ? L.bgColor : L.bg === 'none' ? 'transparent' : c && `color-mix(in srgb, ${c.bg} 80%, transparent)`);
    prop('--cb-lfg', L.fg === 'custom' ? L.fgColor : c?.accentText);
    prop('--cb-lline', c?.border);
    prop('--cb-lring', c?.ring);
    prop('--cb-lbadge', c?.accent);
    prop('--cb-lbadge-fg', c?.onAccent);
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


/** The part of the page that is actually on screen: it shrinks (and may scroll) when the keyboard opens. */
function visibleArea() {
    const vv = window.visualViewport;
    return vv
        ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height }
        : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

function placeLauncher(el = document.getElementById('cb_launcher')) {
    if (!el || el.hidden || el.classList.contains('cb_dragging')) return;
    const { x: ox, y: oy, w: vw, h: vh } = visibleArea();
    const p = settings().launcherPos || DEFAULTS.launcherPos;
    const m = 8, w = el.offsetWidth, h = el.offsetHeight;
    let left = m + clamp(Number(p.x) || 0, 0, 1) * Math.max(0, vw - w - 2 * m);
    let top = m + clamp(Number(p.y) || 0, 0, 1) * Math.max(0, vh - h - 2 * m);
    if (p.edge === 'left') left = m;
    if (p.edge === 'right') left = vw - w - m;
    if (p.edge === 'top') top = m;
    if (p.edge === 'bottom') top = vh - h - m;
    el.style.left = `${Math.round(ox + left)}px`;
    el.style.top = `${Math.round(oy + top)}px`;
    el.dataset.edge = p.edge ?? '';
}

/** Place again now and once the keyboard has finished sliding (iOS reports the size late). */
let placeTimer = null;
function placeLauncherSoon() {
    requestAnimationFrame(() => placeLauncher());
    clearTimeout(placeTimer);
    placeTimer = setTimeout(() => placeLauncher(), 350);
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
    el.title = 'Reverie — แชทและการ์ดทั้งหมด';
    applyLook(el);
    document.body.append(el);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBrowser(); } });

    let start = null, moved = false, skipClick = false;
    // Open on click, not pointerup: opened on pointerup, the browser appears under the finger and the
    // click that follows the same tap lands on whatever is there (a chat tile, or the backdrop, which closes it).
    el.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        if (skipClick) { skipClick = false; return; } // the click that ends a drag
        openBrowser();
    });
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, id: e.pointerId };
        moved = false;
        skipClick = false;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', e => {
        if (!start || e.pointerId !== start.id) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 6) return;
        moved = true;
        el.classList.add('cb_dragging');
        const a = visibleArea();
        el.style.left = `${clamp(start.left + dx, a.x, a.x + a.w - el.offsetWidth)}px`;
        el.style.top = `${clamp(start.top + dy, a.y, a.y + a.h - el.offsetHeight)}px`;
    });
    const end = e => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        if (!moved) return; // a plain tap: the click handler opens the browser
        skipClick = true;
        el.classList.remove('cb_dragging');
        const { x: ox, y: oy, w: vw, h: vh } = visibleArea();
        const b = el.getBoundingClientRect();
        const r = { left: b.left - ox, top: b.top - oy, right: b.right - ox, bottom: b.bottom - oy, width: b.width, height: b.height };
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
    if (!renderLauncher.wired) {
        renderLauncher.wired = true;
        window.addEventListener('resize', placeLauncherSoon);
        window.visualViewport?.addEventListener('resize', placeLauncherSoon);
        window.visualViewport?.addEventListener('scroll', () => placeLauncher());
        document.addEventListener('focusin', placeLauncherSoon);
        document.addEventListener('focusout', placeLauncherSoon);
    }
    placeLauncher(el);
    updateLauncherBadge();
}

// ---------------------------------------------------------------- top bar icon look

const TOP_DEFAULT = Object.freeze({
    icon: 'fa-comments',
    emoji: '',
    image: '',      // data: URL or link
    size: 0,        // px; 0 = the theme's own top bar size
    color: 'theme', // theme | custom
    colorHex: '#8c8cff',
    opacity: 100,
    badge: true,
});

function topLook() {
    const s = settings();
    s.topbarLook = { ...TOP_DEFAULT, ...(s.topbarLook && typeof s.topbarLook === 'object' ? s.topbarLook : {}) };
    return s.topbarLook;
}

function applyTopLook(el = document.getElementById('cb_topbar')) {
    const icon = el?.querySelector('.cb_ticon');
    if (!icon) return;
    const T = topLook();
    const emoji = String(T.emoji ?? '').trim().slice(0, 8);
    icon.className = `drawer-icon closedIcon interactable cb_ticon ${T.image || emoji ? 'cb_ticon_face' : `fa-solid fa-fw ${/^fa-[\w-]+$/.test(T.icon) ? T.icon : 'fa-comments'}`}`;
    icon.innerHTML = T.image ? `<img src="${esc(T.image)}" alt="" draggable="false">` : emoji ? `<span>${esc(emoji)}</span>` : '';
    const size = Number(T.size) || 0;
    if (size) icon.style.setProperty('--cb-tsize', `${clamp(size, 12, 64)}px`); else icon.style.removeProperty('--cb-tsize');
    icon.dataset.sized = size ? '1' : '';
    if (T.color === 'custom') icon.style.color = T.colorHex; else icon.style.removeProperty('color');
    icon.style.opacity = String(clamp(Number(T.opacity) || 100, 20, 100) / 100);
    el.classList.toggle('cb_nobadge', !T.badge);
    updateLauncherBadge();
}

function renderTopbar() {
    let el = document.getElementById('cb_topbar');
    if (!settings().topbar) { el?.remove(); return; }
    if (el) return applyTopLook(el);
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    el = document.createElement('div');
    el.id = 'cb_topbar';
    el.className = 'drawer';
    el.innerHTML = '<div class="drawer-toggle-cb"><div class="cb_ticon" title="Reverie — แชทและการ์ดทั้งหมด" tabindex="0"></div><span class="cb_launch_badge" hidden></span></div>';
    const before = document.getElementById('rightNavHolder');
    if (before?.parentElement === holder) holder.insertBefore(el, before); else holder.append(el);
    el.addEventListener('click', e => { e.stopPropagation(); openBrowser(); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openBrowser(); });
    applyTopLook(el);
}

// ---------------------------------------------------------------- ST's own Card button: tap / hold

const CARD_HOLD_MS = 450;
let cardHold = null;    // { id, x, y, el, timer } while a finger rests on the Card button
let cardEatClick = false; // swallow the one click that ends a hold; reset on the next pointerdown

const cardToggleOf = t => (t instanceof Element ? t.closest('#rightNavHolder > .drawer-toggle') : null);
const cardMode = () => { const m = settings().cardButton; return m === 'hold' || m === 'tap' ? m : 'off'; };
const cardPanelOpen = () => !!document.querySelector('#rightNavHolder > .drawer-content.openDrawer');

function cardRun(action, el) {
    diag(`card button → ${action}`);
    if (action === 'reverie') openBrowser();
    else el.click(); // untrusted, so it passes straight to ST's own handler
}

function onCardDown(e) {
    cardEatClick = false;
    clearTimeout(cardHold?.timer);
    cardHold = null;
    if (!e.isTrusted || e.button !== 0 || cardMode() === 'off') return;
    if (document.documentElement.classList.contains('qd_picking')) return; // Quick Dock is choosing a button
    const el = cardToggleOf(e.target);
    if (!el) return;
    const hold = { id: e.pointerId, x: e.clientX, y: e.clientY, el };
    hold.timer = setTimeout(() => {
        if (cardHold !== hold) return;
        cardHold = null;
        cardEatClick = true;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        cardRun(cardButtonAction(cardMode(), 'hold', cardPanelOpen()), el);
    }, CARD_HOLD_MS);
    cardHold = hold;
}

function onCardMove(e) {
    if (cardHold && e.pointerId === cardHold.id && Math.hypot(e.clientX - cardHold.x, e.clientY - cardHold.y) > 10) {
        clearTimeout(cardHold.timer);
        cardHold = null;
    }
}

function onCardUp(e) {
    if (cardHold && e.pointerId === cardHold.id) { clearTimeout(cardHold.timer); cardHold = null; }
}

function onCardClick(e) {
    if (!e.isTrusted) return; // other extensions (Quick Dock shortcuts) still get ST's Card panel
    if (cardEatClick) { cardEatClick = false; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (cardMode() === 'off') return;
    const el = cardToggleOf(e.target);
    if (!el || cardButtonAction(cardMode(), 'tap', cardPanelOpen()) !== 'reverie') return;
    e.preventDefault();
    e.stopImmediatePropagation(); // capture on document runs before ST's handler on the button
    cardRun('reverie', el);
}

function onCardMenu(e) {
    if (cardMode() !== 'off' && cardToggleOf(e.target)) e.preventDefault(); // Android long-press menu
}

function wireCardButton() {
    document.body.classList.toggle('cb_cardhold', cardMode() !== 'off');
    if (wireCardButton.done) return;
    wireCardButton.done = true;
    document.addEventListener('pointerdown', onCardDown, true);
    document.addEventListener('pointermove', onCardMove, true);
    document.addEventListener('pointerup', onCardUp, true);
    document.addEventListener('pointercancel', onCardUp, true);
    document.addEventListener('click', onCardClick, true);
    document.addEventListener('contextmenu', onCardMenu, true);
}

function addWandItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cb_wand')) return;
    const item = document.createElement('div');
    item.id = 'cb_wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-comments extensionsMenuExtensionButton"></div><span>Reverie</span>';
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
                <b>Reverie <small class="cb_version">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cb_setbtns"><div id="cb_set_open" class="menu_button"><i class="fa-solid fa-comments"></i> เปิด Reverie</div></div>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_launcher"> ปุ่มลอยบนจอ (ลากไปวางตรงไหนก็ได้ หรือเก็บเข้า Quick Dock)</label>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_topbar"> ไอคอนบนแถบด้านบน</label>
                <div class="cb_setrow">
                    <span>ปุ่ม Card ของ ST</span>
                    <select id="cb_set_cardbtn" class="text_pole">
                        <option value="off">ปกติ</option>
                        <option value="hold">ค้าง = Reverie</option>
                        <option value="tap">แตะ = Reverie</option>
                    </select>
                </div>
                <div class="cb_setrow">
                    <span>เอฟเฟกต์ปกการ์ด</span>
                    <select id="cb_set_hover" class="text_pole">${HOVERS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
                </div>
                <small class="cb_sethint">ตอนชี้เมาส์ที่ปกการ์ด ไม่มีแบบไหนขยายรูป · จอสัมผัสไม่มีเมาส์ ใช้สามข้อด้านล่างแทน · ปิดเองถ้าเปิด "ลดการเคลื่อนไหว" ในระบบ</small>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_fxtilt"> การ์ดเอียงตามแสง (ใช้ได้กับทุกแบบ)</label>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_fxopen"> เล่นเอฟเฟกต์ที่รูปใหญ่ตอนเปิดหน้าการ์ด</label>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_fxscroll"> เล่นเอฟเฟกต์ตอนการ์ดเลื่อนเข้ามาในจอ (แกลเลอรี ใบละครั้ง)</label>
                <label class="checkbox_label"><input type="checkbox" id="cb_set_fxgyro"> เอียงมือถือ/ไอแพดแล้วแสงบนรูปใหญ่ขยับตาม</label>
                <small class="cb_sethint">เอียงเครื่อง: ใช้ได้ทุกแบบในหน้าการ์ด เหมือนถือการ์ดสะสมเอียงรับแสง · iPhone/iPad จะถามขออนุญาตใช้เซนเซอร์ตอนติ๊ก</small>
                <div class="cb_setrow">
                    <span>การ์ดต่อหน้า</span>
                    <select id="cb_set_pagecards" class="text_pole">${PAGE_SIZES.cards.map(n => `<option value="${n}">${n || 'ทั้งหมด'}</option>`).join('')}</select>
                </div>
                <div class="cb_setrow">
                    <span>แชทต่อหน้า</span>
                    <select id="cb_set_pagechats" class="text_pole">${PAGE_SIZES.chats.map(n => `<option value="${n}">${n || 'ทั้งหมด'}</option>`).join('')}</select>
                </div>
                <small class="cb_sethint">มีการ์ดหรือแชทเยอะมาก แบ่งเป็นหน้า ๆ จะไม่ต้องเลื่อนยาวและเปิดเร็วขึ้น · ปรับได้ที่แถบบนสุดของรายการใน Reverie ด้วย</small>
                <small class="cb_sethint">ปุ่มการ์ดตัวละคร (<i class="fa-solid fa-address-card"></i>) บนแถบด้านบน · <b>ค้าง = Reverie</b> แตะเปิด Card ของ ST ตามเดิม กดค้างเปิด Reverie · <b>แตะ = Reverie</b> กลับกัน แตะเปิด Reverie กดค้างเปิด Card · ตอนแผง Card เปิดอยู่ แตะเพื่อปิดได้ตามปกติ</small>
                <details class="cb_look">
                    <summary>หน้าตาปุ่มลอย</summary>
                    <div id="cb_look_body"></div>
                </details>
                <details class="cb_look">
                    <summary>หน้าตาไอคอนแถบด้านบน</summary>
                    <div id="cb_top_body"></div>
                </details>
                <div class="cb_setbtns">
                    <div id="cb_set_resetpos" class="menu_button"><i class="fa-solid fa-crosshairs"></i> รีเซ็ตตำแหน่งปุ่มลอย</div>
                    <div id="cb_set_readall" class="menu_button"><i class="fa-solid fa-check-double"></i> ทุกแชทอ่านแล้ว</div>
                    <div id="cb_set_rescan" class="menu_button" title="ปกติ Reverie ถามเซิร์ฟเวอร์เฉพาะแชทที่เปลี่ยน และอ่านทุกแชทวันละครั้ง กดนี้ถ้ารายการดูไม่ตรง"><i class="fa-solid fa-arrows-rotate"></i> โหลดรายการแชทใหม่ทั้งหมด</div>
                    <div id="cb_set_diag" class="menu_button" title="ทดลองเปิด Reverie แล้ววัดว่าเกิดอะไรขึ้น ได้รายงานไว้คัดลอกส่งให้คนแก้"><i class="fa-solid fa-stethoscope"></i> ตรวจปัญหา</div>
                </div>
                <div id="cb_diagbox" class="cb_diagbox" hidden>
                    <textarea class="text_pole" readonly rows="10"></textarea>
                    <div id="cb_diagcopy" class="menu_button"><i class="fa-solid fa-copy"></i> คัดลอกรายงาน</div>
                </div>
                <small class="cb_setnote">เปิดได้จากปุ่มลอย ไอคอนบนแถบด้านบน เมนูไม้กายสิทธิ์ (Extensions) หรือคำสั่ง <code>/chats</code> (<code>/reverie</code>) · จำนวนข้อความใหม่นับแยกในแต่ละเครื่อง · ปุ่ม Sync และ Clean Sync ใช้ Chat Auto Backup ที่เชื่อมต่อ Dropbox ไว้</small>
            </div>
        </div>
    </div>`);
    const $ = id => document.getElementById(id);
    $('cb_set_diag').addEventListener('click', async () => {
        let text;
        try { text = await runDiagnostics(); } catch (err) { text = `ตรวจไม่สำเร็จ: ${err?.stack || err}\n${diagLog.join('\n')}`; }
        $('cb_diagbox').hidden = false;
        $('cb_diagbox').querySelector('textarea').value = text;
    });
    $('cb_diagcopy').addEventListener('click', async () => {
        const ta = $('cb_diagbox').querySelector('textarea');
        try { await navigator.clipboard.writeText(ta.value); globalThis.toastr?.success('คัดลอกรายงานแล้ว', '', { timeOut: 1500 }); }
        catch { ta.focus(); ta.select(); globalThis.toastr?.info('เลือกข้อความไว้แล้ว กดคัดลอกเองได้เลย'); }
    });
    $('cb_set_launcher').checked = !!s.launcher;
    $('cb_set_topbar').checked = !!s.topbar;
    $('cb_set_launcher').addEventListener('change', e => { s.launcher = e.target.checked; saveSettings(); renderLauncher(); });
    $('cb_set_topbar').addEventListener('change', e => { s.topbar = e.target.checked; saveSettings(); renderTopbar(); });
    $('cb_set_cardbtn').value = cardMode();
    $('cb_set_hover').value = hoverMode();
    $('cb_set_hover').addEventListener('change', e => { s.hover = e.target.value; saveSettings(); applyHover(); });
    $('cb_set_fxtilt').checked = !!s.hoverTilt;
    $('cb_set_fxtilt').addEventListener('change', e => { s.hoverTilt = e.target.checked; saveSettings(); applyHover(); });
    $('cb_set_fxopen').checked = !!s.hoverOpen;
    $('cb_set_fxscroll').checked = !!s.hoverScroll;
    $('cb_set_fxgyro').checked = !!s.hoverGyro;
    $('cb_set_fxopen').addEventListener('change', e => { s.hoverOpen = e.target.checked; saveSettings(); });
    $('cb_set_fxscroll').addEventListener('change', e => { s.hoverScroll = e.target.checked; saveSettings(); if (ui.root) ui.render(); });
    $('cb_set_fxgyro').addEventListener('change', async e => {
        const box = e.target;
        if (box.checked) {
            // asked straight from this tap: iPhone and iPad only ask inside one
            const r = gyroSupported() ? await askGyro() : 'unsupported';
            if (r !== 'granted') {
                box.checked = false;
                toast.warn(r === 'unsupported' ? 'เครื่องนี้ไม่มีเซนเซอร์บอกการเอียง' : 'ไม่ได้รับอนุญาตให้ใช้เซนเซอร์การเคลื่อนไหว (เปลี่ยนได้ในการตั้งค่าของเบราว์เซอร์)');
                return;
            }
        }
        s.hoverGyro = box.checked;
        saveSettings();
        syncGyro();
    });
    $('cb_set_pagecards').value = String(s.pageCards);
    $('cb_set_pagechats').value = String(s.pageChats);
    $('cb_set_pagecards').addEventListener('change', e => setPageSize('cards', Number(e.target.value)));
    $('cb_set_pagechats').addEventListener('change', e => setPageSize('chats', Number(e.target.value)));
    $('cb_set_cardbtn').addEventListener('change', e => { s.cardButton = e.target.value; saveSettings(); wireCardButton(); });
    $('cb_set_open').addEventListener('click', () => openBrowser());
    $('cb_set_resetpos').addEventListener('click', () => { s.launcherPos = { ...DEFAULTS.launcherPos }; saveSettings(); if (!s.launcher) { s.launcher = true; $('cb_set_launcher').checked = true; renderLauncher(); } placeLauncher(); });
    renderLookEditor($('cb_look_body'));
    renderTopEditor($('cb_top_body'));
    $('cb_set_rescan').addEventListener('click', async () => {
        const b = $('cb_set_rescan');
        if (b.classList.contains('cb_busy')) return;
        b.classList.add('cb_busy');
        try { await reload({ full: true }); toast.ok(`โหลดใหม่แล้ว ${data.chats.length.toLocaleString('th-TH')} แชท`); } finally { b.classList.remove('cb_busy'); }
    });
    $('cb_set_readall').addEventListener('click', async () => {
        if (!data.at) await reload();
        for (const c of data.chats) seen.map[c.key] = c.count;
        saveSeen();
        updateLauncherBadge();
        ui.render();
        toast.ok('ทุกแชทอ่านแล้ว');
    });
}

/** Top bar icon: size, icon / emoji / picture, colour. Changes show on the real icon right away. */
function renderTopEditor(box) {
    if (!box) return;
    const T = topLook();
    box.innerHTML = `
        <small class="cb_setnote" style="margin-top:0">ดูผลได้ทันทีที่ไอคอนบนแถบด้านบน · ใช้รูป PNG พื้นใสให้เข้าชุดกับไอคอนของธีมได้</small>
        <span class="cb_look_label">ไอคอน</span>
        <div class="cb_look_grid" data-group="ticon">${LOOK_ICONS.map(v => `<button type="button" data-v="${v}"><i class="fa-solid ${v}"></i></button>`).join('')}</div>
        <div class="cb_look_rows">
            <span>อีโมจิ</span><input type="text" class="text_pole" data-t="emoji" maxlength="8" placeholder="เช่น 💌 🐱 ✨">
            <span>รูปภาพ</span>
            <div class="cb_look_imgbtns">
                <div class="menu_button" data-timg="upload"><i class="fa-solid fa-image"></i> เลือกรูป</div>
                <div class="menu_button" data-timg="url"><i class="fa-solid fa-link"></i> ลิงก์รูป</div>
                <div class="menu_button" data-timg="clear"><i class="fa-solid fa-xmark"></i> เอารูปออก</div>
                <input type="file" accept="image/*" hidden>
            </div>
            <span>ขนาด</span>
            <div class="cb_look_inline cb_tsize"><input type="range" data-t="size" min="12" max="64" step="1"><span class="cb_tsizeval"></span><div class="menu_button" data-tsize="theme">ตามธีม</div></div>
            <span>สี</span>
            <div class="cb_look_inline"><select class="text_pole" data-t="color" style="width:auto"><option value="theme">สีธีม</option><option value="custom">เลือกสี</option></select><input type="color" data-t="colorHex"></div>
            <span>ความทึบ</span><input type="range" data-t="opacity" min="20" max="100" step="5">
        </div>
        <div class="cb_look_checks">
            <label class="checkbox_label"><input type="checkbox" data-t="badge"> ตัวเลขข้อความใหม่</label>
        </div>
        <div class="cb_setbtns"><div class="menu_button" data-treset="1"><i class="fa-solid fa-rotate-left"></i> กลับเป็นแบบเดิม</div></div>`;

    const themeSize = () => {
        const icon = document.querySelector('#cb_topbar .cb_ticon');
        return icon ? Math.round(icon.getBoundingClientRect().height) || 0 : 0;
    };
    const sync = () => {
        const cur = topLook();
        for (const el of box.querySelectorAll('[data-t]')) {
            const k = el.dataset.t;
            if (el.type === 'checkbox') el.checked = !!cur[k];
            else if (k === 'size') el.value = cur.size || themeSize() || 30;
            else el.value = cur[k] ?? '';
        }
        refresh();
    };
    // labels and toggles only, so a field being typed in is never rewritten
    const refresh = () => {
        const cur = topLook();
        box.querySelector('.cb_tsizeval').textContent = cur.size ? `${cur.size}px` : 'ตามธีม';
        box.querySelector('[data-tsize]').hidden = !cur.size;
        box.querySelector('[data-t="colorHex"]').hidden = cur.color !== 'custom';
        box.querySelector('[data-timg="clear"]').hidden = !cur.image;
        box.querySelectorAll('[data-group="ticon"] button').forEach(b => b.classList.toggle('cb_on', !cur.emoji && !cur.image && b.dataset.v === cur.icon));
    };
    const set = (patch, all = false) => {
        Object.assign(topLook(), patch);
        saveSettings();
        applyTopLook();
        if (all) sync(); else refresh();
    };

    box.addEventListener('click', e => {
        const b = e.target.closest('button, .menu_button');
        if (!b) return;
        if (b.closest('[data-group="ticon"]')) return set({ icon: b.dataset.v, emoji: '', image: '' }, true);
        if (b.dataset.tsize) return set({ size: 0 }, true);
        if (b.dataset.treset) { settings().topbarLook = { ...TOP_DEFAULT }; saveSettings(); applyTopLook(); return sync(); }
        if (b.dataset.timg === 'upload') return box.querySelector('input[type="file"]').click();
        if (b.dataset.timg === 'clear') return set({ image: '' });
        if (b.dataset.timg === 'url') {
            const url = prompt('ลิงก์รูป (https://… ใช้ PNG พื้นใสหรือ GIF ได้)', /^https?:/.test(topLook().image) ? topLook().image : '');
            if (url == null) return;
            if (url && !/^https?:\/\//i.test(url.trim())) { toast.warn('ใส่ลิงก์ที่ขึ้นต้นด้วย https://'); return; }
            set({ image: url.trim() });
        }
    });
    box.querySelector('input[type="file"]').addEventListener('change', async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try { set({ image: await imageToDataUrl(f) }); } catch (err) { toast.err(`ใช้รูปนี้ไม่ได้: ${errText(err)}`); }
    });
    const onField = e => {
        const el = e.target.closest('[data-t]');
        if (!el) return;
        const k = el.dataset.t;
        const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        set({ [k]: v, ...(k === 'emoji' && String(v).trim() ? { image: '' } : {}) });
    };
    box.addEventListener('input', onField);
    box.addEventListener('change', onField);
    sync();
}

/** A slider with a number box you can read and type into. Icon size is stored as % of the button but shown and typed in px. */
/**
 * The number field's look is written inline with !important: themes style every input with !important behind
 * selectors like input:not(#send_textarea), whose :not(#id) outweighs a class rule. appearance is none, not
 * textfield: Safari reads appearance and -webkit-appearance as one property, and textfield makes iOS paint its
 * own white field.
 */
const BARE_NUM = ['-webkit-appearance:none', 'appearance:none', 'display:block', 'flex:none', 'box-sizing:content-box',
    'width:calc(3ch + 2px)', 'min-width:0', 'max-width:none', 'height:26px', 'min-height:0', 'line-height:26px',
    'margin:0', 'padding:0', 'border:0', 'border-radius:0', 'outline:none', 'box-shadow:none', 'background:transparent',
    'filter:none', 'text-shadow:none', 'color:inherit', 'font:inherit', 'font-size:16px', 'font-weight:700', 'text-align:right']
    .map(d => `${d}!important`).join(';');
const lookSlider = (k, min, max, step, v, unit, label, num = k) => `
    <div class="cb_look_slider">
        <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}" aria-label="${esc(label)}">
        <label class="cb_valbox" title="${esc(label)}"><input type="number" data-num="${num}" inputmode="numeric" aria-label="${esc(label)}" style="${BARE_NUM}"><i>${unit}</i></label>
    </div>`;
/** The icon size the button is drawn at, in px (same sum as applyLook). */
const lookIconPx = L => Math.round(clamp(Number(L.size) || 46, 24, 160) * clamp(Number(L.iconSize) || 42, 20, 100) / 100);

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
            <span>ขนาด</span>${lookSlider('size', 28, 140, 1, L.size, 'px', 'ขนาดปุ่ม')}
            <span>ไอคอน</span>${lookSlider('iconSize', 20, 100, 1, L.iconSize, 'px', 'ขนาดไอคอน (px)', 'iconPx')}
            <span>ความทึบ</span>${lookSlider('opacity', 20, 100, 5, L.opacity, '%', 'ความทึบตอนไม่ได้แตะ — แตะหรือชี้แล้วชัดเต็ม')}
            <span>พื้น</span>
            <div class="cb_look_inline"><select class="text_pole" data-k="bg" style="width:auto">${opt([['auto', COLOR_MODE_LABELS.auto], ['custom', COLOR_MODE_LABELS.custom], ['none', 'โปร่งใส']], L.bg)}</select><input type="color" data-k="bgColor" value="${esc(L.bgColor)}"></div>
            <span>สีไอคอน</span>
            <div class="cb_look_inline"><select class="text_pole" data-k="fg" style="width:auto">${opt(Object.entries(COLOR_MODE_LABELS), L.fg)}</select><input type="color" data-k="fgColor" value="${esc(L.fgColor)}"></div>
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
        // numbers next to the sliders (a box being typed in is left alone)
        const active = document.activeElement;
        const nums = { size: cur.size, iconPx: lookIconPx(cur), opacity: cur.opacity };
        for (const el of box.querySelectorAll('[data-num]')) {
            if (el.dataset.num === 'iconPx') { el.min = String(Math.round(cur.size * 0.2)); el.max = String(cur.size); }
            else { const r = box.querySelector(`[data-k="${el.dataset.num}"]`); el.min = r.min; el.max = r.max; }
            if (el !== active) el.value = String(nums[el.dataset.num]);
        }
        for (const r of box.querySelectorAll('input[type="range"][data-k]')) if (r !== active) r.value = String(cur[r.dataset.k]);
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
    const onNum = e => {
        const el = e.target.closest('[data-num]');
        if (!el || !box.contains(el)) return;
        const n = Number(el.value);
        if (el.value === '' || !Number.isFinite(n)) { if (e.type === 'change') refresh(); return; }
        const k = el.dataset.num;
        if (k === 'iconPx') {
            const size = Number(look().size) || 46;
            const pct = clamp(Math.round(n * 100 / size), 20, 100);
            if (e.type === 'input' && Math.abs(Math.round(size * pct / 100) - n) > 1) return; // still typing
            set({ iconSize: pct });
        } else {
            const min = Number(el.min), max = Number(el.max);
            if (e.type === 'input' && (n < min || n > max)) return; // still typing, e.g. "1" on the way to "120"
            set({ [k]: clamp(Math.round(n), min, max) });
        }
        if (e.type === 'change') { el.blur(); refresh(); }
    };
    box.addEventListener('input', onNum);
    box.addEventListener('change', onNum);
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('[data-num]')) e.target.blur(); });
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
                aliases: ['reverie'],
                callback: () => { openBrowser(); return ''; },
                helpString: 'เปิด Reverie — แชทและการ์ดทั้งหมดของทุกตัวละครและกลุ่ม (/reverie ก็ได้)',
            }));
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'chats-debug',
                aliases: ['reverie-debug'],
                callback: async () => runDiagnostics(),
                helpString: 'ตรวจปัญหา Reverie แล้วคืนรายงาน (ดูหรือคัดลอกได้จาก Extensions → Reverie → ตรวจปัญหา)',
            }));
        } else {
            c.registerSlashCommand?.('chats', () => { openBrowser(); return ''; }, ['reverie'], 'เปิด Reverie', true, true);
        }
    } catch (e) { console.warn(LOG, 'slash command', e); }
}

// ---------------------------------------------------------------- events

let refreshTimer = null;
/**
 * Something changed on the server: refresh quietly. Closed browser: only when `background`
 * (a sync brought chats in — the launcher's unread count should show it); otherwise on next open.
 */
function staleSoon(delay = 800, { background = false, full = false } = {}) {
    clearTimeout(refreshTimer);
    if (full) data.wantFull = true; // also on the next open, if the browser is closed now
    if (!ui.root && !background) return;
    refreshTimer = setTimeout(() => reload(), ui.root ? delay : Math.max(delay, 3000));
}

/** A chat deleted in SillyTavern: off the list now (a quick refresh cannot see a file that is gone). */
function dropDeleted(name) {
    const id = String(name ?? '').replace(/\.jsonl$/i, '');
    if (!id) { data.wantFull = true; return; }
    const cur = ctx();
    const ent = cur.groupId ? `g:${cur.groupId}:` : cur.characters?.[cur.characterId] ? `c:${cur.characters[cur.characterId].avatar}:` : null;
    // the chat of the open character or group; any chat of that name when it is not known
    const gone = data.chats.filter(c => c.chatId === id && (!ent || c.key.startsWith(ent)));
    const drop = gone.length ? gone : data.chats.filter(c => c.chatId === id);
    if (!drop.length) return;
    const keys = new Set(drop.map(c => c.key));
    setChats(data.chats.filter(c => !keys.has(c.key)));
    saveCache(keys);
    if (ui.root) ui.render();
    updateLauncherBadge();
}

function wireEvents() {
    const { eventSource, eventTypes: E0, event_types } = ctx();
    const E = E0 ?? event_types;
    const onMsg = () => { markCurrentSeen(); if (ui.root) ui.render(); };
    for (const ev of [E.MESSAGE_SENT, E.MESSAGE_RECEIVED, E.MESSAGE_DELETED, E.MESSAGE_SWIPED].filter(Boolean)) eventSource.on(ev, onMsg);
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, () => { markCurrentSeen(); if (ui.root) ui.render(); });
    // a renamed file keeps its old date, so only a full read finds it under the new name
    if (E.CHAT_RENAMED) eventSource.on(E.CHAT_RENAMED, ev => { afterRename(ev).catch(e => console.warn(LOG, e)); staleSoon(800, { full: true }); });
    for (const ev of [E.CHAT_DELETED, E.GROUP_CHAT_DELETED].filter(Boolean)) eventSource.on(ev, name => { dropDeleted(name); staleSoon(); });
    for (const ev of [E.CHAT_CREATED, E.GROUP_CHAT_CREATED].filter(Boolean)) eventSource.on(ev, () => staleSoon());
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
        globalThis.toastr?.info(`ติดตั้ง v${remote} ไว้แล้ว แต่หน้านี้ยังรัน v${VERSION}<br>แตะเพื่อโหลดเวอร์ชันใหม่`, 'Reverie', {
            timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false,
            onclick: async () => {
                await Promise.all(['index.js', 'core.js', 'gallery.js', 'editor.js', 'fx.js', 'lib.js', 'theme-palette.js', 'night-palette.js', 'float-colors.js', 'style.css', 'manifest.json'].map(f => fetch(new URL(f, BASE_URL), { cache: 'reload' }).catch(() => null)));
                location.reload();
            },
        });
    } catch { /* offline */ }
}

async function init() {
    // สีที่อ่านออกเสมอ (ดู theme-palette.js): โหมด "ตามธีม" ใช้ทั้งชุด · โหมดสว่าง/มืดที่เลือกเองใช้แค่สีเน้นที่ตัดกับพื้นของโหมดนั้น
    // ปุ่มลอยแบบ "ปรับตามธีม" ก็ดึงสีจากชุดนี้ (float-colors.js) แล้วคำนวณใหม่เมื่อเปลี่ยนธีม
    try {
        palette = installThemePalette({ prefix: 'cbp', surfaces: { light: '#fbfaf7', dark: '#1b1a21' } });
        palette.onChange(() => document.querySelectorAll('.cb_launch').forEach(el => applyLook(el)));
        installNightAccent(palette, 'cbp'); // กลางคืน: สีเน้นของธีมแบบนุ่มลง (night-palette.js)
    } catch (err) { console.warn(LOG, 'theme palette', err); }
    settings();
    renderSettingsPanel();
    renderLauncher();
    renderTopbar();
    wireCardButton();
    addWandItem();
    registerCommand();
    wireEvents();
    cacheReady.then(updateLauncherBadge);
    setTimeout(() => { reload().catch(() => {}); }, 4000); // badge counts; after the app has settled
    setTimeout(checkForNewVersion, 5000);
    console.log(LOG, 'loaded', VERSION);
}

// what gallery.js and editor.js call back into
Object.assign(app, { closeBrowser, doOpen, reload });

const publicApi = { open: openBrowser, close: closeBrowser, reload, data, VERSION, openEditor: avatar => { openBrowser(); return openEditor(avatar); } };
globalThis.Reverie = publicApi;
globalThis.ChatBrowser = publicApi; // the old name, for anything that already calls it

if (typeof jQuery === 'function') jQuery(init); else init();
