/* Plan du campus — scene construction from decoded OSM + relief data */
'use strict';

const KIND = { BUILDING:0, ROAD:1, WATERLINE:2, WATERAREA:3, GREEN:4, ROCK:5, RAIL:6, PARKING:7, CAMPUS:8, WALL:9 };

const ROAD_W = [14,11,9,7.6,6.6,5.4,5,4.4,3.6,4.2,3.2,1.9,1.5,1.7,2.2];
const ROAD_C = [
  [0.29,0.30,0.30],[0.29,0.30,0.30],[0.32,0.32,0.31],[0.31,0.31,0.30],[0.30,0.30,0.29],
  [0.29,0.29,0.28],[0.30,0.30,0.29],[0.32,0.31,0.29],[0.30,0.29,0.27],[0.40,0.37,0.32],
  [0.36,0.31,0.24],[0.47,0.42,0.33],[0.44,0.39,0.30],[0.47,0.42,0.33],[0.33,0.33,0.31]
];

/* ---------------- terrain field ---------------- */
class Field {
  constructor(t, heights) {
    this.w = t.w; this.h = t.h;
    this.x0 = t.x0; this.y0 = t.y0;         // west (x, m), south (northing, m)
    this.dx = t.dx; this.dy = t.dy;         // spacing in metres
    this.z = heights;                        // Float32Array w*h, row 0 = south
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.min = mn; this.max = mx;
  }
  // world x (east), world z (south-positive) -> elevation
  at(x, z) {
    const u = (x - this.x0) / this.dx;
    const v = (-z - this.y0) / this.dy;
    const i = clamp(Math.floor(u), 0, this.w - 2), j = clamp(Math.floor(v), 0, this.h - 2);
    const fu = clamp(u - i, 0, 1), fv = clamp(v - j, 0, 1);
    const a = this.z[j * this.w + i], b = this.z[j * this.w + i + 1];
    const c = this.z[(j + 1) * this.w + i], d = this.z[(j + 1) * this.w + i + 1];
    return lerp(lerp(a, b, fu), lerp(c, d, fu), fv);
  }
}

/* ---------------- decode payload ---------------- */
async function decodeScene(DATA) {
  // terrain
  const tb = await gunzip(b64ToBytes(DATA.terrain.b64));
  const t = DATA.terrain;
  const n = t.w * t.h;
  const raw = new Int32Array(n);
  const r = new Reader(tb);
  let prev = 0;
  for (let j = 0; j < t.h; j++) {
    for (let i = 0; i < t.w; i++) {
      const k = j * t.w + i;
      let pred;
      if (i === 0 && j === 0) pred = 0;
      else if (j === 0) pred = raw[k - 1];
      else if (i === 0) pred = raw[k - t.w];
      else pred = raw[k - 1] + raw[k - t.w] - raw[k - t.w - 1];
      raw[k] = pred + r.zz();
    }
  }
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = t.min + raw[i] * t.step;
  const field = new Field(t, heights);

  // features
  const fb = await gunzip(b64ToBytes(DATA.features));
  const fr = new Reader(fb);
  const count = fr.uv();
  const q = DATA.q || 1;
  const feats = new Array(count);
  for (let f = 0; f < count; f++) {
    const kind = fr.u8(), sub = fr.u8(), flag = fr.u8();
    const np = fr.uv();
    const pts = new Float32Array(np * 2);
    let x = 0, y = 0;
    for (let i = 0; i < np; i++) {
      x += fr.zz(); y += fr.zz();
      pts[i*2] = x * q; pts[i*2+1] = y * q;   // x east, y north (metres)
    }
    feats[f] = { kind, sub, flag, pts };
  }
  return { field, feats };
}

