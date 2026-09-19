/* Plan du campus — core: math, WebGL helpers, binary decoders */
'use strict';

/* ---------- mat4 / vec3 (column-major, WebGL order) ---------- */
const M4 = {
  create() { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },
  perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    out[0]=f/aspect; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=f; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=(far+near)*nf; out[11]=-1;
    out[12]=0; out[13]=0; out[14]=2*far*near*nf; out[15]=0;
    return out;
  },
  ortho(out, l, r, b, t, n, f) {
    const lr=1/(l-r), bt=1/(b-t), nf=1/(n-f);
    out[0]=-2*lr; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=-2*bt; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=2*nf; out[11]=0;
    out[12]=(l+r)*lr; out[13]=(t+b)*bt; out[14]=(f+n)*nf; out[15]=1;
    return out;
  },
  lookAt(out, eye, center, up) {
    let z0=eye[0]-center[0], z1=eye[1]-center[1], z2=eye[2]-center[2];
    let len = Math.hypot(z0,z1,z2) || 1; z0/=len; z1/=len; z2/=len;
    let x0 = up[1]*z2 - up[2]*z1, x1 = up[2]*z0 - up[0]*z2, x2 = up[0]*z1 - up[1]*z0;
    len = Math.hypot(x0,x1,x2);
    if (!len) { x0=0; x1=0; x2=0; } else { x0/=len; x1/=len; x2/=len; }
    const y0 = z1*x2 - z2*x1, y1 = z2*x0 - z0*x2, y2 = z0*x1 - z1*x0;
    out[0]=x0; out[1]=y0; out[2]=z0; out[3]=0;
    out[4]=x1; out[5]=y1; out[6]=z1; out[7]=0;
    out[8]=x2; out[9]=y2; out[10]=z2; out[11]=0;
    out[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]);
    out[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]);
    out[14]=-(z0*eye[0]+z1*eye[1]+z2*eye[2]);
    out[15]=1;
    return out;
  },
  mul(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0=b[c*4], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
      out[c*4]   = a[0]*b0 + a[4]*b1 + a[8]*b2  + a[12]*b3;
      out[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2  + a[13]*b3;
      out[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
      out[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
    }
    return out;
  },
  transform(out, m, x, y, z) {
    const w = m[3]*x + m[7]*y + m[11]*z + m[15];
    out[0] = m[0]*x + m[4]*y + m[8]*z + m[12];
    out[1] = m[1]*x + m[5]*y + m[9]*z + m[13];
    out[2] = m[2]*x + m[6]*y + m[10]*z + m[14];
    out[3] = w;
    return out;
  }
};

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;

/* ---------- binary decoding ---------- */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('no-ds');
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  u8() { return this.b[this.p++]; }
  uv() { // varint
    let x = 0, s = 0, c;
    do { c = this.b[this.p++]; x |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
    return x >>> 0;
  }
  zz() { const u = this.uv(); return (u >>> 1) ^ -(u & 1); }
  get done() { return this.p >= this.b.length; }
}

/* ---------- WebGL helpers ---------- */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l,i)=>(i+1)+': '+l).join('\n'));
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {}, a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace('[0]','')] = gl.getUniformLocation(p, info.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, a };
}

function vao(gl, attribs, indices) {
  const v = gl.createVertexArray();
  const bufs = [];
  gl.bindVertexArray(v);
  for (const at of attribs) {
    const buf = gl.createBuffer();
    bufs.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, at.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(at.loc);
    gl.vertexAttribPointer(at.loc, at.size, at.type || gl.FLOAT, at.norm || false, at.stride || 0, at.offset || 0);
  }
  let count = 0, ibuf = null, itype = 0;
  if (indices) {
    ibuf = gl.createBuffer();
    bufs.push(ibuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    count = indices.length;
    itype = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }
  gl.bindVertexArray(null);
  return { v, count, itype, bufs };
}

/* libère un maillage dynamique (repère de position, tracé d'itinéraire) */
function disposeVao(gl, m) {
  if (!m) return;
  for (const b of m.bufs || []) gl.deleteBuffer(b);
  gl.deleteVertexArray(m.v);
}

/* ---------- ear-clipping triangulation (simple polygons) ---------- */
function triangulate(pts) {
  const n = pts.length / 2;
  if (n < 3) return [];
  const idx = []; for (let i = 0; i < n; i++) idx.push(i);
  // ensure counter-clockwise order (this sum is positive for CCW rings)
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (pts[j*2] - pts[i*2]) * (pts[j*2+1] + pts[i*2+1]);
  if (area < 0) idx.reverse();
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n + 64) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const ax = pts[a*2], ay = pts[a*2+1], bx = pts[b*2], by = pts[b*2+1], cx = pts[c*2], cy = pts[c*2+1];
      const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (cross <= 0) continue; // reflex
      let ok = true;
      for (let k = 0; k < idx.length; k++) {
        const q = idx[k];
        if (q === a || q === b || q === c) continue;
        const px = pts[q*2], py = pts[q*2+1];
        const d1 = (bx-ax)*(py-ay) - (by-ay)*(px-ax);
        const d2 = (cx-bx)*(py-by) - (cy-by)*(px-bx);
        const d3 = (ax-cx)*(py-cy) - (ay-cy)*(px-cx);
        if (d1 >= 0 && d2 >= 0 && d3 >= 0) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++)
    a += (pts[j*2] - pts[i*2]) * (pts[j*2+1] + pts[i*2+1]);
  return Math.abs(a) / 2;
}
