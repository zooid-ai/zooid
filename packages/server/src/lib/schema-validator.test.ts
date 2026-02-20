import { describe, it, expect } from 'vitest';
import { validateEvent } from './schema-validator';

const schema = {
  alert: {
    required: ['level', 'message'],
    properties: {
      level: { type: 'string', enum: ['info', 'warn', 'error'] },
      message: { type: 'string' },
    },
  },
  metric: {
    required: ['name', 'value'],
    properties: {
      name: { type: 'string' },
      value: { type: 'number' },
    },
  },
};

describe('validateEvent', () => {
  it('accepts a valid alert event', () => {
    const result = validateEvent(schema, 'alert', {
      level: 'info',
      message: 'hello',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a valid metric event', () => {
    const result = validateEvent(schema, 'metric', { name: 'cpu', value: 42 });
    expect(result.valid).toBe(true);
  });

  it('rejects event with no type', () => {
    const result = validateEvent(schema, null, {
      level: 'info',
      message: 'hello',
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toContain(
      'must have a type',
    );
  });

  it('rejects event with undefined type', () => {
    const result = validateEvent(schema, undefined, {});
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error).toContain(
      'must have a type',
    );
  });

  it('rejects unknown event type', () => {
    const result = validateEvent(schema, 'unknown', { foo: 'bar' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Unknown event type');
      expect(result.error).toContain('alert');
      expect(result.error).toContain('metric');
    }
  });

  it('rejects missing required field', () => {
    const result = validateEvent(schema, 'alert', { level: 'info' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('message');
    }
  });

  it('rejects wrong type for a field', () => {
    const result = validateEvent(schema, 'metric', {
      name: 'cpu',
      value: 'not-a-number',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('value');
    }
  });

  it('rejects invalid enum value', () => {
    const result = validateEvent(schema, 'alert', {
      level: 'critical',
      message: 'oops',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('level');
    }
  });

  it('accepts data with extra fields (no additionalProperties restriction)', () => {
    const result = validateEvent(schema, 'alert', {
      level: 'info',
      message: 'hi',
      extra: true,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts empty data when no required fields', () => {
    const schemaNoRequired = {
      ping: { properties: { ts: { type: 'number' } } },
    };
    const result = validateEvent(schemaNoRequired, 'ping', {});
    expect(result.valid).toBe(true);
  });

  it('validates boolean type correctly', () => {
    const boolSchema = {
      toggle: {
        required: ['enabled'],
        properties: { enabled: { type: 'boolean' } },
      },
    };
    expect(validateEvent(boolSchema, 'toggle', { enabled: true }).valid).toBe(
      true,
    );
    expect(validateEvent(boolSchema, 'toggle', { enabled: 'yes' }).valid).toBe(
      false,
    );
  });
});
