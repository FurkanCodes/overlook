/**
 * Readable labels from SQL names, shared by the page and the automatic
 * dashboard builder so both say "MRR", never "Mrr".
 */

/** Words that read as capitals in a label: "mrr" -> "MRR", "user_id" -> "User ID". */
const ACRONYMS = new Set([
  'id', 'ids', 'url', 'urls', 'api', 'ip', 'kpi', 'mrr', 'arr', 'arpu', 'arpa', 'ltv', 'cac', 'roi', 'roas', 'ctr', 'cpc', 'cpm', 'cpa',
  'sku', 'skus', 'utc', 'usd', 'eur', 'gbp', 'gmv', 'aov', 'nps', 'csat', 'sla', 'dau', 'wau', 'mau', 'qps', 'rps', 'p50', 'p90', 'p95', 'p99',
  'cpu', 'gpu', 'ram', 'os', 'ui', 'utm', 'seo', 'sms', 'b2b', 'b2c', 'yoy', 'qoq', 'ytd', 'mtd', 'eta', 'faq', 'vat', 'gdp',
]);

function words(id: string): string[] {
  return id.replace(/_/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function fix(w: string): string {
  return ACRONYMS.has(w.toLowerCase()) && w === w.toLowerCase() ? w.toUpperCase() : w;
}

/** "refund_rate" -> "Refund rate". */
export function humanize(id: string): string {
  const t = words(id).map(fix).join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The same label for use mid-sentence: "refund_rate" -> "refund rate", "mrr" -> "MRR". */
export function lowerLabel(id: string): string {
  return words(id)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) && w === w.toLowerCase() ? w.toUpperCase() : w.toLowerCase()))
    .join(' ');
}
