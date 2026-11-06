import { z } from 'zod';

// ---------------------------------------------------------------------------
// The wording of a refused value, kept as wairon has always printed it.
//
// zod 4 rewrote its default messages ("Invalid input: expected number, received
// string" where zod 3 said "Expected number, received string"; an enum refusal no
// longer names the value it received). wairon prints these messages to people
// (a project.yaml or spec that does not parse) and hands them to AI agents (a tool
// call the MCP server refuses), so they keep the zod 3 wording. A schema's own
// message always wins: this map only words the issues a schema leaves to zod.
//
// Loaded for its effect by the modules that parse (the config and spec models and
// the MCP server), so it is in place before any parse, whichever entry point runs.
// ---------------------------------------------------------------------------

type Issue = Parameters<z.core.$ZodErrorMap>[0];

/** The type name zod 3 reported for a received value. */
function receivedType(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  if (input instanceof Date) return 'date';
  if (typeof input === 'number' && Number.isNaN(input)) return 'nan';
  return typeof input;
}

function quoted(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

function sizeMessage(issue: Issue, small: boolean): string | undefined {
  const bound = small ? (issue as { minimum?: unknown }).minimum : (issue as { maximum?: unknown }).maximum;
  const inclusive = (issue as { inclusive?: boolean }).inclusive !== false;
  const origin = (issue as { origin?: string }).origin;
  const n = String(bound);
  if (origin === 'string') {
    return `String must contain ${small ? (inclusive ? 'at least' : 'over') : (inclusive ? 'at most' : 'under')} ${n} character(s)`;
  }
  if (origin === 'array' || origin === 'set') {
    const kind = origin === 'array' ? 'Array' : 'Set';
    return `${kind} must contain ${small ? (inclusive ? 'at least' : 'more than') : (inclusive ? 'at most' : 'less than')} ${n} element(s)`;
  }
  if (origin === 'number' || origin === 'int' || origin === 'bigint') {
    const kind = origin === 'bigint' ? 'BigInt' : 'Number';
    return `${kind} must be ${small ? (inclusive ? 'greater than or equal to' : 'greater than') : (inclusive ? 'less than or equal to' : 'less than')} ${n}`;
  }
  return undefined;
}

/** The zod 3 message for an issue zod words itself, or undefined to keep zod's. */
export function zod3Message(issue: Issue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Required';
      if (issue.expected === 'int' && typeof issue.input === 'number') return 'Expected integer, received float';
      return `Expected ${issue.expected}, received ${receivedType(issue.input)}`;
    case 'invalid_value': {
      const values = (issue as { values?: unknown[] }).values;
      if (!Array.isArray(values)) return undefined;
      if (issue.input === undefined) return 'Required';
      const received = quoted(issue.input);
      return `Invalid enum value. Expected ${values.map(quoted).join(' | ')}, received ${received}`;
    }
    case 'unrecognized_keys': {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      return `Unrecognized key(s) in object: ${keys.map((k) => `'${k}'`).join(', ')}`;
    }
    case 'too_small':
      return sizeMessage(issue, true);
    case 'too_big':
      return sizeMessage(issue, false);
    case 'invalid_union': {
      // A discriminated union names the values its discriminator takes, as zod 3 did.
      const options = (issue as { note?: string; options?: unknown[] }).options;
      if ((issue as { note?: string }).note === 'No matching discriminator' && Array.isArray(options)) {
        return `Invalid discriminator value. Expected ${options.map(quoted).join(' | ')}`;
      }
      return 'Invalid input';
    }
    default:
      return undefined;
  }
}

z.config({ customError: zod3Message });
