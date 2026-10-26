import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ARM_DIMENSIONS, hardwareMotion, linkagePose, type PlanarPoint } from './hardwareKinematics.ts';
import { JOINT_IDS } from '../lib/hardware.ts';

/** The owner's four-SG90 linkage arm. BIT's decorative arm is a separate rig. */
export function createHardwareArmModel() {
  const scene=new THREE.Scene();scene.background=new THREE.Color('#f3f3ef');
  const camera=new THREE.OrthographicCamera(-2.8,2.8,2.8,-2.8,.1,100);
  camera.position.set(4.4,4.7,10);camera.lookAt(.45,1.65,0);
  const body=new THREE.MeshPhysicalMaterial({color:'#aeb1aa',roughness:.58,metalness:.08,clearcoat:.06});
  const side=new THREE.MeshStandardMaterial({color:'#7d837c',roughness:.64,metalness:.1});
  const dark=new THREE.MeshStandardMaterial({color:'#363d3c',roughness:.65,metalness:.12});
  const metal=new THREE.MeshStandardMaterial({color:'#959d97',roughness:.38,metalness:.45});
  const rubber=new THREE.MeshStandardMaterial({color:'#202824',roughness:.9});
  const accents=JOINT_IDS.map(()=>new THREE.MeshStandardMaterial({color:'#8b938c',roughness:.5,metalness:.12}));
  const key=new THREE.DirectionalLight('#fffdf8',1.45);key.position.set(-3,7,9);
  const fill=new THREE.DirectionalLight('#ffffff',.65);fill.position.set(5,3,-5);
  scene.add(key,fill,new THREE.HemisphereLight('#ffffff','#c5c7c5',.85));
  const assembly=new THREE.Group();assembly.position.x=-.6;scene.add(assembly);
  const turntable=new THREE.Group();turntable.name='hardware-base-yaw';assembly.add(turntable);
  const box=(x:number,y:number,z:number,r=.025)=>new RoundedBoxGeometry(x,y,z,3,Math.min(r,x/3,y/3,z/3));
  function mesh(parent:THREE.Object3D,geometry:THREE.BufferGeometry,material:THREE.Material,x=0,y=0,z=0) {
    const object=new THREE.Mesh(geometry,material);object.position.set(x,y,z);parent.add(object);return object;
  }
  function cylinder(parent:THREE.Object3D,r:number,depth:number,material:THREE.Material,x:number,y:number,z:number,axis:'y'|'z'='z') {
    const m=mesh(parent,new THREE.CylinderGeometry(r,r,depth,40),material,x,y,z);if(axis==='z')m.rotation.x=Math.PI/2;return m;
  }
  function pin(parent:THREE.Object3D,x:number,y:number,z:number,axis:'y'|'z'='z') {
    cylinder(parent,.076,.032,metal,x,y,z,axis);
    const socket=mesh(parent,new THREE.CylinderGeometry(.028,.028,.036,6),dark,x,y,z);
    if(axis==='z')socket.rotation.x=Math.PI/2;
  }
  function capsule(length:number,width:number,depth:number,slotted=false) {
    const r=width/2, shape=new THREE.Shape();
    shape.moveTo(0,-r);shape.lineTo(length,-r);shape.absarc(length,0,r,-Math.PI/2,Math.PI/2,false);
    shape.lineTo(0,r);shape.absarc(0,0,r,Math.PI/2,Math.PI*1.5,false);
    if(slotted&&length>.6){
      const hole=new THREE.Path(),inset=.19,hr=width*.19;
      hole.moveTo(inset,-hr);hole.lineTo(length-inset,-hr);hole.absarc(length-inset,0,hr,-Math.PI/2,Math.PI/2,false);
      hole.lineTo(inset,hr);hole.absarc(inset,0,hr,Math.PI/2,Math.PI*1.5,false);shape.holes.push(hole);
    }
    const g=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:true,bevelSize:.012,bevelThickness:.012,bevelSegments:3,curveSegments:16});
    g.translate(0,0,-depth/2);return g;
  }
  const rods: {object:THREE.Group;from:keyof ReturnType<typeof linkagePose>;to:keyof ReturnType<typeof linkagePose>}[]=[];
  function rod(name:string,from:typeof rods[number]['from'],to:typeof rods[number]['to'],length:number,width:number,z:number,material:THREE.Material=body,slot=false) {
    const group=new THREE.Group();group.name=name;turntable.add(group);group.position.z=z;
    mesh(group,capsule(length,width,.095,slot),material);
    pin(group,0,0,.077);pin(group,length,0,.077);
    rods.push({object:group,from,to});return group;
  }
  // The yaw motor is inside the stationary pedestal. Only the top plate rotates.
  mesh(assembly,new THREE.CylinderGeometry(.68,.82,.12,72),body,0,.08);
  const shell=mesh(assembly,new THREE.CylinderGeometry(.55,.67,.43,72,1,true,Math.PI*.19,Math.PI*1.62),body,0,.35);
  shell.rotation.y=-Math.PI*.35;
  mesh(assembly,new THREE.CylinderGeometry(.56,.56,.075,72),dark,0,.58);
  mesh(turntable,new THREE.CylinderGeometry(.66,.66,.10,72),body,0,.66);
  cylinder(turntable,.21,.025,accents[0],0,.723,0,'y');
  for(const x of [-.48,.48]) for(const z of [-.42,.42])pin(assembly,x,.15,z,'y');
  const axisMarkers:THREE.Object3D[]=[];
  function servo(parent:THREE.Object3D,id:number,x:number,y:number,z:number,rotation:THREE.Euler) {
    const motor=new THREE.Group();motor.name=`hardware-servo-J${id}`;motor.position.set(x,y,z);motor.rotation.copy(rotation);parent.add(motor);
    // Output shaft is the local origin. Body and mounting ears are fixed, not pivots.
    mesh(motor,box(.30,.43,.24),dark,0,-.12,-.16);
    mesh(motor,box(.34,.07,.28,.015),side,0,-.29,-.16);
    mesh(motor,box(.43,.055,.09,.012),body,0,-.23,-.04);
    mesh(motor,box(.23,.23,.015,.012),side,0,-.15,-.291);
    cylinder(motor,.112,.075,accents[id-1],0,0,0);
    cylinder(motor,.047,.10,metal,0,0,.02);
    const anchor=new THREE.Object3D();anchor.position.z=.08;motor.add(anchor);axisMarkers[id-1]=anchor;
    return motor;
  }
  servo(assembly,1,0,.54,0,new THREE.Euler(-Math.PI/2,0,0));
  servo(turntable,2,0,ARM_DIMENSIONS.shoulderHeight,.30,new THREE.Euler(0,Math.PI,0));
  servo(turntable,3,0,ARM_DIMENSIONS.shoulderHeight,-.30,new THREE.Euler());
  for(const z of [-.31,.31])mesh(turntable,box(.35,.38,.105),body,0,.83,z);
  // Two independently driven arms share the shoulder's horizontal shaft axis.
  const d=ARM_DIMENSIONS;
  for(const z of [-.18,.18])rod(`hardware-upper-${z}`, 'A','B',d.upper,.24,z,body,true);
  rod('hardware-forearm', 'C','E',d.driveCrank+d.forearm,.21,-.04,body,true);
  rod('hardware-drive-crank', 'A','D',d.driveCrank,.17,-.43,side);
  rod('hardware-drive-rod', 'D','C',d.upper,.14,-.43);
  // A second, passive parallelogram carries the stationary reference to the elbow.
  mesh(turntable,capsule(d.referenceOffset,.17,.10),side,-d.referenceOffset,d.shoulderHeight,.40);
  rod('hardware-reference-rod','F','G',d.upper,.13,.40,side);
  const triangle=new THREE.Group();triangle.name='hardware-passive-elbow-triangle';turntable.add(triangle);
  const triangleShape=new THREE.Shape();triangleShape.moveTo(-d.referenceOffset-.065,-.04);triangleShape.lineTo(.07,-.08);triangleShape.lineTo(.07,d.toolBracket+.06);triangleShape.lineTo(-d.referenceOffset-.065,.06);triangleShape.closePath();
  const triangleGeometry=new THREE.ExtrudeGeometry(triangleShape,{depth:.09,bevelEnabled:true,bevelSize:.02,bevelThickness:.02,bevelSegments:4});triangleGeometry.translate(0,0,-.045);
  mesh(triangle,triangleGeometry,body);pin(triangle,0,0,.08);pin(triangle,-d.referenceOffset,0,.08);pin(triangle,0,d.toolBracket,.08);
  rod('hardware-tool-level-rod','H','I',d.forearm,.12,.40,side);
  const tool=new THREE.Group();tool.name='hardware-passive-tool-mount';turntable.add(tool);
  for(const z of [-.18,.18]){
    const bracket=mesh(tool,capsule(d.toolBracket,.14,.09),body,0,0,z);bracket.rotation.z=Math.PI/2;
    pin(tool,0,0,z+.065);pin(tool,0,d.toolBracket,z+.065);
  }
  // The leveling linkage is mechanical: no virtual wrist servo or roll channel.
  mesh(tool,box(.83,.11,.61),body,.29,-.10,0);
  mesh(tool,box(.39,.07,.32),side,.14,-.015,0);
  servo(tool,4,.39,.025,-.205,new THREE.Euler(Math.PI/2,0,0));
  function gearGeometry() {
    const shape=new THREE.Shape(),teeth=12;
    for(let i=0;i<teeth*4;i++){
      const angle=i/(teeth*4)*Math.PI*2,r=i%4===1||i%4===2?.219:.188;
      if(i===0)shape.moveTo(r*Math.cos(angle),r*Math.sin(angle));else shape.lineTo(r*Math.cos(angle),r*Math.sin(angle));
    }
    shape.closePath();return new THREE.ExtrudeGeometry(shape,{depth:.055,bevelEnabled:true,bevelSize:.005,bevelThickness:.005,bevelSegments:2});
  }
  const jaws=[-1,1].map((sign,index)=>{
    const jaw=new THREE.Group();jaw.name=`hardware-coupled-jaw-${index}`;jaw.position.set(.39,-.015,sign*.205);tool.add(jaw);
    const gear=mesh(jaw,gearGeometry(),side,0,0,0);gear.rotation.x=Math.PI/2;gear.rotation.z=index*Math.PI/12;
    const shape=new THREE.Shape(),points=[[-.055,sign*.045],[.31,sign*.115],[.66,sign*-.105],[.70,sign*-.195],[.57,sign*-.205],[.29,sign*-.035],[.035,sign*-.085]];
    points.forEach(([x,z],i)=>i===0?shape.moveTo(x,-z):shape.lineTo(x,-z));shape.closePath();
    const finger=mesh(jaw,new THREE.ExtrudeGeometry(shape,{depth:.085,bevelEnabled:true,bevelThickness:.012,bevelSize:.012,bevelSegments:3}),body);finger.rotation.x=-Math.PI/2;finger.position.y=-.08;
    mesh(jaw,box(.13,.105,.045,.012),rubber,.615,-.034,sign*-.187);
    pin(jaw,0,.058,0,'y');return jaw;
  });
  const axles = ([['A',.0,.94],['B',.10,.76],['C',-.235,.50],['D',-.43,.20],['F',.40,.18],['G',.40,.18],['H',.40,.18],['I',.25,.45],['E',0,.50]] as const).map(([point,z,depth])=>{
    const object=cylinder(turntable,.049,depth,metal,0,0,z);
    return {point,object};
  });
  const setAspect=(aspect:number)=>{
    const half=2.65/Math.min(1,aspect);camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.updateProjectionMatrix();
  };
  const state={scene,camera,setAspect,jointAnchors:JOINT_IDS.map(()=>({x:0,y:0})),phase:'Illustrative motion · calibration pending',
    update(seconds:number,activeJoint:string){
      const k=linkagePose(hardwareMotion(seconds));turntable.rotation.y=k.pose.yaw*Math.PI/180;
      for(const r of rods){
        const a=k[r.from] as PlanarPoint,b=k[r.to] as PlanarPoint;
        r.object.position.x=a.x;r.object.position.y=a.y;r.object.rotation.z=Math.atan2(b.y-a.y,b.x-a.x);
      }
      axles.forEach(({point,object})=>{object.position.x=k[point].x;object.position.y=k[point].y;});
      triangle.position.set(k.B.x,k.B.y,.40);
      tool.position.set(k.E.x,k.E.y,0);tool.rotation.z=k.toolPitch;
      jaws.forEach((jaw,index)=>{jaw.rotation.y=index===0?k.pose.grip*.58:-k.pose.grip*.58;});
      accents.forEach((material,index)=>material.color.set(activeJoint===JOINT_IDS[index]?'#e5bd35':'#8b938c'));
      scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
      axisMarkers.forEach((anchor,index)=>{
        const p=anchor.getWorldPosition(new THREE.Vector3()).project(camera);
        state.jointAnchors[index].x=(p.x+1)/2;state.jointAnchors[index].y=(1-p.y)/2;
      });
    },
    dispose(){
      const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();
      scene.traverse(o=>{if(o instanceof THREE.Mesh){geometries.add(o.geometry);(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>materials.add(m));}});
      geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
    },
  };
  setAspect(1);state.update(0,'J2');return state;
}
