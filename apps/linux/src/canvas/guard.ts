// The canvas self's approval guard: the same lane as the chat assistant, enforced on every tool
// call of the room's omp session and its subagents (an omp `tool_call` handler blocks the call and
// tells the model why). Reading, research and work inside the agent home's work/ are free;
// anything that leaves the machine or acts in Isaac's name (pushes, deploys, publishing, sending
// messages, purchases, posting data, other people's browsers or his desktop) is refused with
// "needs Isaac's yes": the canvas self hands those to the chat with `@handoff main`, where Isaac
// approves them. Writes outside work/ (and the room's own board file) are refused.
//
// `canvasGuard` must stay self-contained (no imports, no module-level helpers): `guardExtension`
// embeds its source into the extension file each room's omp loads, so tests and omp run the same
// code. It is a policy layer over the agent's own tool calls, not a sandbox: a shell command it
// cannot parse (an inline script writing files, say) is not caught.

export interface GuardPolicy {
  /** The agent's working directory (the agent home): relative paths resolve against it. */
  readonly cwd: string;
  /** `$HOME`, for `~` in paths. */
  readonly home: string;
  /** Directories the agent may write in (the agent home's work/). */
  readonly writeRoots: readonly string[];
  /** Single files it may write (the room's board file). */
  readonly writeFiles: readonly string[];
}

