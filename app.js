/* Plan du campus — renderer, camera, interface */
'use strict';

const COMMON = `
uniform float uExposure;
uniform vec2 uRes;

float fogAmt(float d, float density) { float f = d * density; return 1.0 - exp(-f * f); }

/* courbe ACES (approximation de Narkowicz) — comprime les hautes lumières
   au lieu de les écrêter, ce qui rend les versants ensoleillés et le ciel */
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

/* Étalonnage final, en espace d'affichage : un soupçon de contraste en S,
   des ombres qui tirent vers le bleu et des hautes lumières qui se
   réchauffent — l'écart entre le versant à l'ombre et celui au soleil se
   lit alors en teinte autant qu'en clarté. */
vec3 grade(vec3 c) {
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.20);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(vec3(0.955, 0.985, 1.070), vec3(1.055, 1.012, 0.950), smoothstep(0.22, 0.88, l));
  return clamp(mix(vec3(l), c, 1.09), 0.0, 1.0);
}

/* exposition, léger vignetage optique, transfert sRGB, étalonnage */
vec3 present(vec3 c) {
  vec2 q = gl_FragCoord.xy / max(uRes, vec2(1.0)) - 0.5;
  float vig = 1.0 - dot(q, q) * 0.30;
  return grade(pow(aces(c * uExposure * vig), vec3(1.0 / 2.2)));
}

/* bruit de valeur bon marché, pour casser le lissé des grandes surfaces */
float hash21(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.19);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

/* perspective aérienne : la brume prend la teinte du ciel, et chauffe
   quand le regard porte vers le soleil */
vec3 aerial(vec3 col, vec3 wp, vec3 cam, vec3 sunDir, vec3 sunCol, vec3 horizon, vec3 zenith, float density) {
  vec3 V = normalize(wp - cam);
  float s = max(dot(V, sunDir), 0.0);
  vec3 h = mix(horizon, zenith * 1.04, clamp(-V.y * 1.1, 0.0, 1.0));
  h += sunCol * pow(s, 7.0) * 0.20;
  return mix(col, h, fogAmt(distance(cam, wp), density));
}
`;

/* ------------------------------------------------ shaders */
const VS_SKY = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.999, 1.0); }`;

const FS_SKY = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform mat4 uInvVP;
uniform vec3 uCam, uSun, uZenith, uHorizon, uSunTint;
out vec4 frag;
void main(){
  vec4 p0 = uInvVP * vec4(vNdc, -1.0, 1.0);
  vec4 p1 = uInvVP * vec4(vNdc,  1.0, 1.0);
  vec3 dir = normalize(p1.xyz / p1.w - p0.xyz / p0.w);
  float h = clamp(dir.y * 1.25 + 0.06, -1.0, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.62);
  vec3 col = mix(uHorizon, uZenith, t);
  float sd = max(dot(dir, uSun), 0.0);
  col += uSunTint * (pow(sd, 900.0) * 4.2 + pow(sd, 22.0) * 0.55 + pow(sd, 3.0) * 0.12);
  float band = exp(-abs(dir.y) * 8.0);
  col = mix(col, uHorizon * 1.10, band * 0.34);
  float below = smoothstep(0.02, -0.16, dir.y);
  col = mix(col, uHorizon * 0.55, below);
  frag = vec4(present(col), 1.0);
}`;

const SHADOW_FN = `
precision highp sampler2DShadow;
uniform sampler2DShadow uShadow;
uniform mat4 uLightVP;
uniform float uShadowTexel;
const vec2 POISSON[8] = vec2[8](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696,  0.457), vec2(-0.203,  0.621),
  vec2( 0.962, -0.195), vec2( 0.473, -0.480), vec2( 0.519,  0.767), vec2( 0.185, -0.893));

float shadowAt(vec3 wp, float ndl){
  vec4 lp = uLightVP * vec4(wp, 1.0);
  vec3 pc = lp.xyz / lp.w * 0.5 + 0.5;
  if (pc.x < 0.004 || pc.x > 0.996 || pc.y < 0.004 || pc.y > 0.996 || pc.z > 1.0) return 1.0;
  float bias = max(0.0009, 0.0060 * (1.0 - ndl));
  /* rotation par pixel : le bruit remplace l'escalier des 9 taps réguliers */
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  vec2 rot = vec2(cos(a), sin(a));
  float s = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 o = POISSON[i];
    vec2 d = vec2(o.x * rot.x - o.y * rot.y, o.x * rot.y + o.y * rot.x) * uShadowTexel * 2.4;
    s += texture(uShadow, vec3(pc.xy + d, pc.z - bias));
  }
  return s / 8.0;
}`;

const VS_TERRAIN = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uVP;
uniform vec4 uExtent; // x0, y0, width, height  (map space)
out vec3 vPos; out vec3 vNormal; out vec2 vUV;
void main(){
  vPos = aPos; vNormal = aNormal;
  vUV = vec2((aPos.x - uExtent.x) / uExtent.z, (-aPos.z - uExtent.y) / uExtent.w);
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_TERRAIN = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal; in vec2 vUV;
uniform vec3 uCam, uSun, uSunColor, uSkyAmb, uHorizon, uZenith;
uniform float uFogDensity, uContour;
uniform sampler2D uCover;
${SHADOW_FN}
out vec4 frag;

vec3 reliefColour(float h, float slope){
  vec3 valley = vec3(0.335, 0.345, 0.255);
  vec3 maquis = vec3(0.285, 0.315, 0.225);
  vec3 upland = vec3(0.365, 0.350, 0.265);
  vec3 scree  = vec3(0.45, 0.42, 0.36);
  vec3 granite= vec3(0.56, 0.54, 0.50);
  vec3 c = mix(valley, maquis, smoothstep(380.0, 620.0, h));
  c = mix(c, upland, smoothstep(700.0, 1150.0, h));
  c = mix(c, scree, smoothstep(1150.0, 1520.0, h));
  c = mix(c, granite, smoothstep(1500.0, 1950.0, h));
  c = mix(c, vec3(0.50, 0.47, 0.43), smoothstep(0.42, 0.78, slope) * 0.75);
  return c;
}

void main(){
  vec3 N = normalize(vNormal);
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  vec3 base = reliefColour(vPos.y, slope);
  vec4 cover = texture(uCover, vUV);
  base = mix(base, cover.rgb, cover.a * 0.62);

  /* Grain de surface : sans lui, les versants sont des aplats de plastique.
     Deux octaves, l'amplitude s'éteint avec la distance pour ne pas
     fourmiller au loin, et double sur les pentes raides (éboulis, rochers). */
  float dist = distance(uCam, vPos);
  float near = 1.0 - smoothstep(320.0, 2100.0, dist);
  float grain = vnoise(vPos.xz * 0.075) * 0.62 + vnoise(vPos.xz * 0.27) * 0.38;
  base *= 1.0 + (grain - 0.5) * (0.20 + slope * 0.26) * near;

  base *= base;                      // sRGB -> linéaire (approximation gamma 2)

  float ndl = max(dot(N, uSun), 0.0);
  float sh = shadowAt(vPos, ndl);
  float sky = 0.5 + 0.5 * N.y;
  vec3 col = base * (uSkyAmb * sky + uSunColor * ndl * sh);

  // 100 m contour lines, faded in the distance
  float d = dist;
  float cw = fwidth(vPos.y) * 1.4 + 0.001;
  float line = smoothstep(cw, 0.0, abs(fract(vPos.y / 100.0) - 0.5) - 0.5 + cw);
  col = mix(col, col * 0.80, line * uContour * (1.0 - smoothstep(1200.0, 4200.0, d)));

  /* les lointains se désaturent avant même la brume */
  float far = smoothstep(1600.0, 5200.0, d);
  col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))) * 1.02, far * 0.16);
  frag = vec4(present(aerial(col, vPos, uCam, uSun, uSunColor, uHorizon, uZenith, uFogDensity)), 1.0);
}`;

const VS_BUILDING = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aExtra; // ao, university flag
uniform mat4 uVP;
out vec3 vPos; out vec3 vNormal; out vec3 vColor; out vec2 vExtra;
void main(){
  vPos = aPos; vNormal = aNormal; vColor = aColor; vExtra = aExtra;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const FS_BUILDING = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNormal; in vec3 vColor; in vec2 vExtra;
uniform vec3 uCam, uSun, uSunColor, uSkyAmb, uHorizon, uAccent, uZenith;
uniform float uFogDensity, uHighlight, uNight;
${SHADOW_FN}
out vec4 frag;
void main(){
  vec3 N = normalize(vNormal);
  float ndl = max(dot(N, uSun), 0.0);
  float sh = shadowAt(vPos, ndl);
  float ao = vExtra.x;
  vec3 albedo = mix(vColor, uAccent, vExtra.y * uHighlight * 0.55);
  /* bande d'ombre sous l'égout du toit : sépare les volumes sans données de toiture */
  float isWall = 1.0 - smoothstep(0.55, 0.92, abs(N.y));
  albedo *= 1.0 - isWall * smoothstep(0.88, 1.0, ao) * 0.20;
  albedo *= albedo;                  // sRGB -> linéaire
  float sky = 0.5 + 0.5 * N.y;
  float occ = 0.55 + 0.45 * ao;
  vec3 col = albedo * (uSkyAmb * (0.55 + 0.45 * sky) * occ * 1.3 + uSunColor * ndl * sh * occ);
  /* éclat rasant sur les toits, qui accroche la lumière du soir */
  vec3 V = normalize(uCam - vPos);
  vec3 H = normalize(uSun + V);
  col += uSunColor * sh * pow(max(dot(N, H), 0.0), 26.0) * 0.16 * smoothstep(0.6, 0.95, abs(N.y));
  // lueur des fenêtres après le crépuscule
  col += albedo * uNight * (0.35 + vExtra.y * 0.8) * vec3(1.0, 0.72, 0.36) * (1.0 - ao) * 0.6;
  frag = vec4(present(aerial(col, vPos, uCam, uSun, uSunColor, uHorizon, uZenith, uFogDensity)), 1.0);
}`;

const VS_FLAT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uVP;
out vec3 vPos; out vec3 vColor;
void main(){ vPos = aPos; vColor = aColor; gl_Position = uVP * vec4(aPos, 1.0); }`;

const FS_ROAD = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vColor;
uniform vec3 uCam, uHorizon, uSunColor, uSkyAmb, uSun, uZenith;
uniform float uFogDensity;
out vec4 frag;
void main(){
  vec3 col = vColor * vColor * (uSkyAmb * 0.9 + uSunColor * 0.55);
  frag = vec4(present(aerial(col, vPos, uCam, uSun, uSunColor, uHorizon, uZenith, uFogDensity)), 1.0);
}`;

