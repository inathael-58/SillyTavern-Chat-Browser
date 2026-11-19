// night-palette.js — โหมดกลางคืนสำหรับเล่นในห้องมืด ใช้ร่วมกันใน extension ของ inathael-58
// คัดลอกไฟล์นี้ทั้งไฟล์ อย่าแก้แยกที่ใดที่หนึ่ง (แก้แล้วเพิ่ม NIGHT_VERSION และอัปเดตทุก repo)
// NIGHT_VERSION 1
//
// โหมด "มืด/กลางคืน" ที่ผู้ใช้เลือกเอง: พื้นเกือบดำ ตัวอักษรเทาอ่อน (ไม่ขาวจ้า) เส้นขอบจาง ช่องพิมพ์มืดกว่าพื้น
// สีเน้นยังเป็นโทนของธีม แต่ลดความสด (saturation ≤ 0.42) แล้วตั้งความสว่างให้ตัดกับพื้นพอดี 7:1
// → อ่านออกทั้งเป็นตัวอักษรและเป็นพื้นปุ่มที่มีตัวอักษรเข้มทับ แต่ไม่จ้ากว่าตัวอักษรหลัก
//
// ใช้:  const palette = installThemePalette({ prefix: 'xx', ... });
//       installNightAccent(palette, 'xx');   →  --xx-p-accent-night บน <html>
// สีพื้น/ตัวอักษรของโหมดนี้อยู่ใน style.css ของแต่ละ extension (ค่าเดียวกันกับ NIGHT ด้านล่าง)

import { parseColor, contrast, rgbToHsl, hslToRgb } from './theme-palette.js';

export const NIGHT_VERSION = 1;
export const NIGHT = Object.freeze({
    bg: '#111015',       // พื้นแผง
    surface: '#17161c',  // การ์ด
    surface2: '#1c1b21', // ชิป / hover
    field: '#0d0c10',    // ช่องพิมพ์ (มืดกว่าพื้น)
    border: '#27262d',   // เส้นขอบ
    soft: '#1f1e24',     // เส้นคั่น
    fg: '#c4c0cb',       // ตัวอักษร
    dim: '#8a8693',      // ตัวอักษรรอง
});
const BG = [17, 16, 21];

/** สีเน้นกลางคืนจากสีเน้นของธีม: คงโทน ลดความสด ตัดกับพื้นกลางคืน 7:1 */
export function nightAccent(rgb, bg = BG) {
    const [h, s0] = rgbToHsl(rgb);
    const s = s0 < 0.12 ? 0 : Math.min(s0, 0.42);
    for (let l = 0.3; l <= 0.97; l += 0.005) {
        const c = hslToRgb([h, s, l]);
        if (contrast(c, bg) >= 7) return c;
    }
    return [196, 192, 203];
}

const css = c => `rgb(${c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(', ')})`;

/** เขียน --{prefix}-p-accent-night ทุกครั้งที่ชุดสีธีมเปลี่ยน */
export function installNightAccent(palette, prefix) {
    if (!palette || !prefix) return;
    const root = document.documentElement;
    const apply = p => {
        try {
            const src = parseColor(p?.['accent-dark'] ?? p?.['accent-text'] ?? p?.accent ?? '');
            if (src) root.style.setProperty(`--${prefix}-p-accent-night`, css(nightAccent(src.slice(0, 3))));
        } catch (err) { console.warn(`[night-palette:${prefix}]`, err); }
    };
    apply(palette.current);
    palette.onChange(apply);
}
