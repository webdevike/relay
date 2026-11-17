# Examples

Two finished diagrams that pass every rule. Match their finish, not their content. `<defs>` is shortened here to `<!-- dark defs -->` and `<!-- light defs -->`: in your reply write the full block from the style file.

## Dark loop: six stations, one hub (viewBox 1040 x 776)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1040 776" role="img" aria-labelledby="self-improving-loop-title self-improving-loop-desc">
  <title id="self-improving-loop-title">The self-improving loop</title>
  <desc id="self-improving-loop-desc">Six stations run clockwise from Capture to Learn and back, each writing into one shared memory, with Decide as the human approval gate.</desc>
  <!-- dark defs -->
  <rect class="paper" width="1040" height="776"/>
  <text class="eyebrow" x="40" y="44">LOOP · OPERATIONS</text>
  <text class="title" x="40" y="80">The self-improving loop</text>

  <path class="c" d="M600.000 193.726 A240 240 0 0 1 704.969 267.073" marker-end="url(#arrow)"/>
  <path class="c" d="M743.285 332.000 A240 240 0 0 1 743.722 506.882" marker-end="url(#arrow)"/>
  <path class="c" d="M705.731 572.000 A240 240 0 0 1 601.130 645.871" marker-end="url(#arrow)"/>
  <path class="c" d="M440.000 646.274 A240 240 0 0 1 335.031 572.927" marker-end="url(#arrow)"/>
  <path class="c" d="M296.715 508.000 A240 240 0 0 1 296.278 333.118" marker-end="url(#arrow)"/>
  <path class="c" d="M334.269 268.000 A240 240 0 0 1 438.870 194.129" marker-end="url(#arrow)"/>

  <path class="c-soft" d="M520 212 V362" marker-end="url(#arrow-soft)"/>
  <path class="c-soft" d="M672.533 332 L615.333 365" marker-end="url(#arrow-soft)"/>
  <path class="c-soft" d="M672.533 508 L615.333 475" marker-end="url(#arrow-soft)"/>
  <path class="c-soft" d="M520 628 V478" marker-end="url(#arrow-soft)"/>
  <path class="c-soft" d="M367.467 508 L424.667 475" marker-end="url(#arrow-soft)"/>
  <path class="c-soft" d="M367.467 332 L424.667 365" marker-end="url(#arrow-soft)"/>

  <rect class="mask" x="528" y="272" width="56" height="12" rx="2"/>
  <text class="label label-soft" x="556" y="281">SIGNALS</text>
  <rect class="mask" x="452" y="548" width="60" height="12" rx="2"/>
  <text class="label label-soft" x="482" y="557">OUTCOMES</text>

  <rect class="n-step" x="440" y="148" width="160" height="64" rx="6"/>
  <text class="name" x="520" y="176">Capture</text>
  <text class="sub" x="520" y="194">signals in</text>
  <rect class="n-step" x="648" y="268" width="160" height="64" rx="6"/>
  <text class="name" x="728" y="296">Research</text>
  <text class="sub" x="728" y="314">evidence pulled</text>
  <rect class="n-focal" x="648" y="508" width="160" height="64" rx="6"/>
  <text class="name name-accent" x="728" y="536">Decide</text>
  <text class="sub" x="728" y="554">human approves</text>
  <rect class="n-step" x="440" y="628" width="160" height="64" rx="6"/>
  <text class="name" x="520" y="656">Act</text>
  <text class="sub" x="520" y="674">work ships</text>
  <rect class="n-step" x="232" y="508" width="160" height="64" rx="6"/>
  <text class="name" x="312" y="536">Measure</text>
  <text class="sub" x="312" y="554">outcomes logged</text>
  <rect class="n-step" x="232" y="268" width="160" height="64" rx="6"/>
  <text class="name" x="312" y="296">Learn</text>
  <text class="sub" x="312" y="314">playbook updated</text>

  <rect class="n-hub" x="420" y="368" width="200" height="104" rx="8"/>
  <text class="hub-name" x="520" y="418">Shared memory</text>
  <text class="hub-sub" x="520" y="438">one record, every loop</text>

  <line class="rule" x1="40" y1="712" x2="1000" y2="712"/>
  <text class="eyebrow" x="40" y="736">LEGEND</text>
  <rect class="n-step" x="120" y="727" width="14" height="10" rx="2"/>
  <text class="legend" x="140" y="736">Station</text>
  <rect class="n-focal" x="220" y="727" width="14" height="10" rx="2"/>
  <text class="legend" x="240" y="736">Approval gate</text>
  <rect class="n-hub" x="340" y="727" width="14" height="10" rx="2"/>
  <text class="legend" x="360" y="736">Shared state</text>
  <line class="c" x1="460" y1="733" x2="488" y2="733" marker-end="url(#arrow)"/>
  <text class="legend" x="496" y="736">Flow, clockwise</text>
  <line class="c-soft" x1="600" y1="733" x2="628" y2="733" marker-end="url(#arrow-soft)"/>
  <text class="legend" x="636" y="736">Write-back</text>
