import { Validator } from '@cfworker/json-schema';

export type ValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      error: string;
    };

/**
 * Validate an event against a channel's schema.
 *
 * The schema is a map of event types to JSON Schema-like property definitions:
 * ```json
 * {
 *   "alert": {
 *     "required": ["level", "message"],
 *     "properties": { "level": { "type": "string" }, "message": { "type": "string" } }
 *   }
 * }
 * ```
 *
 * This function converts the type entry into a proper JSON Schema and validates
 * using @cfworker/json-schema (Cloudflare Workers compatible).
 */
export function validateEvent(
  schema: Record<
    string,
    { required?: string[]; properties?: Record<string, unknown> }
  >,
  type: string | null | undefined,
  data: unknown,
): ValidationResult {
  if (!type) {
    return {
      valid: false,
      error: 'Event must have a type when publishing to a strict channel',
    };
  }

  const typeSchema = schema[type];
  if (!typeSchema) {
    const allowed = Object.keys(schema).join(', ');
    return {
      valid: false,
      error: `Unknown event type "${type}". Allowed types: ${allowed}`,
    };
  }

  // Build a JSON Schema object from the type definition
  const jsonSchema: Record<string, unknown> = {
    type: 'object',
    properties: typeSchema.properties ?? {},
  };
  if (typeSchema.required) {
    jsonSchema.required = typeSchema.required;
  }

  const validator = new Validator(jsonSchema, '7', false);
  const result = validator.validate(data);

  if (!result.valid) {
    const errors = result.errors
      .map((e) => {
        const loc =
          e.instanceLocation === '#'
            ? 'data'
            : e.instanceLocation.replace('#/', 'data.');
        return `${loc}: ${e.error}`;
      })
      .join('; ');
    return {
      valid: false,
      error: `Validation failed for type "${type}": ${errors}`,
    };
  }

  return { valid: true };
}
