import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BUILD_DURATION, mix, motionPose, smooth, solveArm, type MotionMode } from './robotMotion.ts';

export interface RobotScene { render(seconds: number, activeJoint: string): void; dispose(): void; phase: string }
type Material = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
const palette = ['#9968f6', '#68ebdd', '#f8e965', '#ff8a72'];
const hex = [[.7, 1.05], [-.7, 1.05], [-1.36, 0], [-.7, -1.05], [.7, -1.05], [1.36, 0]];

function roundedPolygon(points: number[][], radius = .14) {
  const path = new THREE.Shape();
  const corners = points.map((p, i) => {
    const v = new THREE.Vector2(...p), before = new THREE.Vector2(...points[(i + points.length - 1) % points.length]), after = new THREE.Vector2(...points[(i + 1) % points.length]);
    return { v, start: v.clone().add(before.sub(v).normalize().multiplyScalar(radius)), end: v.clone().add(after.sub(v).normalize().multiplyScalar(radius)) };
  });
  path.moveTo(corners[0].start.x, corners[0].start.y);
  for (const c of corners) { path.lineTo(c.start.x, c.start.y); path.quadraticCurveTo(c.v.x, c.v.y, c.end.x, c.end.y); }
  path.closePath();
  return path;
}
function extruded(points: number[][], depth: number, bevel = .07) {
  const geometry = new THREE.ExtrudeGeometry(roundedPolygon(points), { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5, curveSegments: 12, steps: 1 });
  geometry.translate(0, 0, -depth / 2);
  return geometry;
}
function box(x: number, y: number, z: number, bevel = .07) { return new RoundedBoxGeometry(x, y, z, 5, Math.min(bevel, x / 3, y / 3, z / 3)); }
function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function ringGeometry(outer: number, inner: number, height: number) {
  const b = .035;
  return new THREE.LatheGeometry([
    new THREE.Vector2(inner, -height / 2 + b), new THREE.Vector2(inner + b, -height / 2),
    new THREE.Vector2(outer - b, -height / 2), new THREE.Vector2(outer, -height / 2 + b),
    new THREE.Vector2(outer, height / 2 - b), new THREE.Vector2(outer - b, height / 2),
    new THREE.Vector2(inner + b, height / 2), new THREE.Vector2(inner, height / 2 - b), new THREE.Vector2(inner, -height / 2 + b),
  ], 96);
}
function tubeCurve(points: THREE.Vector3[], radius: number) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const corner = .14;
  let previous = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], a = p.clone().add(points[i - 1].clone().sub(p).normalize().multiplyScalar(corner)), b = p.clone().add(points[i + 1].clone().sub(p).normalize().multiplyScalar(corner));
    path.add(new THREE.LineCurve3(previous, a)); path.add(new THREE.QuadraticBezierCurve3(a, p, b)); previous = b;
  }
  path.add(new THREE.LineCurve3(previous, points.at(-1)!));
  return { path, geometry: new THREE.TubeGeometry(path, 220, radius, 16, false) };
}
function applyColors(geometry: THREE.BufferGeometry, colorAt: (index: number) => THREE.Color) {
  const position = geometry.getAttribute('position'), colors: number[] = [];
  for (let i = 0; i < position.count; i++) { const c = colorAt(i); colors.push(c.r, c.g, c.b); }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}
function bandColor(t: number) {
  const stops = [0, .30, .66, .88, 1], colors = [palette[0], palette[1], palette[2], palette[3], palette[3]];
  let i = 0; while (i < 3 && t > stops[i + 1]) i++;
  return new THREE.Color(colors[i]).lerp(new THREE.Color(colors[i + 1]), smooth((t - stops[i]) / (stops[i + 1] - stops[i])));
}

