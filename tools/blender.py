#!/usr/bin/env python3
"""Run Python in the live Blender through the MCP for Blender add-on socket (tests only).

    tools/blender.py 'print(bpy.context.mode)'
    tools/blender.py --state            mode, active object, vertex count, modifiers
    tools/blender.py --reset            back to the default scene Buddy's tests start from
"""
import json
import os
import socket
import sys

PORT = int(os.environ.get("BLENDER_PORT", "9877"))

PRELUDE = '''
import bpy
def ctx():
    win = bpy.context.window_manager.windows[0]
    area = next(a for a in win.screen.areas if a.type == 'VIEW_3D')
    region = next(r for r in area.regions if r.type == 'WINDOW')
    return bpy.context.temp_override(window=win, screen=win.screen, area=area, region=region)
'''

STATE = '''
ob = bpy.context.view_layer.objects.active
if ob and ob.mode == 'EDIT':
    ob.update_from_editmode()
print(bpy.context.mode, ob.name if ob else None,
      len(ob.data.vertices) if ob and ob.type == 'MESH' else '-',
      [m.name for m in ob.modifiers] if ob else [],
      tuple(round(s, 2) for s in ob.scale) if ob else '-',
      sorted(o.name for o in bpy.context.scene.objects))
'''

# Leaves only the default Cube, Light and Camera, in Object Mode with the Cube active.
RESET = '''
with ctx():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
for o in list(bpy.context.scene.objects):
    if o.name not in ('Cube', 'Light', 'Camera'):
        bpy.data.objects.remove(o, do_unlink=True)
cube = bpy.data.objects['Cube']
for m in list(cube.modifiers):
    cube.modifiers.remove(m)
for o in bpy.context.scene.objects:
    o.select_set(o.name == 'Cube')
bpy.context.view_layer.objects.active = cube
'''


def run(code: str) -> str:
    with socket.create_connection(("127.0.0.1", PORT), timeout=10) as s:
        s.sendall(json.dumps({"type": "execute_code", "params": {"code": PRELUDE + code}}).encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                raise SystemExit("Blender closed the connection")
            buf += chunk
            try:
                reply = json.loads(buf)
            except ValueError:
                continue
            result = reply.get("result") or {}
            if reply.get("status") != "success" or result.get("error"):
                raise SystemExit(f"Blender error: {reply.get('message') or result.get('error')}")
            return result.get("result", "")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "--state"
    if arg == "--reset":
        run(RESET)
        arg = "--state"
    print(run(STATE if arg == "--state" else arg), end="")
