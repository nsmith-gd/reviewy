#!/usr/bin/env node
// Stand-in for whisper-cli in tests: writes <-of>.json with a fixed transcript.
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const of = args[args.indexOf('-of') + 1];
const lines = [
  [1000, 4000, 'Okay, this is the combat pass on camp three.'],
  [5000, 9000, 'Wave one spawn timing feels right, that is the pace we want everywhere.'],
  [12000, 15000, 'Thank you for watching!'],
  [16000, 21000, 'The archers are lost against the fog, I cannot see them before they fire.'],
  [22000, 27000, 'Players should learn the parry window from feedback alone, so the stagger needs a stronger tell.'],
];
console.error('whisper_print_progress_callback: progress =  50%');
writeFileSync(`${of}.json`, JSON.stringify({ result: { language: 'en' }, transcription: lines.map(([from, to, text]) => ({ offsets: { from, to }, text: ` ${text}` })) }));
