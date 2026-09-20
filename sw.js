/* Plan du campus — service worker
 *
 * L'application n'appelle aucun service à l'exécution : relief, bâti, voirie
 * et fiches des sites sont embarqués dans data.js. Il suffit donc de mettre
 * la coque en cache une fois pour que tout fonctionne sans réseau — ce qui
 * est le cas d'usage réel : un étudiant au fond d'un amphithéâtre, ou dans
 * la vallée du Tavignanu où la 4G est capricieuse.
 *
 * Stratégie : cache d'abord pour la coque (elle ne change qu'à la
 * publication), réseau d'abord pour la navigation avec repli sur le cache.
 * Pour changer de version, incrémenter VERSION : l'ancien cache est purgé
 * à l'activation.
 */

const VERSION = 'v12';
const SHELL = `plan-du-campus-${VERSION}`;
const RUNTIME = `plan-du-campus-runtime-${VERSION}`;

/* data.js pèse 210 Ko : c'est le gros morceau, et c'est justement lui
   qu'on ne veut pas retélécharger.
 *
 * Les scripts portent la version dans leur adresse (app.js?v12). C'est ce
 * qui garantit qu'une page fraîche ne puisse jamais être servie avec
 * d'anciens scripts : la nouvelle page demande des adresses que l'ancien
 * cache ne contient pas, donc elles viennent du réseau. Sans cela, la page
 * HTML (servie réseau d'abord) et les scripts (servis cache d'abord) se
 * désynchronisent et l'utilisateur reste bloqué sur l'ancienne version.
 * C'est pourquoi la mise en cache compare l'adresse complète, requête
 * comprise — pas d'ignoreSearch ici. */
const ASSETS = [
  './',
  'index.html',
  `data.js?${VERSION}`,
  `core.js?${VERSION}`,
  `build.js?${VERSION}`,
  `app.js?${VERSION}`,
  /* salles.json est demandé sans version par l'application : on le garde
     tel quel. Aucun risque de péremption, le cache entier est reconstruit
     à chaque changement de VERSION. */
  'salles.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.png'
];

/* Les polices viennent de Google Fonts. Elles sont mises en cache au vol,
   et leur absence n'empêche rien : la feuille de style prévoit des polices
   système en repli. Pour s'en passer tout à fait, voir le README. */
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // navigation : on tente le réseau, on retombe sur la page en cache
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copie = res.clone();
          caches.open(SHELL).then(c => c.put('index.html', copie)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('index.html', { ignoreSearch: true }))
    );
    return;
  }

  // polices : cache au vol, sans jamais bloquer
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(RUNTIME).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // coque : cache d'abord, adresse exacte (la version est dans la requête)
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
  }
});
