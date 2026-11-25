// Fracas : petite ville maquette, une voiture jouet, tout ce qu'elle touche part en vrai (Rapier),
// et une foule de PNJ qui s'écarte en éventail devant elle, sans jamais être touchée (v2).
// Contrat (window.jeu, paramètres d'URL, scènes) : SPEC.md, section « Identifiants ».
import * as THREE from 'three';
import RAPIER from 'rapier';

await RAPIER.init();

// ---------- paramètres d'URL ----------
const U = new URLSearchParams(location.search);
const num = (k, d) => { const v = parseFloat(U.get(k)); return Number.isFinite(v) ? v : d; };
const P = {
  scene: U.get('scene'), bande: U.get('bande'), seed: num('seed', 7),
  portrait: U.get('format') === '916', capture: U.get('capture') === '1',
  ralenti: [0.5, 0.25].includes(num('ralenti', 1)) ? num('ralenti', 1) : 1,
  ralDe: num('ralenti_de', 0), ralA: num('ralenti_a', Infinity),
  moteur: num('moteur', 1), rampe: num('rampe', 1), objets: num('objets', 1),
  debris: U.get('debris') !== '0', seuil: num('seuil_casse', 1),
  camDist: num('cam_dist', 1), camHaut: num('cam_haut', 1), flou: num('flou', 1),
  pnj: num('pnj', NaN), pnjTaille: num('pnj_taille', 1), marqueTaille: num('marque_taille', 1),
  contagion: num('panique_contagion', 6), retard: num('panique_retard', 0.5), pnjVitesse: num('pnj_vitesse', 1),
};
P.hud = U.has('hud') ? U.get('hud') === '1' : !P.capture;

const DT = 1 / 240;                       // pas fixe de la physique
const PAS = 50, DEMI_ROUTE = 7, DEMI_BLOC = 18, DEMI_BATI = 14, N = 5;   // ville : 5 x 5 blocs
const ETENDUE = N * PAS + 2 * DEMI_ROUTE;
const SEUIL_CASSE = 15000;                // N : force de contact qui brise une caisse
const PI = Math.PI, sin = Math.sin, cos = Math.cos, hypot = Math.hypot;

function generateur(graine) {             // mulberry32
  let a = graine >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- scènes ----------
// cap : 0 = vers +z ; avant de la voiture = (sin cap, 0, cos cap)
// pnj : nombre de PNJ par défaut ; file : PNJ qui attendent, posés à la main ; rue : la foule de l'avenue (scène panique)
const SCENES = {
  libre:        { x: 25, z: -36, cap: 0, v: 0, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0], pnj: 150 },
  tonneau:      { x: 25, z: -16, cap: 0, v: 20, cam: [11, 7, 0.5, 2], cam916: [14, 15, 0.22, 3.5], pnj: 16 },
  avenue:       { x: -110, z: -75, cap: PI / 2, v: 14, cam: [11, 6, 0.35, 2], cam916: [13, 13, 0.4, 3], pnj: 16 },
  finale:       { x: 18, z: 25, cap: -PI / 2, v: 20, cam: [12, 7, -0.4, 2], cam916: [17, 18, -0.4, 4], pnj: 16 },
  survol:       { x: 25, z: -36, cap: 0, v: 0, survol: { de: [-150, 78, 150], dir: [0.7071, -0.7071], vit: 13, loin: 85 }, pnj: 16 },
  essai_pieton: { x: 75, z: 32, cap: 0, v: 0, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0], pnj: 1, file: [[75, 57]] },
  panique:      { x: -110, z: -75, cap: PI / 2, v: 14, cam: [11, 6, 0.35, 2], cam916: [17, 7.5, 0.1, 20], pnj: 300, rue: true },
  // 10 PNJ en file sur la rue x = 25, perpendiculaire à la voiture qui roule sur z = 25 (carrefour sans circulation)
  essai_vague:  { x: 5, z: 25, cap: PI / 2, v: 14, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0], pnj: 10, file: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => [25, 28 + 4 * i]) },
  // la voiture roule sur le trottoir, à 0,4 m du mur z = 36 du bloc (50, 50) ; le PNJ attend dos à ce mur
  essai_mur:    { x: 30, z: 34.6, cap: PI / 2, v: 12, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0], pnj: 1, file: [[55, 35.45]] },
};
if (!SCENES[P.scene]) P.scene = 'libre';
const SC = SCENES[P.scene];
P.pnj = Math.max(0, Math.min(600, Math.round(Number.isFinite(P.pnj) ? P.pnj : SC.pnj)));

// ---------- le plan de la ville (données pures, tirées de la graine) ----------
const PASTELS = [0xbfe8d4, 0xffd3b0, 0xbcdcf5, 0xfbeeb0, 0xf6d5d8];   // menthe, pêche, bleu ciel, beurre, rose poudré pâle
const CENTRES = [-2, -1, 0, 1, 2].map(i => i * PAS);
const tour = b => 4 * (2 * b.h - 2 * b.r) + 2 * PI * b.r;      // longueur d'une boucle de bloc
const plan = (() => {
  const R = generateur(P.seed), al = (a, b) => a + (b - a) * R(), choix = t => t[Math.floor(R() * t.length)];
  const batiments = [], objets = [], centres = CENTRES;
  const obj = (t, x, y, z, cap = 0, teinte = 0xffffff) => objets.push({ t, x, y, z, cap, teinte });
  for (const cx of centres) for (const cz of centres) {
    // 1, 2 ou 4 immeubles par bloc
    const n = choix([1, 2, 2, 4]), d = DEMI_BATI / 2 + 0.25, l = DEMI_BATI - 0.5, sens = R() < 0.5;
    const lots = n === 1 ? [[0, 0, 2 * DEMI_BATI, 2 * DEMI_BATI]]
      : n === 2 ? [-d, d].map(o => sens ? [o, 0, l, 2 * DEMI_BATI] : [0, o, 2 * DEMI_BATI, l])
      : [[-d, -d, l, l], [d, -d, l, l], [-d, d, l, l], [d, d, l, l]];
    for (const [ox, oz, sx, sz] of lots) batiments.push({ x: cx + ox, z: cz + oz, sx, sz, h: al(8, 32), couleur: choix(PASTELS) });
    // mobilier au bord du trottoir et voitures garées, sur les 4 côtés (0 : z-, 1 : x+, 2 : z+, 3 : x-)
    for (let k = 0; k < 4; k++) {
      const [ux, uz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k], [nx, nz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][k];
      const sur = (t, dehors) => [cx + nx * (DEMI_BLOC + dehors) + ux * t, cz + nz * (DEMI_BLOC + dehors) + uz * t];
      const nb = Math.round(4 * P.objets);
      for (let i = 0; i < nb; i++) {
        const [x, z] = sur(-14 + 28 * (i + al(0.2, 0.8)) / nb, -1), t = choix(['cone', 'cone', 'poubelle', 'banc', 'baril', 'caisse']);
        if (t === 'cone') obj('cone', x, 0.35, z);
        else if (t === 'poubelle') obj('poubelle', x, 0.5, z, 0, choix([0xa9c5b4, 0xb7c3cf]));
        else if (t === 'banc') obj('banc', x, 0.4, z, Math.atan2(-nx, -nz));
        else if (t === 'baril') obj('baril', x, 0.45, z, 0, choix(PASTELS));
        else { obj('caisse', x, 0.45, z, al(-0.3, 0.3)); if (R() < 0.5) obj('caisse', x, 1.35, z, al(-0.3, 0.3)); }
      }
      // rien de garé le long de l'étal du tonneau (rue x = 25, z de -18 à 18)
      const etal = cz === 0 && ((cx === 0 && k === 1) || (cx === PAS && k === 3));
      for (const t of [-8, 6]) if (!etal && R() < 0.45 * P.objets) {
        const [x, z] = sur(t + al(-1.5, 1.5), 1);
        obj('voiture_garee', x, 0.5, z, Math.atan2(ux, uz), choix(PASTELS));
      }
    }
  }
  // l'étal du tonneau : caisses empilées en travers de la rue x = 25, cônes devant et dessus
  for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) {
    const x = 22 + i * 1.0, z = 3 + j * 1.3, h = 1 + Math.floor(R() * 3);
    for (let e = 0; e < h; e++) obj('caisse', x, 0.45 + 0.9 * e, z, al(-0.08, 0.08));
    if (R() < 0.5) obj('cone', x, 0.9 * h + 0.35, z);
  }
  for (let i = 0; i < 6; i++) for (const x of [24.88, 25.82]) { obj('caisse', x, 0.45, -10 + 1.0 * i); obj('cone', x, 1.25, -10 + 1.0 * i); }     // à gauche de la rampe, sur la trajectoire
  // la pyramide de la finale, au carrefour (-25, 25)
  for (let e = 0; e < 7; e++) for (let i = 0; i < 7 - e; i++) for (let j = 0; j < 7 - e; j++)
    obj('caisse', -25 + (i - (6 - e) / 2) * 0.92, 0.45 + 0.9 * e, 25 + (j - (6 - e) / 2) * 0.92);
  for (let i = 0; i < 7; i++) { obj('baril', -20.6, 0.45, 22 + i, 0, choix(PASTELS)); obj('cone', -19.4, 0.35, 22 + i); }
  for (let i = 0; i < 6; i++) { obj('baril', -21.3, 1.35, 22.5 + i, 0, choix(PASTELS)); }
  for (let i = 0; i < 7; i++) for (const z of [24.45, 25.55]) { obj('baril', -10 - 1.2 * i, 0.45, z, 0, choix(PASTELS)); obj('cone', -10 - 1.2 * i, 1.25, z); }     // dans l'axe, avant la pyramide
  // des cônes au milieu de l'avenue z = -75
  for (let i = 0; i < 8; i++) obj('cone', -92 + 8 * i, 0.35, -75);

  // circulation : boucles autour des blocs, loin de l'étal et de la pyramide
  const Q = tour;
  const circulation = [];
  const auto = (cx, cz, f) => { const b = { cx, cz, h: DEMI_BLOC + 4, r: 4 }; circulation.push({ b, s: f * Q(b), couleur: choix(PASTELS) }); };
  for (const [cx, cz, f] of [[-100, -100, 0.55], [-100, -50, 0.02], [-50, -100, 0.42], [-50, -50, 0.93]]) { auto(cx, cz, f); auto(cx, cz, f + 0.5); }
  for (const [cx, cz] of [[0, -100], [0, -50], [50, -50], [100, 0], [-100, 50], [0, 100], [50, 100], [100, -100]]) auto(cx, cz, R());
  // piétons : boucles sur le trottoir, côté immeubles
  const pietons = [], COULEURS = [0x5b8fb9, 0xe8a87c, 0x6fae90, 0xe9c46a, 0x8d99ae, 0x4f6d7a];
  const pieton = (cx, cz, f) => { const b = { cx, cz, h: DEMI_BLOC - 3, r: 1 }; pietons.push({ b, s: f * Q(b), sens: R() < 0.5 ? 1 : -1, couleur: choix(COULEURS) }); };
  for (const [cx, cz, k] of [[-100, -100, 2], [-50, -100, 2], [-100, -50, 0], [-50, -50, 0]]) { pieton(cx, cz, (k + 0.3) / 4); pieton(cx, cz, (k + 0.7) / 4); }
  for (const [cx, cz] of [[100, -100], [100, -50], [100, 0], [100, 50], [50, -100], [-50, 100], [0, -100], [-100, 50]]) pieton(cx, cz, R());
  return { batiments, objets, circulation, pietons, couleurs: COULEURS };
})();

