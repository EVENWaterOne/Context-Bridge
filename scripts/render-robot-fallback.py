"""Render the exact Three.js rig exported by export-robot-scenes.mjs with Blender 4.3.
Used for visual QA and a video fallback when WebGL is unavailable. No image cutouts.
"""
import json, math, sys, os
from pathlib import Path
mode=sys.argv[1] if len(sys.argv)>1 else 'hero'
render_cpus=sorted(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else []
def allocate_render_threads():
 active=[m for m in ['hero','arm','inspect','build'] if not Path(f'public/assets/robot/{m}-loop.mp4').exists()]
 if not render_cpus or mode not in active:return 3
 count=max(1,len(render_cpus)//min(3,len(active)))
 slot=active.index(mode)%3;selected=render_cpus[slot*count:(slot+1)*count] or render_cpus[:count]
 os.sched_setaffinity(0,selected)
 return len(selected)
initial_threads=allocate_render_threads()
import bpy
from mathutils import Quaternion
from pathlib import Path
mode=sys.argv[1] if len(sys.argv)>1 else 'hero'
animate='--animation' in sys.argv
source=json.loads(Path(f'.render-cache/{mode}.json').read_text())
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=4 if animate else 12
scene.cycles.use_denoising=True;scene.cycles.max_bounces=3;scene.cycles.diffuse_bounces=1;scene.cycles.glossy_bounces=2;scene.cycles.transmission_bounces=4
scene.render.resolution_x=416 if animate else 512;scene.render.resolution_y=scene.render.resolution_x;scene.render.resolution_percentage=100
scene.render.threads_mode='FIXED';scene.render.threads=initial_threads
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.render.film_transparent=True
# Fade weak environment shadows into the uniform UI surface; preserve solid geometry.
scene.use_nodes=True;tree=scene.node_tree;tree.nodes.clear()
layer=tree.nodes.new('CompositorNodeRLayers');power=tree.nodes.new('CompositorNodeMath');power.operation='POWER';power.inputs[1].default_value=3
alpha=tree.nodes.new('CompositorNodeSetAlpha');out=tree.nodes.new('CompositorNodeComposite')
tree.links.new(layer.outputs['Alpha'],power.inputs[0]);tree.links.new(layer.outputs['Image'],alpha.inputs['Image']);tree.links.new(power.outputs[0],alpha.inputs['Alpha']);tree.links.new(alpha.outputs[0],out.inputs[0])
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=0
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.78,.80,.79,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.25
root=bpy.data.objects.new('Y-up to Z-up',None);scene.collection.objects.link(root);root.rotation_euler.x=math.pi/2
materials={}
for key,m in source['materials'].items():
 mat=bpy.data.materials.new(key);mat.use_nodes=True;p=mat.node_tree.nodes.get('Principled BSDF')
 p.inputs['Base Color'].default_value=(*m['color'],1)
 p.inputs['Roughness'].default_value=m['roughness'];p.inputs['Metallic'].default_value=m['metalness']
 p.inputs['Transmission Weight'].default_value=m['transmission'];p.inputs['IOR'].default_value=1.46
 p.inputs['Coat Weight'].default_value=m['clearcoat'];p.inputs['Coat Roughness'].default_value=.32
 p.inputs['Emission Color'].default_value=(*m['emissive'],1);p.inputs['Emission Strength'].default_value=m['intensity']
 if m['vertexColors']:
  c=mat.node_tree.nodes.new('ShaderNodeVertexColor');c.layer_name='Col'
  mat.node_tree.links.new(c.outputs['Color'],p.inputs['Base Color']);mat.node_tree.links.new(c.outputs['Color'],p.inputs['Emission Color'])
 if m['transmission']>.95:
  # A thin optical lens: retain a crisp clear centre with a small Fresnel reflection.
  p.inputs['IOR'].default_value=1.12
  transparent=mat.node_tree.nodes.new('ShaderNodeBsdfTransparent')
  combine=mat.node_tree.nodes.new('ShaderNodeMixShader');combine.inputs[0].default_value=.14
  mat.node_tree.links.new(transparent.outputs[0],combine.inputs[1]);mat.node_tree.links.new(p.outputs[0],combine.inputs[2])
  mat.node_tree.links.new(combine.outputs[0],mat.node_tree.nodes.get('Material Output').inputs['Surface'])
 materials[key]=mat
geometries={}
for key,g in source['geometries'].items():
 vertices=list(zip(*[iter(g['position'])]*3));indices=g['index'] or list(range(len(vertices)));faces=list(zip(*[iter(indices)]*3))
 data=bpy.data.meshes.new(key);data.from_pydata(vertices,[],faces);data.update()
 for polygon in data.polygons:polygon.use_smooth=True
 data.normals_split_custom_set_from_vertices(list(zip(*[iter(g['normal'])]*3)))
 if g['color']:
  c=data.color_attributes.new(name='Col',type='FLOAT_COLOR',domain='CORNER')
  for i,loop in enumerate(data.loops):
   j=loop.vertex_index*3;c.data[i].color=(*g['color'][j:j+3],1)
  data.update()
 
 geometries[key]=data
objects={}
for n in source['nodes']:
 data=geometries.get(n.get('geometry'));o=bpy.data.objects.new(n['id'],data);scene.collection.objects.link(o);objects[n['id']]=o
 o.rotation_mode='QUATERNION'
 if data is not None:
  o.data.materials.append(materials[n['material']])
for n in source['nodes']:objects[n['id']].parent=objects.get(n['parent'],root)
for f,values in enumerate(source['frames'],1):
 for n,v in zip(source['nodes'],values):
  o=objects[n['id']];o.location=v[:3];o.rotation_quaternion=(v[6],v[3],v[4],v[5]);o.scale=v[7:10];o.hide_render=not bool(v[10]) or bool(n.get('material') and source['materials'][n['material']]['transmission']>.95)
  for path in ['location','rotation_quaternion','scale','hide_render']:o.keyframe_insert(data_path=path,frame=f)
for o in objects.values():
 if o.animation_data:
  for curve in o.animation_data.action.fcurves:
   for point in curve.keyframe_points:point.interpolation='LINEAR'
# Large studio softboxes, all neutral white.
def light(name,position,power,size):
 data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
 o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.parent=root;o.location=position
 from mathutils import Vector
 o.rotation_euler=(Vector((.2,2,0))-o.location).to_track_quat('-Z','Y').to_euler()
light('Key softbox',(-3,7,7),420,5)
light('Fill softbox',(5,4,2),200,4)
light('Rim softbox',(0,6,-4),500,4)
# Neutral ground and background, matching the product surface.
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.05));floor=bpy.context.object;floor.is_shadow_catcher=True
mat=bpy.data.materials.new('Workbench');mat.use_nodes=True
p=mat.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(.896,.896,.863,1);p.inputs['Roughness'].default_value=.85;floor.data.materials.append(mat)
camdata=bpy.data.cameras.new('Camera');camera=bpy.data.objects.new('Camera',camdata);scene.collection.objects.link(camera);camera.parent=root
camdata.type='ORTHO';camdata.ortho_scale=source['camera']['scale'];camera.location=source['camera']['position']
q=source['camera']['quaternion'];camera.rotation_mode='QUATERNION';camera.rotation_quaternion=(q[3],q[0],q[1],q[2]);scene.camera=camera
scene.render.fps=source['fps'];scene.frame_start=1;scene.frame_end=len(source['frames'])
folder=Path('.render-cache')/mode;folder.mkdir(exist_ok=True)
if animate:
 for frame in range(scene.frame_start,scene.frame_end+1):
  target=folder/f'frame-{frame:04d}.png'
  if target.exists():continue
  scene.render.threads=allocate_render_threads();scene.frame_set(frame);scene.render.filepath=str(target);bpy.ops.render.render(write_still=True)
else:
 frame={'hero':1,'arm':40,'inspect':55,'build':110}[mode];scene.frame_set(frame);scene.render.filepath=str(folder/'preview.png');bpy.ops.render.render(write_still=True)
