/*
 * Reverie — gallery: a grid of character and group covers, and a page per card
 * (picture, creator, tags, creator's note and the card's chats).
 */

import { ctx, settings, saveSettings, esc, toast, errText, st, charOf, charIndex, groupOf, thumb, currentKey, isGenerating, data, ui, app, sheet, fullAvatar } from './core.js';
import { addedAt, fullTime, noteText, relTime, tagCounts } from './lib.js';
import { playCardPage } from './fx.js';

// ---------------------------------------------------------------- gallery cards


// ---------------------------------------------------------------- gallery covers
//
// A card picture is a PNG of a few MB, around 4 MB once decoded. Showing dozens of them at
// full size at once runs an app's WebView out of memory (Tauri and phone apps restart),
// even where a desktop browser copes. So the gallery decodes a few at a time, keeps a
// copy scaled to the tile, and lets the big picture go.

const COVER_JOBS = 3;    // pictures decoding at the same time
const COVER_KEEP = 240;  // scaled copies kept for scrolling back
const coverCache = new Map(); // "url|w|h" → object URL of the scaled copy (or the url itself)
const coverQueue = [];
const coverWanted = new WeakSet(); // <img>s near the screen
let coverRunning = 0;

/** The tile's size in device pixels, rounded so one copy serves tiles of nearly the same size. */
function coverBox(img) {
    const box = img.parentElement;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const step = v => Math.max(80, Math.ceil(v * dpr / 40) * 40);
    return { w: step(box?.clientWidth || 160), h: step(box?.clientHeight || 240) };
}

export function showCover(img) {
    const url = img.dataset.src;
    if (!url || img.hasAttribute('src')) return;
    coverWanted.add(img);
    const { w, h } = coverBox(img);
    const hit = coverCache.get(`${url}|${w}|${h}`);
    // already scaled once: no fade, it simply is there (no flicker on every redraw)
    if (hit) { img.classList.add('cb_now'); img.src = hit; return; }
    if (!coverQueue.some(j => j.img === img)) coverQueue.push({ img, url, w, h });
    pumpCovers();
}

export function dropCover(img) {
    coverWanted.delete(img);
    const i = coverQueue.findIndex(j => j.img === img);
    if (i >= 0) coverQueue.splice(i, 1);
    if (img.hasAttribute('src')) { img.removeAttribute('src'); img.classList.remove('cb_loaded', 'cb_now'); }
    img.previousElementSibling?.classList.remove('cb_under');
}

function pumpCovers() {
    while (coverRunning < COVER_JOBS && coverQueue.length) {
        const job = coverQueue.shift();
        if (!job.img.isConnected || !coverWanted.has(job.img)) continue;
        coverRunning++;
        scaledCover(job.url, job.w, job.h)
            .then(src => { if (job.img.isConnected && coverWanted.has(job.img) && !job.img.hasAttribute('src')) job.img.src = src; })
            .catch(() => {})
            .finally(() => { coverRunning--; pumpCovers(); });
    }
}

async function scaledCover(url, w, h) {
    const key = `${url}|${w}|${h}`;
    if (coverCache.has(key)) return coverCache.get(key);
    let out = url;
    const big = new Image();
    try {
        big.decoding = 'async';
        big.src = url;
        await big.decode();
        const nw = big.naturalWidth, nh = big.naturalHeight;
        const k = Math.max(w / nw, h / nh); // fill the tile, as object-fit: cover does
        if (nw && nh && k < 0.8) {
            const c = document.createElement('canvas');
            c.width = Math.round(nw * k);
            c.height = Math.round(nh * k);
            const g = c.getContext('2d');
            g.imageSmoothingQuality = 'high';
            g.drawImage(big, 0, 0, c.width, c.height);
            const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.9));
            c.width = c.height = 0;
            if (blob) out = URL.createObjectURL(blob);
        }
    } catch { /* could not decode, or another site's picture: show it as it is */ }
    big.removeAttribute('src'); // let the big decoded picture go
    coverCache.set(key, out);
    if (coverCache.size > COVER_KEEP) {
        for (const [k, v] of coverCache) {
            if (coverCache.size <= COVER_KEEP) break;
            if (v.startsWith('blob:') && document.querySelector(`img[src="${CSS.escape(v)}"]`)) continue; // on screen
            coverCache.delete(k);
            if (v.startsWith('blob:')) URL.revokeObjectURL(v);
        }
    }
    return out;
}