// position et cap sur une boucle (rectangle aux coins arrondis, parcouru avec le bloc à droite)
function boucle(b, s) {
  const droit = 2 * b.h - 2 * b.r, arc = PI * b.r / 2, quart = droit + arc, total = 4 * quart;
  s = ((s % total) + total) % total;
  const k = Math.floor(s / quart), t = s - k * quart;
  let x, z, cap;            // côté 0 : z = -h, cap +x
  if (t < droit) { x = -b.h + b.r + t; z = -b.h; cap = PI / 2; }
  else { const a = (t - droit) / b.r; x = b.h - b.r + b.r * sin(a); z = -b.h + b.r - b.r * cos(a); cap = PI / 2 - a; }
  for (let i = 0; i < k; i++) { [x, z] = [-z, x]; cap -= PI / 2; }
  return { x: b.cx + x, z: b.cz + z, cap };
}

// ---------- la foule (données pures ; un générateur à part, pour que la ville ne bouge pas quand la foule change) ----------
// forme au sol des objets pour les PNJ : rayon englobant r, et rectangle L x l (demi-côtés) pour les objets longs au repos
const FORMES = { caisse: { r: 0.64 }, cone: { r: 0.3 }, baril: { r: 0.5 }, poubelle: { r: 0.58 }, banc: { r: 0.95, L: 0.9, l: 0.28, enX: true },
  voiture_garee: { r: 2.33, L: 2.1, l: 1 }, planche: { r: 0.64 } };
const circulation = plan.circulation.filter(a => !SC.rue || a.b.cx > 25 || a.b.cz > -25);     // scène panique : pas de circulation dans la foule de l'avenue
const foule = (() => {
  const G = generateur(P.seed + 2000), al = (a, b) => a + (b - a) * G(), choix = t => t[Math.floor(G() * t.length)];
  const TEINTES = [0x5b8fb9, 0xe8a87c, 0x6fae90, 0xe9c46a, 0x8d99ae, 0x4f6d7a, 0x2a9d8f, 0xf4a261, 0x264653, 0x90be6d, 0xf9c74f, 0x577590, 0x43aa8b, 0xbc6c25, 0x3d5a80, 0xee9b00, 0xf1faee];
  const libreAu = (x, z, m = 0.5) => plan.objets.every(o => hypot(o.x - x, o.z - z) > FORMES[o.t].r + m);
  // un PNJ : sa couleur, son pas, et son caractère dans la panique (retard de réaction, marge et élan de fuite, part radiale)
  const perso = o => Object.assign({ couleur: choix(TEINTES), cap: al(-PI, PI), vit: al(1.1, 1.6), sens: G() < 0.5 ? 1 : -1, cote: G() < 0.5 ? 1 : -1,
    retard: al(0.3, 1), marge: al(3.6, 6), elan: al(4, 9), radial: al(0, 1.6), avance: al(0, 0.3), calme: al(1.5, 2.5), souffle: al(0.4, 1) }, o);
  const marcheur = () => { const b = { cx: choix(CENTRES), cz: choix(CENTRES), h: al(14.7, 16.3), r: 1 }; return perso({ type: 'marche', b, s: G() * tour(b) }); };
  const attente = () => {      // sur un trottoir, côté immeubles
    for (let e = 0; e < 30; e++) {
      const k = Math.floor(G() * 4), h = al(14.5, 16.2), t = al(-15.5, 15.5), cx = choix(CENTRES), cz = choix(CENTRES);
      const x = cx + [0, 1, 0, -1][k] * h + [1, 0, -1, 0][k] * t, z = cz + [-1, 0, 1, 0][k] * h + [0, 1, 0, -1][k] * t;
      if (libreAu(x, z)) return perso({ type: 'attend', x, z });
    }
    return marcheur();
  };
  const traversee = (ax, az, bx, bz) => {      // aller et retour d'un trottoir à l'autre ; null si un objet est posé sur le chemin
    const len = hypot(bx - ax, bz - az);
    for (let d = 0; d <= len; d += 0.5) if (!libreAu(ax + (bx - ax) * d / len, az + (bz - az) * d / len, 0.45)) return null;
    return perso({ type: 'traverse', ax, az, bx, bz, len, t: al(0.08, 0.92) });
  };
  // ponytail: les PNJ ne traversent que les rues sans circulation, loin de l'étal et de la pyramide ;
  // pour traverser partout, il faudrait qu'ils attendent le passage des voitures de circulation
  const trafic = new Set(plan.circulation.map(a => a.b.cx + ',' + a.b.cz)), croisees = [];
  for (const cx of CENTRES) for (const cz of CENTRES) for (const [dx, dz] of [[PAS, 0], [0, PAS]]) {
    const mx = cx + dx / 2, mz = cz + dz / 2;
    if (cx + dx > 2 * PAS || cz + dz > 2 * PAS || trafic.has(cx + ',' + cz) || trafic.has((cx + dx) + ',' + (cz + dz))) continue;
    if (hypot(mx - 25, mz) < 30 || hypot(mx + 25, mz - 25) < 30) continue;
    croisees.push([mx, mz, dx > 0]);
  }
  const traverseur = () => {
    for (let e = 0; e < 30 && croisees.length; e++) {
      const [mx, mz, enX] = choix(croisees), t = al(-13, 13);
      const p = enX ? traversee(mx - 9.3, mz + t, mx + 9.3, mz + t) : traversee(mx + t, mz - 9.3, mx + t, mz + 9.3);
      if (p) return p;
    }
    return marcheur();
  };
  // scène panique : l'avenue z = -75, de 20 à 70 m devant la voiture. Sur 25 PNJ : 8 marchent (trottoirs), 10 attendent, 7 traversent.
  const MOTIF = 'MATMATMATMATMATMATMATAAAM';
  const rue = i => {
    const sorte = MOTIF[i % 25];
    if (sorte === 'M') {
      const x = G() < 0.15 ? al(-90, -86.5) : al(-63.4, -36.5), cx = x < -75 ? -100 : -50, nord = G() < 0.5;
      const b = { cx, cz: nord ? -50 : -100, h: al(14.6, 16.3), r: 1 }, quart = 2 * b.h - 2 + PI / 2;
      return perso({ type: 'marche', b, s: nord ? x - cx + b.h - 1 : 2 * quart + cx + b.h - 1 - x });
    }
    const leLong = () => G() < 0.2 ? al(-90, -82.5) : al(-67.5, -38);      // le long d'un trottoir
    if (sorte === 'T') for (let e = 0; e < 30; e++) { const x = leLong(), p = traversee(x, -84.3, x, -65.7); if (p) return p; }
    for (let e = 0; e < 60; e++) {      // ceux qui attendent : sur la chaussée surtout
      const trottoir = G() < 0.25, x = trottoir ? leLong() : al(-90, -40), z = -75 + (G() < 0.5 ? 1 : -1) * (trottoir ? al(8.6, 10.4) : al(0.9, 5.2));
      if (libreAu(x, z)) return perso({ type: 'attend', x, z });
    }
    return perso({ type: 'attend', x: -60, z: -70 });
  };
  const gens = (SC.file || []).map(([x, z]) => perso({ type: 'attend', x, z }));
  if (!SC.file && !SC.rue) for (const p of plan.pietons) gens.push(perso({ type: 'marche', ...p, vit: 1.3 }));      // les 16 piétons de la v1
  const part = P.scene === 'libre' ? [0.12, 0] : [0.12, 0.28];      // en jeu libre, personne n'attend
  while (gens.length < P.pnj) {
    if (SC.rue) { gens.push(rue(gens.length)); continue; }
    const u = G();
    gens.push(u < part[0] ? traverseur() : u < part[0] + part[1] ? attente() : marcheur());
  }
  gens.length = P.pnj;
  return gens;
})();

// ---------- rendu ----------
const rendu = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
rendu.setPixelRatio(1);
rendu.shadowMap.enabled = true;
rendu.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(rendu.domElement);
const scene = new THREE.Scene();
const CIEL = 0xdff0fa;
scene.background = new THREE.Color(CIEL);
scene.fog = new THREE.Fog(CIEL, 140, 460);
const camera = new THREE.PerspectiveCamera(P.portrait ? 50 : 55, 1, 0.5, 700);
scene.add(new THREE.HemisphereLight(0xffffff, 0xf1e2c8, 1.9));
const soleil = new THREE.DirectionalLight(0xfff3df, 1.9);
soleil.castShadow = true;
soleil.shadow.mapSize.set(2048, 2048);
const portee = SC.survol ? 130 : 55;
Object.assign(soleil.shadow.camera, { left: -portee, right: portee, top: portee, bottom: -portee, near: 1, far: 400 });
soleil.shadow.bias = -0.0004; soleil.shadow.normalBias = 0.04; soleil.shadow.radius = 3;
scene.add(soleil, soleil.target);

