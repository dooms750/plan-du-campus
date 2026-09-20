# Architecture

Notes techniques de **Plan du campus** : format des données, chaîne de rendu, calcul
d'itinéraire, profil mobile. Pour installer et déployer, voir le [README](../README.md).

Carte 3D interactive de Corte et des campus de l'Università di Corsica Pasquale Paoli.
Page statique autonome : aucun serveur applicatif, aucune dépendance npm, aucun appel réseau
à l'exécution. Le relief et les données OpenStreetMap sont embarqués dans `data.js`.

---

## Mise en route

```bash
# n'importe quel serveur statique fait l'affaire
python3 -m http.server 8080
# puis http://localhost:8080/
```

La page fonctionne aussi par simple double-clic sur `index.html` (`file://`), puisqu'elle ne fait
aucune requête réseau : pratique pour une démonstration hors ligne.

Déploiement : copier le dossier tel quel derrière Apache, nginx, un bucket S3, GitHub Pages…
Servir en HTTPS si la page est intégrée dans un site en HTTPS.

**Pré-requis navigateur** : WebGL 2 et `DecompressionStream` — Chrome/Edge 80+, Firefox 113+,
Safari 16.4+. Sur un navigateur plus ancien, la page affiche un message et s'arrête proprement.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | structure, feuille de style, interface (panneau campus, réglages, étiquettes) |
| `core.js` | mathématiques 4×4, utilitaires WebGL, décodage binaire, triangulation par oreilles |
| `build.js` | décodage du jeu de données et construction des maillages (relief, bâti, voirie, eau, occupation du sol) |
| `app.js` | nuanceurs GLSL, carte d'ombre, boucle de rendu, caméra orbitale, interactions |
| `data.js` | jeu de données embarqué (relief + vecteurs + fiches des sites) |
| `tools/build-data.mjs` | régénération de `data.js` depuis OpenStreetMap et les tuiles d'élévation |
| `manifest.webmanifest`, `sw.js`, `icons/` | installation sur l'écran d'accueil et fonctionnement hors ligne |

L'ordre de chargement des scripts compte : `data.js`, puis `core.js`, `build.js`, `app.js`.

---

## Régénérer les données

```bash
node tools/build-data.mjs      # Node 18+, réécrit data.js
```

Le script interroge l'API Overpass pour l'emprise `42.283,9.125,42.332,9.185` puis télécharge
16 tuiles d'élévation Terrarium au zoom 13. Comptez une trentaine de secondes.
Overpass est un service public mutualisé : ne pas l'appeler en boucle, et ne jamais le solliciter
depuis le navigateur des visiteurs — c'est précisément pour cela que les données sont figées
dans `data.js`.

Les réglages sont en tête du script :

| Constante | Effet |
|---|---|
| `LAT0` / `LON0` | centre de la scène ; toutes les coordonnées du jeu de données lui sont relatives |
| `BBOX` | emprise des données vectorielles interrogées sur Overpass |
| `HALF` | demi-emprise du relief en mètres (5500 → carré de 11 km) |
| `GW` | côté de la grille de relief (352 → un point tous les 31 m) |
| `TSTEP` / `Q` | quantification altimétrique / planimétrique, en mètres |

Changer `LAT0`, `LON0` et `BBOX` suffit à porter la carte sur une autre ville : le reste de
la chaîne est générique.

### Ajouter ou décrire un site

