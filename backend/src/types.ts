/** Kinds of personal information Nobody knows how to hide. */
export const ENTITY_TYPES = [
  'PERSON',
  'ORG',
  'LOCATION',
  'ADDRESS',
  'EMAIL',
  'PHONE',
  'CARD',
  'IBAN',
  'IP',
  'URL',
  'SECRET',
  'ID',
  'DATE',
  'USER',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** Where a detection came from. Useful for UI hints and debugging. */
export type SpanSource = 'rule' | 'ner' | 'dictionary' | 'propagated';

/** A detected piece of personal information inside a text. `end` is exclusive. */
export interface Span {
  start: number;
  end: number;
  type: EntityType;
  text: string;
  source: SpanSource;
  /** 0..1 confidence. Rules and dictionary matches are 1. */
  score: number;
}

/** Per-category switch: hide it or leave it alone. */
export type CategoryPolicy = Record<EntityType, boolean>;

export const DEFAULT_POLICY: CategoryPolicy = {
  PERSON: true,
  ORG: true,
  LOCATION: true,
  ADDRESS: true,
  EMAIL: true,
  PHONE: true,
  CARD: true,
  IBAN: true,
  IP: true,
  URL: false, // links are usually needed for the answer; secrets inside them are caught by other rules
  SECRET: true,
  ID: true,
  DATE: true,
  USER: true,
};

export interface DictionaryEntry {
  value: string;
  type: EntityType;
}

export interface DetectOptions {
  policy?: Partial<CategoryPolicy>;
  /** Terms the user always wants hidden (own name, company, project code names...). */
  alwaysHide?: DictionaryEntry[];
  /** Terms that must never be hidden (e.g. "ChatGPT", "Excel"). Case-insensitive. */
  neverHide?: string[];
  /** Minimum NER confidence. */
  nerThreshold?: number;
}

export const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: 'Name',
  ORG: 'Organization',
  LOCATION: 'Location',
  ADDRESS: 'Address',
  EMAIL: 'Email',
  PHONE: 'Phone',
  CARD: 'Card number',
  IBAN: 'Bank account',
  IP: 'IP address',
  URL: 'Link',
  SECRET: 'Secret / key',
  ID: 'ID number',
  DATE: 'Birth date',
  USER: 'Username',
};
