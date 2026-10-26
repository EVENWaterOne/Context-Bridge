import { JOINT_IDS, JOINTS, type HardwareJoint, type ServoLimits } from '../lib/hardware';

export function HardwareSummary({selected,onSelect,calibration}:{selected:HardwareJoint;onSelect:(joint:HardwareJoint)=>void;calibration:ServoLimits}) {
  return <section className="hardware-profile" aria-label="Physical arm configuration">
    <div className="hardware-profile-heading"><strong>4 SG90 servos</strong><span>3 arm axes + 1 gripper</span></div>
    <div className="hardware-axis-list" role="group" aria-label="Select an actuator">
      {JOINT_IDS.map(id=><button type="button" key={id} className={selected===id?'selected':''} aria-pressed={selected===id} onClick={()=>onSelect(id)}><span className="mono">{id}</span><span>{JOINTS[id].motion}</span></button>)}
    </div>
    <p className="hardware-joint-detail">{JOINTS[selected].detail}</p>
    <details className="hardware-calibration"><summary>Servo calibration <span>{JOINT_IDS.every(id=>calibration[id])?'Configured':'Pending'}</span></summary>
      <table><thead><tr><th>Axis</th><th>Min / max</th><th>Zero</th><th>Direction</th></tr></thead><tbody>{JOINT_IDS.map(id=>{
        const c=calibration[id];return <tr key={id}><th>{id}</th><td>{c?`${c.min}° / ${c.max}°`:'Not supplied'}</td><td>{c?`${c.zero}°`:'—'}</td><td>{c?(c.direction===1?'+':'−'):'—'}</td></tr>;
      })}</tbody></table>
      <p>The specification lists a 180° maximum claw opening, not calibrated servo limits. Preview poses are illustrative until min/max, zero and direction are supplied.</p>
    </details>
  </section>;
}
