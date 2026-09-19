/* banc d'essai du routage, hors navigateur */
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console, window: {}, performance, atob, DecompressionStream, Blob, Response, TextDecoder });
for (const f of ['core.js', 'build.js', 'data.js']) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
const DATA = ctx.window.CORTE_DATA;

const scene = await vm.runInContext('decodeScene', ctx)(DATA);
const { field, feats } = scene;
const buildGraph = vm.runInContext('buildGraph', ctx);
const routePoints = vm.runInContext('routePoints', ctx);

for (const mode of ['walk', 'drive']) {
  const t0 = Date.now();
  const G = buildGraph(feats, field, mode);
  const tg = Date.now() - t0;
  const nSeg = (() => { let n = 0; for (const a of G.adj) n += a.length; return n; })();
  console.log(`\n=== ${mode} === ${G.nodes.length} sommets, ${nSeg} arcs, ${G.sizes.length} composantes (principale ${G.sizes[G.main]}), construit en ${tg} ms`);

  let ok = 0, fail = 0, snapMax = 0, tSum = 0, n = 0;
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  for (const p of DATA.places) {
    for (let k = 0; k < 12; k++) {
      // départs tirés dans la cuvette urbaine
      const from = { x: -700 + rnd() * 1500, y: -900 + rnd() * 1700 };
      const t1 = Date.now();
      const r = routePoints(G, from, p, mode === 'walk' ? 1.7 : 14, 4);
      tSum += Date.now() - t1; n++;
      if (!r) { fail++; continue; }
      ok++;
      snapMax = Math.max(snapMax, r.snapDist);
      const vol = Math.hypot(p.x - from.x, p.y - from.y);
      if (r.dist > vol * 3.2 + 300) console.log(`  détour suspect vers ${p.id} : ${Math.round(r.dist)} m pour ${Math.round(vol)} m à vol d'oiseau`);
    }
  }
  console.log(`  ${ok} succès / ${fail} échecs · accrochage max ${snapMax.toFixed(1)} m · ${(tSum / n).toFixed(1)} ms par itinéraire`);
}
