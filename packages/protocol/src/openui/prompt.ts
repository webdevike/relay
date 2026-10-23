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

/** The calculator example: a pocket calculator's immediate execution (each operator applies the
 * pending one to the running total), kept in $acc/$op/$cur with arithmetic per operator. */
export const CALCULATOR = `root = Card([screen, keys, clear], "Calculator")
$display = "0"
$cur = ""
$acc = 0
$op = ""
screen = Text($display, "heading")
keys = Grid([k7, k8, k9, kdiv, k4, k5, k6, kmul, k1, k2, k3, ksub, k0, kdot, keq, kadd], 4, "xs")
result = $cur == "" ? $acc : ($op == "+" ? $acc + $cur * 1 : ($op == "-" ? $acc - $cur : ($op == "*" ? $acc * $cur : ($op == "/" ? $acc / $cur : $cur * 1))))
k7 = Button("7", Action([@Set($cur, $cur + "7"), @Set($display, $cur)]))
k8 = Button("8", Action([@Set($cur, $cur + "8"), @Set($display, $cur)]))
k9 = Button("9", Action([@Set($cur, $cur + "9"), @Set($display, $cur)]))
k4 = Button("4", Action([@Set($cur, $cur + "4"), @Set($display, $cur)]))
k5 = Button("5", Action([@Set($cur, $cur + "5"), @Set($display, $cur)]))
k6 = Button("6", Action([@Set($cur, $cur + "6"), @Set($display, $cur)]))
k1 = Button("1", Action([@Set($cur, $cur + "1"), @Set($display, $cur)]))
k2 = Button("2", Action([@Set($cur, $cur + "2"), @Set($display, $cur)]))
k3 = Button("3", Action([@Set($cur, $cur + "3"), @Set($display, $cur)]))
k0 = Button("0", Action([@Set($cur, $cur + "0"), @Set($display, $cur)]))
kdot = Button(".", Action([@Set($cur, $cur + "."), @Set($display, $cur)]))
kdiv = Button("÷", Action([@Set($acc, result), @Set($op, "/"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kmul = Button("×", Action([@Set($acc, result), @Set($op, "*"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
ksub = Button("−", Action([@Set($acc, result), @Set($op, "-"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
kadd = Button("+", Action([@Set($acc, result), @Set($op, "+"), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "secondary", "accent")
keq = Button("=", Action([@Set($acc, result), @Set($op, ""), @Set($cur, ""), @Set($display, "" + @Round($acc, 10))]), null, "primary")
clear = Button("Clear", @Reset($display, $cur, $acc, $op), null, "subtle")`;

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
  {
    title: "An interactive calculator: $variables, @Set and @Reset, fully on the device (12+7*2= shows 38: each operator applies to the running total)",
    program: CALCULATOR,
  },
];

const RULES = [
  "root may also be one standalone widget, e.g. `root = Chart(...)` or `root = Tickets(...)`, when the reply shows a single widget; use a Card (framed) or Stack to combine several.",
  "Every widget component can be a child of Card, Stack, Grid, Tab and Collapse. Sub-components (Series, Delta, Row, Ticket, Column, Cell, ListItem, Tab, ...) only go inside the widget that takes them.",
  "Write null to skip an optional argument that comes before one you set; leave trailing optional arguments out.",
  "Static widgets use literal values. Interactive ones (counters, toggles, calculators, tip splitters, quizzes) declare `$name = default` state (a string or number) and read it in expressions; the widget re-renders on the device whenever a $variable changes. There is no Query, Mutation or @Run.",
  "A Button changes state with @Set($var, expression) and @Reset($var, ...). Action([...]) runs its steps in order and each @Set sees the ones before it. A button with @Set/@Reset runs on the device and sends nothing; add @ToAssistant only when the result should become Isaac's next turn. Keep self-contained tools (calculator, counter, converter) fully local: never @ToAssistant to compute.",
  'There is no eval: compute with arithmetic on $variables (+ - * / %, ternaries for the operator). + concatenates when either side is a string, so turn typed text into a number with `$cur * 1` before adding; dividing by zero gives 0. String props show a number as its text; write `"" + @Round($x, 2)` to control decimals.',
  "Use only the components and arguments listed. A node that fails validation is dropped (an invalid root drops the whole widget), so never invent fields.",
];

/** The full openui-lang prompt for Relay widgets: syntax, component signatures, rules, examples. */
export function relayWidgetPrompt(): string {
  return relayLibrary.prompt({
    preamble: PREAMBLE,
    examples: OPENUI_EXAMPLES.map((e) => `Example — ${e.title}:\n\`\`\`openui\n${e.program}\n\`\`\``),
    additionalRules: RULES,
    toolCalls: false,
    bindings: true,
  });
}