// flou maquette : la scène est rendue dans une cible, puis recopiée avec un flou qui croît vers le haut et le bas
const cible3d = new THREE.WebGLRenderTarget(2, 2, { samples: 4, type: THREE.HalfFloatType });
const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { t: { value: cible3d.texture }, px: { value: new THREE.Vector2() }, flou: { value: P.flou } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `uniform sampler2D t; uniform vec2 px; uniform float flou; varying vec2 vUv;
    void main(){
      float r = flou * 1.7 * smoothstep(0.2, 0.5, abs(vUv.y - 0.5));
      vec4 c = vec4(0.);
      for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) c += texture2D(t, vUv + vec2(float(i), float(j)) * px * r);
      gl_FragColor = c / 49.;
      #include <colorspace_fragment>
    }`,
  depthTest: false, depthWrite: false,
}));
post.frustumCulled = false;
const scenePost = new THREE.Scene().add(post), camPost = new THREE.Camera();
function tailler() {
  const l = innerWidth, h = innerHeight;
  rendu.setSize(l, h); cible3d.setSize(l, h);
  post.material.uniforms.px.value.set(1 / l, 1 / h);
  camera.aspect = l / h; camera.updateProjectionMatrix();
}
tailler();
addEventListener('resize', () => { tailler(); if (jeu.pret) dessiner(); });

// ---------- géométries (tout en code) ----------
const lambert = o => new THREE.MeshLambertMaterial(o);
const boite = (x, y, z) => new THREE.BoxGeometry(x, y, z), cyl = (a, b, h, n = 16) => new THREE.CylinderGeometry(a, b, h, n);
function fusion(pieces) {     // [[géométrie, couleur, x, y, z, rx, ry, rz], ...] -> une géométrie à couleurs de sommet
  const pos = [], nor = [], col = [], m = new THREE.Matrix4(), e = new THREE.Euler(), c = new THREE.Color();
  for (const [g0, couleur, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0] of pieces) {
    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    g.applyMatrix4(m.makeRotationFromEuler(e.set(rx, ry, rz)).setPosition(x, y, z));
    c.set(couleur);
    for (let i = 0; i < g.attributes.position.count; i++) col.push(c.r, c.g, c.b);
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
const SOMBRE = 0x3b4252, VITRE = 0x56657a, BOIS = 0xd9a86c;
const roues = (y, r) => [[-0.92, 1.35], [0.92, 1.35], [-0.92, -1.35], [0.92, -1.35]].map(([x, z]) => [cyl(r, r, 0.3), SOMBRE, x, y, z, 0, 0, PI / 2]);
// profil de la voiture du joueur (z vers l'avant, y) : un coin, nez bas, qui passe sous ce qu'il heurte
const PROFIL = [[-2.1, -0.5], [2.1, -0.5], [2.1, -0.38], [0.2, 0.78], [-1.3, 0.85], [-2.1, 0.45]];
const geoJoueur = (() => {
  const f = new THREE.Shape(PROFIL.map(([z, y]) => new THREE.Vector2(-z, y)));
  const coque = new THREE.ExtrudeGeometry(f, { depth: 2, bevelEnabled: false }).rotateY(PI / 2).translate(-1, 0, 0);
  const pente = Math.atan2(1.16, 1.9);
  return fusion([[coque, 0xff4a36], ...roues(-0.4, 0.35),     // rouge tomate
    [boite(1.7, 0.04, 0.95), VITRE, 0, 0.5, 0.7, pente, 0, 0],                 // pare-brise
    [boite(2.04, 0.3, 1.3), VITRE, 0, 0.55, -0.55],                            // vitres latérales
    [boite(0.45, 0.08, 0.06), 0xfff6d8, -0.65, -0.44, 2.1], [boite(0.45, 0.08, 0.06), 0xfff6d8, 0.65, -0.44, 2.1],
    [boite(0.5, 0.03, 1.5), 0xfff6e8, 0, 0.83, -0.55, -0.047, 0, 0], [boite(0.5, 0.03, 1.1), 0xfff6e8, 0, -0.02, 1.52, pente, 0, 0],   // bande blanche
    [boite(1.6, 0.04, 0.7), VITRE, 0, 0.66, -1.72, -Math.atan2(0.4, 0.8), 0, 0],                                    // lunette arrière
    [boite(0.4, 0.12, 0.06), 0xffd9c4, -0.7, 0.2, -2.1], [boite(0.4, 0.12, 0.06), 0xffd9c4, 0.7, 0.2, -2.1],
    [boite(1.9, 0.03, 4.0), SOMBRE, 0, -0.51, 0]]);                                                                 // dessous
})();
const geoAuto = fusion([[boite(2, 0.6, 4.2), 0xffffff, 0, -0.05, 0], [boite(1.7, 0.42, 2.2), VITRE, 0, 0.46, -0.1],
  [boite(1.74, 0.08, 2.24), 0xffffff, 0, 0.71, -0.1], ...roues(-0.17, 0.33)]);
const texCaisse = (() => {     // face de caisse en bois, dessinée
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e2b47c'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#b98a54'; g.lineWidth = 2;
  for (const y of [16, 32, 48]) { g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke(); }
  g.strokeStyle = '#c4935a'; g.lineWidth = 9; g.strokeRect(4, 4, 56, 56);
  g.beginPath(); g.moveTo(6, 58); g.lineTo(58, 6); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const TYPES = {     // masse (kg), collider(s), géométrie centrée sur le collider
  caisse: { m: 8, cols: () => [RAPIER.ColliderDesc.cuboid(0.45, 0.45, 0.45)], geo: boite(0.9, 0.9, 0.9), mat: lambert({ map: texCaisse }) },
  cone: { m: 1.5, cols: () => [RAPIER.ColliderDesc.cone(0.35, 0.24)],
    geo: fusion([[new THREE.ConeGeometry(0.2, 0.64, 16), 0xff8a3c, 0, 0.03, 0], [cyl(0.092, 0.142, 0.16), 0xffffff, 0, -0.01, 0], [boite(0.48, 0.06, 0.48), 0xff8a3c, 0, -0.32, 0]]) },
  baril: { m: 8, cols: () => [RAPIER.ColliderDesc.cylinder(0.45, 0.3).setRestitution(0.35)],
    geo: fusion([[cyl(0.3, 0.3, 0.9), 0xf2f2f2], [cyl(0.315, 0.315, 0.07), 0xffffff, 0, 0.2, 0], [cyl(0.315, 0.315, 0.07), 0xffffff, 0, -0.2, 0]]) },
  poubelle: { m: 6, cols: () => [RAPIER.ColliderDesc.cuboid(0.3, 0.5, 0.3)],
    geo: fusion([[boite(0.6, 0.88, 0.6), 0xffffff, 0, -0.06, 0], [boite(0.66, 0.12, 0.66), 0xb0b0b0, 0, 0.44, 0]]) },
  banc: { m: 25, cols: () => [RAPIER.ColliderDesc.cuboid(0.9, 0.4, 0.28)],
    geo: fusion([[boite(1.8, 0.08, 0.5), BOIS, 0, 0.05, 0], [boite(1.8, 0.4, 0.06), BOIS, 0, 0.3, -0.25], [boite(0.08, 0.45, 0.45), SOMBRE, -0.75, -0.175, 0], [boite(0.08, 0.45, 0.45), SOMBRE, 0.75, -0.175, 0]]) },
  voiture_garee: { m: 450, cols: () => [RAPIER.ColliderDesc.cuboid(1, 0.5, 2.1), RAPIER.ColliderDesc.cuboid(0.85, 0.13, 1.1).setTranslation(0, 0.62, -0.1)], geo: geoAuto },
};
const NOMS = Object.keys(TYPES);

// ---------- décor fixe ----------
const ombre = m => { m.castShadow = true; m.receiveShadow = true; return m; };
const M4 = new THREE.Matrix4(), V3 = new THREE.Vector3(), Q4 = new THREE.Quaternion(), S3 = new THREE.Vector3(1, 1, 1), C3 = new THREE.Color(), E3 = new THREE.Euler();
const UN = new THREE.Vector3(1, 1, 1), AXE_Y = new THREE.Vector3(0, 1, 0);
{
  const sol = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-PI / 2), lambert({ color: 0xf3ead8 }));
  sol.receiveShadow = true; scene.add(sol);
  const lignes = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map(i => i * PAS);
  const route = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), lambert({ color: 0xd6d6d2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 12);
  const traits = [];
  lignes.forEach((c, i) => {
    route.setMatrixAt(2 * i, M4.makeScale(2 * DEMI_ROUTE, 1, ETENDUE).setPosition(c, 0.02, 0));
    route.setMatrixAt(2 * i + 1, M4.makeScale(ETENDUE, 1, 2 * DEMI_ROUTE).setPosition(0, 0.02, c));
    for (const cb of [-2, -1, 0, 1, 2]) for (let t = -15; t <= 15; t += 6) traits.push([c, cb * PAS + t, 0], [cb * PAS + t, c, 1]);
  });
  route.receiveShadow = true; scene.add(route);
  const trait = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-PI / 2), lambert({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), traits.length);
  traits.forEach(([x, z, sens], i) => trait.setMatrixAt(i, M4.makeScale(sens ? 2.6 : 0.22, 1, sens ? 0.22 : 2.6).setPosition(x, 0.03, z)));
  trait.receiveShadow = true; scene.add(trait);
  const dalle = new THREE.InstancedMesh(boite(2 * DEMI_BLOC, 0.1, 2 * DEMI_BLOC), lambert({ color: 0xfbf6ea }), N * N);
  let i = 0;
  for (const cx of [-2, -1, 0, 1, 2]) for (const cz of [-2, -1, 0, 1, 2]) dalle.setMatrixAt(i++, M4.makeTranslation(cx * PAS, 0, cz * PAS));
  dalle.receiveShadow = true; scene.add(dalle);
  // immeubles : un volume pastel, des bandeaux de fenêtres, une corniche et un édicule sur le toit
  const pieces = [];
  for (const b of plan.batiments) {
    const c = new THREE.Color(b.couleur), clair = c.clone().lerp(new THREE.Color(0xffffff), 0.35);
    pieces.push([b.x, 0, b.z, b.sx, b.h, b.sz, c], [b.x, b.h, b.z, b.sx + 0.5, 0.5, b.sz + 0.5, clair],
      [b.x + b.sx * 0.18, b.h + 0.5, b.z - b.sz * 0.15, Math.min(4, b.sx * 0.3), 1.6, Math.min(4, b.sz * 0.3), clair]);
    for (let y = 2.2; y + 2 < b.h; y += 3.4) pieces.push([b.x, y, b.z, b.sx + 0.12, 1.3, b.sz + 0.12, c.clone().multiplyScalar(0.72).lerp(new THREE.Color(0xa9c3d6), 0.45)]);
  }
  const bati = ombre(new THREE.InstancedMesh(boite(1, 1, 1).translate(0, 0.5, 0), lambert({}), pieces.length));
  pieces.forEach(([x, y, z, sx, sy, sz, c], k) => { bati.setMatrixAt(k, M4.makeScale(sx, sy, sz).setPosition(x, y, z)); bati.setColorAt(k, c); });
  scene.add(bati);
}
// rampe du tonneau : un tremplin courbe sous les roues droites seulement (rue x = 25), qui fait basculer la voiture
const RAMPE = { x: 23.6, z: -9.5, w: 0.75, l: 5.5, h: 2.1 * P.rampe, n: 8, tri: [], coins: [] };
{
  const { w, l, h, n, tri, coins } = RAMPE, y = i => h * (i / n) ** 2, z = i => l * i / n;
  for (let i = 0; i < n; i++) {
    const a = [-w, 0, z(i)], b = [w, 0, z(i)], A = [-w, y(i), z(i)], B = [w, y(i), z(i)];
    const a1 = [-w, 0, z(i + 1)], b1 = [w, 0, z(i + 1)], A1 = [-w, y(i + 1), z(i + 1)], B1 = [w, y(i + 1), z(i + 1)];
    tri.push(A, A1, B1, A, B1, B, a, a1, A1, a, A1, A, b, B1, b1, b, B, B1);
    coins.push(new Float32Array([a, b, A, B, a1, b1, A1, B1].flat()));     // un coin convexe par tronçon
    if (i === n - 1) tri.push(a1, b1, B1, a1, B1, A1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flat(), 3));
  g.computeVertexNormals();
  const m = ombre(new THREE.Mesh(g, lambert({ color: 0xf7c87a, side: THREE.DoubleSide })));
  m.position.set(RAMPE.x, 0, RAMPE.z); scene.add(m);
}

// ---------- objets mobiles (maillages instanciés, créés une fois ; les corps sont refaits à chaque départ) ----------
const nbObjets = plan.objets.length, nbCaisses = plan.objets.filter(o => o.t === 'caisse').length;
const CAPACITE = nbObjets + nbCaisses * 7;                // objets + morceaux en plus
const pose = new Float32Array(CAPACITE * 7), sale = new Uint8Array(CAPACITE), eveil = new Uint8Array(CAPACITE), deplace = new Uint8Array(nbObjets);
const vitc = new Float32Array(CAPACITE * 2), connu = new Uint8Array(CAPACITE);     // vitesse au sol de chaque corps éveillé (pour la foule)
const maillages = {};
for (const t of NOMS) {
  const n = plan.objets.filter(o => o.t === t).length;
  maillages[t] = ombre(new THREE.InstancedMesh(TYPES[t].geo, TYPES[t].mat || lambert({ vertexColors: true }), n));
  maillages[t].frustumCulled = false; scene.add(maillages[t]);
}
const meshPlanches = ombre(new THREE.InstancedMesh(boite(1, 1, 1), lambert({ color: 0xe2b47c }), nbCaisses * 8));
meshPlanches.frustumCulled = false; scene.add(meshPlanches);
{
  const rang = {};
  plan.objets.forEach(o => { o.rang = rang[o.t] = (rang[o.t] ?? -1) + 1; maillages[o.t].setColorAt(o.rang, C3.set(o.teinte)); });
}
const meshJoueur = ombre(new THREE.Mesh(geoJoueur, lambert({ vertexColors: true })));
scene.add(meshJoueur);
const meshAutos = ombre(new THREE.InstancedMesh(geoAuto, lambert({ vertexColors: true }), circulation.length));
circulation.forEach((a, i) => meshAutos.setColorAt(i, C3.set(a.couleur)));
meshAutos.frustumCulled = false; scene.add(meshAutos);
// la foule : trois maillages instanciés créés à la capacité maximale (corps, paire de bras, « ! » en 3D), .count réglé
const PNJ_MAX = 600;
const bras = x => [new THREE.CapsuleGeometry(0.075, 0.55, 3, 8), 0xdcdcdc, x, 0.3, 0, 0, 0, x < 0 ? 0.55 : -0.55];      // en V, pivot à l'épaule
const meshPnj = ombre(new THREE.InstancedMesh(
  fusion([[new THREE.CapsuleGeometry(0.28, 0.8, 4, 12), 0xdcdcdc], [new THREE.SphereGeometry(0.22, 16, 12), 0xffffff, 0, 0.84, 0]]), lambert({ vertexColors: true }), PNJ_MAX));
const meshBras = ombre(new THREE.InstancedMesh(fusion([bras(-0.48), bras(0.48)]), lambert({ vertexColors: true }), PNJ_MAX));
const meshMarques = new THREE.InstancedMesh(fusion([[cyl(0.16, 0.085, 0.66), 0xffffff, 0, 0.71, 0], [new THREE.SphereGeometry(0.14, 12, 8), 0xffffff, 0, 0.14, 0]]),
  new THREE.MeshBasicMaterial({ color: 0xff3b1f }), PNJ_MAX);
for (let i = 0; i < PNJ_MAX; i++) { meshPnj.setColorAt(i, C3.set(foule[i] ? foule[i].couleur : 0xffffff)); meshBras.setColorAt(i, C3); }
for (const m of [meshPnj, meshBras, meshMarques]) { m.count = m === meshMarques ? 0 : foule.length; m.frustumCulled = false; scene.add(m); }
let nBras = 0;      // paires de bras levés dessinées à la dernière image

// ---------- entrées ----------
const clavier = new Set();
let bande = [], touchesBande = [];
addEventListener('keydown', e => { if (e.code === 'KeyR' && !e.repeat) depart(); clavier.add(e.code); if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); });
addEventListener('keyup', e => clavier.delete(e.code));
addEventListener('blur', () => clavier.clear());
const appui = (...codes) => codes.some(c => clavier.has(c) || touchesBande.includes(c)) ? 1 : 0;

