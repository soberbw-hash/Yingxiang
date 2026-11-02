/** Search all terms without changing stored names, source text or metadata. */
export function matchesSearch(query: string, ...values: Array<string | undefined>) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}
