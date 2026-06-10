// CORE RASTER — gli stessi identici loop per-pixel di js/raster.js, in SIMD.
// Contratto di equivalenza: per ogni input, l'output è BYTE PER BYTE uguale
// al fallback JS (verificato con i checksum di js/bench.js). Per questo:
//   - aritmetica intera: div255 vettoriale = ((x+128) + ((x+128)>>8)) >> 8,
//     identica a ((x+128)*257)>>16 per x <= 65025 (la formula di util.js);
//   - capsule in f64 scalare con lo stesso ordine di operazioni del JS
//     (IEEE 754: stesse operazioni, stessi bit).
// La memoria è gestita da JS (slab sopra __heap_base): qui solo puntatori,
// nessun allocatore. I rettangoli arrivano già clampati dal chiamante.
#![no_std]

use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

const CHUNK_SHIFT: usize = 8; // chunk 256x256 RGBA premultiplied

#[inline(always)]
fn div255(v: u32) -> u32 {
    ((v + 128) * 257) >> 16
}

// div255 su 8 lane u16. Input <= 65025: x+128 <= 65153, somma <= 65407 — tutto
// dentro u16, nessun overflow. Shift logici: le lane restano unsigned.
#[inline(always)]
fn div255_v(x: v128) -> v128 {
    let a = u16x8_add(x, u16x8_splat(128));
    u16x8_shr(u16x8_add(a, u16x8_shr(a, 8)), 8)
}

// Replica le lane alpha (byte 3 di ogni pixel) su tutti i 4 byte del pixel.
#[inline(always)]
fn splat_alpha(v: v128) -> v128 {
    i8x16_shuffle::<3, 3, 3, 3, 7, 7, 7, 7, 11, 11, 11, 11, 15, 15, 15, 15>(v, v)
}

// Blend di uno stamp (maschera alpha u8) sul rettangolo locale del chunk.
// mcol0/mrow0: posizione nella maschera del pixel (lx0, ly0). Ritorna 1 se
// almeno un pixel aveva ma != 0 (semantica `wrote`/touched del JS).
#[no_mangle]
pub unsafe extern "C" fn dab(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32,
    mask_ptr: u32, mask_w: u32, mcol0: u32, mrow0: u32,
    a255: u32, cr: u32, cg: u32, cb: u32, buildup: u32,
) -> u32 {
    let w = (lx1 - lx0 + 1) as usize;
    let h = (ly1 - ly0 + 1) as usize;
    let a16 = u16x8_splat(a255 as u16);
    // colore [R,G,B,255] per coppia di pixel: con C_alpha=255 vale
    // div255(255*ma) = ma, quindi la lane alpha produce direttamente ma.
    let c16 = u16x8(cr as u16, cg as u16, cb as u16, 255, cr as u16, cg as u16, cb as u16, 255);
    let v255 = u16x8_splat(255);
    let mut wrote = false;

    for row in 0..h {
        let mut dp = chunk_ptr as usize + ((((ly0 as usize + row) << CHUNK_SHIFT) + lx0 as usize) << 2);
        let mut mp = mask_ptr as usize + (mrow0 as usize + row) * mask_w as usize + mcol0 as usize;
        let mut x = 0usize;

        while x + 4 <= w {
            let mword = (mp as *const u32).read_unaligned();
            if mword != 0 {
                // 4 byte di maschera -> ma replicata sui 4 canali di ogni pixel
                let mv = u32x4_splat(mword);
                let m8 = i8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(mv, mv);
                let ma_lo = div255_v(i16x8_mul(u16x8_extend_low_u8x16(m8), a16));
                let ma_hi = div255_v(i16x8_mul(u16x8_extend_high_u8x16(m8), a16));
                if v128_any_true(v128_or(ma_lo, ma_hi)) {
                    wrote = true;
                    let d = v128_load(dp as *const v128);
                    let src_lo = div255_v(i16x8_mul(c16, ma_lo));
                    let src_hi = div255_v(i16x8_mul(c16, ma_hi));
                    let out = if buildup != 0 {
                        // out = div255(C*ma) + div255(d*(255-ma)) — somma <= 255 esatta
                        let d_lo = u16x8_extend_low_u8x16(d);
                        let d_hi = u16x8_extend_high_u8x16(d);
                        let o_lo = u16x8_add(src_lo, div255_v(i16x8_mul(d_lo, u16x8_sub(v255, ma_lo))));
                        let o_hi = u16x8_add(src_hi, div255_v(i16x8_mul(d_hi, u16x8_sub(v255, ma_hi))));
                        u8x16_narrow_i16x8(o_lo, o_hi)
                    } else {
                        // wash: scrive solo dove ma > alpha del documento
                        let ma8 = u8x16_narrow_i16x8(ma_lo, ma_hi);
                        let src8 = u8x16_narrow_i16x8(src_lo, src_hi); // [R,G,B,ma]
                        let cond = u8x16_gt(ma8, splat_alpha(d));
                        v128_bitselect(src8, d, cond)
                    };
                    v128_store(dp as *mut v128, out);
                }
            }
            dp += 16;
            mp += 4;
            x += 4;
        }

        // coda scalare (< 4 px), stessa aritmetica
        while x < w {
            let m = *(mp as *const u8) as u32;
            if m != 0 {
                let ma = div255(m * a255);
                if ma != 0 {
                    wrote = true;
                    let p = dp as *mut u8;
                    if buildup != 0 {
                        let inv = 255 - ma;
                        *p = (div255(cr * ma) + div255(*p as u32 * inv)) as u8;
                        *p.add(1) = (div255(cg * ma) + div255(*p.add(1) as u32 * inv)) as u8;
                        *p.add(2) = (div255(cb * ma) + div255(*p.add(2) as u32 * inv)) as u8;
                        *p.add(3) = (ma + div255(*p.add(3) as u32 * inv)) as u8;
                    } else if ma > *p.add(3) as u32 {
                        *p = div255(cr * ma) as u8;
                        *p.add(1) = div255(cg * ma) as u8;
                        *p.add(2) = div255(cb * ma) as u8;
                        *p.add(3) = ma as u8;
                    }
                }
            }
            dp += 4;
            mp += 1;
            x += 1;
        }
    }
    wrote as u32
}