/** Why the call is refused, or null when it may run. */
export function canvasGuard(tool: string, input: Record<string, unknown>, policy: GuardPolicy): string | null {
  const ASK = "That needs Isaac's yes in the chat: hand it off with `@handoff main <what and why>` in a canvas_act batch and tell him in one line.";
  const root = policy.writeRoots[0] ?? policy.cwd;
  const WHERE = `Canvas writes stay under ${policy.writeRoots.join(", ")}${policy.writeFiles.length > 0 ? ` (and ${policy.writeFiles.join(", ")})` : ""}; put files in ${root}/canvas/. Board changes go through canvas_act.`;

  const normalize = (raw: string, base: string): string => {
    let p = raw.trim();
    if (p === "~") p = policy.home;
    else if (p.startsWith("~/")) p = `${policy.home}/${p.slice(2)}`;
    if (!p.startsWith("/")) p = `${base}/${p}`;
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return `/${out.join("/")}`;
  };
  const writable = (raw: string, base: string): boolean => {
    const p = normalize(raw, base);
    if (p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr") return true;
    if (policy.writeFiles.some((f) => normalize(f, "/") === p)) return true;
    return policy.writeRoots.some((r) => {
      const dir = normalize(r, "/");
      return p === dir || p.startsWith(`${dir}/`);
    });
  };
  const refuseWrite = (raw: string, base: string): string | null => (writable(raw, base) ? null : `Refused: ${normalize(raw, base)} is outside the canvas's write area. ${WHERE}`);

  // Shell words of one command segment, quotes removed (good enough for paths and flags).
  const words = (segment: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let has = false;
    for (const ch of segment) {
      if (quote !== null) {
        if (ch === quote) quote = null;
        else cur += ch;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
        has = true;
      } else if (/\s/.test(ch)) {
        if (has || cur !== "") out.push(cur);
        cur = "";
        has = false;
      } else cur += ch;
    }
    if (has || cur !== "") out.push(cur);
    return out;
  };

  if (tool === "eval") return `Refused: eval is not available on the canvas (it runs code no guard can check). Use bash, or the canvas_act tool for the board.`;
  if (tool === "computer_run" || tool === "computer_do") return `Refused: the canvas does not drive Isaac's desktop apps. ${ASK}`;
  if (tool.startsWith("mcp__") || tool === "ssh") return `Refused: ${tool} acts outside this machine's files. ${ASK}`;
  // A string argument of the call, else "" (tools take their paths and commands as strings).
  const arg = (key: string): string => {
    const value = input[key];
    return typeof value === "string" ? value : "";
  };

  if (tool === "browse") {
    if (typeof input["cdp"] === "string" && input["cdp"] !== "") return `Refused: the canvas does not attach to Isaac's own browser. ${ASK}`;
    const goal = arg("goal");
    if (/\b(submit|send|post|reply|comment|buy|purchase|pay|checkout|order|book|sign ?up|subscribe|publish|deploy|merge|approve|delete|remove|cancel|invite|transfer)\b/i.test(goal)) return `Refused: that browser goal acts on a site in Isaac's name. ${ASK}`;
    return null;
  }

  if (tool === "write") {
    const path = arg("path");
    if (/^(local|agent|artifact|proc):\/\//.test(path)) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return `Refused: writing to ${path.split("://")[0] ?? "that"}:// is outside the canvas's lane (devices and remote hosts can spend money or act externally). ${ASK}`;
    return refuseWrite(path.replace(/\.(db|sqlite3?)(:.*)$/i, ".$1"), policy.cwd);
  }

  if (tool === "edit") {
    const patch = arg("input");
    const targets: string[] = [];
    for (const line of patch.split("\n")) {
      const header = /^\[([^\]#]+)#[0-9A-Fa-f]{4}\]/.exec(line.trim());
      if (header?.[1] !== undefined) targets.push(header[1]);
      const move = /^MV\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line.trim());
      if (move !== null) targets.push(move[1] ?? move[2] ?? move[3] ?? "");
    }
    for (const key of ["path", "file", "file_path", "filePath"]) if (arg(key) !== "") targets.push(arg(key));
    if (targets.length === 0) return `Refused: could not tell which file this edit changes. ${WHERE}`;
    for (const target of targets) {
      const why = refuseWrite(target, policy.cwd);
      if (why !== null) return why;
    }
    return null;
  }

  if (tool === "bash") {
    const command = arg("command");
    const external: [RegExp, string][] = [
      [/\bgit\s+(-C\s+\S+\s+)?(push|remote\s+(add|set-url))\b/, "pushing to a remote"],
      [/\bgh\s+(pr\s+(create|merge|comment|review|edit|close|reopen|ready)|issue\s+(create|comment|edit|close|reopen|delete|transfer)|release\s+(create|upload|delete|edit)|repo\s+(create|delete|fork|edit|rename|archive)|secret\s|workflow\s+run|run\s+(rerun|cancel))/, "changing GitHub"],
      [/\bgh\s+api\b[^|;&\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--method\s*(POST|PUT|PATCH|DELETE)|\s-[fF]\s|--field|--raw-field|--input)/, "changing GitHub"],
      [/\b(wrangler\s+(deploy|publish|pages\s+deploy|secret|kv|r2|d1\s+execute|versions\s+deploy)|vercel(\s|$)|netlify\s+deploy|fly(ctl)?\s+deploy|(npm|bun|pnpm|yarn|cargo)\s+publish|docker\s+push|terraform\s+apply|kubectl\s+(apply|delete|create|patch)|eas\s+(submit|update|build))\b/, "deploying or publishing"],
      [/eva-thread\.ts|agent-tell\.ts/, "messaging an assistant thread"],
      [/\bbrew\s+(install|uninstall|upgrade|reinstall)\b|\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\bbun\s+(add|install|i)\s+(-g|--global)\b/, "changing this Mac's installed software"],
      [/\brsync\b[^|;&\n]*\s[\w.-]+@?[\w.-]+:\S/, "reaching another machine"],
    ];
    // A heredoc's body is data (often action lines for `canvas act`), not commands: keep only its first line.
    let script = "";
    let rest = command;
    for (let m = /<<-?\s*(['"]?)([\w.-]+)\1[^\n]*\n/.exec(rest); m !== null; m = /<<-?\s*(['"]?)([\w.-]+)\1[^\n]*\n/.exec(rest)) {
      script += rest.slice(0, m.index + m[0].length);
      const after = rest.slice(m.index + m[0].length);
      const end = new RegExp(`^\\s*${(m[2] ?? "").replace(/[.]/g, "\\.")}\\s*$`, "m").exec(after);
      rest = end === null ? "" : after.slice(end.index + end[0].length);
    }
    script += rest;
    for (const [pattern, what] of external) if (pattern.test(script)) return `Refused: ${what} is outside the canvas's lane. ${ASK}`;
    const lane: Record<string, string> = {
      osascript: "scripting Isaac's apps (it can send messages)",
      sendmail: "sending mail",
      msmtp: "sending mail",
      mail: "sending mail",
      mailx: "sending mail",
      slack: "posting to Slack",
      sudo: "running as root",
      launchctl: "changing this Mac's services",
      shutdown: "stopping this Mac",
      reboot: "stopping this Mac",
      halt: "stopping this Mac",
      softwareupdate: "changing this Mac's installed software",
      killall: "killing other programs",
      pkill: "killing other programs",
      "relay-host": "touching the running Relay host",
      "relay-ota": "touching the running Relay host",
      ssh: "reaching another machine",
      scp: "reaching another machine",
      sftp: "reaching another machine",
    };
    let cwd = arg("cwd") !== "" ? normalize(arg("cwd"), policy.cwd) : policy.cwd;
    for (const segment of script.split(/&&|\|\||;|\n|\|(?!\|)/)) {
      const w = words(segment.trim());
      const cmd = w[0];
      if (cmd === undefined) continue;
      const name = cmd.split("/").at(-1) ?? cmd;
      const why = lane[name];
      if (why !== undefined) return `Refused: ${why} is outside the canvas's lane. ${ASK}`;
      if (/^(curl|wget|xh|http|https)$/.test(name) && w.some((x) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json|-X|--request)$/.test(x) || /^-X(POST|PUT|PATCH|DELETE)$/.test(x)) && !w.some((x) => /(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/.test(x)))
        return `Refused: sending data to a web service is outside the canvas's lane. ${ASK}`;
      if (cmd === "cd") {
        cwd = normalize(w[1] ?? policy.home, cwd);
        continue;
      }
      // Redirections and tee targets.
      for (let i = 0; i < w.length; i++) {
        const word = w[i] ?? "";
        const redirect = /^\d*(>>?|&>>?)(.*)$/.exec(word);
        if (redirect !== null) {
          const target = redirect[2] !== "" ? redirect[2] : w[i + 1];
          if (target !== undefined && !target.startsWith("&")) {
            const why = refuseWrite(target, cwd);
            if (why !== null) return why;
          }
        }
      }
      const args = w.slice(1).filter((x) => !x.startsWith("-") && !/^\d*(>>?|&>>?)/.test(x));
      let targets: string[] = [];
      if (cmd === "tee") targets = args;
      else if (["rm", "rmdir", "mkdir", "touch", "truncate", "unlink", "shred"].includes(cmd)) targets = args;
      else if (["chmod", "chown", "chgrp"].includes(cmd)) targets = args.slice(1);
      else if (["cp", "mv", "ln", "install", "rsync", "ditto"].includes(cmd)) targets = args.slice(-1);
      else if ((cmd === "sed" || cmd === "perl") && w.some((x) => /^-[a-zA-Z]*i/.test(x))) targets = args.slice(-1);
      else if (cmd === "git") {
        const at = w.indexOf("-C");
        const dir = at >= 0 && w[at + 1] !== undefined ? normalize(w[at + 1] ?? "", cwd) : cwd;
        const sub = w.slice(1).find((x, i) => !x.startsWith("-") && w[i] !== "-C");
        if (sub !== undefined && /^(commit|checkout|switch|restore|reset|merge|rebase|stash|add|rm|mv|apply|am|cherry-pick|revert|clean|worktree|init|clone|pull|fetch)$/.test(sub)) targets = [dir];
      }
      for (const target of targets) {
        const why = refuseWrite(target, cwd);
        if (why !== null) return why;
      }
    }
    return null;
  }
  return null;
}

/** The omp extension source that runs `canvasGuard` with `policy` on every tool call. */
export function guardExtension(policy: GuardPolicy): string {
  return [
    "// Generated by the Relay host for one live canvas room (apps/linux/src/canvas/guard.ts). Do not edit.",
    `const canvasGuard = ${canvasGuard.toString()};`,
    `const policy = ${JSON.stringify(policy)};`,
    "export default function canvasGuardExtension(pi) {",
    '  pi.on("tool_call", (event) => {',
    "    const reason = canvasGuard(event.toolName, event.input ?? {}, policy);",
    "    if (reason !== null) return { block: true, reason };",
    "    return undefined;",
    "  });",
    "}",
    "",
  ].join("\n");
}
