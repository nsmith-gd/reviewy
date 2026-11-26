#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Reads the prompt from stdin and prints stream-json like Claude Code.
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
let prompt = '';
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + '\n');
const schemaArg = args.includes('--json-schema') ? JSON.parse(args[args.indexOf('--json-schema') + 1]) : null;
const frames = [...prompt.matchAll(/(f\d{3}\.jpg) @ /g)].map((m) => m[1]);
let structured = null;
let text = '';
if (schemaArg?.properties?.feedback) {
  structured = {
    summary: 'Camp 3 reads well, but archers vanish in fog and the stagger tell is too subtle.',
    commentaryUsable: true,
    intentions: [
      { id: 'i1', t: 24, statement: 'Players learn the parry window from feedback alone.', source: 'said' },
      { id: 'i2', t: 18, statement: 'Ranged threats are readable before they fire.', source: 'said' },
    ],
    feedback: [
      { t: 25, area: 'gameplay', priority: 'normal', title: 'Stagger needs a stronger tell', change: 'Add hitstop and a brighter spark.', why: 'Parry window unreadable.', intention: 'i1', source: 'said', frame: frames[frames.length - 1] || '' },
      { t: 18, area: 'Art', priority: 'high', title: 'Archers invisible against fog', change: 'Raise rim light.', why: 'Cannot see them.', intention: 'i2', source: 'said', frame: frames[1] || '' },
      { t: 10, area: 'nonsense', priority: 'urgent', title: 'Bogus area item', change: 'x', why: '', intention: 'i9', source: 'seen', frame: 'f999.jpg' },
    ],
    notes: [{ t: 7, area: 'gameplay', text: 'Wave 1 spawn timing feels right.', source: 'said', frame: frames[0] || '' }],
  };
} else if (schemaArg?.properties?.intentionMap) {
  structured = { summary: 'Merged summary.', intentions: [{ id: 'i1', t: 1, statement: 'Merged goal', source: 'said' }], intentionMap: [] };
} else if (schemaArg?.properties?.tickets) {
  structured = { tickets: [{ title: 'Archers invisible against fog', key: 'ZQ-1', url: 'https://example.atlassian.net/browse/ZQ-1' }] };
} else {
  const q = prompt.split('## Question').pop().trim();
  text = `You said the archers are lost against the fog [0:18]. (${q.split('\n').pop()})`;
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', model: 'claude-fake-1', tools: ['Read'] });
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 0 } } } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: structured ? JSON.stringify(structured) : text, structured_output: structured, total_cost_usd: 0.01, num_turns: 3 });
