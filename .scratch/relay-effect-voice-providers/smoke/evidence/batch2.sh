cd /Users/ike/Eva/work/relay-effect-voice-providers/apps/linux
S=../../.scratch/relay-effect-voice-providers/smoke; W=/tmp/relay-smoke-evidence/wav; E=/tmp/relay-smoke-evidence
Q="Please ask my assistant to check the status of the alpha project."
rm -rf $E/dg-nokey $E/dg-badkey $E/dg-normal-path $E/gpt-live-smoke $E/gpt-host-check $E/dg-live-declined $E/gpt-nokey
$S/run.sh dg-normal-path deepgram 1500 -- bun test/call-smoke.ts --agent smoke --greeting --wav $W/ask.wav --out $E/dg-normal-path/reply.wav --timeout 90
$S/run.sh dg-nokey deepgram 1500 --no-keys --local-stub -- bun test/call-smoke.ts --agent smoke --wav $W/ask.wav --out $E/dg-nokey/reply.wav --timeout 12
EXTRA_ENV="DEEPGRAM_API_KEY=invalid-test-key" $S/run.sh dg-badkey deepgram 1500 --local-stub -- bun test/call-smoke.ts --agent smoke --wav $W/ask.wav --out $E/dg-badkey/reply.wav --timeout 12
mkdir -p $E/gpt-live-smoke/out
$S/run.sh gpt-live-smoke none 1500 -- bun test/live-smoke.ts --agent smoke --out $E/gpt-live-smoke/out --timeout 200 --ask "$Q"
$S/run.sh gpt-host-check none 1500 -- bun test/live-host-check.ts --agent smoke --ask "$Q"
$S/run.sh dg-live-declined deepgram 1500 -- bun test/live-host-check.ts --agent smoke --ask "$Q"
$S/run.sh gpt-nokey none 1500 --no-keys -- bun test/live-host-check.ts --agent smoke --ask "$Q"
echo BATCH2 DONE
