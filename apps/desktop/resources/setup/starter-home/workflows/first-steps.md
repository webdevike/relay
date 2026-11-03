# First steps: make this home base yours

Use this once, right after setup, to teach your assistants who you are and what to keep track of. Delete or rewrite it when it has done its job.

## Inputs
| Input | What it gives you |
|:--|:--|
| `AGENTS.md` | the identity and rules every assistant starts from |
| `workspaces/README.md` | how to add a card for a project or client |
| `memory/index.md` | the short list of facts that load at the start of every session |

## Steps
1. Ask the assistant: "Interview me for five minutes about my work and routines, then write what you learned into `memory/index.md`." Answer in plain sentences.
2. For each project or client you want help with, ask: "Create a workspace card for <name> from the template and ask me what to put in it."
3. Ask for a runbook the first time you hand over a task you will repeat: "Write a runbook for what we just did."
4. Add your open items to `memory/todos.md`, or ask the assistant to.

## Outputs
- `memory/index.md`: the facts your assistants know about you, short enough to read every time.
- `workspaces/<name>.md`: one card per project.
- `workflows/<task>.md`: one runbook per repeated task.

## Check
- Start a new chat and ask "what do you know about me and what are we working on?". The answer should match what you wrote, without you repeating it.
