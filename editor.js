/*
 * Reverie — card editor: every field of a character card as a tappable row, and a full-screen
 * text sheet per field that stays above the on-screen keyboard. Made for phones, where
 * SillyTavern's own character panel is hard to use.
 *
 * Edits gather in a working copy and are written with one Save, through
 * /api/characters/merge-attributes (only the changed fields, v1 and v2 like SillyTavern writes
 * them). Every keystroke is also kept as a draft in localStorage, so a reload loses nothing.
 */

import { ctx, esc, toast, errText, st, charIndex, charOf, thumb, post, lsGet, ui, sheet } from './core.js';
import { CARD_FIELDS, readCard, diffCard, cardPatch, applyCard, moveItem, parseTags } from './lib.js';

const DRAFT_PREFIX = 'rv_draft_v1:';

/** label, hint shown in the field sheet, icon */
const FIELD_INFO = {
    name: ['ชื่อ', 'ชื่อที่แสดงในแชท · ไฟล์การ์ดและแชทเดิมอยู่ที่เดิม (ไม่ได้เปลี่ยนชื่อไฟล์)', 'fa-solid fa-signature'],
    description: ['คำอธิบาย', 'Description — ตัวตน รูปร่าง นิสัย ประวัติ ส่งให้ AI ทุกครั้ง', 'fa-solid fa-id-card'],
    personality: ['บุคลิก', 'Personality — สรุปนิสัยสั้น ๆ', 'fa-solid fa-masks-theater'],
    scenario: ['ฉาก', 'Scenario — สถานการณ์ตอนเริ่มเรื่อง', 'fa-solid fa-mountain-sun'],
    first_mes: ['ข้อความแรก', 'First message — ข้อความที่ตัวละครพูดเมื่อเริ่มแชทใหม่', 'fa-solid fa-comment'],
    alternate_greetings: ['ข้อความทักทายอื่น', 'Alternate greetings — ปัดเลือกได้ตอนเริ่มแชท เหมือนปัดข้อความ', 'fa-solid fa-comments'],
    mes_example: ['ตัวอย่างบทสนทนา', 'Example dialogue — ขึ้นต้นแต่ละชุดด้วย <START>', 'fa-solid fa-quote-left'],
    creator_notes: ["Creator's note", 'โน้ตจากผู้สร้างการ์ด แสดงในหน้าการ์ด (AI ไม่เห็น)', 'fa-solid fa-note-sticky'],
    system_prompt: ['System prompt', 'ใช้แทน system prompt หลัก เมื่อเปิด “Prefer Char. Prompt” ไว้', 'fa-solid fa-terminal'],
    post_history_instructions: ['Post-history instructions', 'คำสั่งที่ส่งต่อท้ายประวัติแชท เมื่อเปิด “Prefer Char. Instructions” ไว้', 'fa-solid fa-arrow-down-short-wide'],
    depth_prompt: ["Character's note", 'ข้อความที่แทรกเข้าไปในแชทที่ความลึกที่กำหนด (0 = ท้ายสุด)', 'fa-solid fa-thumbtack'],
    creator: ['ผู้สร้าง', 'Creator', 'fa-solid fa-feather-pointed'],
    character_version: ['เวอร์ชัน', 'Character version', 'fa-solid fa-code-branch'],
    tags: ['แท็กในการ์ด', 'แท็กที่เขียนไว้ในไฟล์การ์ด — คนละชุดกับแท็กของ SillyTavern ที่ใช้กรองในแกลเลอรี', 'fa-solid fa-tags'],
};
const GROUPS = [
    { id: 'main', title: '', keys: ['name', 'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'mes_example', 'creator_notes'] },
    { id: 'adv', title: 'ขั้นสูง', keys: ['system_prompt', 'post_history_instructions', 'depth_prompt', 'creator', 'character_version', 'tags'], folded: true },
];
const kindOf = key => CARD_FIELDS.find(f => f.key === key)?.kind ?? 'text';
const ROLES = [['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']];

let ed = null; // the open editor: { avatar, el, base, work, fsheet, advOpen }

const clone = v => JSON.parse(JSON.stringify(v));
const oneLine = (t, n = 140) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const nf = n => Number(n).toLocaleString('th-TH');

export const editorOpen = () => !!ed;

// ---------------------------------------------------------------- drafts (survive a reload)

const draftKey = avatar => DRAFT_PREFIX + avatar;
function readDraft(avatar) {
    const d = lsGet(draftKey(avatar), null);
    return d && typeof d === 'object' && d.fields && typeof d.fields === 'object' ? d : null;
}
function clearDraft(avatar) { try { localStorage.removeItem(draftKey(avatar)); } catch { /* blocked */ } }

/** Keep the working copy (and the text being typed) as a draft, or drop the draft when nothing differs. */
function saveDraft() {
    if (!ed?.work) return; // still loading: whatever draft is stored stays as it is
    // an older draft nobody has restored or dropped yet is kept under the new edits
    const fields = ed.draft ? { ...ed.draft.fields } : {};
    const work = { ...ed.work };
    const live = ed.fsheet?.liveValue?.();
    if (live) work[live.key] = live.value;
    for (const k of diffCard(ed.base, work)) fields[k] = work[k];
    try {
        if (Object.keys(fields).length) localStorage.setItem(draftKey(ed.avatar), JSON.stringify({ at: Date.now(), name: ed.base.name, fields }));
        else localStorage.removeItem(draftKey(ed.avatar));
    } catch { /* storage full or blocked: the editor still works */ }
}
let draftTimer = null;
const saveDraftSoon = () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 350); };
const flushDraft = () => { if (ed) { clearTimeout(draftTimer); saveDraft(); } };
window.addEventListener('pagehide', flushDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });

