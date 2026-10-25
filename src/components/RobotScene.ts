import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILD_DURATION, motionPose, smooth, solveArm, type MotionMode } from './robotMotion.ts';

export interface RobotScene { render(seconds: number, activeJoint: string): void; dispose(): void; phase: string }
type Material = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
const palette = ['#9c28ff', '#00dbef', '#ffe000', '#ff5e12'];
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
function extrudeShape(shape: THREE.Shape, depth: number, bevel = .07) {
  const raw = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 8, curveSegments: 18, steps: 1 });
  // Weld bevel normals while leaving the broad front and back faces perfectly flat.
  raw.deleteAttribute('normal'); raw.deleteAttribute('uv');
  const geometry = mergeVertices(raw); raw.dispose(); geometry.computeVertexNormals();
  geometry.translate(0, 0, -depth / 2);
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  for (let i = 0; i < positions.count; i++) if (Math.abs(Math.abs(positions.getZ(i)) - (depth / 2 + bevel)) < .00001) normals.setXYZ(i, 0, 0, Math.sign(positions.getZ(i)));
  return geometry;
}
function extruded(points: number[][], depth: number, bevel = .07, radius = .14) { return extrudeShape(roundedPolygon(points, radius), depth, bevel); }
function box(x: number, y: number, z: number, bevel = .07) { return new RoundedBoxGeometry(x, y, z, 5, Math.min(bevel, x / 3, y / 3, z / 3)); }
function mesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function ringGeometry(outer: number, inner: number, height: number) {
  const path = roundedPolygon([[inner,-height/2],[outer,-height/2],[outer,height/2],[inner,height/2]], Math.min(.055,height*.3));
  return new THREE.LatheGeometry(path.getPoints(10), 96);
}
function lightBand(points: THREE.Vector3[]) {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const corner = .14;
  let previous = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], a = p.clone().add(points[i - 1].clone().sub(p).normalize().multiplyScalar(corner)), b = p.clone().add(points[i + 1].clone().sub(p).normalize().multiplyScalar(corner));
    path.add(new THREE.LineCurve3(previous, a)); path.add(new THREE.QuadraticBezierCurve3(a, p, b)); previous = b;
  }
  path.add(new THREE.LineCurve3(previous, points.at(-1)!));
  // A solid acrylic diffuser with a broad face and softly radiused edges.
  const profile = roundedPolygon([[-.115,-.065],[.115,-.065],[.115,.065],[-.115,.065]], .034).getPoints(6);
  profile.pop();
  const positions: number[] = [], colors: number[] = [], indices: number[] = [], steps = 240, count = profile.length;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, center = path.getPointAt(t), tangent = path.getTangentAt(t), normal = new THREE.Vector3(-tangent.y,tangent.x,0), color = bandColor(t);
    for (const p of profile) { const v = center.clone().addScaledVector(normal,p.x); v.z += p.y; positions.push(v.x,v.y,v.z); colors.push(color.r,color.g,color.b); }
  }
  for (let i = 0; i < steps; i++) for (let j = 0; j < count; j++) {
    const a=i*count+j,b=i*count+(j+1)%count,c=(i+1)*count+j,d=(i+1)*count+(j+1)%count;
    indices.push(a,b,c,b,d,c);
  }
  for (const end of [0,steps]) {
    const center=path.getPointAt(end/steps),c=bandColor(end/steps),index=positions.length/3;
    positions.push(center.x,center.y,center.z);colors.push(c.r,c.g,c.b);
    for(let j=0;j<count;j++) end===0?indices.push(index,(j+1)%count,j):indices.push(index,end*count+j,end*count+(j+1)%count);
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}
function bandColor(t: number) {
  const stops = [0, .30, .66, .88, 1], colors = [palette[0], palette[1], palette[2], palette[3], palette[3]];
  let i = 0; while (i < 3 && t > stops[i + 1]) i++;
  return new THREE.Color(colors[i]).lerp(new THREE.Color(colors[i + 1]), smooth((t - stops[i]) / (stops[i + 1] - stops[i])));
}