// sqrt scalare via lane SIMD: core (no_std) non ha f64::sqrt, ma il wasm sì.
// f64x2_sqrt è correttamente arrotondato per lane, come Math.sqrt.
#[inline(always)]
fn sqrt64(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}

// Falloff radiale identico a brush.js (banda AA di almeno 1px).
#[inline(always)]
fn falloff(dist: f64, r: f64, h: f64) -> f64 {
    let core_r = r * h;
    let mut w = r - core_r;
    if w < 1.0 {
        w = 1.0;
    }
    let t = (dist - core_r) / w;
    if t <= 0.0 {
        return 1.0;
    }
    if t >= 1.0 {
        return 0.0;
    }
    1.0 - t * t * (3.0 - 2.0 * t)
}

// Capsula con raggio e alpha interpolati, replica esatta di _capsule in
// raster.js (stesso ordine di operazioni f64). ox/oy: origine mondo del chunk.
#[no_mangle]
pub unsafe extern "C" fn capsule(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32,
    ox: f64, oy: f64,
    x0: f64, y0: f64, r0: f64, a0: f64,
    x1: f64, y1: f64, r1: f64, a1: f64,
    hardness: f64, cr: u32, cg: u32, cb: u32,
) -> u32 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len2 = dx * dx + dy * dy;
    let inv_len2 = if len2 > 0.0 { 1.0 / len2 } else { 0.0 };
    let dr = r1 - r0;
    let da = a1 - a0;
    let mut wrote = false;

    for y2 in ly0..=ly1 {
        let py = oy + y2 as f64 + 0.5;
        let mut p = (chunk_ptr as usize + ((((y2 as usize) << CHUNK_SHIFT) + lx0 as usize) << 2)) as *mut u8;
        for x2 in lx0..=lx1 {
            let px = ox + x2 as f64 + 0.5;
            let mut t = ((px - x0) * dx + (py - y0) * dy) * inv_len2;
            if t < 0.0 {
                t = 0.0;
            } else if t > 1.0 {
                t = 1.0;
            }
            let qx = px - (x0 + dx * t);
            let qy = py - (y0 + dy * t);
            let r_t = r0 + dr * t;
            let dist2 = qx * qx + qy * qy;
            let lim = r_t + 1.0;
            if dist2 < lim * lim {
                let a = falloff(sqrt64(dist2), r_t, hardness) * (a0 + da * t);
                if a > 0.0 {
                    let ma = (a * 255.0 + 0.5) as u32;
                    if ma > *p.add(3) as u32 {
                        *p = div255(cr * ma) as u8;
                        *p.add(1) = div255(cg * ma) as u8;
                        *p.add(2) = div255(cb * ma) as u8;
                        *p.add(3) = ma as u8;
                        wrote = true;
                    }
                }
            }
            p = p.add(4);
        }
    }
    wrote as u32
}

// Composita un intero chunk dello stroke buffer sul documento (source-over
// premultiplied, o gomma). Replica commitChunk di raster.js: i pixel con
// parola 0 o alpha effettiva 0 restano intatti.
#[no_mangle]
pub unsafe extern "C" fn commit(dst_ptr: u32, src_ptr: u32, op255: u32, eraser: u32) {
    let full = op255 == 255;
    let op16 = u16x8_splat(op255 as u16);
    let v255 = u16x8_splat(255);
    let zero = u8x16_splat(0);
    let mut s = src_ptr as usize;
    let mut d = dst_ptr as usize;

    for _ in 0..(1usize << (CHUNK_SHIFT * 2)) / 4 {
        let sv = v128_load(s as *const v128);
        if v128_any_true(sv) {
            // s' = sorgente con l'opacità globale applicata (full: s' = s)
            let (sp_lo, sp_hi) = if full {
                (u16x8_extend_low_u8x16(sv), u16x8_extend_high_u8x16(sv))
            } else {
                (
                    div255_v(i16x8_mul(u16x8_extend_low_u8x16(sv), op16)),
                    div255_v(i16x8_mul(u16x8_extend_high_u8x16(sv), op16)),
                )
            };
            let sp8 = u8x16_narrow_i16x8(sp_lo, sp_hi);
            let sa = splat_alpha(sp8);
            let dv = v128_load(d as *const v128);
            let inv_lo = u16x8_sub(v255, u16x8_extend_low_u8x16(sa));
            let inv_hi = u16x8_sub(v255, u16x8_extend_high_u8x16(sa));
            let att_lo = div255_v(i16x8_mul(u16x8_extend_low_u8x16(dv), inv_lo));
            let att_hi = div255_v(i16x8_mul(u16x8_extend_high_u8x16(dv), inv_hi));
            let out8 = if eraser != 0 {
                u8x16_narrow_i16x8(att_lo, att_hi)
            } else {
                u8x16_narrow_i16x8(u16x8_add(sp_lo, att_lo), u16x8_add(sp_hi, att_hi))
            };
            // sa == 0 -> il pixel resta com'era (skip del JS)
            let keep = i8x16_eq(sa, zero);
            v128_store(d as *mut v128, v128_bitselect(dv, out8, keep));
        }
        s += 16;
        d += 16;
    }
}