/* ---------------- terrain mesh ---------------- */
function buildTerrain(gl, field) {
  const { w, h } = field;
  const pos = new Float32Array(w * h * 3);
  const nrm = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      pos[k*3]   = field.x0 + i * field.dx;
      pos[k*3+1] = field.z[k];
      pos[k*3+2] = -(field.y0 + j * field.dy);
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const l = field.z[j*w + Math.max(i-1,0)], rr = field.z[j*w + Math.min(i+1,w-1)];
      const d = field.z[Math.max(j-1,0)*w + i], u = field.z[Math.min(j+1,h-1)*w + i];
      const sx = (rr - l) / (2 * field.dx), sz = (u - d) / (2 * field.dy);
      let nx = -sx, ny = 1, nz = sz;   // z axis points south
      const len = Math.hypot(nx, ny, nz);
      nrm[k*3] = nx/len; nrm[k*3+1] = ny/len; nrm[k*3+2] = nz/len;
    }
  }
  const idx = new Uint32Array((w-1) * (h-1) * 6);
  let p = 0;
  for (let j = 0; j < h-1; j++) {
    for (let i = 0; i < w-1; i++) {
      const a = j*w+i, b = a+1, c = a+w, d = c+1;
      idx[p++]=a; idx[p++]=c; idx[p++]=b;
      idx[p++]=b; idx[p++]=c; idx[p++]=d;
    }
  }
  return vao(gl, [
    { loc: 0, size: 3, data: pos },
    { loc: 1, size: 3, data: nrm }
  ], idx);
}

/* ---------------- buildings ---------------- */
const PALETTE_WALL = [[0.70,0.65,0.55],[0.67,0.61,0.51],[0.73,0.68,0.59],[0.63,0.59,0.50],[0.69,0.63,0.53]];
const PALETTE_ROOF = [[0.55,0.30,0.22],[0.50,0.27,0.20],[0.59,0.34,0.24],[0.46,0.26,0.21],[0.53,0.31,0.25]];

function buildBuildings(gl, feats, field) {
  const P = [], N = [], C = [], E = []; // position, normal, colour, extra(ao, uniFlag)
  const idx = [];
  let base = 0;
  const campusCentres = [];

  for (const f of feats) {
    if (f.kind !== KIND.BUILDING) continue;
    const np = f.pts.length / 2;
    if (np < 3) continue;
    let pts = f.pts;
    // drop duplicated closing point
    if (Math.abs(pts[0]-pts[(np-1)*2]) < 0.5 && Math.abs(pts[1]-pts[(np-1)*2+1]) < 0.5) {
      pts = pts.slice(0, (np-1)*2);
    }
    const m = pts.length / 2;
    if (m < 3) continue;
    if (polyArea(pts) < 8) continue;
    // force counter-clockwise winding so wall normals face outward
    let sa = 0;
    for (let i = 0, j = m - 1; i < m; j = i++) sa += pts[j*2] * pts[i*2+1] - pts[i*2] * pts[j*2+1];
    if (sa < 0) {
      const rev = new Float32Array(m * 2);
      for (let i = 0; i < m; i++) { rev[i*2] = pts[(m-1-i)*2]; rev[i*2+1] = pts[(m-1-i)*2+1]; }
      pts = rev;
    }

    const height = Math.max(2.5, f.sub * 0.5);
    const uni = (f.flag & 1) ? 1 : 0;
    const landmark = (f.flag & 2) ? 1 : 0;

    // ground level: lowest terrain under the footprint
    let gmin = Infinity, cx = 0, cy = 0;
    for (let i = 0; i < m; i++) {
      const e = field.at(pts[i*2], -pts[i*2+1]);
      if (e < gmin) gmin = e;
      cx += pts[i*2]; cy += pts[i*2+1];
    }
    cx /= m; cy /= m;
    const gc = field.at(cx, -cy);
    const y0 = Math.min(gmin, gc) - 1.2;
    const y1 = y0 + height + (gc - gmin) * 0.35;

    const seed = (Math.abs(Math.round(cx * 7 + cy * 13)) % 5);
    let wall = PALETTE_WALL[seed].slice(), roof = PALETTE_ROOF[seed].slice();
    if (uni) { wall = [0.84,0.85,0.84]; roof = [0.34,0.38,0.41]; }
    else if (landmark) { wall = [0.85,0.81,0.70]; roof = [0.40,0.29,0.26]; }
    const tone = 0.92 + ((Math.abs(Math.round(cx*31 + cy*17)) % 17) / 17) * 0.16;
    wall = wall.map(v => clamp(v * tone, 0, 1));
    roof = roof.map(v => clamp(v * tone, 0, 1));

    // walls
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = pts[i*2], az = -pts[i*2+1], bx = pts[j*2], bz = -pts[j*2+1];
      let nx = -(bz - az), nz = (bx - ax);
      const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const v0 = base + P.length / 3;
      P.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      for (let k = 0; k < 4; k++) N.push(nx, 0, nz);
      for (let k = 0; k < 4; k++) C.push(wall[0], wall[1], wall[2]);
      E.push(0.42, uni, 0.42, uni, 1.0, uni, 1.0, uni);
      idx.push(v0, v0+1, v0+2, v0, v0+2, v0+3);
    }
    // roof
    const tris = triangulate(pts);
    const r0 = base + P.length / 3;
    for (let i = 0; i < m; i++) {
      P.push(pts[i*2], y1, -pts[i*2+1]);
      N.push(0, 1, 0);
      C.push(roof[0], roof[1], roof[2]);
      E.push(1.0, uni);
    }
    for (let i = 0; i < tris.length; i += 3) idx.push(r0 + tris[i], r0 + tris[i+1], r0 + tris[i+2]);
  }

  const mesh = vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(N) },
    { loc: 2, size: 3, data: new Float32Array(C) },
    { loc: 3, size: 2, data: new Float32Array(E) }
  ], new Uint32Array(idx));
  return { mesh, campusCentres };
}

