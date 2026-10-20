// The spike's explicitly bounded evaluation budget. Every provider request
// reserves its worst case first and is refused when the reservation does not
// fit. A settled request replaces its reservation with the measured cost; a
// request whose charge is unknown (timeout, missing usage) keeps the full
// reservation, because the provider may still have billed it.

export interface BudgetSnapshot {
  readonly limitUsd: number;
  readonly settledUsd: number;
  readonly heldUsd: number;
  readonly remainingUsd: number;
  readonly refused: number;
}

export class EvaluationBudget {
  readonly #limitUsd: number;
  readonly #open = new Map<string, number>();
  #settledUsd = 0;
  #heldUsd = 0;
  #refused = 0;

  constructor(limitUsd: number) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
      throw new RangeError('The evaluation budget must be a positive amount.');
    }
    this.#limitUsd = limitUsd;
  }

  get remainingUsd(): number {
    let open = 0;
    for (const amount of this.#open.values()) open += amount;
    return this.#limitUsd - this.#settledUsd - this.#heldUsd - open;
  }

  // Returns false, and counts a refusal, when the amount does not fit.
  reserve(id: string, amountUsd: number): boolean {
    if (this.#open.has(id)) throw new RangeError(`${id} is already reserved.`);
    if (!(amountUsd >= 0)) throw new RangeError('A reservation is >= 0.');
    if (amountUsd > this.remainingUsd) {
      this.#refused += 1;
      return false;
    }
    this.#open.set(id, amountUsd);
    return true;
  }

  // Settles a reservation from the measured cost, or keeps all of it when the
  // cost is unknown.
  settle(id: string, actualUsd: number | undefined): void {
    const reserved = this.#open.get(id);
    if (reserved === undefined) throw new RangeError(`${id} is not reserved.`);
    this.#open.delete(id);
    if (actualUsd === undefined) this.#heldUsd += reserved;
    else this.#settledUsd += actualUsd;
  }

  snapshot(): BudgetSnapshot {
    return {
      limitUsd: this.#limitUsd,
      settledUsd: this.#settledUsd,
      heldUsd: this.#heldUsd,
      remainingUsd: this.remainingUsd,
      refused: this.#refused,
    };
  }
}
