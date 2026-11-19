// Fracas : petite ville maquette, une voiture jouet, tout ce qu'elle touche part en vrai (Rapier).
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
const SCENES = {
  libre:        { x: 25, z: -36, cap: 0, v: 0, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0] },
  tonneau:      { x: 25, z: -16, cap: 0, v: 20, cam: [11, 7, 0.5, 2], cam916: [14, 15, 0.22, 3.5] },
  avenue:       { x: -110, z: -75, cap: PI / 2, v: 14, cam: [11, 6, 0.35, 2], cam916: [13, 13, 0.4, 3] },
  finale:       { x: 18, z: 25, cap: -PI / 2, v: 20, cam: [12, 7, -0.4, 2], cam916: [17, 18, -0.4, 4] },
  survol:       { x: 25, z: -36, cap: 0, v: 0, survol: { de: [-150, 78, 150], dir: [0.7071, -0.7071], vit: 13, loin: 85 } },
  essai_pieton: { x: 75, z: 32, cap: 0, v: 0, suivre: true, cam: [10, 5.5, 0], cam916: [13, 14, 0], pieton: [75, 57] },
};
if (!SCENES[P.scene]) P.scene = 'libre';
const SC = SCENES[P.scene];

// ---------- le plan de la ville (données pures, tirées de la graine) ----------
const PASTELS = [0xbfe8d4, 0xffd3b0, 0xbcdcf5, 0xfbeeb0, 0xf6d5d8];   // menthe, pêche, bleu ciel, beurre, rose poudré pâle
const plan = (() => {
  const R = generateur(P.seed), al = (a, b) => a + (b - a) * R(), choix = t => t[Math.floor(R() * t.length)];
  const batiments = [], objets = [], centres = [-2, -1, 0, 1, 2].map(i => i * PAS);
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
  const Q = b => 4 * (2 * b.h - 2 * b.r) + 2 * PI * b.r;
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
const M4 = new THREE.Matrix4(), V3 = new THREE.Vector3(), Q4 = new THREE.Quaternion(), S3 = new THREE.Vector3(1, 1, 1), C3 = new THREE.Color();
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
const meshAutos = ombre(new THREE.InstancedMesh(geoAuto, lambert({ vertexColors: true }), plan.circulation.length));
plan.circulation.forEach((a, i) => meshAutos.setColorAt(i, C3.set(a.couleur)));
meshAutos.frustumCulled = false; scene.add(meshAutos);
const nbPietons = plan.pietons.length + (SC.pieton ? 1 : 0);
const meshPietons = ombre(new THREE.InstancedMesh(
  fusion([[new THREE.CapsuleGeometry(0.28, 0.8, 4, 12), 0xdcdcdc], [new THREE.SphereGeometry(0.22, 16, 12), 0xffffff, 0, 0.84, 0]]), lambert({ vertexColors: true }), nbPietons));
for (let i = 0; i < nbPietons; i++) meshPietons.setColorAt(i, C3.set(plan.pietons[i]?.couleur ?? plan.couleurs[0]));
meshPietons.frustumCulled = false; scene.add(meshPietons);

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
let colCaisses, colPietons, colAutos, colLourds;
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
  colCaisses = new Map(); colPietons = new Set(); colAutos = new Map(); colLourds = new Set();
  deplace.fill(0);
  // sol, immeubles, rampe
  monde.createCollider(RAPIER.ColliderDesc.cuboid(700, 1, 700).setTranslation(0, -1, 0).setFriction(0.9));
  for (const b of plan.batiments) monde.createCollider(RAPIER.ColliderDesc.cuboid(b.sx / 2, b.h / 2, b.sz / 2).setTranslation(b.x, b.h / 2, b.z));
  // la rampe ne porte que les roues (rayons) : la coque du joueur l'ignore, sinon elle bute sur les arêtes entre tronçons
  for (const c of RAMPE.coins) monde.createCollider(RAPIER.ColliderDesc.convexHull(c).setTranslation(RAMPE.x, 0, RAMPE.z).setFriction(0.3).setCollisionGroups(0x0002ffff));
  // objets cassables : posés dans le monde physique à l'approche de la voiture seulement (Rapier paie chaque corps,
  // même endormi, à chaque pas). ponytail: un objet à plus de PORTEE m de la voiture n'existe pas encore pour les
  // autres corps ; suivre aussi les épaves et les débris si un jour ils voyagent aussi loin.
  mobiles = plan.objets.map(o => ({ corps: null, mesh: maillages[o.t], rang: o.rang, ech: null }));
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
  // circulation (cinématique jusqu'au premier choc avec une voiture) et piétons (capteurs)
  autos = plan.circulation.map((a, i) => {
    const p = boucle(a.b, a.s);
    const corps = monde.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.5, p.z).setRotation(quatCap(p.cap)));
    TYPES.voiture_garee.cols().forEach((c, k) => colAutos.set(monde.createCollider(c.setMass(k ? 1 : 450).setFriction(0.6).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), corps).handle, i));
    return { ...a, corps, libre: false };
  });
  const gens = plan.pietons.map(p => ({ ...p, ...boucle(p.b, p.s) }));
  if (SC.pieton) gens.push({ x: SC.pieton[0], z: SC.pieton[1], b: null });
  pietons = gens.map(p => {
    const corps = monde.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, 0.73, p.z));
    colPietons.add(monde.createCollider(RAPIER.ColliderDesc.capsule(0.4, 0.28).setSensor(true).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), corps).handle);
    return { ...p, corps, phase: 0 };
  });
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
    const morceau = { corps, mesh: meshPlanches, rang: planches.length, ech: demi.map(v => 2 * v) };
    planches.push(morceau);
    if (k === 0) mobiles[i] = morceau; else mobiles.push(morceau);
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
    const p = boucle(a.b, a.s);
    a.corps.setNextKinematicTranslation({ x: p.x, y: 0.5, z: p.z });
    a.corps.setNextKinematicRotation(quatCap(p.cap));
  }
}