// ---------- le monde physique ----------
let monde, files, joueur, vehicule, mobiles, planches, autos, pietons, alea, enAttente;
let sousPasFaits = 0, rendus = 0, morceaux = 0, casses = 0, contactsPietons = 0, braquage = 0;
let colCaisses, colAutos, colLourds;
const cam = { cible: new THREE.Vector3(), cap: 0 };
const tq = { x: 0, y: 0, z: 0, w: 1 }, tv = { x: 0, y: 0, z: 0 };
const quatCap = cap => ({ x: 0, y: sin(cap / 2), z: 0, w: cos(cap / 2) });

function depart() {
  if (monde) monde.free();
  monde = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  monde.timestep = DT;
  files = new RAPIER.EventQueue(true);
  alea = generateur(P.seed + 1000);
  sousPasFaits = morceaux = casses = contactsPietons = braquage = 0;
  colCaisses = new Map(); colAutos = new Map(); colLourds = new Set();
  deplace.fill(0); connu.fill(0);
  // sol, immeubles, rampe
  monde.createCollider(RAPIER.ColliderDesc.cuboid(700, 1, 700).setTranslation(0, -1, 0).setFriction(0.9));
  for (const b of plan.batiments) monde.createCollider(RAPIER.ColliderDesc.cuboid(b.sx / 2, b.h / 2, b.sz / 2).setTranslation(b.x, b.h / 2, b.z));
  // la rampe ne porte que les roues (rayons) : la coque du joueur l'ignore, sinon elle bute sur les arêtes entre tronçons
  for (const c of RAMPE.coins) monde.createCollider(RAPIER.ColliderDesc.convexHull(c).setTranslation(RAMPE.x, 0, RAMPE.z).setFriction(0.3).setCollisionGroups(0x0002ffff));
  // objets cassables : posés dans le monde physique à l'approche de la voiture seulement (Rapier paie chaque corps,
  // même endormi, à chaque pas). ponytail: un objet à plus de PORTEE m de la voiture n'existe pas encore pour les
  // autres corps ; suivre aussi les épaves et les débris si un jour ils voyagent aussi loin.
  mobiles = plan.objets.map(o => ({ corps: null, mesh: maillages[o.t], rang: o.rang, ech: null, f: FORMES[o.t] }));
  plan.objets.forEach((o, i) => { const q = quatCap(o.cap); pose.set([o.x, o.y, o.z, q.x, q.y, q.z, q.w], i * 7); });
  sale.fill(1, 0, nbObjets); eveil.fill(0);
  enAttente = plan.objets.map((_, i) => i); planches = [];
  apparaitre(SC.x, SC.z);
  // Rapier réveille tout corps dont un collider vient d'être posé : un pas à blanc, puis tout le monde dort
  // (sans cela, les piles restent actives 2 s et les premières images sont lentes)
  monde.step();
  for (const m of mobiles) if (m.corps) m.corps.sleep();
  meshPlanches.count = 0;
  // la voiture du joueur
  const d = [sin(SC.cap), cos(SC.cap)];
  joueur = monde.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(SC.x, 0.72, SC.z).setRotation(quatCap(SC.cap))
    .setLinvel(d[0] * SC.v, 0, d[1] * SC.v).setCanSleep(false));     // pas de CCD : à 240 pas/s la voiture avance de 11 cm par pas au plus
  const coque = new Float32Array(PROFIL.flatMap(([z, y]) => [-1, y, z, 1, y, z]));
  colLourds.add(monde.createCollider(RAPIER.ColliderDesc.convexHull(coque).setDensity(0).setFriction(0.15).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0.15).setCollisionGroups(0x0001fffd), joueur).handle);
  joueur.setAdditionalMassProperties(600, { x: 0, y: -0.15, z: 0 }, { x: 900, y: 1050, z: 160 }, { x: 0, y: 0, z: 0, w: 1 }, true);
  vehicule = monde.createVehicleController(joueur);
  vehicule.indexUpAxis = 1; vehicule.setIndexForwardAxis = 2;
  [[0.88, 1.35], [-0.88, 1.35], [0.88, -1.35], [-0.88, -1.35]].forEach(([x, z], i) => {
    vehicule.addWheel({ x, y: -0.1, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.35, 0.35);
    vehicule.setWheelSuspensionStiffness(i, 70); vehicule.setWheelSuspensionCompression(i, 6); vehicule.setWheelSuspensionRelaxation(i, 7);
    vehicule.setWheelMaxSuspensionForce(i, 60000); vehicule.setWheelFrictionSlip(i, 2.2); vehicule.setWheelSideFrictionStiffness(i, z > 0 ? 1 : 0.9);
  });
  // circulation (cinématique jusqu'au premier choc avec une voiture)
  autos = circulation.map((a, i) => {
    const p = boucle(a.b, a.s);
    const corps = monde.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.5, p.z).setRotation(quatCap(p.cap)));
    TYPES.voiture_garee.cols().forEach((c, k) => colAutos.set(monde.createCollider(c.setMass(k ? 1 : 450).setFriction(0.6).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), corps).handle, i));
    return { ...a, corps, libre: false, rect: { x: p.x, z: p.z, ux: sin(p.cap), uz: cos(p.cap), L: 2.1, l: 1 }, vx: 8 * sin(p.cap), vz: 8 * cos(p.cap) };
  });
  // la foule : aucun corps Rapier, des positions tenues par le code (voir « la foule »)
  pietons = foule.map((f, i) => {
    const p = { ...f, etat: f.type, x0: f.x, z0: f.z, capVise: 0, phase: f.type === 'attend' ? 0 : i * 1.7, haut: 0, tMarque: 0,
      expo: -1, futur: 0, niveau: 0, tEtat: 0, fin: 0, reste: 0, immun: 0, fx: 0, fz: 0, mur: 0, mx: 0, mz: 0, tg: 0, pret: true, touche: false,
      jx0: 0, jz0: 0, jx1: 0, jz1: 0, jt: 0, jd: 0.3 };
    if (f.type === 'marche') { const c = boucle(f.b, f.s); p.x = c.x; p.z = c.z; p.cap = c.cap + (f.sens < 0 ? PI : 0); }
    else if (f.type === 'traverse') { p.x = f.ax + (f.bx - f.ax) * f.t; p.z = f.az + (f.bz - f.az) * f.t; p.cap = Math.atan2(f.bx - f.ax, f.bz - f.az) + (f.sens < 0 ? PI : 0); }
    p.capVise = p.cap;
    return p;
  });
  V.ux = V.dx = sin(SC.cap); V.uz = V.dz = cos(SC.cap); lireVoiture();
  cam.cible.set(SC.x, 0.72, SC.z); cam.cap = SC.cap;
  relever(false); viser();
  if (jeu.pret) dessiner();
}

