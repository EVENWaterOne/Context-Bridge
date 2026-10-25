import fs from 'node:fs';
import { createRobotModel } from '../src/components/RobotScene.ts';
const fps = 16;
const cacheDir = process.env.ROBOT_RENDER_CACHE || '.render-cache/v3';
fs.mkdirSync(cacheDir,{recursive:true});
for (const mode of ['hero','arm','inspect','build']) {
  const model = createRobotModel(mode), nodes = [], geometries = {}, materials = {};
  model.scene.traverse(o => {
    if (o.isMesh && o.material.type === 'ShadowMaterial') return;
    if (!o.isMesh && !o.isGroup && !o.isPointLight) return;
    nodes.push({id:o.uuid,parent:o.parent?.isScene?null:o.parent?.uuid,geometry:o.geometry?.uuid,material:o.material?.uuid,light:o.isPointLight?{color:o.color.toArray(),intensity:o.intensity}:undefined});
    if (o.isMesh) {
      const g=o.geometry,m=o.material;
      if (!geometries[g.uuid]) geometries[g.uuid] = {position:Array.from(g.attributes.position.array),normal:Array.from(g.attributes.normal.array),index:g.index?Array.from(g.index.array):null,color:g.attributes.color?Array.from(g.attributes.color.array):null};
      materials[m.uuid] = {color:m.color.toArray(),roughness:m.roughness,metalness:m.metalness,emissive:m.emissive.toArray(),intensity:m.emissiveIntensity,transmission:m.transmission??0,alpha:m.opacity,vertexColors:m.vertexColors,clearcoat:m.clearcoat??0};
    }
  });
  const lookup = new Map(); model.scene.traverse(o=>lookup.set(o.uuid,o));
  const duration = {hero:9,arm:7.2,inspect:10,build:12}[mode],frames=[];
  for (let f=0; f<Math.round(duration*fps); f++) {
    model.update(f/fps,'J2');
    frames.push(nodes.map(n=>{const o=lookup.get(n.id);return [...o.position.toArray(),...o.quaternion.toArray(),...o.scale.toArray(),Number(o.visible)];}));
  }
  fs.writeFileSync(`${cacheDir}/${mode}.json`,JSON.stringify({mode,fps,nodes,geometries,materials,frames,camera:{position:model.camera.position.toArray(),quaternion:model.camera.quaternion.toArray(),scale:model.camera.top-model.camera.bottom}}));
  console.log(`${mode}: ${nodes.length} nodes, ${frames.length} frames`);model.dispose();
}
