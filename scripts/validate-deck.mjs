#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {validateDeck} from '../web/src/model.js';
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/validate-deck.mjs <deck.livedeck.json> [...]');
  process.exitCode = 2;
}
for (const file of files) {
  try {
    const deck = validateDeck(JSON.parse(await readFile(file, 'utf8')));
    const panels = {...deck.terminals, ...deck.dashboards};
    console.log(JSON.stringify({file, valid:true, id:deck.id, version:deck.version ?? 1,
      slides:deck.slides.length, panels:Object.keys(panels).length,
      commands:Object.values(panels).reduce((n,p)=>n+p.commands.length,0), steps:(deck.sequence || []).length}));
  } catch (error) {
    console.error(JSON.stringify({file, valid:false, error:error.message})); process.exitCode = 1;
  }
}