function poser(i) {
  const o = plan.objets[i], T = TYPES[o.t];
  const corps = monde.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(o.x, o.y, o.z).setRotation(quatCap(o.cap)));
  T.cols().forEach((c, k) => {
    const col = monde.createCollider(c.setMass(k ? 1 : T.m).setFriction(0.6), corps);
    if (o.t === 'caisse') { col.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS); col.setContactForceEventThreshold(SEUIL_CASSE * P.seuil); colCaisses.set(col.handle, i); }
    if (o.t === 'voiture_garee') colLourds.add(col.handle);
  });
  mobiles[i].corps = corps;
}
const PORTEE = 45;
function apparaitre(x, z) {
  enAttente = enAttente.filter(i => { const o = plan.objets[i]; if (hypot(o.x - x, o.z - z) > PORTEE) return true; poser(i); return false; });
}

// lit les corps éveillés (ou tous) dans `pose`, tient le compteur de casse
function relever(tous) {
  for (let i = 0; i < mobiles.length; i++) {
    const c = mobiles[i].corps;
    if (!c || !(eveil[i] = tous || !c.isSleeping() ? 1 : 0)) continue;
    c.translation(tv); c.rotation(tq);
    if (connu[i]) { vitc[i * 2] = (tv.x - pose[i * 7]) / DT; vitc[i * 2 + 1] = (tv.z - pose[i * 7 + 2]) / DT; } else { vitc[i * 2] = vitc[i * 2 + 1] = 0; connu[i] = 1; }
    pose.set([tv.x, tv.y, tv.z, tq.x, tq.y, tq.z, tq.w], i * 7); sale[i] = 1;
    if (i < nbObjets) {
      const o = plan.objets[i], d = hypot(tv.x - o.x, tv.y - o.y, tv.z - o.z) > 1 ? 1 : 0;
      casses += d - deplace[i]; deplace[i] = d;
    }
  }
}

// une caisse heurtée fort devient 4 à 8 planches ; l'objet d'origine suit la première
function briser(i) {
  const m = mobiles[i], c = m.corps, n = 4 + Math.floor(alea() * 5), axe = Math.floor(alea() * 3), e = 0.9 / n;
  const p = c.translation(), q = c.rotation(), lv = c.linvel(), av = c.angvel();
  Q4.set(q.x, q.y, q.z, q.w);
  monde.removeRigidBody(c);
  maillages.caisse.setMatrixAt(m.rang, M4.makeScale(0, 0, 0)); maillages.caisse.instanceMatrix.needsUpdate = true;
  for (let k = 0; k < n; k++) {
    const demi = [0.45, 0.45, 0.45]; demi[axe] = e / 2;
    V3.set(0, 0, 0).setComponent(axe, (k + 0.5) * e - 0.45).applyQuaternion(Q4);
    const ecart = (k + 0.5) / n - 0.5;
    const corps = monde.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x + V3.x, p.y + V3.y, p.z + V3.z).setRotation(q)
      .setLinvel(lv.x + av.y * V3.z - av.z * V3.y + V3.x * 3 + (alea() - 0.5), lv.y + av.z * V3.x - av.x * V3.z + V3.y * 3 + alea() * 1.5, lv.z + av.x * V3.y - av.y * V3.x + V3.z * 3 + (alea() - 0.5))
      .setAngvel({ x: av.x + ecart * 6 * (alea() - 0.5), y: av.y + ecart * 6 * (alea() - 0.5), z: av.z + ecart * 6 * (alea() - 0.5) }));
    monde.createCollider(RAPIER.ColliderDesc.cuboid(...demi).setMass(8 / n).setFriction(0.6), corps);
    const morceau = { corps, mesh: meshPlanches, rang: planches.length, ech: demi.map(v => 2 * v), f: FORMES.planche };
    planches.push(morceau);
    if (k === 0) { mobiles[i] = morceau; connu[i] = 0; } else mobiles.push(morceau);
  }
  meshPlanches.count = planches.length;
  morceaux += n;
}

