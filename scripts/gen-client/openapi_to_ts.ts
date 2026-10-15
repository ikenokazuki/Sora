/** OpenAPI（インライン展開済み）のスキーマを TypeScript の型表記に変える。分からないものは unknown。 */
export interface OpenApiSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function comment(text: string | undefined, indent: string): string {
  if (!text) return '';
  return `${indent}/** ${text.replace(/\*\//g, '* /').replace(/\s*\n\s*/g, ' ')} */\n`;
}

function base(schema: OpenApiSchema, indent: string): string {
  const union = schema.oneOf ?? schema.anyOf;
  if (union?.length) return union.map((s) => schemaToTs(s, indent)).join(' | ');
  if (schema.enum?.length) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  switch (schema.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': {
      const item = schemaToTs(schema.items, indent);
      return /[|{]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`;
    }
    case 'object': {
      const props = Object.entries(schema.properties ?? {});
      if (props.length === 0) {
        const extra = schema.additionalProperties;
        return extra && typeof extra === 'object' ? `Record<string, ${schemaToTs(extra, indent)}>` : 'Record<string, unknown>';
      }
      const inner = `${indent}  `;
      const lines = props.map(([key, value]) => {
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
        const optional = schema.required?.includes(key) ? '' : '?';
        return `${comment(value.description, inner)}${inner}${name}${optional}: ${schemaToTs(value, inner)};\n`;
      });
      return `{\n${lines.join('')}${indent}}`;
    }
    default: return 'unknown';
  }
}

export function schemaToTs(schema: OpenApiSchema | undefined, indent = ''): string {
  if (!schema) return 'unknown';
  const ts = base(schema, indent);
  return schema.nullable && ts !== 'unknown' ? `${ts} | null` : ts;
}
