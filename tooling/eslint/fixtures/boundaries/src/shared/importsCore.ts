// Deliberate violation: shared imports nothing else in src/, so importing
// core fails lint.
import { budget } from '../core/budget.ts';

export const limit = budget;
