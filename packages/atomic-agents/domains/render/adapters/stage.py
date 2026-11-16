# prop-render stage: runs the model's build() in an empty scene, exports the bare model as GLB, then
# owns everything else (floor, lights, camera framing, render settings) so the agent only ever writes geometry.
# Usage: blender -b --factory-startup -noaudio --python-exit-code 1 --python stage.py -- <script.py> <out.png> <out.glb>
import math
import sys
import traceback

import bpy
from mathutils import Vector

script, out, glb = sys.argv[sys.argv.index("--") + 1:]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

try:
    namespace = {"__name__": "prop"}
    with open(script) as source:
        exec(compile(source.read(), script, "exec"), namespace)
    # Some scripts call build() themselves at module level; calling it again would duplicate the model.
    if not scene.objects:
        if "build" not in namespace:
            raise RuntimeError("script must define build()")
        namespace["build"]()
except Exception:
    print("STAGE_ERROR")
    traceback.print_exc()
    raise

# The agent owns geometry only.
for obj in list(scene.objects):
    if obj.type in {"CAMERA", "LIGHT"}:
        bpy.data.objects.remove(obj, do_unlink=True)

solids = [o for o in scene.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} and not o.hide_render]
if not solids:
    print("STAGE_ERROR")
    raise RuntimeError("build() created no visible geometry")

# The bare model, before the stage adds anything: modifiers applied, no floor, lights or camera.
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", export_apply=True, export_cameras=False, export_lights=False)

bpy.context.view_layer.update()
corners = [o.matrix_world @ Vector(c) for o in solids for c in o.bound_box]
low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center = (low + high) / 2
radius = max((high - low).length / 2, 0.01)

# Floor: a large matte plane just under the object.
bpy.ops.mesh.primitive_plane_add(size=radius * 400, location=(center.x, center.y, low.z - radius * 0.001))
floor = bpy.context.object
floor_mat = bpy.data.materials.new("stage-floor")
floor_mat.use_nodes = True
bsdf = floor_mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.62, 0.62, 0.64, 1)
bsdf.inputs["Roughness"].default_value = 0.85
floor.data.materials.append(floor_mat)

# Soft studio world.
world = bpy.data.worlds.new("stage-world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.78, 0.8, 0.84, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
scene.world = world

target = bpy.data.objects.new("stage-target", None)
scene.collection.objects.link(target)
target.location = center


def aim(obj):
    constraint = obj.constraints.new("TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"


def light(name, offset, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy * radius * radius
    data.size = size * radius
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = center + offset * radius
    aim(obj)


light("key", Vector((2.5, -3.0, 3.5)), 900, 3)
light("fill", Vector((-3.5, -2.0, 1.5)), 250, 4)
light("rim", Vector((0.5, 4.0, 3.0)), 500, 2)

camera_data = bpy.data.cameras.new("stage-camera")
camera_data.lens = 50
camera = bpy.data.objects.new("stage-camera", camera_data)
scene.collection.objects.link(camera)
fov = 2 * math.atan(camera_data.sensor_width / (2 * camera_data.lens))
distance = radius / math.sin(fov / 2) * 1.12
camera.location = center + Vector((1.0, -1.45, 0.75)).normalized() * distance
camera_data.clip_end = distance * 500
aim(camera)
scene.camera = camera

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 768
scene.render.resolution_y = 768
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
print("STAGE_OK", out)
