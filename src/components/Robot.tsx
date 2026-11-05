import { useEffect, useRef, useState } from 'react';
import type { RobotScene } from './RobotScene';
import { BUILD_DURATION, INSPECT_DURATION, type MotionMode } from './robotMotion';
import { armMotionDuration, armFallbackPlaybackRate, normalizedArmMotion, type ArmMotionConfig } from './hardwareKinematics';
import { fitSquareAnchors, layoutJointLabels, type Point } from './robotLabels';
import stableJointTrack from './arm-stable-joints.json';
import shakingJointTrack from './arm-shaking-joints.json';
import './Robot.css';
import { JOINT_IDS, JOINTS, type HardwareJoint } from '../lib/hardware';

export type RobotJoint = HardwareJoint;
export type RobotMode = MotionMode;
export type RobotProps = { mode?: RobotMode; className?: string; activeJoint?: RobotJoint; onJointSelect?: (joint: RobotJoint) => void; playing?: boolean; speed?: number; title?: string; assembledParts?:number; loop?:boolean; playbackKey?:number; onPlaybackComplete?:()=>void; armMotion?:ArmMotionConfig };

/** Every screen uses the same watertight geometry, materials and articulated rig. */
export function Robot({ mode = 'hero', className = '', activeJoint = 'J2', onJointSelect, playing = mode !== 'arm', speed = 1, title, assembledParts, loop=true, playbackKey=0, onPlaybackComplete, armMotion }: RobotProps) {
  const armSettings=normalizedArmMotion(armMotion);
  const armSignature=`${armSettings.variant}:${armSettings.returnDuration}`;
  const armJointTrack=armSettings.variant==='shaking'?shakingJointTrack:stableJointTrack;
  const container = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null);
  const phase = useRef<HTMLSpanElement>(null);
  const jointLayer = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);
  const controls = useRef({ playing, speed, activeJoint, assembledParts, loop, playbackKey, onPlaybackComplete, armMotion:armSettings, armSignature });
  controls.current = { playing, speed, activeJoint, assembledParts, loop, playbackKey, onPlaybackComplete, armMotion:armSettings, armSignature };
  const completedPlayback = useRef<{mode:RobotMode;key:number}|null>(null);
  const videoPlayback = useRef<{element:HTMLVideoElement;mode:RobotMode;key:number;signature:string}|null>(null);
  useEffect(()=>{completedPlayback.current=null;},[mode,playbackKey,armSignature]);
  const finishPlayback = (key:number) => {
    const current=controls.current;
    if(current.loop||!current.playing||current.playbackKey!==key)return;
    if(completedPlayback.current?.mode===mode&&completedPlayback.current.key===key)return;
    completedPlayback.current={mode,key};
    current.onPlaybackComplete?.();
  };
  const visibleJoints=JOINT_IDS.slice(0,assembledParts??4);
  const label = title || (assembledParts!==undefined?`Arm assembly: ${visibleJoints.map(id=>JOINTS[id].name).join(', ')}`:mode === 'arm' ? 'Four-servo linkage arm: base rotation, shoulder, forearm linkage and geared gripper; passive wrist' : mode === 'inspect' ? 'BIT examines the evidence with a transparent magnifying glass' : mode === 'build' ? 'BIT picks up, lifts, carries and places a block' : 'BIT, your AI hardware debugging companion');
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
    layoutJointLabels(anchors.slice(0,buttons.length),width,height,sizes).forEach((p,i)=>{
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
    const mascotDuration=mode==='build'?BUILD_DURATION:mode==='inspect'?INSPECT_DURATION:9;
    let elapsed = 0, previous = 0, visible = true, renderedTime = -1, renderedJoint = '', renderedParts = -1, runKey=controls.current.playbackKey, renderedSignature=controls.current.armSignature;
    const resetFrameClock=()=>{previous=0;};
    document.addEventListener('visibilitychange',resetFrameClock);
    const tick = (now: number) => {
      const current=controls.current;
      const duration=mode==='arm'?armMotionDuration(current.armMotion):mascotDuration;
      if(renderedSignature!==current.armSignature){renderedSignature=current.armSignature;elapsed=0;previous=now;renderedTime=-1;completedPlayback.current=null;}
      if(runKey!==current.playbackKey){runKey=current.playbackKey;elapsed=0;previous=now;renderedTime=-1;}
      // A finite preview still completes if its model is scrolled offscreen.
      // The model and materials stay mounted when Replay resets its clock.
      if ((visible||!current.loop) && !document.hidden && scene) {
        if (current.playing) {
          if(!current.loop&&reduced.matches)elapsed=duration;
          else if(previous&&!reduced.matches)elapsed+=(current.loop?Math.min(now-previous,50):Math.max(0,now-previous))*current.speed/1000;
          if(!current.loop)elapsed=Math.min(elapsed,duration);
        }
        if (renderedTime !== elapsed || renderedJoint !== controls.current.activeJoint || renderedParts !== (controls.current.assembledParts??4)) {
          scene.render(elapsed, controls.current.activeJoint, controls.current.assembledParts, controls.current.armMotion);
          renderedTime = elapsed; renderedJoint = controls.current.activeJoint;renderedParts=controls.current.assembledParts??4;
          if (phase.current) phase.current.textContent = scene.phase;
        }
        if(mode==='arm')placeJoints(scene.jointAnchors);
        if(!current.loop&&elapsed>=duration)finishPlayback(runKey);
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    // Load the renderer separately so forms and task controls never wait for Three.js.
    import('./RobotScene').then(module => {
      if (cancelled) return;
      try {
        scene = module.createRobotScene(host, mode,controls.current.assembledParts); setUnavailable(false);
        observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
        observer.observe(host); frame = requestAnimationFrame(tick);
      } catch { setUnavailable(true); }
    }).catch(() => { if (!cancelled) setUnavailable(true); });
    return () => { cancelled = true; cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',resetFrameClock); observer?.disconnect(); scene?.dispose(); };
  }, [mode]);
  useEffect(() => {
    if (!unavailable || !video.current || assembledParts!==undefined) return;
    const element = video.current, reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true, frame = 0, cancelled=false;
    if(videoPlayback.current?.element!==element||videoPlayback.current.mode!==mode||videoPlayback.current.key!==playbackKey||videoPlayback.current.signature!==armSignature){
      element.currentTime=0;
      videoPlayback.current={element,mode,key:playbackKey,signature:armSignature};
    }
    const finish=()=>{if(!cancelled)finishPlayback(playbackKey);};
    const labels = () => {
      if(mode==='arm'&&visible&&!document.hidden){
        // Compatibility movies use the same rig/reference clock; retime only
        // the return segment so comparison values match the actual playback.
        const rate=armFallbackPlaybackRate(element.currentTime,armSettings);
        const playbackRate=Math.max(.0625,Math.min(16,speed*rate));
        if(Math.abs(element.playbackRate-playbackRate)>.001)element.playbackRate=playbackRate;
        const index=element.currentTime*armJointTrack.fps, a=Math.floor(index)%armJointTrack.frames.length, b=(a+1)%armJointTrack.frames.length, t=index-Math.floor(index);
        placeJoints(armJointTrack.frames[a].map((p,i)=>({x:p[0]+(armJointTrack.frames[b][i][0]-p[0])*t,y:p[1]+(armJointTrack.frames[b][i][1]-p[1])*t})),true);
      }
      frame=requestAnimationFrame(labels);
    };
    const sync = () => {
      const rate=mode==='arm'?armFallbackPlaybackRate(element.currentTime,armSettings):1;
      element.playbackRate = Math.max(.0625,Math.min(16,speed*rate));
      if(playing&&!loop&&(reduced.matches||element.error)){element.pause();finish();return;}
      if (playing && !reduced.matches && !document.hidden && (visible||!loop)) void element.play().catch(() => {if(!cancelled&&!loop)finish();});
      else element.pause();
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }); observer.observe(element);
    document.addEventListener('visibilitychange', sync); reduced.addEventListener('change', sync); element.addEventListener('loadeddata', sync);element.addEventListener('ended',finish);element.addEventListener('error',finish);sync(); if(mode==='arm')labels();
    return () => { cancelled=true;cancelAnimationFrame(frame);element.pause(); observer.disconnect(); document.removeEventListener('visibilitychange', sync); reduced.removeEventListener('change', sync); element.removeEventListener('loadeddata', sync);element.removeEventListener('ended',finish);element.removeEventListener('error',finish); };
  }, [unavailable, mode, playing, speed, assembledParts,loop,playbackKey,armSignature]);
  useEffect(()=>{
    if(!unavailable||assembledParts===undefined||mode!=='arm')return;
    const update=()=>placeJoints(armJointTrack.frames[0].map(p=>({x:p[0],y:p[1]})),true);
    const observer=new ResizeObserver(update);if(container.current)observer.observe(container.current);update();
    return()=>observer.disconnect();
  },[unavailable,assembledParts,mode,armSignature]);
  return <div className={`robot bit-robot bit-robot--${mode} ${className}`} data-robot-mode={mode} data-arm-variant={mode==='arm'?armSettings.variant:undefined} data-arm-duration={mode==='arm'?armMotionDuration(armSettings):undefined}>
    <div ref={container} className="robot-viewport" role="img" aria-label={label}/>
    {unavailable && assembledParts!==undefined && assembledParts>0 && <img className="robot-assembly-fallback" src={`/assets/robot/arm-assembly-${assembledParts}.png`} alt="" aria-hidden="true"/>}
    {unavailable && assembledParts===undefined && <video ref={video} className="robot-video" src={`/assets/robot/${mode==='arm'?`arm-${armSettings.variant}`:mode}-loop.mp4`} poster={`/assets/robot/${mode==='arm'?`arm-${armSettings.variant}`:mode}-poster.png`} muted loop={loop} playsInline preload="auto" aria-hidden="true"/>}
    {mode === 'arm' && onJointSelect && <div ref={jointLayer} className="robot-joints" aria-label="Choose a joint" style={{visibility:'hidden'}}>
      <svg className="robot-joint-leaders" aria-hidden="true">{visibleJoints.map(joint=><g key={joint} className={activeJoint===joint?'is-selected':''}><line/><circle r="3"/></g>)}</svg>
      {visibleJoints.map((joint, n) => <button type="button" key={joint} className={`robot-joint robot-joint--${n + 1} ${activeJoint === joint ? 'is-selected' : ''}`} onPointerDown={event=>{if(event.button===0)event.currentTarget.setPointerCapture(event.pointerId)}} onClick={() => onJointSelect(joint)} aria-pressed={activeJoint === joint}>{joint}<span>{JOINTS[joint].name}</span></button>)}
    </div>}
    {(mode === 'build' || mode === 'inspect') && <span className="robot-motion-caption" ref={phase} aria-hidden="true"/>}
  </div>;
}
export default Robot;
