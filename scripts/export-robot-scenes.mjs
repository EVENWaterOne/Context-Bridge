import fs from 'node:fs';
import { createRobotModel } from '../src/components/RobotScene.ts';
const fps = 16;
const assemblyStills=process.env.ROBOT_ASSEMBLY_STILLS==='1';
const cacheDir = process.env.ROBOT_RENDER_CACHE || '.render-cache/v3';
fs.mkdirSync(cacheDir,{recursive:true});
const modes=(process.env.ROBOT_RENDER_MODES || 'hero,arm,inspect,build').split(',');
if(assemblyStills&&modes.some(mode=>mode!=='arm'))throw new Error('Assembly stills support the hardware arm only');
if(modes.some(mode=>!['hero','arm','inspect','build'].includes(mode)))throw new Error('Unknown render mode');
for (const mode of modes) {
  const model = createRobotModel(mode), nodes = [], geometries = {}, materials = {};
  model.update(0,mode==='arm'?'':'J2');
  model.scene.traverse(o => {
    if (o.isMesh && o.material.type === 'ShadowMaterial') return;
    if (!o.isMesh && !o.isGroup && !o.isPointLight) return;
    nodes.push({id:o.uuid,parent:o.parent?.isScene?null:o.parent?.uuid,geometry:o.geometry?.uuid,material:o.material?.uuid,light:o.isPointLight?{color:o.color.toArray(),intensity:o.intensity}:undefined});
    if (o.isMesh) {
      const g=o.geometry,m=o.material;
      if (!geometries[g.uuid]) geometries[g.uuid] = {position:Array.from(g.attributes.position.array),normal:Array.from(g.attributes.normal.array),index:g.index?Array.from(g.index.array):null,color:g.attributes.color?Array.from(g.attributes.color.array):null};
      materials[m.uuid] = {color:m.color.toArray(),roughness:m.roughness,metalness:m.metalness,emissive:m.emissive.toArray(),intensity:m.emissiveIntensity,transmission:m.transmission??0,alpha:m.opacity,vertexColors:m.vertexColors,clearcoat:m.clearcoat??0,specularIntensity:m.specularIntensity??1};
    }
  });
  const lookup = new Map(); model.scene.traverse(o=>lookup.set(o.uuid,o));
  const duration = {hero:9,arm:7.2,inspect:10,build:12}[mode],frames=[],jointFrames=[];
  for (let f=0; f<(assemblyStills?4:Math.round(duration*fps)); f++) {
    if(assemblyStills)model.setAssembly(f+1);
    model.update(assemblyStills?0:f/fps,mode==='arm'?'':'J2');
    if(mode==='arm')jointFrames.push(model.jointAnchors.map(p=>[Number(p.x.toFixed(6)),Number(p.y.toFixed(6))]));
    frames.push(nodes.map(n=>{const o=lookup.get(n.id);return [...o.position.toArray(),...o.quaternion.toArray(),...o.scale.toArray(),Number(o.visible)];}));
  }
  fs.writeFileSync(`${cacheDir}/${mode}.json`,JSON.stringify({mode,fps,nodes,geometries,materials,frames,camera:{position:model.camera.position.toArray(),quaternion:model.camera.quaternion.toArray(),scale:model.camera.top-model.camera.bottom}}));
  if(mode==='arm'&&!assemblyStills)fs.writeFileSync('src/components/armJointTrack.json',JSON.stringify({fps,frames:jointFrames})+'\n');
  console.log(`${mode}: ${nodes.length} nodes, ${frames.length} frames`);model.dispose();
}