// ---------------------------------------------------------------- token counts

const tokenCache = new Map();
async function tokens(text) {
    const t = String(text ?? '');
    if (!t.trim()) return 0;
    if (tokenCache.has(t)) return tokenCache.get(t);
    const c = ctx();
    let n = null;
    try {
        if (typeof c.getTokenCountAsync === 'function') n = await c.getTokenCountAsync(t);
        else if (typeof c.getTokenCount === 'function') n = c.getTokenCount(t);
    } catch { n = null; }
    if (Number.isFinite(n)) {
        tokenCache.set(t, n);
        if (tokenCache.size > 400) tokenCache.delete(tokenCache.keys().next().value);
    }
    return Number.isFinite(n) ? n : null;
}
const textOf = (key, v) => (key === 'depth_prompt' ? v?.prompt : key === 'alternate_greetings' ? (v || []).join('\n') : key === 'tags' ? (v || []).join(', ') : v) ?? '';

// ---------------------------------------------------------------- saving

/**
 * If SillyTavern's own character editor shows this card, refill its fields from memory. Its
 * form is what SillyTavern saves on its next autosave (and on "Start new chat"), so stale
 * values there would overwrite ours. Same as SillyTavern's /char-update does.
 */
function refreshStEditor(avatar, s) {
    const $ = globalThis.jQuery;
    if (typeof $ !== 'function') return;
    if ($('#form_create').attr('actiontype') !== 'editcharacter' || $('#avatar_url_pole').val() !== avatar) return;
    const idx = charIndex(avatar);
    if (idx < 0) return;
    try {
        if (typeof s.select_selected_character === 'function') { s.select_selected_character(idx, { switchMenu: false }); return; }
    } catch (e) { console.warn('[Reverie] refresh editor', e); }
    // older SillyTavern: the fields its edit form sends
    const ch = ctx().characters[idx];
    const d = ch.data || {};
    $('#character_name_pole').val(ch.name);
    $('#description_textarea').val(ch.description);
    $('#personality_textarea').val(ch.personality);
    $('#scenario_pole').val(ch.scenario);
    $('#firstmessage_textarea').val(ch.first_mes);
    $('#mes_example_textarea').val(ch.mes_example);
    $('#creator_notes_textarea').val(d.creator_notes || ch.creatorcomment);
    $('#system_prompt_textarea').val(d.system_prompt || '');
    $('#post_history_instructions_textarea').val(d.post_history_instructions || '');
    $('#creator_textarea').val(d.creator);
    $('#character_version_textarea').val(d.character_version || '');
    $('#tags_textarea').val(Array.isArray(d.tags) ? d.tags.join(', ') : '');
    $('#depth_prompt_prompt').val(d.extensions?.depth_prompt?.prompt ?? '');
    $('#depth_prompt_depth').val(d.extensions?.depth_prompt?.depth ?? 4);
    $('#depth_prompt_role').val(d.extensions?.depth_prompt?.role ?? 'system');
    $('#character_json_data').val(ch.json_data);
}

/** Write the changed fields of a card and bring SillyTavern up to date with them. */
export async function saveCard(avatar, values, keys) {
    const c = ctx();
    const s = await st();
    if (charIndex(avatar) < 0) throw new Error('ไม่พบการ์ดนี้แล้ว');
    // Memory and SillyTavern's editor form first: an autosave of SillyTavern's own editor that
    // happens while the request runs then writes the new values too, not the old ones.
    applyCard(c.characters[charIndex(avatar)], values, keys);
    refreshStEditor(avatar, s);
    try {
        await post('/api/characters/merge-attributes', cardPatch(avatar, values, keys));
    } finally {
        // what the file holds now (also after a failure), back into memory and the editor form
        try { if (typeof c.getOneCharacter === 'function') await c.getOneCharacter(avatar); } catch (e) { console.warn('[Reverie] reload card', e); }
        refreshStEditor(avatar, s);
    }
    const idx = charIndex(avatar);
    try { await c.eventSource?.emit?.(c.eventTypes.CHARACTER_EDITED, { detail: { id: idx, character: c.characters[idx] } }); } catch (e) { console.warn('[Reverie] event', e); }
    if (keys.includes('name') || keys.includes('tags')) { try { s.printCharactersDebounced?.(); } catch { /* list redraws later anyway */ } }
}

