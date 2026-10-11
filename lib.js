/*
 * Chat Browser — pure helpers (no DOM, no SillyTavern), so they can be tested in Node.
 */

// ---------------------------------------------------------------- preview text
//
// The list shows only what a reader would read: narration and dialogue. Everything else
// that ends up in a message — <think> blocks, status panels, <details>, HTML widgets,
// code, tables, image links, OOC notes, macros — is removed, not just its tags.

// Formatting tags: drop the tag, keep the words inside.
const INLINE_TAGS = ['a', 'abbr', 'b', 'big', 'blockquote', 'br', 'center', 'cite', 'del', 'em', 'font', 'i', 'ins',
    'mark', 'p', 'q', 'ruby', 'rb', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'u', 'wbr'];
// Blocks that never hold the story, even when the whole message is wrapped in another tag.
const META_TAGS = ['think', 'thinking', 'thought', 'thoughts', 'reasoning', 'reason', 'analysis', 'scratchpad', 'plan',
    'details', 'summary', 'style', 'script', 'code', 'pre', 'table', 'svg', 'img', 'iframe', 'video', 'audio', 'button',
    'select', 'textarea', 'input', 'form', 'status', 'stats', 'stat', 'statusbar', 'status_bar', 'panel', 'dashboard',
    'info', 'infobox', 'hud', 'tracker', 'memo', 'note', 'notes', 'ooc', 'system', 'meta', 'options', 'choices', 'choice'];

