import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Quaternion, Mesh, Raycaster, SRGBColorSpace } from 'three';
import { createRobotModel, bandColor } from '../src/components/RobotScene.ts';
import { BUILD_DURATION, INSPECT_DURATION, motionPose, waitingMotion } from '../src/components/robotMotion.ts';
import { layoutJointLabels } from '../src/components/robotLabels.ts';

test('turning BIT toward the work preserves exact pickup and placement contacts', () => {
  const model = createRobotModel('build');
  try {
    const position = (name: string) => model.scene.getObjectByName(name)!.getWorldPosition(new Vector3());
    const head = model.scene.getObjectByName('bit-head')!;
    for (const [start,end,prop] of [[.16,.23,'block-source'],[.72,.79,'block-placed']] as const) {
      for (let t=start; t<=end; t+=.005) {
        model.update(BUILD_DURATION * t, 'J2');
        assert.ok(head.rotation.y > .4, 'BIT faces right toward the working area');
        assert.ok(position('block-held').distanceTo(position(prop)) < .00001, `block slips during contact at ${t}`);
        const held=model.scene.getObjectByName('block-held')!.getWorldQuaternion(new Quaternion());
        const resting=model.scene.getObjectByName(prop)!.getWorldQuaternion(new Quaternion());
        assert.ok(held.angleTo(resting)<.00001, 'held block aligns with the resting block');
      }
    }
  } finally { model.dispose(); }
});

test('both waiting poses turn, float, swivel and blink while the tool follows its workspace target', () => {
  for (const [mode,duration] of [['inspect',INSPECT_DURATION],['build',BUILD_DURATION]] as const) {
    const model=createRobotModel(mode);
    try {
      const head=model.scene.getObjectByName('bit-head')!,mount=model.scene.getObjectByName('bit-arm-mount')!,wrist=model.scene.getObjectByName('bit-gripper')!;
      const eyes=['bit-eye-left','bit-eye-right'].map(name=>model.scene.getObjectByName(name)!);
      const turns:number[]=[],heights:number[]=[],swivels:number[]=[],blinks:number[]=[];
      for(let t=0;t<duration;t+=.025){
        model.update(t,'J2');
        turns.push(head.rotation.y);heights.push(head.position.y);swivels.push(mount.rotation.y);blinks.push(eyes[0].scale.y);
        assert.equal(eyes[0].scale.y,eyes[1].scale.y);
        assert.ok(head.rotation.y>.4&&head.rotation.y<.7,'BIT stays facing its work');
        const pose=motionPose(mode,t),follow=waitingMotion(mode,t);
        const expected=new Vector3(pose.x,pose.y,follow.toolDepth);
        head.parent!.localToWorld(expected);
        assert.ok(wrist.getWorldPosition(new Vector3()).distanceTo(expected)<.00001,`tool target drift at ${mode}, ${t}`);
      }
      const range=(values:number[])=>Math.max(...values)-Math.min(...values);
      assert.ok(range(turns)>.15,'body visibly follows the work');
      assert.ok(range(heights)>.12,'body gently floats');
      assert.ok(range(swivels)>.15,'first joint swivels rather than remaining fixed');
      assert.ok(Math.min(...blinks)<.1&&Math.abs(Math.max(...blinks)-1)<1e-8,'eyes fully blink and reopen');
      const moving=[head,mount,wrist,...eyes];
      model.update(0,'J2');
      const start=moving.map(o=>o.matrixWorld.clone());
      model.update(duration-.00001,'J2');
      moving.forEach((o,i)=>o.matrixWorld.elements.forEach((v,j)=>assert.ok(Math.abs(v-start[i].elements[j])<.0001,'waiting loop must not jump')));
    } finally { model.dispose(); }
  }
});

test('the cyan to yellow transition stays colored rather than passing through white', () => {
  for(let t=0;t<=1;t+=.002){
    const hsl=bandColor(t).getHSL({h:0,s:0,l:0},SRGBColorSpace);
    assert.ok(hsl.s>.55,`desaturated band at ${t}`);
    assert.ok(hsl.l<.75,`washed-out band at ${t}`);
  }
});

test('the face covers the diffuser inner lip across every corner', () => {
  const model=createRobotModel('hero');
  try {
    const band=model.scene.getObjectByName('bit-light-band') as Mesh;
    const source=model.scene.getObjectByName('bit-face-panel') as Mesh;
    const face=new Mesh(source.geometry,source.material);face.position.copy(source.position);face.updateMatrixWorld();
    const positions=band.geometry.getAttribute('position'),count=(positions.count-2)/241;
    for(let step=0;step<=240;step+=3){
      let inner=new Vector3(Infinity,Infinity,0);
      for(let j=0;j<count;j++){
        const p=new Vector3().fromBufferAttribute(positions,step*count+j);
        if(Math.hypot(p.x,p.y)<Math.hypot(inner.x,inner.y))inner=p;
      }
      const ray=new Raycaster(new Vector3(inner.x*.999,inner.y*.999,2),new Vector3(0,0,-1));
      assert.ok(ray.intersectObject(face).length>0,`face gap at band cross-section ${step}`);
    }
  } finally { model.dispose(); }
});

test('arm motion and its joint callouts stay within the model area at narrow and wide sizes', () => {
  const model=createRobotModel('arm');
  try {
    const meshes:Mesh[]=[];model.scene.traverse(o=>{if(o instanceof Mesh){o.geometry.computeBoundingBox();meshes.push(o)}});
    for(const [width,height] of [[280,400],[400,400],[560,350]]){
      model.setAspect(width/height);
      for(let t=0;t<7.2;t+=.24){
        model.update(t,'J2');
        for(const mesh of meshes){
          const b=mesh.geometry.boundingBox!;
          for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z]){
            const p=new Vector3(x,y,z).applyMatrix4(mesh.matrixWorld).project(model.camera);
            assert.ok(Math.abs(p.x)<.9&&Math.abs(p.y)<.9,`arm outside safe area at ${width}×${height}, ${t}s`);
          }
        }
        const labels=layoutJointLabels(model.jointAnchors,width,height,Array(4).fill({width:92,height:30}));
        labels.forEach(p=>{assert.ok(p.x>=8&&p.x+92<=width-8);assert.ok(p.y>=23&&p.y<=height-23)});
        for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){
          const a=labels[i],b=labels[j];
          assert.ok(Math.abs(a.x-b.x)>=92||Math.abs(a.y-b.y)>=30,`joint labels overlap at ${width}×${height}, ${t}s`);
        }
      }
    }
  } finally { model.dispose(); }
});