// ---------------------------------------------------------------- the editor

/** Open the editor for a character (by avatar file name) over the browser window. */
export async function openEditor(avatar) {
    if (!ui.root || ed) return;
    if (charIndex(avatar) < 0) { toast.err('ไม่พบการ์ดนี้แล้ว'); return; }
    const layer = ui.root.querySelector('.cb_layer');
    const el = document.createElement('div');
    el.className = 'rv_editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'แก้ไขการ์ด');
    el.innerHTML = `<header class="rv_ehead">
            <button class="cb_iconbtn rv_eback" data-eback aria-label="กลับ"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="rv_etitle"><b>แก้ไขการ์ด</b><small>${esc(charOf(avatar)?.name ?? '')}</small></div>
            <button class="cb_btn cb_primary rv_esave" data-esave disabled><i class="fa-solid fa-floppy-disk"></i><span>บันทึก</span></button>
        </header>
        <div class="rv_ebody"><div class="cb_empty"><i class="fa-solid fa-circle-notch fa-spin"></i><span>กำลังอ่านการ์ด…</span></div></div>`;
    el._close = () => closeEditorGuarded();
    // shown first, filled after: a failure below still leaves a panel that can be closed
    layer.append(el);
    ed = { avatar, el, base: null, work: null, fsheet: null, advOpen: false };
    requestAnimationFrame(() => el.classList.add('cb_in'));
    el.addEventListener('click', onEditorClick);
    try {
        const c = ctx();
        // the card as it is in the file now (also loads the full card when SillyTavern only has its summary)
        try { if (typeof c.getOneCharacter === 'function') await c.getOneCharacter(avatar); else await c.unshallowCharacter?.(charIndex(avatar)); } catch (e) { console.warn('[Reverie] load card', e); }
        if (!ed || ed.el !== el) return;
        const ch = charOf(avatar);
        if (!ch) throw new Error('ไม่พบการ์ดนี้แล้ว');
        if (ch.shallow) throw new Error('โหลดข้อมูลการ์ดไม่ครบ ลองใหม่อีกครั้ง');
        ed.base = readCard(ch);
        ed.work = clone(ed.base);
        const draft = readDraft(avatar);
        ed.draft = draft && diffCard(ed.base, { ...ed.base, ...draft.fields }).length ? draft : null;
        if (draft && !ed.draft) clearDraft(avatar);
        renderEditor();
    } catch (e) {
        console.error('[Reverie] editor', e);
        el.querySelector('.rv_ebody').innerHTML = `<div class="cb_empty"><i class="fa-solid fa-triangle-exclamation"></i><span>เปิดตัวแก้ไขไม่ได้: ${esc(errText(e))}</span></div>`;
    }
}

function changedKeys() { return ed?.work ? diffCard(ed.base, ed.work) : []; }

function renderEditor() {
    if (!ed?.work) return;
    const keys = changedKeys();
    const btn = ed.el.querySelector('[data-esave]');
    btn.disabled = !keys.length;
    btn.querySelector('span').textContent = keys.length ? `บันทึก (${keys.length})` : 'บันทึก';
    ed.el.querySelector('.rv_etitle small').textContent = ed.work.name || ed.base.name;
    const body = ed.el.querySelector('.rv_ebody');
    const top = body.scrollTop;
    const d = ed.draft;
    body.innerHTML = `
        <div class="rv_ehero"><img src="${esc(thumb('avatar', ed.avatar))}" alt=""><div><b>${esc(ed.work.name || '(ไม่มีชื่อ)')}</b><small>${esc(ed.avatar)}</small></div></div>
        ${d ? `<div class="rv_draft"><i class="fa-solid fa-clock-rotate-left"></i><span>มีร่างที่ยังไม่ได้บันทึก ${Object.keys(d.fields).length} ช่อง<small>${esc(new Date(d.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }))}</small></span>
            <button class="cb_btn cb_small" data-draft="drop">ทิ้ง</button><button class="cb_btn cb_small cb_primary" data-draft="use">กู้คืน</button></div>` : ''}
        ${GROUPS.map(g => {
            const open = !g.folded || ed.advOpen || g.keys.some(k => keys.includes(k));
            const rows = g.keys.map(k => rowHtml(k, keys.includes(k))).join('');
            if (!g.title) return `<div class="rv_group">${rows}</div>`;
            return `<button class="rv_gtitle${open ? ' cb_on' : ''}" data-adv aria-expanded="${open}"><span>${esc(g.title)}</span><small>${g.keys.map(k => FIELD_INFO[k][0]).join(' · ')}</small><i class="fa-solid fa-chevron-down"></i></button>
                <div class="rv_group"${open ? '' : ' hidden'}>${rows}</div>`;
        }).join('')}
        <p class="cb_note rv_enote"><i class="fa-solid fa-shield-halved"></i>ทุกตัวอักษรที่พิมพ์เก็บเป็นร่างในเครื่องนี้ด้วย ปิดหน้าหรือรีโหลดก็ไม่หาย · กด “บันทึก” เพื่อเขียนลงการ์ด</p>`;
    body.scrollTop = top;
    countRows();
}