/* ---------------- ribbons (roads, rails, rivers) ---------------- */
function ribbon(P, C, idx, pts, width, col, field, lift, densify) {
  const m = pts.length / 2;
  if (m < 2) return;
  // densify so the ribbon follows the terrain
  const line = [];
  for (let i = 0; i < m - 1; i++) {
    const ax = pts[i*2], ay = pts[i*2+1], bx = pts[(i+1)*2], by = pts[(i+1)*2+1];
    const d = Math.hypot(bx-ax, by-ay);
    const steps = Math.max(1, Math.ceil(d / densify));
    for (let s = 0; s < steps; s++) line.push(lerp(ax,bx,s/steps), lerp(ay,by,s/steps));
  }
  line.push(pts[(m-1)*2], pts[(m-1)*2+1]);
  const n = line.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  const start = P.length / 3;
  for (let i = 0; i < n; i++) {
    const px = line[i*2], py = line[i*2+1];
    const qx = line[Math.min(i+1, n-1)*2], qy = line[Math.min(i+1, n-1)*2+1];
    const rx = line[Math.max(i-1, 0)*2], ry = line[Math.max(i-1, 0)*2+1];
    let tx = qx - rx, ty = qy - ry;
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty, ny = tx;
    const y = field.at(px, -py) + lift;
    P.push(px + nx*hw, y, -(py + ny*hw));
    P.push(px - nx*hw, y, -(py - ny*hw));
    C.push(col[0], col[1], col[2], col[0]*0.86, col[1]*0.86, col[2]*0.86);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i*2, b = a+1, c = a+2, d = a+3;
    idx.push(a, c, b, b, c, d);
  }
}

function buildRoads(gl, feats, field) {
  const P = [], C = [], idx = [];
  for (const f of feats) {
    if (f.kind === KIND.ROAD) {
      const w = ROAD_W[f.sub] || 4, c = ROAD_C[f.sub] || [0.3,0.3,0.3];
      ribbon(P, C, idx, f.pts, w, c, field, 0.9, 12);
    } else if (f.kind === KIND.RAIL) {
      ribbon(P, C, idx, f.pts, 3.2, [0.27,0.26,0.25], field, 0.9, 14);
    }
  }
  return vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(C) }
  ], new Uint32Array(idx));
}

