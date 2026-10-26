import {useState} from 'react';
import {Robot} from './Robot';
import {JOINT_IDS,JOINTS,pendingCalibration,type HardwareJoint} from '../lib/hardware';
import {assembledCount,existingArmAssembly,parseServoDraft,servoDraft,type HardwareAssembly,type ServoDraft} from '../lib/assembly';
import type {Hardware,Task} from '../lib/workflow';
import './HardwareSetup.css';

const partCopy={
  J1:{title:'Start with the base.',description:'Add the servo that turns the whole arm left and right.',added:'Base rotation'},
  J2:{title:'Give it a shoulder.',description:'Add the base-mounted servo that raises and lowers the upper arm.',added:'Shoulder + upper arm'},
  J3:{title:'Extend the forearm.',description:'The opposite base-mounted servo drives the forearm through a linkage. The elbow pivot is passive.',added:'Forearm + linkage'},
  J4:{title:'Finish with the gripper.',description:'One servo opens and closes both jaws. This arm has no independent wrist motor.',added:'Coupled gripper'},
};
const futureHardware=[['Mobile robot','Wheels & steering'],['Soft robot','Flexible actuators'],['Biped robot','Legs & balance']] as const;
type Props={task:Task;onChange:(patch:Partial<Hardware>)=>void;onName:(name:string)=>void;onFinish:()=>void;onFiles:()=>void;onLeave:()=>void};

