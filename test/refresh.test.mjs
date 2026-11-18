import test from 'node:test';
import assert from 'node:assert/strict';
import { chatSig, windowSettled, mergeChats } from '../lib.js';

const row = (n, over = {}) => ({ key: `c:a.png:chat${n}`, count: 10, last: 1000 + n, size: '1 KB', persona: null, memories: 0, chain: [], prev: null, mainChat: null, preview: 'p', ...over });

test('the signature changes with what the list shows, not with the preview', () => {
    assert.equal(chatSig(row(1)), chatSig(row(1, { preview: 'other' })));
    for (const change of [{ count: 11 }, { last: 5 }, { size: '2 KB' }, { persona: 'x.png' }, { memories: 3 }, { chain: ['a'] }, { prev: 'p' }, { mainChat: 'm' }]) {
        assert.notEqual(chatSig(row(1)), chatSig(row(1, change)), JSON.stringify(change));
    }
});

test('a window shorter than asked is every chat', () => {
    assert.equal(windowSettled([row(1), row(2)], new Map(), 40), 'complete');
});

test('settled once the oldest rows in the window are unchanged', () => {
    const cached = Array.from({ length: 40 }, (_, i) => row(i));
    const byKey = new Map(cached.map(c => [c.key, c]));
    const fresh = cached.map((c, i) => (i < 3 ? { ...c, count: 99 } : c)); // three chats got messages
    assert.equal(windowSettled(fresh, byKey, 40), 'settled');
});

test('more when even the oldest rows changed or are new', () => {
    const cached = Array.from({ length: 40 }, (_, i) => row(i));
    const byKey = new Map(cached.map(c => [c.key, c]));
    const changed = cached.map(c => ({ ...c, count: 99 }));
    assert.equal(windowSettled(changed, byKey, 40), 'more');
    const fresh = [...cached.slice(0, 39), row(500)]; // a chat the cache never saw
    assert.equal(windowSettled(fresh, byKey, 40), 'more');
});

test('merge puts the fresh rows in and keeps the rest', () => {
    const cached = [row(1), row(2), row(3)];
    const merged = mergeChats(cached, [row(2, { count: 50 }), row(9)]);
    assert.deepEqual(merged.map(c => [c.key, c.count]), [['c:a.png:chat2', 50], ['c:a.png:chat9', 10], ['c:a.png:chat1', 10], ['c:a.png:chat3', 10]]);
});

test('a complete fresh list replaces the cache (chats deleted elsewhere go)', () => {
    assert.deepEqual(mergeChats([row(1), row(2)], [row(2)], true).map(c => c.key), ['c:a.png:chat2']);
});

test('cache buckets: every key lands in one stable bucket, spread over all of them', async () => {
    globalThis.SillyTavern ??= { getContext: () => ({}) };
    const { bucketOf, CACHE_BUCKETS } = await import('../core.js');
    const seen = new Set();
    for (let i = 0; i < 5000; i++) {
        const b = bucketOf(`c:bot${i}.png:Bot${i} - 2026-01-01@12h00m00s`);
        assert.ok(b >= 0 && b < CACHE_BUCKETS);
        seen.add(b);
    }
    assert.equal(seen.size, CACHE_BUCKETS);
    assert.equal(bucketOf('g:17:chat'), bucketOf('g:17:chat'));
});