</svg>
```

## Light flowchart: two decisions, three outcomes (viewBox 1000 x 704)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 704" role="img" aria-labelledby="skill-or-not-title skill-or-not-desc">
  <title id="skill-or-not-title">Should you write this as a skill?</title>
  <desc id="skill-or-not-desc">Flowchart deciding whether a new workflow stays manual, becomes a project note, or is written as a reusable skill.</desc>
  <!-- light defs -->
  <rect class="paper" width="1000" height="704"/>
  <text class="eyebrow" x="40" y="44">FLOWCHART · WORKFLOWS</text>
  <text class="title" x="40" y="80">Should you write this as a skill?</text>

  <line class="c" x1="500" y1="168" x2="500" y2="200" marker-end="url(#arrow)"/>
  <line class="c" x1="500" y1="248" x2="500" y2="272" marker-end="url(#arrow)"/>
  <line class="c" x1="600" y1="320" x2="720" y2="320" marker-end="url(#arrow)"/>
  <line class="c" x1="500" y1="368" x2="500" y2="408" marker-end="url(#arrow)"/>
  <line class="c" x1="600" y1="456" x2="720" y2="456" marker-end="url(#arrow)"/>
  <line class="c-accent" x1="500" y1="504" x2="500" y2="544" marker-end="url(#arrow-accent)"/>

  <rect class="mask" x="644" y="300" width="24" height="12" rx="2"/>
  <text class="label" x="656" y="309">NO</text>
  <rect class="mask" x="508" y="378" width="32" height="12" rx="2"/>
  <text class="label" x="524" y="387">YES</text>
  <rect class="mask" x="644" y="436" width="24" height="12" rx="2"/>
  <text class="label" x="656" y="445">NO</text>
  <rect class="mask" x="508" y="514" width="32" height="12" rx="2"/>
  <text class="label label-accent" x="524" y="523">YES</text>

  <rect class="n-external" x="420" y="120" width="160" height="48" rx="20"/>
  <text class="name" x="500" y="148">New workflow</text>
  <rect class="n-step" x="420" y="200" width="160" height="48" rx="6"/>
  <text class="name" x="500" y="228">Do it manually once</text>
  <polygon class="n-step" points="500,272 600,320 500,368 400,320"/>
  <text class="name" x="500" y="318">Will you repeat</text>
  <text class="name" x="500" y="332">it 3+ times?</text>
  <rect class="n-external" x="720" y="296" width="160" height="48" rx="20"/>
  <text class="name" x="800" y="318">One-off</text>
  <text class="sub" x="800" y="334">keep manual</text>
  <polygon class="n-step" points="500,408 600,456 500,504 400,456"/>
  <text class="name" x="500" y="454">Reusable across</text>
  <text class="name" x="500" y="468">projects?</text>
  <rect class="n-external" x="720" y="432" width="160" height="48" rx="20"/>
  <text class="name" x="800" y="454">Project note</text>
  <text class="sub" x="800" y="470">project-scoped</text>
  <rect class="n-focal" x="420" y="544" width="160" height="56" rx="20"/>
  <text class="name name-accent" x="500" y="570">Write a skill</text>
  <text class="sub" x="500" y="588">reusable and shared</text>

  <line class="rule" x1="40" y1="624" x2="960" y2="624"/>
  <text class="eyebrow" x="40" y="648">LEGEND</text>
  <rect class="n-external" x="120" y="639" width="24" height="12" rx="6"/>
  <text class="legend" x="152" y="648">Start or end</text>
  <rect class="n-step" x="260" y="639" width="24" height="12" rx="2"/>
  <text class="legend" x="292" y="648">Step</text>
  <polygon class="n-step" points="372,645 384,639 396,645 384,651"/>
  <text class="legend" x="404" y="648">Decision</text>
  <line class="c-accent" x1="492" y1="645" x2="520" y2="645" marker-end="url(#arrow-accent)"/>
  <text class="legend" x="528" y="648">Happy path</text>
</svg>
```
