/*
 * Reverie — gallery: a grid of character and group covers, and a page per card
 * (picture, creator, tags, creator's note and the card's chats).
 */

import { ctx, settings, saveSettings, esc, charOf, groupOf, thumb, currentKey, ui } from './core.js';
import { fullTime, noteText, relTime } from './lib.js';

// ---------------------------------------------------------------- gallery cards

const fullAvatar = file => `/characters/${encodeURIComponent(file)}`;

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
    if (hit) { img.src = hit; return; }
    if (!coverQueue.some(j => j.img === img)) coverQueue.push({ img, url, w, h });
    pumpCovers();
}

export function dropCover(img) {
    coverWanted.delete(img);
    const i = coverQueue.findIndex(j => j.img === img);
    if (i >= 0) coverQueue.splice(i, 1);
    if (img.hasAttribute('src')) { img.removeAttribute('src'); img.classList.remove('cb_loaded'); }
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

export function tagsOf(entity, ch) {
    const c = ctx();
    const own = (c.tagMap?.[entity] || []).map(id => (c.tags || []).find(t => t.id === id)).filter(t => t?.name);
    if (own.length) return own.map(t => ({ name: String(t.name), color: t.color || '', color2: t.color2 || '' }));
    // tags written in the card itself, when SillyTavern's own tags were not imported
    const raw = ch?.data?.tags ?? ch?.tags;
    return Array.isArray(raw) ? [...new Set(raw.map(String).map(x => x.trim()).filter(Boolean))].slice(0, 30).map(name => ({ name })) : [];
}

/** What the gallery shows of a character or group: pictures, tags, creator and creator's note. */
export function cardMeta(id) {
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
        note: noteText(d.creator_notes || ch?.creatorcomment || '', { char: ch?.name, user: ctx().name1 }),
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
    const m = cardMeta(id);
    return `${m.tags.map(t => t.name).join('\n')}\n${m.creator}`;
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
}

export function closeCard() {
    const list = ui.root?.querySelector('.cb_list');
    if (!list || !ui.card) return;
    const from = ui.card;
    ui.card = null;
    ui.render();
    list.scrollTop = ui.gridTop;
    const tile = list.querySelector(`.cb_tile[data-card="${CSS.escape(from)}"]`);
    if (tile) { tile.classList.add('cb_back_here'); tile.focus({ preventScroll: true }); }
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
        const m = cardMeta(card.id);
        const cur = currentKey();
        const isOpen = card.chats.some(c => c.key === cur);
        // only the first screenful fades in one by one; the rest are off screen anyway
        return `<div class="cb_tile${isOpen ? ' cb_isopen' : ''}${card.unread ? ' cb_unread' : ''}" data-card="${esc(card.id)}" role="button" tabindex="0"${i < 40 ? ` data-a style="--i:${i}"` : ''} aria-label="${esc(card.name)} · ${card.count} แชท">
            <div class="cb_cover">${this.coverHtml(m)}</div>
            <div class="cb_tiletop">
                ${m.fav ? '<span class="cb_tmark" title="ตัวละครโปรด"><i class="fa-solid fa-star"></i></span>' : ''}
                ${card.pinned ? '<span class="cb_tmark" title="มีแชทที่ปักหมุด"><i class="fa-solid fa-thumbtack"></i></span>' : ''}
                ${card.type === 'group' ? '<span class="cb_tmark" title="กลุ่ม"><i class="fa-solid fa-users"></i></span>' : ''}
                <span class="cb_tspace"></span>
                ${card.unread ? `<span class="cb_badge" title="ข้อความใหม่">+${card.unread > 999 ? '999' : card.unread}</span>` : ''}
            </div>
            <div class="cb_tileinfo">
                <b>${esc(card.name)}</b>
                <span>${isOpen ? '<em>เปิดอยู่</em> · ' : ''}${card.count} แชท · ${esc(relTime(card.last))}</span>
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
                        <span><i class="fa-regular fa-comments"></i>${card.count} แชท</span>
                        <span><i class="fa-regular fa-message"></i>${card.total.toLocaleString('th-TH')} ข้อความ</span>
                        ${card.last ? `<span title="${esc(fullTime(card.last))}"><i class="fa-regular fa-clock"></i>${esc(relTime(card.last))}</span>` : ''}
                    </div>
                    ${m.members?.length ? `<div class="cb_members">${m.members.map(x => `<span title="${esc(x.name)}"><img src="${esc(x.thumb)}" alt="" loading="lazy">${esc(x.name)}</span>`).join('')}</div>` : ''}
                    ${m.tags.length ? `<div class="cb_tags">${m.tags.map(t => `<button class="cb_tag" data-tag="${esc(t.name)}"${tagStyle(t)} title="ค้นหาการ์ดที่มีแท็กนี้">${esc(t.name)}</button>`).join('')}</div>` : ''}
                    <button class="cb_btn cb_primary cb_continue" data-continue="${esc(card.head.key)}"><i class="fa-solid ${isOpen ? 'fa-eye' : 'fa-play'}"></i>${isOpen ? 'กลับไปที่แชท' : 'คุยต่อแชทล่าสุด'}</button>
                </div>
            </div>
            ${m.note ? `<div class="cb_cnote${this.noteOpen ? ' cb_open' : ''}">
                <div class="cb_cnotehead"><i class="fa-solid fa-quote-left"></i>Creator's note</div>
                <div class="cb_cnotetext">${esc(m.note)}</div>
                <button class="cb_notemore" data-note="1"${this.noteOpen ? '' : ' hidden'}>${this.noteOpen ? 'ย่อ<i class="fa-solid fa-chevron-up"></i>' : 'อ่านต่อ<i class="fa-solid fa-chevron-down"></i>'}</button>
            </div>` : ''}
            <div class="cb_cardchats"><i class="fa-regular fa-comments"></i>แชทของการ์ดนี้<span>${card.count}</span></div>
            ${this.entries.length ? '' : '<div class="cb_empty"><i class="fa-regular fa-comments"></i><span>ไม่มีแชท</span></div>'}
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
