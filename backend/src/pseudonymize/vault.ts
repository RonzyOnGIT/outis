import type { EntityType } from '../types.js';

export interface VaultEntry {
  placeholder: string;
  type: EntityType;
  /** Real value shown when restoring. The longest form seen, e.g. "John Smith" over "John". */
  value: string;
  /** Every surface form that maps to this placeholder. */
  aliases: string[];
}

export interface VaultData {
  version: 1;
  entries: VaultEntry[];
  counters: Partial<Record<EntityType, number>>;
}

function normalize(type: EntityType, value: string): string {
  const v = value.normalize('NFKC').trim().toLowerCase();
  switch (type) {
    case 'PHONE':
    case 'CARD':
      return v.replace(/\D/g, '');
    case 'IBAN':
    case 'ID':
      return v.replace(/[^a-z0-9]/g, '');
    default:
      return v.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '');
  }
}

function nameTokens(value: string): string[] {
  return normalize('PERSON', value)
    .split(/[\s.]+/)
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((t) => t.length > 1);
}

function isSubset(a: string[], b: string[]): boolean {
  return a.length > 0 && a.every((t) => b.includes(t));
}

/**
 * Maps real values to stable placeholders like [PERSON_1].
 * The same person/email/etc. always gets the same placeholder within a vault,
 * which is what keeps a conversation coherent for the AI on the other side.
 */
export class Vault {
  private entries: VaultEntry[];
  private counters: Partial<Record<EntityType, number>>;

  constructor(data?: VaultData | null) {
    this.entries = data?.entries?.map((e) => ({ ...e, aliases: [...e.aliases] })) ?? [];
    this.counters = { ...(data?.counters ?? {}) };
  }

  get size(): number {
    return this.entries.length;
  }

  list(): readonly VaultEntry[] {
    return this.entries;
  }

  byPlaceholder(placeholder: string): VaultEntry | undefined {
    const key = placeholder.toUpperCase().replace(/\s+/g, '').replace(/^\[?/, '[').replace(/\]?$/, ']');
    return this.entries.find((e) => e.placeholder === key);
  }

  find(type: EntityType, value: string): VaultEntry | undefined {
    const norm = normalize(type, value);
    const exact = this.entries.find((e) => e.type === type && e.aliases.some((a) => normalize(type, a) === norm));
    if (exact || type !== 'PERSON') return exact;

    // "Smith" or "John" → "John Smith"; "John Smith" → earlier "John". Most recent wins on ambiguity.
    const tokens = nameTokens(value);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.type !== 'PERSON') continue;
      const et = nameTokens(e.value);
      if (isSubset(tokens, et) || isSubset(et, tokens)) return e;
    }
    return undefined;
  }

  /** Get (or create) the placeholder for a value. */
  assign(type: EntityType, value: string): string {
    const existing = this.find(type, value);
    if (existing) {
      if (!existing.aliases.some((a) => normalize(type, a) === normalize(type, value))) existing.aliases.push(value);
      if (type === 'PERSON' && nameTokens(value).length > nameTokens(existing.value).length) existing.value = value;
      return existing.placeholder;
    }
    const n = (this.counters[type] ?? 0) + 1;
    this.counters[type] = n;
    const placeholder = `[${type}_${n}]`;
    this.entries.push({ placeholder, type, value, aliases: [value] });
    return placeholder;
  }

  clone(): Vault {
    return new Vault(this.toJSON());
  }

  toJSON(): VaultData {
    return {
      version: 1,
      entries: this.entries.map((e) => ({ ...e, aliases: [...e.aliases] })),
      counters: { ...this.counters },
    };
  }
}