const inlineAlt = INLINE_TAGS.join('|');
const BLOCK_RE = new RegExp(`<(?!(?:${inlineAlt})(?=[\\s/>]))([a-zA-Z][\\w:-]*)(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const META_BLOCK_RE = new RegExp(`<(${META_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
// An opening reasoning tag that never closes (a cut-off reply): everything after it is reasoning.
const OPEN_THINK_RE = /<(think|thinking|thought|reasoning|analysis)(?:\s[^>]*)?>(?![\s\S]*<\/\1\s*>)[\s\S]*$/i;
const HTML_TAGS = new Set(['div', 'section', 'article', 'aside', 'main', 'header', 'footer', 'nav', 'table', 'ul', 'ol', 'li', 'p', 'span', 'details', 'figure', 'form', 'html', 'body', 'center', 'font', 'blockquote']);
const ANY_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

function decodeEntities(t) {
    return t.replace(/&(nbsp|amp|lt|gt|quot|#39|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, e, dec, hex) => {
        if (dec) return String.fromCodePoint(Number(dec));
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        return { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e.toLowerCase()] ?? m;
    });
}

function dropRepeated(text, re) {
    let out = text;
    for (let i = 0; i < 25; i++) { // nested blocks
        const next = out.replace(re, '\n');
        if (next === out) break;
        out = next;
    }
    return out;
}

/** Lines that are not prose: tables, rules, headings, bracketed status lines, key: value stat rows. */
function isNoiseLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (/^\|.*\|$/.test(t) || (t.match(/\|/g) || []).length >= 2) return true;      // table / "HP 10 | MP 5 | …"
    if (/^([-*_=~]\s*){3,}$/.test(t)) return true;                                    // horizontal rule
    if (/^#{1,6}\s/.test(t)) return true;                                             // markdown heading
    if (/^\[[^\]]*\]$/.test(t) || /^【[^】]*】$/.test(t)) return true;                 // [Status: …]
    // Preset/regex markers that open a status line: §CLK§ …, ::HUD:: …, ¤STAT¤ …
    if (/^([^\p{L}\p{N}\s*_"'“”‘’()[\]])\1?[\p{L}\d_-]{2,24}\1\1?(?=\s|$)/u.test(t)) return true;
    if ((t.match(/\[[\p{Lu}\d_ ]{2,}\s*[:：][^\]]*\]/gu) || []).length >= 2) return true; // [DYNAMISM: 2] [TENSION: 1]
    if ((t.match(JSON_KEY_RE) || []).length >= 3) return true;                       // a piece of JSON: …","clock":"…","stats":
    if (isCodeLine(t)) return true;
    if (/^\(\(.*\)\)$/.test(t) || /^\(?\s*OOC\s*[:：]/i.test(t)) return true;          // ((ooc)) / OOC: …
    if (/^[^\s:：]{1,24}\s*[:：]\s*[\d.,/%+-]+\s*$/.test(t)) return true;              // "HP: 80/100"
    if (/^[\p{Extended_Pictographic}\s|·•:：\d/%.,+-]+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t)) return true; // emoji-only stat rows
    return false;
}

/** End of the JSON value opening at i (index after its closing bracket), or -1 if it never closes. */
function jsonEnd(t, i) {
    let depth = 0;
    for (let k = i; k < t.length; k++) {
        const ch = t[k];
        if (ch === '"') {
            for (k++; k < t.length && t[k] !== '"'; k++) if (t[k] === '\\') k++;
        } else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return k + 1; }
    }
    return -1;
}

const JSON_KEY_RE = /"[^"\n]{1,48}"\s*:/g;

/**
 * Game cards and trackers often write their state into the message as raw JSON
 * ({"clock":"…","stats":{…}}). Remove every object or array that carries keys —
 * also one cut off at the end of the message.
 */
function stripJson(t) {
    let out = '';
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if ((ch === '{' || ch === '[') && /^[{[]\s*["{[]/.test(t.slice(i, i + 12))) {
            const end = jsonEnd(t, i);
            const seg = t.slice(i, end < 0 ? t.length : end);
            if ((seg.match(JSON_KEY_RE) || []).length >= 2 || (end > 0 && /^\[\s*"/.test(seg) && (seg.match(/"/g) || []).length >= 6)) {
                out += ' ';
                i = (end < 0 ? t.length : end) - 1;
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/** Leftover script or regex source: symbol-heavy, or with tokens prose never has. */
function isCodeLine(t) {
    if (/\\[sSdDwWbn][*+?]?|\[\\s\\S\]|=>|\b(?:function|const|let|var)\s+[\w$]+\s*[=(]|\b(?:document|window|console)\.\w|\)\s*\{|[)}\]];\s*$/.test(t)) return true;
    const sym = (t.match(/[{}[\]()\\;=<>$|^]/g) || []).length;
    return t.length >= 8 && sym / t.length > 0.2;
}

function finish(text, keepLines) {
    let t = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|blockquote|li)\s*>/gi, '\n')
        .replace(ANY_TAG_RE, '');
    t = stripJson(decodeEntities(t));
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')                  // images
        .replace(/\[([^\]]+)\]\((?:https?:|\/)[^)]*\)/g, '$1')    // links → their text
        .replace(/\{\{[^}]*\}\}/g, ' ')                           // unresolved macros
        .replace(/\(\(\s*OOC[\s\S]*?\)\)/gi, ' ')
        .replace(/\(\s*OOC\s*[:：][^)]*\)/gi, ' ');
    t = t.split('\n').filter(l => !isNoiseLine(l)).join('\n');
    t = t.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')       // bold / strike
        .replace(/(^|[\s(“"'«])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,!?;:”"'»…—-])/gm, '$1$2') // *italic* / _italic_
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/^\s*>+\s?/gm, '')                               // quote markers
        .replace(/^\s*[-*+]\s+/gm, '')                            // bullet markers
        .replace(/[*_]{2,}/g, '')
        .replace(/(^|\s)\*(\s|$)/g, '$1$2');
    return keepLines
        ? t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
        : t.replace(/\s+/g, ' ').trim();
}

/**
 * Narration and dialogue of a message, nothing else.
 * keepLines: keep paragraph breaks (detail view).
 */
export function cleanPreview(text, { keepLines = false } = {}) {
    let src = String(text ?? '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?(?:```|$)/g, '\n');
    // Scripts and styles first, whole: their code often holds tag-like strings ('</div>')
    // that would end an outer block early and leave code behind.
    src = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '\n').replace(/<(script|style)\b[\s\S]*$/i, '\n');
    src = src.replace(OPEN_THINK_RE, '');
    const strict = finish(dropRepeated(src, BLOCK_RE), keepLines);
    if (strict) return strict;
    // The whole reply sits inside one custom tag (<response>…</response>): keep its words,
    // still without the blocks that are never story.
    // Only for a reply wrapped in a custom tag, or text long enough to read as story —
    // not the leftover labels of an HTML widget ("HP 3").
    const loose = finish(dropRepeated(src, META_BLOCK_RE), keepLines);
    const wrap = src.trim().match(/^<([a-zA-Z][\w:-]*)[^>]*>[\s\S]*<\/\1\s*>$/);
    const custom = wrap && !HTML_TAGS.has(wrap[1].toLowerCase());
    return custom || loose.length >= 30 ? loose : '';
}

/** First `max` characters, cut at a word or sentence end where possible. */
export function clip(text, max) {
    const t = String(text ?? '');
    if (t.length <= max) return t;
    let cut = t.slice(0, max);
    const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    if (at > max * 0.6) cut = cut.slice(0, at);
    return `${cut.trimEnd()}…`;
}

// ---------------------------------------------------------------- time

/** ms since epoch from anything SillyTavern stores as a date. */
export function toMs(v, parseMoment) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const s = String(v ?? '').trim();
    if (!s) return 0;
    if (/^\d{10,}$/.test(s)) return Number(s);
    // humanized: 2025-06-05@15h04m03s (optionally with ms)
    const h = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s/);
    if (h) return new Date(+h[1], +h[2] - 1, +h[3], +h[4], +h[5], +h[6]).getTime();
    if (parseMoment) {
        try { const m = parseMoment(s); const n = m?.valueOf?.(); if (Number.isFinite(n) && n > 0) return n; } catch { /* fall through */ }
    }
    const p = Date.parse(s.replace(/(\d)(am|pm)$/i, '$1 $2'));
    return Number.isFinite(p) ? p : 0;
}