/** Batch fixed castings inside each articulated part; pivots and movable props stay separate. */
function batchStaticParts(parent:THREE.Group) {
  for(const child of [...parent.children]) if(child instanceof THREE.Group) batchStaticParts(child);
  const groups=new Map<THREE.Material,THREE.Mesh[]>();
  for(const child of parent.children) if(child instanceof THREE.Mesh&&!child.name&&!Array.isArray(child.material)) {
    const list=groups.get(child.material)||[];list.push(child);groups.set(child.material,list);
  }
  for(const [material,parts] of groups) if(parts.length>1) {
    const geometries=parts.map(part=>{
      part.updateMatrix();const geometry=(part.geometry.index?part.geometry.toNonIndexed():part.geometry.clone()).applyMatrix4(part.matrix);
      for(const name of Object.keys(geometry.attributes)) if(!['position','normal','color'].includes(name))geometry.deleteAttribute(name);
      return geometry;
    });
    const merged=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());
    if(!merged)continue;
    for(const part of parts){parent.remove(part);part.geometry.dispose();}
    mesh(parent,merged,material);
  }
}

interface ArmRig { root: THREE.Group; shoulder: THREE.Group; elbow: THREE.Group; wrist: THREE.Group; fingers: THREE.Group[]; accents: Material[]; upper: number; lower: number }
function makeArm(parent: THREE.Object3D, body: Material, dark: Material, scale = 1): ArmRig {
  const root = new THREE.Group(); root.name='bit-arm-mount'; parent.add(root);
  const shoulder = new THREE.Group(); root.add(shoulder);
  const elbow = new THREE.Group(), wrist = new THREE.Group();wrist.name='bit-gripper';
  const upper = 1.55 * scale, lower = 1.70 * scale, accents: Material[] = [];
  const edge = new THREE.MeshStandardMaterial({color:'#797b78',roughness:.4,metalness:.32});
  const satin = new THREE.MeshStandardMaterial({color:'#b5b4ae',roughness:.42,metalness:.22});
  const rubber = new THREE.MeshStandardMaterial({color:'#282b2a',roughness:.86,metalness:0});
  function screw(p:THREE.Object3D,x:number,y:number,z:number,r=.041) {
    const cap=mesh(p,new THREE.CylinderGeometry(r*scale,r*scale,.018*scale,32),edge,x*scale,y*scale,z*scale);cap.rotation.x=Math.PI/2;
    const socket=mesh(p,new THREE.CylinderGeometry(r*.48*scale,r*.48*scale,.009*scale,6),dark,x*scale,y*scale,(z+.012)*scale);socket.rotation.x=Math.PI/2;
  }
  const makeJoint = (p: THREE.Group, r: number) => {
    const barrel=mesh(p,new THREE.CylinderGeometry(r*.89,r*.89,.44*scale,64),dark);barrel.rotation.x=Math.PI/2;
    for (const side of [-1,1]) {
      const collar=mesh(p,ringGeometry(r,r*.73,.085*scale),satin,0,0,side*.236*scale);collar.rotation.x=Math.PI/2;
      const gasket=mesh(p,new THREE.TorusGeometry(r*.73,.014*scale,12,64),rubber,0,0,side*.280*scale);
      gasket.castShadow=false;
      const hub=mesh(p,new THREE.CylinderGeometry(r*.67,r*.67,.042*scale,64),edge,0,0,side*.275*scale);hub.rotation.x=Math.PI/2;
      const face=mesh(p,new THREE.CylinderGeometry(r*.54,r*.54,.010*scale,64),dark,0,0,side*.302*scale);face.rotation.x=Math.PI/2;
      const accent=new THREE.MeshStandardMaterial({color:'#9a9990',roughness:.42,metalness:.3});
      mesh(p,new THREE.TorusGeometry(r*.91,.013*scale,12,64),accent,0,0,side*.276*scale);
      if(side===1) {accents.push(accent);screw(p,0,0,.312,r/scale*.22);}
    }
  };
  function link(p:THREE.Group,length:number,width:number) {
    mesh(p,box(width*scale,length+.18*scale,.34*scale,.14*scale),dark,0,length/2,-.015*scale);
    mesh(p,box((width-.025)*scale,length+.15*scale,.34*scale,.14*scale),body,0,length/2,.025*scale);
    // Thin recessed panel seam, a separate front casting, and the real side channel.
    mesh(p,box((width-.12)*scale,length-.30*scale,.019*scale,.07*scale),edge,0,length/2,.202*scale);
    mesh(p,box((width-.145)*scale,length-.325*scale,.025*scale,.07*scale),body,0,length/2,.215*scale);
    for(const side of [-1,1]) mesh(p,box(.014*scale,length-.57*scale,.095*scale,.006*scale),dark,side*(width/2-.006)*scale,length/2,-.02*scale);
    for(const y of [.26,length/scale-.26]) screw(p,0,y,.239,.027);
  }
  link(shoulder,upper,.47);makeJoint(shoulder,.285*scale);
  elbow.position.y=upper;shoulder.add(elbow);link(elbow,lower,.42);makeJoint(elbow,.27*scale);
  wrist.position.y=lower;elbow.add(wrist);makeJoint(wrist,.21*scale);
  mesh(wrist,box(.64*scale,.26*scale,.36*scale,.08*scale),dark,0,-.16*scale);
  mesh(wrist,box(.68*scale,.25*scale,.08*scale,.07*scale),satin,0,-.17*scale,.23*scale);
  for(const side of [-1,1]) screw(wrist,side*.25,-.16,.28,.045);
  const fingers = [-1,1].map(side=>{
    const f=new THREE.Group();f.position.set(side*.30*scale,-.27*scale,0);wrist.add(f);
    const outline=[[0,.07],[.13,.025],[.16,-.30],[.105,-.45],[-.025,-.45],[-.045,-.36],[-.005,-.26],[-.07,-.015]].map(([x,y])=>[side*x*scale,y*scale]);
    const shape=roundedPolygon(outline,.035*scale);
    const slot=roundedPolygon([[.028,-.09],[.083,-.09],[.102,-.28],[.032,-.29]].map(([x,y])=>[side*x*scale,y*scale]),.018*scale);
    shape.holes.push(slot);
    mesh(f,extrudeShape(shape,.18*scale,.018*scale),body);
    const hinge=mesh(f,new THREE.CylinderGeometry(.087*scale,.087*scale,.025*scale,48),edge,0,0,.13*scale);hinge.rotation.x=Math.PI/2;
    screw(f,0,0,.15,.040);
    mesh(f,box(.055*scale,.15*scale,.16*scale,.016*scale),rubber,side*.015*scale,-.37*scale,.015*scale);
    for(let j=0;j<3;j++) mesh(f,box(.061*scale,.009*scale,.165*scale,.003*scale),edge,side*.015*scale,(-.32-j*.045)*scale,.015*scale);
    return f;
  });
  return {root,shoulder,elbow,wrist,fingers,accents,upper,lower};
}
function poseArm(rig: ArmRig, x: number, y: number, open: number, wristTilt = 0, bend: -1 | 1 = -1) {
  const p=solveArm(x,y,rig.upper,rig.lower,bend);
  rig.shoulder.rotation.z=p.shoulder-Math.PI/2;rig.elbow.rotation.z=p.elbow;
  rig.wrist.rotation.z=-rig.shoulder.rotation.z-rig.elbow.rotation.z+wristTilt;
  rig.fingers[0].rotation.z=-.58*open;rig.fingers[1].rotation.z=.58*open;
}