export function HardwareSetup({task,onChange,onName,onFinish,onFiles,onLeave}:Props){
  const assembly=task.hardware.assembly??existingArmAssembly(),count=assembledCount(assembly);
  const step=Math.max(0,Math.min(assembly.step,count+1,5));
  const joint=JOINT_IDS[Math.max(0,Math.min(step-1,3))];
  const calibration=task.hardware.servoCalibration??pendingCalibration();
  const draft=assembly.drafts[joint]??servoDraft(assembly.parts[joint],calibration[joint]);
  const [error,setError]=useState('');
  const editing=!!assembly.parts[joint];
  function patchAssembly(patch:Partial<HardwareAssembly>){setError('');onChange({assembly:{...assembly,...patch}})}
  function setStep(next:number){patchAssembly({step:next})}
  function patchDraft(patch:Partial<ServoDraft>){patchAssembly({drafts:{...assembly.drafts,[joint]:{...draft,...patch}}})}
  function submit(){
    if(step===0){if(assembly.category)setStep(1);return;}
    if(step===5){onFinish();return;}
    const parsed=parseServoDraft(draft,joint,assembly);
    if('error' in parsed){setError(parsed.error);return;}
    const drafts={...assembly.drafts};delete drafts[joint];
    onChange({configured:false,assembly:{...assembly,parts:{...assembly.parts,[joint]:parsed.part},drafts,step:count===4?5:step+1},servoCalibration:{...calibration,[joint]:parsed.calibration}});
    setError('');
  }
  const currentTitle=step===0?'A little context.\nOne part at a time.':step===5?'Your arm, assembled.':partCopy[joint].title;
  return <div className="hardware-setup">
    <div className="hardware-builder">
      <section className="assembly-column" aria-label="Hardware assembly preview">
        <div className="assembly-heading"><span className="eyebrow">YOUR BUILD</span><span className="mono" aria-live="polite">{count} / 4 PARTS ADDED</span></div>
        <h1>{count===0?'Start with a blank workbench.':count===4?'3 axes. One gripper.':`${count} part${count===1?'':'s'}. Taking shape.`}</h1>
        <div className={`assembly-stage ${count===0?'is-empty':''}`} data-part-count={count}>
          {count>0?<Robot mode="arm" assembledParts={count} activeJoint={step>0&&step<5&&editing?joint:JOINT_IDS[count-1]} onJointSelect={id=>setStep(JOINT_IDS.indexOf(id)+1)} playing={false}/>:<div className="assembly-empty"><div className="workbench-outline" aria-hidden="true"/><p>Your hardware will take shape here.</p><span>Add a part on the right to begin.</span></div>}
        </div>
        <div className="assembly-parts" aria-label="Added parts">
          {JOINT_IDS.map((id,index)=><button key={id} type="button" className={`${index<count?'is-added':''} ${step===index+1?'is-current':''}`} disabled={!assembly.category||index>count} onClick={()=>setStep(index+1)} aria-current={step===index+1?'step':undefined}><span className="part-index">{id}</span><span>{JOINTS[id].name}</span><small>{index<count?'Added':step===index+1?'Adding':'Next'}</small></button>)}
        </div>
        <p className="assembly-note">{count===4?'Same structure throughout your task. Select a part to review it.':'Only confirmed parts appear in your build.'}</p>
      </section>

      <form id="hardware-setup-form" className="assembly-form" onSubmit={event=>{event.preventDefault();submit()}}>
        <span className="eyebrow">{step===0?'01 / CHOOSE YOUR HARDWARE':step===5?'READY / CHECK YOUR BUILD':`${joint} / ${editing?'EDIT':'ADD'} ${JOINTS[joint].name.toUpperCase()}`}</span>
        <h2>{currentTitle}</h2>
        {step===0?<>
          <p className="muted">What are you building? We’ll map its moving parts together.</p>
          <button className={`hardware-category ${assembly.category?'selected':''}`} type="button" aria-pressed={!!assembly.category} onClick={()=>patchAssembly({category:'robot-arm'})}>
            <span className="category-top"><span className="category-type">ROBOTICS</span><span className="category-status">Available in demo</span></span><strong>Robot arm</strong><span>Base → shoulder → forearm → gripper</span><span className="category-bottom"><small>4-servo linkage arm</small><span aria-hidden="true">↗</span></span>
          </button>
          <div className="future-hardware" role="group" aria-label="Other hardware categories">
            {futureHardware.map(([name,description])=><button key={name} type="button" className="hardware-coming" disabled aria-label={`${name} — not available in this demo`}><strong>{name}</strong><span>{description}</span><small>Not in demo</small></button>)}
          </div>
          <p className="fine">More kinds of builds. One shared workflow.<br/>This demo supports the 4-servo linkage arm.</p>
        </>:step<5?<>
          <p className="muted part-description">{partCopy[joint].description}</p>
          <div className="part-parameter-fields">
            <label>Servo model<input maxLength={60} required value={draft.model} onChange={event=>patchDraft({model:event.target.value})} placeholder="e.g. SG90"/></label>
            <label>Control pin / channel <span className="optional">Optional</span><input maxLength={30} value={draft.pin} onChange={event=>patchDraft({pin:event.target.value})} placeholder="e.g. GPIO 18"/></label>
          </div>
          <div className="servo-limit-section">
            <label className="limit-toggle"><input type="checkbox" aria-label="Enter measured angle limits" checked={draft.calibrate} onChange={event=>patchDraft({calibrate:event.target.checked})}/><span>Enter measured angle limits</span><small>{draft.calibrate?'Set now':'Optional'}</small></label>
            {draft.calibrate?<div className="servo-limit-fields">
              <div className="angle-fields">{(['min','max','zero'] as const).map(key=><label key={key}>{key==='min'?'Minimum':key==='max'?'Maximum':'Home / zero'}<span className="angle-input"><input type="number" step="any" required value={draft[key]} onChange={event=>patchDraft({[key]:event.target.value})} aria-label={`${JOINTS[joint].name} ${key} angle`}/><span>°</span></span></label>)}</div>
              <label>Positive command direction<select value={draft.direction} onChange={event=>patchDraft({direction:Number(event.target.value) as 1|-1})}><option value={1}>Increase servo angle (+)</option><option value={-1}>Decrease servo angle (−)</option></select></label>
              <p className="fine">Use the measured servo range. Home / zero must be inside it.</p>
            </div>:<p className="fine">Not calibrated yet? Leave it pending and add limits later.</p>}
          </div>
          <div className="part-add-note"><span className="mono">ADDS TO YOUR BUILD</span><p>{partCopy[joint].added}</p></div>
        </>:<>
          <p className="muted">Check the parts, then choose how your controller connects.</p>
          <div className="assembly-review" aria-label="Configured servos">{JOINT_IDS.map(id=><div key={id}><span className="mono">{id}</span><div><strong>{JOINTS[id].name} <span>· {assembly.parts[id]?.model}</span></strong><small>{assembly.parts[id]?.pin||'Pin not set'} · {calibration[id]?`${calibration[id]!.min}–${calibration[id]!.max}°`:'Limits pending'}</small></div><button type="button" className="text-button" onClick={()=>setStep(JOINT_IDS.indexOf(id)+1)} aria-label={`Edit ${JOINTS[id].name}`}>Edit</button></div>)}</div>
          <div className="connection-fields"><label>Controller<select required value={task.hardware.controller} onChange={event=>onChange({controller:event.target.value})}><option value="" disabled>Choose controller</option><option>ESP32</option><option>STM32F103C8T6</option><option>Arduino</option><option>Raspberry Pi + ESP32</option><option>Other</option></select></label><label>Connection<select required value={task.hardware.connection} onChange={event=>onChange({connection:event.target.value})}><option value="" disabled>Choose connection</option><option>USB serial · 115200 baud</option><option>Wi-Fi</option><option>Bluetooth</option></select></label></div>
          <details className="setup-context"><summary>Task & project files <span>{task.files.length} files</span></summary><label>Task name<input required value={task.name} onChange={event=>onName(event.target.value)}/></label><button type="button" className="button" onClick={onFiles}>{task.files.length?'View project files':'Add project files'}</button></details>
          <p className="fine">Unmeasured angles stay pending. The next step is a simulated first run.</p>
        </>}
        {error&&<p className="setup-error" role="alert">{error}</p>}
      </form>
    </div>
    <footer className="hardware-setup-actions"><button type="button" className="text-button setup-save" onClick={onLeave}>Save & leave</button><div>{step>0&&<button type="button" className="button" onClick={()=>setStep(step-1)}>Back</button>}<button type="submit" form="hardware-setup-form" className="button primary" disabled={step===0&&!assembly.category}>{step===0?'Start with the base →':step===5?'Use this setup →':editing?'Save part →':`Add ${JOINTS[joint].name.toLowerCase()} →`}</button></div></footer>
  </div>;
}
