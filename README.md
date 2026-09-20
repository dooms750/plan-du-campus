# Plan du campus

Plan en relief des campus de l'**Università di Corsica Pasquale Paoli**, à Corte.
Une page web, aucun serveur applicatif, aucun compte, aucune publicité, aucun traqueur.

👉 **[Ouvrir le plan](https://dooms750.github.io/plan-du-campus/)**

---

## Pour les étudiants

Vous arrivez à Corte et vous cherchez votre premier cours.

- **Cherchez un nom.** « Desanti », « RU », « BU », « IUT », « gare », « courses » : le champ de
  recherche connaît les bâtiments universitaires, les sigles, et 150 lieux de la ville. Pas besoin
  des accents ni de l'orthographe exacte — « batiment desanti » suffit.
- **Touchez un bâtiment sur le plan.** Il s'ouvre, avec son nom et sa description.
- **Filtrez ce que vous voyez.** Université, Manger, Se déplacer, Services, Sport, Vivre :
  les noms s'affichent sur le plan par catégorie.
- **Savoir combien de temps ça prend.** Durée à pied *et* en voiture côte à côte, distance,
  dénivelé, heure d'arrivée. À Corte, le dénivelé n'est pas un détail.
- **Poser un départ où l'on veut.** Gardez le doigt appuyé une demi-seconde sur le plan.
  Ou touchez le bouton de position pour partir d'où vous êtes.
- **Sans réseau.** Une fois la page ouverte, tout est en mémoire : le relief, les rues, les
  bâtiments, les 150 lieux. Elle fonctionne dans un amphi, dans le train, dans la vallée.

### Ce que la recherche connaît

| Vous tapez | Vous trouvez |
|---|---|
| `desanti`, `conrad`, `alfonsi`, `culombu` | les bâtiments de l'université, par leur nom |
| `RU`, `BU`, `IUT`, `CROUS`, `INSPÉ`, `IAE`, `FST` | les sigles du quotidien |
| `amphi`, `B204` | les salles, si la scolarité a rempli l'annuaire (voir plus bas) |
| `courses`, `pain`, `retrait`, `pharmacie` | par besoin, pas seulement par nom |
| `gare`, `bus`, `parking` | les transports |

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
git clone https://github.com/dooms750/plan-du-campus.git
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

Une minute plus tard, le plan est en ligne sur `https://dooms750.github.io/plan-du-campus/`.
La géolocalisation et l'installation sur l'écran d'accueil exigent HTTPS : Pages le fournit.

Pour héberger ailleurs (Apache, nginx, un bucket S3, un intranet), copier le dossier tel quel.
Servir `sw.js` depuis la racine du site, sinon la portée du service worker ne couvre pas la page.

### Après une modification

Le service worker sert la coque depuis le cache. Pour que les visiteurs reçoivent la nouvelle
version, **incrémenter `VERSION` en tête de `sw.js`** (`v10` → `v11`) dans le même commit.
L'ancien cache est purgé à l'activation.

### Remplir l'annuaire des salles

C'est l'attente la plus fréquente d'un étudiant de première année : « je cherche la B204 ».
Cette information n'existe dans aucune base publique — elle est chez vous. Le fichier
`salles.json` est prévu pour la recevoir, et l'application fonctionne sans.

Une salle se décrit en cinq champs, dont deux obligatoires :

```json
{ "code": "B204", "batiment": "Bâtiment Jean-Toussaint Desanti",
  "nom": "Salle de travaux dirigés", "etage": 2, "info": "Accès par la cour" }
```

`batiment` doit reprendre un nom de la liste `_batiments` figurant en tête de `salles.json`
(les 23 bâtiments relevés dans OpenStreetMap). Une salle rattachée à un bâtiment inconnu ne
sera pas trouvable.

Depuis un tableur, exportez en CSV et lancez :

```bash
node tools/salles-csv.mjs salles.csv --verifier   # contrôle, n'écrit rien
node tools/salles-csv.mjs salles.csv              # écrit salles.json
```

Le script accepte les en-têtes en français avec ou sans accents, détecte le séparateur d'un
export Excel français, et signale les bâtiments qu'il ne reconnaît pas. Pensez ensuite à
incrémenter `VERSION` dans `sw.js`.

Pour voir à quoi ressemble la fonction avant d'avoir les vraies données, `salles.exemple.json`
contient trois salles fictives : mettez `salles.json` de côté, renommez l'exemple, rechargez.
**Ne pas mettre ce fichier d'exemple en production** — il décrirait des salles qui n'existent pas.

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
| `salles.json` | annuaire des salles, tenu par l'établissement (vide au départ) |
| `salles.exemple.json` | même format, avec trois salles fictives pour essayer |
| `sw.js`, `manifest.webmanifest`, `icons/` | installation et fonctionnement hors ligne |
| `tools/build-data.mjs` | régénère `data.js` depuis OpenStreetMap et les tuiles d'élévation |
| `tools/routecheck.mjs` | banc d'essai du calcul d'itinéraire, hors navigateur |
| `tools/salles-csv.mjs` | convertit un export CSV de la scolarité en `salles.json` |
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