Le tableau `SITES`, dans `tools/build-data.mjs`, est le seul endroit à modifier. Chaque entrée
associe une expression régulière (appliquée au tag `name` d'OSM) à un intitulé, un sous-titre,
une notice et un cadrage de caméra :

```js
{ id: 'grimaldi', match: /Campus Grimaldi/i, name: 'Campus Grimaldi',
  sub: 'Sciences · Santé · Sport', note: '…',
  kind: 'campus',        // 'campus' → listé dans le panneau ; 'place' → simple étiquette
  r: 560,                // distance caméra à l'arrivée, en mètres
  phi: 0.38,             // élévation de la caméra, en radians (0 = rasant, 1.5 = zénithal)
  theta: 0.35 }          // azimut, en radians
```

Si un site n'existe pas encore dans OpenStreetMap, le plus propre est de l'y ajouter : la carte
en bénéficiera, et le reste du monde aussi. À défaut, une entrée peut être écrite directement
dans le tableau `places` de `data.js`, avec ses coordonnées `x`/`y` en mètres relatifs au centre.

---

## Recherche, catégories et salles

L'index de recherche est construit au démarrage (`buildIndex`, `app.js`) à partir de trois
sources : les sites du panneau, les 150 lieux repris d'OpenStreetMap (`CORTE_DATA.pois`) et
l'annuaire des salles (`salles.json`, facultatif).

**Repli des accents.** Chaque entrée porte une clé `key` normalisée en NFD, diacritiques
supprimés, en minuscules : « batiment desanti » trouve « Bâtiment Jean-Toussaint Desanti ».

**Alias.** Un étudiant tape « RU », pas « Restaurant Universitaire ». Deux tables les couvrent :
`ALIAS_NOM` pour les lieux précis, `ALIAS_GENRE` par genre (`distributeur` répond à « retrait »,
« argent », « billets »). Les alias entrent dans la clé mais ne s'affichent jamais.

**Classement.** Le score additionne la position du mot dans la clé (début de chaîne 100, début de
mot 70, ailleurs 30), un bonus universitaire, et surtout un bonus de 600 quand la frappe est
exactement un sigle connu — sans quoi « bu » remonterait l'IUT (« but ») avant la bibliothèque.

**Catégories.** Six groupes (`CATS`) filtrent les étiquettes affichées sur le plan, pas la
recherche, qui porte toujours sur tout. La catégorie « Université » est active au démarrage.

**Étiquettes des lieux.** Elles entrent dans la même passe de dé-chevauchement que les sites,
avec une priorité inférieure : un nom de boulangerie ne masquera jamais un campus. Les bâtiments
universitaires restent lisibles jusqu'à 2,6 km, les commerces n'apparaissent qu'en dessous
de 1 km — sinon la vallée entière se couvre de noms.

**Format des lieux.** `CORTE_DATA.pois` est un tableau de tableaux, pour tenir en 7 Ko :

```js
[x, y, categorie, genre, nom, universitaire]
// [-27, -212, "e", "biblio", "Bibliothèque universitaire", 1]
```

`x` et `y` sont en mètres entiers depuis l'origine de la scène ; `categorie` vaut `e`, `m`, `b`,
`s`, `l` ou `v` ; `genre` sert à l'intitulé et aux alias.

**Salles.** `salles.json` est chargé par `fetch` au démarrage. Absent, illisible, ou page ouverte
en `file://` : la promesse est capturée et la recherche porte alors sur les bâtiments seuls.
Chaque salle est rattachée à son bâtiment par son nom, et hérite de ses coordonnées — l'itinéraire
mène donc au bâtiment, l'étage étant donné dans la fiche.

---

## Format du jeu de données

`data.js` définit `window.CORTE_DATA` :

```jsonc
{
  "origin":     { "lat": 42.3025, "lon": 9.1525 },
  "mPerDegLat": 111079.13,          // mètres par degré, à cette latitude
  "mPerDegLon": 82457.28,
  "q":          0.5,                // quantum planimétrique, en mètres
  "terrain":    { "w": 352, "h": 352, "x0": -5500, "y0": -5500,
                  "dx": 31.339, "dy": 31.339,
                  "min": 235, "step": 0.25, "b64": "…" },
  "features":   "…",                // base64
  "places":     [ /* fiches des sites */ ]
}
```

Repère : `x` vers l'est, `y` vers le nord, en mètres depuis `origin`. Le moteur travaille
dans un repère main droite où `z = -y`.

**Relief** (`terrain.b64`) : gzip + base64. Une fois décompressé, une suite d'entiers varint
zigzag, un par point de la grille, lus du sud vers le nord et d'ouest en est. Chaque valeur est
le résidu par rapport au prédicteur plan `gauche + dessous − diagonale` (le premier point vaut 0,
la première ligne et la première colonne se prédisent sur leur unique voisin). L'altitude est
`min + valeur × step`. Ce prédicteur est ce qui fait tenir 124 000 points en 96 Ko.

**Vecteurs** (`features`) : gzip + base64. Un varint donne le nombre d'entités, puis pour chacune
trois octets — genre, sous-genre, drapeaux — un varint pour le nombre de sommets, et les sommets
en delta varint zigzag (`x` puis `y`, en unités de `q` mètres).

| Genre | Contenu | Sous-genre |
|---|---|---|
| 0 | bâtiment | hauteur en pas de 0,5 m |
| 1 | voirie | index dans `ROAD_W` / `ROAD_C` (`build.js`) |
| 2 | cours d'eau (linéaire) | 0 rivière, 1 ruisseau, 2 autre |
| 3 | plan d'eau (surfacique) | — |
| 4 | végétation | 0 forêt, 1 maquis, 2 pelouse, 3 cultures, 4 terrain de sport |
| 5 | roche nue | — |
| 6 | voie ferrée | — |
| 7 | stationnement | — |
| 8 | emprise de campus | — |

Drapeaux, genre 0 (bâtiment) : bit 0 = bâtiment universitaire (teinte ambre, mis en avant),
bit 1 = monument ou édifice remarquable.

Drapeaux, genre 1 (voirie) : bit 0 = sens unique dans le sens du tracé, bit 1 = sens unique
inverse (`oneway=-1`), bit 2 = circulation automobile interdite (voie piétonne, escalier,
accès privé ou réservé). Le champ `roadFlags: 1` en tête du jeu de données signale leur présence.

---

## Fonctionnement du rendu

Tout est écrit à la main en WebGL 2, sans bibliothèque 3D.

1. **Passe d'ombre** — relief et bâti rendus en profondeur seule dans une texture 2048²
   depuis le soleil, projection orthographique recentrée sur la cible de la caméra.
2. **Ciel** — dégradé calculé par rayon de vue, halo solaire à trois lobes et bande de brume
   rasante à l'horizon.
3. **Relief** — 124 000 sommets, couleur par altitude et par pente, mélangée à une texture
   d'occupation du sol dessinée au chargement sur un canevas 2D, ombres portées avec PCF 3×3,
   courbes de niveau tous les 100 m, brume exponentielle.
4. **Voirie et hydrographie** — rubans drapés sur le relief, décalage de profondeur
   (`gl.polygonOffset`) pour éviter le z-fighting.
5. **Bâti** — prismes extrudés, assise calée sur le point le plus bas de l'emprise,
   occlusion verticale approchée, lueur des fenêtres après le crépuscule.
6. **Étiquettes** — éléments HTML projetés à chaque image, avec dé-chevauchement en espace écran
   (les sites prioritaires masquent les autres).
7. **Halo lumineux** — l'image finie est recopiée (`copyTexSubImage2D`), seuillée au quart de
   côté, floutée en deux passes séparables, puis rajoutée en fondu additif. Le seuil s'applique
   après le tonemapping, donc sur ce que l'œil perçoit comme lumineux : le soleil, les fenêtres
   allumées au crépuscule, le tracé de l'itinéraire. Trois passes au seizième des pixels, coupées
   d'office si l'échelle de rendu adaptative est déjà descendue sous 0,72 sur téléphone.

**Chaîne colorimétrique.** Les teintes du jeu de couleurs sont écrites en espace d'affichage puis
linéarisées avant l'éclairage ; le calcul se fait en linéaire, et chaque nuanceur termine par
`present()` — exposition, courbe ACES, vignetage optique léger, transfert sRGB. C'est ce qui donne
des versants ensoleillés qui se compriment au lieu de s'écrêter et des ombres qui gardent leur
couleur. L'exposition suit l'heure : l'œil s'ouvre quand le jour tombe. Un étalonnage final
(`grade()`) ajoute un contraste en S, refroidit les ombres et réchauffe les hautes lumières :
l'écart entre l'adret et l'ubac se lit en teinte autant qu'en clarté.

**Grain de surface.** Sans lui, le relief est un aplat de plastique. Deux octaves de bruit de
valeur modulent l'albédo du terrain, d'amplitude double sur les pentes raides et éteinte au-delà
de 2 km pour ne pas fourmiller au loin.

**Perspective aérienne.** La brume n'est pas une couleur unique : elle prend le bleu du ciel quand
le regard porte vers le bas, chauffe vers le soleil, et les lointains se désaturent avant même de
se voiler.

La caméra est un ressort critique sur cinq paramètres (cible, distance, azimut, élévation) ;
l'orbite automatique reprend après trois secondes d'inactivité.

### Points d'entrée pour modifier l'apparence

| Quoi | Où |
|---|---|
| palette du bâti | `PALETTE_WALL` / `PALETTE_ROOF`, `build.js` |
| largeurs et couleurs de voirie | `ROAD_W` / `ROAD_C`, `build.js` |
| couleurs d'occupation du sol | `greenTints` dans `buildCover`, `build.js` |
| étagement altimétrique des couleurs | `reliefColour`, `FS_TERRAIN` dans `app.js` |
| course et teinte du soleil | `sunFor`, `app.js` |
| densité de brume | `uFogDensity` dans `setCommon`, `app.js` |
| cadrage d'ouverture | fin de `boot`, `app.js` |
| interface, typographie, thème | `index.html` |

---

## Profil mobile

La page se comporte comme une application : pas de rebond de défilement, pas de surbrillance au
toucher, cibles tactiles élargies, et deux doigts pour déplacer la carte (pincer pour zoomer,
glisser pour déplacer ; un doigt fait tourner la caméra).

### Coque « application téléphone »

Sous 760 px de large, l'interface bascule d'un habillage de bureau (panneaux flottants) vers une
**feuille inférieure** à deux crans, plus un bouton flottant de géolocalisation. Rien n'est
dupliqué : `applyLayout()` (app.js) **déplace** les mêmes nœuds DOM entre les conteneurs de bureau
et les emplacements de la feuille — `#slotNote`, `#slotNav`, `#slotFoot`, `#slotStrip` — puis les
remet en place si la fenêtre s'élargit. Une seule source de vérité pour l'interface, donc pas de
divergence entre les deux présentations.

| Élément | Rôle |
|---|---|
| `.sheet[data-state="mini"]` | la feuille s'efface : il ne reste qu'un bandeau — pictogramme, durée, distance, destination — et le tracé occupe tout l'écran |
| `.sheet[data-state="peek"]` | 52 vh : pastilles des sites en bandeau horizontal (`order: -1`) et fiche d'itinéraire condensée (description et intitulé masqués) |
| `.sheet[data-state="open"]` | 78 vh : fiche complète, liste verticale des sites, boutons de position, calques et curseur d'heure |
| `.sheet-grip` | poignée : tape pour changer de cran, glisse verticale pour ouvrir/replier (`bindSheet()`) |
| `.fab` | pastille de 52 px en bas à droite, teintée turquoise une fois la position acquise ; masquée quand la feuille est ouverte |

Le passage d'un cran à l'autre se fait par tape ou par glissé sur la poignée ; le bandeau du cran
« mini » est lui-même un bouton qui rouvre la fiche. Dès qu'un itinéraire est calculé, la feuille
descend d'elle-même au cran « mini » — c'est le moment où l'on veut voir le trajet, pas le menu.
`flyTo()` replie la feuille au cran « aperçu » : choisir un site rend aussitôt la carte visible.
La feuille réserve `env(safe-area-inset-bottom)` pour l'encoche et la barre d'accueil iOS.

Trois mesures tiennent le fréquence d'images sur téléphone :

| Mesure | Effet |
|---|---|
| plafond de pixels (`PIXEL_BUDGET`) | 1,45 Mpx sur mobile contre 4,4 sur écran large ; un iPhone rend donc à 2× plutôt qu'à 3× |
| échelle de rendu adaptative | mesure glissante du temps d'image, l'échelle descend jusqu'à 0,58 puis remonte dès que ça respire |
| carte d'ombre mise en cache | la passe d'ombre dessine 800 000 triangles : elle n'est refaite que si le soleil ou le cadrage bougent, soit une image sur plusieurs dizaines caméra immobile |

La carte d'ombre passe par ailleurs de 2048² à 1024² sur mobile.

## Performance

Environ 700 000 triangles pour le relief et 150 000 pour le bâti, soit une passe d'ombre et une
passe principale par image. Fluide sur GPU intégré récent ; sur machine modeste, les leviers sont
`SHADOW_SIZE` (app.js), `GW` (régénération du relief) et la taille de la texture d'occupation du sol
(appel `buildCover(gl, feats, field, 2048)`).

---

## Position et itinéraire piéton

Trois commandes dans le panneau des sites :

- **Ma position** — `navigator.geolocation.watchPosition` en haute précision. La position est
  projetée dans le repère local de la scène, matérialisée par un fût turquoise et son cercle de
  précision, et suivie en continu. Rien ne quitte le navigateur : aucune requête réseau n'est
  émise, la position n'est ni stockée ni transmise. Nécessite HTTPS (ou `localhost`).
- **Départ manuel** — bouton d'appoint : arme le mode « pose un point » pour un clic suivant.
- **Choisir un site** — dès qu'un départ existe, l'itinéraire se calcule et la caméra cadre
  le trajet entier.

### Tout se fait sur la carte

Le détour par le menu n'est plus nécessaire — les deux gestes utiles sont directs :

| Geste | Effet |
|---|---|
| **appui long** (460 ms) sur le relief | pose le départ à cet endroit (`dropStart`) ; un anneau turquoise grandit sous le doigt pendant l'appui, et le mouvement au-delà de 9 px l'annule |
| **tape brève** près d'un site | le choisit comme destination (`tapPlace`) : les sites sont projetés à l'écran et le plus proche du doigt gagne, dans un rayon de 17 % du petit côté, plafonné à 110 px — on vise un bâtiment, pas une coordonnée |

Si une destination est déjà choisie quand le départ est posé (ou l'inverse), l'itinéraire se
recalcule et la caméra se recadre dans la foulée.

### La fiche d'itinéraire

Tout tient dans la fiche du site, sans écran intermédiaire :

| Élément | Ce qu'il apporte |
|---|---|
| fil du trajet | pastille turquoise « votre position » ─ losange ambre « site », les mêmes repères que sur la carte |
| deux tuiles | pictogramme, **durée en gros**, distance en dessous ; la tuile grisée signale un mode sans chemin |
| profil en long | `profile()` échantillonne 48 altitudes le long du tracé, `profileSvg()` en fait une aire SVG ; les étiquettes donnent la montée et la descente cumulées |
| distance et heure d'arrivée | l'heure est plus parlante qu'une durée quand on doit être en cours à heure fixe |

Sur la carte, les deux extrémités sont explicites : **pastille turquoise** cerclée de blanc pour la
position (`buildMarker(..., 'dot')`, trois disques empilés pour rester lisible sur un toit clair
comme sur la forêt) et **fanion ambre** pour la destination (`'pin'`). Les deux sont des géométries
posées au sol : leur rayon est recalculé par paliers en fonction de la distance caméra
(`markScale()` / `refreshMarkers()`), sans quoi un disque de 13 m disparaît dès qu'on prend du recul.

Le cadrage s'adapte à l'orientation : en portrait la caméra se place **dans l'axe du trajet**, qui
se déploie du bas vers le haut de l'écran ; en paysage elle se place perpendiculairement, et le
trajet traverse l'image. Sur grand écran, la liste des sites se replie d'elle-même quand un
itinéraire apparaît (`foldRail()`, bouton **Masquer / Afficher** dans l'en-tête du panneau).

Tant qu'aucun départ n'existe, la fiche montre un seul bouton — **Activer ma position** — plutôt
qu'un message d'état : une action, une seule, au même endroit que le résultat.

### Les deux modes

Le sélecteur de la fiche affiche les deux durées côte à côte — **à pied** et **en voiture** — et
bascule le tracé d'un mode à l'autre. Chaque mode a son propre graphe, construit à la demande et
mis en cache :

| | à pied | en voiture |
|---|---|---|
| voies retenues | tout sauf autoroutes et voies rapides | tout sauf voies piétonnes, escaliers, chemins et accès privés |
| sens uniques | ignorés | respectés (`oneway`, ronds-points) |
| coût d'un arc | temps de Tobler, fonction de la pente réelle | longueur ÷ vitesse effective de la classe (`CAR_SPEED`) |
| dénivelé affiché | oui | non |

Les raccords entre le point réel et le réseau sont comptés à la vitesse de marche dans les deux
cas : on rejoint toujours sa voiture à pied.

`access=destination` (et `customers`, `delivery`) **n'interdit pas** la circulation automobile :
la mention réserve la voie à la desserte locale, ce qui est précisément le cas de quelqu'un qui
s'y rend. Les exclure rendait la citadelle inaccessible en voiture. Seuls `no` et `private`
ferment vraiment une voie.

Banc d'essai (`routecheck.mjs`, 108 trajets par mode depuis des départs tirés au hasard dans la
cuvette urbaine) : 108/108 à pied en 4,5 ms par trajet, 97/108 en voiture en 6,5 ms. Les onze
échecs concernent tous l'IUT, desservi dans OSM par une boucle de service à sens unique qu'aucun
arc n'autorise à pénétrer — l'interface le signale en désactivant le mode voiture plutôt qu'en
affichant un trajet faux.

### Le calcul

`buildGraph` (dans `build.js`) assemble le graphe à partir des seules entités de voirie du jeu de
données : les sommets OSM partagés se retrouvent par quantification à 0,5 m, ce qui reconstitue la
topologie sans table de nœuds. **La voirie n'est jamais simplifiée à l'encodage** — une
simplification de Douglas-Peucker supprimait les sommets de jonction et fracturait le réseau en
341 composantes, avec un tiers des trajets impossibles. Sans elle : 15 composantes, dont une
principale qui couvre 99,6 % du réseau piéton.

L'accrochage d'un point au réseau se fait **sur le segment, pas sur le sommet** : 8 % des segments
de Corte dépassent 50 m et le plus long atteint 1,3 km, si bien que viser le sommet le plus proche
pouvait décaler le départ de plusieurs centaines de mètres. `snapCandidates` projette le point sur
les segments voisins via un index spatial, `routePoints` insère un sommet virtuel le temps du
calcul puis restaure le graphe, et réessaie sur les accrochages suivants si aucun chemin ne passe. Autoroutes et voies rapides sont exclues ; chaque
classe porte un coefficient de confort (`WALK_PEN`) qui favorise ruelles, escaliers et chemins
sur les axes routiers.

Le coût d'un arc n'est pas une longueur mais un **temps de marche**, calculé par la fonction de
Tobler à partir de la pente réelle tirée du relief :

```
v = 6 · exp(−3,5 · |pente + 0,05|)   km/h
```

À Corte, où la vieille ville grimpe vers la citadelle, cela change les itinéraires : le chemin le
plus court n'est pas le plus rapide. Un A* (`findRoute`) avec heuristique euclidienne divisée par
la vitesse de plat donne le trajet, sa longueur, sa durée et ses dénivelés cumulés.

Le réseau OSM comporte des tronçons isolés (impasses non raccordées, voies de service internes).
`buildGraph` calcule donc les composantes connexes : le départ s'accroche au réseau principal, et
l'arrivée à la même composante que le départ — sans quoi une arrivée posée sur un tronçon orphelin
rendait le calcul impossible.

Le tracé est un ruban drapé sur le relief, parcouru d'une onde lumineuse dont l'abscisse
curviligne est portée par un attribut de sommet (`ribbonS`, programme `VS_ROUTE`/`FS_ROUTE`).

### Régler le comportement

| Quoi | Où |
|---|---|
| confort par classe de voie | `WALK_PEN`, `build.js` |
| vitesse de marche selon la pente | `walkSpeed`, `build.js` |
| largeur et couleur du tracé | `buildRouteMesh`, `build.js` |
| apparence du repère de position | `buildMarker`, `build.js` |
| cadrage à l'arrivée d'un calcul | `frameRoute`, `app.js` |

---

## Licences et attribution

**Données OpenStreetMap** — © les contributeurs d'OpenStreetMap, sous
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). La mention en bas de page est une
obligation de la licence : la conserver, visible, dans toute version dérivée ou intégrée.
Toute correction du bâti ou des noms de bâtiments gagne à être faite en amont, dans OSM.

**Relief** — tuiles Terrarium du jeu de données Mapzen/AWS Open Data, agrégat de sources publiques
(SRTM, NED, EU-DEM…), attribution recommandée et présente en bas de page. Résolution d'origine
d'environ 14 m au zoom 13 : suffisante pour la silhouette de la vallée, à ne pas confondre avec
un MNT topographique.

**Polices** — Fraunces et IBM Plex, distribuées par Google Fonts sous SIL Open Font License.
Chargées depuis `fonts.googleapis.com` ; pour un déploiement sans dépendance externe ou conforme
à une politique RGPD stricte, héberger les fichiers de police et remplacer la balise `<link>`.

**Identité visuelle** — l'écusson de l'Università di Corsica Pasquale Paoli est la propriété de
l'université ; son usage relève de sa charte graphique. Les images embarquées ici ont été
détourées depuis un visuel institutionnel fourni par le commanditaire, et sont volontairement
isolées pour être remplaçables :

| Où | Quoi |
|---|---|
| `index.html`, `<img class="crest">` | écusson seul, WebP en `data:` URI, affiché à 36–50 px |
| `index.html`, `<img class="crest-full">` | verrouillage complet sur l'écran de chargement |
| `icon-180.png` | icône d'application 180×180 |

Pour repartir des fichiers officiels de la direction de la communication, il suffit de remplacer
ces trois images — aucune règle de style ne dépend de leur contenu, seulement de leur hauteur.

**Code** — écrit pour l'Università di Corsica ; à placer sous la licence de votre choix.

---

## Pistes d'évolution

- Recherche de bâtiment ou d'amphithéâtre, avec vol vers le résultat.
- Couche « vie étudiante » : restaurants universitaires, résidences, arrêts de bus, à partir des
  tags OSM déjà présents dans la réponse Overpass.
- Itinéraires piétons entre deux sites, calculés sur le graphe `highway` déjà embarqué.
- Lien profond par site (`#grimaldi`) pour pointer un campus depuis le site de l'université.
- Découpage du jeu de données en deux fichiers pour un affichage progressif du relief puis du bâti.
