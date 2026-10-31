/** A pattern as a regular expression: `*` matches anything, `{a,b}` either alternative. */
export function glob(pattern: string): RegExp {
  let source = "";
  for (const part of pattern.split(/(\*|\{[^}]*\})/)) {
    if (part === "*") source += ".*";
    else if (part.startsWith("{") && part.endsWith("}")) source += `(?:${part.slice(1, -1).split(",").map(escape).join("|")})`;
    else source += escape(part);
  }
  return new RegExp(`^${source}$`);
}

function escape(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
