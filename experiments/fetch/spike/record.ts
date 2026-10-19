// The shape of one scenario's result in the recorded JSON.
import type { StepRecord } from './lab.ts';

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly observed: unknown;
}

export interface ScenarioRecord {
  readonly id: string;
  // Acceptance criterion numbers from #141.
  readonly criteria: readonly number[];
  readonly title: string;
  readonly passed: boolean;
  readonly checks: readonly Check[];
  readonly steps: readonly StepRecord[];
  readonly data?: unknown;
}

export class ScenarioBuilder {
  readonly #id: string;
  readonly #criteria: readonly number[];
  readonly #title: string;
  readonly #checks: Check[] = [];
  readonly #steps: StepRecord[] = [];
  #data: unknown;

  constructor(id: string, criteria: readonly number[], title: string) {
    this.#id = id;
    this.#criteria = criteria;
    this.#title = title;
  }

  check(name: string, passed: boolean, observed: unknown = undefined): boolean {
    this.#checks.push({ name, passed, observed });
    return passed;
  }

  step<T extends { readonly record: StepRecord }>(measured: T): T {
    this.#steps.push(measured.record);
    return measured;
  }

  data(value: unknown): void {
    this.#data = value;
  }

  build(): ScenarioRecord {
    return {
      id: this.#id,
      criteria: this.#criteria,
      title: this.#title,
      passed: this.#checks.length > 0 && this.#checks.every((c) => c.passed),
      checks: this.#checks,
      steps: this.#steps,
      ...(this.#data === undefined ? {} : { data: this.#data }),
    };
  }
}
