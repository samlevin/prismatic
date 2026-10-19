// What the journal records add up to: spend, publication records, effect
// receipts, abandoned rounds, suppressions and resets. A reset carries the
// verified spend, suppressions and known round keys forward, so a new chain
// segment starts from them rather than from an empty pull request.
import type { JournalRecord } from './journal.ts';
import { assembleRecord } from './record.ts';
import type { Assembled, JournalChunk, RecordManifest } from './record.ts';

export interface Reservation {
  readonly attemptId: string;
  readonly amountMicroUsd: number;
}

export interface Settlement {
  readonly attemptId: string;
  readonly costMicroUsd: number;
}

export interface Suppression {
  readonly findingId: string;
  readonly byLogin: string;
}

export interface Spend {
  // Reservations with no settlement: the provider may have charged them.
  readonly heldMicroUsd: number;
  readonly settledMicroUsd: number;
}

// The values a reset record carries into the next chain segment.
export interface Carried {
  readonly reservations: readonly Reservation[];
  readonly settlements: readonly Settlement[];
  readonly suppressions: readonly Suppression[];
  readonly roundKeys: readonly string[];
  readonly resets: number;
}

export class Ledger {
  readonly reservations = new Map<string, Reservation>();
  readonly settlements = new Map<string, Settlement>();
  readonly manifests = new Map<string, RecordManifest>();
  readonly chunks: JournalChunk[] = [];
  readonly receipts = new Map<string, number>();
  readonly abandoned = new Set<string>();
  readonly suppressions = new Map<string, Suppression>();
  // Round keys a reset acknowledged without their records.
  readonly acknowledged = new Set<string>();
  resets = 0;

  constructor(records: readonly JournalRecord[]) {
    for (const record of records) this.#add(record);
  }

  get spend(): Spend {
    let held = 0;
    let settled = 0;
    for (const reservation of this.reservations.values()) {
      const settlement = this.settlements.get(reservation.attemptId);
      if (settlement === undefined) held += reservation.amountMicroUsd;
    }
    for (const settlement of this.settlements.values()) {
      settled += settlement.costMicroUsd;
    }
    return { heldMicroUsd: held, settledMicroUsd: settled };
  }

  // The round keys the journal knows about, published or acknowledged.
  knows(roundKey: string): boolean {
    return this.manifests.has(roundKey) || this.acknowledged.has(roundKey);
  }

  record(roundKey: string): Assembled | undefined {
    const manifest = this.manifests.get(roundKey);
    return manifest === undefined
      ? undefined
      : assembleRecord(manifest, this.chunks);
  }

  carry(): Carried {
    return {
      reservations: [...this.reservations.values()],
      settlements: [...this.settlements.values()],
      suppressions: [...this.suppressions.values()],
      roundKeys: [...new Set([...this.manifests.keys(), ...this.acknowledged])],
      resets: this.resets,
    };
  }

  #add(record: JournalRecord): void {
    const data = record.data as Record<string, unknown>;
    switch (record.type) {
      case 'reservation':
        this.reservations.set(
          data.attemptId as string,
          data as unknown as Reservation,
        );
        break;
      case 'settlement':
        this.settlements.set(
          data.attemptId as string,
          data as unknown as Settlement,
        );
        break;
      case 'publication-chunk':
        this.chunks.push(data as unknown as JournalChunk);
        break;
      case 'publication-manifest':
        this.manifests.set(
          data.roundKey as string,
          data as unknown as RecordManifest,
        );
        break;
      case 'receipt':
        this.receipts.set(data.effectId as string, data.commentId as number);
        break;
      case 'abandoned':
        this.abandoned.add(data.roundKey as string);
        break;
      case 'suppression':
        this.suppressions.set(
          data.findingId as string,
          data as unknown as Suppression,
        );
        break;
      case 'reset':
        this.#reset(data.carried as Carried);
        break;
    }
  }

  #reset(carried: Carried): void {
    this.resets = carried.resets + 1;
    for (const item of carried.reservations)
      this.reservations.set(item.attemptId, item);
    for (const item of carried.settlements)
      this.settlements.set(item.attemptId, item);
    for (const item of carried.suppressions)
      this.suppressions.set(item.findingId, item);
    for (const key of carried.roundKeys) this.acknowledged.add(key);
  }
}
