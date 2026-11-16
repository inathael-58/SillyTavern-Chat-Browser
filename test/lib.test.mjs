import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPreview, clip, toMs, relTime, linkStories, buildEntries, renameInMeta } from '../lib.js';

test('removes reasoning, panels and tags, keeps narration and dialogue', () => {
    const msg = `<think>plan the reply</think>
*เธอยิ้มบาง ๆ แล้วเดินเข้ามาใกล้* "วันนี้เหนื่อยไหม?"
<status>
HP: 80/100 | MP: 20/50
</status>
<details><summary>Inventory</summary>sword</details>
<div class="panel"><b>Affection</b> 45</div>
**ฝนเริ่มตก**`;
    assert.equal(cleanPreview(msg), 'เธอยิ้มบาง ๆ แล้วเดินเข้ามาใกล้ "วันนี้เหนื่อยไหม?" ฝนเริ่มตก');
});

test('unclosed reasoning is dropped to the end', () => {
    assert.equal(cleanPreview('Hello there. <thinking>and then I should'), 'Hello there.');
});

test('whole reply wrapped in a custom tag keeps its words but not meta blocks', () => {
    assert.equal(cleanPreview('<response><think>x</think>She waves. "Hi!"</response>'), 'She waves. "Hi!"');
});

test('status lines, tables, images, macros, code and OOC go away', () => {
    const msg = `[Location: Bangkok | 21:00]
| a | b |
|---|---|
![img](https://x/y.png)
\`\`\`
code
\`\`\`
{{char}} smiles.
(OOC: keep it short)
Real line.`;
    assert.equal(cleanPreview(msg), 'smiles. Real line.');
});

test('preset marker lines (§CLK§, [KEY: n] rows) go away', () => {
    const msg = `§CLK§ ⏳ วันอังคาร · 20 ตุลาคม 2026 · 18:40 · พลบค่ำ · ⏳—
§STG§ 📍 สถานีตำรวจ ♪ เสียงโทรศัพท์ดังระงม · แอร์เย็นเฉียบ
§TIER§ [DYNAMISM: 2] [TENSION: 1] [INTIMACY: 1] → LOCKED: [NARRATIVE]
::HUD:: HP 20
บานประตูกระจกอัตโนมัติเลื่อนเปิด "มาแล้วเหรอ"`;
    assert.equal(cleanPreview(msg), 'บานประตูกระจกอัตโนมัติเลื่อนเปิด "มาแล้วเหรอ"');
    // ordinary lines that merely start with punctuation stay
    assert.equal(cleanPreview('"Hello," she said.\n*She waves.*\n— Then silence.'), '"Hello," she said. She waves. — Then silence.');
});

test('raw JSON state (whole, cut off, or a fragment) goes away', () => {
    const state = '{"turn":4,"clock":"เหลือ 5 ชม.","stats":{"CHASSIS":1,"VECTOR":0},"slots":[{"id":"HOLM","state":"ok"},null],"vault":[]}';
    assert.equal(cleanPreview(`เสียงไซเรนดังขึ้นไกล ๆ "ไปกันเถอะ"\n${state}`), 'เสียงไซเรนดังขึ้นไกล ๆ "ไปกันเถอะ"');
    assert.equal(cleanPreview(`ฝนตก ${state.slice(0, 60)}`), 'ฝนตก');
    assert.equal(cleanPreview('…","clock":"เหลือ 5 ชม.","stats":{"CHASSIS":1},"hull":[5,6],"drift":[0,6]\nเรือแล่นต่อไป'), 'เรือแล่นต่อไป');
    assert.equal(cleanPreview('&#123;&quot;a&quot;:1,&quot;b&quot;:2&#125; ok'), 'ok');
    // prose with braces or a quoted word followed by a colon stays
    assert.equal(cleanPreview('She wrote {soon} and said "Wait": then left.'), 'She wrote {soon} and said "Wait": then left.');
    assert.equal(cleanPreview('["Hello"] she whispered.'), '["Hello"] she whispered.');
});