function buildWater(gl, feats, field) {
  const P = [], C = [], idx = [];
  for (const f of feats) {
    if (f.kind === KIND.WATERLINE) {
      const w = f.sub === 0 ? 14 : (f.sub === 1 ? 6 : 2.6);
      ribbon(P, C, idx, f.pts, w, [0.19,0.35,0.41], field, 0.35, 10);
    } else if (f.kind === KIND.WATERAREA) {
      let pts = f.pts;
      let m = pts.length / 2;
      if (m > 3 && Math.abs(pts[0] - pts[(m-1)*2]) < 0.4 && Math.abs(pts[1] - pts[(m-1)*2+1]) < 0.4) {
        pts = pts.slice(0, (m - 1) * 2); m = pts.length / 2;
      }
      if (m < 3) continue;
      let lo = Infinity;
      for (let i = 0; i < m; i++) lo = Math.min(lo, field.at(pts[i*2], -pts[i*2+1]));
      const tris = triangulate(pts);
      const s = P.length / 3;
      for (let i = 0; i < m; i++) { P.push(pts[i*2], lo + 0.4, -pts[i*2+1]); C.push(0.17,0.33,0.39); }
      for (let i = 0; i < tris.length; i += 3) idx.push(s+tris[i], s+tris[i+1], s+tris[i+2]);
    }
  }
  return vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(C) }
  ], new Uint32Array(idx));
}

/* ---------------- land-cover texture ---------------- */
function buildCover(gl, feats, field, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const W = (field.w - 1) * field.dx, H = (field.h - 1) * field.dy;
  const toPx = (x, y) => [ (x - field.x0) / W * size, size - (y - field.y0) / H * size ];

  const drawPoly = (pts, fill, alpha) => {
    const m = pts.length / 2;
    if (m < 3) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let i = 0; i < m; i++) {
      const [px, py] = toPx(pts[i*2], pts[i*2+1]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  };

  const greenTints = ['#3f4c30', '#495234', '#5a6339', '#63653c', '#4e5a36'];
  for (const f of feats) {
    if (f.kind === KIND.GREEN) drawPoly(f.pts, greenTints[f.sub % greenTints.length], 0.88);
  }
  for (const f of feats) {
    if (f.kind === KIND.ROCK) drawPoly(f.pts, '#7a7264', 0.8);
    else if (f.kind === KIND.PARKING) drawPoly(f.pts, '#4c4a45', 0.7);
  }
  /* Empreintes du bâti dessinées à part, puis reposées floutées sur le fond :
     une passe large donne le ton minéral du tissu urbain, une passe serrée
     fait office d'occlusion de contact au pied des murs. */
  const oc = document.createElement('canvas');
  oc.width = oc.height = size;
  const octx = oc.getContext('2d');
  octx.fillStyle = '#524b40';
  for (const f of feats) {
    if (f.kind !== KIND.BUILDING) continue;
    const m = f.pts.length / 2;
    if (m < 3) continue;
    octx.beginPath();
    for (let i = 0; i < m; i++) {
      const [qx, qy] = toPx(f.pts[i * 2], f.pts[i * 2 + 1]);
      i ? octx.lineTo(qx, qy) : octx.moveTo(qx, qy);
    }
    octx.closePath();
    octx.fill();
  }
  const lay = (radius, alpha) => {
    ctx.save();
    try { ctx.filter = `blur(${radius}px)`; } catch (_) { /* filtre non géré : rendu net, acceptable */ }
    ctx.globalAlpha = alpha;
    ctx.drawImage(oc, 0, 0);
    ctx.restore();
  };
  lay(Math.max(2, size / 320), 0.42);   // halo minéral autour du bâti
  lay(Math.max(1, size / 900), 0.34);   // ombre de contact
  ctx.globalAlpha = 1;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return tex;
}

/* ---------------- campus outlines ---------------- */
function buildCampusRings(gl, feats, field) {
  const P = [], C = [], idx = [];
  for (const f of feats) {
    if (f.kind !== KIND.CAMPUS) continue;
    const m = f.pts.length / 2;
    const closed = new Float32Array((m + 1) * 2);
    closed.set(f.pts);
    closed[m*2] = f.pts[0]; closed[m*2+1] = f.pts[1];
    ribbon(P, C, idx, closed, 3.0, [1.0, 0.72, 0.28], field, 1.4, 8);
  }
  return vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(C) }
  ], new Uint32Array(idx));
}

/* ================================================================
   Itinéraires piétons — graphe de voirie, rendu du tracé, repère GPS
   ================================================================ */

/* pénalité de confort par classe de voie, à pied ; 0 = voie exclue */
const WALK_PEN = [0, 0, 1.32, 1.24, 1.14, 1.06, 1.00, 0.96, 1.06, 0.92, 1.14, 0.90, 0.95, 1.02, 1.00];

