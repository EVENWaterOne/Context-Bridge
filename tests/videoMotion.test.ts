import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, Mesh } from 'three';
import { createRobotModel } from '../src/components/RobotScene.ts';
import { ARM_DURATION } from '../src/components/robotMotion.ts';
import { hardwareMotion, armMotionDuration, armMotionSteps, armFallbackPlaybackRate, normalizedArmMotion, linkagePose, DEMO_POSE_BOUNDS, type ArmMotionConfig } from '../src/components/hardwareKinematics.ts';
import { createExampleWorkspace, getActiveTask, getActiveRound, makeFile, readMotionSettings } from '../src/lib/workflow.ts';

const near=(a:number,b:number,tolerance=1e-8)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);

test('video choreography reaches out, operates the gripper, turns, then returns to the same home pose',()=>{
  const home=hardwareMotion(0),reach=hardwareMotion(2.5),turned=hardwareMotion(5.2);
  assert.deepEqual(home,hardwareMotion(1.35));
  assert.ok(reach.shoulder<home.shoulder-20);
  assert.ok(reach.forearm<home.forearm-8);
  assert.ok(hardwareMotion(2.9).grip<.2);
  assert.ok(hardwareMotion(3.5).grip>.95);
  assert.ok(turned.yaw>70&&turned.shoulder>95,'uploaded video turns to a retracted upright pose');
  assert.deepEqual(turned,hardwareMotion(6.2));
  assert.deepEqual(home,hardwareMotion(8));
  assert.deepEqual(home,hardwareMotion(ARM_DURATION));
  assert.deepEqual(armMotionSteps().map(step=>step.phase),['Home','Reach','Pause','Turn','Return']);
  near(armMotionSteps().at(-1)!.end,ARM_DURATION);
});

test('slower return changes only return timing, including finite playback and its settling hold',()=>{
  const regular={returnDuration:1.5},slower={returnDuration:3};
  near(armMotionDuration(slower)-armMotionDuration(regular),1.5);
  for(let t=0;t<=6.3;t+=.13){const a=hardwareMotion(t,regular),b=hardwareMotion(t,slower);for(const key of ['yaw','shoulder','forearm','grip'] as const)near(a[key],b[key]);}
  for(let t=0;t<=1.5;t+=.1){
    const a=hardwareMotion(6.3+t,regular),b=hardwareMotion(6.3+t*2,slower);
    for(const key of ['yaw','shoulder','forearm','grip'] as const)near(a[key],b[key]);
  }
  assert.deepEqual(hardwareMotion(armMotionDuration(slower)+30,slower,false),hardwareMotion(0));
  assert.notDeepEqual(hardwareMotion(armMotionDuration(slower)+2,slower,true),hardwareMotion(0));
});

test('file parameters, WebGL and reference movies agree at both return-duration bounds',()=>{
  const workspace=createExampleWorkspace(),task=getActiveTask(workspace),round=getActiveRound(workspace);
  for(const [written,expected] of [[.01,.3],[.3,.3],[1.5,1.5],[7,7],[8,8],[20,8]]){
    const configured={...task,files:[makeFile('motion.py',`return_duration = ${written}\nmotion_easing = "minimum_jerk"\n`,'code')]};
    const settings=readMotionSettings(configured,round);
    assert.equal(settings.returnDuration,expected);
    assert.deepEqual(normalizedArmMotion(settings),settings,'the renderer must not silently shorten a valid file setting');
    const referenceReturn=armFallbackPlaybackRate(7,settings);
    near(6.3+1.5/referenceReturn+(ARM_DURATION-7.8),armMotionDuration(settings));
    assert.equal(armFallbackPlaybackRate(6.29,settings),1);
    assert.equal(armFallbackPlaybackRate(7.8,settings),1,'the final hold resumes normal speed');
    assert.deepEqual(hardwareMotion(armMotionDuration(settings)+1,settings,false),hardwareMotion(0,settings,false));
  }
});

test('shaking is a distinct connected joint motion, while stable preserves the same targets and range',()=>{
  const shaky:ArmMotionConfig={variant:'shaking'},stable:ArmMotionConfig={variant:'stable'};
  const keys=['yaw','shoulder','forearm','grip'] as const;
  for(const t of [0,1.3,3.5,6.2,8.5,ARM_DURATION])assert.deepEqual(hardwareMotion(t,shaky),hardwareMotion(t,stable));
  const acceleration=(config:ArmMotionConfig)=>{
    let energy=0;
    for(let t=1.65;t<2.35;t+=.01){
      const a=hardwareMotion(t-.01,config),b=hardwareMotion(t,config),c=hardwareMotion(t+.01,config);
      energy+=(a.forearm-2*b.forearm+c.forearm)**2;
    }
    return energy;
  };
  assert.ok(acceleration(shaky)>acceleration(stable)*30,'before visibly oscillates; after has smooth acceleration');
  for(const config of [shaky,stable])for(let t=0;t<=ARM_DURATION;t+=.025){
    const pose=hardwareMotion(t,config),k=linkagePose(pose);
    for(const key of keys){const [min,max]=DEMO_POSE_BOUNDS[key];assert.ok(pose[key]>=min&&pose[key]<=max);near(pose[key],k.pose[key]);}
    near(k.toolPitch,0);
  }
});

test('both video variants keep every model vertex inside its viewport throughout the full sequence',()=>{
  const model=createRobotModel('arm');
  try{
    const meshes:Mesh[]=[];model.scene.traverse(o=>{if(o instanceof Mesh){o.geometry.computeBoundingBox();meshes.push(o);}});
    for(const config of [{variant:'shaking'},{variant:'stable'}] as const)for(const aspect of [.7,1,1.6]){
      model.setAspect(aspect);
      for(let t=0;t<armMotionDuration(config);t+=.12){
        model.update(t,'J2',config);
        for(const mesh of meshes){const b=mesh.geometry.boundingBox!;
          for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z]){
            const p=new Vector3(x,y,z).applyMatrix4(mesh.matrixWorld).project(model.camera);
            assert.ok(Math.abs(p.x)<.9&&Math.abs(p.y)<.9,`${config.variant}, ${t}: model exceeds safe viewport`);
          }
        }
      }
    }
  }finally{model.dispose();}
});