// une fois par image : les piétons marchent, et s'écartent de la voiture et de tout corps rapide qui vient sur eux
function esquive(p, bx, bz, vx, vz, proche, large, duree) {     // direction de fuite [x, z], ou null
  const dx = p.x - bx, dz = p.z - bz, d = hypot(dx, dz), vit = hypot(vx, vz);
  if (d < proche) return [dx / (d || 1), dz / (d || 1)];
  if (vit < 1.5) return null;
  const ux = vx / vit, uz = vz / vit, devant = dx * ux + dz * uz, cote = dx * uz - dz * ux;
  if (devant < 0 || devant > proche + vit * duree || Math.abs(cote) > large) return null;
  const s = cote >= 0 ? 1 : -1;
  return [s * uz, -s * ux];
}
function marcher() {
  const dt = 1 / 60, pj = joueur.translation(), vj = joueur.linvel();
  for (const p of pietons) {
    let f = esquive(p, pj.x, pj.z, vj.x, vj.z, 3.6, 4.2, 1.4);
    if (!f) for (let i = 0; i < mobiles.length && !f; i++) if (eveil[i]) {
      const bx = pose[i * 7], bz = pose[i * 7 + 2];
      if (Math.abs(p.x - bx) > 25 || Math.abs(p.z - bz) > 25) continue;
      const w = mobiles[i].corps.linvel();
      f = esquive(p, bx, bz, w.x, w.z, 1.5, 2.2, 1.2);
    }
    if (f) { p.x += f[0] * 6.5 * dt; p.z += f[1] * 6.5 * dt; p.phase += 0.5; }
    else if (p.b) {
      p.s += p.sens * 1.3 * dt;
      const c = boucle(p.b, p.s), ex = c.x - p.x, ez = c.z - p.z, e = hypot(ex, ez), pas = Math.min(e, (e > 0.5 ? 2.6 : 1.4) * dt);
      if (e > 1e-6) { p.x += ex / e * pas; p.z += ez / e * pas; }
      p.phase += 0.22;
    }
    if (p.b) {      // jamais dans les immeubles de son bloc
      const lx = p.x - p.b.cx, lz = p.z - p.b.cz, m = DEMI_BATI + 0.5;
      if (Math.abs(lx) < m && Math.abs(lz) < m) { if (Math.abs(lx) > Math.abs(lz)) p.x = p.b.cx + Math.sign(lx || 1) * m; else p.z = p.b.cz + Math.sign(lz || 1) * m; }
    }
    p.corps.setNextKinematicTranslation({ x: p.x, y: 0.73, z: p.z });
  }
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
  if (sousPasFaits % 4 === 0) { joueur.translation(tv); apparaitre(tv.x, tv.z); marcher(); }
  monde.step(files);
  const aBriser = [];
  files.drainCollisionEvents((h1, h2, debut) => {
    if (!debut) return;
    if (colPietons.has(h1) || colPietons.has(h2)) contactsPietons++;
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
  relever(false); viser();
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
  pietons.forEach((p, i) => meshPietons.setMatrixAt(i, M4.makeTranslation(p.x, 0.73 + Math.abs(sin(p.phase)) * 0.07, p.z)));
  meshPietons.instanceMatrix.needsUpdate = true;
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
    return {
      image: sousPasFaits / 4, rendus,
      voiture: { pos: [p.x, p.y, p.z].map(arr), quat: [q.x, q.y, q.z, q.w].map(arr), vitesse: arr(hypot(v.x, v.y, v.z)),
        ecran: { x: arr((x0 + x1) / 4 + 0.5), y: arr(0.5 - (y0 + y1) / 4), l: arr((x1 - x0) / 2), h: arr((y1 - y0) / 2) } },
      camera: { pos: camera.position.toArray().map(arr) },
      corps: plan.objets.map((_, i) => Array.from(pose.subarray(i * 7, i * 7 + 7), arr)),
      types, morceaux, casses,
      ville: { batiments: plan.batiments.length, etendue: [ETENDUE, ETENDUE] },
      circulation: autos.map(a => xyz(a.corps)), pietons: pietons.map(p => [arr(p.x), 0, arr(p.z)]),
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
