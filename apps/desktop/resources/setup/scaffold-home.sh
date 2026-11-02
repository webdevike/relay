#!/usr/bin/env bash
# Create the ICM starter home base from resources/setup/starter-home/.
#
#   scaffold-home.sh <root> <answers.json>
#
# answers.json: {"userName": "Jane",
#                "assistants": [{"id": "nova", "name": "Nova", "purpose": "Everything personal", "model": "anthropic/claude-opus-5-5"}],
#                "firstWorkspace": {"name": "Acme", "description": "My consulting client"}}
#   (model and firstWorkspace are optional)
#
# Never overwrites an existing file: re-running only fills in what is missing. Writes
#   <root>/.omp/assistant/agents.json                      (the registry Relay Host reads)
#   <root>/.omp/assistant/agents/<id>/prime.md             (one persona per assistant)
#   <root>/work/agents/<id>/thread.md                      (the assistant's running notes)
# stdout: `OK <root> (<created> created, <kept> kept)` or `ERR <message>` (exit 1).
set -eEuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
install_err_trap

TEMPLATE="${RELAY_STARTER_HOME:-$HERE/starter-home}"
ROOT="${1:-}"
ANSWERS="${2:-}"
[ -n "$ROOT" ] && [ -n "$ANSWERS" ] || fail "usage: scaffold-home.sh <root> <answers.json>"
[ -d "$TEMPLATE" ] || fail "starter template not found at $TEMPLATE"
[ -f "$ANSWERS" ] || fail "answers file not found: $ANSWERS"
case "$ROOT" in "~"|"~/"*) ROOT="$HOME${ROOT#\~}" ;; esac
case "$ROOT" in /*) ;; *) fail "root must be an absolute path, got '$ROOT'" ;; esac
ROOT="${ROOT%/}"

# ---- answers (plutil reads JSON on every Mac; no jq) ----
ans() { plutil -extract "$1" raw -o - "$ANSWERS" 2>/dev/null || true; }
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
slugify() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//'; }

plutil -convert json -o /dev/null "$ANSWERS" >/dev/null 2>&1 || fail "answers file is not valid JSON"
USER_NAME="$(trim "$(ans userName)")"
[ -n "$USER_NAME" ] || fail "answers.userName is required"
COUNT="$(ans assistants)"
case "$COUNT" in ''|*[!0-9]*) COUNT=0 ;; esac
[ "$COUNT" -ge 1 ] || fail "answers.assistants needs at least one assistant"

A_ID=(); A_NAME=(); A_PURPOSE=(); A_MODEL=()
i=0
while [ "$i" -lt "$COUNT" ]; do
  name="$(trim "$(ans "assistants.$i.name")")"
  id="$(trim "$(ans "assistants.$i.id")")"
  [ -n "$name" ] || fail "assistants[$i].name is required"
  [ -n "$id" ] || id="$(slugify "$name")"
  printf '%s' "$id" | grep -Eq '^[a-z][a-z0-9-]*$' || fail "assistant id '$id' must match ^[a-z][a-z0-9-]*\$"
  j=0
  while [ "$j" -lt "${#A_ID[@]}" ]; do
    [ "${A_ID[$j]}" != "$id" ] || fail "duplicate assistant id '$id'"
    j=$((j + 1))
  done
  A_ID+=("$id"); A_NAME+=("$name")
  A_PURPOSE+=("$(trim "$(ans "assistants.$i.purpose")")")
  A_MODEL+=("$(trim "$(ans "assistants.$i.model")")")
  i=$((i + 1))
done
WS_NAME="$(trim "$(ans firstWorkspace.name)")"
WS_DESC="$(trim "$(ans firstWorkspace.description)")"
WS_SLUG=""
[ -n "$WS_NAME" ] && WS_SLUG="$(slugify "$WS_NAME")"
[ -z "$WS_NAME" ] || [ -n "$WS_SLUG" ] || fail "firstWorkspace.name has no usable letters or digits"

# ---- placeholder values ----
TODAY="$(date '+%Y-%m-%d')"
ASSISTANT_LIST=""; ASSISTANT_NAMES=""
i=0
while [ "$i" -lt "$COUNT" ]; do
  line="- **${A_NAME[$i]}** (\`${A_ID[$i]}\`)"
  [ -z "${A_PURPOSE[$i]}" ] || line="$line: ${A_PURPOSE[$i]}"
  ASSISTANT_LIST="${ASSISTANT_LIST:+$ASSISTANT_LIST
}$line"
  ASSISTANT_NAMES="${ASSISTANT_NAMES:+$ASSISTANT_NAMES, }${A_NAME[$i]}"
  i=$((i + 1))
done
if [ -n "$WS_NAME" ]; then
  WORKSPACE_INDEX="- \`workspaces/$WS_SLUG.md\`: ${WS_DESC:-$WS_NAME}"
else
  WORKSPACE_INDEX="- (none yet: copy \`.omp/templates/workspace.md\` to add the first card)"
fi

# Per-assistant values, set before filling an assistant's files.
V_assistantName=""; V_assistantId=""; V_assistantPurpose=""

CREATED=0; KEPT=0

# Replace {{placeholders}} in a text file we just created.
subst_file() {
  local f="$1" c
  case "$f" in *.md|*.json|*.yml|*.yaml|*.gitignore) ;; *) return 0 ;; esac
  grep -q '{{' "$f" || return 0
  c="$(cat "$f")"
  c="${c//\{\{userName\}\}/$USER_NAME}"
  c="${c//\{\{today\}\}/$TODAY}"
  c="${c//\{\{assistantList\}\}/$ASSISTANT_LIST}"
  c="${c//\{\{assistantNames\}\}/$ASSISTANT_NAMES}"
  c="${c//\{\{workspaceIndex\}\}/$WORKSPACE_INDEX}"
  c="${c//\{\{assistantName\}\}/$V_assistantName}"
  c="${c//\{\{assistantId\}\}/$V_assistantId}"
  c="${c//\{\{assistantPurpose\}\}/$V_assistantPurpose}"
  c="${c//\{\{homeRoot\}\}/$ROOT}"
  printf '%s\n' "$c" >"$f"
}

# Copy a template file to a destination unless it exists; fill placeholders in the new copy.
place() { # place <src> <dest>
  if [ -e "$2" ]; then KEPT=$((KEPT + 1)); return 0; fi
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  subst_file "$2"
  CREATED=$((CREATED + 1))
}

# Write stdin to a destination unless it exists.
place_text() { # place_text <dest> <<< content
  if [ -e "$1" ]; then cat >/dev/null; KEPT=$((KEPT + 1)); return 0; fi
  mkdir -p "$(dirname "$1")"
  cat >"$1"
  subst_file "$1"
  CREATED=$((CREATED + 1))
}

# Template names starting with `dot-` become dotfiles (packagers drop or hide real ones).
map_rel() {
  local rel="$1" out="" part oldifs="$IFS"
  IFS=/
  for part in $rel; do
    case "$part" in dot-*) part=".${part#dot-}" ;; esac
    out="${out:+$out/}$part"
  done
  IFS="$oldifs"
  printf '%s' "$out"
}

mkdir -p "$ROOT"

# ---- 1. the static tree ----
while IFS= read -r -d '' src; do
  rel="${src#"$TEMPLATE"/}"
  case "$rel" in *__ID__*|.DS_Store|*/.DS_Store) continue ;; esac
  place "$src" "$ROOT/$(map_rel "$rel")"
