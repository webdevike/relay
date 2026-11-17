"""Print the installed Soundly app's API constants as one JSON line.

Run with the app's own interpreter, from its Resources dir (soundly.ts does this):
    PYTHONHOME=<Resources> PYTHONPATH=<Resources>/lib/python39.zip:<Resources>/lib/python3.9:<Resources>/lib/python3.9/lib-dynload \
        /Applications/Soundly.app/Contents/MacOS/python app_constants.py

The app's code is SourceDefender-encrypted (.pye); its bundled `sourcedefender` import hook loads it. Reading the
values from the installed build (instead of copying them) keeps the agent working when an update rotates them.
`server_token` is an app-wide constant (the same in every install), not Isaac's credential.
"""
import json
import os
import sys

# Soundly.py's order: stdlib first (on a case-insensitive disk scripts/dataClasses.pye would shadow `dataclasses`),
# then `scripts` appended and `dependencies` in front.
import dataclasses, sqlite3, re, uuid, base64, hmac, copy, pathlib, queue, asyncio, csv  # noqa: E401,F401

sys.path.append("scripts")
sys.path.insert(0, "dependencies")
for base in ("scripts", "dependencies"):
    for root, _dirs, _files in os.walk(base):
        if root != base:
            sys.path.append(root)

from PyQt5 import sip  # noqa: E402

sys.modules["sip"] = sip
import sourcedefender  # noqa: E402,F401  (installs the .pye import hook)

# The app's modules import each other in a cycle; masterController first resolves it, as the app's main does.
import masterController  # noqa: E402,F401
import cloudServer  # noqa: E402
import sharedVariables  # noqa: E402

print(json.dumps({
    "server": sharedVariables.ServerUrl,
    "semanticServer": sharedVariables.SemanticSearchUrl,
    "token": cloudServer.SERVER_TOKEN,
    "clientId": sharedVariables.ClientID,
    "version": str(sharedVariables.Version),
    "build": str(sharedVariables.Build),
}))
