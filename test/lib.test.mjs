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