function conduire() {
  const v = vehicule.currentVehicleSpeed(), av = appui('KeyW', 'ArrowUp'), ar = appui('KeyS', 'ArrowDown');
  let force = 0, frein = 0.4;
  if (av) { force = 6600 * P.moteur * Math.max(0, 1 - v / 34); frein = 0; }
  else if (ar) { if (v > 1) frein = 9; else { force = -4200 * P.moteur * Math.max(0, 1 + v / 12); frein = 0; } }
  const vise = (appui('KeyA', 'ArrowLeft') - appui('KeyD', 'ArrowRight')) * 0.55 / (1 + Math.abs(v) / 9);
  braquage += (vise - braquage) * 0.05;
  const main = appui('Space');
  // Rapier 0.21 : sans force moteur, une voiture à vitesse exactement nulle sort de updateVehicle avec des NaN.
  // À l'arrêt, une force infime évite cette branche (le frein ne sert à rien à l'arrêt).
  if (!force && Math.abs(v) < 0.05) force = 1e-3;
  for (let i = 0; i < 4; i++) {
    vehicule.setWheelEngineForce(i, force / 4);
    vehicule.setWheelBrake(i, i >= 2 && main ? 14 : frein);
    if (i < 2) vehicule.setWheelSteering(i, braquage);
  }
  vehicule.updateVehicle(DT, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
}

function circuler() {
  for (const a of autos) if (!a.libre) {
    a.s += 8 * DT;
    const p = boucle(a.b, a.s), r = a.rect;
    r.x = p.x; r.z = p.z; r.ux = sin(p.cap); r.uz = cos(p.cap); a.vx = 8 * r.ux; a.vz = 8 * r.uz;
    a.corps.setNextKinematicTranslation({ x: p.x, y: 0.5, z: p.z });
    a.corps.setNextKinematicRotation(quatCap(p.cap));
  }
}

// ---------- la foule ----------
// Aucun PNJ n'a de corps Rapier : tout se joue ici, à chaque sous-pas, après le pas de physique.
// calme (marche, attend, traverse) -> alerte (« ! ») -> fuite (course, bras levés) -> alerte -> calme ; saut : le filet de sécurité.
const RP = 0.28 * P.pnjTaille, VF = 6.5 * P.pnjVitesse;      // rayon de contact d'un PNJ, vitesse de fuite
const D_ABS = 2.15, D_SAUT = 2.3, D_CIBLE = 2.6;             // m de la coque : jamais plus près, saut en dessous, arrivée du saut
const NIVEAU = 12;                                           // la panique se transmet au plus NIVEAU fois de suite
const REAGI = { alerte: 1, fuite: 1, saut: 1 };
const norme = (x, z) => Math.sqrt(x * x + z * z);      // Math.hypot est bien plus lent, et la foule l'appelle des milliers de fois par image
const V = { x: 0, z: 0, ux: 0, uz: 1, L: 2.1, l: 1, vx: 0, vz: 0, vit: 0, dx: 0, dz: 1 };      // la coque du joueur au sol, sa vitesse
const RECT = { x: 0, z: 0, ux: 0, uz: 1, L: 0, l: 0 };
// obstacles du sous-pas : x, z, rayon, vx, vz, éveillé, L, l, ux, uz (rectangle si L > 0), y
const OB = new Float32Array(CAPACITE * 11), RAPIDES = new Int32Array(CAPACITE), PROCHES = new Int32Array(CAPACITE), BB = [0, 0, 0, 0];
const SX = new Float32Array(PNJ_MAX), SZ = new Float32Array(PNJ_MAX), SN = new Float32Array(PNJ_MAX);      // sources de contagion
let nOb = 0, nRap = 0, nPro = 0, nS = 0, NX = 0, NZ = 0, PX = 0, PZ = 0, FX = 0, FZ = 0;

function lireVoiture() {
  const p = joueur.translation(), v = joueur.linvel(), q = joueur.rotation();
  V3.set(0, 0, 1).applyQuaternion(Q4.set(q.x, q.y, q.z, q.w));
  const h = norme(V3.x, V3.z);
  if (h > 0.3) { V.ux = V3.x / h; V.uz = V3.z / h; }      // voiture à la verticale : on garde le dernier cap
  V.x = p.x; V.z = p.z; V.vx = v.x; V.vz = v.z; V.vit = norme(v.x, v.z);
  if (V.vit > 1e-3) { V.dx = v.x / V.vit; V.dz = v.z / V.vit; }
}
// distance d'un point au rectangle orienté r (négative dedans) ; normale sortante dans NX, NZ
function dRect(px, pz, r) {
  const dx = px - r.x, dz = pz - r.z, a = dx * r.ux + dz * r.uz, b = dx * r.uz - dz * r.ux;      // le long, de côté
  const ea = Math.abs(a) - r.L, eb = Math.abs(b) - r.l, sa = a < 0 ? -1 : 1, sb = b < 0 ? -1 : 1;
  let na = 0, nb = 0, d;
  if (ea > 0 || eb > 0) { na = Math.max(ea, 0); nb = Math.max(eb, 0); d = norme(na, nb); na *= sa / d; nb *= sb / d; }
  else if (ea > eb) { d = ea; na = sa; } else { d = eb; nb = sb; }
  NX = na * r.ux + nb * r.uz; NZ = na * r.uz - nb * r.ux;
  return d;
}
// distance à la coque d'ici T secondes, si la voiture garde sa vitesse (T = 0 : maintenant)
function dZone(px, pz, T) {
  const loin = norme(px - V.x, pz - V.z) - 2.4 - V.vit * T;
  if (loin > 4 || T <= 0) return loin > 4 ? loin : dRect(px, pz, V);
  const n = Math.max(1, Math.ceil(V.vit * T / 1.5));
  let d = Infinity;
  for (let k = 0; k <= n; k++) { const t = T * k / n; d = Math.min(d, dRect(px - V.vx * t, pz - V.vz * t, V)); }
  return d;
}
function dObst(x, z, k) {      // distance au bord de l'obstacle k ; normale sortante dans NX, NZ
  const o = k * 11;
  if (OB[o + 6] > 0) { RECT.x = OB[o]; RECT.z = OB[o + 1]; RECT.L = OB[o + 6]; RECT.l = OB[o + 7]; RECT.ux = OB[o + 8]; RECT.uz = OB[o + 9]; return dRect(x, z, RECT); }
  const dx = x - OB[o], dz = z - OB[o + 1], d = norme(dx, dz);
  if (d > 1e-6) { NX = dx / d; NZ = dz / d; } else { NX = 1; NZ = 0; }
  return d - OB[o + 2];
}
const ecart = k => OB[k * 11 + 6] > 0 ? RP + 0.1 : Math.max(RP + 0.05, 0.75 - OB[k * 11 + 2]);      // place à garder autour de l'obstacle k
// les immeubles : pour un PNJ, tout le cœur d'un bloc (28 x 28 m) est plein. 0 : loin, 1 : contre le mur, 2 : il a fallu le sortir
const centre = v => Math.max(-2, Math.min(2, Math.round(v / PAS))) * PAS;
function murs(p) {
  const cx = centre(p.x), cz = centre(p.z), lx = p.x - cx, lz = p.z - cz, ax = Math.abs(lx), az = Math.abs(lz), m = DEMI_BATI + RP + 0.07;
  if (ax >= m + 0.03 || az >= m + 0.03) return 0;
  const dedans = ax < m && az < m;
  if (ax > az) { p.mx = lx < 0 ? -1 : 1; p.mz = 0; if (dedans) p.x = cx + p.mx * m; }
  else { p.mx = 0; p.mz = lz < 0 ? -1 : 1; if (dedans) p.z = cz + p.mz * m; }
  return dedans ? 2 : 1;
}
// le point (x, z) est-il libre : hors immeubles, à dC m au moins de la coque d'ici T s, hors voitures et objets
function estLibre(x, z, dC, T) {
  const m = DEMI_BATI + RP + 0.069;
  if (Math.abs(x - centre(x)) < m && Math.abs(z - centre(z)) < m) return false;
  if (dZone(x, z, T) < dC) return false;
  for (const a of autos) if (Math.abs(x - a.rect.x) < 4 && Math.abs(z - a.rect.z) < 4 && dRect(x, z, a.rect) < RP + 0.29) return false;
  for (let k = 0; k < nOb; k++) { const o = k * 11, R = OB[o + 2] + 1.2; if (Math.abs(x - OB[o]) < R && Math.abs(z - OB[o + 1]) < R && dObst(x, z, k) < ecart(k) - 0.01) return false; }
  return true;
}
// le point libre le plus proche de (x, z), dans PX, PZ : des cercles de plus en plus grands, 16 directions, le plus loin de la coque
function pointLibre(x, z, dC, T) {
  for (let r = 0.4; r <= 16; r += 0.4) {
    let score = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = k * PI / 8, cx = x + r * sin(a), cz = z + r * cos(a);
      if (!estLibre(cx, cz, dC, T)) continue;
      const sc = dZone(cx, cz, T);
      if (sc > score) { score = sc; PX = cx; PZ = cz; }
    }
    if (score > -Infinity) return true;
  }
  return false;
}
// direction de fuite [x, z] devant un corps qui vient sur le PNJ, ou null (v1)
function esquive(p, bx, bz, vx, vz, proche, large, duree) {
  const dx = p.x - bx, dz = p.z - bz, d = norme(dx, dz), vit = norme(vx, vz);
  if (d < proche) return [dx / (d || 1), dz / (d || 1)];
  if (vit < 1.5) return null;
  const ux = vx / vit, uz = vz / vit, devant = dx * ux + dz * uz, cote = dx * uz - dz * ux;
  if (devant < 0 || devant > proche + vit * duree || Math.abs(cote) > large) return null;
  const s = cote >= 0 ? 1 : -1;
  return [s * uz, -s * ux];
}
// un pas vers (ux, uz) ; contre un mur, le PNJ le longe (du côté qui l'éloigne de la voiture s'il arrive droit dessus)
function avancer(p, ux, uz, pas) {
  const n = p.mur ? ux * p.mx + uz * p.mz : 0;
  if (n < 0) {
    let tx = ux - n * p.mx, tz = uz - n * p.mz, t = norme(tx, tz);
    if (t < 0.3) { if (!p.tg) p.tg = -p.mz * (p.x - V.x) + p.mx * (p.z - V.z) >= 0 ? 1 : -1; tx = -p.mz * p.tg; tz = p.mx * p.tg; t = 1; }
    ux = tx / t; uz = tz / t;
  } else p.tg = 0;
  p.x += ux * pas; p.z += uz * pas;
  p.capVise = Math.atan2(ux, uz);
}
// la vie calme : suivre sa boucle de trottoir, traverser et revenir, ou rester à sa place (et y retourner après une fuite)
function flaner(p) {
  let cx = p.x0, cz = p.z0;
  if (p.type === 'marche') { if (p.pret) p.s += p.sens * p.vit * DT; const c = boucle(p.b, p.s); cx = c.x; cz = c.z; }
  else if (p.type === 'traverse') {
    if (p.pret) { p.t += p.sens * p.vit * DT / p.len; if (p.t >= 1) { p.t = 1; p.sens = -1; } else if (p.t <= 0) { p.t = 0; p.sens = 1; } }
    cx = p.ax + (p.bx - p.ax) * p.t; cz = p.az + (p.bz - p.az) * p.t;
  }
  const ex = cx - p.x, ez = cz - p.z, e = norme(ex, ez), immobile = p.type === 'attend' && e < 0.05;
  p.pret = e < 1.5;      // le but attend un PNJ retardé
  if (!immobile && e > 1e-9) { avancer(p, ex / e, ez / e, Math.min(e, (e > 0.5 ? 2.6 : p.vit * 1.1) * DT)); p.phase += 13.2 * DT; }
  p.etat = p.type !== 'attend' ? p.type : e > 0.3 ? 'marche' : 'attend';
}
// les obstacles assez près du PNJ pour le gêner d'ici 0,6 m de déplacement, dans PROCHES
function voisins(p, pres) {
  nPro = 0;
  if (pres) for (let k = 0; k < nOb; k++) { const o = k * 11, R = OB[o + 2] + RP + 1.2; if (Math.abs(p.x - OB[o]) < R && Math.abs(p.z - OB[o + 1]) < R) PROCHES[nPro++] = k; }
}
// après le mouvement : hors des objets, des voitures, de la coque (D_ABS) et des murs ; puis le compte des contacts
function contraindre(p, pres) {
  let conflit = false;
  for (let essai = 0; essai < 3; essai++) {
    const x0 = p.x, z0 = p.z;
    voisins(p, pres);
    for (let t = 0; t < 2; t++) {
      let pousse = false;
      for (let i = 0; i < nPro; i++) { const k = PROCHES[i], d = dObst(p.x, p.z, k), e = ecart(k); if (d < e) { p.x += NX * (e - d); p.z += NZ * (e - d); pousse = true; } }
      for (const a of autos) {
        const r = a.rect;
        if (Math.abs(p.x - r.x) > 4 || Math.abs(p.z - r.z) > 4) continue;
        const d = dRect(p.x, p.z, r);
        if (d < RP + 0.3) { p.x += NX * (RP + 0.3 - d); p.z += NZ * (RP + 0.3 - d); pousse = true; }
      }
      if (pres) { const d = dRect(p.x, p.z, V); if (d < D_ABS) { p.x += NX * (D_ABS - d); p.z += NZ * (D_ABS - d); pousse = true; } }
      p.mur = murs(p);
      conflit = t === 1 && (pousse || p.mur === 2);
    }
    if (Math.abs(p.x - x0) + Math.abs(p.z - z0) < 0.6) break;      // poussé plus loin (la coque l'a sorti de son chemin) : d'autres obstacles sont à voir
    conflit = true;
  }
  // coincé entre deux obstacles : le point libre le plus proche
  if (conflit) {
    if (!estLibre(p.x, p.z, D_ABS - 0.02, 0) && pointLibre(p.x, p.z, D_ABS, 0)) { p.x = PX; p.z = PZ; p.mur = murs(p); }
    voisins(p, pres);
  }
  let c = false;
  if (pres) {
    c = dRect(p.x, p.z, V) < RP;
    for (let i = 0; i < nPro && !c; i++) { const k = PROCHES[i]; c = OB[k * 11 + 5] > 0 && dObst(p.x, p.z, k) < RP; }
  }
  for (const a of autos) if (!c && Math.abs(p.x - a.rect.x) < 4 && Math.abs(p.z - a.rect.z) < 4) c = dRect(p.x, p.z, a.rect) < RP;
  if (c && !p.touche) contactsPietons++;
  p.touche = c;
}
function pnjPas(p) {
  const dxv = p.x - V.x, dzv = p.z - V.z, reagi = REAGI[p.etat] === 1;
  const pres = (Math.abs(dxv) < 75 && Math.abs(dzv) < 75) || (p.x > BB[0] && p.x < BB[1] && p.z > BB[2] && p.z < BB[3]);
  if (p.immun > 0) p.immun -= DT;
  if (reagi) p.tMarque += DT; else p.tMarque = 0;
  // 1. le danger. 1 : la voiture du joueur vient sur lui (couloir devant elle, large de sa marge) ; 2 : une voiture de circulation ou un objet rapide
  let menace = 0;
  if (pres && V.vit > 1.5) {
    const devant = dxv * V.dx + dzv * V.dz, cote = dxv * V.dz - dzv * V.dx, ac = Math.abs(cote);
    // déjà en alerte, il part au dernier moment sûr : ceux de l'axe d'abord, ceux des bords ensuite (la foule s'ouvre en coin devant le capot)
    if (devant > -3 && devant < 3.6 + V.vit * (reagi ? 0.45 + p.avance + 1.15 * (p.marge - ac) / VF : 1.4) && ac < p.marge) {
      menace = 1;
      // fuite en éventail : de côté, plus une part radiale propre au PNJ, réduite quand le temps manque pour sortir du couloir
      const s = cote > 0 ? 1 : cote < 0 ? -1 : p.cote, d = norme(dxv, dzv) || 1;
      const f = Math.min(1, (p.marge - ac) / (Math.max(0.05, (devant - 2.1) / V.vit * 0.8) * VF)), w = Math.min(p.radial, Math.sqrt(1 - f * f) / Math.max(f, 1e-3));
      FX = s * V.dz + w * dxv / d; FZ = -s * V.dx + w * dzv / d;
    }
  }
  if (!menace) {
    let f = null;
    for (let i = 0; i < autos.length && !f; i++) {
      const a = autos[i], r = a.rect;
      if (Math.abs(p.x - r.x) < 20 && Math.abs(p.z - r.z) < 20 && norme(a.vx, a.vz) > 1.5) f = esquive(p, r.x, r.z, a.vx, a.vz, 2.8, 2.2, 1.2);
    }
    if (pres) for (let i = 0; i < nRap && !f; i++) {
      const o = RAPIDES[i] * 11;
      if (Math.abs(p.x - OB[o]) < 25 && Math.abs(p.z - OB[o + 1]) < 25) f = esquive(p, OB[o], OB[o + 1], OB[o + 3], OB[o + 4], OB[o + 2] + 1.2, OB[o + 2] + 1.5, 1);
    }
    if (f) { menace = 2; FX = f[0]; FZ = f[1]; }
  }
  // 2. l'état
  const T = p.mur && reagi ? 0.8 : 0.35;      // coincé contre un mur : il saute plus tôt
  if (p.etat === 'saut') {
    p.jt += DT / p.jd;
    const t = Math.min(1, p.jt), e = 1 - (1 - t) * (1 - t);
    p.x = p.jx0 + (p.jx1 - p.jx0) * e; p.z = p.jz0 + (p.jz1 - p.jz0) * e; p.haut = 3.2 * t * (1 - t) * P.pnjTaille; p.phase += 30 * DT;
    if (t >= 1) { p.etat = 'fuite'; p.haut = 0; p.reste = 1.5; }
  } else if (pres && V.vit > 1.5 && dZone(p.x, p.z, T) < D_SAUT && pointLibre(p.x, p.z, D_CIBLE, T + 0.5)) {
    // le filet : la coque sera à moins de D_SAUT m dans T s, il saute vers le point libre le plus proche
    const d = norme(PX - p.x, PZ - p.z) || 1;
    p.etat = 'saut'; p.jx0 = p.x; p.jz0 = p.z; p.jx1 = PX; p.jz1 = PZ; p.jt = 0; p.jd = 0.3 + 0.02 * d;
    p.fx = (PX - p.x) / d; p.fz = (PZ - p.z) / d; p.capVise = Math.atan2(p.fx, p.fz); p.niveau = NIVEAU; p.expo = -1;
  } else if (!reagi) {
    if (menace === 2) { p.etat = 'fuite'; p.reste = 1.5; p.fx = FX; p.fz = FZ; p.niveau = 0; p.expo = -1; }
    else {
      if (p.expo < 0) {      // il voit la voiture, ou un voisin en alerte (contagion) : il réagira après son retard
        if (menace === 1) { p.expo = p.retard * P.retard; p.futur = NIVEAU; }
        else if (nS && p.immun <= 0) {
          let niv = 0;
          for (let k = 0; k < nS; k++) { const ex = SX[k] - p.x, ez = SZ[k] - p.z; if (ex * ex + ez * ez < P.contagion * P.contagion && SN[k] > niv) niv = SN[k]; }
          if (niv > 0) { p.expo = p.retard * P.retard; p.futur = niv - 1; }
        }
      }
      if (p.expo >= 0 && (p.expo -= DT) < 0) { p.expo = -1; p.etat = 'alerte'; p.tEtat = 0; p.fin = p.calme; p.niveau = p.futur; }
      else flaner(p);
    }
  } else if (p.etat === 'alerte') {
    p.tEtat += DT;
    if (menace) { p.etat = 'fuite'; p.reste = menace === 1 ? p.elan : 1.5; p.fx = FX; p.fz = FZ; if (menace === 1) p.niveau = NIVEAU; }
    else if (p.tEtat > p.fin) { p.etat = p.type === 'attend' ? 'marche' : p.type; p.immun = 5; p.niveau = 0; }
    else if (pres) p.capVise = Math.atan2(-dxv, -dzv);      // il regarde la voiture
  } else {      // fuite
    if (menace) { p.fx = FX; p.fz = FZ; if (menace === 1) p.niveau = NIVEAU; }
    const n = norme(p.fx, p.fz) || 1;
    avancer(p, p.fx / n, p.fz / n, VF * DT); p.reste -= VF * DT; p.phase += 30 * DT;
    if (!menace && p.reste <= 0) { p.etat = 'alerte'; p.tEtat = 0; p.fin = p.souffle; }
  }
  contraindre(p, pres);
  let e = p.capVise - p.cap; e -= 2 * PI * Math.round(e / (2 * PI)); p.cap += e * 0.05;
}
function animerFoule() {
  lireVoiture();
  for (const a of autos) if (a.libre) {
    const r = a.rect, p = a.corps.translation(), v = a.corps.linvel(), q = a.corps.rotation();
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y), h = norme(fx, fz);
    if (h > 0.3) { r.ux = fx / h; r.uz = fz / h; }
    r.x = p.x; r.z = p.z; a.vx = v.x; a.vz = v.z;
  }
  // obstacles : les objets posés près de la voiture, et tous ceux qui bougent, où qu'ils soient
  nOb = nRap = 0; BB[0] = BB[2] = Infinity; BB[1] = BB[3] = -Infinity;
  for (let i = 0; i < mobiles.length; i++) {
    const m = mobiles[i];
    if (!m.corps) continue;
    const k = i * 7, x = pose[k], y = pose[k + 1], z = pose[k + 2], ev = eveil[i];
    if (y > 3 || (!ev && (Math.abs(x - V.x) > 75 || Math.abs(z - V.z) > 75))) continue;
    const o = nOb * 11, vx = ev ? vitc[i * 2] : 0, vz = ev ? vitc[i * 2 + 1] : 0, v = norme(vx, vz), f = m.f;
    OB[o] = x; OB[o + 1] = z; OB[o + 2] = f.r; OB[o + 3] = vx; OB[o + 4] = vz; OB[o + 5] = ev; OB[o + 6] = 0; OB[o + 10] = y;
    if (f.L && v < 0.5) {      // banc ou voiture garée au repos : un rectangle
      const qx = pose[k + 3], qy = pose[k + 4], qz = pose[k + 5], qw = pose[k + 6];
      const ax = f.enX ? 1 - 2 * (qy * qy + qz * qz) : 2 * (qx * qz + qw * qy), az = f.enX ? 2 * (qx * qz - qw * qy) : 1 - 2 * (qx * qx + qy * qy), h = norme(ax, az);
      if (h > 0.5) { OB[o + 6] = f.L; OB[o + 7] = f.l; OB[o + 8] = ax / h; OB[o + 9] = az / h; }
    }
    if (ev) {
      BB[0] = Math.min(BB[0], x - 6); BB[1] = Math.max(BB[1], x + 6); BB[2] = Math.min(BB[2], z - 6); BB[3] = Math.max(BB[3], z + 6);
      if (v > 3) RAPIDES[nRap++] = nOb;
    }
    nOb++;
  }
  nS = 0;
  if (P.contagion > 0) for (const p of pietons) if (p.niveau > 0 && REAGI[p.etat]) { SX[nS] = p.x; SZ[nS] = p.z; SN[nS++] = p.niveau; }
  for (const p of pietons) pnjPas(p);
}