done < <(find "$TEMPLATE" -type f -print0 | sort -z)

# ---- 2. registry ----
ids_palette_paper=("#ffe3e3" "#e7f5ff" "#ebfbee" "#fff3bf" "#f3d9fa" "#d0ebff")
ids_palette_accent=("#1c7ed6" "#f76707" "#2f9e44" "#e03131" "#7048e8" "#0c8599")
registry="$ROOT/.omp/assistant/agents.json"
if [ -e "$registry" ]; then
  KEPT=$((KEPT + 1))
else
  mkdir -p "$(dirname "$registry")"
  {
    printf '{\n  "agents": [\n'
    i=0
    while [ "$i" -lt "$COUNT" ]; do
      p=$((i % ${#ids_palette_paper[@]}))
      printf '    {\n      "id": %s,\n      "title": %s' "\"$(json_esc "${A_ID[$i]}")\"" "\"$(json_esc "${A_NAME[$i]}")\""
      [ -z "${A_PURPOSE[$i]}" ] || printf ',\n      "scope": "%s"' "$(json_esc "${A_PURPOSE[$i]}")"
      [ -z "${A_MODEL[$i]}" ] || printf ',\n      "model": "%s"' "$(json_esc "${A_MODEL[$i]}")"
      printf ',\n      "avatar": {\n        "style": "micah",\n        "seed": "%s-%s",\n        "colors": { "paper": "%s", "accent": "%s" }\n      }\n    }' \
        "$(json_esc "${A_ID[$i]}")" "$((i + 1))" "${ids_palette_paper[$p]}" "${ids_palette_accent[$p]}"
      i=$((i + 1))
      [ "$i" -lt "$COUNT" ] && printf ','
      printf '\n'
    done
    printf '  ]\n}\n'
  } >"$registry"
  plutil -convert json -o /dev/null "$registry" >/dev/null 2>&1 || fail "generated agents.json is invalid"
  CREATED=$((CREATED + 1))
fi

# ---- 3. one persona and one thread file per assistant ----
PRIME_SRC="$TEMPLATE/dot-omp/assistant/agents/__ID__/prime.md"
THREAD_SRC="$TEMPLATE/dot-omp/assistant/thread.template.md"
i=0
while [ "$i" -lt "$COUNT" ]; do
  V_assistantId="${A_ID[$i]}"; V_assistantName="${A_NAME[$i]}"
  V_assistantPurpose="${A_PURPOSE[$i]:-General help with whatever $USER_NAME asks.}"
  [ ! -f "$PRIME_SRC" ] || place "$PRIME_SRC" "$ROOT/.omp/assistant/agents/$V_assistantId/prime.md"
  [ ! -f "$THREAD_SRC" ] || place "$THREAD_SRC" "$ROOT/work/agents/$V_assistantId/thread.md"
  i=$((i + 1))
done
V_assistantId=""; V_assistantName=""; V_assistantPurpose=""

# ---- 4. first workspace card ----
if [ -n "$WS_NAME" ]; then
  place_text "$ROOT/workspaces/$WS_SLUG.md" <<CARD
# $WS_NAME

${WS_DESC:-$WS_NAME}

## Rules
- (Add a standing rule that applies to every task here.)

## What to Load
| Task | Load |
|:--|:--|
| (task type) | \`workspaces/$WS_SLUG/<topic>.md\`, \`references/<file>.md\` |

## Deliverables
- (Add: what you produce here and who reads it.)
CARD
fi

chmod 700 "$ROOT/secrets" 2>/dev/null || true
ok "$ROOT ($CREATED created, $KEPT kept)"
