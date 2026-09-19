import { describe, it, expect } from 'vitest';
import { extractTypeIdentifiers, methodTypeRefs } from '../../src/models/type-references.js';

// ---------------------------------------------------------------------------
// Union type references: which shapes the grammar supports, pinned.
//
// The tree already holds well over a hundred refs containing a union, nearly all
// of them `T | null` returns, and it validates clean — so union handling works.
// What it did not have was a statement of WHICH shapes work, which is the same
// as not knowing whether the next one an author writes will. This file is that
// statement, and it is what the schema's field descriptions point at.
//
// The rule underneath is simple and worth stating once: a type reference is
// TOKENIZED, not parsed as a type expression. Every identifier a string names is
// a reference that must resolve, and `|`, `<>`, `[]`, `,` and `()` are all just
// separators. That is why a union needs no special handling — and why a union of
// string LITERALS names no type at all.
// ---------------------------------------------------------------------------

describe('method_signature.typeRefs over unions', () => {
  /** [what an author writes, the identifiers it names] */
  const SUPPORTED: [string, string[]][] = [
    // The overwhelmingly common shape: an optional return.
    ['ApprovalRequest | null', ['ApprovalRequest', 'null']],
    ['ProjectConfig | undefined', ['ProjectConfig', 'undefined']],
    // Spacing around the bar is not part of the grammar.
    ['ApprovalRequest|null', ['ApprovalRequest', 'null']],
    ['Invoice |null', ['Invoice', 'null']],
    ['Invoice| null', ['Invoice', 'null']],
    // A union of two named types — both are references, both must resolve.
    ['Invoice | Receipt', ['Invoice', 'Receipt']],
    ['Invoice | Receipt | null', ['Invoice', 'Receipt', 'null']],
    ['Invoice | null | undefined', ['Invoice', 'null', 'undefined']],
    // Inside a generic, and with a generic inside a union member.
    ['Promise<Invoice | null>', ['Promise', 'Invoice', 'null']],
    ['Array<Invoice | null>', ['Array', 'Invoice', 'null']],
    ['Map<string, Invoice | null>', ['Map', 'string', 'Invoice', 'null']],
    ['Promise<Map<string, Invoice | null>>', ['Promise', 'Map', 'string', 'Invoice', 'null']],
    ['Result<Invoice, Error> | null', ['Result', 'Invoice', 'Error', 'null']],
    ['Record<string, Invoice | null> | undefined', ['Record', 'string', 'Invoice', 'null', 'undefined']],
    // Arrays, both ways round.
    ['Invoice[] | null', ['Invoice', 'null']],
    ['(Invoice | null)[]', ['Invoice', 'null']],
    // Qualified ids keep their namespace through a union.
    ['billing::Invoice | null', ['billing::Invoice', 'null']],
    ['billing.Invoice | null', ['billing.Invoice', 'null']],
    // Trailing prose is stripped from a union exactly as from anything else.
    ['Invoice | null — absent when unknown', ['Invoice', 'null']],
    ['Invoice | null (or nothing)', ['Invoice', 'null']],
    // All builtins: no named type to resolve, and nothing invented.
    ['string | number | boolean', ['string', 'number', 'boolean']],
  ];

  it.each(SUPPORTED)('reads every identifier out of %s', (written, expected) => {
    expect(extractTypeIdentifiers(written)).toEqual(expected);
  });

  it('a union of string literals names no type — there is nothing there to resolve', () => {
    expect(extractTypeIdentifiers("'read' | 'write'")).toEqual([]);
    expect(extractTypeIdentifiers('"read" | "write"')).toEqual([]);
  });

  it('structured params carry a union through untouched, signature prose unread', () => {
    expect(methodTypeRefs({
      signature: 'getById(id: string): ApprovalRequest | null',
      returns: 'ApprovalRequest | null',
      params: [{ name: 'id', type: 'ApprovalId | undefined' }],
    })).toEqual(['ApprovalId', 'undefined', 'ApprovalRequest', 'null']);
  });

  it('a prose signature is split on its own commas, so a union inside a generic stays whole', () => {
    // The comma inside Map<string, Receipt> must not end the parameter: a split
    // there would leave "Receipt> | null" as a parameter of its own.
    expect(methodTypeRefs({
      signature: 'save(x: Invoice | null, y: Map<string, Receipt> | null): void',
      returns: 'void',
    })).toEqual(['void', 'Invoice', 'null', 'Map', 'string', 'Receipt']);
  });

  it('a union inside a callback parameter is read, and the callback\'s own label is not', () => {
    expect(methodTypeRefs({
      signature: 'onDone(cb: (e: Error | null) => void): void',
      returns: 'void',
    })).toEqual(['void', 'Error', 'null']);
  });
});
