#!/usr/bin/env node
/**
 * Plan du campus — régénération de data.js
 *
 *   node tools/build-data.mjs > /dev/null   (écrit ../data.js)
 *
 * Sources :
 *   - OpenStreetMap via l'API Overpass  (bâti, voirie, hydrographie, occupation du sol, campus)
 *   - Tuiles d'élévation "Terrarium"     (Mapzen / AWS Open Data, zoom 13)
 *
 * Node 18+ requis (fetch global, zlib). Aucune dépendance npm : le décodeur PNG
 * ci-dessous gère le sous-ensemble utilisé par les tuiles Terrarium
 * (8 bits, RGB ou RGBA, non entrelacé).
 */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'data.js');

/* ------------------------------------------------------------------ réglages */
const LAT0 = 42.3025, LON0 = 9.1525;      // centre de scène (Corte, place Paoli)
const BBOX = '42.283,9.125,42.332,9.185'; // emprise des données vectorielles
const HALF = 5500;                        // demi-emprise du relief, en mètres
const GW = 352;                           // côté de la grille de relief
const TSTEP = 0.25;                       // quantum d'altitude, en mètres
const Q = 0.5;                            // quantum planimétrique, en mètres
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const PH = LAT0 * Math.PI / 180;
const MLAT = 111132.92 - 559.82 * Math.cos(2 * PH) + 1.175 * Math.cos(4 * PH);
const MLON = 111412.84 * Math.cos(PH) - 93.5 * Math.cos(3 * PH);
const px = (lon) => (lon - LON0) * MLON;
const py = (lat) => (lat - LAT0) * MLAT;

/* ------------------------------------------------------- écriture binaire */
class W {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 255); }
  uv(v) { v >>>= 0; while (v >= 0x80) { this.a.push((v & 0x7f) | 0x80); v >>>= 7; } this.a.push(v); }
  zz(v) { this.uv((v << 1) ^ (v >> 31)); }
  bytes() { return Buffer.from(this.a); }
}

/* ------------------------------------------------------------ décodeur PNG */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('signature PNG invalide');
  let p = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6))
    throw new Error(`PNG non géré (depth=${depth} colour=${colour} interlace=${interlace})`);
  const ch = colour === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let q = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, ch, data: out };
}

/* ------------------------------------------------------------------ relief */
const Z = 13, N = 2 ** Z;
const tileX = (lon) => (lon + 180) / 360 * N;
const tileY = (lat) => { const t = lat * Math.PI / 180; return (1 - Math.log(Math.tan(t) + 1 / Math.cos(t)) / Math.PI) / 2 * N; };