const FS_WATER = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vColor;
uniform vec3 uCam, uHorizon, uSunColor, uSkyAmb, uSun, uZenith;
uniform float uFogDensity, uTime;
out vec4 frag;
void main(){
  vec3 V = normalize(uCam - vPos);
  float ripple = sin(vPos.x * 0.22 + uTime * 1.1) * 0.5 + sin(vPos.z * 0.31 - uTime * 0.8) * 0.5;
  vec3 N = normalize(vec3(ripple * 0.06, 1.0, cos(vPos.z * 0.25 + uTime) * 0.05));
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0);
  vec3 col = vColor * vColor * (uSkyAmb * 0.9 + uSunColor * 0.4);
  col = mix(col, uZenith * 0.95, fres * 0.60) + uSunColor * spec * 1.1;
  float glint = pow(max(dot(reflect(-uSun, N), V), 0.0), 260.0);
  col += uSunColor * glint * 1.6;
  frag = vec4(present(aerial(col, vPos, uCam, uSun, uSunColor, uHorizon, uZenith, uFogDensity)), 1.0);
}`;

const FS_RING = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vColor;
uniform vec3 uCam;
uniform float uTime, uRingFade;
out vec4 frag;
void main(){
  float pulse = 0.72 + 0.28 * sin(uTime * 2.0);
  float fade = 1.0 - smoothstep(2400.0, 5000.0, distance(uCam, vPos));
  frag = vec4(present(vColor * pulse * 1.5), uRingFade * fade);
}`;

/* tracé d'itinéraire : ruban lumineux parcouru d'une onde */
const VS_ROUTE = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aS;
uniform mat4 uVP;
out vec3 vPos; out vec3 vColor; out float vS;
void main(){ vPos = aPos; vColor = aColor; vS = aS; gl_Position = uVP * vec4(aPos, 1.0); }`;

const FS_ROUTE = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vColor; in float vS;
uniform vec3 uCam;
uniform float uTime;
out vec4 frag;
void main(){
  float m = fract(vS * 0.035 - uTime * 0.42);
  float wave = smoothstep(0.0, 0.30, m) * smoothstep(1.0, 0.62, m);
  vec3 col = vColor * (0.70 + 1.25 * wave);
  float fade = 1.0 - smoothstep(2600.0, 5200.0, distance(uCam, vPos));
  frag = vec4(present(col), (0.74 + 0.24 * wave) * fade);
}`;

/* ================= halo lumineux (bloom) =================
   La scène est déjà tonemappée quand on la recopie : le seuil s'applique
   donc en valeurs d'affichage, ce qui cible exactement ce que l'œil voit
   comme « lumineux » — soleil, fenêtres allumées, tracé de l'itinéraire.
   Trois passes au seizième de la résolution : négligeable, même sur
   téléphone. */
