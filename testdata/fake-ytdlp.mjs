#!/usr/bin/env node
// Stand-in for yt-dlp in tests: "downloads" FAKE_VIDEO into the -o template.
import { copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
console.log('TITLE:Camp 3 combat pass');
console.log('[download]  10.0% of 1.00MiB');
console.log('[download] 100.0% of 1.00MiB');
copyFileSync(process.env.FAKE_VIDEO, out);