/* vitesse de circulation effective en m/s par classe ; 0 = voie interdite ou impraticable */
const CAR_SPEED = [25, 22, 12.5, 12.5, 11, 10, 7.5, 5, 4, 0, 5, 0, 0, 0, 0];

/* drapeaux portés par les voies (octet `flag`) */
const ONEWAY_FWD = 1, ONEWAY_REV = 2, NO_CAR = 4;

/* fonction de Tobler : vitesse de marche en m/s selon la pente */
function walkSpeed(slope) {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05)) / 3.6;
}

function edgeCost(d2, dz, pen) {
  const s = d2 > 0.5 ? dz / d2 : 0;
  return (d2 / Math.max(0.30, walkSpeed(s))) * pen;
}

/* mode 'walk' (défaut) ou 'drive' : à pied les sens uniques sont ignorés,
   en voiture ils sont respectés et les voies piétonnes exclues */
function buildGraph(feats, field, mode) {
  const drive = mode === 'drive';
  const nodes = [];
  const adj = [];
  const index = new Map();
  const nodeAt = (x, y) => {
    const k = Math.round(x * 2) + 'v' + Math.round(y * 2);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ x, y, z: field.at(x, -y) });
      adj.push([]);
      index.set(k, id);
    }
    return id;
  };
  for (const f of feats) {
    if (f.kind !== KIND.ROAD) continue;
    const pen = WALK_PEN[f.sub];
    const speed = CAR_SPEED[f.sub];
    if (drive) { if (!speed || (f.flag & NO_CAR)) continue; }
    else if (!pen) continue;
    const fwd = !drive || !(f.flag & ONEWAY_REV);
    const rev = !drive || !(f.flag & ONEWAY_FWD);
    const n = f.pts.length / 2;
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const id = nodeAt(f.pts[i * 2], f.pts[i * 2 + 1]);
      if (prev >= 0 && prev !== id) {
        const a = nodes[prev], b = nodes[id];
        const d2 = Math.hypot(b.x - a.x, b.y - a.y);
        if (d2 > 0.2) {
          const dz = b.z - a.z;
          const cf = drive ? d2 / speed : edgeCost(d2, dz, pen);
          const cr = drive ? d2 / speed : edgeCost(d2, -dz, pen);
          if (fwd) adj[prev].push({ to: id, c: cf, d: d2, dz });
          if (rev) adj[id].push({ to: prev, c: cr, d: d2, dz: -dz });
        }
      }
      prev = id;
    }
  }

  /* composantes connexes : le réseau OSM comporte des tronçons isolés,
     il faut éviter d'y accrocher un départ ou une arrivée */
  const comp = new Int32Array(nodes.length).fill(-1);
  const sizes = [];
  const stack = [];
  const inAdj = nodes.map(() => []);
  for (let u = 0; u < adj.length; u++) for (const e of adj[u]) inAdj[e.to].push(u);
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] >= 0) continue;
    const c = sizes.length;
    let n = 0;
    stack.length = 0;
    stack.push(s);
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      n++;
      for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); }
      for (const v of inAdj[u]) if (comp[v] < 0) { comp[v] = c; stack.push(v); }
    }
    sizes.push(n);
  }
  let main = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
  return { nodes, adj, comp, sizes, main };
}