interface ArmRig { root: THREE.Group; shoulder: THREE.Group; elbow: THREE.Group; wrist: THREE.Group; fingers: THREE.Group[]; accents: Material[]; upper: number; lower: number }
function makeArm(parent: THREE.Object3D, body: Material, dark: Material, scale = 1): ArmRig {
  const root = new THREE.Group(); parent.add(root);
  const shoulder = new THREE.Group(); root.add(shoulder);
  const elbow = new THREE.Group(), wrist = new THREE.Group();
  const upper = 1.55 * scale, lower = 1.70 * scale;
  const accents: Material[] = [];
  const makeJoint = (p: THREE.Group, r: number) => {
    const shell = mesh(p, new THREE.CylinderGeometry(r, r, .40 * scale, 64), body); shell.rotation.x = Math.PI / 2;
    for (const side of [-1, 1]) {
      const hub = mesh(p, new THREE.CylinderGeometry(r * .76, r * .76, .045 * scale, 64), dark, 0, 0, side * .215 * scale); hub.rotation.x = Math.PI / 2;
      const accent = new THREE.MeshStandardMaterial({ color: '#989e9b', roughness: .48, metalness: .15, emissive: '#000000' });
      const trim = mesh(p, new THREE.TorusGeometry(r * .85, .025 * scale, 12, 64), accent, 0, 0, side * .24 * scale);
      trim.castShadow = false; if (side === 1) accents.push(accent);
      mesh(p, box(.025 * scale, .14 * scale, .014 * scale, .006), body, 0, 0, side * .25 * scale);
    }
  };
  makeJoint(shoulder, .26 * scale);
  // Solid overlapping joint housings conceal both rotating link ends at every angle.
  mesh(shoulder, box(.32 * scale, upper, .35 * scale, .09 * scale), dark, 0, upper / 2, -.015 * scale);
  mesh(shoulder, box(.38 * scale, upper - .25 * scale, .38 * scale, .09 * scale), body, 0, upper / 2, .02 * scale);
  elbow.position.y = upper; shoulder.add(elbow); makeJoint(elbow, .26 * scale);
  mesh(elbow, box(.29 * scale, lower, .33 * scale, .08 * scale), dark, 0, lower / 2, -.015 * scale);
  mesh(elbow, box(.34 * scale, lower - .24 * scale, .36 * scale, .09 * scale), body, 0, lower / 2, .015 * scale);
  wrist.position.y = lower; elbow.add(wrist); makeJoint(wrist, .22 * scale);
  mesh(wrist, box(.55 * scale, .25 * scale, .43 * scale, .08 * scale), body, 0, -.18 * scale);
  mesh(wrist, box(.28 * scale, .06 * scale, .36 * scale, .02), dark, 0, -.32 * scale);
  const fingers = [-1, 1].map(side => {
    const f = new THREE.Group(); f.position.set(side * .30 * scale, -.27 * scale, 0); wrist.add(f);
    mesh(f, box(.15 * scale, .42 * scale, .28 * scale, .045 * scale), body, side * .045 * scale, -.17 * scale);
    mesh(f, box(.16 * scale, .16 * scale, .29 * scale, .04 * scale), dark, side * .045 * scale, -.37 * scale);
    return f;
  });
  return { root, shoulder, elbow, wrist, fingers, accents, upper, lower };
}
function poseArm(rig: ArmRig, x: number, y: number, open: number, wristTilt = 0) {
  const p = solveArm(x, y, rig.upper, rig.lower);
  rig.shoulder.rotation.z = p.shoulder - Math.PI / 2;
  rig.elbow.rotation.z = p.elbow;
  rig.wrist.rotation.z = -rig.shoulder.rotation.z - rig.elbow.rotation.z + wristTilt;
  rig.fingers[0].rotation.z = -.42 * open; rig.fingers[1].rotation.z = .42 * open;
}

