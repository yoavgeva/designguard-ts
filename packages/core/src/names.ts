import ts from "typescript";

/**
 * The text a message names a call by, on one line: `prisma.user.findUnique`, or for a chain of calls, where it starts
 * and the call that ends it, as `db.selectFrom(…).execute`.
 */
export function callee(named: ts.Expression): string {
  let first: ts.Expression | undefined;
  for (let node: ts.Expression = named; ; ) {
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) first = node;
    if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
    else break;
  }
  const text =
    first === undefined || !ts.isPropertyAccessExpression(named)
      ? oneLine(named.getText())
      : ts.isTaggedTemplateExpression(first)
        ? `${oneLine(first.tag.getText())}\`…\`.${named.name.text}`
        : `${oneLine((first as ts.CallExpression).expression.getText())}(…).${named.name.text}`;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Text on one line: line breaks and the indentation after them go, other runs of spaces become one. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, "").replace(/\s+/g, " ");
}
