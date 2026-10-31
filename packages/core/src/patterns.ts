/** A pattern as a regular expression: `*` matches anything, `{a,b}` either alternative, each a pattern itself. */
export function glob(pattern: string): RegExp {
  return new RegExp(`^${source(pattern)}$`);
}

function source(pattern: string): string {
  let result = "";
  for (const part of pattern.split(/(\*|\{[^}]*\})/)) {
    if (part === "*") result += ".*";
    else if (part.startsWith("{") && part.endsWith("}")) result += `(?:${part.slice(1, -1).split(",").map(source).join("|")})`;
    else result += escape(part);
  }
  return result;
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