/* tas binaire minimal pour A* */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(id, k) {
    const a = this.a;
    a.push({ id, k });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/* nœud le plus proche, éventuellement restreint à une composante connexe */
function nearestNode(graph, x, y, comp) {
  let best = -1, bd = Infinity;
  const nodes = graph.nodes;
  for (let i = 0; i < nodes.length; i++) {
    if (comp !== undefined && graph.comp[i] !== comp) continue;
    const dx = nodes[i].x - x, dy = nodes[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return { id: best, dist: Math.sqrt(bd) };
}

/* A* — renvoie { path, dist, time, up, down } ou null */
function findRoute(graph, from, to, vmax) {
  const N = graph.nodes.length;
  if (from < 0 || to < 0 || from === to) return null;
  const g = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const target = graph.nodes[to];
  const h = (i) => {
    const n = graph.nodes[i];
    return Math.hypot(n.x - target.x, n.y - target.y) / (vmax || 1.70);
  };
  const open = new Heap();
  g[from] = 0;
  open.push(from, h(from));
  let found = false;
  while (open.size) {
    const cur = open.pop();
    if (seen[cur.id]) continue;
    seen[cur.id] = 1;
    if (cur.id === to) { found = true; break; }
    for (const e of graph.adj[cur.id]) {
      const ng = g[cur.id] + e.c;
      if (ng < g[e.to]) {
        g[e.to] = ng;
        prev[e.to] = cur.id;
        open.push(e.to, ng + h(e.to));
      }
    }
  }
  if (!found) return null;
  const path = [];
  for (let i = to; i >= 0; i = prev[i]) path.push(i);
  path.reverse();
  let dist = 0, up = 0, down = 0;
  for (let i = 1; i < path.length; i++) {
    const a = graph.nodes[path[i - 1]], b = graph.nodes[path[i]];
    dist += Math.hypot(b.x - a.x, b.y - a.y);
    const dz = b.z - a.z;
    if (dz > 0) up += dz; else down -= dz;
  }
  return { path, dist, time: g[to], up, down };
}

/* ---------- rubans dynamiques (tracé, repère de position) ---------- */

/* variante de ribbon() qui renseigne aussi l'abscisse curviligne */
function ribbonS(P, C, S, idx, pts, width, col, field, lift, densify) {
  const m = pts.length / 2;
  if (m < 2) return;
  const line = [];
  for (let i = 0; i < m - 1; i++) {
    const ax = pts[i*2], ay = pts[i*2+1], bx = pts[(i+1)*2], by = pts[(i+1)*2+1];
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(d / densify));
    for (let s = 0; s < steps; s++) line.push(lerp(ax, bx, s / steps), lerp(ay, by, s / steps));
  }
  line.push(pts[(m-1)*2], pts[(m-1)*2+1]);
  const n = line.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  const start = P.length / 3;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const px = line[i*2], py = line[i*2+1];
    if (i) acc += Math.hypot(px - line[(i-1)*2], py - line[(i-1)*2+1]);
    const qx = line[Math.min(i+1, n-1)*2], qy = line[Math.min(i+1, n-1)*2+1];
    const rx = line[Math.max(i-1, 0)*2], ry = line[Math.max(i-1, 0)*2+1];
    let tx = qx - rx, ty = qy - ry;
    const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty, ny = tx;
    const y = field.at(px, -py) + lift;
    P.push(px + nx*hw, y, -(py + ny*hw));
    P.push(px - nx*hw, y, -(py - ny*hw));
    C.push(col[0], col[1], col[2], col[0], col[1], col[2]);
    S.push(acc, acc);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = start + i*2, b = a+1, c = a+2, d = a+3;
    idx.push(a, c, b, b, c, d);
  }
}

function buildRouteMesh(gl, pts, field, col) {
  const P = [], C = [], S = [], idx = [];
  ribbonS(P, C, S, idx, pts, col ? 5.4 : 4.6, col || [0.42, 0.90, 0.82], field, 2.0, 6);
  if (!idx.length) return null;
  return vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(C) },
    { loc: 2, size: 1, data: new Float32Array(S) }
  ], new Uint32Array(idx));
}