function viser() {
  if (SC.survol) {
    const s = SC.survol, t = sousPasFaits * DT * s.vit;
    camera.position.set(s.de[0] + s.dir[0] * t, s.de[1] * P.camHaut, s.de[2] + s.dir[1] * t);
    cam.cible.set(camera.position.x + s.dir[0] * s.loin, 0, camera.position.z + s.dir[1] * s.loin);
    camera.lookAt(cam.cible);
    return;
  }
  joueur.translation(tv);
  cam.cible.x += (tv.x - cam.cible.x) * 0.25; cam.cible.z += (tv.z - cam.cible.z) * 0.25; cam.cible.y += (tv.y - cam.cible.y) * 0.03;
  if (SC.suivre) {
    joueur.rotation(tq); V3.set(0, 0, 1).applyQuaternion(Q4.set(tq.x, tq.y, tq.z, tq.w));
    if (hypot(V3.x, V3.z) > 0.3) { let e = Math.atan2(V3.x, V3.z) - cam.cap; e -= 2 * PI * Math.round(e / (2 * PI)); cam.cap += e * 0.015; }
  }
  const [dist, haut, az, avance = 0] = P.portrait ? SC.cam916 : SC.cam, a = cam.cap + az;
  camera.position.set(cam.cible.x - sin(a) * dist * P.camDist, cam.cible.y + haut * P.camHaut, cam.cible.z - cos(a) * dist * P.camDist);
  camera.lookAt(cam.cible.x + sin(cam.cap) * avance, cam.cible.y + 0.4, cam.cible.z + cos(cam.cap) * avance);     // on vise un peu devant : la voiture est sous le centre
}