test('widget code from a card regex leaves nothing behind', () => {
    const widget = `<div class="salvage"><script>
const m = text.match(/salvage_save\s*({[\s\S]*?})\s*[\s\S]*?(<\/div>)/);
let html = '<div class="row">' + "…ใช้สัญญาณลวงล่อให้พวกมันหันไปทางอื่นก่อน" + '</div>';
document.querySelector('.salvage').innerHTML = html;
</script><b>HULL</b> 5/6</div>`;
    assert.equal(cleanPreview(`ลมพัดผ่านซากเรือ "ระวังข้างหลัง!"\n${widget}`), 'ลมพัดผ่านซากเรือ "ระวังข้างหลัง!"');
    assert.equal(cleanPreview('<style>.a{color:red}</style>ok'), 'ok');
    // leftovers outside any tag
    assert.equal(cleanPreview('เรือแล่นต่อไป\nsalvage_save\\s*({[\\s\\S]*?})\\s*\n[\\s\\S]*?('), 'เรือแล่นต่อไป');
    // ordinary prose survives
    for (const line of ['*She smiles* *and nods* softly.', 'Let me see (just once) — fine.', 'He whispered: "return to me".', '“อย่าไป!” (เธอตะโกน) แล้ววิ่งตาม', 'Price: 5 coins; take it or leave it.']) {
        assert.equal(cleanPreview(line).length > 10, true, line);
    }
});

test('one stray marker never wipes the rest of the message', () => {
    const story = 'คันเร่งหลักถูกดันจมมิดร่อง คอนโซลส่งเสียงหวีดแหลมยาว';
    assert.equal(cleanPreview('```html\n<div>x</div>\n' + story), story);                       // fence never closed
    assert.equal(cleanPreview('<script src="a.js">\n' + story), story);                           // script never closed
    assert.equal(cleanPreview('{"turn":4,"clock":"x\n' + story), story);                         // JSON never closed
    assert.equal(cleanPreview(story.replace(' ', '\\n')), story);                 // literal \n line breaks
    // the whole reply inside an HTML wrapper with the state inside too
    assert.equal(cleanPreview(`<div class="salvage">${story}<details><summary>s</summary>x</details><salvage_save>{"a":1,"b":2}</salvage_save></div>`), story);
    // …or inside a meta-looking wrapper
    assert.equal(cleanPreview(`<panel>${story}\n{"a":1,"b":2}</panel>`), story);
});

test('a game reply: roll, narration, inner chatter, fenced status JSON', () => {
    const msg = '<roll>2+4 = 6, +1 (STAT 1) = 7</roll>\n\nThe throttle slams forward and the console shrieks.\n\n*crack — boom!*\n\n"Pillar\'s down," she says.\n\n<Blocks>\n<NPC_Inner_Chatter>\nNoel: "Too slow."\n</NPC_Inner_Chatter>\n</Blocks>\n```status_ui\n{"copilot":"Noel","clock":"5h","stats":{"A":1,"B":0},"hull":[5,6],"log":["HULL 6→5"]}\n```';
    assert.equal(cleanPreview(msg), 'The throttle slams forward and the console shrieks. crack — boom! "Pillar\'s down," she says.');
});

test('keepLines keeps paragraphs', () => {
    assert.equal(cleanPreview('<p>One.</p><p>Two.</p>', { keepLines: true }), 'One.\nTwo.');
});

test('clip cuts at a word', () => {
    assert.equal(clip('one two three four five', 15), 'one two three…');
});

test('toMs reads humanized dates and numbers', () => {
    assert.equal(toMs('2025-06-05@15h04m03s'), new Date(2025, 5, 5, 15, 4, 3).getTime());
    assert.equal(toMs(123456789012), 123456789012);
    assert.ok(toMs('2025-06-05T10:00:00.000Z') > 0);
});

test('relTime', () => {
    const now = new Date(2026, 9, 11, 12, 0).getTime();
    assert.equal(relTime(now - 30_000, now), 'เมื่อกี้');
    assert.equal(relTime(now - 5 * 60_000, now), '5 นาที');
    assert.equal(relTime(now - 3 * 3_600_000, now), '3 ชม.');
    assert.equal(relTime(new Date(2026, 9, 10, 23, 0).getTime(), now), 'เมื่อวาน');
});

