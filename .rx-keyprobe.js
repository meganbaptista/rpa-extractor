const names = Object.keys(process.env).filter((n) => /^ANTHROPIC|GATEWAY|_AI_/.test(n));
for (const n of names) {
  const v = process.env[n] || '';
  console.log(n, '=>', v.length > 50 ? `<${v.length} chars>` : v);
}
