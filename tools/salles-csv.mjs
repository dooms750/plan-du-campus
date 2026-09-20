/* Convertit un tableur de salles exporté en CSV vers salles.json.
 *
 *   node tools/salles-csv.mjs salles.csv            > écrit salles.json
 *   node tools/salles-csv.mjs salles.csv --verifier > contrôle sans écrire
 *
 * Le CSV doit avoir une ligne d'en-tête. Les colonnes reconnues, dans
 * n'importe quel ordre et quelle que soit la casse ou les accents :
 *
 *   code | salle          obligatoire
 *   batiment | bâtiment   obligatoire
 *   nom | intitule        facultatif
 *   etage | étage         facultatif
 *   info | remarque       facultatif
 *
 * Le séparateur est détecté (point-virgule ou virgule) : un export Excel
 * français passe sans réglage. Les noms de bâtiment sont vérifiés contre la
 * liste « _batiments » de salles.json et les écarts sont signalés — une
 * salle rattachée à un bâtiment inconnu n'apparaîtra pas dans la recherche.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
const verifierSeulement = process.argv.includes('--verifier');
if (!src) {
  console.error('usage : node tools/salles-csv.mjs <fichier.csv> [--verifier]');
  process.exit(1);
}

const sansAccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/* Analyseur CSV minimal mais correct : guillemets, guillemets doublés,
   retours à la ligne dans un champ, BOM. */
function parseCsv(texte, sep) {
  const lignes = [];
  let champ = '', ligne = [], guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (guillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++; }
        else guillemets = false;
      } else champ += c;
      continue;
    }
    if (c === '"') { guillemets = true; continue; }
    if (c === sep) { ligne.push(champ); champ = ''; continue; }
    if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ''; continue; }
    if (c === '\r') continue;
    champ += c;
  }
  if (champ !== '' || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  return lignes.filter(l => l.some(v => v.trim() !== ''));
}

const brut = fs.readFileSync(src, 'utf8').replace(/^﻿/, '');
const tete = brut.slice(0, brut.indexOf('\n') + 1 || brut.length);
const sep = (tete.split(';').length > tete.split(',').length) ? ';' : ',';
const lignes = parseCsv(brut, sep);
if (!lignes.length) { console.error('CSV vide'); process.exit(1); }

const ALIAS = {
  code: 'code', salle: 'code', numero: 'code', 'n°': 'code',
  batiment: 'batiment', bat: 'batiment', immeuble: 'batiment',
  nom: 'nom', intitule: 'nom', libelle: 'nom',
  etage: 'etage', niveau: 'etage',
  info: 'info', remarque: 'info', commentaire: 'info', acces: 'info'
};
const entete = lignes[0].map(h => ALIAS[sansAccent(h)] || null);
if (!entete.includes('code') || !entete.includes('batiment')) {
  console.error('colonnes « code » et « batiment » obligatoires — trouvé :', lignes[0].join(' | '));
  process.exit(1);
}

const salles = [];
const soucis = [];
for (let i = 1; i < lignes.length; i++) {
  const l = lignes[i];
  const o = {};
  entete.forEach((clef, j) => { if (clef && l[j] != null) o[clef] = String(l[j]).trim(); });
  if (!o.code || !o.batiment) { soucis.push(`ligne ${i + 1} : code ou bâtiment manquant`); continue; }
  const s = { code: o.code, batiment: o.batiment };
  if (o.nom) s.nom = o.nom;
  if (o.etage !== undefined && o.etage !== '') {
    const n = parseInt(String(o.etage).replace(/[^\d-]/g, ''), 10);
    if (!Number.isNaN(n)) s.etage = n;
  }
  if (o.info) s.info = o.info;
  salles.push(s);
}

// contrôle des noms de bâtiment
const cible = path.join(root, 'salles.json');
let connus = [];
try { connus = JSON.parse(fs.readFileSync(cible, 'utf8'))._batiments || []; } catch (_) {}
const connusPlies = connus.map(sansAccent);
const inconnus = new Set();
for (const s of salles) {
  const f = sansAccent(s.batiment);
  if (!connusPlies.some(b => b === f || b.includes(f) || f.includes(b))) inconnus.add(s.batiment);
}

console.log(`${salles.length} salle(s) lue(s) depuis ${path.basename(src)} (séparateur « ${sep} »)`);
for (const s of soucis) console.warn('  ignoré —', s);
if (inconnus.size) {
  console.warn(`\n  ${inconnus.size} bâtiment(s) inconnu(s) — ces salles ne seront pas trouvables :`);
  for (const b of inconnus) console.warn('    ·', b);
  console.warn('  Noms attendus : voir « _batiments » dans salles.json.');
}

if (verifierSeulement) { console.log('\n--verifier : rien n’a été écrit.'); process.exit(inconnus.size ? 2 : 0); }

let doc = { salles: [] };
try { doc = JSON.parse(fs.readFileSync(cible, 'utf8')); } catch (_) {}
doc.salles = salles;
fs.writeFileSync(cible, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nsalles.json écrit — pensez à incrémenter VERSION dans sw.js.`);