const mk = (chatId, extra = {}) => ({ key: `c:a.png:${chatId}`, type: 'character', entity: 'a.png', entityName: 'A', chatId, chain: [], last: 0, count: 10, ...extra });

test('stories from Memory Hub chains and manual links', () => {
    const chats = [
        mk('p1', { last: 1 }),
        mk('p2', { chain: ['p1'], last: 2 }),
        mk('p3', { chain: ['p1', 'p2'], last: 3 }),
        mk('side', { prev: 'p3', last: 4 }),
        mk('alone', { last: 5 }),
        mk('gap', { chain: ['deleted1', 'deleted2'], last: 6 }),
    ];
    const s = linkStories(chats);
    assert.equal(s.get('c:a.png:p1').part, 1);
    assert.equal(s.get('c:a.png:p3').part, 3);
    assert.equal(s.get('c:a.png:side').part, 4);
    assert.equal(s.get('c:a.png:p1').size, 4);
    assert.equal(s.get('c:a.png:alone').size, 1);
    assert.equal(s.get('c:a.png:gap').part, 3);
});

test('buildEntries merges stories, pins first, filters unread', () => {
    const chats = [mk('p1', { last: 1 }), mk('p2', { chain: ['p1'], last: 5 }), mk('x', { last: 3 })];
    const e = buildEntries(chats, { pins: { 'c:a.png:x': 1 } });
    assert.deepEqual(e.map(x => x.kind === 'section' ? `#${x.id}` : x.chat.chatId), ['#pinned', 'x', '#all', 'p2']);
    assert.equal(e[3].story.parts.length, 2);
    const u = buildEntries(chats, { filter: 'unread', unreadOf: c => (c.chatId === 'p1' ? 2 : 0) });
    assert.deepEqual(u.filter(x => x.kind === 'chat').map(x => x.chat.chatId), ['p2']);
    assert.equal(u[0].unread, 2);
    const flat = buildEntries(chats, { merge: false, query: 'p' });
    assert.deepEqual(flat.map(x => x.chat.chatId), ['p2', 'p1']);
});

test('renameInMeta updates every link', () => {
    const meta = { memory_hub: { chain: ['a', 'b'], memories: [{ origin: { chat: 'b' } }] }, chat_browser: { prev: 'b' }, main_chat: 'b' };
    assert.ok(renameInMeta(meta, 'b', 'c'));
    assert.deepEqual(meta.memory_hub.chain, ['a', 'c']);
    assert.equal(meta.memory_hub.memories[0].origin.chat, 'c');
    assert.equal(meta.chat_browser.prev, 'c');
    assert.equal(meta.main_chat, 'c');
    assert.ok(!renameInMeta(meta, 'zzz', 'y'));
});

test('buildCards groups chats per character, filters and searches tags', async () => {
    const { buildCards } = await import('../lib.js');
    const chats = [
        { key: 'c:a.png:1', type: 'character', entity: 'a.png', entityName: 'Alice', chatId: '1', count: 10, last: 100 },
        { key: 'c:a.png:2', type: 'character', entity: 'a.png', entityName: 'Alice', chatId: '2', count: 5, last: 300 },
        { key: 'c:b.png:3', type: 'character', entity: 'b.png', entityName: 'Bob', chatId: '3', count: 50, last: 200, persona: 'p.png' },
        { key: 'g:7:4', type: 'group', entity: '7', entityName: 'Party', chatId: '4', count: 1, last: 50 },
    ];
    const recent = buildCards(chats);
    assert.deepEqual(recent.map(x => x.name), ['Alice', 'Bob', 'Party']);
    assert.equal(recent[0].count, 2);
    assert.equal(recent[0].total, 15);
    assert.equal(recent[0].head.chatId, '2');
    assert.deepEqual(buildCards(chats, { sort: 'size' }).map(x => x.name), ['Bob', 'Alice', 'Party']);
    assert.deepEqual(buildCards(chats, { filter: 'group' }).map(x => x.name), ['Party']);
    assert.deepEqual(buildCards(chats, { persona: 'p.png' }).map(x => x.name), ['Bob']);
    assert.deepEqual(buildCards(chats, { pins: { 'c:a.png:1': 1 }, filter: 'pinned' }).map(x => x.name), ['Alice']);
    assert.deepEqual(buildCards(chats, { unreadOf: c => (c.chatId === '3' ? 2 : 0), filter: 'unread' }).map(x => x.name), ['Bob']);
    assert.deepEqual(buildCards(chats, { query: 'fantasy', extraText: id => (id === 'b.png' || id === 'character|b.png' ? 'Fantasy Knight' : '') }).map(x => x.name), ['Bob']);
});

