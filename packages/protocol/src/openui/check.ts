/**
 * Checks every ```openui block of a reply: `bun packages/protocol/src/openui/check.ts < reply.md`
 * prints one JSON report (`{ blocks: [...] }`, see `OpenUIBlockFinding`) and always exits 0. An
 * unclosed last block is checked as a stream prefix. Used by Eva's widget-check hook.
 */
import { checkOpenUIBlocks } from "./check-blocks";

let input = "";
for await (const chunk of process.stdin) input += String(chunk);
process.stdout.write(`${JSON.stringify({ blocks: checkOpenUIBlocks(input) }, null, 2)}\n`);