function previewOf(key, v) {
    if (key === 'alternate_greetings') return v.length ? `${v.length} ข้อความ · ${oneLine(v[0], 90)}` : '';
    if (key === 'depth_prompt') return v.prompt.trim() ? `ลึก ${v.depth} · ${v.role} · ${oneLine(v.prompt, 100)}` : '';
    if (key === 'tags') return v.join(', ');
    return oneLine(v);
}

function rowHtml(key, changed) {
    const [label, , icon] = FIELD_INFO[key];
    const v = ed.work[key];
    const prev = previewOf(key, v);
    const long = !['line', 'tags'].includes(kindOf(key));
    return `<button class="rv_row${changed ? ' rv_changed' : ''}" data-field="${key}">
        <i class="${icon} rv_ricon"></i>
        <span class="rv_rmain">
            <span class="rv_rlabel">${esc(label)}${changed ? '<em class="rv_dot" title="แก้แล้ว ยังไม่บันทึก"></em>' : ''}</span>
            <span class="rv_rprev${prev ? '' : ' rv_empty'}">${prev ? esc(prev) : 'ว่าง'}</span>
            ${long ? `<span class="rv_rmeta" data-count="${key}">${nf(textOf(key, v).length)} ตัวอักษร</span>` : ''}
        </span>
        <i class="fa-solid fa-chevron-right rv_rgo"></i>
    </button>`;
}

/** Token counts arrive one by one (the tokenizer may take a moment on long fields). */
async function countRows() {
    const el = ed?.el;
    for (const m of [...(el?.querySelectorAll('[data-count]') ?? [])]) {
        const key = m.dataset.count;
        const text = textOf(key, ed?.work?.[key]);
        const n = await tokens(text);
        if (!ed || ed.el !== el || !m.isConnected) return;
        if (n != null && text.trim()) m.textContent = `${nf(text.length)} ตัวอักษร · ≈${nf(n)} โทเคน`;
    }
}

async function onEditorClick(e) {
    if (!ed) return;
    const t = e.target;
    if (t.closest('[data-eback]')) { closeEditorGuarded(); return; }
    if (t.closest('[data-esave]')) { saveNow(); return; }
    if (t.closest('[data-adv]')) { ed.advOpen = !t.closest('[data-adv]').classList.contains('cb_on'); renderEditor(); return; }
    const dr = t.closest('[data-draft]');
    if (dr) {
        if (dr.dataset.draft === 'use') Object.assign(ed.work, clone(ed.draft.fields));
        else clearDraft(ed.avatar);
        ed.draft = null;
        renderEditor();
        if (dr.dataset.draft === 'use') { saveDraft(); toast.info('กู้คืนร่างแล้ว — ตรวจดูแล้วกด “บันทึก”'); }
        return;
    }
    const row = t.closest('[data-field]');
    if (row && !t.closest('.rv_fsheet')) openField(row.dataset.field);
}