test('noteText turns creator notes into plain paragraphs', async () => {
    const { noteText } = await import('../lib.js');
    const note = '<style>.x{color:red}</style><div><b>Hello</b> {{user}}!</div><p>I am {{char}} &amp; friends.</p>![pic](https://x/y.png)<ul><li>one</li><li>two</li></ul>';
    assert.equal(noteText(note, { char: 'Mia', user: 'Kit' }), 'Hello Kit!\nI am Mia & friends.\n• one\n• two');
});

test('fileName strips characters no file system allows', async () => {
    const { fileName } = await import('../lib.js');
    assert.equal(fileName('A: b/c?', 'txt'), 'A_ b_c_.txt');
    assert.equal(fileName('', 'jsonl'), 'chat.jsonl');
});

test('buildCards includes cards without chats, filters by tags and favourites, sorts by date added', async () => {
    const { buildCards } = await import('../lib.js');
    const chats = [
        { key: 'c:a.png:1', type: 'character', entity: 'a.png', entityName: 'Alice', chatId: '1', count: 10, last: 500 },
    ];
    const entities = [
        { id: 'character|a.png', type: 'character', entity: 'a.png', name: 'Alice', fav: true, added: 100, tags: ['Fantasy', 'Romance'] },
        { id: 'character|n.png', type: 'character', entity: 'n.png', name: 'New', fav: false, added: 900, tags: ['fantasy'] },
        { id: 'character|o.png', type: 'character', entity: 'o.png', name: 'Old', fav: false, added: 50, tags: [] },
        { id: 'group|g1', type: 'group', entity: 'g1', name: 'Party', fav: true, added: 300, tags: [] },
    ];
    const all = buildCards(chats, { entities });
    assert.deepEqual(all.map(x => x.name), ['New', 'Alice', 'Party', 'Old']); // recent: last chat, else date added
    const fresh = all.find(x => x.name === 'New');
    assert.equal(fresh.count, 0);
    assert.equal(fresh.head, null);
    assert.equal(all.find(x => x.name === 'Alice').head.chatId, '1');
    assert.deepEqual(buildCards(chats, { entities, sort: 'added' }).map(x => x.name), ['New', 'Party', 'Alice', 'Old']);
    assert.deepEqual(buildCards(chats, { entities, fav: true }).map(x => x.name), ['Alice', 'Party']);
    assert.deepEqual(buildCards(chats, { entities, tags: ['fantasy'] }).map(x => x.name), ['New', 'Alice']);
    assert.deepEqual(buildCards(chats, { entities, tags: ['fantasy', 'romance'] }).map(x => x.name), ['Alice']);
    assert.deepEqual(buildCards(chats, { entities, filter: 'group' }).map(x => x.name), ['Party']);
    assert.deepEqual(buildCards(chats, { entities, filter: 'unread' }).map(x => x.name), []);
    assert.deepEqual(buildCards(chats, { entities, entity: 'character|o.png' }).map(x => x.name), ['Old']);
    assert.deepEqual(buildCards(chats, { entities, query: 'new' }).map(x => x.name), ['New']);
});

