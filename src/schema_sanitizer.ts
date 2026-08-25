/**
 * Gemini API / Vertex AI 互換 JSON Schema サニタイザー
 *
 * Google Gemini API の Schema (Protobuf) 仕様は OpenAPI 3.0 のサブセットであり、
 * 標準 JSON Schema (Draft-07, 2020-12, OpenAPI 3.1) に存在する以下のキーワードをサポートしていません:
 * - exclusiveMinimum / exclusiveMaximum (Gemini は minimum / maximum のみ)
 * - const (Gemini は enum のみ)
 * - type 配列 (例: ["string", "null"] -> type: "string", nullable: true)
 * - $schema などのメタフィールド
 *
 * 本モジュールは MCP ツールの inputSchema を Gemini が確実に解釈できる形式へ再帰的に変換します。
 */

export function sanitizeJsonSchemaForGemini<T = any>(schema: T): T {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeJsonSchemaForGemini(item)) as unknown as T;
  }

  const obj = { ...(schema as Record<string, any>) };

  // 1. $schema の削除
  delete obj.$schema;

  // 2. exclusiveMinimum の処理 (Gemini は minimum のみサポート)
  if (obj.exclusiveMinimum !== undefined) {
    if (typeof obj.exclusiveMinimum === 'number') {
      if (obj.minimum === undefined) {
        // int / integer の場合は +1、それ以外または未指定はそのまま minimum にマッピング
        if (obj.type === 'integer') {
          obj.minimum = obj.exclusiveMinimum + 1;
        } else {
          obj.minimum = obj.exclusiveMinimum;
        }
      }
    } else if (typeof obj.exclusiveMinimum === 'boolean' && obj.exclusiveMinimum === true && obj.minimum !== undefined) {
      // Draft-04 形式: { minimum: 0, exclusiveMinimum: true }
      if (obj.type === 'integer') {
        obj.minimum = obj.minimum + 1;
      }
    }
    delete obj.exclusiveMinimum;
  }

  // 3. exclusiveMaximum の処理 (Gemini は maximum のみサポート)
  if (obj.exclusiveMaximum !== undefined) {
    if (typeof obj.exclusiveMaximum === 'number') {
      if (obj.maximum === undefined) {
        if (obj.type === 'integer') {
          obj.maximum = obj.exclusiveMaximum - 1;
        } else {
          obj.maximum = obj.exclusiveMaximum;
        }
      }
    } else if (typeof obj.exclusiveMaximum === 'boolean' && obj.exclusiveMaximum === true && obj.maximum !== undefined) {
      if (obj.type === 'integer') {
        obj.maximum = obj.maximum - 1;
      }
    }
    delete obj.exclusiveMaximum;
  }

  // 4. const の処理 (Gemini は enum のみサポート)
  if (obj.const !== undefined) {
    if (!obj.enum) {
      obj.enum = [obj.const];
    }
    delete obj.const;
  }

  // 5. type 配列 (Union 型) の処理 (例: ["string", "null"] -> type: "string", nullable: true)
  if (Array.isArray(obj.type)) {
    const types = obj.type as string[];
    const isNullable = types.includes('null');
    const concreteTypes = types.filter((t) => t !== 'null');

    if (concreteTypes.length === 1) {
      obj.type = concreteTypes[0];
      if (isNullable) {
        obj.nullable = true;
      }
    } else if (concreteTypes.length === 0) {
      obj.type = 'string';
      if (isNullable) {
        obj.nullable = true;
      }
    }
  }

  // 6. properties の再帰サニタイズ
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    const newProps: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj.properties)) {
      newProps[key] = sanitizeJsonSchemaForGemini(val);
    }
    obj.properties = newProps;
  }

  // 7. items の再帰サニタイズ
  if (obj.items) {
    obj.items = sanitizeJsonSchemaForGemini(obj.items);
  }

  // 8. anyOf / allOf / oneOf の再帰サニタイズ
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf = obj.anyOf.map(sanitizeJsonSchemaForGemini);
  }
  if (Array.isArray(obj.allOf)) {
    obj.allOf = obj.allOf.map(sanitizeJsonSchemaForGemini);
  }
  if (Array.isArray(obj.oneOf)) {
    obj.oneOf = obj.oneOf.map(sanitizeJsonSchemaForGemini);
  }

  // 9. additionalProperties の再帰サニタイズ
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    obj.additionalProperties = sanitizeJsonSchemaForGemini(obj.additionalProperties);
  }

  return obj as T;
}
