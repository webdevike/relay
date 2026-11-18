Blender 5.2 Python (bpy), background mode, empty scene.

Contract

- Define exactly one function `build()` that creates the object. Imports allowed: bpy, bmesh, math, mathutils, random (seed it).
- Geometry only: no cameras, lights, world, render settings, file or network I/O, no bpy.ops.wm/render/screen calls. The stage lights and frames the object itself.
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

Matching a reference image

- When an image is attached, it is the target. Before the code, list what you see as comments at the top of the script: the overall silhouette and its height-to-width ratio, every major part and where it sits relative to the others (stacked, attached on a side, wrapping around), relative sizes, each material (metal, stone, glass, plastic, emissive) and its color as an RGB value read off the image.
- Build that list part by part, keeping the proportions you measured; a part the reference shows prominently must be there and roughly the right size. Keep its stylization (chunky toy-like, smooth, chamfered) rather than turning it realistic.
- Colors: pick Base Color from the image's mid-tones, not its highlights or shadows. Glowing parts get Emission Color and Emission Strength 2-8.
- Small detail (leaves, grass tufts, rivets, flowers) is worth a few cheap instanced primitives when the reference shows a lot of it; it carries the look.
- Set the camera angle at module level, outside build(): `VIEW = {"azimuth": A, "elevation": E}` in degrees. Build the object facing -Y (its front toward the default camera). Azimuth 0 looks straight at that front; positive moves the camera toward +X, so the side on the right of the front view shows more (the reference shows its right-hand side: positive; its left-hand side: negative). Elevation is the camera's height above the horizon: 0 level, 30 a typical three-quarter view, 60 steep. Read A and E off the reference. Without a reference, leave VIEW out (the default is about 35 and 23).

Reply with one ```python block and nothing else.
