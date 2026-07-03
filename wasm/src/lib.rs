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
    let a255_v = u8x16_splat(a255 as u8); // bound esatto del wash: ma <= a255
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
                    wrote = true; // semantica JS: ma != 0 conta come "scritto"
                    let d = v128_load(dp as *const v128);
                    if buildup != 0 {
                        // out = div255(C*ma) + div255(d*(255-ma)) — somma <= 255 esatta
                        let src_lo = div255_v(i16x8_mul(c16, ma_lo));
                        let src_hi = div255_v(i16x8_mul(c16, ma_hi));
                        let d_lo = u16x8_extend_low_u8x16(d);
                        let d_hi = u16x8_extend_high_u8x16(d);
                        let o_lo = u16x8_add(src_lo, div255_v(i16x8_mul(d_lo, u16x8_sub(v255, ma_lo))));
                        let o_hi = u16x8_add(src_hi, div255_v(i16x8_mul(d_hi, u16x8_sub(v255, ma_hi))));
                        v128_store(dp as *mut v128, u8x16_narrow_i16x8(o_lo, o_hi));
                    } else {
                        // wash, a parità vince l'ULTIMO dab (>=): ma <= a255
                        // sempre, quindi se il documento è già OLTRE a255 su
                        // tutti e 4 i pixel nessuno può scrivere. (ma == da == 0
                        // riscrive zeri su zeri: stessi byte del salto JS.)
                        let da8 = splat_alpha(d);
                        if !u8x16_all_true(u8x16_gt(da8, a255_v)) {
                            let src_lo = div255_v(i16x8_mul(c16, ma_lo));
                            let src_hi = div255_v(i16x8_mul(c16, ma_hi));
                            let ma8 = u8x16_narrow_i16x8(ma_lo, ma_hi);
                            let src8 = u8x16_narrow_i16x8(src_lo, src_hi); // [R,G,B,ma]
                            let cond = u8x16_ge(ma8, da8);
                            v128_store(dp as *mut v128, v128_bitselect(src8, d, cond));
                        }
                    }
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
                    } else if ma >= *p.add(3) as u32 {
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

// Replica i 4 byte (un pixel ciascuno) di una parola su 16 lane: byte i -> px i.
#[inline(always)]
fn splat_bytes(word: u32) -> v128 {
    let v = u32x4_splat(word);
    i8x16_shuffle::<0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3>(v, v)
}

// Dab texturizzato via TILE di fattori in spazio chunk (1 byte/px, stesso
// indirizzamento del chunk: il fattore del pixel (x,y) sta a tile_ptr+(y<<8)+x).
// La matematica texture (bilineare+LUT) è già nel tile, calcolato una volta
// per chunk in JS: qui solo m2 = div255(m*f) e lo stesso identico composito
// di `dab`. Equivalenza bit-exact col fallback JS: stessa doppia quantizzazione
// m2 = div255(m*f), poi ma = div255(m2*a255).
// rgb_ptr != 0: tile RGBX (4 byte/px, X=255, stesso indirizzamento del chunk)
// con i colori della texture al posto del colore del pennello; con X=255 la
// lane X produce direttamente ma, come la lane alpha di c16.
#[no_mangle]
pub unsafe extern "C" fn dab_tex_tile(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32,
    mask_ptr: u32, mask_w: u32, mcol0: u32, mrow0: u32,
    tile_ptr: u32, rgb_ptr: u32,
    a255: u32, cr: u32, cg: u32, cb: u32, buildup: u32,
) -> u32 {
    let w = (lx1 - lx0 + 1) as usize;
    let h = (ly1 - ly0 + 1) as usize;
    let a16 = u16x8_splat(a255 as u16);
    let a255_v = u8x16_splat(a255 as u8); // bound esatto del wash: ma <= a255
    let c16 = u16x8(cr as u16, cg as u16, cb as u16, 255, cr as u16, cg as u16, cb as u16, 255);
    let v255 = u16x8_splat(255);
    let mut wrote = false;

    for row in 0..h {
        let trow = ((ly0 as usize + row) << CHUNK_SHIFT) + lx0 as usize;
        let mut dp = chunk_ptr as usize + (trow << 2);
        let mut tp = tile_ptr as usize + trow;
        let mut rp = rgb_ptr as usize + (trow << 2); // letto solo se rgb_ptr != 0
        let mut mp = mask_ptr as usize + (mrow0 as usize + row) * mask_w as usize + mcol0 as usize;
        let mut x = 0usize;

        while x + 4 <= w {
            let mword = (mp as *const u32).read_unaligned();
            if mword != 0 {
                let fword = (tp as *const u32).read_unaligned();
                // maschera e fattore replicati sui 4 canali di ogni pixel:
                // m2 = div255(m*f) e ma = div255(m2*a255) escono già nel
                // layout del composito di `dab` (m*f <= 65025: dentro u16)
                let m8 = splat_bytes(mword);
                let f8 = splat_bytes(fword);
                let m2_lo = div255_v(i16x8_mul(u16x8_extend_low_u8x16(m8), u16x8_extend_low_u8x16(f8)));
                let m2_hi = div255_v(i16x8_mul(u16x8_extend_high_u8x16(m8), u16x8_extend_high_u8x16(f8)));
                let ma_lo = div255_v(i16x8_mul(m2_lo, a16));
                let ma_hi = div255_v(i16x8_mul(m2_hi, a16));
                if v128_any_true(v128_or(ma_lo, ma_hi)) {
                    wrote = true; // semantica JS: ma != 0 conta come "scritto"
                    let d = v128_load(dp as *const v128);
                    // colore per coppia di pixel: fisso o dal tile RGBX
                    let (cl, ch) = if rgb_ptr != 0 {
                        let cv = v128_load(rp as *const v128);
                        (u16x8_extend_low_u8x16(cv), u16x8_extend_high_u8x16(cv))
                    } else {
                        (c16, c16)
                    };
                    if buildup != 0 {
                        let src_lo = div255_v(i16x8_mul(cl, ma_lo));
                        let src_hi = div255_v(i16x8_mul(ch, ma_hi));
                        let d_lo = u16x8_extend_low_u8x16(d);
                        let d_hi = u16x8_extend_high_u8x16(d);
                        let o_lo = u16x8_add(src_lo, div255_v(i16x8_mul(d_lo, u16x8_sub(v255, ma_lo))));
                        let o_hi = u16x8_add(src_hi, div255_v(i16x8_mul(d_hi, u16x8_sub(v255, ma_hi))));
                        v128_store(dp as *mut v128, u8x16_narrow_i16x8(o_lo, o_hi));
                    } else {
                        // wash, a parità vince l'ULTIMO dab (vedi `dab`)
                        let da8 = splat_alpha(d);
                        if !u8x16_all_true(u8x16_gt(da8, a255_v)) {
                            let src_lo = div255_v(i16x8_mul(cl, ma_lo));
                            let src_hi = div255_v(i16x8_mul(ch, ma_hi));
                            let ma8 = u8x16_narrow_i16x8(ma_lo, ma_hi);
                            let src8 = u8x16_narrow_i16x8(src_lo, src_hi); // [R,G,B,ma]
                            let cond = u8x16_ge(ma8, da8);
                            v128_store(dp as *mut v128, v128_bitselect(src8, d, cond));
                        }
                    }
                }
            }
            dp += 16;
            tp += 4;
            rp += 16;
            mp += 4;
            x += 4;
        }

        // coda scalare (< 4 px), stessa aritmetica
        while x < w {
            let m = *(mp as *const u8) as u32;
            if m != 0 {
                let f = *(tp as *const u8) as u32;
                let m2 = div255(m * f);
                if m2 != 0 {
                    let ma = div255(m2 * a255);
                    if ma != 0 {
                        wrote = true;
                        let (r, g, b) = if rgb_ptr != 0 {
                            (
                                *(rp as *const u8) as u32,
                                *((rp + 1) as *const u8) as u32,
                                *((rp + 2) as *const u8) as u32,
                            )
                        } else {
                            (cr, cg, cb)
                        };
                        let p = dp as *mut u8;
                        if buildup != 0 {
                            let inv = 255 - ma;
                            *p = (div255(r * ma) + div255(*p as u32 * inv)) as u8;
                            *p.add(1) = (div255(g * ma) + div255(*p.add(1) as u32 * inv)) as u8;
                            *p.add(2) = (div255(b * ma) + div255(*p.add(2) as u32 * inv)) as u8;
                            *p.add(3) = (ma + div255(*p.add(3) as u32 * inv)) as u8;
                        } else if ma >= *p.add(3) as u32 {
                            *p = div255(r * ma) as u8;
                            *p.add(1) = div255(g * ma) as u8;
                            *p.add(2) = div255(b * ma) as u8;
                            *p.add(3) = ma as u8;
                        }
                    }
                }
            }
            dp += 4;
            tp += 1;
            rp += 4;
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

// ---- CAPSULE v2 A INTERI (spec: js/capsule_int.js) ----
// La LUT del falloff (1025 u16, smoothstep discendente a scala 32768) viene
// scritta dal JS nel heap all'attach e registrata qui: unica fonte per
// JS/wasm/WGSL. Il puntatore resta valido attraverso i memory.grow.
static mut FALLOFF_LUT_PTR: usize = 0;

#[no_mangle]
pub unsafe extern "C" fn set_falloff_lut(ptr: u32) {
    FALLOFF_LUT_PTR = ptr as usize;
}

#[inline(always)]
unsafe fn lut16(i: u32) -> u32 {
    *((FALLOFF_LUT_PTR + (i as usize) * 2) as *const u16) as u32
}

// t di proiezione ARROTONDATO: floor((num<<16 + den/2)/den), esatto in u64.
#[inline(always)]
fn div_t(num: u32, den: u32) -> u32 {
    ((((num as u64) << 16) + ((den >> 1) as u64)) / (den as u64)) as u32
}

// round(sqrt(n)) esatto, n < 2^31 (mai tie: D²+D+0.25 non è intero).
// sqrt f64 è correttamente arrotondata -> il floor sbaglia di al più 1,
// i quadrati esatti in u32 correggono; poi n > s²+s decide l'arrotondamento.
#[inline(always)]
fn isqrt_round(n: u32) -> u32 {
    let mut s = sqrt64(n as f64) as u32;
    if s > 46340 {
        s = 46340;
    }
    while s * s > n {
        s -= 1;
    }
    while (s + 1) * (s + 1) <= n {
        s += 1;
    }
    if n > s * s + s {
        s += 1;
    }
    s
}

// Parametri interi di una tratta (record dello spec, quantizzato dal JS:
// fixed 1/32px, tratte <=128px).
struct CapsInt {
    x0: i32, y0: i32, dx: i32, dy: i32, den: u32,
    r0: i32, dr: i32, a0: i32, da: i32, hq: i32,
    cr: u32, cg: u32, cb: u32, ma_max: u32,
}

// ma v2 (0..255) al pixel (px,py in 1/32 px) — speculare, operazione per
// operazione, a capsuleIntMa in capsule_int.js.
#[inline(always)]
unsafe fn capsule_int_ma(c: &CapsInt, px: i32, py: i32) -> u32 {
    let rx = px - c.x0;
    let ry = py - c.y0;
    let num = rx as i64 * c.dx as i64 + ry as i64 * c.dy as i64;
    let tq: u32 = if c.den == 0 || num <= 0 {
        0
    } else if num >= c.den as i64 {
        65536
    } else {
        div_t(num as u32, c.den)
    };
    let ti = tq as i32;
    let qx = rx - ((c.dx * ti) >> 16);
    let qy = ry - ((c.dy * ti) >> 16);
    let r_t = c.r0 + ((c.dr * ti) >> 16);
    let lim = r_t + 32;
    if lim <= 0 {
        return 0;
    }
    // qx²+qy² può superare i31: somma in u32 (i quadrati singoli stanno in i32)
    let d2 = (qx * qx) as u32 + (qy * qy) as u32;
    let ulim = lim as u32;
    if d2 >= ulim * ulim {
        return 0;
    }
    let a_t = c.a0 + ((c.da * (ti >> 4)) >> 12);
    if a_t <= 0 {
        return 0;
    }
    let core = (r_t * c.hq) >> 12;
    let mut w = r_t - core;
    if w < 32 {
        w = 32;
    }
    let d = isqrt_round(d2) as i32;
    let u: u32 = if d <= core {
        0
    } else {
        (((d - core) * 1024) as u32 + ((w as u32) >> 1)) / (w as u32)
    };
    if u >= 1024 {
        return 0;
    }
    (lut16(u) * (a_t as u32) + (1 << 22)) >> 23
}

// Bound esatto di riga: ma(pixel) <= bound per monotonia del falloff intero
// (D >= row_dist, rT <= r_max, aT <= a_max) — speculare a capsuleIntBound.
#[inline(always)]
unsafe fn capsule_int_bound(row_dist: i32, r_max: i32, a_max: i32, hq: i32) -> u32 {
    let lim = r_max + 32;
    if lim <= 0 || row_dist >= lim || a_max <= 0 {
        return 0;
    }
    let core = (r_max * hq) >> 12;
    let mut w = r_max - core;
    if w < 32 {
        w = 32;
    }
    let u: u32 = if row_dist <= core {
        0
    } else {
        (((row_dist - core) * 1024) as u32 + ((w as u32) >> 1)) / (w as u32)
    };
    if u >= 1024 {
        return 0;
    }
    (lut16(u) * (a_max as u32) + (1 << 22)) >> 23
}

// Un pixel della capsula v2: pre-check esatto sul bound di riga, poi la
// matematica intera e il tie `>` (primo vince) come in raster.js.
#[inline(always)]
unsafe fn capsule_int_px(c: &CapsInt, p: *mut u8, px: i32, py: i32) -> bool {
    if *p.add(3) as u32 >= c.ma_max {
        return false;
    }
    let ma = capsule_int_ma(c, px, py);
    if ma > *p.add(3) as u32 {
        *p = div255(c.cr * ma) as u8;
        *p.add(1) = div255(c.cg * ma) as u8;
        *p.add(2) = div255(c.cb * ma) as u8;
        *p.add(3) = ma as u8;
        return true;
    }
    false
}

// Capsula v2 con raggio e alpha interpolati, replica esatta di _capsule in
// raster.js (il chiamante passa il record già quantizzato: tratte <=128px).
// È il path caldo del pennello di default (spacing < 0.05 -> via continua):
// i segmenti consecutivi si sovrappongono quasi del tutto, quindi quasi
// tutti i pixel falliscono `ma > alpha` DOPO la matematica. Struttura di
// skip identica a prima — bound esatto per riga (righe a bound 0 saltate
// intere) + confronto SIMD dell'alpha di 4 pixel contro il bound — nessuno
// dei due cambia l'output di un bit. cox/coy: origine mondo del chunk in px.
#[no_mangle]
pub unsafe extern "C" fn capsule_int(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32,
    cox: i32, coy: i32,
    x0: i32, y0: i32, dx: i32, dy: i32, den: u32,
    r0: i32, dr: i32, a0: i32, da: i32,
    hq: u32, cr: u32, cg: u32, cb: u32,
) -> u32 {
    let r_max = if dr > 0 { r0 + dr } else { r0 };
    let a_max = if da > 0 { a0 + da } else { a0 };
    let y_lo = if dy < 0 { y0 + dy } else { y0 };
    let y_hi = if dy > 0 { y0 + dy } else { y0 };
    let mut c = CapsInt {
        x0, y0, dx, dy, den, r0, dr, a0, da,
        hq: hq as i32, cr, cg, cb,
        ma_max: 0, // impostato per riga
    };
    let w = (lx1 - lx0 + 1) as usize;
    let mut wrote = false;

    for y2 in ly0..=ly1 {
        let py = (coy + y2 as i32) * 32 + 16;
        let row_dist = if py < y_lo { y_lo - py } else if py > y_hi { py - y_hi } else { 0 };
        let bound = capsule_int_bound(row_dist, r_max, a_max, hq as i32);
        if bound == 0 {
            continue; // nessun pixel della riga può scrivere
        }
        c.ma_max = bound;
        let bound_v = u8x16_splat(bound as u8); // <= 255

        let row = chunk_ptr as usize + ((((y2 as usize) << CHUNK_SHIFT) + lx0 as usize) << 2);
        let px0 = (cox + lx0 as i32) * 32 + 16;
        let mut x = 0usize;

        while x + 4 <= w {
            let d4 = v128_load((row + x * 4) as *const v128);
            if !u8x16_all_true(u8x16_ge(splat_alpha(d4), bound_v)) {
                let p = (row + x * 4) as *mut u8;
                let xi = x as i32;
                wrote |= capsule_int_px(&c, p, px0 + xi * 32, py);
                wrote |= capsule_int_px(&c, p.add(4), px0 + (xi + 1) * 32, py);
                wrote |= capsule_int_px(&c, p.add(8), px0 + (xi + 2) * 32, py);
                wrote |= capsule_int_px(&c, p.add(12), px0 + (xi + 3) * 32, py);
            }
            x += 4;
        }
        while x < w {
            wrote |= capsule_int_px(&c, (row + x * 4) as *mut u8, px0 + (x as i32) * 32, py);
            x += 1;
        }
    }
    wrote as u32
}

// Un pixel della capsula v2 texturizzata: geometria intera identica a
// capsule_int_ma, poi ma = div255(ma_base * f) col fattore f dal tile.
// Pre-check esatto: ma <= div255(bound * f) sempre (div255 è monotona).
// rgb = 0 -> colore del pennello; altrimenti ptr al pixel RGBX del tile.
#[inline(always)]
unsafe fn capsule_tex_int_px(c: &CapsInt, p: *mut u8, f: u32, rgb: usize, px: i32, py: i32) -> bool {
    if *p.add(3) as u32 >= div255(c.ma_max * f) {
        return false;
    }
    let ma_base = capsule_int_ma(c, px, py);
    if ma_base == 0 {
        return false;
    }
    let ma = div255(ma_base * f);
    if ma > *p.add(3) as u32 {
        let (cr, cg, cb) = if rgb != 0 {
            (
                *(rgb as *const u8) as u32,
                *((rgb + 1) as *const u8) as u32,
                *((rgb + 2) as *const u8) as u32,
            )
        } else {
            (c.cr, c.cg, c.cb)
        };
        *p = div255(cr * ma) as u8;
        *p.add(1) = div255(cg * ma) as u8;
        *p.add(2) = div255(cb * ma) as u8;
        *p.add(3) = ma as u8;
        return true;
    }
    false
}

// Capsula v2 texturizzata: la via continua quando la grana è ancorata al
// canvas (il fattore per pixel non dipende dal dab, quindi commuta con
// l'unione wash). Stessa struttura di `capsule_int`; il bound per riga viene
// raffinato per pixel col fattore del tile: dove la grana satura il
// documento a un'alpha più bassa, il blocco di 4 pixel si salta con un
// confronto SIMD esatto. tile_ptr: fattori 1 byte/px; rgb_ptr: RGBX o 0.
#[no_mangle]
pub unsafe extern "C" fn capsule_tex_int(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32,
    cox: i32, coy: i32,
    x0: i32, y0: i32, dx: i32, dy: i32, den: u32,
    r0: i32, dr: i32, a0: i32, da: i32,
    hq: u32, cr: u32, cg: u32, cb: u32,
    tile_ptr: u32, rgb_ptr: u32,
) -> u32 {
    let r_max = if dr > 0 { r0 + dr } else { r0 };
    let a_max = if da > 0 { a0 + da } else { a0 };
    let y_lo = if dy < 0 { y0 + dy } else { y0 };
    let y_hi = if dy > 0 { y0 + dy } else { y0 };
    let mut c = CapsInt {
        x0, y0, dx, dy, den, r0, dr, a0, da,
        hq: hq as i32, cr, cg, cb,
        ma_max: 0, // impostato per riga
    };
    let w = (lx1 - lx0 + 1) as usize;
    let mut wrote = false;

    for y2 in ly0..=ly1 {
        let py = (coy + y2 as i32) * 32 + 16;
        let row_dist = if py < y_lo { y_lo - py } else if py > y_hi { py - y_hi } else { 0 };
        let bound = capsule_int_bound(row_dist, r_max, a_max, hq as i32);
        if bound == 0 {
            continue; // nessun pixel della riga può scrivere
        }
        c.ma_max = bound;
        let bnd16 = u16x8_splat(bound as u16);

        let trow = ((y2 as usize) << CHUNK_SHIFT) + lx0 as usize;
        let row = chunk_ptr as usize + (trow << 2);
        let tr = tile_ptr as usize + trow;
        let rr = rgb_ptr as usize + (trow << 2); // valido solo se rgb_ptr != 0
        let px0 = (cox + lx0 as i32) * 32 + 16;
        let mut x = 0usize;

        while x + 4 <= w {
            let d4 = v128_load((row + x * 4) as *const v128);
            // bound esatto per pixel, replicato sui 4 canali come l'alpha:
            // ma <= div255(bound * f) (f*bound <= 65025: dentro u16)
            let fword = ((tr + x) as *const u32).read_unaligned();
            let f8 = splat_bytes(fword);
            let b_lo = div255_v(i16x8_mul(u16x8_extend_low_u8x16(f8), bnd16));
            let b_hi = div255_v(i16x8_mul(u16x8_extend_high_u8x16(f8), bnd16));
            let bound_v = u8x16_narrow_i16x8(b_lo, b_hi);
            if !u8x16_all_true(u8x16_ge(splat_alpha(d4), bound_v)) {
                let p = (row + x * 4) as *mut u8;
                let f = fword;
                let rb = if rgb_ptr != 0 { rr + x * 4 } else { 0 };
                let rs = if rgb_ptr != 0 { 4 } else { 0 };
                let xi = x as i32;
                wrote |= capsule_tex_int_px(&c, p, f & 0xff, rb, px0 + xi * 32, py);
                wrote |= capsule_tex_int_px(&c, p.add(4), (f >> 8) & 0xff, rb + rs, px0 + (xi + 1) * 32, py);
                wrote |= capsule_tex_int_px(&c, p.add(8), (f >> 16) & 0xff, rb + rs * 2, px0 + (xi + 2) * 32, py);
                wrote |= capsule_tex_int_px(&c, p.add(12), f >> 24, rb + rs * 3, px0 + (xi + 3) * 32, py);
            }
            x += 4;
        }
        while x < w {
            let f = *((tr + x) as *const u8) as u32;
            let rb = if rgb_ptr != 0 { rr + x * 4 } else { 0 };
            wrote |= capsule_tex_int_px(&c, (row + x * 4) as *mut u8, f, rb, px0 + (x as i32) * 32, py);
            x += 1;
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

// ===========================================================================
// PENNELLO BLUR/SFUMINO — kernel del blend, replica di js/blur_brush.js.
// Contratto: output BYTE PER BYTE uguale al fallback JS — f64 scalare con lo
// stesso ordine di operazioni (niente SIMD: il loop è dominato da mask e
// campionamenti f64, e f64x2 su V8 è più lento dello scalare, misurato).
// I parametri per-dab arrivano in due blocchi scritti da JS (pf: f64,
// pi: i32) per non esplodere le firme; per chunk passano solo rettangolo,
// origine e i puntatori base/out. base == out = scrittura in-place (chunk
// già catturato dall'undo); altrimenti out è un tile scratch: il kernel
// PRE-COPIA il sub-rect da base (i pixel saltati restano identici) e JS
// ricopia solo il rettangolo danneggiato. Ritorna il damage locale
// (dx0<<24 | dy0<<16 | dx1<<8 | dy1) oppure u32::MAX se nulla è cambiato.

// floor scalare via lane SIMD: core (no_std) non ha f64::floor, il wasm sì.
#[inline(always)]
fn floor64(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
}

// i255 di blur_brush.js: (v + 0.5) | 0 con clamp (in (0,255) trunc == floor).
#[inline(always)]
fn i255b(v: f64) -> i32 {
    if v <= 0.0 { 0 } else if v >= 255.0 { 255 } else { (v + 0.5) as i32 }
}

// Store di Uint8ClampedArray: clamp 0..255 e round-half-to-EVEN (spec JS).
#[inline(always)]
fn u8cr(v: f64) -> u8 {
    if v <= 0.0 {
        return 0;
    }
    if v >= 255.0 {
        return 255;
    }
    let f = floor64(v);
    let d = v - f;
    let r = if d > 0.5 {
        f + 1.0
    } else if d < 0.5 {
        f
    } else if (f as i32) & 1 == 0 {
        f
    } else {
        f + 1.0
    };
    r as u8
}

// Replica di _samplePremulInto: bilineare premultiplied dal buffer src;
// fuori [0..sw-1]x[0..sh-1] = trasparente, bordo con clamp.
#[inline(always)]
unsafe fn sample_premul(src: *const u8, sw: i32, sh: i32, fx: f64, fy: f64) -> [f64; 4] {
    if fx < 0.0 || fy < 0.0 || fx > (sw - 1) as f64 || fy > (sh - 1) as f64 {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let x0 = floor64(fx) as i32;
    let y0 = floor64(fy) as i32;
    let x1 = (x0 + 1).min(sw - 1);
    let y1 = (y0 + 1).min(sh - 1);
    let tx = fx - x0 as f64;
    let ty = fy - y0 as f64;
    let i00 = src.offset(((y0 * sw + x0) << 2) as isize);
    let i10 = src.offset(((y0 * sw + x1) << 2) as isize);
    let i01 = src.offset(((y1 * sw + x0) << 2) as isize);
    let i11 = src.offset(((y1 * sw + x1) << 2) as isize);
    let w00 = (1.0 - tx) * (1.0 - ty);
    let w10 = tx * (1.0 - ty);
    let w01 = (1.0 - tx) * ty;
    let w11 = tx * ty;
    [
        *i00 as f64 * w00 + *i10 as f64 * w10 + *i01 as f64 * w01 + *i11 as f64 * w11,
        *i00.add(1) as f64 * w00 + *i10.add(1) as f64 * w10 + *i01.add(1) as f64 * w01 + *i11.add(1) as f64 * w11,
        *i00.add(2) as f64 * w00 + *i10.add(2) as f64 * w10 + *i01.add(2) as f64 * w01 + *i11.add(2) as f64 * w11,
        *i00.add(3) as f64 * w00 + *i10.add(3) as f64 * w10 + *i01.add(3) as f64 * w01 + *i11.add(3) as f64 * w11,
    ]
}

// pf: [0]cx [1]cy [2]pressure [3]drag [4]blurOpacity
//     [5]ffCore [6]ffCore2 [7]ffCut2 [8]ffW
//     [9..12]cW00,cW10,cW01,cW11 [13..16]aW.. [17..20]bW..
//     [21]oCX [22]oCY [23]crossX [24]crossY
// pi: [0]srcPtr [1]sx [2]sy [3]sw [4]sh [5]blurPtr(0=off) [6]hasSmudge
//     [7]cD [8]aD [9]bD [10..13]fwx0,fwx1,fwy0,fwy1
//     [14]selPtr(0=off) [15]selX [16]selY [17]selW [18]selH
//     [19]stampPtr(0=off) [20]stampSize [21]stampIx [22]stampIy
#[no_mangle]
pub unsafe extern "C" fn blur_blend(
    pf_ptr: u32, pi_ptr: u32, base_ptr: u32, out_ptr: u32,
    lx0: u32, ly0: u32, lx1: u32, ly1: u32, ox: i32, oy: i32,
) -> u32 {
    let pf = pf_ptr as usize as *const f64;
    let pi = pi_ptr as usize as *const i32;
    let cx = *pf;
    let cy = *pf.add(1);
    let pressure = *pf.add(2);
    let drag = *pf.add(3);
    let blur_op = *pf.add(4);
    let ff_core = *pf.add(5);
    let ff_core2 = *pf.add(6);
    let ff_cut2 = *pf.add(7);
    let ff_w = *pf.add(8);
    let cw00 = *pf.add(9); let cw10 = *pf.add(10); let cw01 = *pf.add(11); let cw11 = *pf.add(12);
    let aw00 = *pf.add(13); let aw10 = *pf.add(14); let aw01 = *pf.add(15); let aw11 = *pf.add(16);
    let bw00 = *pf.add(17); let bw10 = *pf.add(18); let bw01 = *pf.add(19); let bw11 = *pf.add(20);
    let ocx = *pf.add(21); let ocy = *pf.add(22);
    let crx = *pf.add(23); let cry = *pf.add(24);
    let src = *pi as u32 as usize as *const u8;
    let sx = *pi.add(1); let sy = *pi.add(2);
    let sw = *pi.add(3); let sh = *pi.add(4);
    let blur_p = *pi.add(5);
    let blur = blur_p as u32 as usize as *const u8;
    let has_blur = blur_p != 0;
    let has_smudge = *pi.add(6) != 0;
    let c_d = *pi.add(7) as isize; let a_d = *pi.add(8) as isize; let b_d = *pi.add(9) as isize;
    let fwx0 = *pi.add(10); let fwx1 = *pi.add(11); let fwy0 = *pi.add(12); let fwy1 = *pi.add(13);
    let sel_p = *pi.add(14);
    let sel = sel_p as u32 as usize as *const u8;
    let sel_x = *pi.add(15); let sel_y = *pi.add(16); let sel_w = *pi.add(17); let sel_h = *pi.add(18);
    let stamp_p = *pi.add(19);
    let stamp = stamp_p as u32 as usize as *const u8;
    let stamp_size = *pi.add(20); let stamp_ix = *pi.add(21); let stamp_iy = *pi.add(22);
    let sw4 = (sw as isize) << 2;

    let base = base_ptr as usize as *const u8;
    let out = out_ptr as usize as *mut u8;
    if out_ptr != base_ptr {
        let w4 = (((lx1 - lx0 + 1) as usize) << 2) as usize;
        for ly in ly0..=ly1 {
            let o = (((ly as usize) << CHUNK_SHIFT) + lx0 as usize) << 2;
            core::ptr::copy_nonoverlapping(base.add(o), out.add(o), w4);
        }
    }

    let mut dx0 = 256i32; let mut dy0 = 256i32;
    let mut dx1 = -1i32; let mut dy1 = -1i32;
    for ly in ly0 as i32..=ly1 as i32 {
        let wy = oy + ly;
        let ddy = wy as f64 + 0.5 - cy;
        let dy2 = ddy * ddy;
        let row_d = ((ly as usize) << CHUNK_SHIFT) << 2;
        let si_row = ((wy - sy) * sw + (ox - sx)) as isize;
        let row_fast = has_smudge && wy >= fwy0 && wy <= fwy1;
        for lx in lx0 as i32..=lx1 as i32 {
            let wx = ox + lx;
            let mask: f64;
            if stamp_p != 0 {
                let mx = wx - stamp_ix;
                let my = wy - stamp_iy;
                if mx < 0 || my < 0 || mx >= stamp_size || my >= stamp_size { continue; }
                let mut bm = *stamp.add((my * stamp_size + mx) as usize) as f64 / 255.0;
                if bm <= 0.0 { continue; }
                if sel_p != 0 {
                    let smx = wx - sel_x;
                    let smy = wy - sel_y;
                    if smx < 0 || smy < 0 || smx >= sel_w || smy >= sel_h { continue; }
                    let sm = *sel.add((smy * sel_w + smx) as usize) as f64 / 255.0;
                    if sm <= 0.0 { continue; }
                    bm = sm * bm;
                }
                mask = bm * pressure;
            } else {
                let ddx = wx as f64 + 0.5 - cx;
                let d2 = ddx * ddx + dy2;
                if d2 >= ff_cut2 { continue; }
                let mut bm = if d2 <= ff_core2 {
                    1.0
                } else {
                    let t = (sqrt64(d2) - ff_core) / ff_w;
                    1.0 - t * t * (3.0 - 2.0 * t)
                };
                if sel_p != 0 {
                    let smx = wx - sel_x;
                    let smy = wy - sel_y;
                    if smx < 0 || smy < 0 || smx >= sel_w || smy >= sel_h { continue; }
                    let sm = *sel.add((smy * sel_w + smx) as usize) as f64 / 255.0;
                    if sm <= 0.0 { continue; }
                    bm = sm * bm;
                }
                mask = bm * pressure;
            }
            if mask <= 0.0001 { continue; }

            let di = row_d + ((lx as usize) << 2);
            let si = (si_row + lx as isize) << 2;
            let sp = src.offset(si);
            let sa = *sp.add(3) as i32;
            let mut na = sa;
            let mut nr = *sp as i32;
            let mut ng = *sp.add(1) as i32;
            let mut nb = *sp.add(2) as i32;
            if has_blur {
                let bp = blur.offset(si);
                let ba = *bp.add(3) as i32;
                let blur_mask = mask * blur_op * (1.0 - drag);
                if sa != 0 || ba != 0 {
                    na = i255b(na as f64 + (ba - na) as f64 * blur_mask);
                    nr = i255b(nr as f64 + (*bp as i32 - nr) as f64 * blur_mask).min(na);
                    ng = i255b(ng as f64 + (*bp.add(1) as i32 - ng) as f64 * blur_mask).min(na);
                    nb = i255b(nb as f64 + (*bp.add(2) as i32 - nb) as f64 * blur_mask).min(na);
                }
            }
            if has_smudge {
                let drag_mask = drag * mask;
                if drag_mask > 0.0001 {
                    let tr: f64; let tg: f64; let tb: f64; let ta: f64;
                    if row_fast && wx >= fwx0 && wx <= fwx1 {
                        // path fast: 3 tap bilineari fusi a indici/pesi costanti,
                        // stessa associatività del JS: ((C*w)+..)*0.6 + (..)*0.2 + (..)*0.2
                        let ic = src.offset(si + c_d);
                        let ia = src.offset(si + a_d);
                        let ib = src.offset(si + b_d);
                        tr = (*ic as f64 * cw00 + *ic.offset(4) as f64 * cw10 + *ic.offset(sw4) as f64 * cw01 + *ic.offset(sw4 + 4) as f64 * cw11) * 0.6
                            + (*ia as f64 * aw00 + *ia.offset(4) as f64 * aw10 + *ia.offset(sw4) as f64 * aw01 + *ia.offset(sw4 + 4) as f64 * aw11) * 0.2
                            + (*ib as f64 * bw00 + *ib.offset(4) as f64 * bw10 + *ib.offset(sw4) as f64 * bw01 + *ib.offset(sw4 + 4) as f64 * bw11) * 0.2;
                        tg = (*ic.offset(1) as f64 * cw00 + *ic.offset(5) as f64 * cw10 + *ic.offset(sw4 + 1) as f64 * cw01 + *ic.offset(sw4 + 5) as f64 * cw11) * 0.6
                            + (*ia.offset(1) as f64 * aw00 + *ia.offset(5) as f64 * aw10 + *ia.offset(sw4 + 1) as f64 * aw01 + *ia.offset(sw4 + 5) as f64 * aw11) * 0.2
                            + (*ib.offset(1) as f64 * bw00 + *ib.offset(5) as f64 * bw10 + *ib.offset(sw4 + 1) as f64 * bw01 + *ib.offset(sw4 + 5) as f64 * bw11) * 0.2;
                        tb = (*ic.offset(2) as f64 * cw00 + *ic.offset(6) as f64 * cw10 + *ic.offset(sw4 + 2) as f64 * cw01 + *ic.offset(sw4 + 6) as f64 * cw11) * 0.6
                            + (*ia.offset(2) as f64 * aw00 + *ia.offset(6) as f64 * aw10 + *ia.offset(sw4 + 2) as f64 * aw01 + *ia.offset(sw4 + 6) as f64 * aw11) * 0.2
                            + (*ib.offset(2) as f64 * bw00 + *ib.offset(6) as f64 * bw10 + *ib.offset(sw4 + 2) as f64 * bw01 + *ib.offset(sw4 + 6) as f64 * bw11) * 0.2;
                        ta = (*ic.offset(3) as f64 * cw00 + *ic.offset(7) as f64 * cw10 + *ic.offset(sw4 + 3) as f64 * cw01 + *ic.offset(sw4 + 7) as f64 * cw11) * 0.6
                            + (*ia.offset(3) as f64 * aw00 + *ia.offset(7) as f64 * aw10 + *ia.offset(sw4 + 3) as f64 * aw01 + *ia.offset(sw4 + 7) as f64 * aw11) * 0.2
                            + (*ib.offset(3) as f64 * bw00 + *ib.offset(7) as f64 * bw10 + *ib.offset(sw4 + 3) as f64 * bw01 + *ib.offset(sw4 + 7) as f64 * bw11) * 0.2;
                    } else {
                        // bordo dello snapshot: campionatore generico, stessi
                        // ordini di _blendResult (sourceX = (wx+0.5) + oCX ecc.)
                        let s_x = wx as f64 + 0.5 + ocx;
                        let s_y = wy as f64 + 0.5 + ocy;
                        let sxf = sx as f64;
                        let syf = sy as f64;
                        let p = sample_premul(src, sw, sh, s_x - sxf - 0.5, s_y - syf - 0.5);
                        let pa = sample_premul(src, sw, sh, (s_x + crx) - sxf - 0.5, (s_y + cry) - syf - 0.5);
                        let pb = sample_premul(src, sw, sh, (s_x - crx) - sxf - 0.5, (s_y - cry) - syf - 0.5);
                        tr = p[0] * 0.6 + pa[0] * 0.2 + pb[0] * 0.2;
                        tg = p[1] * 0.6 + pa[1] * 0.2 + pb[1] * 0.2;
                        tb = p[2] * 0.6 + pa[2] * 0.2 + pb[2] * 0.2;
                        ta = p[3] * 0.6 + pa[3] * 0.2 + pb[3] * 0.2;
                    }
                    if sa == 0 && ta <= 0.0001 && !has_blur { continue; }
                    nr = i255b(nr as f64 + (tr - nr as f64) * drag_mask);
                    ng = i255b(ng as f64 + (tg - ng as f64) * drag_mask);
                    nb = i255b(nb as f64 + (tb - nb as f64) * drag_mask);
                    na = i255b(na as f64 + (ta - na as f64) * drag_mask);
                    nr = nr.min(na);
                    ng = ng.min(na);
                    nb = nb.min(na);
                }
            }
            let cp = base.add(di);
            let cr = *cp as i32;
            let cg = *cp.add(1) as i32;
            let cb = *cp.add(2) as i32;
            let ca = *cp.add(3) as i32;
            if nr == cr && ng == cg && nb == cb && na == ca { continue; }
            let op = out.add(di);
            *op = nr as u8;
            *op.add(1) = ng as u8;
            *op.add(2) = nb as u8;
            *op.add(3) = na as u8;
            if lx < dx0 { dx0 = lx; }
            if lx > dx1 { dx1 = lx; }
            if ly < dy0 { dy0 = ly; }
            if ly > dy1 { dy1 = ly; }
        }
    }
    if dx1 < 0 { return u32::MAX; }
    ((dx0 as u32) << 24) | ((dy0 as u32) << 16) | ((dx1 as u32) << 8) | (dy1 as u32)
}

// Variante low-res (replica di _blendUp): base = pixel del chunk, blur/pull
// campionati bilineare dai buffer low con upsampling fuso. Stesso protocollo
// base/out/damage di blur_blend.
// pf: [0..8] come sopra (mask); pi: [0]lowPullPtr(0=off) [1]csx [2]csy
//     [3]lowW [4]lowH [5]lowBlurPtr(0=off) [6]k
//     [14..18]sel [19..22]stamp
#[no_mangle]
pub unsafe extern "C" fn blur_blend_low(
    pf_ptr: u32, pi_ptr: u32, base_ptr: u32, out_ptr: u32,
    lx0: u32, ly0: u32, lx1: u32, ly1: u32, ox: i32, oy: i32,
) -> u32 {
    let pf = pf_ptr as usize as *const f64;
    let pi = pi_ptr as usize as *const i32;
    let cx = *pf;
    let cy = *pf.add(1);
    let pressure = *pf.add(2);
    let drag = *pf.add(3);
    let blur_op = *pf.add(4);
    let ff_core = *pf.add(5);
    let ff_core2 = *pf.add(6);
    let ff_cut2 = *pf.add(7);
    let ff_w = *pf.add(8);
    let pull_p = *pi;
    let pull = pull_p as u32 as usize as *const u8;
    let csx = *pi.add(1);
    let csy = *pi.add(2);
    let low_w = *pi.add(3);
    let low_h = *pi.add(4);
    let blur_p = *pi.add(5);
    let lblur = blur_p as u32 as usize as *const u8;
    let k = *pi.add(6);
    let sel_p = *pi.add(14);
    let sel = sel_p as u32 as usize as *const u8;
    let sel_x = *pi.add(15); let sel_y = *pi.add(16); let sel_w = *pi.add(17); let sel_h = *pi.add(18);
    let stamp_p = *pi.add(19);
    let stamp = stamp_p as u32 as usize as *const u8;
    let stamp_size = *pi.add(20); let stamp_ix = *pi.add(21); let stamp_iy = *pi.add(22);
    let inv_k = 1.0 / k as f64;
    let lw4 = (low_w << 2) as isize;

    let base = base_ptr as usize as *const u8;
    let out = out_ptr as usize as *mut u8;
    if out_ptr != base_ptr {
        let w4 = (((lx1 - lx0 + 1) as usize) << 2) as usize;
        for ly in ly0..=ly1 {
            let o = (((ly as usize) << CHUNK_SHIFT) + lx0 as usize) << 2;
            core::ptr::copy_nonoverlapping(base.add(o), out.add(o), w4);
        }
    }

    let mut dx0 = 256i32; let mut dy0 = 256i32;
    let mut dx1 = -1i32; let mut dy1 = -1i32;
    for ly in ly0 as i32..=ly1 as i32 {
        let wy = oy + ly;
        let ddy = wy as f64 + 0.5 - cy;
        let dy2 = ddy * ddy;
        // riga bilineare del reticolo low (clamp come nel JS: ty resta
        // quello pre-clamp, i pesi degeneri sommano al valore esatto)
        let fy = (wy - csy) as f64 + 0.5;
        let fy = fy * inv_k - 0.5;
        let mut iy0 = floor64(fy) as i32;
        let ty = fy - iy0 as f64;
        let mut iy1 = iy0 + 1;
        if iy0 < 0 {
            iy0 = 0;
            iy1 = 0;
        } else if iy1 >= low_h {
            iy1 = low_h - 1;
        }
        let row_a = iy0 as isize * lw4;
        let row_b = iy1 as isize * lw4;
        let wy_a = 1.0 - ty;
        let wy_b = ty;
        let row_d = ((ly as usize) << CHUNK_SHIFT) << 2;
        for lx in lx0 as i32..=lx1 as i32 {
            let wx = ox + lx;
            let mask: f64;
            if stamp_p != 0 {
                let mx = wx - stamp_ix;
                let my = wy - stamp_iy;
                if mx < 0 || my < 0 || mx >= stamp_size || my >= stamp_size { continue; }
                let mut bm = *stamp.add((my * stamp_size + mx) as usize) as f64 / 255.0;
                if bm <= 0.0 { continue; }
                if sel_p != 0 {
                    let smx = wx - sel_x;
                    let smy = wy - sel_y;
                    if smx < 0 || smy < 0 || smx >= sel_w || smy >= sel_h { continue; }
                    let sm = *sel.add((smy * sel_w + smx) as usize) as f64 / 255.0;
                    if sm <= 0.0 { continue; }
                    bm = sm * bm;
                }
                mask = bm * pressure;
            } else {
                let ddx = wx as f64 + 0.5 - cx;
                let d2 = ddx * ddx + dy2;
                if d2 >= ff_cut2 { continue; }
                let mut bm = if d2 <= ff_core2 {
                    1.0
                } else {
                    let t = (sqrt64(d2) - ff_core) / ff_w;
                    1.0 - t * t * (3.0 - 2.0 * t)
                };
                if sel_p != 0 {
                    let smx = wx - sel_x;
                    let smy = wy - sel_y;
                    if smx < 0 || smy < 0 || smx >= sel_w || smy >= sel_h { continue; }
                    let sm = *sel.add((smy * sel_w + smx) as usize) as f64 / 255.0;
                    if sm <= 0.0 { continue; }
                    bm = sm * bm;
                }
                mask = bm * pressure;
            }
            if mask <= 0.0001 { continue; }

            // pesi bilineari del reticolo low per questo pixel (condivisi
            // da blur e pull) — identici a _blendUp
            let fx = (wx - csx) as f64 + 0.5;
            let fx = fx * inv_k - 0.5;
            let mut ix0 = floor64(fx) as i32;
            let tx = fx - ix0 as f64;
            let mut ix1 = ix0 + 1;
            if ix0 < 0 {
                ix0 = 0;
                ix1 = 0;
            } else if ix1 >= low_w {
                ix1 = low_w - 1;
            }
            let w00 = (1.0 - tx) * wy_a;
            let w10 = tx * wy_a;
            let w01 = (1.0 - tx) * wy_b;
            let w11 = tx * wy_b;
            let a0 = (row_a + ((ix0 as isize) << 2)) as usize;
            let a1 = (row_a + ((ix1 as isize) << 2)) as usize;
            let b0 = (row_b + ((ix0 as isize) << 2)) as usize;
            let b1 = (row_b + ((ix1 as isize) << 2)) as usize;

            let di = row_d + ((lx as usize) << 2);
            let cp = base.add(di);
            let cr = *cp as i32;
            let cg = *cp.add(1) as i32;
            let cb = *cp.add(2) as i32;
            let ca = *cp.add(3) as i32;
            let mut nr = cr;
            let mut ng = cg;
            let mut nb = cb;
            let mut na = ca;
            if blur_p != 0 {
                let ba = *lblur.add(a0 + 3) as f64 * w00 + *lblur.add(a1 + 3) as f64 * w10
                    + *lblur.add(b0 + 3) as f64 * w01 + *lblur.add(b1 + 3) as f64 * w11;
                let blur_mask = mask * blur_op * (1.0 - drag);
                if na != 0 || ba > 0.0001 {
                    let br = *lblur.add(a0) as f64 * w00 + *lblur.add(a1) as f64 * w10
                        + *lblur.add(b0) as f64 * w01 + *lblur.add(b1) as f64 * w11;
                    let bg = *lblur.add(a0 + 1) as f64 * w00 + *lblur.add(a1 + 1) as f64 * w10
                        + *lblur.add(b0 + 1) as f64 * w01 + *lblur.add(b1 + 1) as f64 * w11;
                    let bb = *lblur.add(a0 + 2) as f64 * w00 + *lblur.add(a1 + 2) as f64 * w10
                        + *lblur.add(b0 + 2) as f64 * w01 + *lblur.add(b1 + 2) as f64 * w11;
                    na = i255b(na as f64 + (ba - na as f64) * blur_mask);
                    nr = i255b(nr as f64 + (br - nr as f64) * blur_mask).min(na);
                    ng = i255b(ng as f64 + (bg - ng as f64) * blur_mask).min(na);
                    nb = i255b(nb as f64 + (bb - nb as f64) * blur_mask).min(na);
                }
            }
            if pull_p != 0 {
                let drag_mask = drag * mask;
                if drag_mask > 0.0001 {
                    let ta = *pull.add(a0 + 3) as f64 * w00 + *pull.add(a1 + 3) as f64 * w10
                        + *pull.add(b0 + 3) as f64 * w01 + *pull.add(b1 + 3) as f64 * w11;
                    if ca == 0 && ta <= 0.0001 && blur_p == 0 { continue; }
                    let tr = *pull.add(a0) as f64 * w00 + *pull.add(a1) as f64 * w10
                        + *pull.add(b0) as f64 * w01 + *pull.add(b1) as f64 * w11;
                    let tg = *pull.add(a0 + 1) as f64 * w00 + *pull.add(a1 + 1) as f64 * w10
                        + *pull.add(b0 + 1) as f64 * w01 + *pull.add(b1 + 1) as f64 * w11;
                    let tb = *pull.add(a0 + 2) as f64 * w00 + *pull.add(a1 + 2) as f64 * w10
                        + *pull.add(b0 + 2) as f64 * w01 + *pull.add(b1 + 2) as f64 * w11;
                    nr = i255b(nr as f64 + (tr - nr as f64) * drag_mask);
                    ng = i255b(ng as f64 + (tg - ng as f64) * drag_mask);
                    nb = i255b(nb as f64 + (tb - nb as f64) * drag_mask);
                    na = i255b(na as f64 + (ta - na as f64) * drag_mask);
                    nr = nr.min(na);
                    ng = ng.min(na);
                    nb = nb.min(na);
                }
            }
            if nr == cr && ng == cg && nb == cb && na == ca { continue; }
            let op = out.add(di);
            *op = nr as u8;
            *op.add(1) = ng as u8;
            *op.add(2) = nb as u8;
            *op.add(3) = na as u8;
            if lx < dx0 { dx0 = lx; }
            if lx > dx1 { dx1 = lx; }
            if ly < dy0 { dy0 = ly; }
            if ly > dy1 { dy1 = ly; }
        }
    }
    if dx1 < 0 { return u32::MAX; }
    ((dx0 as u32) << 24) | ((dy0 as u32) << 16) | ((dx1 as u32) << 8) | (dy1 as u32)
}

// Accumulo dello snapshot low-res (replica del loop row-wise di _dabLow):
// 4 campioni stratificati per cella — righe/colonne congruenti a q0/q1
// (mod k) — sommati nel buffer acc u32. Aritmetica intera: esatta ovunque.
#[no_mangle]
pub unsafe extern "C" fn blur_low_acc(
    chunk_ptr: u32, lx0: u32, ly0: u32, lx1: u32, ly1: u32, ox: i32, oy: i32,
    acc_ptr: u32, csx: i32, csy: i32, k: i32, q0: i32, q1: i32, low_w: i32,
) {
    let data = chunk_ptr as usize as *const u8;
    let acc = acc_ptr as usize as *mut u32;
    let wxe = ox + lx1 as i32;
    for ly in ly0 as i32..=ly1 as i32 {
        let wy = oy + ly;
        let ry = (wy - csy) % k;
        if ry != q0 && ry != q1 {
            continue;
        }
        let my_row = ((wy - csy - ry) / k) * low_w;
        for s in 0..2 {
            let sox = if s == 0 { q0 } else { q1 };
            let mut wx0 = ox + lx0 as i32;
            let rx = (wx0 - csx - sox) % k;
            if rx != 0 {
                wx0 += if rx < 0 { -rx } else { k - rx };
            }
            if wx0 > wxe {
                continue;
            }
            let mut o = (((ly as usize) << CHUNK_SHIFT) + (wx0 - ox) as usize) << 2;
            let mut ci = (((my_row + (wx0 - csx - sox) / k) as usize) << 2) as usize;
            let mut wx = wx0;
            while wx <= wxe {
                *acc.add(ci) += *data.add(o) as u32;
                *acc.add(ci + 1) += *data.add(o + 1) as u32;
                *acc.add(ci + 2) += *data.add(o + 2) as u32;
                *acc.add(ci + 3) += *data.add(o + 3) as u32;
                wx += k;
                o += (k as usize) << 2;
                ci += 4;
            }
        }
    }
}

// Media dei 4 campioni accumulati col vincolo premultiplied r,g,b <= a.
#[no_mangle]
pub unsafe extern "C" fn blur_low_div(acc_ptr: u32, out_ptr: u32, low_n: u32) {
    let acc = acc_ptr as usize as *const u32;
    let out = out_ptr as usize as *mut u8;
    let mut o = 0usize;
    while o < low_n as usize {
        let a = (*acc.add(o + 3) + 2) >> 2;
        let r = (*acc.add(o) + 2) >> 2;
        let g = (*acc.add(o + 1) + 2) >> 2;
        let b = (*acc.add(o + 2) + 2) >> 2;
        *out.add(o) = if r > a { a as u8 } else { r as u8 };
        *out.add(o + 1) = if g > a { a as u8 } else { g as u8 };
        *out.add(o + 2) = if b > a { a as u8 } else { b as u8 };
        *out.add(o + 3) = a as u8;
        o += 4;
    }
}

// Pull dello smudge sulla griglia low (replica di _pullLow): 3 tap bilineari
// fusi a offset costante; scrittura u8 con round-half-to-even (semantica
// Uint8ClampedArray del JS). Il bordo ricade sul campionatore generico.
#[no_mangle]
pub unsafe extern "C" fn blur_pull_low(
    src_ptr: u32, w: i32, h: i32, out_ptr: u32,
    ocx: f64, ocy: f64, crx: f64, cry: f64,
) {
    let src = src_ptr as usize as *const u8;
    let out = out_ptr as usize as *mut u8;
    let oax = ocx + crx;
    let oay = ocy + cry;
    let obx = ocx - crx;
    let oby = ocy - cry;
    let xc = floor64(ocx) as i32; let yc = floor64(ocy) as i32;
    let xa = floor64(oax) as i32; let ya = floor64(oay) as i32;
    let xb = floor64(obx) as i32; let yb = floor64(oby) as i32;
    let txc = ocx - xc as f64; let tyc = ocy - yc as f64;
    let txa = oax - xa as f64; let tya = oay - ya as f64;
    let txb = obx - xb as f64; let tyb = oby - yb as f64;
    let w4 = (w as isize) << 2;
    let cd = ((yc * w + xc) << 2) as isize;
    let ad = ((ya * w + xa) << 2) as isize;
    let bd = ((yb * w + xb) << 2) as isize;
    let cw00 = (1.0 - txc) * (1.0 - tyc); let cw10 = txc * (1.0 - tyc);
    let cw01 = (1.0 - txc) * tyc; let cw11 = txc * tyc;
    let aw00 = (1.0 - txa) * (1.0 - tya); let aw10 = txa * (1.0 - tya);
    let aw01 = (1.0 - txa) * tya; let aw11 = txa * tya;
    let bw00 = (1.0 - txb) * (1.0 - tyb); let bw10 = txb * (1.0 - tyb);
    let bw01 = (1.0 - txb) * tyb; let bw11 = txb * tyb;
    let fx0 = (-xc).max(-xa).max(-xb);
    let fx1 = w - 2 - xc.max(xa).max(xb);
    let fy0 = (-yc).max(-ya).max(-yb);
    let fy1 = h - 2 - yc.max(ya).max(yb);
    for iy in 0..h {
        let row_ok = iy >= fy0 && iy <= fy1;
        let mut o = ((iy * w) << 2) as usize;
        for ix in 0..w {
            if row_ok && ix >= fx0 && ix <= fx1 {
                let sp = src.add(o);
                let ic = sp.offset(cd);
                let ia = sp.offset(ad);
                let ib = sp.offset(bd);
                *out.add(o) = u8cr((*ic as f64 * cw00 + *ic.offset(4) as f64 * cw10 + *ic.offset(w4) as f64 * cw01 + *ic.offset(w4 + 4) as f64 * cw11) * 0.6
                    + (*ia as f64 * aw00 + *ia.offset(4) as f64 * aw10 + *ia.offset(w4) as f64 * aw01 + *ia.offset(w4 + 4) as f64 * aw11) * 0.2
                    + (*ib as f64 * bw00 + *ib.offset(4) as f64 * bw10 + *ib.offset(w4) as f64 * bw01 + *ib.offset(w4 + 4) as f64 * bw11) * 0.2);
                *out.add(o + 1) = u8cr((*ic.offset(1) as f64 * cw00 + *ic.offset(5) as f64 * cw10 + *ic.offset(w4 + 1) as f64 * cw01 + *ic.offset(w4 + 5) as f64 * cw11) * 0.6
                    + (*ia.offset(1) as f64 * aw00 + *ia.offset(5) as f64 * aw10 + *ia.offset(w4 + 1) as f64 * aw01 + *ia.offset(w4 + 5) as f64 * aw11) * 0.2
                    + (*ib.offset(1) as f64 * bw00 + *ib.offset(5) as f64 * bw10 + *ib.offset(w4 + 1) as f64 * bw01 + *ib.offset(w4 + 5) as f64 * bw11) * 0.2);
                *out.add(o + 2) = u8cr((*ic.offset(2) as f64 * cw00 + *ic.offset(6) as f64 * cw10 + *ic.offset(w4 + 2) as f64 * cw01 + *ic.offset(w4 + 6) as f64 * cw11) * 0.6
                    + (*ia.offset(2) as f64 * aw00 + *ia.offset(6) as f64 * aw10 + *ia.offset(w4 + 2) as f64 * aw01 + *ia.offset(w4 + 6) as f64 * aw11) * 0.2
                    + (*ib.offset(2) as f64 * bw00 + *ib.offset(6) as f64 * bw10 + *ib.offset(w4 + 2) as f64 * bw01 + *ib.offset(w4 + 6) as f64 * bw11) * 0.2);
                *out.add(o + 3) = u8cr((*ic.offset(3) as f64 * cw00 + *ic.offset(7) as f64 * cw10 + *ic.offset(w4 + 3) as f64 * cw01 + *ic.offset(w4 + 7) as f64 * cw11) * 0.6
                    + (*ia.offset(3) as f64 * aw00 + *ia.offset(7) as f64 * aw10 + *ia.offset(w4 + 3) as f64 * aw01 + *ia.offset(w4 + 7) as f64 * aw11) * 0.2
                    + (*ib.offset(3) as f64 * bw00 + *ib.offset(7) as f64 * bw10 + *ib.offset(w4 + 3) as f64 * bw01 + *ib.offset(w4 + 7) as f64 * bw11) * 0.2);
            } else {
                let p = sample_premul(src, w, h, ix as f64 + ocx, iy as f64 + ocy);
                let pa = sample_premul(src, w, h, ix as f64 + oax, iy as f64 + oay);
                let pb = sample_premul(src, w, h, ix as f64 + obx, iy as f64 + oby);
                *out.add(o) = u8cr(p[0] * 0.6 + pa[0] * 0.2 + pb[0] * 0.2);
                *out.add(o + 1) = u8cr(p[1] * 0.6 + pa[1] * 0.2 + pb[1] * 0.2);
                *out.add(o + 2) = u8cr(p[2] * 0.6 + pa[2] * 0.2 + pb[2] * 0.2);
                *out.add(o + 3) = u8cr(p[3] * 0.6 + pa[3] * 0.2 + pb[3] * 0.2);
            }
            o += 4;
        }
    }
}

// Gaussiana ricorsiva Young–van Vliet, replica di gaussianBlurBuffer in
// js/fx_blur.js: accumulo f32 con intermedi f64 (come fa V8 sui Float32Array),
// coefficienti calcolati in JS e passati qui, riscrittura u8 con round-half-
// to-even (semantica Uint8ClampedArray) e vincolo premultiplied r,g,b <= a.
// f_ptr: scratch f32 da w*h*4 lane (allocato da JS, nessuno stato).
#[no_mangle]
pub unsafe extern "C" fn iir_blur(
    data_ptr: u32, f_ptr: u32, w: u32, h: u32,
    b: f64, c1: f64, c2: f64, c3: f64,
) {
    let n = (w * h * 4) as usize;
    let data = data_ptr as usize as *mut u8;
    let f = f_ptr as usize as *mut f32;
    for i in 0..n {
        *f.add(i) = *data.add(i) as f32;
    }
    let w4 = (w * 4) as usize;
    let h = h as usize;
    // hPass: ricorsione per riga, avanti e indietro, 4 canali in parallelo
    for y in 0..h {
        let row = y * w4;
        let mut r1 = 0f64; let mut r2 = 0f64; let mut r3 = 0f64;
        let mut g1 = 0f64; let mut g2 = 0f64; let mut g3 = 0f64;
        let mut b1 = 0f64; let mut b2 = 0f64; let mut b3 = 0f64;
        let mut a1 = 0f64; let mut a2 = 0f64; let mut a3 = 0f64;
        let mut o = row;
        let end = row + w4;
        while o < end {
            let r = b * *f.add(o) as f64 + c1 * r1 + c2 * r2 + c3 * r3;
            *f.add(o) = r as f32; r3 = r2; r2 = r1; r1 = r;
            let g = b * *f.add(o + 1) as f64 + c1 * g1 + c2 * g2 + c3 * g3;
            *f.add(o + 1) = g as f32; g3 = g2; g2 = g1; g1 = g;
            let bb = b * *f.add(o + 2) as f64 + c1 * b1 + c2 * b2 + c3 * b3;
            *f.add(o + 2) = bb as f32; b3 = b2; b2 = b1; b1 = bb;
            let a = b * *f.add(o + 3) as f64 + c1 * a1 + c2 * a2 + c3 * a3;
            *f.add(o + 3) = a as f32; a3 = a2; a2 = a1; a1 = a;
            o += 4;
        }
        r1 = 0.0; r2 = 0.0; r3 = 0.0; g1 = 0.0; g2 = 0.0; g3 = 0.0;
        b1 = 0.0; b2 = 0.0; b3 = 0.0; a1 = 0.0; a2 = 0.0; a3 = 0.0;
        let mut o = (row + w4 - 4) as isize;
        while o >= row as isize {
            let ou = o as usize;
            let r = b * *f.add(ou) as f64 + c1 * r1 + c2 * r2 + c3 * r3;
            *f.add(ou) = r as f32; r3 = r2; r2 = r1; r1 = r;
            let g = b * *f.add(ou + 1) as f64 + c1 * g1 + c2 * g2 + c3 * g3;
            *f.add(ou + 1) = g as f32; g3 = g2; g2 = g1; g1 = g;
            let bb = b * *f.add(ou + 2) as f64 + c1 * b1 + c2 * b2 + c3 * b3;
            *f.add(ou + 2) = bb as f32; b3 = b2; b2 = b1; b1 = bb;
            let a = b * *f.add(ou + 3) as f64 + c1 * a1 + c2 * a2 + c3 * a3;
            *f.add(ou + 3) = a as f32; a3 = a2; a2 = a1; a1 = a;
            o -= 4;
        }
    }
    // vPass: avanti con innesco a zero (prime 3 righe dedicate), poi indietro
    for y in 0..h {
        let o0 = y * w4;
        if y >= 3 {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o - w4) as f64
                    + c2 * *f.add(o - 2 * w4) as f64 + c3 * *f.add(o - 3 * w4) as f64) as f32;
            }
        } else if y == 2 {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o - w4) as f64
                    + c2 * *f.add(o - 2 * w4) as f64) as f32;
            }
        } else if y == 1 {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o - w4) as f64) as f32;
            }
        } else {
            for i in 0..w4 {
                *f.add(o0 + i) = (b * *f.add(o0 + i) as f64) as f32;
            }
        }
    }
    let mut y = h as isize - 1;
    while y >= 0 {
        let yu = y as usize;
        let o0 = yu * w4;
        if yu + 4 <= h {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o + w4) as f64
                    + c2 * *f.add(o + 2 * w4) as f64 + c3 * *f.add(o + 3 * w4) as f64) as f32;
            }
        } else if yu + 3 == h {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o + w4) as f64
                    + c2 * *f.add(o + 2 * w4) as f64) as f32;
            }
        } else if yu + 2 == h {
            for i in 0..w4 {
                let o = o0 + i;
                *f.add(o) = (b * *f.add(o) as f64 + c1 * *f.add(o + w4) as f64) as f32;
            }
        } else {
            for i in 0..w4 {
                *f.add(o0 + i) = (b * *f.add(o0 + i) as f64) as f32;
            }
        }
        y -= 1;
    }
    // riscrittura: alpha prima, canali col vincolo premultiplied
    let mut i = 0usize;
    while i < n {
        let a = u8cr(*f.add(i + 3) as f64);
        *data.add(i + 3) = a;
        let af = a as f64;
        let r = *f.add(i) as f64;
        *data.add(i) = u8cr(if r < af { r } else { af });
        let g = *f.add(i + 1) as f64;
        *data.add(i + 1) = u8cr(if g < af { g } else { af });
        let bl = *f.add(i + 2) as f64;
        *data.add(i + 2) = u8cr(if bl < af { bl } else { af });
        i += 4;
    }
}