const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
out vec4 frag;
void main(){
  vec3 c = texture(uTex, vUv + vec2(-1.0, -1.0) * uTexel).rgb
         + texture(uTex, vUv + vec2( 1.0, -1.0) * uTexel).rgb
         + texture(uTex, vUv + vec2(-1.0,  1.0) * uTexel).rgb
         + texture(uTex, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  c *= 0.25;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = max(l - uThreshold, 0.0) / max(l, 1e-4);
  frag = vec4(c * k * k, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 frag;
const float W[5] = float[5](0.2270, 0.1945, 0.1216, 0.0540, 0.0162);
void main(){
  vec3 c = texture(uTex, vUv).rgb * W[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    c += texture(uTex, vUv + o).rgb * W[i];
    c += texture(uTex, vUv - o).rgb * W[i];
  }
  frag = vec4(c, 1.0);
}`;

const FS_BLOOM = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uStrength;
out vec4 frag;
void main(){ frag = vec4(texture(uTex, vUv).rgb * uStrength, 1.0); }`;

const VS_DEPTH = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP;
void main(){ gl_Position = uLightVP * vec4(aPos, 1.0); }`;

const FS_DEPTH = `#version 300 es
precision highp float;
void main(){}`;

/* ------------------------------------------------ app */
(function () {
  const canvas = document.getElementById('scene');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  const loader = document.getElementById('loader');
  const loadNote = document.getElementById('loadNote');
  const loadBar = document.getElementById('loadBar');

  if (!gl) {
    loadNote.textContent = "Ce navigateur n'expose pas WebGL 2 — la carte ne peut pas s'afficher.";
    loader.classList.add('failed');
    return;
  }

  const state = {
    target: [0, 400, 0], dTarget: [0, 400, 0],
    dist: 4200, dDist: 4200,
    theta: -0.85, dTheta: -0.85,
    phi: 0.62, dPhi: 0.62,
    autoOrbit: true, idle: 0, hour: 17.3,
    showBuildings: true, showRoads: true, showLabels: true, glow: true,
    highlight: 1, activePlace: null, intro: true
  };

  let field, feats, terrainMesh, buildingMesh, roadMesh, waterMesh, ringMesh, coverTex;
  let places = [];

  /* --- position et itinéraire --- */
  const MODES = {
    walk: {
      label: 'À pied', col: [0.42, 0.90, 0.82], vmax: 1.70,
      // pictogramme : marcheur
      icon: '<circle cx="14.2" cy="3.6" r="2.5"/><path d="M12.4 8.2 8.6 10.6 6.9 15.4M12.4 8.2l3.6 1.1 2 4.1 3.1 1.1M13.1 12.4l-1.4 4.4 3.1 4.5M11.7 16.8l-4 4.6"/>'
    },
    drive: {
      label: 'En voiture', col: [0.56, 0.72, 1.00], vmax: 14.0,
      // pictogramme : voiture
      icon: '<path d="M3.6 14.6h16.8M5.4 14.6l1.9-5.2a2 2 0 0 1 1.9-1.3h6.4a2 2 0 0 1 1.9 1.3l1.9 5.2M4.4 14.6v3.6a1 1 0 0 0 1 1h1.3a1 1 0 0 0 1-1v-1.1M19.6 14.6v3.6a1 1 0 0 1-1 1h-1.3a1 1 0 0 1-1-1v-1.1"/><circle cx="7.6" cy="16.6" r="0.1"/><circle cx="16.4" cy="16.6" r="0.1"/>'
    }
  };
  const ICON = (m, cls) =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MODES[m].icon}</svg>`;
  const nav = {
    graphs: { walk: null, drive: null },   // graphes construits à la demande
    mode: 'walk',
    pos: null,              // { x, y, acc, source: 'gps' | 'manuel' }
    marker: null,           // maillage du repère de départ
    destMark: null,         // maillage du repère d'arrivée
    route: null,            // maillage du tracé affiché
    results: null,          // { walk: {...} | null, drive: {...} | null, to }
    info: null,             // résultat du mode actif
    watchId: null,
    picking: false,
    lastSolve: null,
    markScale: 1
  };

  /* Les repères sont des disques posés au sol : à 3 km de recul un disque de
     13 m ne fait plus un pixel. On les redimensionne par paliers avec la
     distance caméra — assez rare pour ne rien coûter, assez fin pour qu'ils
     restent toujours lisibles. */
  const markScale = () => clamp(Math.pow(state.dist / 900, 0.85), 0.6, 4.2);
  const progs = {};
  let shadowFbo, shadowTex, lastShadowKey = '';
  /* ressources du halo lumineux : une copie de la scène, plus deux cibles
     au quart de côté (donc un seizième des pixels) pour le flou séparable */
  const glow = { copy: null, w: 0, h: 0, fboA: null, texA: null, fboB: null, texB: null, bw: 0, bh: 0 };
  let SHADOW_SIZE = 2048;

  /* Profil d'appareil : sur téléphone on vise 60 images/s avant la finesse.
     Le budget est un plafond de pixels, l'échelle s'ajuste ensuite sur le
     temps d'image mesuré. */
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const SMALL = Math.min(screen.width, screen.height) < 520;
  const MOBILE = COARSE || SMALL;
  const PIXEL_BUDGET = MOBILE ? 1.45e6 : 4.4e6;
  const SHADOW_SIZE_DEV = MOBILE ? 1024 : 2048;
  let renderScale = MOBILE ? 0.9 : 1;
  let frameAvg = 16.7;
  let vpW = 1, vpH = 1;
  const matVP = M4.create(), matProj = M4.create(), matView = M4.create(),
        matLightVP = M4.create(), matLightP = M4.create(), matLightV = M4.create(),
        matInvVP = M4.create();
  const eye = [0, 0, 0];

  function invert(out, m) {
    const a00=m[0],a01=m[1],a02=m[2],a03=m[3],a10=m[4],a11=m[5],a12=m[6],a13=m[7],
          a20=m[8],a21=m[9],a22=m[10],a23=m[11],a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,
          b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,
          b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
    let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
    if (!det) return out; det = 1/det;
    out[0]=(a11*b11-a12*b10+a13*b09)*det; out[1]=(a02*b10-a01*b11-a03*b09)*det;
    out[2]=(a31*b05-a32*b04+a33*b03)*det; out[3]=(a22*b04-a21*b05-a23*b03)*det;
    out[4]=(a12*b08-a10*b11-a13*b07)*det; out[5]=(a00*b11-a02*b08+a03*b07)*det;
    out[6]=(a32*b02-a30*b05-a33*b01)*det; out[7]=(a20*b05-a22*b02+a23*b01)*det;
    out[8]=(a10*b10-a11*b08+a13*b06)*det; out[9]=(a01*b08-a00*b10-a03*b06)*det;
    out[10]=(a30*b04-a31*b02+a33*b00)*det; out[11]=(a21*b02-a20*b04-a23*b00)*det;
    out[12]=(a11*b07-a10*b09-a12*b06)*det; out[13]=(a00*b09-a01*b07+a02*b06)*det;
    out[14]=(a31*b01-a30*b03-a32*b00)*det; out[15]=(a20*b03-a21*b01+a22*b00)*det;
    return out;
  }

  /* ---------- sun & palette by hour ---------- */
  function sunFor(hour) {
    // Corte, 42.3°N — mid-September arc, generous artistic licence on colour
    const t = clamp((hour - 6.2) / (19.6 - 6.2), 0, 1);
    const alt = Math.sin(t * Math.PI) * 0.95;                 // 0..0.95
    const az = -2.35 + t * 3.3;                               // east -> west
    const elev = Math.max(0.035, alt);
    const dir = [Math.cos(elev * 1.35) * Math.sin(az), Math.sin(elev * 1.35), Math.cos(elev * 1.35) * Math.cos(az)];
    const L = Math.hypot(dir[0], dir[1], dir[2]);
    dir[0] /= L; dir[1] /= L; dir[2] /= L;

    const low = 1 - smoothstep(clamp(alt / 0.42, 0, 1));      // 1 at dawn/dusk
    const night = clamp((0.14 - alt) / 0.2, 0, 1);
    const sunColor = [
      lerp(1.44, 1.58, low) * (1 - night * 0.88),
      lerp(1.33, 0.88, low) * (1 - night * 0.92),
      lerp(1.15, 0.50, low) * (1 - night * 0.94)
    ];
    const zenith = [
      lerp(0.20, 0.10, night) + low * 0.04,
      lerp(0.37, 0.13, night),
      lerp(0.60, 0.26, night)
    ];
    const horizon = [
      lerp(0.62, 0.16, night) + low * 0.22,
      lerp(0.68, 0.18, night) - low * 0.10,
      lerp(0.72, 0.26, night) - low * 0.26
    ];
    const amb = [
      lerp(0.225, 0.075, night) + low * 0.02,
      lerp(0.255, 0.095, night),
      lerp(0.325, 0.150, night)
    ];
    // l'œil s'ouvre quand le jour tombe
    const exposure = lerp(1.20, 2.05, night) + low * 0.20;
    return { dir, sunColor, zenith, horizon, amb, night, exposure,
             tint: [1.0, lerp(0.86, 0.55, low), lerp(0.66, 0.28, low)] };
  }

  /* ---------- shadow target ---------- */
  function updateShadow(sun) {
    const half = clamp(state.dist * 0.62, 420, 2600);
    const c = state.target;
    const up = Math.abs(sun.dir[1]) > 0.98 ? [0, 0, -1] : [0, 1, 0];
    const d = 4200;
    M4.lookAt(matLightV, [c[0] + sun.dir[0]*d, c[1] + sun.dir[1]*d, c[2] + sun.dir[2]*d], c, up);
    M4.ortho(matLightP, -half, half, -half, half, 10, 9000);
    M4.mul(matLightVP, matLightP, matLightV);
  }

  /* ---------- draw helpers ---------- */
  function makeTarget(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  function glowResize(w, h) {
    const bw = Math.max(8, w >> 2), bh = Math.max(8, h >> 2);
    if (glow.w !== w || glow.h !== h) {
      if (glow.copy) gl.deleteTexture(glow.copy);
      glow.copy = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glow.copy);
      /* le contexte est créé sans canal alpha : le tampon par défaut est en
         RGB8, et copyTexSubImage2D refuse une destination RGBA */
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      glow.w = w; glow.h = h;
    }
    if (glow.bw !== bw || glow.bh !== bh) {
      if (glow.fboA) { gl.deleteFramebuffer(glow.fboA); gl.deleteTexture(glow.texA); }
      if (glow.fboB) { gl.deleteFramebuffer(glow.fboB); gl.deleteTexture(glow.texB); }
      const a = makeTarget(bw, bh), b = makeTarget(bw, bh);
      glow.fboA = a.fbo; glow.texA = a.tex;
      glow.fboB = b.fbo; glow.texB = b.tex;
      glow.bw = bw; glow.bh = bh;
    }
  }

  /* Halo lumineux : copie de l'image, seuillage au quart de résolution,
     flou séparable, puis addition sur l'image d'origine. */
  function drawGlow(strength) {
    glowResize(vpW, vpH);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, glow.copy);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, vpW, vpH);

    gl.bindVertexArray(progs.quad.v);
    gl.viewport(0, 0, glow.bw, glow.bh);

    gl.bindFramebuffer(gl.FRAMEBUFFER, glow.fboA);
    gl.useProgram(progs.bright.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glow.copy);
    gl.uniform1i(progs.bright.u.uTex, 0);
    gl.uniform2f(progs.bright.u.uTexel, 1 / vpW, 1 / vpH);
    gl.uniform1f(progs.bright.u.uThreshold, 0.84);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(progs.blur.p);
    gl.uniform1i(progs.blur.u.uTex, 0);
    for (let pass = 0; pass < 2; pass++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pass ? glow.fboA : glow.fboB);
      gl.bindTexture(gl.TEXTURE_2D, pass ? glow.texB : glow.texA);
      if (pass) gl.uniform2f(progs.blur.u.uDir, 0, 1.25 / glow.bh);
      else gl.uniform2f(progs.blur.u.uDir, 1.25 / glow.bw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vpW, vpH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progs.bloom.p);
    gl.bindTexture(gl.TEXTURE_2D, glow.texA);
    gl.uniform1i(progs.bloom.u.uTex, 0);
    gl.uniform1f(progs.bloom.u.uStrength, strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
  }

  function drawMesh(prog, mesh) {
    if (!mesh || !mesh.count) return;
    gl.bindVertexArray(mesh.v);
    gl.drawElements(gl.TRIANGLES, mesh.count, mesh.itype, 0);
  }

  function setCommon(P, sun) {
    gl.uniformMatrix4fv(P.u.uVP, false, matVP);
    if (P.u.uCam) gl.uniform3fv(P.u.uCam, eye);
    if (P.u.uSun) gl.uniform3fv(P.u.uSun, sun.dir);
    if (P.u.uSunColor) gl.uniform3fv(P.u.uSunColor, sun.sunColor);
    if (P.u.uSkyAmb) gl.uniform3fv(P.u.uSkyAmb, sun.amb);
    if (P.u.uHorizon) gl.uniform3fv(P.u.uHorizon, sun.horizon);
    if (P.u.uZenith) gl.uniform3fv(P.u.uZenith, sun.zenith);
    if (P.u.uFogDensity) gl.uniform1f(P.u.uFogDensity, 0.0000430);
    if (P.u.uExposure) gl.uniform1f(P.u.uExposure, sun.exposure);
    if (P.u.uRes) gl.uniform2f(P.u.uRes, vpW, vpH);
    if (P.u.uAccent) gl.uniform3f(P.u.uAccent, 0.96, 0.70, 0.28);
    if (P.u.uLightVP) gl.uniformMatrix4fv(P.u.uLightVP, false, matLightVP);
    if (P.u.uShadowTexel) gl.uniform1f(P.u.uShadowTexel, 1 / SHADOW_SIZE);
    if (P.u.uShadow) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadowTex); gl.uniform1i(P.u.uShadow, 1); }
  }

  /* ---------- main loop ---------- */
  let last = performance.now(), clock = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now; clock += dt;

    // camera damping
    state.idle += dt;
    if (state.autoOrbit && state.idle > 3.2 && !state.intro) state.dTheta += dt * 0.055;
    const k = state.intro ? 1.15 : 3.6;
    const s = 1 - Math.exp(-k * dt);
    for (let i = 0; i < 3; i++) state.target[i] = lerp(state.target[i], state.dTarget[i], s);
    state.dist = lerp(state.dist, state.dDist, s);
    let dth = state.dTheta - state.theta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    state.theta += dth * s;
    state.phi = lerp(state.phi, state.dPhi, s);
    if (state.intro && Math.abs(state.dist - state.dDist) < 60) state.intro = false;
    if (nav.pos || nav.destId) refreshMarkers();

    const cp = Math.cos(state.phi), sp = Math.sin(state.phi);
    eye[0] = state.target[0] + state.dist * cp * Math.sin(state.theta);
    eye[1] = state.target[1] + state.dist * sp;
    eye[2] = state.target[2] + state.dist * cp * Math.cos(state.theta);
    const groundAtEye = field.at(eye[0], eye[2]) + 45;
    if (eye[1] < groundAtEye) eye[1] = groundAtEye;

    frameAvg = frameAvg * 0.90 + Math.min(80, dt * 1000) * 0.10;
    if (clock > 2.5) {
      if (frameAvg > 26 && renderScale > 0.58) renderScale -= 0.05;
      else if (frameAvg < 18.5 && renderScale < 1) renderScale = Math.min(1, renderScale + 0.02);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = canvas.clientWidth * dpr * renderScale;
    let H = canvas.clientHeight * dpr * renderScale;
    const over = (W * H) / PIXEL_BUDGET;
    if (over > 1) { const k = 1 / Math.sqrt(over); W *= k; H *= k; }
    W = Math.max(320, Math.round(W)); H = Math.max(200, Math.round(H));
    // on ne redimensionne que sur un écart franc : un resize par image coûte cher
    if (Math.abs(canvas.width - W) > canvas.width * 0.02 || Math.abs(canvas.height - H) > canvas.height * 0.02) {
      canvas.width = W; canvas.height = H;
    }
    vpW = canvas.width; vpH = canvas.height;

    const sun = sunFor(state.hour);
    M4.perspective(matProj, 0.86, vpW / vpH, 3, 26000);
    M4.lookAt(matView, eye, state.target, [0, 1, 0]);
    M4.mul(matVP, matProj, matView);
    invert(matInvVP, matVP);

    /* La passe d'ombre dessine 800 000 triangles. Elle ne dépend que du
       soleil et du cadrage de la projection orthographique : tant que ni
       l'un ni l'autre ne bouge, on garde la texture précédente. */
    const shadowKey = Math.round(state.target[0] / 45) + ':' + Math.round(state.target[2] / 45) + ':'
      + Math.round(state.dist / 70) + ':' + Math.round(state.hour * 24) + ':' + (state.showBuildings ? 1 : 0);
    if (shadowKey !== lastShadowKey) {
      lastShadowKey = shadowKey;
      updateShadow(sun);
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(progs.depth.p);
      gl.uniformMatrix4fv(progs.depth.u.uLightVP, false, matLightVP);
      if (state.showBuildings) drawMesh(progs.depth, buildingMesh);
      drawMesh(progs.depth, terrainMesh);
    }

    /* main pass */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vpW, vpH);
    gl.clearColor(sun.horizon[0], sun.horizon[1], sun.horizon[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(progs.sky.p);
    gl.uniformMatrix4fv(progs.sky.u.uInvVP, false, matInvVP);
    gl.uniform3fv(progs.sky.u.uCam, eye);
    gl.uniform3fv(progs.sky.u.uSun, sun.dir);
    gl.uniform3fv(progs.sky.u.uZenith, sun.zenith);
    gl.uniform3fv(progs.sky.u.uHorizon, sun.horizon);
    gl.uniform3fv(progs.sky.u.uSunTint, sun.tint);
    gl.uniform1f(progs.sky.u.uExposure, sun.exposure);
    gl.uniform2f(progs.sky.u.uRes, vpW, vpH);
    gl.bindVertexArray(progs.quad.v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);

    // terrain
    gl.useProgram(progs.terrain.p);
    setCommon(progs.terrain, sun);
    gl.uniform4f(progs.terrain.u.uExtent, field.x0, field.y0, (field.w - 1) * field.dx, (field.h - 1) * field.dy);
    gl.uniform1f(progs.terrain.u.uContour, 0.55);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, coverTex);
    gl.uniform1i(progs.terrain.u.uCover, 0);
    drawMesh(progs.terrain, terrainMesh);

    // roads
    if (state.showRoads) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2.5, -8);
      gl.useProgram(progs.road.p);
      setCommon(progs.road, sun);
      drawMesh(progs.road, roadMesh);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // water
    gl.useProgram(progs.water.p);
    setCommon(progs.water, sun);
    gl.uniform1f(progs.water.u.uTime, clock);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-3.5, -12);
    drawMesh(progs.water, waterMesh);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // emprises de campus, repère de position, tracé d'itinéraire
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.POLYGON_OFFSET_FILL);

    gl.useProgram(progs.ring.p);
    gl.uniformMatrix4fv(progs.ring.u.uVP, false, matVP);
    gl.uniform3fv(progs.ring.u.uCam, eye);
    gl.uniform1f(progs.ring.u.uTime, clock);
    gl.uniform1f(progs.ring.u.uExposure, sun.exposure);
    gl.uniform2f(progs.ring.u.uRes, vpW, vpH);
    gl.uniform1f(progs.ring.u.uRingFade, 0.85 * state.highlight);
    gl.polygonOffset(-6, -20);
    drawMesh(progs.ring, ringMesh);

    if (nav.marker) {
      gl.uniform1f(progs.ring.u.uRingFade, 0.95);
      gl.polygonOffset(-10, -34);
      drawMesh(progs.ring, nav.marker);
    }

    if (nav.destMark) {
      gl.uniform1f(progs.ring.u.uRingFade, 0.95);
      gl.polygonOffset(-10, -34);
      drawMesh(progs.ring, nav.destMark);
    }

    if (nav.route) {
      gl.useProgram(progs.route.p);
      gl.uniformMatrix4fv(progs.route.u.uVP, false, matVP);
      gl.uniform3fv(progs.route.u.uCam, eye);
      gl.uniform1f(progs.route.u.uTime, clock);
      gl.uniform1f(progs.route.u.uExposure, sun.exposure);
      gl.uniform2f(progs.route.u.uRes, vpW, vpH);
      gl.polygonOffset(-9, -30);
      drawMesh(progs.route, nav.route);
    }

    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);

    // buildings
    if (state.showBuildings) {
      gl.useProgram(progs.building.p);
      setCommon(progs.building, sun);
      gl.uniform1f(progs.building.u.uHighlight, state.highlight);
      gl.uniform1f(progs.building.u.uNight, sun.night);
      drawMesh(progs.building, buildingMesh);
    }

    /* halo : coupé si l'appareil peine déjà — l'image nette prime */
    if (state.glow && !(MOBILE && renderScale < 0.72)) {
      drawGlow(0.28 + sun.night * 0.34);
    }

    updateLabels(vpW, vpH, vpW / canvas.clientWidth);
    requestAnimationFrame(frame);
  }

  /* ================= recherche et catégories =================
     Un étudiant de première année ne cherche pas « un campus », il cherche
     « Desanti », « le RU », « la BU ». L'index couvre donc les sites, les
     150 lieux repris d'OpenStreetMap et l'annuaire des salles. */

  const CATS = [
    { id: 'e', label: 'Université', hint: 'Bâtiments, facultés, BU' },
    { id: 'm', label: 'Manger',     hint: 'RU, supermarchés, restaurants' },
    { id: 'b', label: 'Se déplacer',hint: 'Gare, bus, parkings' },
    { id: 's', label: 'Services',   hint: 'Santé, banque, poste, administration' },
    { id: 'l', label: 'Sport',      hint: 'Halle, piscine, salles' },
    { id: 'v', label: 'Vivre',      hint: 'Logement étudiant, laverie' }
  ];
  const KIND_LABEL = {
    univ: 'Bâtiment universitaire', biblio: 'Bibliothèque', ecole: 'École', cowork: 'Espace de travail',
    librairie: 'Librairie', resto: 'Restaurant', rapide: 'Restauration rapide',
    boulangerie: 'Boulangerie', supermarche: 'Supermarché', epicerie: 'Épicerie',
    primeur: 'Primeur', boucher: 'Boucherie', social: 'Logement étudiant', laverie: 'Laverie',
    bus: 'Arrêt de bus', quai: 'Quai', gare: 'Gare', parking: 'Parking', velo: 'Parking à vélos',
    carburant: 'Station-service', pharmacie: 'Pharmacie', medecin: 'Médecin', clinique: 'Clinique',
    hopital: 'Hôpital', banque: 'Banque', distributeur: 'Distributeur', poste: 'La Poste',
    police: 'Gendarmerie', mairie: 'Mairie', administration: 'Administration',
    toilettes: 'Toilettes', eau: 'Point d’eau', sport: 'Sport', stade: 'Stade', cinema: 'Cinéma'
  };

  /* Sans accents et sans casse : « batiment desanti » doit trouver
     « Bâtiment Jean-Toussaint Desanti ». */
  const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  /* Un étudiant tape « RU », pas « Restaurant Universitaire ». Ces alias
     s'ajoutent à la clé de recherche ; ils ne s'affichent jamais. */
  const ALIAS_NOM = [
    [/^Restaurant Universitaire$/i, 'ru restau u resto u cantine cafeteria self manger midi'],
    [/^Bibliothèque universitaire$/i, 'bu biblio bibli travailler reviser silence'],
    [/CROUS/i, 'crous bourse logement dossier social aide'],
    [/Halle des sports/i, 'gymnase sport eps halle musculation'],
    [/Spaziu/i, 'spaziu culture associations vie etudiante concert'],
    [/^IUT di Corsica$/i, 'iut technologie dut but'],
    [/^Paoli Tech/i, 'paolitech ingenieur ingenieurs'],
    [/^INSPÉ/i, 'inspe espe professorat enseignement master meef'],
    [/^Casa studientina$/i, 'residence logement chambre cite universitaire crous'],
    [/^Sambucucciu/i, 'residence logement chambre cite universitaire crous'],
    [/^Palais National$/i, 'musee patrimoine histoire paoli'],
    [/Institut universitaire de santé/i, 'ius sante infirmier soins'],
    [/École de Management/i, 'iae management economie gestion'],
    [/Faculté de droit/i, 'droit fac licence'],
    [/Faculté des lettres/i, 'lettres langues shs fac licence'],
    [/Faculté des sciences/i, 'sciences fst fac licence'],
    [/^Médiathèque/i, 'mediatheque bibliotheque livres'],
    [/^Palazzu Naziunale$/i, 'palazzu naziunale palais national presidence president direction administration siege'],
    [/^Caserne Padoue$/i, 'silex caserne padoue padua casarma innovation incubateur entreprises']
  ];
  const ALIAS_GENRE = {
    biblio: 'bibliotheque livres travailler', resto: 'manger dejeuner diner',
    rapide: 'manger snack sandwich kebab pizza', boulangerie: 'pain viennoiserie petit dejeuner',
    supermarche: 'courses supermarche alimentation', epicerie: 'courses depannage alimentation',
    primeur: 'fruits legumes courses', boucher: 'viande courses',
    distributeur: 'atm retrait argent liquide billets', banque: 'argent compte rib',
    poste: 'courrier colis timbre lettre', pharmacie: 'medicament ordonnance',
    hopital: 'urgences soins medecin', medecin: 'soins consultation',
    bus: 'arret transport ligne', gare: 'train sncf cff transport',
    quai: 'train transport', parking: 'voiture stationnement garer',
    velo: 'velo bicyclette', carburant: 'essence gasoil station',
    laverie: 'lessive linge machine laver', social: 'logement residence chambre',
    sport: 'sport musculation fitness gym piscine', cinema: 'film seance',
    eau: 'fontaine boire eau potable', toilettes: 'wc toilettes',
    mairie: 'administration commune', police: 'gendarmerie securite',
    administration: 'administration bureau service', cowork: 'travailler coworking bureau',
    librairie: 'livres papeterie fournitures', ecole: 'formation ecole',
    univ: 'universite fac cours amphi batiment'
  };
  const SIGLES = [
    [/^Bibliothèque universitaire$/i, ['bu']],
    [/^Restaurant Universitaire$/i, ['ru']],
    [/^IUT di Corsica$/i, ['iut']],
    [/CROUS/i, ['crous']],
    [/^INSPÉ/i, ['inspe', 'espe']],
    [/École de Management/i, ['iae']],
    [/Faculté des sciences/i, ['fst']],
    [/Institut universitaire de santé/i, ['ius']],
    [/^Paoli Tech/i, ['paolitech']],
    [/Halle des sports/i, ['halle']],
    [/^Caserne Padoue$/i, ['silex', 'padoue']],
    [/^Palazzu Naziunale$/i, ['palazzu', 'presidence']]
  ];
  const siglesFor = (name) => {
    for (const [re, codes] of SIGLES) if (re.test(name)) return codes;
    return null;
  };
  const aliasFor = (name, kind) => {
    let a = ALIAS_GENRE[kind] || '';
    for (const [re, mots] of ALIAS_NOM) if (re.test(name)) a += ' ' + mots;
    return a;
  };

  let index = [];        // { id, name, sub, cat, kind, x, y, uni, key, place }
  const objById = new Map();   // identifiant -> objet destination
  let salles = [];       // annuaire fourni par l'établissement
  let cat = 'e';         // catégorie affichée sur le plan
  let query = '';

  function poiPlace(e) {
    return {
      id: e.id, name: e.name, sub: e.sub, note: e.note || '',
      kind: 'poi', x: e.x, y: e.y,
      r: e.uni ? 300 : 340, phi: 0.42, theta: state.theta, lift: 22
    };
  }

  function buildIndex() {
    index = [];
    objById.clear();
    for (const p of places) {
      index.push({ id: p.id, name: p.name, sub: p.sub || 'Corte', cat: 'e', kind: 'site',
        x: p.x, y: p.y, uni: 2,
        key: fold(p.name + ' ' + (p.sub || '') + ' ' + (p.alt || '') + ' '
                  + aliasFor(p.name, 'univ') + ' campus'),
        codes: siglesFor(p.name), place: p });
      objById.set(p.id, p);
    }
    const pois = CORTE_DATA.pois || [];
    const dejaListes = new Set();
    for (const p of places) {
      dejaListes.add(fold(p.name));
      for (const a of String(p.alt || '').split('·')) if (a.trim()) dejaListes.add(fold(a.trim()));
    }
    pois.forEach((r, i) => {
      const [x, y, c, kind, name, uni] = r;
      const label = name || KIND_LABEL[kind] || 'Lieu';
      if (dejaListes.has(fold(label))) return;   // déjà dans la liste des sites
      const e = { id: 'poi' + i, name: label, sub: KIND_LABEL[kind] || '', cat: c, kind,
        x, y, uni: uni ? 1 : 0,
        key: fold(label + ' ' + (KIND_LABEL[kind] || '') + ' ' + aliasFor(label, kind)),
        codes: siglesFor(label) };
      e.place = poiPlace(e);
      objById.set(e.place.id, e.place);
      index.push(e);
    });
    for (const s of salles) {
      const bat = index.find(e => fold(e.name) === fold(s.batiment))
        || index.find(e => fold(e.name).includes(fold(s.batiment)));
      if (!bat) continue;
      const etage = s.etage != null ? (s.etage === 0 ? 'rez-de-chaussée' : s.etage + 'e étage') : '';
      index.push({ id: 'salle:' + s.code, name: s.code, cat: 'e', kind: 'salle',
        sub: [s.nom, s.batiment, etage].filter(Boolean).join(' · '),
        x: bat.x, y: bat.y, uni: 3,
        key: fold(s.code + ' ' + (s.nom || '') + ' ' + s.batiment),
        place: Object.assign({}, bat.place, {
          id: 'salle:' + s.code, name: s.code,
          sub: s.nom || 'Salle',
          note: `Dans le ${s.batiment}${etage ? ', ' + etage : ''}.` + (s.info ? ' ' + s.info : '')
        })
      });
      objById.set('salle:' + s.code, index[index.length - 1].place);
    }
  }

  /* Classement : d'abord l'universitaire, puis le début du mot, puis
     l'inclusion. Sans quoi « bu » remonterait vingt bars avant la BU. */
  function search(q, limit) {
    const f = fold(q).trim();
    if (!f) return [];
    const mots = f.split(/\s+/).filter(Boolean);
    const res = [];
    for (const e of index) {
      let score = 0, ok = true;
      for (const m of mots) {
        const i = e.key.indexOf(m);
        if (i < 0) { ok = false; break; }
        score += i === 0 ? 100 : /[\s'’-]/.test(e.key[i - 1] || '') ? 70 : 30;
      }
      if (!ok) continue;
      if (e.codes && e.codes.includes(f)) score += 600;
      score += e.uni * 45;
      if (e.kind === 'salle') score += 60;
      score -= Math.min(20, e.name.length / 4);
      res.push({ e, score });
    }
    res.sort((a, b) => b.score - a.score);
    return res.slice(0, limit || 24).map(r => r.e);
  }

  /* ---------- labels ---------- */
  const labelLayer = document.getElementById('labels');
  const labelEls = [];
  const tmp = [0, 0, 0, 0];

  let meLabel = null;

  function makeLabels() {
    labelLayer.innerHTML = '';
    labelEls.length = 0;
    meLabel = document.createElement('button');
    meLabel.className = 'lab lab-me';
    meLabel.innerHTML = '<span class="dot"></span><span class="txt">Vous êtes ici</span>';
    meLabel.style.opacity = '0';
    meLabel.addEventListener('click', () => {
      if (!nav.pos) return;
      state.dTarget = [nav.pos.x, field.at(nav.pos.x, -nav.pos.y) + 25, -nav.pos.y];
      state.dDist = 420; state.dPhi = 0.46; state.idle = 0; state.intro = false;
    });
    labelLayer.appendChild(meLabel);
    for (const p of places) {
      const el = document.createElement('button');
      el.className = 'lab' + (p.kind === 'campus' ? ' lab-campus' : ' lab-place');
      el.innerHTML = `<span class="dot"></span><span class="txt">${p.name}</span>`;
      el.addEventListener('click', () => flyTo(p));
      labelLayer.appendChild(el);
      labelEls.push({ el, p });
    }
    makePoiLabels();
  }

  /* Étiquettes des lieux de la catégorie choisie. Elles se placent dans la
     même passe de dé-chevauchement que les sites, qui gardent la priorité :
     un nom de restaurant ne masquera jamais un campus. */
  let poiEls = [];
  function makePoiLabels() {
    for (const L of poiEls) L.el.remove();
    poiEls = [];
    if (!cat) return;
    for (const e of index) {
      if (e.kind === 'site' || e.kind === 'salle' || e.cat !== cat) continue;
      const el = document.createElement('button');
      el.className = 'lab lab-poi' + (e.uni ? ' lab-uni' : '');
      el.innerHTML = `<span class="dot"></span><span class="txt">${e.name}</span>`;
      el.addEventListener('click', () => flyTo(e.place));
      labelLayer.appendChild(el);
      poiEls.push({ el, p: Object.assign({ kind: 'poi', uni: e.uni }, e.place) });
    }
  }

  function hideLabel(el) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }

  function updateLabels(W, H, dpr) {
    const cw = W / dpr, ch = H / dpr;
    const cand = [];
    const list = labelEls.concat(poiEls);
    if (nav.pos && meLabel) {
      meLabel.querySelector('.txt').textContent = nav.pos.source === 'gps' ? 'Vous êtes ici' : 'Départ';
      list.push({ el: meLabel, p: { x: nav.pos.x, y: nav.pos.y, kind: 'me', id: '__me' } });
    } else if (meLabel) {
      hideLabel(meLabel);
    }
    for (const L of list) {
      const { el, p } = L;
      el.classList.toggle('is-active', state.activePlace === p.id);
      if (!state.showLabels) { hideLabel(el); continue; }
      const y = field.at(p.x, -p.y);
      M4.transform(tmp, matVP, p.x, y + (p.kind === 'campus' ? 42 : p.kind === 'me' ? 46 : 24), -p.y);
      if (tmp[3] <= 0) { hideLabel(el); continue; }
      const sx = (tmp[0] / tmp[3] * 0.5 + 0.5) * cw;
      const sy = (0.5 - tmp[1] / tmp[3] * 0.5) * ch;
      if (sx < -80 || sx > cw + 80 || sy < -20 || sy > ch + 40) { hideLabel(el); continue; }
      const d = Math.hypot(eye[0] - p.x, eye[1] - y, eye[2] + p.y);
      /* Les bâtiments universitaires portent loin — c'est l'objet même de
         l'application. Les commerces n'apparaissent qu'une fois la caméra
         descendue, sinon la vallée se couvre de noms de boulangeries. */
      const near = p.kind === 'poi' ? (p.uni ? 2400 : 950) : p.kind === 'place' ? 2000 : 9000;
      const coupe = p.kind === 'poi' ? (p.uni ? 2600 : 1050) : p.kind === 'place' ? 2200 : 1e9;
      let op = clamp(1 - (d - near * 0.35) / near, 0, 1);
      if (d > coupe) op = 0;
      if (state.activePlace === p.id) op = 1;          // la destination reste lisible
      if (op <= 0.03) { hideLabel(el); continue; }
      if (!L.w) L.w = (el.offsetWidth || 96);
      cand.push({
        L, sx, sy, op, d,
        pr: p.kind === 'me' ? -3 : (state.activePlace === p.id ? -2
          : p.kind === 'campus' ? -1 : p.kind === 'poi' ? 2 : 1)
      });
    }
    cand.sort((a, b) => a.pr - b.pr || a.d - b.d);
    const placed = [];
    for (const c of cand) {
      const w = c.L.w + 10, x0 = c.sx - w / 2, y0 = c.sy - 42, x1 = x0 + w, y1 = c.sy - 12;
      let clash = false;
      for (const q of placed) { if (x0 < q.x1 && x1 > q.x0 && y0 < q.y1 && y1 > q.y0) { clash = true; break; } }
      if (clash) { hideLabel(c.L.el); continue; }
      placed.push({ x0, y0, x1, y1 });
      const el = c.L.el;
      el.style.transform = `translate(-50%,-100%) translate(${c.sx.toFixed(1)}px, ${c.sy.toFixed(1)}px)`;
      el.style.opacity = c.op.toFixed(2);
      el.style.pointerEvents = c.op > 0.5 ? 'auto' : 'none';
    }
  }

  /* ---------- navigation ---------- */
  function flyTo(p) {
    state.dTarget = [p.x, field.at(p.x, -p.y) + (p.lift || 30), -p.y];
    state.dDist = p.r || 620;
    state.dPhi = p.phi != null ? p.phi : 0.44;
    state.dTheta = p.theta != null ? p.theta : state.theta + 0.0001;
    state.idle = 0;
    state.activePlace = p.id;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.id === p.id));
    nav.fail = false;
    renderNote(p);
    if (nav.pos) computeRoute(p, true);
    if (phoneLayout && sheet.dataset.state === 'open') setSheet('peek');
  }

  function overview() {
    state.dTarget = [0, 420, 0];
    state.dDist = 3400; state.dPhi = 0.52; state.dTheta = -0.85;
    state.activePlace = null; state.idle = 0;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('is-active'));
    const note = document.getElementById('placeNote');
    if (note) note.classList.remove('visible');
    sheet.dataset.fiche = '0';
    foldRail(false);
    if (phoneLayout && sheet.dataset.state === 'mini') setSheet('peek');
  }

  /* ================= position et itinéraire ================= */

  const navStatus = (t) => {
    const el = document.getElementById('navStatus');
    if (el) el.textContent = t;
  };

  const fmtDist = (m) => m < 950
    ? Math.round(m / 10) * 10 + ' m'
    : (m / 1000).toFixed(1).replace('.', ',') + ' km';

  const fmtTime = (s) => {
    const min = Math.max(1, Math.round(s / 60));
    return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0');
  };

  function ensureGraph(mode) {
    if (!nav.graphs[mode]) {
      navStatus(mode === 'drive' ? 'Construction du réseau routier…' : 'Construction du réseau piéton…');
      nav.graphs[mode] = buildGraph(feats, field, mode);
    }
    return nav.graphs[mode];
  }

  function setPosition(x, y, acc, source) {
    const prev = nav.pos;
    const moved = !prev || Math.hypot(prev.x - x, prev.y - y) > 1.5
      || Math.abs((prev.acc || 0) - (acc || 12)) > 4;
    nav.pos = { x, y, acc: Math.max(4, acc || 12), source };
    if (moved) {
      disposeVao(gl, nav.marker);
      nav.markScale = markScale();
      nav.marker = buildMarker(gl, x, y, nav.pos.acc, field,
        source === 'gps' ? [0.40, 0.90, 0.82] : [0.64, 0.78, 0.96], 'dot', nav.markScale);
    }
    const lat = (CORTE_DATA.origin.lat + y / CORTE_DATA.mPerDegLat).toFixed(5);
    const lon = (CORTE_DATA.origin.lon + x / CORTE_DATA.mPerDegLon).toFixed(5);
    navStatus(`${source === 'gps' ? 'Position' : 'Départ'} ${lat}°N ${lon}°E · ±${Math.round(nav.pos.acc)} m`);

    /* Le GPS envoie un point par seconde : relancer deux A* à chaque fois
       saccade le rendu pour rien. On ne recalcule qu'au-delà de 25 m de
       dérive, et jamais plus d'une fois toutes les trois secondes. */
    const dest = objById.get(state.activePlace);
    if (!dest) return;
    const now = performance.now();
    const drift = nav.lastSolve ? Math.hypot(nav.lastSolve.x - x, nav.lastSolve.y - y) : Infinity;
    if (source !== 'gps' || (drift > 25 && now - nav.lastSolve.t > 3000) || !nav.results) {
      nav.lastSolve = { x, y, t: now };
      computeRoute(dest, false);
    }
  }

  function clearRoute() {
    disposeVao(gl, nav.route);
    nav.route = null;
    setDestMark(null);
    nav.info = null;
    nav.results = null;
    nav.fail = false;
    const dest = objById.get(state.activePlace);
    if (dest) renderNote(dest);
    renderRouteBar();
    if (phoneLayout && sheet.dataset.state === 'mini') setSheet('peek');
    foldRail(false);
  }

  /* calcule un mode et renvoie { dist, time, up, down, pts } ou null */
  function solve(dest, mode) {
    const G = ensureGraph(mode);
    const res = routePoints(G, nav.pos, dest, MODES[mode].vmax, 4);
    if (!res) return null;
    const pts = [nav.pos.x, nav.pos.y, ...res.pts, dest.x, dest.y];
    // les raccords entre le point réel et le réseau se font toujours à pied
    return {
      dist: res.dist + res.snapDist,
      time: res.time + res.snapDist / 1.25,
      up: res.up, down: res.down, pts, mode,
      prof: profile(pts)
    };
  }

  /* Profil en long : N altitudes prises à intervalle constant le long du
     tracé. Sert au graphique de la fiche — rien d'autre ne le consomme. */
  function profile(pts, N = 48) {
    const m = pts.length / 2;
    if (m < 2) return null;
    const cum = [0];
    for (let i = 1; i < m; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]));
    }
    const total = cum[m - 1];
    if (!(total > 0)) return null;
    const out = [];
    let seg = 1;
    for (let k = 0; k < N; k++) {
      const d = total * k / (N - 1);
      while (seg < m - 1 && cum[seg] < d) seg++;
      const a = seg - 1, span = cum[seg] - cum[a] || 1;
      const t = clamp((d - cum[a]) / span, 0, 1);
      const x = lerp(pts[a * 2], pts[seg * 2], t);
      const y = lerp(pts[a * 2 + 1], pts[seg * 2 + 1], t);
      out.push(field.at(x, -y));
    }
    return out;
  }

  /* Graphique du profil en long, en SVG : aire + trait, sans dépendance. */
  function profileSvg(prof, col) {
    if (!prof || prof.length < 4) return '';
    let lo = Infinity, hi = -Infinity;
    for (const v of prof) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(12, hi - lo);          // au moins 12 m pour éviter le bruit
    const mid = (hi + lo) / 2;
    const y0 = mid - span / 2;
    const W = 100, H = 30, pad = 3;
    const px = (i) => (i / (prof.length - 1)) * W;
    const py = (v) => H - pad - ((v - y0) / span) * (H - pad * 2);
    let line = '';
    prof.forEach((v, i) => { line += (i ? 'L' : 'M') + px(i).toFixed(2) + ' ' + py(v).toFixed(2) + ' '; });
    const area = `M0 ${H} ` + line.replace(/^M/, 'L') + `L${W} ${H} Z`;
    return `<svg class="prof" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path class="prof-area" d="${area}" fill="${col}"/>
      <path class="prof-line" d="${line}" fill="none" stroke="${col}" stroke-width="1.5"
        stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  /* Reconstruit les repères quand l'échelle a trop dérivé. */
  function refreshMarkers() {
    const k = markScale();
    if (Math.abs(k / (nav.markScale || 1) - 1) < 0.28) return;
    nav.markScale = k;
    if (nav.pos) {
      disposeVao(gl, nav.marker);
      nav.marker = buildMarker(gl, nav.pos.x, nav.pos.y, nav.pos.acc, field,
        nav.pos.source === 'gps' ? [0.40, 0.90, 0.82] : [0.64, 0.78, 0.96], 'dot', k);
    }
    if (nav.destId) {
      const p = objById.get(nav.destId);
      if (p) {
        disposeVao(gl, nav.destMark);
        nav.destMark = buildMarker(gl, p.x, p.y, 0, field, [0.95, 0.70, 0.26], 'pin', k);
      }
    }
  }

  function drawRoute() {
    disposeVao(gl, nav.route);
    nav.route = null;
    const r = nav.results && nav.results[nav.mode];
    if (r) nav.route = buildRouteMesh(gl, r.pts, field, MODES[nav.mode].col);
    nav.info = r || null;
    setDestMark(r ? objById.get(nav.results.to) : null);
  }

  /* repère d'arrivée, aux couleurs d'accent : le trajet se lit d'un coup
     d'œil — pastille turquoise au départ, fanion ambre à l'arrivée. */
  function setDestMark(p) {
    disposeVao(gl, nav.destMark);
    nav.destMark = null;
    nav.destId = p ? p.id : null;
    if (p) nav.destMark = buildMarker(gl, p.x, p.y, 0, field, [0.95, 0.70, 0.26], 'pin', markScale());
  }

  function setMode(mode, dest) {
    if (!MODES[mode] || mode === nav.mode) return;
    nav.mode = mode;
    drawRoute();
    renderRouteBar();
    if (nav.info) navStatus(`${MODES[mode].label} : ${fmtDist(nav.info.dist)} · ${fmtTime(nav.info.time)}`);
    if (dest) renderNote(dest);
  }

  function computeRoute(dest, reframe) {
    if (!nav.pos) return;
    nav.lastSolve = { x: nav.pos.x, y: nav.pos.y, t: performance.now() };
    nav.results = { walk: solve(dest, 'walk'), drive: solve(dest, 'drive'), to: dest.id };
    if (!nav.results[nav.mode] && nav.results[nav.mode === 'walk' ? 'drive' : 'walk']) {
      nav.mode = nav.mode === 'walk' ? 'drive' : 'walk';
    }
    drawRoute();
    nav.fail = !nav.results.walk && !nav.results.drive;
    if (nav.fail) {
      nav.results = null;
      navStatus('Aucun chemin continu vers ce site dans les données OpenStreetMap.');
      renderNote(dest);
      return;
    }
    navStatus(`${MODES[nav.mode].label} : ${fmtDist(nav.info.dist)} · ${fmtTime(nav.info.time)}`);
    renderNote(dest);
    if (reframe) frameRoute(dest);
    // le tracé vient d'apparaître : on efface le menu pour le laisser voir
    if (reframe) {
      if (phoneLayout) setSheet('peek');
      else foldRail(true);
    } else if (phoneLayout && sheet.dataset.state === 'mini') {
      renderRouteBar();
    }
  }

  function frameRoute(dest) {
    const a = nav.pos;
    const cx = (a.x + dest.x) / 2, cy = (a.y + dest.y) / 2;
    const span = Math.hypot(dest.x - a.x, dest.y - a.y);
    /* On regarde dans l'axe du trajet : il se déploie alors du bas vers le
       haut de l'écran, ce qui tombe juste sur un téléphone tenu debout.
       Le léger biais de 0,38 rad évite le couloir parfaitement frontal. */
    const aspect = Math.max(0.35, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const portrait = aspect < 1;
    state.dTarget = [cx, field.at(cx, -cy) + 25, -cy];
    state.dDist = clamp(span * (portrait ? 1.05 / aspect : 1.45) + 300, 300, 3400);
    state.dPhi = portrait ? 0.60 : 0.52;
    state.dTheta = portrait
      ? Math.atan2(dest.x - a.x, -(dest.y - a.y)) + 0.38   // le trajet monte dans l'écran
      : Math.atan2(dest.y - a.y, dest.x - a.x);            // il traverse l'écran
    state.idle = 0;
    state.intro = false;
  }

  function renderNote(p) {
    const el = document.getElementById('placeNote');
    if (!el) return;
    let html = `<span class="eyebrow">${p.sub || 'Corte'}</span><strong>${p.name}</strong>`;
    if (p.note) html += `<span class="meta">${p.note}</span>` +
      `<button class="note-more" type="button" hidden>Lire la suite</button>`;

    if (nav.results && nav.results.to === p.id && nav.info) {
      const i = nav.info;
      const card = (m) => {
        const r = nav.results[m];
        const on = nav.mode === m;
        return `<button class="mode" data-mode="${m}" type="button" aria-pressed="${on}"${r ? '' : ' disabled'}>
          ${ICON(m, 'mode-ic')}
          <em>${r ? fmtTime(r.time) : '—'}</em>
          <span>${r ? fmtDist(r.dist) : MODES[m].label}</span>
        </button>`;
      };
      // même teinte que le tracé sur la carte, ramenée en espace d'affichage
      const col = () => `rgb(${MODES[nav.mode].col.map(v => Math.round(Math.sqrt(v) * 255)).join(',')})`;
      const arrive = new Date(Date.now() + i.time * 1000);
      const hh = String(arrive.getHours()).padStart(2, '0') + 'h' + String(arrive.getMinutes()).padStart(2, '0');
      const from = nav.pos.source === 'gps' ? 'Votre position' : 'Départ choisi';

      html += `<div class="route-box">
        <div class="trip">
          <span class="trip-pt trip-from"><i></i>${from}</span>
          <span class="trip-line"></span>
          <span class="trip-pt trip-to"><i></i>${p.name}</span>
        </div>
        <div class="mode-switch" role="group" aria-label="Mode de déplacement">${card('walk')}${card('drive')}</div>
        <div class="prof-wrap">
          ${profileSvg(i.prof, col())}
          <span class="prof-tag prof-up">+${Math.round(i.up)} m</span>
          <span class="prof-tag prof-down">−${Math.round(i.down)} m</span>
        </div>
        <div class="route-figs">
          <span><b>${fmtDist(i.dist)}</b>distance</span>
          <span><b>${hh}</b>arrivée</span>
        </div>
        <button class="ghost tiny" id="btnClearRoute" type="button">Effacer l’itinéraire</button>
      </div>`;
    } else if (nav.fail) {
      html += `<div class="route-box">
        <span class="route-head route-warn">Pas de chemin continu vers ce site dans les données OpenStreetMap.</span>
        <button class="ghost tiny" id="btnClearRoute" type="button">Fermer</button>
      </div>`;
    } else if (!nav.pos) {
      // état d'accueil : une seule action évidente
      html += `<div class="route-box route-cta">
        <span class="route-head">Itinéraire depuis votre position</span>
        <button class="go" id="btnGoLocate" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>
            <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3" stroke-linecap="round"/>
          </svg>
          Activer ma position
        </button>
        <span class="route-hint">ou gardez le doigt appuyé sur la carte pour poser un départ où vous voulez</span>
      </div>`;
    }

    el.innerHTML = html;
    el.classList.add('visible');
    sheet.dataset.fiche = '1';
    const b = document.getElementById('btnClearRoute');
    if (b) b.addEventListener('click', clearRoute);
    const g = document.getElementById('btnGoLocate');
    if (g) g.addEventListener('click', locateMe);

    /* « Lire la suite » n'apparaît que si le texte est réellement tronqué :
       inutile de proposer d'ouvrir la feuille pour deux lignes. */
    const meta = el.querySelector('.meta');
    const more = el.querySelector('.note-more');
    if (meta && more) {
      more.addEventListener('click', () => setSheet('open'));
      requestAnimationFrame(() => {
        const tronque = phoneLayout && sheet.dataset.state !== 'open'
          && meta.scrollHeight > meta.clientHeight + 2;
        more.hidden = !tronque;
      });
    }
    if (phoneLayout) requestAnimationFrame(placeFab);
    el.querySelectorAll('.mode').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode, p)));
  }

  function locateMe() {
    const btn = document.getElementById('btnLocate');
    if (!navigator.geolocation) {
      navStatus('Ce navigateur ne propose pas la géolocalisation.');
      return;
    }
    navStatus('Recherche du signal…');
    btn.disabled = true;
    if (nav.watchId !== null) navigator.geolocation.clearWatch(nav.watchId);
    nav.watchId = navigator.geolocation.watchPosition(
      (fix) => { btn.disabled = false; onFix(fix); },
      (err) => {
        btn.disabled = false;
        navigator.geolocation.clearWatch(nav.watchId);
        nav.watchId = null;
        const msg = err.code === 1 ? 'Accès à la position refusé.'
          : err.code === 3 ? 'Délai dépassé, position non obtenue.'
          : 'Position indisponible.';
        if (fab) fab.dataset.on = 'false';
        navStatus(msg + ' Utilisez « Départ manuel ».');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 4000 }
    );
  }

  function onFix(fix) {
    const x = (fix.coords.longitude - CORTE_DATA.origin.lon) * CORTE_DATA.mPerDegLon;
    const y = (fix.coords.latitude - CORTE_DATA.origin.lat) * CORTE_DATA.mPerDegLat;
    const lim = Math.abs(field.x0) - 40;
    if (Math.abs(x) > lim || Math.abs(y) > lim) {
      const km = Math.hypot(x, y) / 1000;
      navStatus(`Vous êtes à ${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km de Corte, hors de l’emprise de la carte. Utilisez « Départ manuel ».`);
      return;
    }
    const first = !nav.pos;
    if (fab) fab.dataset.on = 'true';
    setPosition(x, y, fix.coords.accuracy, 'gps');
    if (first && !state.activePlace) {
      state.dTarget = [x, field.at(x, -y) + 30, -y];
      state.dDist = 520;
      state.dPhi = 0.46;
      state.idle = 0;
      state.intro = false;
    }
  }

  function setPicking(on) {
    nav.picking = on;
    const b = document.getElementById('btnStart');
    if (b) b.setAttribute('aria-pressed', String(on));
    canvas.style.cursor = on ? 'crosshair' : 'grab';
    if (on) navStatus('Touchez la carte pour poser le départ.');
  }

  /* lancer de rayon sur le relief : renvoie [x est, y nord] ou null */
  function pickTerrain(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width * 2 - 1;
    const ny = 1 - (clientY - rect.top) / rect.height * 2;
    const a = [0, 0, 0, 0], b = [0, 0, 0, 0];
    M4.transform(a, matInvVP, nx, ny, -1);
    M4.transform(b, matInvVP, nx, ny, 1);
    const p0 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const p1 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    dx /= L; dy /= L; dz /= L;
    let t = 0, step = 5;
    for (let k = 0; k < 4000 && t < 20000; k++) {
      const x = p0[0] + dx * t, y = p0[1] + dy * t, z = p0[2] + dz * t;
      if (y <= field.at(x, z)) {
        let lo = Math.max(0, t - step), hi = t;
        for (let j = 0; j < 26; j++) {
          const m = (lo + hi) / 2;
          const mx = p0[0] + dx * m, my = p0[1] + dy * m, mz = p0[2] + dz * m;
          if (my <= field.at(mx, mz)) hi = m; else lo = m;
        }
        const m = (lo + hi) / 2;
        return [p0[0] + dx * m, -(p0[2] + dz * m)];
      }
      t += step;
      step = Math.min(step * 1.02, 45);
    }
    return null;
  }

  /* Poser un départ à l'endroit touché, sans passer par le menu.
     C'est l'idiome des applications de carte : on maintient le doigt, un
     point apparaît. Le calcul repart aussitôt si une destination est déjà
     choisie — et le cadrage suit, comme après un choix de site. */
  function dropStart(clientX, clientY) {
    const hit = pickTerrain(clientX, clientY);
    if (!hit) { navStatus('Point hors du relief — visez la vallée.'); return false; }
    setPicking(false);
    setPosition(hit[0], hit[1], 6, 'manuel');
    navStatus('Départ posé sur la carte.');
    const dest = objById.get(state.activePlace);
    if (dest) computeRoute(dest, true);
    return true;
  }

  /* Une tape brève sur la carte choisit le site le plus proche du doigt,
     mesuré à l'écran : on vise un bâtiment, pas une coordonnée. */
  function tapPlace(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const tol = Math.min(Math.min(rect.width, rect.height) * 0.17, 110);
    let best = null, bestD = tol;
    const v = [0, 0, 0, 0];
    for (const p of places) {
      M4.transform(v, matVP, p.x, field.at(p.x, -p.y) + 12, -p.y);
      if (v[3] <= 0) continue;
      const sx = (v[0] / v[3] * 0.5 + 0.5) * rect.width;
      const sy = (1 - (v[1] / v[3] * 0.5 + 0.5)) * rect.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return false;
    flyTo(best);
    return true;
  }

  /* ---------- input ---------- */
  function bindInput() {
    let dragging = false, panning = false, lx = 0, ly = 0, pinch = 0, downX = 0, downY = 0;
    let touches = 0, twoX = 0, twoY = 0;
    let holdTimer = 0, held = false;
    const ring = document.getElementById('holdRing');
    const cancelHold = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
      if (ring) ring.dataset.on = 'false';
    };
    const down = (e) => {
      dragging = true; panning = e.button === 2 || e.shiftKey;
      lx = downX = e.clientX; ly = downY = e.clientY;
      state.idle = 0; state.intro = false;
      canvas.setPointerCapture(e.pointerId);
      held = false;
      cancelHold();
      if (!panning && touches < 2) {
        if (ring) {
          ring.style.left = e.clientX + 'px';
          ring.style.top = e.clientY + 'px';
          ring.dataset.on = 'true';
        }
        holdTimer = setTimeout(() => {
          holdTimer = 0;
          if (ring) ring.dataset.on = 'false';
          if (touches >= 2) return;
          held = dropStart(downX, downY);
        }, 460);
      }
    };
    const move = (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 9) cancelHold();
      if (!dragging || touches >= 2) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY; state.idle = 0;
      if (panning) {
        const scale = state.dist * 0.0016;
        const c = Math.cos(state.theta), si = Math.sin(state.theta);
        state.dTarget[0] -= (dx * c - dy * si) * scale;
        state.dTarget[2] += (dx * si + dy * c) * scale;
        state.target[0] = state.dTarget[0]; state.target[2] = state.dTarget[2];
      } else {
        state.dTheta -= dx * 0.005;
        state.dPhi = clamp(state.dPhi + dy * 0.004, 0.06, 1.42);
      }
    };
    const up = (e) => {
      dragging = false;
      cancelHold();
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (held) { held = false; return; }          // l'appui long a déjà agi
      if (moved > 6 || touches >= 2) return;
      if (nav.picking) { dropStart(e.clientX, e.clientY); return; }
      tapPlace(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.dDist = clamp(state.dDist * Math.exp(e.deltaY * 0.0011), 150, 9000);
      state.idle = 0; state.intro = false;
    }, { passive: false });

    const twoFingers = (e) => ({
      d: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY),
      cx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
      cy: (e.touches[0].clientY + e.touches[1].clientY) / 2
    });
    canvas.addEventListener('touchstart', (e) => {
      touches = e.touches.length;
      if (touches === 2) { const t = twoFingers(e); pinch = t.d; twoX = t.cx; twoY = t.cy; }
    }, { passive: true });
    canvas.addEventListener('touchend', (e) => { touches = e.touches.length; if (touches < 2) pinch = 0; }, { passive: true });
    canvas.addEventListener('touchcancel', () => { touches = 0; pinch = 0; }, { passive: true });
    /* deux doigts : pincer pour zoomer, glisser pour déplacer la carte */
    canvas.addEventListener('touchmove', (e) => {
      touches = e.touches.length;
      if (touches !== 2 || !pinch) return;
      const t = twoFingers(e);
      state.dDist = clamp(state.dDist * (pinch / t.d), 150, 9000);
      const scale = state.dist * 0.0016;
      const dx = t.cx - twoX, dy = t.cy - twoY;
      const c = Math.cos(state.theta), si = Math.sin(state.theta);
      state.dTarget[0] -= (dx * c - dy * si) * scale;
      state.dTarget[2] += (dx * si + dy * c) * scale;
      state.target[0] = state.dTarget[0]; state.target[2] = state.dTarget[2];
      pinch = t.d; twoX = t.cx; twoY = t.cy;
      state.idle = 0; state.intro = false;
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      const step = state.dist * 0.08;
      const c = Math.cos(state.theta), si = Math.sin(state.theta);
      if (e.key === 'ArrowLeft') { state.dTarget[0] -= c * step; state.dTarget[2] += si * step; }
      else if (e.key === 'ArrowRight') { state.dTarget[0] += c * step; state.dTarget[2] -= si * step; }
      else if (e.key === 'ArrowUp') { state.dTarget[0] += si * step; state.dTarget[2] += c * step; }
      else if (e.key === 'ArrowDown') { state.dTarget[0] -= si * step; state.dTarget[2] -= c * step; }
      else if (e.key === '+' || e.key === '=') state.dDist = clamp(state.dDist * 0.8, 150, 9000);
      else if (e.key === '-') state.dDist = clamp(state.dDist * 1.25, 150, 9000);
      else if (e.key === 'Escape') overview();
      else return;
      state.idle = 0; state.intro = false;
      e.preventDefault();
    });
  }

  /* ---------- interface ---------- */
  /* La même liste sert de sommaire des campus et de résultats de recherche :
     une seule mécanique à comprendre pour l'utilisateur comme pour le code. */
  function renderList() {
    const el = document.getElementById('nav');
    if (!el) return;
    el.innerHTML = '';
    const q = query.trim();
    let rows, vide = '';
    if (q) {
      rows = search(q, 30);
      if (!rows.length) {
        vide = /^[a-z]{1,3}\s?-?\d/i.test(q)
          ? 'Aucune salle ni aucun lieu à ce nom. L’annuaire des salles se remplit dans <code>salles.json</code>.'
          : 'Rien à ce nom. Essayez « Desanti », « RU », « bibliothèque », « gare ».';
      }
    } else {
      rows = index.filter(e => e.kind === 'site');
    }
    for (const e of rows) {
      const b = document.createElement('button');
      b.className = 'nav-item' + (e.kind === 'salle' ? ' is-salle' : '');
      b.dataset.id = e.place.id;
      b.type = 'button';
      b.innerHTML = `<span class="ni-name">${e.name}</span>` +
        `<span class="ni-sub">${e.sub || ''}</span>`;
      b.addEventListener('click', () => { flyTo(e.place); });
      el.appendChild(b);
    }
    if (vide) {
      const d = document.createElement('p');
      d.className = 'nav-empty';
      d.innerHTML = vide;
      el.appendChild(d);
    }
    document.querySelectorAll('.nav-item').forEach(b =>
      b.classList.toggle('is-active', b.dataset.id === state.activePlace));
  }

  function setCat(c) {
    cat = c;
    document.querySelectorAll('.cat-chip').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.cat === c)));
    makePoiLabels();
  }

  function buildUI() {
    renderList();
    document.getElementById('btnOverview').addEventListener('click', overview);

    // chips de catégorie
    const catBox = document.getElementById('cats');
    if (catBox) {
      catBox.innerHTML = '';
      for (const c of CATS) {
        const b = document.createElement('button');
        b.className = 'cat-chip';
        b.type = 'button';
        b.dataset.cat = c.id;
        b.textContent = c.label;
        b.title = c.hint;
        b.setAttribute('aria-pressed', String(c.id === cat));
        b.addEventListener('click', () => setCat(cat === c.id ? '' : c.id));
        catBox.appendChild(b);
      }
    }

    // champ de recherche
    const find = document.getElementById('find');
    const findClear = document.getElementById('findClear');
    const head = document.getElementById('listHead');
    if (find) {
      const sync = () => {
        query = find.value;
        if (findClear) findClear.hidden = !query;
        if (head) head.textContent = query.trim()
          ? 'Résultats' : 'Campus & repères';
        renderList();
      };
      find.addEventListener('input', sync);
      find.addEventListener('focus', () => { if (phoneLayout) setSheet('open'); });
      find.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { find.value = ''; sync(); find.blur(); }
        if (e.key === 'Enter') {
          const first = document.querySelector('#nav .nav-item');
          if (first) { first.click(); find.blur(); }
        }
      });
      if (findClear) findClear.addEventListener('click', () => { find.value = ''; sync(); find.focus(); });
    }

    // carte de bienvenue, une seule fois par appareil
    const wel = document.getElementById('welcome');
    const welGo = document.getElementById('welcomeGo');
    let vu = false;
    try { vu = localStorage.getItem('pdc-vu') === '1'; } catch (_) {}
    if (wel && !vu) {
      wel.hidden = false;
      const close = () => {
        wel.hidden = true;
        try { localStorage.setItem('pdc-vu', '1'); } catch (_) {}
      };
      if (welGo) welGo.addEventListener('click', close);
      wel.addEventListener('click', (e) => { if (e.target === wel) close(); });
    }
    const foldBtn = document.getElementById('railFold');
    if (foldBtn) foldBtn.addEventListener('click', () =>
      foldRail(document.querySelector('.rail').dataset.fold !== 'true'));

    const bind = (id, key, onLabel, offLabel) => {
      const el = document.getElementById(id);
      const sync = () => { el.setAttribute('aria-pressed', String(state[key])); el.textContent = state[key] ? onLabel : offLabel; };
      el.addEventListener('click', () => { state[key] = !state[key]; sync(); });
      sync();
    };
    bind('tBuildings', 'showBuildings', 'Bâti', 'Bâti');
    bind('tRoads', 'showRoads', 'Voirie', 'Voirie');
    bind('tLabels', 'showLabels', 'Étiquettes', 'Étiquettes');
    bind('tOrbit', 'autoOrbit', 'Orbite auto', 'Orbite auto');

    const locate = document.getElementById('btnLocate');
    if (locate) locate.addEventListener('click', locateMe);
    const start = document.getElementById('btnStart');
    if (start) start.addEventListener('click', () => setPicking(!nav.picking));

    const hourEl = document.getElementById('hour');
    const hourOut = document.getElementById('hourOut');
    const fmt = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
    hourEl.value = String(state.hour);
    hourOut.textContent = fmt(state.hour);
    hourEl.addEventListener('input', () => { state.hour = parseFloat(hourEl.value); hourOut.textContent = fmt(state.hour); });

    const readout = document.getElementById('readout');
    setInterval(() => {
      const lat = (CORTE_DATA.origin.lat + (-state.target[2]) / CORTE_DATA.mPerDegLat).toFixed(4);
      const lon = (CORTE_DATA.origin.lon + state.target[0] / CORTE_DATA.mPerDegLon).toFixed(4);
      readout.textContent = `${lat}°N ${lon}°E · ${Math.round(field.at(state.target[0], state.target[2]))} m · ${Math.round(state.dist)} m`;
    }, 120);
  }

  /* ================= maquette téléphone ================= */

  const sheet = document.getElementById('sheet');
  const fab = document.getElementById('fabLocate');
  const mq = matchMedia('(max-width: 760px)');
  let phoneLayout = null;

  /* Les mêmes nœuds servent aux deux maquettes : on les déplace plutôt que
     de les dupliquer, ce qui préserve écouteurs et état. */
  function applyLayout() {
    const phone = mq.matches;
    if (phone === phoneLayout) return;
    phoneLayout = phone;
    const note = document.getElementById('placeNote');
    const navList = document.getElementById('nav');
    const foot = document.querySelector('.rail-foot');
    const strip = document.querySelector('.strip');
    const finder = document.getElementById('finder');
    if (!note || !navList || !foot || !strip) return;

    if (phone) {
      if (finder) document.getElementById('slotFind').appendChild(finder);
      document.getElementById('slotNote').appendChild(note);
      document.getElementById('slotNav').appendChild(navList);
      document.getElementById('slotFoot').appendChild(foot);
      document.getElementById('slotStrip').appendChild(strip);
      sheet.hidden = false;
      placeFab();
    } else {
      const rail = document.querySelector('.rail');
      if (finder) rail.insertBefore(finder, rail.firstElementChild);
      document.querySelector('.mast').appendChild(note);
      rail.insertBefore(navList, rail.querySelector('.rail-foot'));
      rail.appendChild(foot);
      document.querySelector('.overlay').appendChild(strip);
      sheet.hidden = true;
      document.body.classList.remove('sheet-open');
    }
  }

  /* Sur grand écran, c'est la liste des sites qui masque le tracé : on la
     replie dès qu'un itinéraire s'affiche, et on la rouvre quand il s'efface. */
  function foldRail(on) {
    const rail = document.querySelector('.rail');
    const btn = document.getElementById('railFold');
    if (!rail || !btn) return;
    rail.dataset.fold = String(!!on);
    btn.setAttribute('aria-expanded', String(!on));
    const txt = document.getElementById('railFoldTxt');
    if (txt) txt.textContent = on ? 'Afficher' : 'Masquer';
  }

  function placeFab() {
    if (!phoneLayout) return;
    const h = sheet.getBoundingClientRect().height;
    fab.style.bottom = Math.round(h + 12) + 'px';
  }

  function setSheet(state) {
    if (state === 'mini' && !(nav.results && nav.info) && !state_fiche()) state = 'peek';
    sheet.dataset.state = state;
    document.getElementById('sheetGrip').setAttribute('aria-expanded', String(state === 'open'));
    document.body.classList.toggle('sheet-open', state === 'open');
    if (state === 'mini') renderRouteBar();
    requestAnimationFrame(placeFab);
    setTimeout(placeFab, 320);
  }

  /* Bandeau de résumé du cran « mini » : le strict nécessaire pour savoir
     où l'on va, tout le reste de l'écran revient à la carte. */
  function renderRouteBar() {
    const bar = document.getElementById('routeBar');
    if (!bar) return;
    const i = nav.info;
    if (!i || !nav.results) { bar.hidden = true; return; }
    const dest = objById.get(nav.results.to);
    bar.hidden = false;
    bar.innerHTML = `${ICON(nav.mode, 'rb-ic')}
      <span class="rb-main">
        <span class="rb-time">${fmtTime(i.time)}</span>
        <span class="rb-sub">${fmtDist(i.dist)} · ${dest ? dest.name : ''}</span>
      </span>
      <span class="rb-more">Détails
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
          <path d="M5 9l7 7 7-7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>`;
  }

  function bindSheet() {
    sheet.addEventListener('transitionend', (e) => { if (e.propertyName === 'max-height') placeFab(); });
    const grip = document.getElementById('sheetGrip');
    let sy = 0, moved = false;
    grip.addEventListener('pointerdown', (e) => { sy = e.clientY; moved = false; grip.setPointerCapture(e.pointerId); });
    const UP = { mini: 'peek', peek: 'open', open: 'open' };
    const DOWN = { open: 'peek', peek: 'mini', mini: 'mini' };
    grip.addEventListener('pointermove', (e) => {
      if (Math.abs(e.clientY - sy) < 26 || moved) return;
      moved = true;
      const cur = sheet.dataset.state;
      setSheet((e.clientY < sy ? UP : DOWN)[cur] || 'peek');
    });
    grip.addEventListener('pointerup', (e) => {
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!moved) setSheet(sheet.dataset.state === 'open' ? 'peek' : UP[sheet.dataset.state] || 'open');
    });
    const bar = document.getElementById('routeBar');
    if (bar) bar.addEventListener('click', () => setSheet('peek'));
    fab.addEventListener('click', () => {
      locateMe();
      fab.dataset.on = 'true';
    });
    mq.addEventListener('change', applyLayout);
    window.addEventListener('resize', placeFab);
    applyLayout();
    setSheet('peek');
  }

  /* Annuaire des salles : fichier optionnel, tenu par l'établissement.
     Absent, illisible ou ouvert en file:// — on continue sans, la recherche
     porte alors sur les bâtiments seuls. */
  async function loadSalles() {
    try {
      const r = await fetch('salles.json', { cache: 'no-cache' });
      if (!r.ok) return [];
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.salles || []);
      return arr.filter(s => s && s.code && s.batiment);
    } catch (_) { return []; }
  }

  /* ---------- boot ---------- */
  async function boot() {
    const step = (pct, msg) => { loadBar.style.width = pct + '%'; loadNote.textContent = msg; return new Promise(r => setTimeout(r, 0)); };
    try {
      await step(12, 'Décompression du relief');
      const scene = await decodeScene(CORTE_DATA);
      field = scene.field; feats = scene.feats;

      await step(34, 'Maillage du relief');
      terrainMesh = buildTerrain(gl, field);

      await step(52, 'Extrusion du bâti');
      buildingMesh = buildBuildings(gl, feats, field).mesh;

      await step(68, 'Voirie et cours d’eau');
      roadMesh = buildRoads(gl, feats, field);
      waterMesh = buildWater(gl, feats, field);
      ringMesh = buildCampusRings(gl, feats, field);

      await step(82, 'Couverture du sol');
      coverTex = buildCover(gl, feats, field, 2048);

      await step(92, 'Compilation des nuanceurs');
      progs.sky = program(gl, VS_SKY, COMMON_INJECT(FS_SKY));
      progs.terrain = program(gl, VS_TERRAIN, COMMON_INJECT(FS_TERRAIN));
      progs.building = program(gl, VS_BUILDING, COMMON_INJECT(FS_BUILDING));
      progs.road = program(gl, VS_FLAT, COMMON_INJECT(FS_ROAD));
      progs.water = program(gl, VS_FLAT, COMMON_INJECT(FS_WATER));
      progs.ring = program(gl, VS_FLAT, COMMON_INJECT(FS_RING));
      progs.route = program(gl, VS_ROUTE, COMMON_INJECT(FS_ROUTE));
      progs.depth = program(gl, VS_DEPTH, FS_DEPTH);
      progs.bright = program(gl, VS_QUAD, FS_BRIGHT);
      progs.blur = program(gl, VS_QUAD, FS_BLUR);
      progs.bloom = program(gl, VS_QUAD, FS_BLOOM);
      progs.quad = vao(gl, [{ loc: 0, size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) }], null);

      // shadow framebuffer
      SHADOW_SIZE = SHADOW_SIZE_DEV;
      shadowTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      shadowFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      places = CORTE_DATA.places.map(p => ({ ...p }));
      salles = await loadSalles();
      buildIndex();
      makeLabels();
      buildUI();
      bindInput();
      bindSheet();

      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.depthFunc(gl.LEQUAL);

      await step(100, 'Prêt');
      // opening move: wide shot settling over the Tavignano valley
      state.dist = 7600; state.phi = 0.82; state.theta = -1.64;
      state.target = [40, 900, -140];
      state.dTarget = [40, 430, -140]; state.dDist = 1700; state.dPhi = 0.44; state.dTheta = -0.74;
      state.intro = true;
      loader.classList.add('done');
      setTimeout(() => loader.remove(), 900);
      requestAnimationFrame(frame);
    } catch (err) {
      console.error(err);
      loader.classList.add('failed');
      loadNote.textContent = 'La carte n’a pas pu se charger : ' + err.message;
    }
  }

  function COMMON_INJECT(src) {
    const i = src.indexOf('\n', src.indexOf('precision'));
    return src.slice(0, i + 1) + COMMON + src.slice(i + 1);
  }

  boot();
})();
