#!/usr/bin/env node
import { main } from '../dist/server/cli.js';
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