function sousPas() {
  const image = sousPasFaits / 4;
  let k = 0; while (k + 1 < bande.length && bande[k + 1].image <= image) k++;
  touchesBande = bande.length && bande[k].image <= image ? bande[k].touches : [];
  conduire(); circuler();
  if (sousPasFaits % 4 === 0) { joueur.translation(tv); apparaitre(tv.x, tv.z); }
  monde.step(files);
  const aBriser = [];
  files.drainCollisionEvents((h1, h2, debut) => {
    if (!debut) return;
    for (const [a, b] of [[h1, h2], [h2, h1]]) if (colAutos.has(a) && colLourds.has(b)) {     // choc avec une voiture : elle devient un corps libre
      const auto = autos[colAutos.get(a)];
      if (auto.libre) continue;
      const p = boucle(auto.b, auto.s);
      auto.libre = true; auto.corps.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      auto.corps.setLinvel({ x: sin(p.cap) * 8, y: 0, z: cos(p.cap) * 8 }, true);
      for (const [h, j] of colAutos) if (autos[j] === auto) colLourds.add(h);
    }
  });
  files.drainContactForceEvents(e => { for (const h of [e.collider1(), e.collider2()]) if (colCaisses.has(h)) aBriser.push(h); });
  if (P.debris) for (const h of aBriser) if (colCaisses.has(h)) { briser(colCaisses.get(h)); colCaisses.delete(h); }
  sousPasFaits++;
  relever(false); animerFoule(); viser();
}

// ---------- affichage ----------
const compteur = P.hud ? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'compteur', textContent: '0' })) : null;
if (compteur) compteur.style.cssText = 'position:fixed;left:24px;top:18px;font:700 44px system-ui,sans-serif;color:#3b4252;background:#fffdf6cc;padding:4px 20px;border-radius:16px;pointer-events:none';

function dessiner() {
  for (let i = 0; i < mobiles.length; i++) if (sale[i]) {
    const m = mobiles[i], k = i * 7;
    m.mesh.setMatrixAt(m.rang, M4.compose(V3.fromArray(pose, k), Q4.fromArray(pose, k + 3), m.ech ? S3.fromArray(m.ech) : UN));
    m.mesh.instanceMatrix.needsUpdate = true; sale[i] = 0;
  }
  joueur.translation(tv); joueur.rotation(tq);
  meshJoueur.position.set(tv.x, tv.y, tv.z); meshJoueur.quaternion.set(tq.x, tq.y, tq.z, tq.w);
  autos.forEach((a, i) => { a.corps.translation(tv); a.corps.rotation(tq); meshAutos.setMatrixAt(i, M4.compose(V3.copy(tv), Q4.copy(tq), UN)); });
  meshAutos.instanceMatrix.needsUpdate = true;
  // la foule : corps penché et rebond plus fort en course, bras levés en fuite et en saut, « ! » au dessus des PNJ qui ont réagi
  const T = P.pnjTaille;
  let nM = 0; nBras = 0;
  for (let i = 0; i < pietons.length; i++) {
    const p = pietons[i], cours = p.etat === 'fuite' || p.etat === 'saut', y = (0.73 + Math.abs(sin(p.phase)) * (cours ? 0.16 : 0.07)) * T + p.haut;
    Q4.setFromEuler(E3.set(cours ? 0.3 : 0, p.cap, 0, 'YXZ'));
    meshPnj.setMatrixAt(i, M4.compose(V3.set(p.x, y, p.z), Q4, S3.setScalar(T)));
    V3.set(0, 0.36 * T, 0).applyQuaternion(Q4); V3.x += p.x; V3.y += y; V3.z += p.z;      // l'épaule
    Q4.setFromEuler(E3.set(cours ? 0.3 * sin(p.phase * 2) - 0.2 : PI - 0.5 * sin(p.phase), p.cap, 0, 'YXZ'));
    meshBras.setMatrixAt(i, M4.compose(V3, Q4, S3));
    if (cours) nBras++;
    if (cours || p.etat === 'alerte') { const e = P.marqueTaille * T * Math.min(1, 0.4 + p.tMarque * 6); meshMarques.setMatrixAt(nM++, M4.makeScale(e, e, e).setPosition(p.x, y + 1.25 * T, p.z)); }
  }
  meshMarques.count = nM;
  for (const m of [meshPnj, meshBras, meshMarques]) m.instanceMatrix.needsUpdate = true;
  soleil.target.position.copy(cam.cible);
  soleil.position.set(cam.cible.x + 60, cam.cible.y + 110, cam.cible.z + 35);
  if (compteur) compteur.textContent = String(casses);
  rendu.setRenderTarget(cible3d); rendu.render(scene, camera);
  rendu.setRenderTarget(null); rendu.render(scenePost, camPost);
}

// ---------- window.jeu ----------
const arr = v => Math.round(v * 1e4) / 1e4;
const dansRalenti = () => { const i = sousPasFaits / 4; return P.ralenti < 1 && i >= P.ralDe && i < P.ralA; };
const jeu = window.jeu = {
  pret: false,
  get image() { return sousPasFaits / 4; },
  pas(n = 1) {
    for (let i = 0; i < n; i++) {
      const k = dansRalenti() ? Math.round(4 * P.ralenti) : 4;
      for (let j = 0; j < k; j++) sousPas();
      dessiner(); rendus++;
    }
  },
  projeter([x, y, z]) {      // position à l'écran (fractions de l'image, y = 0 en haut), avec la caméra de la dernière image rendue
    const devant = V3.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z < 0;
    V3.applyMatrix4(camera.projectionMatrix);
    return [arr(V3.x / 2 + 0.5), arr(0.5 - V3.y / 2), devant];
  },
  etat() {
    const p = joueur.translation(), q = joueur.rotation(), v = joueur.linvel();
    // boîte du châssis projetée à l'écran
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    Q4.set(q.x, q.y, q.z, q.w); camera.updateMatrixWorld();
    for (const sx of [-1, 1]) for (const sy of [-0.5, 0.85]) for (const sz of [-2.1, 2.1]) {
      V3.set(sx, sy, sz).applyQuaternion(Q4).add(p).project(camera);
      x0 = Math.min(x0, V3.x); x1 = Math.max(x1, V3.x); y0 = Math.min(y0, V3.y); y1 = Math.max(y1, V3.y);
    }
    const types = {}; for (const t of NOMS) types[t] = 0; for (const o of plan.objets) types[o.t]++;
    const xyz = c => { const t = c.translation(); return [arr(t.x), arr(t.y), arr(t.z)]; };
    const pnj = { marche: 0, attend: 0, traverse: 0, alerte: 0, fuite: 0, saut: 0 };
    for (const g of pietons) pnj[g.etat]++;
    return {
      scene: P.scene, image: sousPasFaits / 4, rendus,
      voiture: { pos: [p.x, p.y, p.z].map(arr), quat: [q.x, q.y, q.z, q.w].map(arr), vitesse: arr(hypot(v.x, v.y, v.z)),
        ecran: { x: arr((x0 + x1) / 4 + 0.5), y: arr(0.5 - (y0 + y1) / 4), l: arr((x1 - x0) / 2), h: arr((y1 - y0) / 2) },
        coque: [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [arr(V.x + a * V.L * V.ux + b * V.l * V.uz), arr(V.z + a * V.L * V.uz - b * V.l * V.ux)]) },
      camera: { pos: camera.position.toArray().map(arr) },
      corps: plan.objets.map((_, i) => Array.from(pose.subarray(i * 7, i * 7 + 7), arr)),
      types, morceaux, casses,
      ville: { batiments: plan.batiments.length, etendue: [ETENDUE, ETENDUE],
        boites: plan.batiments.map(b => [b.x - b.sx / 2, b.z - b.sz / 2, b.x + b.sx / 2, b.z + b.sz / 2].map(arr)) },
      circulation: autos.map(a => xyz(a.corps)), pietons: pietons.map(g => [arr(g.x), 0, arr(g.z)]),
      pnj_etats: pietons.map(g => g.etat), pnj, pnj_rendu: { marques: meshMarques.count, bras_leves: nBras },
      contacts_pietons: contactsPietons,
    };
  },
};

if (P.bande) bande = await (await fetch(`./bandes/${P.bande}.json`)).json();
depart();
dessiner();
jeu.pret = true;

if (!P.capture) {      // jeu libre : accumulateur à pas fixe
  let avant = null, reste = 0;
  const tour = t => {
    requestAnimationFrame(tour);
    if (avant !== null) {
      reste += Math.min(0.1, (t - avant) / 1000) * (dansRalenti() ? P.ralenti : 1);
      while (reste >= DT) { sousPas(); reste -= DT; }
    }
    avant = t; dessiner();
  };
  requestAnimationFrame(tour);
}
