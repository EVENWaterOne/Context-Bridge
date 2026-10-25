import { useEffect, useId, useRef } from 'react';
import './Robot.css';

export type RobotJoint = 'J1' | 'J2' | 'J3';
export type RobotMode = 'hero' | 'inspect' | 'build' | 'arm';
export type RobotProps = { mode?: RobotMode; className?: string; activeJoint?: RobotJoint; onJointSelect?: (joint: RobotJoint) => void; playing?: boolean; speed?: number; title?: string };
const ROOT = '/assets/robot/';
const deg = 180 / Math.PI;
const origin = { x: 460, y: 349 };
const elbow = { x: 713, y: 167 };
const wrist = { x: 975, y: 365 };
const l1 = Math.hypot(elbow.x - origin.x, elbow.y - origin.y);
const l2 = Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y);
const originalA = Math.atan2(elbow.y - origin.y, elbow.x - origin.x);
const originalB = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x) - originalA;
const ease = (v: number) => v * v * (3 - 2 * v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function inverseKinematics(x: number, y: number) {
  const dx = x - origin.x, dy = y - origin.y;
  const b = Math.acos(Math.max(-1, Math.min(1, (dx * dx + dy * dy - l1 * l1 - l2 * l2) / (2 * l1 * l2))));
  const a = Math.atan2(dy, dx) - Math.atan2(l2 * Math.sin(b), l1 + l2 * Math.cos(b));
  return [(a - originalA) * deg, (b - originalB) * deg];
}
// A complete, continuous pick / close / lift / carry / lower / release cycle.
const buildKeys = [
  [0, 910, 330, 1], [.17, 975, 365, 1], [.25, 975, 365, 0],
  [.43, 950, 260, 0], [.60, 995, 285, 0], [.75, 975, 365, 0],
  [.84, 975, 365, 1], [1, 910, 330, 1],
];
function buildPose(t: number) {
  let i = 0; while (i < buildKeys.length - 2 && t > buildKeys[i + 1][0]) i++;
  const a = buildKeys[i], b = buildKeys[i + 1];
  const k = ease((t - a[0]) / (b[0] - a[0]));
  return { x: lerp(a[1], b[1], k), y: lerp(a[2], b[2], k), open: lerp(a[3], b[3], k), held: t >= .25 && t <= .75 };
}

/** One shared render rig. Source pixels and materials are never regenerated per route. */
export default function Robot({ mode = 'hero', className = '', activeJoint = 'J2', onJointSelect, playing = mode !== 'arm', speed = 1, title }: RobotProps) {
  const uid = useId().replace(/:/g, '');
  const shoulderRef = useRef<SVGGElement>(null);
  const elbowRef = useRef<SVGGElement>(null);
  const wristRef = useRef<SVGGElement>(null);
  const leftRef = useRef<SVGGElement>(null);
  const rightRef = useRef<SVGGElement>(null);
  const cubeRef = useRef<SVGGElement>(null);
  const armLowerRef = useRef<SVGGElement>(null);
  const armUpperRef = useRef<SVGGElement>(null);
  const phaseRef = useRef<HTMLSpanElement>(null);
  const id = (name: string) => `${uid}-${name}`;
  const clip = (name: string) => `url(#${id(name)})`;
  const GlassBlock = () => <g>
    <path d="M981 542L1159 527Q1194 525 1192 562L1187 681Q1182 703 1142 707L994 713Q957 709 957 672L954 573Q954 548 981 542Z" fill={`url(#${id('block-color')})`} stroke="#fff5" strokeWidth="3"/>
    <path d="M981 542L1159 527Q1194 525 1192 562L1187 681Q1182 703 1142 707L994 713Q957 709 957 672L954 573Q954 548 981 542Z" fill={`url(#${id('block-yellow')})`}/>
    <g clipPath={clip('block-texture')}>{raster('bit-build.png')}</g>
    <path d="M967 554L1011 574Q1025 579 1025 600V698M1017 576L1176 551" fill="none" stroke="#ffffff90" strokeWidth="4" strokeLinecap="round"/>
    <path d="M975 552L1153 536Q1183 534 1181 563L1177 676Q1174 694 1143 697L994 704Q969 700 968 674V573" fill="none" stroke="#ffffff55" strokeWidth="2"/>
  </g>;
  const raster = (src: string) => <image href={`${ROOT}${src}`} x="0" y="0" width="1254" height="1254" />;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, elapsed = 0, previous = 0;
    let lastLabel = '';
    const frame = (now: number) => {
      if (previous && !document.hidden && playing && !reduced.matches) elapsed += Math.min(now - previous, 60) * speed;
      previous = now;
      const seconds = elapsed / 1000;
      if (mode === 'inspect' || mode === 'build' || mode === 'hero') {
        const t = (seconds % 7.2) / 7.2;
        const pose = mode === 'build' ? buildPose(t) : mode === 'hero' ? { x: 850 + Math.sin(seconds * .7) * 12, y: 320 + Math.cos(seconds * .65) * 12, open: .7 + Math.sin(seconds * .8) * .2, held: false } : { x: 940 + Math.cos(seconds * .8) * 36, y: 365 + Math.sin(seconds * 1.15) * 52, open: 0, held: false };
        const [a, b] = inverseKinematics(pose.x, pose.y);
        shoulderRef.current?.setAttribute('transform', `rotate(${a} 460 349)`);
        elbowRef.current?.setAttribute('transform', `rotate(${b} 713 167)`);
        wristRef.current?.setAttribute('transform', `rotate(${-a - b} 975 365)`);
        leftRef.current?.setAttribute('transform', `rotate(${pose.open * 10} 980 440)`);
        rightRef.current?.setAttribute('transform', `rotate(${-pose.open * 8} 1040 430)`);
        cubeRef.current?.setAttribute('transform', pose.held ? `translate(${pose.x - 975} ${pose.y - 365})` : 'translate(0 0)');
        const label = mode === 'inspect' ? (t < .35 ? 'Finding the relevant context' : t < .7 ? 'Checking the evidence' : 'Connecting code and hardware') : (t < .17 ? 'Reaching for the change' : t < .25 ? 'Securing the change' : t < .43 ? 'Lifting it into place' : t < .6 ? 'Updating your project' : t < .75 ? 'Placing the change' : 'Checking the result');
        if (phaseRef.current && label !== lastLabel) { phaseRef.current.textContent = label; lastLabel = label; }
      } else {
        const v = Math.sin(seconds * 1.15) * (playing ? 1 : 0);
        armLowerRef.current?.setAttribute('transform', `rotate(${v * 3.3} 280 790)`);
        armUpperRef.current?.setAttribute('transform', `rotate(${v * -6.8} 485 190)`);
      }
      if (playing && !reduced.matches) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mode, playing, speed]);

  if (mode === 'arm') return <div className={`robot bit-robot bit-robot--arm ${className}`} data-robot-mode={mode}>
    <svg viewBox="0 0 1254 1254" role="img" aria-label={title || 'Three-joint robot arm with matte grey housing'}>
      <defs>
        <mask id={id('arm-alpha')}><image href={`${ROOT}arm-alpha.png`} width="1254" height="1254" /></mask>
        <clipPath id={id('arm-base')}><path d="M0 900L160 890L230 855L400 840L550 850L600 900H1254V1254H0Z" /></clipPath>
        <clipPath id={id('arm-lower')}><path d="M0 0H400V280L543 480L480 745L555 907L393 953L160 910L80 795Z" /></clipPath>
        <clipPath id={id('arm-upper')}><path d="M400 0H1254V700L880 690L602 490L520 330L400 290Z" /></clipPath>
      </defs>
      <g mask={clip('arm-alpha')} clipPath={clip('arm-base')}>{raster('arm-rgb.jpg')}</g>
      <g ref={armLowerRef} data-rig="armLowerRef">
        <g mask={clip('arm-alpha')} clipPath={clip('arm-lower')}>{raster('arm-rgb.jpg')}</g>
        <g ref={armUpperRef} data-rig="armUpperRef"><g mask={clip('arm-alpha')} clipPath={clip('arm-upper')}>{raster('arm-rgb.jpg')}</g></g>
      </g>
    </svg>
    {onJointSelect && <div className="robot-joints" aria-label="Choose a joint">
      {(['J1', 'J2', 'J3'] as const).map((joint, n) => <button type="button" key={joint} className={`robot-joint robot-joint--${n + 1} ${activeJoint === joint ? 'is-selected' : ''}`} onClick={() => onJointSelect(joint)} aria-pressed={activeJoint === joint}><span />{joint}{activeJoint === joint ? ` · ${['base', 'elbow', 'gripper'][n]}` : ''}</button>)}
    </div>}
  </div>;

  return <div className={`robot bit-robot bit-robot--${mode} ${className}`} data-robot-mode={mode}>
    {mode === 'inspect' && <div className="robot-evidence" aria-hidden="true"><div><span /><span /><span /></div><div><span /><span /></div></div>}
    <svg viewBox={mode === 'hero' ? "80 0 1120 1254" : "80 0 1220 1254"} role="img" aria-label={title || (mode === 'hero' ? 'BIT, your AI hardware debugging companion' : mode === 'inspect' ? 'BIT moves a clear magnifying glass to examine the evidence' : 'BIT reaches, grips, lifts, carries and places a block')}>
      <defs>
        <linearGradient id={id('block-color')} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#35e4df"/><stop offset=".42" stopColor="#8b7cf1"/><stop offset=".8" stopColor="#eb75d5"/><stop offset="1" stopColor="#ff99a0"/></linearGradient>
        <linearGradient id={id('block-yellow')} x1="0" y1="0" x2="0" y2="1"><stop offset=".15" stopColor="#f8e965" stopOpacity="0"/><stop offset="1" stopColor="#ffe525"/></linearGradient>
        <clipPath id={id('shoulder-base')}><path d="M395 349H603V454H395Z" /></clipPath>
        <clipPath id={id('body')}><path d="M0 420H855V1254H0Z" /></clipPath>
        <clipPath id={id('upper')}><path d="M390 426L390 300L651 137L675 123L732 204L595 358L596 426Z" /></clipPath>
        <clipPath id={id('lower')}><path d="M650 85L780 84L1044 311L1045 411L975 453L902 414L697 235L650 202Z" /></clipPath>
        <clipPath id={id('palm')}><path d="M907 383L975 368L1049 386L1050 445L1016 479L946 473L916 438Z" /></clipPath>
        <clipPath id={id('left-claw')}><path d="M889 443L942 425L1000 474L1034 562L1018 594L976 605L896 564Z" /></clipPath>
        <clipPath id={id('right-claw')}><path d="M1020 385L1079 383L1181 469L1175 533L1115 543L1026 466Z" /></clipPath>
        <clipPath id={id('lens')}><path d="M1028 516H1114V654L1254 670V1040H880V667L1028 650Z" /></clipPath>
        <clipPath id={id('block-texture')}><path d="M1034 542L1115 541L1168 537L1191 538L1186 683L1151 703L992 707L958 690V610H1034Z" /></clipPath>
        <clipPath id={id('cube')}><path d="M1002 525L1198 521V710H942V582L993 591L1028 570L1018 546Z" /></clipPath>
        <clipPath id={id('stack')}><rect x="930" y="710" width="280" height="370" /></clipPath>
      </defs>
      <g clipPath={clip('body')}>{raster('bit-build.png')}</g>
      {mode === 'build' && <>
        <g clipPath={clip('stack')}>{raster('bit-build.png')}</g>
        <g ref={cubeRef} data-rig="cubeRef"><GlassBlock /></g>
      </>}
      <g ref={shoulderRef} data-rig="shoulderRef">
        <g clipPath={clip('upper')}>{raster('bit-build.png')}</g>
        <g ref={elbowRef} data-rig="elbowRef">
          <g clipPath={clip('lower')}>{raster('bit-build.png')}</g>
          <g ref={wristRef} data-rig="wristRef">
            {mode === 'inspect' && <g clipPath={clip('lens')}>{raster('bit-inspect.png')}</g>}
            <g clipPath={clip('palm')}>{raster('bit-build.png')}</g>
            <g ref={leftRef} data-rig="leftRef"><g clipPath={clip('left-claw')}>{raster('bit-inspect.png')}</g></g>
            <g ref={rightRef} data-rig="rightRef"><g clipPath={clip('right-claw')}>{raster('bit-inspect.png')}</g></g>
          </g>
        </g>
      </g>
      <g clipPath={clip('shoulder-base')}>{raster('bit-build.png')}</g>
    </svg>
    {mode !== 'hero' && <span className="robot-motion-caption" ref={phaseRef} aria-hidden="true">{mode === 'inspect' ? 'Checking the evidence' : 'Updating your project'}</span>}
  </div>;
}

export { Robot };