const TH_SHORT = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });
const TH_YEAR = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
const TH_FULL = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

/** "เมื่อกี้", "5 นาที", "3 ชม.", "เมื่อวาน", "4 วัน", "5 มิ.ย.", "5 มิ.ย. 67" */
export function relTime(ms, now = Date.now()) {
    if (!ms) return '';
    const d = now - ms;
    if (d < 60_000) return 'เมื่อกี้';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} นาที`;
    const a = new Date(ms), b = new Date(now);
    const dayStart = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((dayStart(b) - dayStart(a)) / 86_400_000);
    if (days === 0) return `${Math.floor(d / 3_600_000)} ชม.`;
    if (days === 1) return 'เมื่อวาน';
    if (days < 7) return `${days} วัน`;
    return a.getFullYear() === b.getFullYear() ? TH_SHORT.format(a) : TH_YEAR.format(a);
}

export const fullTime = ms => (ms ? TH_FULL.format(new Date(ms)) : '');

// ---------------------------------------------------------------- stories
//
// Chats that continue one story: Memory Hub's "continue in a new chat" writes the earlier
// chats into chat_metadata.memory_hub.chain; Chat Browser's own "continues …" link is
// chat_metadata.chat_browser.prev. Linked chats of the same character/group form a story;
// a chat's part number counts the chats before it (deleted ones too, so gaps show).
// SillyTavern branches (chat_metadata.main_chat) are shown as branches, not parts.

/**
 * chats: [{ key, type, entity, chatId, chain: string[], prev, last }]
 * Returns Map key → { story: id, part: 1-based, parts: [chat…] (in order), size }
 */
export function linkStories(chats) {
    const idx = new Map();
    for (const c of chats) idx.set(`${c.type}|${c.entity}|${c.chatId}`, c);
    const find = (c, id) => idx.get(`${c.type}|${c.entity}|${id}`);

    const up = new Map(chats.map(c => [c.key, c.key]));
    const root = k => { while (up.get(k) !== k) { up.set(k, up.get(up.get(k))); k = up.get(k); } return k; };
    const join = (a, b) => { const x = root(a), y = root(b); if (x !== y) up.set(x, y); };
    for (const c of chats) {
        for (const id of [...(c.chain || []), c.prev].filter(Boolean)) {
            const p = find(c, id);
            if (p && p !== c) join(c.key, p.key);
        }
    }

    const depth = new Map();
    const depthOf = (c, seen = new Set()) => {
        if (depth.has(c.key)) return depth.get(c.key);
        if (seen.has(c.key)) return 0; // a loop in hand-made links
        seen.add(c.key);
        let d = Array.isArray(c.chain) ? c.chain.length : 0;
        const p = c.prev && find(c, c.prev);
        if (p && p !== c) d = Math.max(d, depthOf(p, seen) + 1);
        else if (c.prev && !p) d = Math.max(d, 1);
        depth.set(c.key, d);
        return d;
    };

    const groups = new Map();
    for (const c of chats) {
        const r = root(c.key);
        (groups.get(r) ?? groups.set(r, []).get(r)).push(c);
    }
    const out = new Map();
    for (const [r, list] of groups) {
        const parts = [...list].sort((a, b) => depthOf(a) - depthOf(b) || (a.last || 0) - (b.last || 0));
        for (const c of parts) out.set(c.key, { story: r, part: depthOf(c) + 1, parts, size: parts.length });
    }
    return out;
}

// ---------------------------------------------------------------- list building

const collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });
export const compareText = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

/** Lower-cased haystack for search. */
export function searchText(c) {
    return `${c.chatId}\n${c.entityName}\n${c.personaName ?? ''}\n${c.preview ?? ''}`.toLowerCase();
}

/**
 * Turn chats into list entries.
 *   merge: one entry per story (its newest part), older parts listed under it
 *   sort:  recent | character | name | size
 * Returns [{ kind: 'section', … } | { kind: 'chat', chat, story?: { parts, total, unread } }]
 */
export function buildEntries(chats, { sort = 'recent', merge = true, query = '', filter = 'all', entity = null, persona = null, pins = {}, unreadOf = () => 0 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const stories = linkStories(chats);
    const pinned = c => !!pins[c.key];

    // Search and filters apply to any part of a story, so a story shows if one part matches.
    const keep = c => {
        if (entity && `${c.type}|${c.entity}` !== entity) return false;
        if (persona && c.persona !== persona) return false;
        if (filter === 'group' && c.type !== 'group') return false;
        if (q && !q.split(/\s+/).every(w => searchText(c).includes(w))) return false;
        return true;
    };

    let units = [];
    if (merge) {
        const seen = new Set();
        for (const c of chats) {
            const s = stories.get(c.key);
            if (s.size < 2) { units.push({ head: c, parts: [c] }); continue; }
            if (seen.has(s.story)) continue;
            seen.add(s.story);
            const head = s.parts.reduce((a, b) => ((b.last || 0) > (a.last || 0) ? b : a));
            units.push({ head, parts: s.parts });
        }
    } else {
        units = chats.map(c => ({ head: c, parts: [c] }));
    }
    units = units.filter(u => u.parts.some(keep));
    for (const u of units) {
        u.unread = u.parts.reduce((n, c) => n + unreadOf(c), 0);
        u.pinned = u.parts.some(pinned);
        u.last = Math.max(...u.parts.map(c => c.last || 0));
        u.total = u.parts.reduce((n, c) => n + (c.count || 0), 0);
    }
    if (filter === 'unread') units = units.filter(u => u.unread > 0);
    if (filter === 'pinned') units = units.filter(u => u.pinned);

    const byRecent = (a, b) => b.last - a.last;
    const cmp = {
        recent: byRecent,
        name: (a, b) => compareText(a.head.chatId, b.head.chatId) || byRecent(a, b),
        size: (a, b) => b.total - a.total || byRecent(a, b),
        character: byRecent,
    }[sort] ?? byRecent;

    const entry = u => ({
        kind: 'chat',
        chat: u.head,
        part: stories.get(u.head.key),
        story: u.parts.length > 1 ? { parts: u.parts, total: u.total, unread: u.unread } : null,
        unread: u.unread,
        pinned: u.pinned,
    });

    const out = [];
    const pinnedUnits = sort === 'character' || filter === 'pinned' ? [] : units.filter(u => u.pinned).sort(cmp);
    if (pinnedUnits.length) {
        out.push({ kind: 'section', id: 'pinned', title: 'ปักหมุด', count: pinnedUnits.length });
        out.push(...pinnedUnits.map(entry));
    }
    const rest = units.filter(u => !pinnedUnits.includes(u)).sort(cmp);
    if (sort === 'character') {
        const groups = new Map();
        for (const u of rest) {
            const k = `${u.head.type}|${u.head.entity}`;
            (groups.get(k) ?? groups.set(k, []).get(k)).push(u);
        }
        const ordered = [...groups.entries()].sort((a, b) => b[1][0].last - a[1][0].last);
        for (const [k, list] of ordered) {
            const h = list[0].head;
            out.push({ kind: 'section', id: k, title: h.entityName, entity: k, head: h, count: list.length, unread: list.reduce((n, u) => n + u.unread, 0) });
            // pinned first inside each character
            out.push(...[...list].sort((a, b) => (b.pinned - a.pinned) || cmp(a, b)).map(entry));
        }
    } else {
        if (pinnedUnits.length && rest.length) out.push({ kind: 'section', id: 'all', title: sort === 'recent' ? 'ล่าสุด' : sort === 'name' ? 'ชื่อแชท ก–ฮ' : 'ยาวที่สุด', count: rest.length });
        out.push(...rest.map(entry));
    }
    return out;
}

/** Replace a chat id inside the link fields of a chat's metadata. Returns true when something changed. */
export function renameInMeta(meta, oldId, newId) {
    if (!meta || typeof meta !== 'object') return false;
    let changed = false;
    const mh = meta.memory_hub;
    if (mh && Array.isArray(mh.chain) && mh.chain.includes(oldId)) {
        mh.chain = mh.chain.map(x => (x === oldId ? newId : x));
        changed = true;
    }
    if (mh && Array.isArray(mh.memories)) {
        for (const m of mh.memories) if (m?.origin?.chat === oldId) { m.origin.chat = newId; changed = true; }
    }
    if (meta.chat_browser?.prev === oldId) { meta.chat_browser.prev = newId; changed = true; }
    if (meta.main_chat === oldId) { meta.main_chat = newId; changed = true; }
    return changed;
}
