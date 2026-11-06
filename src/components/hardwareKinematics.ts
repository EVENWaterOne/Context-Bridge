import { ARM_DURATION, smooth } from './robotMotion.ts';

export interface ArmPose { yaw: number; shoulder: number; forearm: number; grip: number }
export interface PlanarPoint { x: number; y: number }
// Drawing-space proportions inferred from the assembly photos, not millimetres.
export const ARM_DIMENSIONS = { shoulderHeight: .97, upper: 1.52, forearm: 1.62, driveCrank: .53, referenceOffset: .48, toolBracket: .34 } as const;
// This is a drawing envelope for the observed motion, never a servo calibration.
export const DEMO_POSE_BOUNDS = { yaw: [-24,84], shoulder: [55,108], forearm: [-32,24], grip: [0,1] } as const;
const radians = (degrees:number) => degrees*Math.PI/180;
const add = (a:PlanarPoint,b:PlanarPoint):PlanarPoint => ({x:a.x+b.x,y:a.y+b.y});
const vector = (length:number,degrees:number):PlanarPoint => ({x:length*Math.cos(radians(degrees)),y:length*Math.sin(radians(degrees))});
/** Three arm axes plus ONE coupled jaw DOF. No independently commanded wrist.
 * Two rear rods have different jobs: transmit the forearm drive, and carry the
 * fixed base reference to the elbow triangle. Its top rod levels the tool mount.
 */
export function linkagePose(input: ArmPose) {
  const pose = Object.fromEntries(Object.entries(input).map(([key,value]) => {
    const [min,max] = DEMO_POSE_BOUNDS[key as keyof ArmPose];
    if (!Number.isFinite(value)) throw new Error('Invalid preview pose.');
    return [key, Math.max(min,Math.min(max,value))];
  })) as unknown as ArmPose;
  const d=ARM_DIMENSIONS;
  const A={x:0,y:d.shoulderHeight};
  const B=add(A,vector(d.upper,pose.shoulder));
  const D=add(A,vector(-d.driveCrank,pose.forearm));
  const C=add(B,vector(-d.driveCrank,pose.forearm));
  const F=add(A,{x:-d.referenceOffset,y:0});
  const G=add(B,{x:-d.referenceOffset,y:0});
  const H=add(B,{x:0,y:d.toolBracket});
  const E=add(B,vector(d.forearm,pose.forearm));
  const I=add(E,{x:0,y:d.toolBracket});
  return { pose, A,B,C,D,E,F,G,H,I, toolPitch: 0, jawAngles: [-pose.grip*.58,pose.grip*.58] as const };
}
/** A visual reconstruction of the supplied 9.57 s tabletop demonstration.
 * Only relative poses are inferred from the camera footage. No values here are
 * sent to physical servos; controller limits remain in the hardware adapter.
 */
export interface ArmMotionConfig { variant?: 'stable' | 'shaking'; returnDuration?: number }
export type ArmMotionPhase = 'Home' | 'Reach' | 'Pause' | 'Turn' | 'Return';
export const REFERENCE_RETURN_DURATION = 1.5;
const RETURN_START = 6.3;
const FINAL_HOLD = ARM_DURATION - RETURN_START - REFERENCE_RETURN_DURATION;
export function normalizedArmMotion(config: ArmMotionConfig = {}): Required<ArmMotionConfig> {
  return {variant:config.variant === 'shaking' ? 'shaking' : 'stable', returnDuration:Number.isFinite(config.returnDuration) ? Math.max(.3,Math.min(8,config.returnDuration!)) : REFERENCE_RETURN_DURATION};
}
export function armMotionDuration(config: ArmMotionConfig = {}) {
  return RETURN_START + normalizedArmMotion(config).returnDuration + FINAL_HOLD;
}
/** Reference movies retime the return only, then play their final hold at 1×. */
export function armFallbackPlaybackRate(referenceSeconds:number, config:ArmMotionConfig = {}) {
  return referenceSeconds>=RETURN_START && referenceSeconds<RETURN_START+REFERENCE_RETURN_DURATION
    ? REFERENCE_RETURN_DURATION/normalizedArmMotion(config).returnDuration : 1;
}
export function armMotionSteps(config: ArmMotionConfig = {}) {
  const spans: readonly (readonly [ArmMotionPhase,string,number])[] = [
    ['Home','Home',1.4],['Reach','Reach',1.1],['Pause','Grip & pause',1.5],
    ['Turn','Lift & turn',2.3],['Return','Return & settle',normalizedArmMotion(config).returnDuration+FINAL_HOLD],
  ];
  let start=0;
  return spans.map(([phase,label,duration])=>{const step={phase,label,duration,start,end:start+duration};start+=duration;return step;});
}
export function armMotionPhase(seconds:number, config: ArmMotionConfig = {}, loop=true): ArmMotionPhase {
  const duration=armMotionDuration(config),t=loop?((seconds%duration)+duration)%duration:Math.max(0,Math.min(duration,seconds));
  return armMotionSteps(config).find(step=>t<step.end)?.phase??'Return';
}
type MotionKey = readonly [number,number,number,number,number];
function referenceKeys(config: ArmMotionConfig): readonly MotionKey[] {
  const end=RETURN_START+normalizedArmMotion(config).returnDuration;
  return [
    [0,0,98,-14,.65],[1.4,0,98,-14,.65],
    [2.5,14,70,-25,.65],[2.9,14,70,-25,.10],
    [3.5,14,70,-25,1],[4,14,70,-25,.12],
    [5.2,74,100,-5,.12],[6.3,74,100,-5,.12],
    [end,0,98,-14,.65],[end+FINAL_HOLD,0,98,-14,.65],
  ];
}
export function hardwareMotion(seconds:number, config: ArmMotionConfig = {}, loop=true):ArmPose {
  const settings=normalizedArmMotion(config),duration=armMotionDuration(settings);
  const t=loop?((seconds%duration)+duration)%duration:Math.max(0,Math.min(duration,seconds));
  const keys=referenceKeys(settings);
  let i=0;while(i<keys.length-2&&t>keys[i+1][0])i++;
  const a=keys[i],b=keys[i+1],u=Math.max(0,Math.min(1,(t-a[0])/(b[0]-a[0])));
  const k=settings.variant==='shaking'?u:smooth(u);
  const values=a.slice(1).map((value,index)=>value+(b[index+1]-value)*k);
  if(settings.variant==='shaking'){
    // The same connected rig oscillates around the commanded path. A short
    // settling tail makes the fault visible without moving the start/end pose.
    const moving=[[1.4,2.5],[4,5.2],[RETURN_START,RETURN_START+settings.returnDuration]];
    const envelope=Math.min(1,moving.reduce((sum,[start,end])=>sum+smooth((t-start)/.16)*(1-smooth((t-end)/.6)),0));
    const wave=Math.sin(t*Math.PI*2*4.2)+.28*Math.sin(t*Math.PI*2*7.1+.5);
    values[0]+=envelope*Math.sin(t*Math.PI*2*3.7)*1.5;
    values[1]+=envelope*wave*2.1;
    values[2]-=envelope*wave*3.1;
  }
  return {yaw:values[0],shoulder:values[1],forearm:values[2],grip:values[3]};
}
