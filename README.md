# Plan du campus

Plan en relief des campus de l'**Università di Corsica Pasquale Paoli**, à Corte.
Une page web, aucun serveur applicatif, aucun compte, aucune publicité, aucun traqueur.

👉 **[Ouvrir le plan](https://VOTRE-COMPTE.github.io/plan-du-campus/)**

<!-- Remplacer VOTRE-COMPTE par le compte GitHub qui héberge le dépôt, ici et
     dans la section « Mise en ligne ». -->

---

## Pour les étudiants

- **Trouver un campus** — Mariani, Grimaldi, l'IUT, le Spaziu Natale Luciani, le CROUS,
  le bâtiment Edmond Simeoni, la citadelle : la liste du bas, ou une tape directement sur
  le bâtiment dans le plan.
- **Savoir combien de temps ça prend** — durée à pied *et* en voiture côte à côte, distance,
  dénivelé, heure d'arrivée. À Corte, le dénivelé n'est pas un détail.
- **Poser un départ où l'on veut** — gardez le doigt appuyé une demi-seconde sur le plan.
  Ou touchez le bouton de position pour partir d'où vous êtes.
- **Sans réseau** — une fois la page ouverte, tout est en mémoire : le relief, les rues, les
  bâtiments. Elle fonctionne dans un amphi, dans le train, dans la vallée.

### L'installer sur son téléphone

C'est une application web : rien à télécharger sur un magasin d'applications.

- **iPhone** — ouvrir le lien dans Safari, bouton **Partager**, puis *Sur l'écran d'accueil*.
- **Android** — ouvrir le lien dans Chrome, menu **⋮**, puis *Installer l'application*
  (ou *Ajouter à l'écran d'accueil*).

L'icône apparaît avec les autres applications et le plan s'ouvre en plein écran, hors ligne.

### Vie privée

La position n'est demandée que si vous appuyez sur le bouton, elle **ne quitte jamais le
téléphone** et n'est pas conservée : l'itinéraire est calculé sur place, dans le navigateur.
La page n'émet aucune requête à l'exécution — la seule exception est le chargement des polices
depuis Google Fonts, que l'on peut supprimer (voir plus bas).

---

## Pour le service informatique

### Essayer en local

```bash
git clone https://github.com/VOTRE-COMPTE/plan-du-campus.git
cd plan-du-campus
python3 -m http.server 8080      # n'importe quel serveur statique fait l'affaire
# puis http://localhost:8080/
```

Un double-clic sur `index.html` fonctionne aussi (`file://`), sans le service worker.

**Pré-requis navigateur** : WebGL 2 et `DecompressionStream` — Chrome/Edge 80+, Firefox 113+,
Safari 16.4+. Sur un navigateur plus ancien, la page affiche un message et s'arrête proprement.

### Mise en ligne (GitHub Pages)

Le dépôt est déjà prêt : les fichiers servis sont à la racine.

1. **Settings → Pages**
2. *Source* : **Deploy from a branch**
3. *Branch* : `main`, dossier `/ (root)` → **Save**

Une minute plus tard, le plan est en ligne sur `https://VOTRE-COMPTE.github.io/plan-du-campus/`.
La géolocalisation et l'installation sur l'écran d'accueil exigent HTTPS : Pages le fournit.

Pour héberger ailleurs (Apache, nginx, un bucket S3, un intranet), copier le dossier tel quel.
Servir `sw.js` depuis la racine du site, sinon la portée du service worker ne couvre pas la page.

### Après une modification

Le service worker sert la coque depuis le cache. Pour que les visiteurs reçoivent la nouvelle
version, **incrémenter `VERSION` en tête de `sw.js`** (`v10` → `v11`) dans le même commit.
L'ancien cache est purgé à l'activation.

### Ajouter ou corriger un site

Tout part d'OpenStreetMap. Si un bâtiment manque ou porte le mauvais nom, le corriger dans OSM
profite à tout le monde ; ensuite `node tools/build-data.mjs` régénère `data.js`.
Le tableau `SITES`, en tête de ce script, est le seul endroit qui décrit les campus (intitulé,
sous-titre, notice, cadrage de la caméra). Détails dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Se passer de Google Fonts

La page charge Fraunces et IBM Plex depuis `fonts.googleapis.com`. Pour un déploiement sans
dépendance externe — ou conforme à une lecture stricte du RGPD :

1. Télécharger les deux familles depuis [Google Fonts](https://fonts.google.com) ou
   [fontsource](https://fontsource.org), placer les `.woff2` dans `fonts/`.
2. Remplacer la balise `<link rel="stylesheet" …>` de `index.html` par les règles `@font-face`
   correspondantes.
3. Ajouter les fichiers à la liste `ASSETS` de `sw.js` et incrémenter `VERSION`.

La feuille de style prévoit déjà des polices système en repli : sans cette étape, la page reste
parfaitement lisible hors ligne, simplement avec une autre typographie.

---

## Ce qu'il y a dans le dépôt

| Fichier | Rôle |
|---|---|
| `index.html` | structure, feuille de style, interface |
| `data.js` | jeu de données embarqué : relief, bâti, voirie, eau, fiches des sites (210 Ko) |
| `core.js` | mathématiques 4×4, utilitaires WebGL, décodage binaire, triangulation |
| `build.js` | construction des maillages et du graphe d'itinéraire |
| `app.js` | nuanceurs GLSL, carte d'ombre, boucle de rendu, caméra, interactions |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation et fonctionnement hors ligne |
| `tools/build-data.mjs` | régénère `data.js` depuis OpenStreetMap et les tuiles d'élévation |
| `tools/routecheck.mjs` | banc d'essai du calcul d'itinéraire, hors navigateur |
| `docs/ARCHITECTURE.md` | notes techniques détaillées |

Aucune dépendance : pas de `package.json`, pas de `node_modules`, pas d'étape de compilation.
Le rendu 3D est écrit à la main en WebGL 2, sans bibliothèque.

---

## Licences et attribution

**Code** — [MIT](LICENSE).

**Données cartographiques** — © les contributeurs d'OpenStreetMap, sous
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). La mention affichée en bas de page
est une obligation de la licence : la conserver dans toute version dérivée ou intégrée.

**Relief** — tuiles Terrarium du jeu de données Mapzen / AWS Open Data (agrégat SRTM, NED,
EU-DEM…), résolution d'origine d'environ 14 m.

**Polices** — Fraunces et IBM Plex, sous SIL Open Font License.

**Écusson de l'Università di Corsica Pasquale Paoli** — propriété de l'université, **hors du
champ de la licence MIT**. Son usage relève de la charte graphique de l'établissement. Les
images concernées sont isolées et remplaçables : les deux `data:` URI de `index.html`
(`<img class="crest">` et `<img class="crest-full">`) et le dossier `icons/`.
Un fork qui n'émane pas de l'université doit les remplacer.
