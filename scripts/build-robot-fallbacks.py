"""Run with Python 3.11 + bpy 4.3 + numpy<2; ffmpeg must be on PATH."""
import sys, subprocess, shutil, os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
subprocess.run(['node','--experimental-strip-types','scripts/export-robot-scenes.mjs'],check=True)
output=Path('public/assets/robot');output.mkdir(parents=True,exist_ok=True)
def render(mode):
 if (output/f'{mode}-loop.mp4').exists() and (output/f'{mode}-poster.png').exists():return
 with open(f'.render-cache/{mode}-render.log','w') as log:
  subprocess.run([sys.executable,'scripts/render-robot-fallback.py',mode,'--animation'],stdout=log,stderr=subprocess.STDOUT,check=True)
 shutil.copyfile(f'.render-cache/{mode}/frame-0001.png',output/f'{mode}-poster.png')
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate','16','-i',f'.render-cache/{mode}/frame-%04d.png','-f','lavfi','-i','color=c=0xf3f3ef:s=416x416:r=16','-filter_complex','[1:v][0:v]overlay=shortest=1:format=auto,format=yuv420p','-c:v','libx264','-preset','fast','-crf','20','-movflags','+faststart',str(output/f'{mode}-loop.mp4')],check=True)
 print(f'{mode}: video and poster ready',flush=True)
with ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(render,['hero','arm','inspect','build']))
