import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../src/models/zod-messages';

// wairon prints zod's messages to people and hands them to AI agents. zod 4 reworded its
// defaults; these are the zod 3 messages wairon has always printed, captured from zod 3.25
// on the same inputs, and a schema's own message still wins.
const CASES: Array<[string, z.ZodType, unknown, string]> = [
  ['type mismatch', z.object({ waironMajor: z.number() }), { waironMajor: 'six' }, "Expected number, received string"],
  ['required', z.object({ id: z.string() }), {}, "Required"],
  ['null', z.object({ id: z.string() }), { id: null }, "Expected string, received null"],
  ['array for object', z.object({ a: z.object({}) }), { a: [] }, "Expected object, received array"],
  ['strict keys', z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 }, "Unrecognized key(s) in object: 'b', 'c'"],
  ['string min', z.string().min(2), 'x', "String must contain at least 2 character(s)"],
  ['string max', z.string().max(1), 'xy', "String must contain at most 1 character(s)"],
  ['array min', z.array(z.string()).min(1), [], "Array must contain at least 1 element(s)"],
  ['array max', z.array(z.string()).max(1), ['a', 'b'], "Array must contain at most 1 element(s)"],
  ['number gte', z.number().min(1), 0, "Number must be greater than or equal to 1"],
  ['number gt', z.number().gt(5), 5, "Number must be greater than 5"],
  ['number lte', z.number().max(3), 9, "Number must be less than or equal to 3"],
  ['int', z.number().int(), 1.5, "Expected integer, received float"],
  ['enum', z.enum(['HTTP', 'gRPC']), 'HTTP_API', "Invalid enum value. Expected 'HTTP' | 'gRPC', received 'HTTP_API'"],
  ['enum missing', z.object({ t: z.enum(['a', 'b']) }), {}, "Required"],
  ['union', z.union([z.string(), z.number()]), true, "Invalid input"],
  ['discriminator', z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })]), { kind: 'c' }, "Invalid discriminator value. Expected 'a' | 'b'"],
  ['custom message kept', z.string().min(1, 'id must not be empty'), '', "id must not be empty"],
  ['record value', z.record(z.string(), z.number()), { a: 'x' }, "Expected number, received string"],
];

describe('the wording of a refused value', () => {
  it.each(CASES)('%s', (_name, schema, value, expected) => {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.message).join(' | ')).toBe(expected);
  });
});