let tagIndex = { list: null, map: new Map() };
function tagById(id) {
    const list = ctx().tags || [];
    if (tagIndex.list !== list || tagIndex.size !== list.length) tagIndex = { list, size: list.length, map: new Map(list.map(t => [t.id, t])) };
    return tagIndex.map.get(id);
}

/** SillyTavern's own tags of a character or group; else the tags written in the card. */
export function tagsOf(entity, ch) {
    const c = ctx();
    const own = (c.tagMap?.[entity] || []).map(tagById).filter(t => t?.name);
    if (own.length) return own.map(t => ({ name: String(t.name), color: t.color || '', color2: t.color2 || '' }));
    // tags written in the card itself, when SillyTavern's own tags were not imported
    const raw = ch?.data?.tags ?? ch?.tags;
    return Array.isArray(raw) ? [...new Set(raw.map(String).map(x => x.trim()).filter(Boolean))].slice(0, 30).map(name => ({ name })) : [];
}

/** What the gallery shows of a character or group: pictures, tags, creator and creator's note. */
export function cardMeta(id, { note = true } = {}) {
    const bar = id.indexOf('|');
    const type = id.slice(0, bar), entity = id.slice(bar + 1);
    if (type === 'group') {
        const g = groupOf(entity);
        const members = (g?.members || []).map(a => charOf(a)).filter(Boolean);
        const url = g?.avatar_url;
        const own = url && /^(data:|https?:|\/)/.test(url) ? url : '';
        return {
            type, entity,
            full: own, thumb: own,
            collage: own ? null : members.slice(0, 4).map(ch => ({ full: fullAvatar(ch.avatar), thumb: thumb('avatar', ch.avatar) })),
            members: members.map(ch => ({ name: ch.name, thumb: thumb('avatar', ch.avatar) })),
            tags: tagsOf(entity, null),
            creator: '', version: '', note: '', fav: g?.fav === true || g?.fav === 'true',
        };
    }
    const ch = charOf(entity);
    const d = ch?.data || {};
    return {
        type, entity,
        full: fullAvatar(entity), thumb: thumb('avatar', entity),
        collage: null, members: null,
        tags: tagsOf(entity, ch),
        creator: String(d.creator ?? '').trim(),
        version: String(d.character_version ?? '').trim(),
        note: note ? noteText(d.creator_notes || ch?.creatorcomment || '', { char: ch?.name, user: ctx().name1 }) : '',
        fav: ch?.fav === true || ch?.fav === 'true',
    };
}

/**
 * Creator / version as cards write them: a name, or links to where the card came from.
 * Links become short chips (site and first folder); long plain text is cut.
 */
