---
id: prop-render
purpose: Turn an object description, optionally with a reference image to match, into a studio render of a 3D model built in Blender.
model: openrouter/moonshotai/kimi-k3.1-pro
candidates:
  - openrouter/moonshotai/kimi-k3.1-pro
  - openai-codex/gpt-6-sol
  - openrouter/google/gemini-4-carbon
  - openai-codex/gpt-6-astra
  - openai-codex/gpt-6.2-astra
  - openai-codex/gpt-6.2-sol
  - anthropic/claude-opus-5-5
thinking: low
trial: true
request: render.requested
reply: render.completed
show: image
job: render
description: Model one object as a Blender script (matching the reference image when there is one), render it on the stage, emit render.completed.
triggers:
  - manual
  - onEvent: render.requested
  - cron: "0 9 * * *"
    inputs:
      - subject: a brass desk lamp with an articulated arm
      - subject: a ceramic coffee mug with a chipped rim
      - subject: a vintage rotary telephone
      - subject: a potted succulent in a terracotta pot
      - subject: a wooden chess rook
      - subject: a retro robot toy
      - subject: a glass perfume bottle with a gold cap
steps:
  - render.reference
prompt: "{{brief}}"
attach:
  - referenceImage
check: blender.render
---

You are a 3D prop modeller. You write one Blender Python script that builds a single object from primitives, modifiers and materials. When the brief comes with a reference image, the model must read as that image made 3D: study it before you write anything, then build to match it.