export function createRobotModel(mode: MotionMode) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#f3f3ef');
  const body = new THREE.MeshStandardMaterial({ color: '#aeb3b2', roughness: .58, metalness: .10, envMapIntensity: .65 });
  const dark = new THREE.MeshStandardMaterial({ color: '#303639', roughness: .62, metalness: .12 });
  const black = new THREE.MeshPhysicalMaterial({ color: '#101819', roughness: .31, metalness: .07, clearcoat: .22, clearcoatRoughness: .38 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#f3d548', roughness: .47, metalness: .05 });
  const key = new THREE.DirectionalLight('#fffaf5', 2.2); key.position.set(-3, 7, 8); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 7; key.shadow.camera.bottom = -3; key.shadow.normalBias = .025; key.shadow.bias = -.0001; key.shadow.radius = 4;
  scene.add(key, new THREE.HemisphereLight('#ffffff', '#c5c7c5', 1.0));
  const fill = new THREE.DirectionalLight('#ffffff', .8); fill.position.set(5, 3, -5); scene.add(fill);
  const floor = mesh(scene, new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .12 }), 0, -.04, 0); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  const camera = new THREE.OrthographicCamera(-3.5, 3.5, 3.5, -3.5, .1, 100);
  const actor = new THREE.Group(); scene.add(actor);
  const torso = new THREE.Group(); actor.add(torso);
  const rings: THREE.Mesh[] = [], eyes: THREE.Group[] = [];
  let rig: ArmRig;
  let magnifier: THREE.Group | undefined, heldBlock: THREE.Mesh | undefined, sourceBlock: THREE.Mesh | undefined, placedBlock: THREE.Mesh | undefined;
  const evidence: THREE.Group[] = [];
  const lensMaterial = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: .015, metalness: 0, transmission: 1, thickness: .025, ior: 1.12, transparent: true, opacity: .22, clearcoat: 1, envMapIntensity: .6 });
  if (mode === 'arm') {
    actor.position.x = -.8;
    mesh(actor, new THREE.CylinderGeometry(.65, .85, .20, 96), dark, 0, .10);
    mesh(actor, new THREE.CylinderGeometry(.60, .72, .20, 96), body, 0, .29);
    mesh(actor, new THREE.CylinderGeometry(.44, .48, .43, 80), body, 0, .59);
    const trim = mesh(actor, new THREE.TorusGeometry(.46, .035, 16, 96), yellow, 0, .78); trim.rotation.x = Math.PI / 2;
    rig = makeArm(torso, body, dark, 1.1); rig.root.position.y = .95;
    camera.position.set(4.5, 4.7, 10); camera.lookAt(.15, 1.85, 0);
  } else {
    actor.position.x = mode === 'hero' ? -.45 : -.75;
    torso.position.y = 2.12;
    // The same bevelled solid shell is reused for home, searching, building and feedback.
    mesh(torso, extruded(hex, .57, .09), dark, 0, 0, -.10);
    mesh(torso, extruded(hex.map(([x, y]) => [x * .99, y * .99]), .49, .09), body, 0, 0, .015);
    mesh(torso, extruded(hex.map(([x, y]) => [x * .78, y * .78]), .13, .065), dark, 0, 0, .38);
    mesh(torso, extruded(hex.map(([x, y]) => [x * .755, y * .755]), .075, .04), black, 0, 0, .465);
    for (const side of [-1, 1]) {
      mesh(torso, box(.15, .51, .48, .06), dark, side * 1.35, -.04, -.01);
      mesh(torso, box(.27, .61, .51, .09), body, side * 1.45, -.04, -.01);
      mesh(torso, box(.045, .29, .025, .02), dark, side * 1.47, -.04, .26);
    }
    const band = tubeCurve([[.83,.70,.57],[.65,1,.57],[-.65,1,.57],[-1.25,0,.57],[-.65,-1,.57],[.65,-1,.57],[1.25,0,.57],[1.07,.30,.57]].map(p => new THREE.Vector3(...p)), .115);
    applyColors(band.geometry, i => bandColor(Math.floor(i / 17) / 220));
    const acrylic = new THREE.MeshPhysicalMaterial({ color: '#ffffff', vertexColors: true, roughness: .42, metalness: 0, clearcoat: .25, clearcoatRoughness: .35, transmission: .12, thickness: .18, emissive: '#ffffff', emissiveIntensity: .23 });
    const bandMesh = mesh(torso, band.geometry, acrylic); bandMesh.scale.z = .83; bandMesh.position.z = .115;
    // Rounded solid endcaps make the intentional upper-right gap visibly physical.
    for (const t of [0, 1]) {
      const capMat = acrylic.clone(); capMat.vertexColors = false; capMat.color.copy(bandColor(t)); capMat.emissive.copy(bandColor(t));
      const p = band.path.getPoint(t), cap = mesh(torso, new THREE.SphereGeometry(.115, 24, 16), capMat, p.x, p.y, p.z * .83 + .115); cap.scale.z = .83;
    }
    for (const [color, x, y] of [['#68ebdd', -.97, .05], ['#9968f6', .37, .91], ['#f8e965', -.35, -.93], ['#ff8a72', 1.0, -.22]] as const) {
      const glow = new THREE.PointLight(color, .28, 1.2, 2); glow.position.set(x, y, .69); torso.add(glow);
    }
    const pixelMat = new THREE.MeshStandardMaterial({ color: '#fff8e9', emissive: '#fff4df', emissiveIntensity: 1.8, roughness: .5 });
    for (const x of [-.34, .34]) {
      const eye = new THREE.Group(); eye.position.set(x, .01, .55); torso.add(eye); eyes.push(eye);
      for (let row = 0; row < 6; row++) for (let col = 0; col < 3; col++) mesh(eye, box(.052, .052, .012, .004), pixelMat, (col - 1) * .066, (row - 2.5) * .066);
    }
    [[.25,.14,.12,.12],[.47,.30,.17,.43],[.72,.51,.20,.81]].forEach(([outer,inner,height,y]) => { rings.push(mesh(actor, ringGeometry(outer, inner, height), body, 0, y, .25)); });
    mesh(torso, new THREE.CylinderGeometry(.32, .38, .14, 64), body, 0, 1.18);
    rig = makeArm(torso, body, dark); rig.root.position.y = 1.39;
    if (mode === 'inspect') {
      magnifier = new THREE.Group(); rig.wrist.add(magnifier);
      mesh(magnifier, box(.12,.55,.15,.045), dark, 0,-.50,.12);
      mesh(magnifier, new THREE.TorusGeometry(.44,.065,20,80), yellow, 0,-1.13,.12);
      const lens = mesh(magnifier, new THREE.SphereGeometry(.415,64,32), lensMaterial, 0,-1.13,.12); lens.scale.z = .075; lens.castShadow = false;
      const reflection = new THREE.MeshStandardMaterial({color:'#fffefa',emissive:'#ffffff',emissiveIntensity:.2,roughness:.2});
      const glint = mesh(magnifier, new THREE.TorusGeometry(.36,.007,8,32,.65), reflection, 0,-1.13,.154); glint.rotation.z = .65; glint.castShadow = false;
      // Evidence exists in 3D behind the lens, making its transparency easy to see.
      for (let i = 0; i < 3; i++) {
        const card = new THREE.Group(); card.position.set(2.1 + i * .24, 1.2 + i * .23, -.30 - i * .12); card.rotation.set(-.10, -.12, -.14 + i * .14); actor.add(card); evidence.push(card);
        mesh(card, box(.74,.91,.035,.05), new THREE.MeshStandardMaterial({color: '#fdfdf9', roughness: .75}));
        for (let line = 0; line < 4; line++) mesh(card, box(line === 3 ? .30 : .51,.025,.008,.005), line === 1 ? yellow : dark, line === 3 ? -.1 : 0,.25-line*.15,.025);
      }
    }
    if (mode === 'build') {
      const blockMaterial = new THREE.MeshPhysicalMaterial({ color: '#eee9dc', roughness: .30, metalness: .03, clearcoat: .5 });
      const colored = blockMaterial.clone(); colored.color.set('#f3d548');
      // Both piles have a real platform and contact shadows, not printed shadows.
      mesh(actor, box(.87,.16,.85,.06), dark, 2.62,.73,0);
      mesh(actor, box(.83,.13,.83,.06), body, 1.9,.31,0);
      mesh(actor, box(.57,.59,.57,.07), blockMaterial,1.9,.67,0);
      mesh(actor, box(.57,.59,.57,.07), blockMaterial,1.9,1.27,0);
      sourceBlock = mesh(actor, box(.57,.59,.57,.07), colored, 2.62,1.14,0);
      heldBlock = mesh(rig.wrist, box(.57,.59,.57,.07), colored, 0,-.69,0);
      placedBlock = mesh(actor, box(.57,.59,.57,.07), colored,1.9,1.87,0);
    }
    camera.position.set(4.0,7.2,12); camera.lookAt(mode === 'hero' ? .25 : .6,2.45,0);
  }
  const setAspect = (aspect: number) => {
    const half = mode === 'arm' ? 2.55 : 3.05;
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half; camera.updateProjectionMatrix();
  };
  setAspect(1);
  const state = {
    scene, camera, setAspect,
    phase: '',
    update(seconds: number, activeJoint: string) {
      const pose = motionPose(mode, seconds); state.phase = pose.phase;
      if (mode === 'arm') {
        torso.rotation.y = Math.sin(seconds * .52) * .12;
        poseArm(rig, pose.x, pose.y - .95, pose.open);
        rig.accents.forEach((material, i) => { material.color.set(activeJoint === `J${i + 1}` ? '#f3d548' : '#969c99'); material.emissive.set(activeJoint === `J${i + 1}` ? '#8f740b' : '#000000'); material.emissiveIntensity = .18; });
      } else {
        const breath = Math.sin(seconds * .9) * .035;
        torso.position.y = 2.12 + breath;
        torso.rotation.y = mode === 'hero' ? Math.sin(seconds * .52) * .10 : mode === 'inspect' ? -.045 + Math.sin(seconds * .6) * .04 : 0;
        rings.forEach((ring, i) => { ring.position.y = [.12,.43,.81][i] + Math.sin(seconds * .9 - i * .22) * .025; });
        const blink = seconds % 4.7, blinkScale = blink > 4.42 ? 1 - Math.sin((blink - 4.42) / .28 * Math.PI) * .94 : 1;
        eyes.forEach(eye => { eye.scale.y = blinkScale; eye.position.x = (eye.position.x < 0 ? -.34 : .34) + (mode === 'inspect' ? .03 : 0); });
        poseArm(rig, pose.x, pose.y - (2.12 + breath + 1.39), mode === 'inspect' ? -.6 : pose.open, mode === 'inspect' ? Math.sin(seconds * .75) * .15 : 0);
        if (magnifier) magnifier.rotation.y = Math.sin(seconds * .7) * .16;
        if (mode === 'build' && heldBlock && sourceBlock && placedBlock) {
          const t = (seconds % BUILD_DURATION) / BUILD_DURATION;
          heldBlock.visible = t >= .23 && t < .72;
          sourceBlock.visible = t < .23 || t > .92;
          sourceBlock.scale.setScalar(t > .92 ? smooth((t - .92) / .08) : 1);
          placedBlock.visible = t >= .72 && t < .92;
          placedBlock.scale.setScalar(t > .84 ? 1 - smooth((t - .84) / .08) : 1);
        }
      }
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    },
    dispose() {

      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(o => { if (o instanceof THREE.Mesh) { geometries.add(o.geometry); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); } });
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); lensMaterial.dispose();
    },
  };
  state.update(0, 'J2');
  return state;
}

/** The DOM renderer is separate so the identical model can also be rendered offline. */
export function createRobotScene(host: HTMLElement, mode: MotionMode): RobotScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const model = createRobotModel(mode);
  const environment = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer), envMap = pmrem.fromScene(environment, .04);
  model.scene.environment = envMap.texture; model.scene.environmentIntensity = .6;
  environment.dispose(); pmrem.dispose();
  const resize = () => { const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight); model.setAspect(width / height); renderer.setSize(width, height, false); renderer.render(model.scene, model.camera); };
  const sizeObserver = new ResizeObserver(resize); sizeObserver.observe(host); resize();
  let disposed = false;
  return {
    get phase() { return model.phase; },
    render(seconds, activeJoint) { if (disposed) return; model.update(seconds, activeJoint); renderer.render(model.scene, model.camera); },
    dispose() { disposed = true; sizeObserver.disconnect(); model.dispose(); envMap.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); },
  };
}