function creditHtml(value, { icon = '', prefix = '', title = '', maxText = 40 } = {}) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const links = [];
    const text = raw
        .replace(/https?:\/\/[^\s<>"']+/gi, url => {
            const tail = url.match(/[).,;:!?\]]+$/)?.[0] ?? '';
            links.push(url.slice(0, url.length - tail.length));
            return ' ';
        })
        .replace(/[([]\s*[)\]]|[([]\s*$/g, ' ')   // brackets left empty by the links
        .replace(/\s+/g, ' ').trim();
    const out = [];
    if (text && text.length <= maxText) out.push(`<span title="${esc(title)}">${icon ? `<i class="${icon}"></i>` : ''}${esc(prefix)}${esc(text)}</span>`);
    for (const url of links.slice(0, 3)) {
        let label = url;
        try {
            const u = new URL(url);
            const dir = u.pathname.split('/').filter(Boolean)[0];
            label = `${u.hostname.replace(/^www\./, '')}${dir ? `/${dir}` : ''}`;
        } catch { continue; }
        out.push(`<a class="cb_link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}: ${esc(url)}">${icon && !out.length ? `<i class="${icon}"></i>` : '<i class="fa-solid fa-link"></i>'}${esc(label)}</a>`);
    }
    return out.join('');
}

/** Tags and creator, so the gallery search finds cards by them too. */
export function cardSearchText(id) {
    const m = cardMeta(id, { note: false });
    return `${m.tags.map(t => t.name).join('\n')}\n${m.creator}`;
}

const isFav = x => x?.fav === true || x?.fav === 'true';

/** Every character and group, so cards without any chat (a card just imported) are in the gallery too. */
export function galleryEntities() {
    const c = ctx();
    const out = [];
    for (const ch of c.characters || []) {
        if (!ch?.avatar) continue;
        out.push({ id: `character|${ch.avatar}`, type: 'character', entity: ch.avatar, name: String(ch.name ?? ''), fav: isFav(ch), added: addedAt(ch, c.timestampToMoment), tags: tagsOf(ch.avatar, ch).map(t => t.name) });
    }
    for (const g of c.groups || []) {
        if (g?.id == null) continue;
        const id = String(g.id);
        out.push({ id: `group|${id}`, type: 'group', entity: id, name: String(g.name ?? ''), fav: isFav(g), added: addedAt(g, c.timestampToMoment), tags: tagsOf(id, null).map(t => t.name) });
    }
    return out;
}

/** Which tags to show cards for (every one of them): SillyTavern's tags with how many cards have each. */
export async function pickTags() {
    const s = settings();
    const counts = tagCounts(galleryEntities());
    if (!counts.length) { toast.info('ยังไม่มีการ์ดไหนติดแท็ก'); return; }
    const chosen = new Set(s.galleryTags.filter(t => counts.some(x => x.name === t)));
    const colorOf = new Map((ctx().tags || []).map(t => [String(t.name), t]));
    const row = x => {
        const t = colorOf.get(x.name);
        const dot = t?.color ? `<span class="rv_tagdot" style="background:${esc(t.color)}"></span>` : '<i class="fa-solid fa-tag"></i>';
        return `<button class="cb_pick rv_tagpick${chosen.has(x.name) ? ' cb_on' : ''}" data-tag="${esc(x.name)}" aria-pressed="${chosen.has(x.name)}">${dot}<span class="rv_tagname">${esc(x.name)}</span><small>${x.count}</small><i class="fa-solid fa-check cb_tick"></i></button>`;
    };
    const res = await sheet({
        title: 'กรองตามแท็ก',
        body: `<p class="cb_note">แสดงเฉพาะการ์ดที่มี<b>ทุก</b>แท็กที่เลือก · ตัวเลขคือจำนวนการ์ด</p>
            ${counts.length > 8 ? '<input type="search" class="cb_input rv_tagq" placeholder="หาแท็ก" aria-label="หาแท็ก" autocomplete="off" spellcheck="false">' : ''}
            <div class="cb_picklist rv_taglist">${counts.map(row).join('')}</div>`,
        buttons: [
            { label: 'ล้าง', run: a => a.close([]) },
            { label: 'ใช้ตัวกรอง', primary: true, run: a => a.close([...chosen]) },
        ],
        onMount: a => {
            a.body.querySelector('.rv_taglist').addEventListener('click', e => {
                const b = e.target.closest('[data-tag]');
                if (!b) return;
                const t = b.dataset.tag;
                if (chosen.has(t)) chosen.delete(t); else chosen.add(t);
                b.classList.toggle('cb_on', chosen.has(t));
                b.setAttribute('aria-pressed', String(chosen.has(t)));
            });
            const input = a.body.querySelector('.rv_tagq');
            input?.addEventListener('input', () => {
                const q = input.value.trim().toLowerCase();
                for (const b of a.body.querySelectorAll('[data-tag]')) b.hidden = !!q && !b.dataset.tag.toLowerCase().includes(q);
            });
        },
    });
    if (res == null) return;
    s.galleryTags = res;
    saveSettings();
    ui.card = null;
    ui.animate = true;
    ui.render();
    ui.root?.querySelector('.cb_list')?.scrollTo?.(0, 0);
}

/** A new chat with this character or group, made by SillyTavern the way its own "Start new chat" does. */
export async function startNewChat(id) {
    const bar = id.indexOf('|');
    const type = id.slice(0, bar), entity = id.slice(bar + 1);
    if (isGenerating()) { toast.warn('กำลังสร้างข้อความอยู่ — รอให้เสร็จหรือกดหยุดก่อน'); return; }
    app.closeBrowser();
    try {
        const c = ctx();
        const s = await st();
        const had = data.chats.some(x => x.type === type && x.entity === entity);
        if (type === 'group') {
            const g = groupOf(entity);
            if (!g) throw new Error('ไม่พบกลุ่มนี้แล้ว');
            if (String(c.groupId) !== String(g.id)) {
                if (!s.openGroupById) throw new Error('SillyTavern รุ่นนี้เปิดกลุ่มจากที่นี่ไม่ได้');
                await s.openGroupById(g.id);
                if (String(ctx().groupId) !== String(g.id)) throw new Error('เปิดกลุ่มไม่ได้ตอนนี้ (กำลังบันทึกแชทอยู่?) ลองอีกครั้ง');
                if (!had) return; // opening a group without chats already started its first one
            }
        } else {
            const idx = charIndex(entity);
            if (idx < 0) throw new Error('ไม่พบตัวละครนี้แล้ว');
            if (String(c.characterId) !== String(idx) || c.groupId) {
                await c.selectCharacterById(idx);
                const now = ctx();
                if (String(now.characterId) !== String(idx) || now.groupId) throw new Error('เปลี่ยนตัวละครไม่ได้ตอนนี้ (กำลังบันทึกแชทอยู่?) ลองอีกครั้ง');
                if (!had) return; // SillyTavern started the first chat (with the greeting) as it opened the card
            }
        }
        if (typeof s.doNewChat === 'function') await s.doNewChat({ deleteCurrentChat: false });
        else await ctx().executeSlashCommandsWithOptions('/newchat');
    } catch (e) {
        console.error('[Reverie]', e);
        toast.err(`เริ่มแชทใหม่ไม่สำเร็จ: ${errText(e)}`);
    }
}

// ------------------------------------------------ hand-off to Bulk Manager

const hasSlash = name => { try { return !!ctx().SlashCommandParser?.commands?.[name]; } catch { return false; } };

/** Bulk Manager is installed: with its hand-off (selection carried over) or at least its /bulk command. */
export function bulkAvailable() {
    return typeof globalThis.BulkManager?.open === 'function' || hasSlash('bulk');
}

/** Open Bulk Manager on its characters tab with these cards selected. action is a hint (delete | backup | copy). */
export async function handOffToBulk(avatars, action) {
    const bm = globalThis.BulkManager;
    app.closeBrowser();
    try {
        if (typeof bm?.open === 'function') {
            await bm.open({ tab: 'characters', select: [...avatars], action });
            return true;
        }
        if (hasSlash('bulk')) {
            await ctx().executeSlashCommandsWithOptions('/bulk');
            toast.info('เปิด Bulk Manager แล้ว แต่รุ่นที่ติดตั้งอยู่ยังรับการ์ดที่เลือกจาก Reverie ไม่ได้ — เลือกการ์ดอีกครั้งในแผงนั้น (อัปเดต Bulk Manager แล้วจะส่งต่อให้เอง)', 'Reverie', { timeOut: 9000 });
            return true;
        }
        toast.warn('ไม่พบ Bulk Manager');
    } catch (e) {
        console.error('[Reverie]', e);
        toast.err(`เปิด Bulk Manager ไม่สำเร็จ: ${errText(e)}`);
    }
    return false;
}

// ------------------------------------------------ hand-off to Card Updater

/** Card Updater 1.6.0+ (with CardUpdater.open) is installed. */
export const cardUpdaterAvailable = () => typeof globalThis.CardUpdater?.open === 'function';

/**
 * Update this character from a file with Card Updater: its file picker, dialog and summary.
 * Call straight from the tap with nothing awaited before — iOS opens a file picker only inside a
 * user gesture, and CardUpdater.open() opens it at once. Reverie stays open on the card page and
 * reloads once the update is done.
 */
export function updateFromFile(avatar) {
    const cu = globalThis.CardUpdater;
    if (typeof cu?.open !== 'function') { toast.warn('ต้องใช้ Card Updater 1.6.0 ขึ้นไป'); return; }
    let run;
    try { run = cu.open({ avatar }); } catch (e) { run = Promise.reject(e); }
    Promise.resolve(run).then(r => {
        // 'failed' can still mean a partial update, so reload for anything but a cancel
        if (r?.status !== 'cancelled') app.reload?.();
    }, e => {
        console.error('[Reverie]', e);
        toast.err(`เปิด Card Updater ไม่สำเร็จ: ${errText(e)}`);
    });
}

export function openCard(id) {
    const list = ui.root?.querySelector('.cb_list');
    if (!list || !id) return;
    if (!ui.card) ui.gridTop = list.scrollTop;
    ui.card = id;
    ui.noteOpen = false;
    ui.render();
    list.scrollTop = 0;
    list.querySelector('.cb_card')?.classList.add('cb_enter');
    playCardPage();
}

export function closeCard() {
    const list = ui.root?.querySelector('.cb_list');
    if (!list || !ui.card) return;
    const from = ui.card;
    // stepping through cards may have gone past the grid's page: back on the page of the card shown last
    const size = settings().pageCards;
    const i = ui.cards.findIndex(x => x.id === from);
    const want = size && i >= 0 ? Math.floor(i / size) + 1 : ui.page;
    const moved = want !== ui.page;
    ui.page = want;
    ui.card = null;
    ui.render();
    list.scrollTop = moved ? 0 : ui.gridTop;
    const tile = list.querySelector(`.cb_tile[data-card="${CSS.escape(from)}"]`);
    if (tile) {
        if (moved) tile.scrollIntoView({ block: 'center' });
        tile.classList.add('cb_back_here');
        tile.focus({ preventScroll: true });
    }
}

/** Big covers or small ones; the card at the top of the screen stays at the top. */
export function setGallerySize(size) {
    const s = settings();
    if (s.gallerySize === size) return;
    const list = ui.root.querySelector('.cb_list');
    const top = list.getBoundingClientRect().top;
    const first = [...list.querySelectorAll('.cb_tile')].find(t => t.getBoundingClientRect().bottom > top + 8);
    const atTop = list.scrollTop < 40;
    s.gallerySize = size;
    saveSettings();
    ui.animate = atTop;
    ui.render();
    const again = first && list.querySelector(`.cb_tile[data-card="${CSS.escape(first.dataset.card)}"]`);
    if (atTop || !again) list.scrollTop = 0;
    else list.scrollTop += again.getBoundingClientRect().top - list.getBoundingClientRect().top - 8;
}

/** Next or previous card on the grid's order (buttons, arrow keys, swiping sideways). */
export function stepCard(d) {
    const i = ui.cards.findIndex(x => x.id === ui.card);
    const next = i < 0 ? null : ui.cards[i + d];
    if (!next) return;
    const list = ui.root.querySelector('.cb_list');
    ui.card = next.id;
    ui.noteOpen = false;
    ui.render();
    list.scrollTop = 0;
    list.querySelector('.cb_card')?.classList.add(d > 0 ? 'cb_from_r' : 'cb_from_l');
    playCardPage();
}

/** The cover full screen; any tap closes it. */
export function zoomCover(id) {
    const m = cardMeta(id);
    const urls = m.collage?.length ? m.collage.map(x => x.full) : [m.full];
    if (!urls[0]) return;
    const layer = ui.root.querySelector('.cb_layer');
    const el = document.createElement('div');
    el.className = 'cb_lightbox';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="cb_lbimgs" data-n="${urls.length}">${urls.map(u => `<img src="${esc(u)}" alt="">`).join('')}</div>
        <button class="cb_iconbtn cb_lbx" aria-label="ปิด"><i class="fa-solid fa-xmark"></i></button>`;
    const close = () => { el.classList.add('cb_out'); setTimeout(() => el.remove(), 160); };
    el._close = close;
    el.addEventListener('click', close);
    layer.append(el);
    requestAnimationFrame(() => el.classList.add('cb_in'));
}

/** Drawing of the gallery; index.js mixes these into ui (this = ui). */
export const galleryUi = {

    /**
     * A cover: the small thumbnail first (blurred), the picture over it once loaded.
     * In the grid both wait until the tile comes near the screen (watchCovers).
     */
    coverHtml(m, lazy = true) {
        const src = lazy ? 'data-src' : 'src';
        const img = (full, small) => `<img class="cb_thumb" ${src}="${esc(small)}" alt="" decoding="async"><img class="cb_full" ${src}="${esc(full)}" alt="" decoding="async">`;
        if (m.collage) {
            return `<div class="cb_tcollage" data-n="${m.collage.length}">${m.collage.map(x => `<div>${img(x.full, x.thumb)}</div>`).join('') || '<i class="fa-solid fa-users"></i>'}</div>`;
        }
        return img(m.full, m.thumb);
    },

    tileHtml(card, i) {
        const m = cardMeta(card.id, { note: false });
        const cur = currentKey();
        const isOpen = card.chats.some(c => c.key === cur);
        const sel = this.selecting && this.selCards.has(card.id);
        const sub = card.count ? `${card.count} แชท · ${esc(relTime(card.last))}` : '<span class="rv_nochat">ยังไม่มีแชท</span>';
        // only the first screenful fades in one by one; the rest are off screen anyway
        return `<div class="cb_tile${isOpen ? ' cb_isopen' : ''}${card.unread ? ' cb_unread' : ''}${sel ? ' cb_selected' : ''}${card.count ? '' : ' rv_fresh'}" data-card="${esc(card.id)}" role="button" tabindex="0"${i < 40 ? ` data-a style="--i:${i}"` : ''} aria-label="${esc(card.name)} · ${card.count ? `${card.count} แชท` : 'ยังไม่มีแชท'}">
            <div class="cb_cover">${this.coverHtml(m)}</div>
            <div class="cb_tiletop">
                ${this.selecting ? '<span class="rv_tcheck"><i class="fa-solid fa-check"></i></span>' : ''}
                ${m.fav ? '<span class="cb_tmark" title="ตัวละครโปรด"><i class="fa-solid fa-star"></i></span>' : ''}
                ${card.pinned ? '<span class="cb_tmark" title="มีแชทที่ปักหมุด"><i class="fa-solid fa-thumbtack"></i></span>' : ''}
                ${card.type === 'group' ? '<span class="cb_tmark" title="กลุ่ม"><i class="fa-solid fa-users"></i></span>' : ''}
                <span class="cb_tspace"></span>
                ${card.unread ? `<span class="cb_badge" title="ข้อความใหม่">+${card.unread > 999 ? '999' : card.unread}</span>` : ''}
            </div>
            <div class="cb_tileinfo">
                <b>${esc(card.name)}</b>
                <span>${isOpen ? '<em>เปิดอยู่</em> · ' : ''}${sub}</span>
            </div>
        </div>`;
    },

    cardHtml(card) {
        const m = cardMeta(card.id);
        const i = this.cards.findIndex(x => x.id === card.id);
        const prev = i > 0 ? this.cards[i - 1] : null;
        const next = i >= 0 && i < this.cards.length - 1 ? this.cards[i + 1] : null;
        const cur = currentKey();
        const isOpen = card.chats.some(c => c.key === cur);
        const step = (d, x) => `<button class="cb_iconbtn cb_step" data-step="${d}"${x ? ` title="${esc(x.name)}"` : ' disabled'} aria-label="${d < 0 ? 'การ์ดก่อนหน้า' : 'การ์ดถัดไป'}"><i class="fa-solid fa-chevron-${d < 0 ? 'left' : 'right'}"></i></button>`;
        const tagStyle = t => (t.color ? ` style="--tag-bg:${esc(t.color)};${t.color2 ? `--tag-fg:${esc(t.color2)};` : ''}"` : '');
        // back / position / prev-next sit under the header, outside the scrolling list
        this.root.querySelector('.cb_cardnav').innerHTML = `
                <button class="cb_back" data-back="1"><i class="fa-solid fa-chevron-left"></i><span>การ์ดทั้งหมด</span></button>
                <span class="cb_cardpos">${i >= 0 ? `${i + 1} / ${this.cards.length}` : ''}</span>
                ${step(-1, prev)}${step(1, next)}`;
        return `<div class="cb_card" data-cardpage="${esc(card.id)}">
            <div class="cb_hero">
                <img class="cb_herobg" src="${esc(m.thumb || m.collage?.[0]?.thumb || '')}" alt="" aria-hidden="true">
                <button class="cb_heroimg" data-zoom="1" title="ดูรูปเต็ม" aria-label="ดูรูปเต็ม">${this.coverHtml(m, false)}</button>
                <div class="cb_heroinfo">
                    <h3>${m.fav ? '<i class="fa-solid fa-star cb_favstar" title="ตัวละครโปรด"></i>' : ''}${esc(card.name)}</h3>
                    <div class="cb_herosub">
                        ${creditHtml(m.creator, { icon: 'fa-solid fa-feather-pointed', title: 'ผู้สร้างการ์ด' })}
                        ${creditHtml(m.version, { prefix: 'v', title: 'เวอร์ชันการ์ด', maxText: 16 })}
                        ${card.count ? `<span><i class="fa-regular fa-comments"></i>${card.count} แชท</span>
                        <span><i class="fa-regular fa-message"></i>${card.total.toLocaleString('th-TH')} ข้อความ</span>` : '<span class="rv_nochat"><i class="fa-regular fa-comments"></i>ยังไม่มีแชท</span>'}
                        ${card.last ? `<span title="${esc(fullTime(card.last))}"><i class="fa-regular fa-clock"></i>${esc(relTime(card.last))}</span>` : ''}
                    </div>
                    ${m.members?.length ? `<div class="cb_members">${m.members.map(x => `<span title="${esc(x.name)}"><img src="${esc(x.thumb)}" alt="" loading="lazy">${esc(x.name)}</span>`).join('')}</div>` : ''}
                    ${m.tags.length ? `<div class="cb_tags">${m.tags.map(t => `<button class="cb_tag" data-tag="${esc(t.name)}"${tagStyle(t)} title="ค้นหาการ์ดที่มีแท็กนี้">${esc(t.name)}</button>`).join('')}</div>` : ''}
                    <div class="rv_actions">
                        ${card.head ? `<button class="cb_btn cb_primary cb_continue" data-continue="${esc(card.head.key)}"><i class="fa-solid ${isOpen ? 'fa-eye' : 'fa-play'}"></i>${isOpen ? 'กลับไปที่แชท' : 'คุยต่อแชทล่าสุด'}</button>` : ''}
                        <button class="cb_btn${card.head ? '' : ' cb_primary'} rv_newchat" data-newchat="1"><i class="fa-solid fa-plus"></i>เริ่มแชทใหม่</button>
                        ${card.type === 'character' ? '<button class="cb_btn rv_edit" data-edit="1"><i class="fa-solid fa-pen-to-square"></i>แก้ไขการ์ด</button>' : ''}
                        ${card.type === 'character' && cardUpdaterAvailable() ? '<button class="cb_btn rv_cuupdate" data-cuupdate="1" title="เลือกไฟล์การ์ด, lorebook หรือ regex มาอัปเดตตัวละครนี้ (Card Updater)"><i class="fa-solid fa-file-arrow-up"></i>อัปเดตจากไฟล์</button>' : ''}
                    </div>
                </div>
            </div>
            ${m.note ? `<div class="cb_cnote${this.noteOpen ? ' cb_open' : ''}">
                <div class="cb_cnotehead"><i class="fa-solid fa-quote-left"></i>Creator's note</div>
                <div class="cb_cnotetext">${esc(m.note)}</div>
                <button class="cb_notemore" data-note="1"${this.noteOpen ? '' : ' hidden'}>${this.noteOpen ? 'ย่อ<i class="fa-solid fa-chevron-up"></i>' : 'อ่านต่อ<i class="fa-solid fa-chevron-down"></i>'}</button>
            </div>` : ''}
            <div class="cb_cardchats"><i class="fa-regular fa-comments"></i>แชทของการ์ดนี้<span>${card.count}</span></div>
            ${this.entries.length ? '' : '<div class="cb_empty"><i class="fa-regular fa-comments"></i><span>ยังไม่มีแชท<br><small>แตะ “เริ่มแชทใหม่” เพื่อคุยกับการ์ดนี้</small></span></div>'}
        </div>`;
    },

    /** Show "อ่านต่อ" only when the note is longer than its folded height. */
    fitNote() {
        const box = this.root?.querySelector('.cb_cnote');
        if (!box || this.noteOpen) return;
        requestAnimationFrame(() => {
            const text = box.querySelector('.cb_cnotetext');
            const more = box.querySelector('.cb_notemore');
            if (text && more) more.hidden = text.scrollHeight <= text.clientHeight + 2;
        });
    },

    /**
     * Pictures load only near the screen, a few at a time, scaled to the tile (coverQueue),
     * and are let go further away, so a long gallery stays light.
     */
    watchCovers() {
        const list = this.root.querySelector('.cb_list');
        this.imgObserver ??= new IntersectionObserver(es => {
            for (const x of es) {
                if (x.isIntersecting) {
                    for (const t of x.target.querySelectorAll('img.cb_thumb[data-src]:not([src])')) t.src = t.dataset.src;
                }
                for (const img of x.target.querySelectorAll('img.cb_full')) {
                    if (x.isIntersecting) showCover(img); else dropCover(img);
                }
            }
        }, { root: list, rootMargin: '400px 0px' });
        list.querySelectorAll('.cb_tile').forEach(t => this.imgObserver.observe(t));
    },
};
