// The canvas self's lesson on `proto` nodes: the `@add_proto` line, when to reach for it, the JSX
// contract (```mantine-widget's), what each design system gives (Relay's theme, eCard's design-system
// components) and example prototypes. The examples are checked by test/canvas.test.ts with the same
// check that guards @add_proto, so the prompt cannot teach code that would be refused.

/** Example prototypes for the prompt; each is a complete `@add_proto` block. */
export const PROTO_EXAMPLES: readonly { id: string; title: string; system: "relay" | "ecard"; width: number; height: number; mobile?: boolean; source: string }[] = [
  {
    id: "ecard-assets",
    title: "Platform Assets (eCard)",
    system: "ecard",
    width: 960,
    height: 560,
    source: `const rows = [
  { name: "holiday-card-front.png", type: "Card artwork", size: "1.2 MB" },
  { name: "merchant-logo.svg", type: "Logo", size: "18 KB" },
];
const [query, setQuery] = useState("");
const shown = rows.filter((r) => r.name.includes(query));
return (
  <BasePageBody>
    <BasePageHeader>
      <BasePageTitle>Platform Assets</BasePageTitle>
      <BasePageDescription>Files merchants and cards use.</BasePageDescription>
    </BasePageHeader>
    <Group mb="md">
      <BaseTextInput placeholder="Filename or GUID" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      <Button>Upload asset</Button>
    </Group>
    <Stack gap="sm">
      {shown.map((r) => (
        <BasePanel key={r.name}>
          <Group justify="space-between">
            <BaseRowTitle>{r.name}</BaseRowTitle>
            <Badge variant="light">{r.type}</Badge>
          </Group>
          <BaseDetailLabel mt="xs">Size</BaseDetailLabel>
          <BaseDetailValue>{r.size}</BaseDetailValue>
        </BasePanel>
      ))}
    </Stack>
  </BasePageBody>
);`,
  },
  {
    id: "relay-approve",
    title: "Approve sheet (Relay, phone)",
    system: "relay",
    width: 430,
    height: 640,
    mobile: true,
    source: `const [done, setDone] = useState(false);
return (
  <Stack p="md" gap="sm">
    <Title order={4}>Deploy to dev?</Title>
    <Text c="dimmed" size="sm">Nova wants to run the deploy for PR 412.</Text>
    <Card withBorder>
      <Text size="sm">bun run deploy --env dev</Text>
    </Card>
    {done ? <Alert color="green">Approved</Alert> : (
      <Group grow>
        <Button variant="default">Deny</Button>
        <Button onClick={() => setDone(true)}>Approve</Button>
      </Group>
    )}
  </Stack>
);`,
  },
];

/** The prototype section of the canvas self's system prompt. */
export function protoPrompt(): string {
  const examples = PROTO_EXAMPLES.map(
    (e, i) =>
      `Example ${String(i + 1)}:\n@add_proto ${e.id} ${String(i * 1000)} 800 ${String(e.width)} ${String(e.height)} ${e.system}${e.mobile === true ? " mobile" : ""}\n${e.title}\n${e.source}\n@end`,
  ).join("\n\n");
  return `Prototypes (@add_proto):
A "proto" node is a real, clickable mockup of a screen, drawn live in a product's design system. Use it when asked to mock up, prototype, sketch a screen, show what a page or flow could look like, "mock up X for eCard", "a Relay version of Y". Not for live data (that is @add_ui) and not a handoff.
Syntax: @add_proto <newId> <x> <y> <width> [height] <relay|ecard|mantine> [mobile], then the title on the first line, then the JSX, then @end. @set_text <protoId> body with new JSX replaces it.
- relay: Relay's own app look (its Mantine theme, dark or light like the board). ecard: eCard's design system (brand blue buttons, Inter, its tokens) plus its components: BasePageBody, BasePageHeader, BasePageTitle, BasePageDescription, BasePanel, BaseCardTitle, BaseRowTitle, BaseDetailLabel, BaseDetailValue, BaseLedgerRow, BaseTextInput, BaseTextarea, BaseNumberInput, BaseColorInput, and Base<Name> for any Mantine <Name> (BaseButton, BaseTable, ...). Button variants contained, outlined, text and quiet are eCard's. mantine: plain Mantine.
- Size: desktop screens 900-1100 wide and 560-720 tall; mobile adds "mobile" (a 390px phone column) with width about 430.
- The JSX is the body of a React component: hooks and constants, then return <JSX/> (or one JSX element). Every @mantine/core, @mantine/charts and @mantine/hooks name and React's hooks are in scope; no imports, no icons packages, no network, no images except data: URLs. Define small helper components inside the code. Make it interactive with useState: tabs that switch, buttons that change state, inputs that filter, rows that select. Use realistic made-up content, never real customer data.
- It must compile and use only known components, or it does not land (the reason comes back to you). Put prototypes side by side with 60px gaps, below or beside the related notes.

${examples}`;
}
