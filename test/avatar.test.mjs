// The card-picture helpers in lib.js: crop frame maths and avatar URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverScale, clampView, initialView, zoomView, cropOf, outputSize, isAvatarUrl, withVersion, versionOf, AVATAR_W, AVATAR_H } from '../lib.js';

const frame = { w: 200, h: 300 };

test('a 2:3 picture fills the frame exactly at zoom 1', () => {
    const img = { w: 1024, h: 1536 };
    const v = initialView(img, frame);
    assert.deepEqual(v, { zoom: 1, x: 0, y: 0 });
    assert.deepEqual(cropOf(v, img, frame), { x: 0, y: 0, width: 1024, height: 1536 });
});

test('a wide picture is centred across; a tall one sits near the top', () => {
    const wide = { w: 1600, h: 900 };
    const s = coverScale(wide, frame); // height decides
    assert.equal(s, 300 / 900);
    const v = initialView(wide, frame);
    assert.equal(v.y, 0);
    assert.ok(Math.abs(v.x - (200 - 1600 * s) / 2) < 1e-9);
    const c = cropOf(v, wide, frame);
    assert.equal(c.height, 900);
    assert.equal(c.width, 600);
    assert.equal(c.x, 500); // (1600 - 600) / 2

    const tall = { w: 1000, h: 3000 };
    const t = cropOf(initialView(tall, frame), tall, frame);
    assert.equal(t.width, 1000);
    assert.equal(t.height, 1500);
    assert.equal(t.y, 300); // 20% of the 1500 left over
});

test('the view never shows past the picture edge', () => {
    const img = { w: 1000, h: 1500 };
    assert.deepEqual(clampView({ zoom: 1, x: 50, y: -999 }, img, frame), { zoom: 1, x: 0, y: 0 });
    const v = clampView({ zoom: 2, x: -1000, y: 10 }, img, frame);
    assert.equal(v.x, -200); // picture 400 wide on a 200 frame
    assert.equal(v.y, 0);
    assert.equal(clampView({ zoom: 0.2, x: 0, y: 0 }, img, frame).zoom, 1);
    assert.equal(clampView({ zoom: 99, x: 0, y: 0 }, img, frame).zoom, 6);
});

test('zooming keeps the point under the fingers in place', () => {
    const img = { w: 1000, h: 1500 };
    const v = zoomView({ zoom: 1, x: 0, y: 0 }, 2, 100, 150, img, frame); // zoom on the centre
    assert.deepEqual(v, { zoom: 2, x: -100, y: -150 });
    const c = cropOf(v, img, frame);
    assert.deepEqual(c, { x: 250, y: 375, width: 500, height: 750 });
    // back out: clamped to the edge, never past it
    assert.deepEqual(zoomView(v, 1, 0, 0, img, frame), { zoom: 1, x: 0, y: 0 });
});

test('crop stays inside the picture after rounding', () => {
    const img = { w: 777, h: 1111 };
    for (const zoom of [1, 1.37, 2.9, 6]) {
        const s = coverScale(img, frame) * zoom;
        const v = clampView({ zoom, x: frame.w - img.w * s, y: frame.h - img.h * s }, img, frame); // bottom-right corner
        const c = cropOf(v, img, frame);
        assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= img.w && c.y + c.height <= img.h, JSON.stringify({ zoom, c }));
    }
});

test('output size: 512×768, or the crop scaled down to the limit', () => {
    assert.deepEqual(outputSize({ width: 3000, height: 4500 }, true), { w: AVATAR_W, h: AVATAR_H });
    assert.deepEqual(outputSize({ width: 3000, height: 4500 }, false), { w: 1365, h: 2048 });
    assert.deepEqual(outputSize({ width: 400, height: 600 }, false), { w: 400, h: 600 });
});

test('isAvatarUrl: thumbnails and full pictures of that file only', () => {
    const a = 'Alice & Bob.png';
    const enc = encodeURIComponent(a);
    assert.ok(isAvatarUrl(`/thumbnail?type=avatar&file=${enc}`, a));
    assert.ok(isAvatarUrl(`http://host:8000/thumbnail?type=avatar&file=${enc}&rv=3`, a));
    assert.ok(isAvatarUrl(`/characters/${enc}`, a));
    assert.ok(isAvatarUrl(`/characters/${enc}?rv=1`, a));
    assert.ok(!isAvatarUrl(`/thumbnail?type=persona&file=${enc}`, a));
    assert.ok(!isAvatarUrl(`/thumbnail?type=avatar&file=Alice.png`, a));
    assert.ok(!isAvatarUrl('/characters/Other.png', a));
    assert.ok(!isAvatarUrl('/img/ai4.png', a));
    assert.ok(!isAvatarUrl('', a));
    assert.ok(!isAvatarUrl('/characters/%E0%A4', 'x.png')); // broken escape: no throw
});

test('withVersion adds or replaces rv and keeps the rest', () => {
    assert.equal(withVersion('/thumbnail?type=avatar&file=A.png', 5), '/thumbnail?type=avatar&file=A.png&rv=5');
    assert.equal(withVersion('/thumbnail?type=avatar&file=A.png&rv=5', 6), '/thumbnail?type=avatar&file=A.png&rv=6');
    assert.equal(withVersion('/characters/A%20B.png', 7), '/characters/A%20B.png?rv=7');
    assert.equal(withVersion('/characters/A.png#x', 1), '/characters/A.png?rv=1#x');
    assert.equal(withVersion('/characters/A.png', 0), '/characters/A.png');
    assert.equal(versionOf('/characters/A.png?rv=7'), '7');
    assert.equal(versionOf('/characters/A.png'), '');
    // the thumbnail's file name survives the round trip
    assert.ok(isAvatarUrl(withVersion(`/thumbnail?type=avatar&file=${encodeURIComponent('ก ข+ค.png')}`, 2), 'ก ข+ค.png'));
});
