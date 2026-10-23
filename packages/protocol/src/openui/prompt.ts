/**
 * The prompt that teaches an agent to emit Relay widgets as OpenUI Lang: lang-core's generated
 * syntax rules and component signatures for the Relay library, plus Relay's fence, rules and
 * examples.
 */
import { relayLibrary } from "./library";

const PREAMBLE = `Relay (Isaac's phone app) and Relay desktop render native widgets from OpenUI Lang (openui-lang), a compact declarative UI language. To show a widget, put an openui-lang program in a fenced code block tagged \`openui\` inside your normal Markdown reply:

\`\`\`openui
root = Stat("Collected", "$7.9k", Delta("12%", "up"))
\`\`\`

Text outside the fence renders as chat. Inside the fence write only openui-lang statements: no prose, no comments. The widget renders live while you stream; a block that does not parse shows as code under a "Widget couldn't render" header. Use a widget when the answer is better seen than read (metrics, trends, ticket lists, visual proof, choices to tap); plain prose, code and short lists stay Markdown.`;

/** Example programs shown in the prompt; each parses to a valid widget with no errors. */
export const OPENUI_EXAMPLES: readonly { title: string; program: string }[] = [
  {
    title: "A card with stats, rows and badges",
    program: `root = Card([stats, Divider(), status, tags], "Morning brief")
stats = Stack([Stat("Open tickets", "12"), Stat("In review", "1", Delta("2", "down"))], "horizontal")
status = Rows([Row("ENG-5533", "In Review", "accent"), Row("ENG-5514", "Waiting on QA", "warn")])
tags = Stack([Badge("eCard", "accent"), Badge("Dev green", "ok")], "horizontal", "xs")`,
  },
  {
    title: "Tickets (null skips an optional argument before one you set)",
    program: `root = Tickets([t1, t2], "My Linear tickets")
t1 = Ticket("ENG-5514", "Black Buttons: more stragglers", "Merged; waiting on Steve's QA on dev before closing.", "https://linear.app/ecard-systems/issue/ENG-5514/black-buttons-more-stragglers", "In QA", "started", "Low", null, "2d ago")
t2 = Ticket("ENG-5533", "Invoice export times out", "Paginating the query fixed it locally; PR is up for review.", null, "In Review", "started", "High")`,
  },
  {
    title: "A review card with a callout, table, progress and buttons",
    program: `root = Card([note, checks, bar, actions], "ENG-6211 review")
note = Callout("Two approvals needed before merge.", "Waiting on Noah", "warn")
checks = Table(["Check", Column("Time", "right")], [["lint", "42s"], [Cell("e2e", "danger", true), "6m"]])
bar = Progress(7, 9, "Checks", null, "ok")
actions = Stack([Button("Nudge Noah", @ToAssistant("nudge Noah on ENG-6211"), null, "primary"), Button("Open PR", @OpenUrl("https://github.com/ecard/app/pull/412"))], "horizontal")`,
  },
  {
    title: "One standalone widget as the root",
    program: `root = Chart("bar", [Series([40, 60, 55], "connected", "#A7F3D0"), Series([50, 70, 60], "voicemail", "#FDE68A")], ["W1", "W2", "W3"], "Calls by outcome", true)`,
  },
];

const RULES = [
  "root may also be one standalone widget, e.g. `root = Chart(...)` or `root = Tickets(...)`, when the reply shows a single widget; use a Card (framed) or Stack to combine several.",
  "Every widget component can be a child of Card, Stack, Grid, Tab and Collapse. Sub-components (Series, Delta, Row, Ticket, Column, Cell, ListItem, Tab, ...) only go inside the widget that takes them.",
  "Write null to skip an optional argument that comes before one you set; leave trailing optional arguments out.",
  "Values are literals only: no expressions, $variables, Query, Mutation or @functions. The only @-steps are @ToAssistant and @OpenUrl, in a Button's action slot.",
  "Use only the components and arguments listed. A node that fails validation is dropped (an invalid root drops the whole widget), so never invent fields.",
];

/** The full openui-lang prompt for Relay widgets: syntax, component signatures, rules, examples. */
export function relayWidgetPrompt(): string {
  return relayLibrary.prompt({
    preamble: PREAMBLE,
    examples: OPENUI_EXAMPLES.map((e) => `Example — ${e.title}:\n\`\`\`openui\n${e.program}\n\`\`\``),
    additionalRules: RULES,
    toolCalls: false,
    bindings: false,
  });
}