export function createRobotModel(mode: MotionMode) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#f3f3ef');
  const body = new THREE.MeshPhysicalMaterial({ color: '#989994', roughness: .46, metalness: .18, envMapIntensity: .6, clearcoat:.12, clearcoatRoughness:.5 });
  const dark = new THREE.MeshStandardMaterial({ color: '#353735', roughness: .56, metalness: .18 });
  const black = new THREE.MeshPhysicalMaterial({ color: '#111612', roughness: .43, metalness: 0, clearcoat: .10, clearcoatRoughness: .46 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#f3d548', roughness: .47, metalness: .05 });
  const key = new THREE.DirectionalLight('#fffdf8', 1.45); key.position.set(-3,7,9);
  scene.add(key, new THREE.HemisphereLight('#ffffff', '#c5c7c5', .85));
  const fill = new THREE.DirectionalLight('#ffffff', .65); fill.position.set(5,3,-5); scene.add(fill);
  // No receiving ground plane: the mascot floats without a distracting hard silhouette.
  const camera = new THREE.OrthographicCamera(-3.5, 3.5, 3.5, -3.5, .1, 100);
  const actor = new THREE.Group(); scene.add(actor);
  const torso = new THREE.Group(); torso.name='bit-head'; actor.add(torso);
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
    actor.position.x = mode === 'hero' ? .18 : -.75;
    torso.position.y = 2.12;
    // The same bevelled solid shell is reused for home, searching, building and feedback.
    mesh(torso, extruded(hex.map(([x,y])=>[x*.98,y*.98]), .45, .115, .22), dark,0,0,-.065);
    mesh(torso, extruded(hex, .48, .13, .22), body,0,0,.025);
    mesh(torso, extruded(hex.map(([x,y])=>[x*.79,y*.79]), .085, .055,.16), dark,0,0,.39);
    mesh(torso, extruded(hex.map(([x,y])=>[x*.755,y*.755]), .055, .035,.16), black,0,0,.465);
    for (const side of [-1, 1]) {
      mesh(torso, box(.15,.48,.32,.06),dark,side*1.36,-.04,0);
      mesh(torso, box(.24,.59,.39,.10),body,side*1.46,-.04,.04);
      mesh(torso, box(.15,.47,.018,.065),body,side*1.46,-.04,.249);
      mesh(torso, box(.019,.29,.014,.008),dark,side*1.54,-.04,.25);
    }
    const band=lightBand([[.83,.70,.585],[.65,1,.585],[-.65,1,.585],[-1.25,0,.585],[-.65,-1,.585],[.65,-1,.585],[1.25,0,.585],[1.07,.30,.585]].map(p=>new THREE.Vector3(...p)));
    const acrylic=new THREE.MeshPhysicalMaterial({color:'#ffffff',vertexColors:true,roughness:.34,metalness:0,clearcoat:.15,clearcoatRoughness:.42,transmission:.04,thickness:.13,emissive:'#ffffff',emissiveIntensity:.58,toneMapped:false});
    // Vertex colour must tint emission as well as reflection; white emission washed out v1.
    acrylic.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor;\n#endif');};
    acrylic.customProgramCacheKey=()=> 'bit-colored-acrylic-v2';
    mesh(torso,band,acrylic);
    for(const [t,x,y] of [[0,.83,.70],[1,1.07,.30]]) {
      const endMaterial=acrylic.clone();endMaterial.vertexColors=false;endMaterial.color.copy(bandColor(t));endMaterial.emissive.copy(bandColor(t));
      const end=mesh(torso,new THREE.SphereGeometry(.115,32,20),endMaterial,x,y,.585);end.scale.set(.35,1,.565);end.rotation.z=Math.atan2(.30,-.18);
    }
    for (const [color,x,y] of [[palette[1],-.96,.05],[palette[0],.35,.90],[palette[2],-.30,-.91],[palette[3],.98,-.20]] as const) {
      const glow=new THREE.PointLight(color,.075,.75,2);glow.position.set(x,y,.59);torso.add(glow);
    }
    const pixelMat = new THREE.MeshStandardMaterial({color:'#fff7de',emissive:'#fff0c9',emissiveIntensity:.8,roughness:.5,toneMapped:false});
    for (const x of [-.34, .34]) {
      const eye = new THREE.Group(); eye.position.set(x, .01, .55); torso.add(eye); eyes.push(eye);
      for (let row = 0; row < 6; row++) for (let col = 0; col < 3; col++) mesh(eye, box(.052, .052, .012, .004), pixelMat, (col - 1) * .066, (row - 2.5) * .066);
    }
    [[.26,.16,.14,.30],[.42,.29,.17,.54],[.62,.45,.19,.80]].forEach(([outer,inner,height,y]) => { rings.push(mesh(actor, ringGeometry(outer, inner, height), body, 0, y, .25)); });
    // A shaped saddle, gasket and rotating bearing make the arm part of the housing.
    mesh(torso,box(.80,.16,.55,.075),body,0,1.075,-.035);
    mesh(torso,new THREE.CylinderGeometry(.33,.38,.10,72),dark,0,1.19,-.025);
    mesh(torso,new THREE.CylinderGeometry(.32,.34,.09,72),body,0,1.265,-.025);
    const mountRim=mesh(torso,new THREE.TorusGeometry(.32,.018,12,72),dark,0,1.305,-.025);mountRim.rotation.x=Math.PI/2;
    rig = makeArm(torso, body, dark); rig.root.position.y = 1.39;
    for(const side of [-1,1]) mesh(rig.root,box(.51,.37,.075,.10),body,0,-.005,side*.225-.025);
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
      // Solid display platforms share the same neutral, shadow-free environment.
      mesh(actor, box(.87,.16,.85,.06), dark, 2.62,.73,0);
      mesh(actor, box(.83,.13,.83,.06), body, 1.9,.31,0);
      mesh(actor, box(.57,.59,.57,.07), blockMaterial,1.9,.67,0);
      mesh(actor, box(.57,.59,.57,.07), blockMaterial,1.9,1.27,0);
      sourceBlock = mesh(actor, box(.57,.59,.57,.07), colored, 2.62,1.14,0);
      heldBlock = mesh(rig.wrist, box(.57,.59,.57,.07), colored, 0,-.69,0);
      placedBlock = mesh(actor, box(.57,.59,.57,.07), colored,1.9,1.87,0);
      sourceBlock.name='block-source';heldBlock.name='block-held';placedBlock.name='block-placed';
    }
    camera.position.set(2.2,5.0,15); camera.lookAt(mode==='hero'?-.05:.6,2.5,0);
  }
  const setAspect = (aspect: number) => {
    const half = mode === 'arm' ? 2.55 : 3.05;
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half; camera.updateProjectionMatrix();
  };
  batchStaticParts(torso);
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
        torso.rotation.y=mode==='hero'?Math.sin(seconds*.52)*.06:mode==='inspect'?.55+Math.sin(seconds*.6)*.035:.52;
        // Turn BIT toward the work, while the rotary mounting bearing keeps the
        // arm's workspace fixed. Gripper contacts remain aligned with the props.
        rig.root.rotation.y=mode==='hero'?0:-torso.rotation.y;
        rings.forEach((ring, i) => { ring.position.y = [.30,.54,.80][i] + Math.sin(seconds * .9 - i * .22) * .02; });
        const blink = seconds % 4.7, blinkScale = blink > 4.42 ? 1 - Math.sin((blink - 4.42) / .28 * Math.PI) * .94 : 1;
        eyes.forEach(eye => { eye.scale.y = blinkScale; eye.position.x = (eye.position.x < 0 ? -.34 : .34) + (mode === 'inspect' ? .03 : 0); });
        poseArm(rig,pose.x,pose.y-(2.12+breath+1.39),mode==='inspect'?-1.2:pose.open,mode==='hero'?-Math.PI/2:mode==='inspect'?Math.sin(seconds*.75)*.15:0,mode==='hero'?1:-1);
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
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = false;
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