/* repère de position : disque au sol, cercle de précision, fût vertical */
function buildMarker(gl, x, y, accuracy, field, col, style, scale) {
  const P = [], C = [], idx = [];
  const ground = field.at(x, -y);
  const dot = style === 'dot';
  const k = scale || 1;
  const push = (px, py, pz, c) => {
    P.push(px, py, pz); const k = c || col; C.push(k[0], k[1], k[2]);
    return P.length / 3 - 1;
  };
  const disc = (r, h, c) => {
    const seg = 34;
    const centre = push(x, ground + h, -y, c);
    const ring = [];
    for (let i = 0; i < seg; i++) {
      const a = i / seg * Math.PI * 2;
      ring.push(push(x + Math.cos(a) * r, ground + h, -(y + Math.sin(a) * r), c));
    }
    for (let i = 0; i < seg; i++) idx.push(centre, ring[i], ring[(i + 1) % seg]);
  };

  if (dot) {
    /* Position actuelle : une pastille, comme dans une appli de navigation.
       Trois disques empilés — halo sombre, anneau clair, cœur coloré — pour
       rester lisible aussi bien sur un toit clair que sur la forêt. */
    /* La chaîne colorimétrique (exposition + ACES) délave les teintes vives :
       le cœur est assombri en amont pour ressortir franchement à l'écran. */
    disc(13.4 * k, 0.7, [0.012, 0.016, 0.018]);
    disc(11.0 * k, 0.9, [0.94, 0.97, 0.95]);
    disc(8.6 * k, 1.1, [col[0] * 0.26, col[1] * 0.30, col[2] * 0.30]);
  } else {
    disc(7.0 * k, 0.8);
    // fût vertical
    const rCol = 2.0 * k, hCol = 42 * k, sides = 6;
    const base = [], top = [];
    for (let i = 0; i < sides; i++) {
      const a = i / sides * Math.PI * 2;
      base.push(push(x + Math.cos(a) * rCol, ground + 0.8, -(y + Math.sin(a) * rCol)));
      top.push(push(x + Math.cos(a) * rCol * 0.25, ground + hCol, -(y + Math.sin(a) * rCol * 0.25)));
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      idx.push(base[i], base[j], top[i], top[i], base[j], top[j]);
    }
  }

  // cercle de précision — seulement pour une position mesurée
  if (accuracy) {
    const acc = clamp(accuracy, 9, 150);
    const circle = [];
    for (let i = 0; i <= 64; i++) {
      const a = i / 64 * Math.PI * 2;
      circle.push(x + Math.cos(a) * acc, y + Math.sin(a) * acc);
    }
    const rp = [], rc = [], rs = [], ri = [];
    ribbonS(rp, rc, rs, ri, new Float32Array(circle), 2.2, col, field, 1.2, 8);
    const off = P.length / 3;
    for (let i = 0; i < rp.length; i += 3) { P.push(rp[i], rp[i+1], rp[i+2]); C.push(col[0], col[1], col[2]); }
    for (const v of ri) idx.push(off + v);
  }

  return vao(gl, [
    { loc: 0, size: 3, data: new Float32Array(P) },
    { loc: 1, size: 3, data: new Float32Array(C) }
  ], new Uint32Array(idx));
}

/* ================================================================
   Accrochage au réseau par segment
   Se caler sur le sommet le plus proche est insuffisant : à Corte,
   8 % des segments de voirie dépassent 50 m et le plus long atteint
   1,3 km. On projette donc le point sur le segment, et on insère un
   sommet virtuel le temps du calcul.
   ================================================================ */

const SEG_CELL = 60;                       // côté d'une cellule d'index, en mètres
const cellKey = (i, j) => i * 100000 + j;

function buildSegIndex(graph) {
  const segs = [];
  const seen = new Set();
  for (let u = 0; u < graph.adj.length; u++) {
    for (const e of graph.adj[u]) {
      const a = u < e.to ? u : e.to, b = u < e.to ? e.to : u;
      const k = a * 1000003 + b;
      if (seen.has(k)) continue;
      seen.add(k);
      segs.push([a, b]);
    }
  }
  const cells = new Map();
  for (let s = 0; s < segs.length; s++) {
    const A = graph.nodes[segs[s][0]], B = graph.nodes[segs[s][1]];
    const i0 = Math.floor(Math.min(A.x, B.x) / SEG_CELL), i1 = Math.floor(Math.max(A.x, B.x) / SEG_CELL);
    const j0 = Math.floor(Math.min(A.y, B.y) / SEG_CELL), j1 = Math.floor(Math.max(A.y, B.y) / SEG_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        let l = cells.get(k);
        if (!l) cells.set(k, l = []);
        l.push(s);
      }
    }
  }
  graph.segs = segs;
  graph.cells = cells;
  return graph;
}

