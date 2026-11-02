import { JOINT_IDS, validCalibration, type HardwareJoint, type ServoCalibration, type ServoLimits } from './hardware.ts';

export interface ServoPart { model: string; pin: string }
export interface ServoDraft { model: string; pin: string; calibrate: boolean; min: string; max: string; zero: string; direction: 1 | -1 }
export interface HardwareAssembly {
  category: 'robot-arm' | null;
  /** 0: category, 1–4: actuator, 5: review. */
  step: number;
  parts: Partial<Record<HardwareJoint, ServoPart>>;
  drafts: Partial<Record<HardwareJoint, ServoDraft>>;
}
export const emptyAssembly = (): HardwareAssembly => ({category:null,step:0,parts:{},drafts:{}});
export const existingArmAssembly = (): HardwareAssembly => ({category:'robot-arm',step:5,parts:Object.fromEntries(JOINT_IDS.map(joint=>[joint,{model:'SG90',pin:''}])),drafts:{}});
/** A disconnected downstream part must never reveal an otherwise missing arm. */
export function assembledCount(assembly: HardwareAssembly): number {
  if(assembly.category!=='robot-arm')return 0;
  const firstMissing=JOINT_IDS.findIndex(joint=>!assembly.parts[joint]);
  return firstMissing<0?4:firstMissing;
}
export function servoDraft(part?:ServoPart,calibration?:ServoCalibration|null):ServoDraft {
  return {model:part?.model??'SG90',pin:part?.pin??'',calibrate:!!calibration,min:calibration?String(calibration.min):'',max:calibration?String(calibration.max):'',zero:calibration?String(calibration.zero):'',direction:calibration?.direction??1};
}
/** GPIO 18, IO18 and 18 are one pin, as are D9, Pin 9 and 9. A0 and PA8 keep their letters. */
const pinKey=(pin:string)=>pin.trim().toUpperCase().replace(/^(?:PIN\s*)?(?:GPIO|IO|D)?\s*(?=\d)/, '').replace(/\s+/g,'');
export function parseServoDraft(draft:ServoDraft,joint:HardwareJoint,assembly:HardwareAssembly):{part:ServoPart;calibration:ServoCalibration|null}|{error:string} {
  const part={model:draft.model.trim(),pin:draft.pin.trim()};
  if(!part.model)return {error:'Enter a servo model before adding this part.'};
  if(part.pin&&JOINT_IDS.some(id=>id!==joint&&assembly.parts[id]?.pin&&pinKey(assembly.parts[id]!.pin)===pinKey(part.pin)))return {error:'This pin or channel is already assigned to another servo.'};
  if(!draft.calibrate)return {part,calibration:null};
  if([draft.min,draft.max,draft.zero].some(value=>!value.trim()))return {error:'Enter all three angles, or leave limits for later.'};
  const calibration={min:Number(draft.min),max:Number(draft.max),zero:Number(draft.zero),direction:draft.direction};
  if(!validCalibration(calibration))return {error:'Minimum must be below maximum, with home / zero inside that range.'};
  return {part,calibration};
}
export function assemblyReady(assembly:HardwareAssembly,limits:ServoLimits):boolean {
  if(assembledCount(assembly)!==4)return false;
  return JOINT_IDS.every(joint=>!('error' in parseServoDraft(servoDraft(assembly.parts[joint],limits[joint]),joint,assembly)));
}
