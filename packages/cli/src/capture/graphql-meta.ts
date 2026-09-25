/**
 * GraphQL return-type metadata for produced `gql:Root.field` surfaces: the named return type and
 * its category (object | interface | enum | scalar | union | input | unknown). Sent alongside the
 * surface on sync so the server can group a field under its returned entity. The canonical surface
 * ID never changes. An unresolved category is `unknown`, which the server treats conservatively.
 *
 * KEEP IN SYNC with packages/core/src/ledger/graphql-meta.ts (graphql-meta.parity.test.ts pins them).
 */

export interface GqlFieldMeta {
  returnType: string;
  returnTypeKind: string;
}

const BUILTIN_SCALARS = new Set(["Int", "Float", "String", "Boolean", "ID"]);

/** Drop descriptions, string literals and comments so their contents never parse as fields. */
function strip(src: string): string {
  return src
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, " ");
}

/** Every named type definition in a document → its category. `type X` is an object. */
export function graphqlTypeKinds(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of strip(content).matchAll(/\b(type|interface|enum|scalar|union|input)\s+(\w+)/g)) {
    if (!out.has(m[2]!)) out.set(m[2]!, m[1] === "type" ? "object" : m[1]!);
  }
  return out;
}

/** Root `Query`/`Mutation`/`Subscription` fields → `gql:Root.field` with the raw return type. */
export function graphqlRootFields(content: string): Array<{ surface: string; returnType: string }> {
  const s = strip(content);
  const out: Array<{ surface: string; returnType: string }> = [];
  for (const block of s.matchAll(/\b(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{/g)) {
    const root = block[1]!;
    const end = s.indexOf("}", block.index! + block[0].length);
    const body = s.slice(block.index! + block[0].length, end < 0 ? s.length : end);
    let i = 0;
    while (i < body.length) {
      const name = /^\s*(\w+)/.exec(body.slice(i));
      if (!name) break;
      i += name[0].length;
      while (/\s/.test(body[i] ?? "")) i++;
      if (body[i] === "(") {
        let d = 0;
        for (; i < body.length; i++) {
          if (body[i] === "(") d++;
          else if (body[i] === ")" && --d === 0) {
            i++;
            break;
          }
        }
        while (/\s/.test(body[i] ?? "")) i++;
      }
      if (body[i] !== ":") {
        i++;
        continue;
      }
      i++;
      while (/\s/.test(body[i] ?? "")) i++;
      // a type reference: optional list brackets, a name, then any `!` / `]` (e.g. `[[Order!]!]!`)
      const type = /^[[\s]*\w+(?:\s*[!\]])*/.exec(body.slice(i))?.[0];
      if (type) out.push({ surface: `gql:${root}.${name[1]!}`, returnType: type.replace(/\s+/g, "") });
      // directives and the rest of the line are not part of the next field
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? body.length : nl + 1;
    }
  }
  return out;
}

/** Resolve field metadata across a whole schema (types may be defined in other files). */
export function resolveGraphqlMeta(documents: string[]): Map<string, GqlFieldMeta> {
  const kinds = new Map<string, string>();
  for (const d of documents) for (const [k, v] of graphqlTypeKinds(d)) if (!kinds.has(k)) kinds.set(k, v);
  const out = new Map<string, GqlFieldMeta>();
  for (const d of documents) {
    for (const f of graphqlRootFields(d)) {
      const base = f.returnType.replace(/[[\]!\s]/g, "");
      const kind = BUILTIN_SCALARS.has(base) ? "scalar" : (kinds.get(base) ?? "unknown");
      out.set(f.surface, { returnType: f.returnType, returnTypeKind: kind });
    }
  }
  return out;
}
