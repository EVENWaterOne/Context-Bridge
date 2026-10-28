"""Rebuild the shared 3D rig's compatibility movies. Python 3.11, bpy 4.3, numpy<2, ffmpeg.
Uses Mesa software rendering when a GPU is unavailable. The source fingerprint keeps
cached frames consistent; completed public assets are replaced only after encoding.
"""
import sys, subprocess, shutil, os, hashlib, json
from pathlib import Path
from queue import Queue
from concurrent.futures import ThreadPoolExecutor
modes=os.environ.get('ROBOT_RENDER_MODES','arm,hero,inspect,build').split(',')
if not modes or any(mode not in ['arm','hero','inspect','build'] for mode in modes):raise ValueError('Unknown render mode')
sources=['src/components/HardwareArm.ts','src/components/hardwareKinematics.ts','src/lib/hardware.ts','src/components/RobotScene.ts','src/components/robotMotion.ts','scripts/export-robot-scenes.mjs','scripts/render-robot-fallback.py','scripts/build-robot-fallbacks.py']
fingerprint=hashlib.sha256(b''.join(Path(p).read_bytes() for p in sources)).hexdigest()[:12]
cache=Path('.render-cache')/fingerprint;cache.mkdir(parents=True,exist_ok=True)
output=Path('public/assets/robot');output.mkdir(parents=True,exist_ok=True)
threads=max(1,len(os.sched_getaffinity(0))//2) if hasattr(os,'sched_getaffinity') else 3
environment={**os.environ,'ROBOT_RENDER_CACHE':str(cache),'ROBOT_RENDER_ENGINE':os.environ.get('ROBOT_RENDER_ENGINE','BLENDER_EEVEE_NEXT'),'LIBGL_ALWAYS_SOFTWARE':'1','EGL_PLATFORM':'surfaceless','LP_NUM_THREADS':str(threads),'ROBOT_RENDER_THREADS':str(threads)}
subprocess.run(['node','--experimental-strip-types','scripts/export-robot-scenes.mjs'],env=environment,check=True)
print(f'Render cache: {cache}',flush=True)
slots=Queue()
for slot in range(2):slots.put(slot)
def render(mode):
 slot=slots.get()
 try:
  movie=cache/f'{mode}-loop.mp4';poster=cache/f'{mode}-poster.png'
  if not movie.exists():
   with open(cache/f'{mode}-render.log','w') as log:
    subprocess.run([sys.executable,'scripts/render-robot-fallback.py',mode,'--animation'],env={**environment,'ROBOT_RENDER_SLOT':str(slot)},stdout=log,stderr=subprocess.STDOUT,check=True)
   shutil.copyfile(cache/mode/'frame-0001.png',poster)
   size=768 if mode=='hero' else 576
   fps=json.loads((cache/f'{mode}.json').read_text())['fps']
   temporary=cache/f'{mode}-encoding.mp4'
   subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate',str(fps),'-i',str(cache/mode/'frame-%04d.png'),'-f','lavfi','-i',f'color=c=0xf3f3ef:s={size}x{size}:r={fps}','-filter_complex','[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p','-c:v','libx264','-preset','fast','-crf','18','-movflags','+faststart',str(temporary)],check=True)
   temporary.replace(movie)
  for source in [movie,poster]:
   temporary=output/(source.name+'.tmp');shutil.copyfile(source,temporary);temporary.replace(output/source.name)
  print(f'{mode}: video and poster ready',flush=True)
 finally:slots.put(slot)
with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(render,modes))
