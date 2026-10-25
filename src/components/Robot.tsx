import { useEffect, useRef, useState } from 'react';
import type { RobotScene } from './RobotScene';
import type { MotionMode } from './robotMotion';
import { fitSquareAnchors, layoutJointLabels, type Point } from './robotLabels';
import armJointTrack from './armJointTrack.json';
import './Robot.css';

export type RobotJoint = 'J1' | 'J2' | 'J3';
export type RobotMode = MotionMode;
export type RobotProps = { mode?: RobotMode; className?: string; activeJoint?: RobotJoint; onJointSelect?: (joint: RobotJoint) => void; playing?: boolean; speed?: number; title?: string };

/** Every screen uses the same watertight geometry, materials and articulated rig. */
export function Robot({ mode = 'hero', className = '', activeJoint = 'J2', onJointSelect, playing = mode !== 'arm', speed = 1, title }: RobotProps) {
  const container = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  const phase = useRef<HTMLSpanElement>(null);
  const jointLayer = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  const controls = useRef({ playing, speed, activeJoint });
  controls.current = { playing, speed, activeJoint };
  const label = title || (mode === 'arm' ? 'Articulated robot arm, matte grey with yellow joint accents' : mode === 'inspect' ? 'BIT examines the evidence with a transparent magnifying glass' : mode === 'build' ? 'BIT picks up, lifts, carries and places a block' : 'BIT, your AI hardware debugging companion');
  const placeJoints = (points:Point[], square=false) => {
    const layer=jointLayer.current, host=container.current;
    if(!layer||!host)return;
    const width=host.clientWidth,height=host.clientHeight;
    if(!width||!height)return;
    const buttons=Array.from(layer.querySelectorAll<HTMLButtonElement>('.robot-joint'));
    const leaders=Array.from(layer.querySelectorAll<SVGLineElement>('line'));
    const pins=Array.from(layer.querySelectorAll<SVGCircleElement>('circle'));
    const anchors=square?fitSquareAnchors(points,width,height):points;
    const sizes=buttons.map(b=>({width:b.offsetWidth,height:b.offsetHeight}));
    layoutJointLabels(anchors,width,height,sizes).forEach((p,i)=>{
      buttons[i].style.left=`${p.x}px`;buttons[i].style.top=`${p.y-sizes[i].height/2}px`;
      for(const [key,value] of Object.entries({x1:p.pin.x,y1:p.pin.y,x2:p.end.x,y2:p.end.y}))leaders[i].setAttribute(key,String(value));
      pins[i].setAttribute('cx',String(p.pin.x));pins[i].setAttribute('cy',String(p.pin.y));
    });
    layer.style.visibility='visible';
  };
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let frame = 0, scene: RobotScene | undefined, cancelled = false, observer: IntersectionObserver | undefined;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let elapsed = 0, previous = 0, visible = true, renderedTime = -1, renderedJoint = '';
    const tick = (now: number) => {
      if (visible && !document.hidden && scene) {
        if (previous && controls.current.playing && !reduced.matches) elapsed += Math.min(now - previous, 50) * controls.current.speed / 1000;
        if (renderedTime !== elapsed || renderedJoint !== controls.current.activeJoint) {
          scene.render(elapsed, controls.current.activeJoint);
          renderedTime = elapsed; renderedJoint = controls.current.activeJoint;
          if (phase.current) phase.current.textContent = scene.phase;
        }
        if(mode==='arm')placeJoints(scene.jointAnchors);
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    // Load the renderer separately so forms and task controls never wait for Three.js.
    import('./RobotScene').then(module => {
      if (cancelled) return;
      try {
        scene = module.createRobotScene(host, mode); setUnavailable(false);
        observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
        observer.observe(host); frame = requestAnimationFrame(tick);
      } catch { setUnavailable(true); }
    }).catch(() => { if (!cancelled) setUnavailable(true); });
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); scene?.dispose(); };
  }, [mode]);
  useEffect(() => {
    if (!unavailable || !video.current) return;
    const element = video.current, reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true, frame = 0;
    const labels = () => {
      if(mode==='arm'&&visible&&!document.hidden){
        const index=element.currentTime*armJointTrack.fps, a=Math.floor(index)%armJointTrack.frames.length, b=(a+1)%armJointTrack.frames.length, t=index-Math.floor(index);
        placeJoints(armJointTrack.frames[a].map((p,i)=>({x:p[0]+(armJointTrack.frames[b][i][0]-p[0])*t,y:p[1]+(armJointTrack.frames[b][i][1]-p[1])*t})),true);
      }
      frame=requestAnimationFrame(labels);
    };
    const sync = () => {
      element.playbackRate = speed;
      if (playing && !reduced.matches && !document.hidden && visible) void element.play().catch(() => {});
      else element.pause();
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }); observer.observe(element);
    document.addEventListener('visibilitychange', sync); reduced.addEventListener('change', sync); element.addEventListener('loadeddata', sync); sync(); if(mode==='arm')labels();
    return () => { cancelAnimationFrame(frame);element.pause(); observer.disconnect(); document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync); element.removeEventListener('loadeddata', sync); };
  }, [unavailable, mode, playing, speed]);
  return <div className={`robot bit-robot bit-robot--${mode} ${className}`} data-robot-mode={mode}>
    <div ref={container} className="robot-viewport" role="img" aria-label={label}/>
    {unavailable && <video ref={video} className="robot-video" src={`/assets/robot/${mode}-loop.mp4`} poster={`/assets/robot/${mode}-poster.png`} muted loop playsInline preload="auto" aria-hidden="true"/>}
    {mode === 'arm' && onJointSelect && <div ref={jointLayer} className="robot-joints" aria-label="Choose a joint" style={{visibility:'hidden'}}>
      <svg className="robot-joint-leaders" aria-hidden="true">{(['J1','J2','J3'] as const).map(joint=><g key={joint} className={activeJoint===joint?'is-selected':''}><line/><circle r="3"/></g>)}</svg>
      {(['J1', 'J2', 'J3'] as const).map((joint, n) => <button type="button" key={joint} className={`robot-joint robot-joint--${n + 1} ${activeJoint === joint ? 'is-selected' : ''}`} onPointerDown={event=>{if(event.button===0)event.currentTarget.setPointerCapture(event.pointerId)}} onClick={() => onJointSelect(joint)} aria-pressed={activeJoint === joint}>{joint}<span>{['Base', 'Elbow', 'Gripper'][n]}</span></button>)}
    </div>}
    {(mode === 'build' || mode === 'inspect') && <span className="robot-motion-caption" ref={phase} aria-hidden="true"/>}
  </div>;
}
export default Robot;
