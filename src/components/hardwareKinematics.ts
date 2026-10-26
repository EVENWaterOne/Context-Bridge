import { ARM_DURATION, smooth } from './robotMotion.ts';

export interface ArmPose { yaw: number; shoulder: number; forearm: number; grip: number }
export interface PlanarPoint { x: number; y: number }
// Drawing-space proportions inferred from the assembly photos, not millimetres.
export const ARM_DIMENSIONS = { shoulderHeight: .97, upper: 1.52, forearm: 1.62, driveCrank: .53, referenceOffset: .48, toolBracket: .34 } as const;
export const DEMO_POSE_BOUNDS = { yaw: [-24,24], shoulder: [55,108], forearm: [-32,24], grip: [0,1] } as const;
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
// Deliberately modest illustrative motion, NOT the mechanism's calibrated limits.
const keys: readonly (readonly [number,number,number,number,number])[] = [
  [0,0,100,-8,.5],[.12,0,100,-8,.5],[.38,18,65,-24,1],
  [.50,18,65,-24,.05],[.69,-14,88,13,.05],[.90,0,100,-8,.5],[1,0,100,-8,.5],
];
export function hardwareMotion(seconds:number):ArmPose {
  const t=((seconds%ARM_DURATION)+ARM_DURATION)%ARM_DURATION/ARM_DURATION;
  let i=0;while(i<keys.length-2&&t>keys[i+1][0])i++;
  const a=keys[i],b=keys[i+1],k=smooth((t-a[0])/(b[0]-a[0]));
  const values=a.slice(1).map((value,index)=>value+(b[index+1]-value)*k);
  return {yaw:values[0],shoulder:values[1],forearm:values[2],grip:values[3]};
}
