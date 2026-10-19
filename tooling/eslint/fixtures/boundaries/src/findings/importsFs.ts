// Deliberate violation: only adapters import fs, so a domain module that
// reads files fails lint.
import { readFileSync } from 'node:fs';

export const read = readFileSync;
