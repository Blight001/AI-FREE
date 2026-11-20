'use strict';

// Every process launched through the interaction inventory gets its own Electron
// storage before the fixture loads. The outer verifier owns timeout cleanup.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { interactions } = require('../../../scripts/verification/interactions');

const file = process.argv[2];
if (!interactions.some((entry) => !entry.manual && entry.file === file)) throw new Error('UNKNOWN_INTERACTION_ENTRY');
const parentDirectory = process.env.AI_FREE_FIXTURE_ROOT;
if (!parentDirectory || !fs.statSync(parentDirectory).isDirectory()) throw new Error('FIXTURE_PROCESS_REQUIRED');
const directory = path.join(parentDirectory, 'electron');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.setPath('sessionData', directory);
const target = path.resolve(__dirname, '../../acceptance/scripts', file);
process.argv.splice(1, 2, target);
require(target);