test('tagCounts and addedAt', async () => {
    const { tagCounts, addedAt } = await import('../lib.js');
    assert.deepEqual(tagCounts([{ tags: ['b', 'a'] }, { tags: ['a', 'a'] }, { tags: [] }]), [{ name: 'a', count: 2 }, { name: 'b', count: 1 }]);
    assert.equal(addedAt({ create_date: '2024-01-02T03:04:05.000Z' }), Date.parse('2024-01-02T03:04:05.000Z'));
    assert.equal(addedAt({ create_date: '2023-5-12 @21h 32m 29s 224ms' }), new Date(2023, 4, 12, 21, 32, 29).getTime());
    assert.equal(addedAt({ date_added: 1234 }), 1234);
    assert.equal(addedAt({}), 0);
});

const sampleChar = () => ({
    name: 'Mia', avatar: 'mia.png', description: 'top desc', personality: '', scenario: 'park', first_mes: 'Hi', mes_example: '',
    creatorcomment: 'old note', tags: ['x'],
    data: {
        name: 'Mia', description: 'data desc', personality: 'shy', scenario: 'park', first_mes: 'Hi', mes_example: '',
        creator_notes: 'note', system_prompt: 'sys', post_history_instructions: '', alternate_greetings: ['A', 'B'],
        creator: 'Kit', character_version: '2', tags: ['fantasy', ' cute '],
        extensions: { talkativeness: 0.5, world: 'Lore', depth_prompt: { prompt: 'remember', depth: 2, role: 'user' } },
    },
});

test('readCard reads v1 first for the classic fields and data for the rest', async () => {
    const { readCard } = await import('../lib.js');
    const v = readCard(sampleChar());
    assert.equal(v.description, 'top desc');
    assert.equal(v.personality, 'shy');              // empty at the top level → data
    assert.equal(v.creator_notes, 'old note');       // creatorcomment is the v1 name
    assert.deepEqual(v.alternate_greetings, ['A', 'B']);
    assert.deepEqual(v.tags, ['fantasy', 'cute']);
    assert.deepEqual(v.depth_prompt, { prompt: 'remember', depth: 2, role: 'user' });
    const bare = readCard({ name: 'X', data: {} });
    assert.deepEqual(bare.depth_prompt, { prompt: '', depth: 4, role: 'system' });
    assert.deepEqual(bare.alternate_greetings, []);
    assert.equal(bare.system_prompt, '');
});

test('diffCard, cardPatch and applyCard write only what changed, in v1 and v2', async () => {
    const { readCard, diffCard, cardPatch, applyCard } = await import('../lib.js');
    const ch = sampleChar();
    const before = readCard(ch);
    const after = { ...before, description: 'new desc', alternate_greetings: ['B', 'A', 'C'], depth_prompt: { ...before.depth_prompt, depth: 6 }, creator_notes: 'fresh' };
    const keys = diffCard(before, after);
    assert.deepEqual(keys, ['description', 'alternate_greetings', 'creator_notes', 'depth_prompt']);
    const p = cardPatch('mia.png', after, keys);
    assert.deepEqual(p, {
        avatar: 'mia.png',
        description: 'new desc',
        creatorcomment: 'fresh',
        data: {
            description: 'new desc',
            alternate_greetings: ['B', 'A', 'C'],
            creator_notes: 'fresh',
            extensions: { depth_prompt: { prompt: 'remember', depth: 6, role: 'user' } },
        },
    });
    assert.deepEqual(diffCard(before, readCard(ch)), []);
    applyCard(ch, after, keys);
    assert.equal(ch.description, 'new desc');
    assert.equal(ch.data.description, 'new desc');
    assert.equal(ch.data.extensions.world, 'Lore');  // untouched
    assert.equal(ch.data.extensions.depth_prompt.depth, 6);
    assert.deepEqual(ch.data.alternate_greetings, ['B', 'A', 'C']);
    assert.deepEqual(diffCard(after, readCard(ch)), []);
    const tagsPatch = cardPatch('mia.png', { tags: [' a ', '', 'b'] }, ['tags']);
    assert.deepEqual(tagsPatch, { avatar: 'mia.png', tags: ['a', 'b'], data: { tags: ['a', 'b'] } });
});

test('moveItem and parseTags', async () => {
    const { moveItem, parseTags } = await import('../lib.js');
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 9), ['a', 'c', 'b']);
    assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
    assert.deepEqual(parseTags('a, b ,, A\nc'), ['a', 'b', 'c']);
});
