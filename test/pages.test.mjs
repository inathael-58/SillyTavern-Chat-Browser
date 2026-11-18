import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRange, pageEntries, PAGE_SIZES } from '../lib.js';

test('size 0 (all) or a short list is one page', () => {
    assert.deepEqual(pageRange(500, 0, 3), { page: 1, pages: 1, from: 0, to: 500 });
    assert.deepEqual(pageRange(20, 24, 2), { page: 1, pages: 1, from: 0, to: 20 });
    assert.deepEqual(pageRange(0, 24, 1), { page: 1, pages: 1, from: 0, to: 0 });
});

test('pages split the items and the page is clamped', () => {
    assert.deepEqual(pageRange(100, 24, 1), { page: 1, pages: 5, from: 0, to: 24 });
    assert.deepEqual(pageRange(100, 24, 5), { page: 5, pages: 5, from: 96, to: 100 });
    assert.deepEqual(pageRange(100, 24, 9), { page: 5, pages: 5, from: 96, to: 100 }); // the list got shorter
    assert.deepEqual(pageRange(100, 24, 0), { page: 1, pages: 5, from: 0, to: 24 });
});

test('the sizes offered start with "all"', () => {
    assert.equal(PAGE_SIZES.cards[0], 0);
    assert.equal(PAGE_SIZES.chats[0], 0);
});

const chat = (n) => ({ kind: 'chat', chat: { key: `k${n}` } });
const section = (id) => ({ kind: 'section', id, title: id });

test('list pages count chats, not section headers', () => {
    const entries = [section('pinned'), chat(1), chat(2), section('all'), chat(3), chat(4), chat(5)];
    const p1 = pageEntries(entries, 2, 1);
    assert.equal(p1.pages, 3);
    assert.deepEqual(p1.entries.map(e => e.kind === 'chat' ? e.chat.key : e.id), ['pinned', 'k1', 'k2']);
    const p2 = pageEntries(entries, 2, 2);
    assert.deepEqual(p2.entries.map(e => e.kind === 'chat' ? e.chat.key : e.id), ['all', 'k3', 'k4']);
    assert.equal(p2.entries[0].cont, undefined); // the section starts on this page
});

test('a page that starts inside a section repeats its header, marked as continued', () => {
    const entries = [section('a'), chat(1), chat(2), chat(3), section('b'), chat(4)];
    const p2 = pageEntries(entries, 2, 2);
    assert.deepEqual(p2.entries.map(e => e.kind === 'chat' ? e.chat.key : e.id), ['a', 'k3', 'b', 'k4']);
    assert.equal(p2.entries[0].cont, true);
    assert.equal(p2.entries[2].cont, undefined);
    assert.equal(entries[0].cont, undefined); // the original entry is left alone
});

test('size 0 returns the same entries', () => {
    const entries = [section('a'), chat(1), chat(2)];
    const r = pageEntries(entries, 0, 4);
    assert.equal(r.entries, entries);
    assert.equal(r.page, 1);
});