/* les k meilleurs accrochages, du plus proche au plus lointain */
function snapCandidates(graph, x, y, k) {
  if (!graph.cells) buildSegIndex(graph);
  const ci = Math.floor(x / SEG_CELL), cj = Math.floor(y / SEG_CELL);
  const out = [];
  const tried = new Set();
  let firstHit = -1;
  for (let ring = 0; ring <= 60; ring++) {
    for (let i = ci - ring; i <= ci + ring; i++) {
      for (let j = cj - ring; j <= cj + ring; j++) {
        if (ring > 0 && Math.abs(i - ci) !== ring && Math.abs(j - cj) !== ring) continue;
        const l = graph.cells.get(cellKey(i, j));
        if (!l) continue;
        for (const s of l) {
          if (tried.has(s)) continue;
          tried.add(s);
          const [ai, bi] = graph.segs[s];
          const A = graph.nodes[ai], B = graph.nodes[bi];
          const dx = B.x - A.x, dy = B.y - A.y;
          const L2 = dx * dx + dy * dy;
          let t = L2 > 0 ? ((x - A.x) * dx + (y - A.y) * dy) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = A.x + dx * t, py = A.y + dy * t;
          out.push({ a: ai, b: bi, t, x: px, y: py, dist: Math.hypot(x - px, y - py) });
        }
      }
    }
    if (out.length && firstHit < 0) firstHit = ring;
    if (firstHit >= 0 && ring >= firstHit + 1) break;   // une couronne de marge
  }
  out.sort((p, q) => p.dist - q.dist);
  return out.slice(0, k);
}

/* insère un sommet virtuel sur un segment ; renvoie son identifiant */
function insertVirtual(graph, snap, restore) {
  const A = graph.nodes[snap.a], B = graph.nodes[snap.b];
  const id = graph.nodes.length;
  const z = A.z + (B.z - A.z) * snap.t;
  graph.nodes.push({ x: snap.x, y: snap.y, z });
  graph.adj.push([]);
  const edgeOf = (u, v) => { for (const e of graph.adj[u]) if (e.to === v) return e; return null; };
  const ab = edgeOf(snap.a, snap.b), ba = edgeOf(snap.b, snap.a);
  const ref = ab || ba;
  if (!ref) return id;
  const dA = ref.d * snap.t, dB = ref.d * (1 - snap.t);
  if (ab) {
    graph.adj[id].push({ to: snap.b, c: ab.c * (1 - snap.t), d: dB, dz: B.z - z });
    restore.push([snap.a, graph.adj[snap.a].length]);
    graph.adj[snap.a].push({ to: id, c: ab.c * snap.t, d: dA, dz: z - A.z });
  }
  if (ba) {
    graph.adj[id].push({ to: snap.a, c: ba.c * snap.t, d: dA, dz: A.z - z });
    restore.push([snap.b, graph.adj[snap.b].length]);
    graph.adj[snap.b].push({ to: id, c: ba.c * (1 - snap.t), d: dB, dz: z - B.z });
  }
  return id;
}

/* itinéraire entre deux points quelconques : essaie les accrochages
   successifs tant qu'aucun chemin n'est trouvé (sens uniques, tronçons
   orphelins). Renvoie { dist, time, up, down, pts, snapDist } ou null. */
function routePoints(graph, from, to, vmax, tries) {
  if (!graph.nodes.length) return null;
  const A = snapCandidates(graph, from.x, from.y, tries || 4);
  const B = snapCandidates(graph, to.x, to.y, tries || 4);
  if (!A.length || !B.length) return null;

  for (let ia = 0; ia < A.length; ia++) {
    for (let ib = 0; ib < B.length; ib++) {
      const n0 = graph.nodes.length;
      const restore = [];
      const s = insertVirtual(graph, A[ia], restore);
      const t = insertVirtual(graph, B[ib], restore);
      let out = null;
      if (s !== t) {
        const res = findRoute(graph, s, t, vmax);
        if (res) {
          const pts = [];
          for (const i of res.path) pts.push(graph.nodes[i].x, graph.nodes[i].y);
          out = { dist: res.dist, time: res.time, up: res.up, down: res.down, pts,
                  snapDist: A[ia].dist + B[ib].dist };
        }
      }
      for (let i = restore.length - 1; i >= 0; i--) graph.adj[restore[i][0]].length = restore[i][1];
      graph.nodes.length = n0;
      graph.adj.length = n0;
      if (out) return out;
    }
  }
  return null;
}