async function buildRelief() {
  const x0 = Math.floor(tileX(LON0 - HALF / MLON)), x1 = Math.floor(tileX(LON0 + HALF / MLON));
  const y0 = Math.floor(tileY(LAT0 + HALF / MLAT)), y1 = Math.floor(tileY(LAT0 - HALF / MLAT));
  const tw = x1 - x0 + 1, th = y1 - y0 + 1, demW = tw * 256, demH = th * 256;
  const dem = new Float32Array(demW * demH);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = `${TERRARIUM}/${Z}/${tx}/${ty}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`tuile ${url} : HTTP ${res.status}`);
      const png = decodePNG(Buffer.from(await res.arrayBuffer()));
      const ox = (tx - x0) * 256, oy = (ty - y0) * 256;
      for (let j = 0; j < 256; j++) {
        for (let i = 0; i < 256; i++) {
          const k = (j * 256 + i) * png.ch;
          dem[(oy + j) * demW + ox + i] = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
        }
      }
      process.stderr.write(`relief ${tx}/${ty}\n`);
    }
  }
  const sample = (gx, gy) => {
    const i = Math.max(0, Math.min(demW - 2, Math.floor(gx))), j = Math.max(0, Math.min(demH - 2, Math.floor(gy)));
    const fu = gx - i, fv = gy - j;
    const a = dem[j * demW + i], b = dem[j * demW + i + 1], c = dem[(j + 1) * demW + i], d = dem[(j + 1) * demW + i + 1];
    const t = a + (b - a) * fu;
    return t + ((c + (d - c) * fu) - t) * fv;
  };
  const dxm = (2 * HALF) / (GW - 1);
  const heights = new Float32Array(GW * GW);
  for (let j = 0; j < GW; j++) {
    const lat = LAT0 + (-HALF + j * dxm) / MLAT, gy = (tileY(lat) - y0) * 256;
    for (let i = 0; i < GW; i++) heights[j * GW + i] = sample((tileX(LON0 + (-HALF + i * dxm) / MLON) - x0) * 256, gy);
  }
  let hmin = Infinity, hmax = -Infinity;
  for (const v of heights) { if (v < hmin) hmin = v; if (v > hmax) hmax = v; }
  hmin = Math.floor(hmin) - 1;

  // prédicteur plan (gauche + dessous − diagonale) puis varint zigzag
  const w = new W(), raw = new Int32Array(GW * GW);
  for (let j = 0; j < GW; j++) {
    for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      raw[k] = Math.round((heights[k] - hmin) / TSTEP);
      let pred;
      if (i === 0 && j === 0) pred = 0;
      else if (j === 0) pred = raw[k - 1];
      else if (i === 0) pred = raw[k - GW];
      else pred = raw[k - 1] + raw[k - GW] - raw[k - GW - 1];
      w.zz(raw[k] - pred);
    }
  }
  return { bytes: w.bytes(), hmin, hmax, dxm };
}

/* --------------------------------------------------------------- vecteurs */
const KIND = { BUILDING: 0, ROAD: 1, WATERLINE: 2, WATERAREA: 3, GREEN: 4, ROCK: 5, RAIL: 6, PARKING: 7, CAMPUS: 8 };
const ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'service', 'pedestrian', 'track', 'footway', 'path', 'steps', 'cycleway'];
const ALIAS = { motorway_link: 'motorway', trunk_link: 'trunk', primary_link: 'primary', secondary_link: 'secondary',
  tertiary_link: 'tertiary', road: 'unclassified', bridleway: 'path', corridor: 'footway' };
const NO_CAR_ACCESS = new Set(['no', 'private', 'destination', 'customers', 'delivery', 'agricultural', 'forestry', 'permit']);
const CAR_FREE_CLASSES = new Set(['pedestrian', 'footway', 'path', 'steps', 'cycleway']);

const QUERY = `[out:json][timeout:180];(
 way["building"](${BBOX});way["highway"](${BBOX});way["waterway"](${BBOX});way["natural"](${BBOX});
 way["landuse"](${BBOX});way["leisure"](${BBOX});way["railway"](${BBOX});way["amenity"](${BBOX});
 way["historic"](${BBOX});way["tourism"](${BBOX});
 node["amenity"="university"](${BBOX});node["historic"](${BBOX});node["railway"="station"](${BBOX});node["place"](${BBOX});
 relation["building"](${BBOX});relation["natural"="water"](${BBOX});
);out geom;`;

function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    let dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
    const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i * 2] - ax) * dy - (pts[i * 2 + 1] - ay) * dx);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

function heightOf(t) {
  if (t.height) { const h = parseFloat(t.height); if (h > 0) return h; }
  if (t['building:levels']) { const l = parseFloat(t['building:levels']); if (l > 0) return l * 3.1 + 1.6; }
  const map = { house: 7, detached: 7, residential: 11, apartments: 14, hotel: 14, church: 15, chapel: 9,
    cathedral: 22, retail: 8, commercial: 11, industrial: 9, warehouse: 8, garage: 3.2, garages: 3.2, shed: 3,
    hut: 3, roof: 3.5, school: 10, university: 13, hospital: 14, public: 12, civic: 12, train_station: 10,
    ruins: 5, castle: 17, tower: 22 };
  if (map[t.building]) return map[t.building];
  if (t.amenity === 'place_of_worship') return 15;
  return 10.5;
}

function greenSub(t) {
  const v = t.landuse || t.natural || t.leisure;
  if (['forest', 'wood'].includes(v)) return 0;
  if (['scrub', 'heath'].includes(v)) return 1;
  if (['grass', 'meadow', 'park', 'garden', 'village_green', 'recreation_ground', 'grassland'].includes(v)) return 2;
  if (['farmland', 'orchard', 'vineyard', 'allotments', 'farmyard'].includes(v)) return 3;
  if (['pitch', 'golf_course', 'track'].includes(v)) return 4;
  return 2;
}

/* --- fiches des sites : n'éditer que ce bloc pour ajouter ou décrire un lieu ---
   match : expression régulière appliquée au tag name d'OpenStreetMap
   r/phi/theta : cadrage de la caméra à l'arrivée (distance, hauteur, azimut)   */
const SITES = [
  { id: 'mariani', match: /Campus Mariani/i, name: 'Campus Mariani', sub: 'Droit · Lettres · INSPÉ',
    note: 'Le campus historique, adossé au centre ancien : droit et sciences politiques, lettres, langues et sciences humaines, IAE, INSPÉ et le CROUS.',
    kind: 'campus', r: 430, phi: 0.40, theta: -0.9 },
  { id: 'grimaldi', match: /Campus Grimaldi/i, name: 'Campus Grimaldi', sub: 'Sciences · Santé · Sport',
    note: 'Le grand campus au sud : faculté des sciences et techniques, institut universitaire de santé, bâtiments Marcelle Conrad et Dumenicu Alfonsi, halle des sports Raymond Montet.',
    kind: 'campus', r: 560, phi: 0.38, theta: 0.35 },
  { id: 'iut', match: /IUT di Corsica/i, name: 'IUT di Corsica', sub: 'Institut universitaire de technologie',
    note: 'À l’extrémité sud du plateau universitaire, l’IUT prolonge le campus Grimaldi vers la vallée.',
    kind: 'campus', r: 380, phi: 0.42, theta: 1.1 },
  { id: 'spaziu', match: /Spaziu universitariu/i, name: 'Spaziu Natale Luciani', sub: 'Vie étudiante · culture',
    note: 'L’espace culturel et associatif de l’université, entre le campus Mariani et le cours Paoli.',
    kind: 'campus', r: 330, phi: 0.45, theta: -1.7 },
  { id: 'crous', match: /Centre régional des œuvres universitaires/i, name: 'CROUS di Corsica',
    sub: 'Restauration · logement étudiant',
    note: 'Le centre régional des œuvres universitaires et scolaires, au cœur du campus Mariani.',
    kind: 'campus', r: 300, phi: 0.46, theta: -1.2 },
  { id: 'simeoni', match: /Bâtiment Docteur Edmond Simeoni/i, name: 'Bâtiment Edmond Simeoni',
    sub: 'Università di Corsica', note: 'Antenne universitaire au nord du cours Paoli.',
    kind: 'campus', r: 320, phi: 0.44, theta: -0.3 },
  { id: 'citadella', match: /citadelle|citadella/i, name: 'Citadella di Corti', sub: 'Nid d’Aigle · Musée de la Corse',
    note: 'La citadelle domine la confluence du Tavignanu et de la Restonica ; son Nid d’Aigle veille sur la vieille ville.',
    kind: 'campus', r: 420, phi: 0.34, theta: -2.3 },
  { id: 'paoli', match: /^Place Paoli$/i, name: 'Piazza Paoli', sub: 'Centre ancien', note: '',
    kind: 'place', r: 300, phi: 0.45, theta: -1.0 },
];

async function buildVectors() {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(QUERY)
  });
  if (!res.ok) throw new Error(`Overpass : HTTP ${res.status}`);
  const els = (await res.json()).elements;
  process.stderr.write(`OSM : ${els.length} objets\n`);

  const feats = [];
  const add = (kind, sub, flag, coords, tol) => {
    let pts = [];
    for (const g of coords) pts.push(px(g.lon), py(g.lat));
    if (tol) pts = simplify(pts, tol);
    if (pts.length < 4) return;
    feats.push({ kind, sub, flag, pts });
  };

  for (const e of els) {
    const t = e.tags || {};
    let geom = e.geometry;
    if (!geom && e.members) {
      const outer = e.members.filter(m => m.role !== 'inner' && m.geometry);
      if (outer.length) geom = outer[0].geometry;
    }
    if (!geom || geom.length < 2) continue;

    if (t.building && t.building !== 'no') {
      const uni = (t.building === 'university' || t.amenity === 'university'
        || /universit|facult|campus|IUT|CROUS|Spaziu/i.test(t.name || '')
        || /universit/i.test(t.operator || '')) ? 1 : 0;
      const land = (t.historic || t.tourism === 'museum' || t.amenity === 'place_of_worship'
        || /citadelle|palazzu|mus[ée]e/i.test(t.name || '')) ? 2 : 0;
      add(KIND.BUILDING, Math.min(255, Math.round(heightOf(t) / 0.5)), uni | land, geom, 0);
      continue;
    }
    if (t.highway) {
      const cls = ALIAS[t.highway] || t.highway;
      const i = ROADS.indexOf(cls);
      if (i < 0) continue;
      // drapeaux : bit 0 sens unique dans le sens du tracé, bit 1 sens inverse,
      // bit 2 circulation automobile interdite
      let flag = 0;
      const ow = String(t.oneway || '').toLowerCase();
      if (ow === 'yes' || ow === 'true' || ow === '1') flag |= 1;
      else if (ow === '-1' || ow === 'reverse') flag |= 2;
      else if (t.junction === 'roundabout') flag |= 1;
      const motor = String(t.motor_vehicle || t.vehicle || t.access || '').toLowerCase();
      if (NO_CAR_ACCESS.has(motor) || CAR_FREE_CLASSES.has(cls)) flag |= 4;
      add(KIND.ROAD, i, flag, geom, 0.8);
      continue;
    }
    if (t.railway === 'rail') { add(KIND.RAIL, 0, 0, geom, 0.8); continue; }
    if (t.waterway) {
      if (['river', 'stream', 'canal', 'ditch'].includes(t.waterway))
        add(KIND.WATERLINE, t.waterway === 'river' ? 0 : (t.waterway === 'stream' ? 1 : 2), 0, geom, 0.9);
      continue;
    }
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.natural === 'wetland') { add(KIND.WATERAREA, 0, 0, geom, 0.9); continue; }
    if (['bare_rock', 'scree', 'cliff', 'rock', 'ridge'].includes(t.natural)) { add(KIND.ROCK, 0, 0, geom, 1.5); continue; }
    if (t.amenity === 'university') { add(KIND.CAMPUS, 0, 0, geom, 1.0); continue; }
    if (t.amenity === 'parking') { add(KIND.PARKING, 0, 0, geom, 1.2); continue; }
    if (t.landuse || (t.natural && t.natural !== 'tree_row') || t.leisure) {
      if (t.leisure === 'swimming_pool') { add(KIND.WATERAREA, 0, 0, geom, 0.6); continue; }
      add(KIND.GREEN, greenSub(t), 0, geom, 1.4);
    }
  }

  const w = new W();
  w.uv(feats.length);
  for (const f of feats) {
    w.u8(f.kind); w.u8(f.sub); w.u8(f.flag);
    const n = f.pts.length / 2;
    w.uv(n);
    let lx = 0, ly = 0;
    for (let i = 0; i < n; i++) {
      const qx = Math.round(f.pts[i * 2] / Q), qy = Math.round(f.pts[i * 2 + 1] / Q);
      w.zz(qx - lx); w.zz(qy - ly); lx = qx; ly = qy;
    }
  }

  const centroid = (e) => {
    const g = e.geometry || [];
    if (!g.length) return [px(e.lon), py(e.lat)];
    let sx = 0, sy = 0;
    for (const p of g) { sx += px(p.lon); sy += py(p.lat); }
    return [sx / g.length, sy / g.length];
  };
  const places = [];
  for (const s of SITES) {
    const e = els.find(el => el.tags && s.match.test(el.tags.name || ''))
      || els.find(el => el.tags && (el.tags.historic === 'citadel' || el.tags.historic === 'castle') && s.id === 'citadella');
    if (!e) { process.stderr.write(`site introuvable dans OSM : ${s.id}\n`); continue; }
    const [x, y] = centroid(e);
    places.push({ id: s.id, name: s.name, sub: s.sub, note: s.note, kind: s.kind,
      x: +x.toFixed(1), y: +y.toFixed(1), r: s.r, phi: s.phi, theta: s.theta,
      lift: s.kind === 'campus' ? 25 : 30 });
  }
  const gare = els.find(e => e.tags && e.tags.railway === 'station');
  if (gare) {
    const [x, y] = centroid(gare);
    places.push({ id: 'gara', name: 'Gara di Corti', sub: 'Chemins de fer de la Corse', note: '',
      kind: 'place', x: +x.toFixed(1), y: +y.toFixed(1), r: 340, phi: 0.45, theta: -0.6, lift: 30 });
  }
  process.stderr.write(`vecteurs : ${feats.length} entités, ${places.length} sites\n`);
  return { bytes: w.bytes(), places, count: feats.length };
}

/* -------------------------------------------------------------------- main */
const relief = await buildRelief();
const vectors = await buildVectors();

const payload = {
  origin: { lat: LAT0, lon: LON0 },
  mPerDegLat: +MLAT.toFixed(2),
  mPerDegLon: +MLON.toFixed(2),
  q: Q,
  roadFlags: 1,
  terrain: { w: GW, h: GW, x0: -HALF, y0: -HALF, dx: +relief.dxm.toFixed(4), dy: +relief.dxm.toFixed(4),
             min: relief.hmin, step: TSTEP, b64: zlib.gzipSync(relief.bytes, { level: 9 }).toString('base64') },
  features: zlib.gzipSync(vectors.bytes, { level: 9 }).toString('base64'),
  places: vectors.places
};

fs.writeFileSync(OUT, 'window.CORTE_DATA=' + JSON.stringify(payload) + ';');
process.stderr.write(`écrit ${OUT} — ${(fs.statSync(OUT).size / 1024).toFixed(0)} Ko, altitudes ${relief.hmin}–${Math.round(relief.hmax)} m\n`);