async function saveNow() {
    if (!ed?.work) return false;
    const keys = changedKeys();
    if (!keys.length) return true;
    if (keys.includes('name') && !ed.work.name.trim()) { toast.warn('ชื่อตัวละครว่างไม่ได้'); return false; }
    const btn = ed.el.querySelector('[data-esave]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'กำลังบันทึก…';
    const el = ed.el;
    try {
        await saveCard(ed.avatar, ed.work, keys);
    } catch (e) {
        console.error('[Reverie] save', e);
        toast.err(`บันทึกการ์ดไม่สำเร็จ: ${errText(e)} — ร่างยังเก็บไว้ในเครื่องนี้`);
        if (ed?.el === el) renderEditor();
        return false;
    }
    if (!ed || ed.el !== el) return true;
    const now = charOf(ed.avatar);
    ed.base = now ? readCard(now) : clone(ed.work);
    // anything the server wrote differently stays visible as unsaved instead of being lost
    const left = diffCard(ed.base, ed.work);
    if (!left.length) ed.work = clone(ed.base);
    saveDraft(); // drops the draft, unless an older one is still waiting to be restored or dropped
    toast.ok(`บันทึกการ์ด “${ed.base.name}” แล้ว (${keys.length} ช่อง)`);
    renderEditor();
    ui.render?.();
    return true;
}

/** Leave the editor; with unsaved edits, ask first (save / discard / keep editing). */
export async function closeEditorGuarded() {
    if (!ed) return true;
    if (ed.fsheet) { ed.fsheet.requestClose(); return false; }
    const keys = changedKeys();
    if (keys.length) {
        const choice = await sheet({
            title: 'ยังไม่ได้บันทึก',
            body: `<p>แก้ไว้ ${keys.length} ช่อง: ${keys.map(k => `<b>${esc(FIELD_INFO[k][0])}</b>`).join(', ')}</p><p class="cb_note">ถ้าออกโดยไม่บันทึก ร่างยังเก็บไว้ในเครื่องนี้ เปิดตัวแก้ไขการ์ดนี้อีกครั้งแล้วกู้คืนได้</p>`,
            buttons: [
                { label: 'แก้ต่อ', run: a => a.close('stay') },
                { label: 'ออกโดยไม่บันทึก', run: a => a.close('leave') },
                { label: 'บันทึกแล้วออก', primary: true, run: a => a.close('save') },
            ],
        });
        if (choice === 'save') { if (!(await saveNow())) return false; } else if (choice !== 'leave') return false;
        else flushDraft();
    }
    closeEditor();
    return true;
}

export function closeEditor() {
    if (!ed) return;
    const el = ed.el;
    flushDraft(); // unsaved edits stay as a draft (nothing is kept when they were saved)
    ed = null;
    el.classList.add('cb_out');
    setTimeout(() => el.remove(), 160);
}

// ---------------------------------------------------------------- field sheets

/**
 * A full-screen sheet over the editor. The browser window follows the visible viewport
 * (index.js fitViewport), so the sheet's bottom bar sits right above the on-screen keyboard.
 */
function fieldShell({ title, hint, cls = '', actions = '' }) {
    const el = document.createElement('div');
    el.className = `rv_fsheet ${cls}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<header class="rv_fhead">
            <button class="cb_iconbtn" data-fx aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>
            <b class="rv_ftitle">${esc(title)}</b>
            ${actions}
        </header>
        ${hint ? `<div class="rv_fhint">${esc(hint)}</div>` : ''}
        <div class="rv_fbody"></div>`;
    ed.el.append(el);
    requestAnimationFrame(() => el.classList.add('cb_in'));
    return el;
}
const dropShell = el => { el.classList.add('cb_out'); setTimeout(() => el.remove(), 150); };

function openField(key) {
    if (!ed?.work || ed.fsheet) return;
    const kind = kindOf(key);
    if (kind === 'list') return openGreetings();
    if (kind === 'tags') return openTags();
    const [label, hint] = FIELD_INFO[key];
    textSheet({
        key, title: label, hint,
        value: key === 'depth_prompt' ? ed.work.depth_prompt.prompt : ed.work[key],
        depth: key === 'depth_prompt' ? ed.work.depth_prompt : null,
        line: kind === 'line',
        onDone: (text, extra) => {
            ed.work[key] = key === 'depth_prompt' ? { prompt: text, depth: extra.depth, role: extra.role } : text;
        },
    });
}

/**
 * The text sheet: a big textarea, {{char}} / {{user}} chips, undo of the whole edit, counts.
 * onDone(text, extra) runs on "เสร็จ"; closing with changes asks first.
 */
function textSheet({ key, title, hint, value, depth = null, line = false, onDone, onClose = null, liveKey = key, liveWrap = null }) {
    const parent = ed.fsheet; // a list sheet under this one (greetings), back on top when this closes
    const start = String(value ?? '');
    const startDepth = depth ? { depth: depth.depth, role: depth.role } : null;
    const el = fieldShell({
        title, hint, cls: line ? 'rv_line' : '',
        actions: `<button class="cb_iconbtn rv_undo" data-fundo title="ย้อนการแก้ในช่องนี้ทั้งหมด" aria-label="ย้อนการแก้" disabled><i class="fa-solid fa-rotate-left"></i></button>
            <button class="cb_btn cb_primary rv_fdone" data-fdone>เสร็จ</button>`,
    });
    const body = el.querySelector('.rv_fbody');
    body.innerHTML = `${depth ? `<div class="rv_depth">
            <label><span>ความลึก</span><input type="number" inputmode="numeric" min="0" max="999" step="1" class="cb_input rv_dnum" value="${esc(depth.depth)}"></label>
            <label><span>ส่งในนาม</span><select class="cb_input rv_drole">${ROLES.map(([v, l]) => `<option value="${v}"${depth.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>` : ''}
        <textarea class="rv_ta" spellcheck="false" autocomplete="off" autocapitalize="sentences" ${line ? 'rows="2" enterkeyhint="done"' : ''}></textarea>`;
    const bar = document.createElement('footer');
    bar.className = 'rv_fbar';
    bar.innerHTML = `<button class="rv_chip" data-ins="{{char}}">{{char}}</button><button class="rv_chip" data-ins="{{user}}">{{user}}</button><span class="rv_fcount"></span>`;
    el.append(bar);
    const ta = body.querySelector('textarea');
    ta.value = start;
    const dnum = body.querySelector('.rv_dnum'), drole = body.querySelector('.rv_drole');
    const undoBtn = el.querySelector('[data-fundo]');
    let redo = null; // the edit that undo took back, until something is typed again

    const extra = () => (depth ? { depth: Math.max(0, Math.round(Number(dnum.value) || 0)), role: drole.value } : null);
    const dirty = () => ta.value !== start || (depth && (extra().depth !== startDepth.depth || extra().role !== startDepth.role));
    const fit = () => {
        // short fields grow with their text; long ones fill the sheet and scroll inside
        if (!line) return;
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight + 2, body.clientHeight - 8)}px`;
    };
    let countTimer = null;
    const count = () => {
        const n = ta.value.length;
        const out = el.querySelector('.rv_fcount');
        out.textContent = `${nf(n)} ตัวอักษร`;
        clearTimeout(countTimer);
        countTimer = setTimeout(async () => { const k = await tokens(ta.value); if (k != null && el.isConnected && ta.value.trim()) out.textContent = `${nf(ta.value.length)} ตัวอักษร · ≈${nf(k)} โทเคน`; }, 500);
    };
    const update = () => {
        undoBtn.disabled = !dirty() && !redo;
        undoBtn.classList.toggle('rv_redo', !!redo);
        undoBtn.innerHTML = redo ? '<i class="fa-solid fa-rotate-right"></i>' : '<i class="fa-solid fa-rotate-left"></i>';
        undoBtn.title = redo ? 'ทำซ้ำ — เอาการแก้กลับมา' : 'ย้อนการแก้ในช่องนี้ทั้งหมด';
        count();
        fit();
        saveDraftSoon();
    };
    ta.addEventListener('input', () => { redo = null; update(); });
    dnum?.addEventListener('input', () => { redo = null; update(); });
    drole?.addEventListener('change', () => { redo = null; update(); });
    if (line) ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); done(); } });

    // chips: pointerdown must not take the focus, or the keyboard drops and comes back
    bar.addEventListener('pointerdown', e => { if (e.target.closest('[data-ins]')) e.preventDefault(); });
    bar.addEventListener('mousedown', e => { if (e.target.closest('[data-ins]')) e.preventDefault(); });
    bar.addEventListener('click', e => {
        const b = e.target.closest('[data-ins]');
        if (!b) return;
        if (document.activeElement !== ta) ta.focus({ preventScroll: true });
        // execCommand keeps the system's own undo working; setRangeText where it is gone
        let ok = false;
        try { ok = document.execCommand('insertText', false, b.dataset.ins); } catch { ok = false; }
        if (!ok) { ta.setRangeText(b.dataset.ins, ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    });
    undoBtn.addEventListener('click', () => {
        if (redo) {
            ta.value = redo.text;
            if (depth) { dnum.value = redo.depth; drole.value = redo.role; }
            redo = null;
        } else {
            redo = { text: ta.value, ...(extra() || {}) };
            ta.value = start;
            if (depth) { dnum.value = startDepth.depth; drole.value = startDepth.role; }
        }
        update();
    });

    const close = () => { clearTimeout(countTimer); ed.fsheet = parent; dropShell(el); onClose?.(); saveDraftSoon(); };
    const done = () => { onDone(ta.value, extra()); close(); renderEditor(); saveDraft(); };
    const requestClose = async () => {
        if (!dirty()) { close(); return; }
        const ok = await sheet({
            title: 'ทิ้งการแก้ในช่องนี้?',
            body: '<p class="cb_note">ข้อความที่พิมพ์ในช่องนี้ตั้งแต่เปิดจะหายไป</p>',
            buttons: [
                { label: 'แก้ต่อ', run: a => a.close(false) },
                { label: 'ทิ้ง', danger: true, run: a => a.close(true) },
                { label: 'เก็บไว้', primary: true, run: a => a.close('keep') },
            ],
        });
        if (ok === 'keep') done();
        else if (ok) close();
    };
    el.querySelector('[data-fx]').addEventListener('click', requestClose);
    el.querySelector('[data-fdone]').addEventListener('click', done);
    el._close = requestClose;
    ed.fsheet = {
        el, requestClose,
        liveValue: () => {
            const v = depth ? { prompt: ta.value, ...extra() } : ta.value;
            return { key: liveKey, value: liveWrap ? liveWrap(v) : v };
        },
    };
    update();
    // the keyboard comes up right away on a tap (iOS opens it only from the tap itself)
    ta.focus({ preventScroll: true });
    if (line) ta.setSelectionRange(ta.value.length, ta.value.length);
    else ta.setSelectionRange(0, 0);
}

// ---------------------------------------------------------------- alternate greetings

function openGreetings() {
    const el = fieldShell({
        title: FIELD_INFO.alternate_greetings[0],
        hint: FIELD_INFO.alternate_greetings[1],
        cls: 'rv_greets',
        actions: `<button class="cb_btn rv_gview" data-gview title="ดูแบบปัดเหมือนตอนเริ่มแชท"><i class="fa-solid fa-eye"></i><span>ลองปัด</span></button>
            <button class="cb_btn cb_primary" data-fx2>เสร็จ</button>`,
    });
    const body = el.querySelector('.rv_fbody');
    const list = () => ed.work.alternate_greetings;
    const draw = () => {
        const g = list();
        body.innerHTML = `${g.length ? `<div class="rv_glist">${g.map((x, i) => `<div class="rv_gitem" data-gi="${i}">
                <button class="rv_gtext" data-gedit="${i}"><b>#${i + 1}</b><span class="${x.trim() ? '' : 'rv_empty'}">${esc(oneLine(x, 220) || 'ว่าง')}</span><small>${nf(x.length)} ตัวอักษร</small></button>
                <div class="rv_gtools">
                    <button class="cb_iconbtn" data-gup="${i}"${i === 0 ? ' disabled' : ''} aria-label="เลื่อนขึ้น"><i class="fa-solid fa-arrow-up"></i></button>
                    <button class="cb_iconbtn" data-gdown="${i}"${i === g.length - 1 ? ' disabled' : ''} aria-label="เลื่อนลง"><i class="fa-solid fa-arrow-down"></i></button>
                    <button class="cb_iconbtn rv_gdel" data-gdel="${i}" aria-label="ลบ"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`).join('')}</div>` : '<div class="cb_empty"><i class="fa-regular fa-comments"></i><span>ยังไม่มีข้อความทักทายอื่น</span></div>'}
            <button class="cb_btn rv_gadd" data-gadd><i class="fa-solid fa-plus"></i>เพิ่มข้อความทักทาย</button>`;
        el.querySelector('[data-gview]').disabled = !g.length && !ed.work.first_mes.trim();
    };
    const close = () => { ed.fsheet = null; dropShell(el); renderEditor(); saveDraft(); };
    el.querySelector('[data-fx]').addEventListener('click', close);
    el.querySelector('[data-fx2]').addEventListener('click', close);
    el._close = close;
    ed.fsheet = { el, requestClose: close, liveValue: () => null };
    const editAt = (i, isNew = false) => textSheet({
        key: 'alternate_greetings', title: isNew ? 'ข้อความทักทายใหม่' : `ข้อความทักทาย #${i + 1}`, hint: '', value: list()[i] ?? '',
        liveWrap: v => { const g = [...list()]; g[i] = v; return g; },
        onDone: text => { const g = [...list()]; g[i] = text; ed.work.alternate_greetings = g; },
        onClose: () => {
            // a new greeting left empty is not kept
            if (isNew && !String(list()[i] ?? '').trim()) ed.work.alternate_greetings = list().filter((_, j) => j !== i);
            draw();
        },
    });
    body.addEventListener('click', async e => {
        const t = e.target;
        const n = s => Number(t.closest(`[${s}]`)?.getAttribute(s));
        if (t.closest('[data-gadd]')) { ed.work.alternate_greetings = [...list(), '']; draw(); editAt(list().length - 1, true); return; }
        if (t.closest('[data-gedit]')) { editAt(n('data-gedit')); return; }
        if (t.closest('[data-gup]')) { ed.work.alternate_greetings = moveItem(list(), n('data-gup'), n('data-gup') - 1); draw(); saveDraftSoon(); return; }
        if (t.closest('[data-gdown]')) { ed.work.alternate_greetings = moveItem(list(), n('data-gdown'), n('data-gdown') + 1); draw(); saveDraftSoon(); return; }
        if (t.closest('[data-gdel]')) {
            const i = n('data-gdel');
            const text = list()[i] ?? '';
            if (text.trim()) {
                const ok = await sheet({
                    title: `ลบข้อความทักทาย #${i + 1}?`,
                    body: `<div class="rv_gquote">${esc(oneLine(text, 300))}</div><p class="cb_note">ยังกู้ได้จนกว่าจะกด “บันทึก” (ปิดตัวแก้ไขโดยไม่บันทึก)</p>`,
                    buttons: [{ label: 'ยกเลิก', run: a => a.close(false) }, { label: 'ลบ', danger: true, run: a => a.close(true) }],
                });
                if (!ok) return;
            }
            ed.work.alternate_greetings = list().filter((_, j) => j !== i);
            draw();
            saveDraftSoon();
        }
    });
    el.querySelector('[data-gview]').addEventListener('click', () => swipePreview(draw));
    draw();
}

/** The greetings as a new chat shows them: first message, then each alternate, swiping sideways. */
function swipePreview(redraw) {
    const all = () => [ed.work.first_mes, ...ed.work.alternate_greetings];
    let i = 0;
    const c = ctx();
    const fill = t => String(t ?? '').replace(/\{\{char\}\}/gi, ed.work.name || '{{char}}').replace(/\{\{user\}\}/gi, c.name1 || '{{user}}');
    const holder = ed.fsheet;
    const el = fieldShell({
        title: 'ลองปัด',
        cls: 'rv_swipe',
        actions: '<button class="cb_btn rv_gfirst" data-gfirst title="สลับข้อความนี้กับข้อความแรก"><i class="fa-solid fa-star"></i><span>ตั้งเป็นข้อความแรก</span></button>',
    });
    const body = el.querySelector('.rv_fbody');
    const draw = () => {
        const g = all();
        i = Math.max(0, Math.min(g.length - 1, i));
        body.innerHTML = `<div class="rv_swhead"><img src="${esc(thumb('avatar', ed.avatar))}" alt=""><b>${esc(ed.work.name)}</b><span>${i === 0 ? 'ข้อความแรก' : `ทักทายอื่น #${i}`}</span></div>
            <div class="rv_swtext">${esc(fill(g[i])) || '<span class="rv_empty">ว่าง</span>'}</div>
            <div class="rv_swnav">
                <button class="cb_iconbtn" data-sw="-1"${i === 0 ? ' disabled' : ''} aria-label="ก่อนหน้า"><i class="fa-solid fa-chevron-left"></i></button>
                <span>${i + 1} / ${g.length}</span>
                <button class="cb_iconbtn" data-sw="1"${i === g.length - 1 ? ' disabled' : ''} aria-label="ถัดไป"><i class="fa-solid fa-chevron-right"></i></button>
            </div>`;
        el.querySelector('[data-gfirst]').disabled = i === 0;
    };
    const close = () => { ed.fsheet = holder; dropShell(el); redraw(); };
    el.querySelector('[data-fx]').addEventListener('click', close);
    el._close = close;
    ed.fsheet = { el, requestClose: close, liveValue: () => null };
    body.addEventListener('click', e => {
        const b = e.target.closest('[data-sw]');
        if (b && !b.disabled) { i += Number(b.dataset.sw); draw(); }
    });
    el.querySelector('[data-gfirst]').addEventListener('click', () => {
        if (i === 0) return;
        const g = [...ed.work.alternate_greetings];
        const first = ed.work.first_mes;
        ed.work.first_mes = g[i - 1];
        g[i - 1] = first;
        ed.work.alternate_greetings = g;
        i = 0;
        draw();
        saveDraftSoon();
        toast.info('สลับกับข้อความแรกแล้ว — กด “บันทึก” เพื่อเขียนลงการ์ด');
    });
    let sx = null;
    body.addEventListener('touchstart', e => { sx = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    body.addEventListener('touchend', e => {
        if (!sx) return;
        const p = e.changedTouches[0];
        const dx = p.clientX - sx.x, dy = p.clientY - sx.y;
        sx = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) { i += dx < 0 ? 1 : -1; draw(); }
    }, { passive: true });
    draw();
}

// ---------------------------------------------------------------- tags

function openTags() {
    const start = [...ed.work.tags];
    let tags = [...start];
    const el = fieldShell({
        title: FIELD_INFO.tags[0], hint: FIELD_INFO.tags[1],
        actions: '<button class="cb_btn cb_primary" data-fdone>เสร็จ</button>',
    });
    const body = el.querySelector('.rv_fbody');
    body.innerHTML = `<div class="rv_tagedit"></div>
        <div class="rv_tagadd"><input class="cb_input" type="text" placeholder="พิมพ์แท็กแล้วกด เพิ่ม (คั่นหลายแท็กด้วย ,)" enterkeyhint="done" autocomplete="off" spellcheck="false"><button class="cb_btn" data-tadd>เพิ่ม</button></div>`;
    const input = body.querySelector('input');
    const draw = () => {
        body.querySelector('.rv_tagedit').innerHTML = tags.length
            ? tags.map((t, i) => `<span class="rv_etag">${esc(t)}<button data-tdel="${i}" aria-label="ลบแท็ก ${esc(t)}"><i class="fa-solid fa-xmark"></i></button></span>`).join('')
            : '<span class="rv_empty">ยังไม่มีแท็ก</span>';
    };
    const add = () => {
        const more = parseTags(input.value);
        if (!more.length) return;
        tags = parseTags([...tags, ...more].join(','));
        input.value = '';
        draw();
        saveDraftSoon();
    };
    body.addEventListener('click', e => {
        const d = e.target.closest('[data-tdel]');
        if (d) { tags = tags.filter((_, i) => i !== Number(d.dataset.tdel)); draw(); saveDraftSoon(); return; }
        if (e.target.closest('[data-tadd]')) add();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
    input.addEventListener('input', () => { if (input.value.includes(',')) add(); });
    const close = () => { ed.fsheet = null; dropShell(el); renderEditor(); saveDraft(); };
    const done = () => { add(); ed.work.tags = tags; close(); };
    const requestClose = async () => {
        add();
        if (JSON.stringify(tags) === JSON.stringify(start)) { close(); return; }
        done();
    };
    el.querySelector('[data-fx]').addEventListener('click', requestClose);
    el.querySelector('[data-fdone]').addEventListener('click', done);
    el._close = requestClose;
    ed.fsheet = { el, requestClose, liveValue: () => ({ key: 'tags', value: tags }) };
    draw();
}
