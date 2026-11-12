# Composer shape (pill, card, dictation, hold)

The assistant thread's composer (`apps/mobile/src/agents/composerShape.machine.ts`, run by `AssistantComposer`). `idle` is the floating pill; `opening` is the card rising with the keyboard before the field reports focus, and it falls back to the pill if the focus never comes (`FOCUS_TIMEOUT`), so the card never sits open with no keyboard. `typing` has the keyboard up.

`tapDictating` fills the field with live words after a mic tap; keys wait until it lands, then the field is the draft again (typing if the keyboard is still up). `holding` is a walkie-talkie hold on the pill or the mic. Being offline only stops the mic and the hold (`online`); the field stays editable. Any state but `idle` counts as busy for the OTA gate.

<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->
```mermaid
stateDiagram-v2
  state "any state" as anyState
  [*] --> idle
  idle --> opening : composer.tapPill
  idle --> typing : composer.focus
  idle --> tapDictating : composer.tapMic [online]
  idle --> holding : composer.holdStart [online]
  opening --> typing : composer.focus
  opening --> idle : composer.blur
  opening --> tapDictating : composer.tapMic [online]
  opening --> holding : composer.holdStart [online]
  opening --> idle : after FOCUS_TIMEOUT
  typing --> idle : composer.blur
  typing --> tapDictating : composer.tapMic [online]
  typing --> holding : composer.holdStart [online]
  tapDictating --> typing : composer.dictationLanded [focused]
  tapDictating --> idle : composer.dictationLanded
  holding --> typing : composer.holdEnd [focused]
  holding --> idle : composer.holdEnd
```
<!-- diagram:end -->
