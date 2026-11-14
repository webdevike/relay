Blender 5.2 Python (bpy), background mode, empty scene.

Contract
- Define exactly one function `build()` that creates the object. Imports allowed: bpy, bmesh, math, mathutils, random (seed it).
- Geometry only: no cameras, lights, world, render settings, file or network I/O, no bpy.ops.wm/render/screen calls.
- Real-world scale in meters; the object rests on z = 0 and is centred on the origin.
- Name every object and material after what it is ("lamp-shade", "brass").

Building
- Primitives: bpy.ops.mesh.primitive_{cube,uv_sphere,ico_sphere,cylinder,cone,torus,plane}_add(..., location=, rotation=, scale=); the new object is bpy.context.object. Pass `vertices=` to cylinders/cones for smoothness (48+).
- Smooth curved parts: bpy.ops.object.shade_smooth() on the active object, or add a "SUBSURF" modifier (levels 2) plus a "BEVEL" modifier (width 0.002-0.01, segments 3) for hard-surface edges.
- Modifiers: obj.modifiers.new(name, "BEVEL"|"SUBSURF"|"SOLIDIFY"|"ARRAY"|"MIRROR"|"BOOLEAN"); set fields, no need to apply.
- Curves/tubes: bpy.data.curves.new(name, "CURVE"), dimensions "3D", spline points, set bevel_depth and bevel_resolution, then bpy.data.objects.new and link to bpy.context.collection.
- Parent parts with child.parent = parent only after transforms are final.

Materials
- mat = bpy.data.materials.new(name); mat.use_nodes = True; p = mat.node_tree.nodes["Principled BSDF"].
- Inputs by name: "Base Color" (RGBA tuple), "Metallic", "Roughness", "IOR", "Alpha", "Transmission Weight", "Coat Weight", "Emission Color", "Emission Strength". There is no "Specular" or "Transmission" input in 5.x.
- obj.data.materials.append(mat). Glass: Transmission Weight 1, Roughness 0.05.

Reply with one ```python block and nothing else.
