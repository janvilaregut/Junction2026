#!/usr/bin/env node
// Local model from the terminal. Everything stays on this Mac.
//   npm run local                         interactive chat (keeps history; "exit" to quit)
//   npm run local -- "question"           one answer, streamed
//   npm run local -- --health             is oMLX up, which models it serves
//   npm run local -- --scan file.js       security review of a file (- reads stdin)
//   npm run local -- --json "prompt"      answer as a JSON object
//   --model <id>  --system "<text>"  --lang es|en
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { chat, health, LOCAL_MODEL } from './omlx.js';
import { scanCode } from './tasks.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0 || i === argv.length - 1) return undefined;
  return argv.splice(i, 2)[1];
};

const model = opt('--model') || LOCAL_MODEL;
const system = opt('--system');
const lang = opt('--lang') || 'es';
const scanPath = opt('--scan');
const wantHealth = flag('--health');
const wantJson = flag('--json');
const prompt = argv.join(' ').trim();

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const stats = (r) => dim(`\n[${model} · ${(r.ms / 1000).toFixed(1)} s${r.tps ? ` · ${r.tps.toFixed(0)} tok/s` : ''}${r.usage ? ` · ${r.usage.completion_tokens} tokens` : ''}]`);

async function main() {
  if (wantHealth) {
    const h = await health();
    console.log(JSON.stringify(h, null, 2));
    process.exit(h.ok ? 0 : 1);
  }

  if (scanPath) {
    const code = scanPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(scanPath, 'utf8');
    const r = await scanCode(code, { lang, model });
    const color = { block: 31, review: 33, clean: 32 }[r.verdict];
    console.log(`\x1b[${color}m${r.verdict.toUpperCase()}\x1b[0m  ${r.summary}\n`);
    for (const f of r.findings) {
      console.log(`  ${f.severity.padEnd(8)} ${f.kind.padEnd(14)} line ${f.line}  ${f.evidence}`);
      console.log(dim(`           ${f.why}\n           fix: ${f.fix}\n`));
    }
    console.log(dim(`[${r.model} · ${(r.ms / 1000).toFixed(1)} s]`));
    return;
  }

  if (prompt) {
    if (wantJson) {
      const r = await chat({ prompt, system, model, json: true, temperature: 0 });
      console.log(JSON.stringify(r.data, null, 2), stats(r));
      return;
    }
    const r = await chat({ prompt, system, model, maxTokens: 8192, onToken: (t) => process.stdout.write(t) });
    console.log(stats(r));
    return;
  }

  // Interactive chat.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const messages = [];
  console.log(dim(`Local chat with ${model} (oMLX). Nothing leaves this machine. "exit" to quit.`));
  for (;;) {
    let line;
    try {
      line = (await rl.question('\n> ')).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;
    if (['exit', 'quit', 'salir'].includes(line.toLowerCase())) break;
    messages.push({ role: 'user', content: line });
    try {
      const r = await chat({ messages, system, model, maxTokens: 8192, onToken: (t) => process.stdout.write(t) });
      messages.push({ role: 'assistant', content: r.text });
      console.log(stats(r));
    } catch (e) {
      messages.pop();
      console.error(`\n${e.message}`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
