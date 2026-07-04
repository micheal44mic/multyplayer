import"./modulepreload-polyfill-Dezn_h7o.js";import{a as e,i as t,p as n,t as r}from"./capsule_int-DfYiQd3u.js";import{c as i,p as a,r as o,t as s}from"./raster-DbHDoJQ2.js";var c=`
struct Params {
  n: u32,
  originX: i32,
  originY: i32,
  width: u32,
  height: u32,
  clipX0: i32,
  clipY0: i32,
  clipX1: i32,
  clipY1: i32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> pix: array<u32>;
@group(0) @binding(1) var<storage, read> masks: array<u32>;
// dab piatti, stride 12 u32: ix, iy, size, maskOff, a255, r, g, b, buildup, pad*3
@group(0) @binding(2) var<storage, read> dabs: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;

// stessa identita' intera di util.js: ((x+128) + ((x+128)>>8)) >> 8
fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn maskByte(off: u32) -> u32 {
  return (masks[off >> 2u] >> (8u * (off & 3u))) & 0xffu;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let gx = P.originX + i32(gid.x);
  let gy = P.originY + i32(gid.y);
  // il raster clampa i bbox al clip del tratto: qui il clip taglia per pixel
  if (gx < P.clipX0 || gx > P.clipX1 || gy < P.clipY0 || gy > P.clipY1) { return; }
  let pi = gid.y * P.width + gid.x;
  let p = pix[pi];
  var pr = p & 0xffu;
  var pg = (p >> 8u) & 0xffu;
  var pb = (p >> 16u) & 0xffu;
  var pa = (p >> 24u) & 0xffu;
  var wrote = false;
  for (var i = 0u; i < P.n; i = i + 1u) {
    let o = i * 12u;
    let mx = gx - bitcast<i32>(dabs[o]);
    let my = gy - bitcast<i32>(dabs[o + 1u]);
    let size = dabs[o + 2u];
    if (mx < 0 || my < 0 || mx >= i32(size) || my >= i32(size)) { continue; }
    let m = maskByte(dabs[o + 3u] + u32(my) * size + u32(mx));
    if (m == 0u) { continue; }
    let ma = div255(m * dabs[o + 4u]);
    if (ma == 0u) { continue; }
    if (dabs[o + 8u] != 0u) {
      // buildup: source-over incrementale (mai oltre 255 per identita')
      let inv = 255u - ma;
      pr = div255(dabs[o + 5u] * ma) + div255(pr * inv);
      pg = div255(dabs[o + 6u] * ma) + div255(pg * inv);
      pb = div255(dabs[o + 7u] * ma) + div255(pb * inv);
      pa = ma + div255(pa * inv);
      wrote = true;
    } else if (ma >= pa) {
      // wash: max(alpha), a parita' vince l'ULTIMO dab (>=)
      pr = div255(dabs[o + 5u] * ma);
      pg = div255(dabs[o + 6u] * ma);
      pb = div255(dabs[o + 7u] * ma);
      pa = ma;
      wrote = true;
    }
  }
  if (wrote) {
    pix[pi] = pr | (pg << 8u) | (pb << 16u) | (pa << 24u);
  }
}
`,l=class{constructor(){this.device=null,this.pipeline=null,this.ok=!1}async init(){let e=navigator.gpu;if(!e)return!1;let t=await e.requestAdapter();if(!t)return!1;this.device=await t.requestDevice();let n=this.device.createShaderModule({code:c});return this.pipeline=await this.device.createComputePipelineAsync({layout:`auto`,compute:{module:n,entryPoint:`main`}}),this.ok=!0,!0}async runBatch(e,t,n,r,i,a,o,s,c){let l=this.device,u=l.createBuffer({size:e.byteLength,usage:140});l.queue.writeBuffer(u,0,e);let d=a.byteLength+3&-4,f=l.createBuffer({size:Math.max(4,d),usage:136});l.queue.writeBuffer(f,0,a,0,a.byteLength);let p=l.createBuffer({size:Math.max(4,o.byteLength),usage:136});l.queue.writeBuffer(p,0,o);let m=new ArrayBuffer(48),h=new Uint32Array(m),g=new Int32Array(m);h[0]=s,g[1]=r,g[2]=i,h[3]=t,h[4]=n,g[5]=c.x0,g[6]=c.y0,g[7]=c.x1,g[8]=c.y1;let _=l.createBuffer({size:48,usage:72});l.queue.writeBuffer(_,0,m);let v=l.createBuffer({size:e.byteLength,usage:9}),y=l.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:u}},{binding:1,resource:{buffer:f}},{binding:2,resource:{buffer:p}},{binding:3,resource:{buffer:_}}]}),b=performance.now(),x=l.createCommandEncoder(),S=x.beginComputePass();S.setPipeline(this.pipeline),S.setBindGroup(0,y),S.dispatchWorkgroups(Math.ceil(t/8),Math.ceil(n/8)),S.end(),x.copyBufferToBuffer(u,0,v,0,e.byteLength),l.queue.submit([x.finish()]),await v.mapAsync(1);let C=performance.now()-b;e.set(new Uint8Array(v.getMappedRange())),v.unmap();for(let e of[u,f,p,_,v])e.destroy();return C}},u=1024,d=1024,f=10,p=e=>console.log(e),m=0;function h(e,t){p((e?`ok   `:`FAIL `)+t),e||m++}function g(e={}){return{baseR:12,diam:24,opacity:1,hardness:.85,roundness:1,shape:null,shapeInvert:!1,baseAngle:0,rotation:0,spacing:.04,smoothing:0,direct:!1,pressureSize:0,pressureCurveX:.5,pressureCurveY:.5,stabilizationMode:`smart`,scatter:!1,partN:1,partSize:.5,partDev:0,jPos:0,jSize:0,jOp:0,jSpacing:0,jAngle:0,jBright:0,jSat:0,aqua:!1,aquaColorMix:0,aquaWetness:.5,aquaLighten:!1,buildup:!1,alphaCompPow:1,taperStart:0,taperEnd:0,speedScale:1,tex:null,texScale:1,texAngle:0,texCos:1,texSin:0,texMoving:!1,texLut:null,texColor:!1,texColorLut:null,colR:30,colG:90,colB:200,hsv:{h:0,s:0,v:0},eraser:!1,continuous:!1,globalOpacity:1,seed:7,rng:n(7),tmpRgb:{r:0,g:0,b:0},...e}}function _(e){let t=new Float32Array(e.length*f);for(let n=0;n<e.length;n++){let r=e[n],i=n*f;t[i]=0,t[i+1]=r.x,t[i+2]=r.y,t[i+3]=r.r,t[i+4]=r.a,t[i+5]=r.angle??0,t[i+6]=r.cr??30,t[i+7]=r.cg??90,t[i+8]=r.cb??200,t[i+9]=0}return t}function v(e,t,n,r=60){let i=n.x1-n.x0+1,a=n.y1-n.y0+1,o=[];for(let s=0;s<t;s++)o.push({x:n.x0-40+e()*(i+80),y:n.y0-40+e()*(a+80),r:.6+e()*r,a:e()<.08?0:.05+e()*.95,angle:e()*7,cr:e()*255|0,cg:e()*255|0,cb:e()*255|0});return o}async function y(e,t,n,r,c){let l=r.length/f,p=new i,m=new a(`ref`,null),g=new s(m,p,null);g.beginStroke(n,c,null,null);let _=new o;for(let e=0;e<l;e++){let t=e*f;_.push(r[t],r[t+1],r[t+2],r[t+3],r[t+4],r[t+5],r[t+6],r[t+7],r[t+8],r[t+9])}let v=performance.now();g.run(_,1/0);let y=performance.now()-v,b=new Map,x=[],S=0,C=new Uint32Array(l*12),w=new Int32Array(C.buffer),T=0;for(let e=0;e<l;e++){let t=e*f,i=r[t+1],a=r[t+2],o=r[t+3],s=r[t+4],c=r[t+5],l=Math.min(255,s*255+.5|0);if(l===0)continue;let u=p.getStamp(o,n.hardness,n.roundness,c,n.shape,n.shapeInvert),d=b.get(u);d===void 0&&(d=S,b.set(u,d),x.push(u.mask),S+=u.mask.length);let m=T*12;w[m]=Math.round(i-u.half),w[m+1]=Math.round(a-u.half),C[m+2]=u.size,C[m+3]=d,C[m+4]=l,C[m+5]=r[t+6],C[m+6]=r[t+7],C[m+7]=r[t+8],C[m+8]=+!!n.buildup,T++}let E=new Uint8Array(S);{let e=0;for(let t of x)E.set(t,e),e+=t.length}let D=new Uint8Array(u*d*4),O=await e.runBatch(D,u,d,0,0,E,C.subarray(0,T*12),T,c),k=0,A=0,j=new Uint8Array(16);m.map.forEach(e=>{let t=e.cx*256,n=e.cy*256;if(t<0||n<0||t>=u||n>=d)return;j[(e.cy<<2)+e.cx]=1;let r=e.data;for(let e=0;e<256;e++){let i=((n+e)*u+t)*4,a=e*256*4;for(let e=0;e<256*4;e++)r[a+e]!==D[i+e]&&k++,r[a+e]!==0&&A++}});let M=0;for(let e=0;e<4;e++)for(let t=0;t<4;t++){if(j[(e<<2)+t])continue;let n=t*256,r=e*256;for(let e=0;e<256;e++){let t=((r+e)*u+n)*4;for(let e=0;e<256*4;e++)D[t+e]!==0&&M++}}h(k===0,`${t}: 0 byte diversi (${k}; ref ha ${A} byte dipinti, ${T}/${l} dab, atlas ${(S/1024).toFixed(0)}KB, js ${y.toFixed(1)}ms vs gpu ${O.toFixed(1)}ms)`),h(M===0,`${t}: nessuna scrittura GPU fuori dai chunk del riferimento (${M})`)}async function b(){p(`kernel WebGPU dab vs Rasterizer JS — regione 1024², descrittori f32 condivisi`);let e=new l;if(!navigator.gpu)return p(`navigator.gpu ASSENTE — il contesto non è sicuro (serve HTTPS o localhost) oppure il browser non espone WebGPU. isSecureContext = `+window.isSecureContext),p(`Se isSecureContext è true: il browser non ha WebGPU attivo — su iPhone/iPad vecchi va acceso in Impostazioni > Safari > Avanzate > Feature Flags > WebGPU.`),p(`UA: `+navigator.userAgent),{ok:!1,failures:-1,webgpu:!1};if(!await e.init())return p(`WebGPU presente ma nessun adapter/device: GPU in blocklist o limiti del device.`),p(`UA: `+navigator.userAgent),{ok:!1,failures:-1,webgpu:!1};let t={x0:0,y0:0,x1:1023,y1:1023};await y(e,`wash tondo`,g(),_(v(n(11),140,t)),t),await y(e,`wash soft (hardness 0)`,g({hardness:0}),_(v(n(23),120,t)),t),await y(e,`wash duro (hardness 1, banda AA 1px)`,g({hardness:1}),_(v(n(31),120,t)),t);let r=[];for(let e=0;e<24;e++)r.push({x:300.37,y:412.81,r:40,a:.5,cr:e*10,cg:255-e*10,cb:7*e});for(let e=0;e<16;e++)r.push({x:600.5,y:200.5,r:30,a:.2+e*.05,cr:200,cg:e*15,cb:30});for(let e=0;e<16;e++)r.push({x:600.5,y:500.5,r:30,a:.95-e*.05,cr:10,cg:e*15,cb:200});await y(e,`tie-break e scalette di alpha`,g(),_(r),t),await y(e,`ellisse ruotata (roundness 0.35)`,g({roundness:.35}),_(v(n(47),120,t)),t);let i=[];for(let e=0;e<200;e++)i.push({x:100+e*4,y:480+Math.sin(e/9)*60,r:22,a:.15,cr:180,cg:40,cb:90});await y(e,`buildup accumulo`,g({buildup:!0}),_(i),t);let a={x0:100,y0:100,x1:400,y1:300};return await y(e,`clip stretto a cavallo`,g(),_(v(n(59),120,a,80)),a),await y(e,`dab giganti (r 300)`,g(),_([{x:250,y:250,r:300,a:.8,cr:20,cg:120,cb:240},{x:700,y:300,r:300,a:.45,cr:240,cg:80,cb:20},{x:500,y:700,r:290,a:1,cr:60,cg:200,cb:60},{x:-80,y:900,r:300,a:.6,cr:200,cg:200,cb:0}]),t),p(m===0?`ALL WGPU DAB TESTS PASS`:`${m} FAILURE(S)`),{ok:m===0,failures:m,webgpu:!0}}function x(e){p=e}var S=`
struct Params {
  n: u32,
  originX: i32,
  originY: i32,
  width: u32,
  height: u32,
  clipX0: i32,
  clipY0: i32,
  clipX1: i32,
  clipY1: i32,
  hq: u32,
  colR: u32,
  colG: u32,
  colB: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> pix: array<u32>;
@group(0) @binding(1) var<storage, read> lut: array<u32>;   // FALLOFF_LUT u16 a coppie
@group(0) @binding(2) var<storage, read> segs: array<i32>;  // stride 10: X0,Y0,DX,DY,den,R0,DR,A0,DA,pad
@group(0) @binding(3) var<uniform> P: Params;

fn div255(x: u32) -> u32 {
  let t = x + 128u;
  return (t + (t >> 8u)) >> 8u;
}

fn lut16(i: u32) -> u32 {
  return (lut[i >> 1u] >> (16u * (i & 1u))) & 0xffffu;
}

// a*b a 64 bit come (hi, lo), tutto in u32
fn mul64(a: u32, b: u32) -> vec2<u32> {
  let a0 = a & 0xffffu; let a1 = a >> 16u;
  let b0 = b & 0xffffu; let b1 = b >> 16u;
  let ll = a0 * b0;
  let lh = a0 * b1;
  let hl = a1 * b0;
  let mid = lh + hl;
  let carry = select(0u, 0x10000u, mid < lh);
  let lo = ll + (mid << 16u);
  let c2 = select(0u, 1u, lo < ll);
  let hi = a1 * b1 + (mid >> 16u) + carry + c2;
  return vec2<u32>(hi, lo);
}

// (a64 <= b64)? confronto di coppie (hi,lo)
fn le64(a: vec2<u32>, b: vec2<u32>) -> bool {
  return a.x < b.x || (a.x == b.x && a.y <= b.y);
}

// floor((num<<16 + den/2)/den) — t ARROTONDATO, 0 < num < den <= 2^25:
// risultato <= 65536. f32 approssima, le verifiche esatte a 64 bit correggono.
fn divT(num: u32, den: u32) -> u32 {
  let lo0 = num << 16u;
  let lo = lo0 + (den >> 1u);
  let n64 = vec2<u32>((num >> 16u) + select(0u, 1u, lo < lo0), lo);
  var q = u32(clamp(f32(num) * 65536.0 / f32(den) + 0.5, 0.0, 65536.0));
  for (var k = 0u; k < 8u; k = k + 1u) {
    if (!le64(mul64(q, den), n64)) {          // q*den > num<<16 -> troppo alto
      q = q - 1u;
    } else if (le64(mul64(q + 1u, den), n64)) { // (q+1)*den <= num<<16 -> troppo basso
      q = q + 1u;
    } else {
      break;
    }
  }
  return q;
}

// round(sqrt(n)) esatto, n < 2^31 (mai tie): f32 approssima, i quadrati
// esatti in u32 correggono il floor, poi n > s²+s decide l'arrotondamento
fn isqrtRound(n: u32) -> u32 {
  var s = min(u32(sqrt(f32(n))), 46340u);
  for (var k = 0u; k < 4u; k = k + 1u) {
    if (s * s > n) {
      s = s - 1u;
    } else if ((s + 1u) * (s + 1u) <= n) {
      s = s + 1u;
    } else {
      break;
    }
  }
  if (n > s * s + s) { s = s + 1u; }
  return s;
}

// ma (0..255) della capsula al pixel (px,py in 1/16 px) — riga per riga
// speculare a capsuleIntMa in capsule_int.js
fn capsuleMa(o: u32, px: i32, py: i32) -> u32 {
  let rx = px - segs[o];
  let ry = py - segs[o + 1u];
  let dx = segs[o + 2u];
  let dy = segs[o + 3u];
  let r0 = segs[o + 5u];
  let dr = segs[o + 6u];
  // scarto rapido: box di Chebyshev attorno ai due estremi, gonfiato di
  // Rmax+1px — soprainsieme del disco, l'output non cambia
  let rmax = max(r0, r0 + dr);
  let pad = rmax + 32;
  if (rx < min(0, dx) - pad || rx > max(0, dx) + pad ||
      ry < min(0, dy) - pad || ry > max(0, dy) + pad) { return 0u; }
  let den = segs[o + 4u];
  let num = rx * dx + ry * dy;
  var tq: u32;
  if (den == 0 || num <= 0) { tq = 0u; }
  else if (num >= den) { tq = 65536u; }
  else { tq = divT(u32(num), u32(den)); }
  let ti = i32(tq);
  let qx = rx - ((dx * ti) >> 16u);
  let qy = ry - ((dy * ti) >> 16u);
  let rT = r0 + ((dr * ti) >> 16u);
  let lim = rT + 32;
  if (lim <= 0) { return 0u; }
  // d² in u32: qx²+qy² può superare i31 (q fino a ~2^15.2 post-cull)
  let d2 = u32(qx * qx) + u32(qy * qy);
  let ulim = u32(lim);
  if (d2 >= ulim * ulim) { return 0u; }
  let aT = segs[o + 7u] + ((segs[o + 8u] * (ti >> 4u)) >> 12u);
  if (aT <= 0) { return 0u; }
  let core = (rT * i32(P.hq)) >> 12u;
  let w = u32(max(rT - core, 32));
  let d = i32(isqrtRound(d2));
  var u: u32 = 0u;
  if (d > core) { u = (u32((d - core) * 1024) + (w >> 1u)) / w; }
  if (u >= 1024u) { return 0u; }
  let m = lut16(u);
  return (m * u32(aT) + (1u << 22u)) >> 23u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= P.width || gid.y >= P.height) { return; }
  let gx = P.originX + i32(gid.x);
  let gy = P.originY + i32(gid.y);
  if (gx < P.clipX0 || gx > P.clipX1 || gy < P.clipY0 || gy > P.clipY1) { return; }
  let px = gx * 32 + 16;
  let py = gy * 32 + 16;
  let pi = gid.y * P.width + gid.x;
  let p = pix[pi];
  var pr = p & 0xffu;
  var pg = (p >> 8u) & 0xffu;
  var pb = (p >> 16u) & 0xffu;
  var pa = (p >> 24u) & 0xffu;
  var wrote = false;
  for (var i = 0u; i < P.n; i = i + 1u) {
    let ma = capsuleMa(i * 10u, px, py);
    if (ma > pa) {
      pr = div255(P.colR * ma);
      pg = div255(P.colG * ma);
      pb = div255(P.colB * ma);
      pa = ma;
      wrote = true;
    }
  }
  if (wrote) {
    pix[pi] = pr | (pg << 8u) | (pb << 16u) | (pa << 24u);
  }
}
`,C=class{constructor(){this.device=null,this.pipeline=null,this.ok=!1}async init(){let e=navigator.gpu;if(!e)return!1;let t=await e.requestAdapter();if(!t)return!1;this.device=await t.requestDevice();let n=this.device.createShaderModule({code:S});return this.pipeline=await this.device.createComputePipelineAsync({layout:`auto`,compute:{module:n,entryPoint:`main`}}),this.ok=!0,!0}async runBatch(e,t,n,r,i,a,o,s,c,l,u,d,f){let p=this.device,m=p.createBuffer({size:e.byteLength,usage:140});p.queue.writeBuffer(m,0,e);let h=a.byteLength+3&-4,g=p.createBuffer({size:h,usage:136});if(p.queue.writeBuffer(g,0,a,0,a.length-(a.length&1)),a.length&1){let e=new Uint16Array(2);e[0]=a[a.length-1],p.queue.writeBuffer(g,(a.length-1)*2,e)}let _=p.createBuffer({size:Math.max(4,o.byteLength),usage:136});p.queue.writeBuffer(_,0,o);let v=new ArrayBuffer(64),y=new Uint32Array(v),b=new Int32Array(v);y[0]=s,b[1]=r,b[2]=i,y[3]=t,y[4]=n,b[5]=f.x0,b[6]=f.y0,b[7]=f.x1,b[8]=f.y1,y[9]=c,y[10]=l,y[11]=u,y[12]=d;let x=p.createBuffer({size:64,usage:72});p.queue.writeBuffer(x,0,v);let S=p.createBuffer({size:e.byteLength,usage:9}),C=p.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:m}},{binding:1,resource:{buffer:g}},{binding:2,resource:{buffer:_}},{binding:3,resource:{buffer:x}}]}),w=performance.now(),T=p.createCommandEncoder(),E=T.beginComputePass();E.setPipeline(this.pipeline),E.setBindGroup(0,C),E.dispatchWorkgroups(Math.ceil(t/8),Math.ceil(n/8)),E.end(),T.copyBufferToBuffer(m,0,S,0,e.byteLength),p.queue.submit([T.finish()]),await S.mapAsync(1);let D=performance.now()-w;e.set(new Uint8Array(S.getMappedRange())),S.unmap();for(let e of[m,g,_,x,S])e.destroy();return D}},w=1024,T=1024,E=10,D=e=>console.log(e),O=0;function k(e,t){D((e?`ok   `:`FAIL `)+t),e||O++}function A(e){return{baseR:12,diam:24,opacity:1,hardness:e,roundness:1,shape:null,shapeInvert:!1,baseAngle:0,rotation:0,spacing:.04,smoothing:0,direct:!1,pressureSize:0,pressureCurveX:.5,pressureCurveY:.5,stabilizationMode:`smart`,scatter:!1,partN:1,partSize:.5,partDev:0,jPos:0,jSize:0,jOp:0,jSpacing:0,jAngle:0,jBright:0,jSat:0,aqua:!1,aquaColorMix:0,aquaWetness:.5,aquaLighten:!1,buildup:!1,alphaCompPow:1,taperStart:0,taperEnd:0,speedScale:1,tex:null,texScale:1,texAngle:0,texCos:1,texSin:0,texMoving:!1,texLut:null,texColor:!1,texColorLut:null,colR:30,colG:90,colB:200,hsv:{h:0,s:0,v:0},eraser:!1,continuous:!0,globalOpacity:1,seed:7,rng:n(7),tmpRgb:{r:0,g:0,b:0}}}function j(e,t,n,r,i,a){let o=[],s=120+e()*500,c=120+e()*500,l=e()*Math.PI*2,u=r;for(let d=0;d<t;d++){l+=(e()-.5)*.9;let f=s+Math.cos(l)*n*(.5+e()),p=c+Math.sin(l)*n*(.5+e()),m=Math.max(.3,r+Math.sin(d/7)*i+(e()-.5)*i*.3),h=a?.15+d/t*.8:1,g=a?.15+.8*((d+1)/t):1;o.push([s,c,u,h,f,p,m,g]),s=f,c=p,u=m}let d=new Float32Array(o.length*E);for(let e=0;e<o.length;e++){let t=e*E,n=o[e];d[t]=1,d[t+1]=n[0],d[t+2]=n[1],d[t+3]=n[2],d[t+4]=n[3],d[t+5]=n[4],d[t+6]=n[5],d[t+7]=n[6],d[t+8]=n[7],d[t+9]=0}return d}async function M(n,c,l,u,d){let f=l.length/E,p=Math.round(u*4096),m=new a(`ref`,null),h=new s(m,new i,null);h.beginStroke(A(u),d,null,null);let g=new o;for(let e=0;e<f;e++){let t=e*E;g.push(l[t],l[t+1],l[t+2],l[t+3],l[t+4],l[t+5],l[t+6],l[t+7],l[t+8],l[t+9])}let _=performance.now();h.run(g,1/0);let v=performance.now()-_,y=new Uint8Array(w*T*4);m.map.forEach(e=>{let t=e.cx*256,n=e.cy*256;if(!(t<0||n<0||t>=w||n>=T))for(let r=0;r<256;r++)y.set(e.data.subarray(r*256*4,(r+1)*256*4),((n+r)*w+t)*4)});let b=[];for(let e=0;e<f;e++){let n=e*E;t(l[n+1],l[n+2],l[n+3],l[n+4],l[n+5],l[n+6],l[n+7],l[n+8],b)}let x=new Int32Array(b),S=x.length/10,C=new Uint8Array(w*T*4),D=performance.now();e(C,w,T,0,0,x,S,p,30,90,200,d);let O=performance.now()-D,j=new Uint8Array(w*T*4),M=await n.runBatch(j,w,T,0,0,r,x,S,p,30,90,200,d),N=0;for(let e=0;e<C.length;e++)C[e]!==j[e]&&N++;k(N===0,`${c} [A determinismo]: 0 byte diversi JS-int vs GPU (${N}; ${S} tratte da ${f} seg, js-int ${O.toFixed(1)}ms, gpu ${M.toFixed(1)}ms)`);let P=0,F=0,I=0,L=0;for(let e=3;e<y.length;e+=4){let t=y[e],n=C[e];(t>0||n>0)&&P++;let r=Math.abs(t-n);r>0&&(F++,L+=r,r>I&&(I=r))}let R=P?F/P*100:0,z=F?L/F:0;k(I===0,`${c} [B motore==spec]: maxΔalpha ${I} (atteso 0), pixel diversi ${F}/${P} (${R.toFixed(2)}%), Δ medio ${z.toFixed(2)}, motore ${v.toFixed(1)}ms`)}async function N(){D(`capsule v2 a interi — (A) JS-int vs WGSL 0-diff, (B) fedeltà vs v1 float`);let e=new C;if(!navigator.gpu||!await e.init())return D(`WebGPU non disponibile: suite capsule saltata.`),{ok:!1,failures:-1,webgpu:!1};let t={x0:0,y0:0,x1:1023,y1:1023};await M(e,`catena densa r12 h0.85`,j(n(101),120,5,12,4,!1),.85,t),await M(e,`catena r60→300 h0.5`,j(n(202),40,22,160,140,!1),.5,t),await M(e,`catena soft h0`,j(n(303),80,8,30,10,!1),0,t),await M(e,`catena dura h1 (AA 1px)`,j(n(404),80,8,30,10,!1),1,t),await M(e,`alpha in rampa`,j(n(505),90,7,20,6,!0),.85,t);let r=new Float32Array(E);r[0]=1,r[1]=60.3,r[2]=980.7,r[3]=4,r[4]=1,r[5]=990.2,r[6]=80.4,r[7]=40,r[8]=1,await M(e,`linea snap 1300px con split`,r,.85,t);let i=new Float32Array(4*E),a=(e,t)=>{i[e*E]=1;for(let n=0;n<8;n++)i[e*E+1+n]=t[n]};return a(0,[400.5,400.5,25,1,400.5,400.5,25,1]),a(1,[500.2,300.9,.3,1,540.7,310.1,.35,1]),a(2,[200,600,18,0,260,640,18,0]),a(3,[700.5,700.5,12,1,700.9,700.6,12,1]),await M(e,`degeneri (len0, r0.3, a0)`,i,.85,t),await M(e,`clip stretto`,j(n(606),100,9,26,12,!1),.85,{x0:200,y0:200,x1:500,y1:420}),D(O===0?`ALL CAPSULE V2 TESTS PASS`:`${O} FAILURE(S) capsule`),{ok:O===0,failures:O,webgpu:!0}}function P(e){D=e}var F=document.getElementById(`out`);F.textContent=``;var I=e=>{let t=document.createElement(`span`);t.textContent=e+`
`,e.startsWith(`FAIL`)||e.includes(`FAILURE`)?t.className=`fail`:(e.startsWith(`ok`)||e.includes(`PASS`))&&(t.className=`ok`),F.appendChild(t),console.log(`[wgpu-test]`,e)};x(I),P(I),(async()=>{let e=await b();I(``);let t=await N();window.__wgpuTestResult={ok:e.ok&&t.ok,dab:e,capsule:t}})().catch(e=>{window.__wgpuTestResult={ok:!1,error:String(e&&e.stack||e)};let t=document.createElement(`span`);t.className=`fail`,t.textContent=`ERRORE: `+(e&&e.stack||e),F.appendChild(t)});