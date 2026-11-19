/** The spec reference returned by `get_spec_reference`. Kept short on purpose. */
export const SPEC_REFERENCE = `# Overlook dashboard spec (version 1)

A dashboard is JSON:
{
  "version": 1,
  "title": "Sales overview",
  "description": "optional one-liner",
  "filters": [ ...optional, max 6 ],
  "panels": [ ...1 to 24 ]
}

## Panels
Every panel has "id" (letters, digits, _; unique), "type", optional "title",
"width" ("full" | "half" | "third") and "note" (one line under the chart).
Every panel except "text" has "source" (a source name from describe_data) and
"sql" (ONE read-only query: SELECT / WITH / FROM).

Do the analysis in SQL (GROUP BY, ORDER BY, LIMIT). The chart only maps result
columns. Refer to result column names exactly; alias them in SQL (AS revenue).

type      required            optional
kpi       value               compare, x, better ("up"|"down"), format, unit
bar       x, y                series, stacked, horizontal, format, unit
line      x, y                series, format, unit
area      x, y                series, stacked, format, unit
scatter   x, y (one column)   series, format, unit
table     -                   columns (subset/order), formats, format, unit
text      markdown            -

- table formats: per-column formats, e.g. {"revenue": "currency"}.
- y may be one column, or an array of columns (one series each).
- series: a column whose values split one y into several lines/bars.
  Use either a y array OR series, not both.
- kpi shows "value" from the first row; "compare" (same row) is the earlier
  value, shown as % change. Aggregate the query to one row.
  Or set "x" (e.g. a month column) and return one row per period ORDER BY x:
  the tile shows the LAST row, a sparkline of all rows, and the change from
  the previous row.
- format: "number" | "compact" (12.3K) | "currency" | "percent" (0.25 -> 25%).
  unit: e.g. "USD" for currency.
- line/area x should be a DATE/TIMESTAMP or number; cast text dates in SQL.
- Keep bar charts under ~20 bars (ORDER BY value DESC LIMIT 20).
- markdown supports headings (#), **bold**, *italic*, \`code\`, lists, [links](https://...).

## Tables in SQL
A file source is one table named after the source: FROM sales.
A SQLite/DuckDB source holds several tables: FROM shop.orders.
Call describe_data to see exact table and column names.

## Filters
{"id": "region", "label": "Region", "type": "select",
 "source": "sales", "options_sql": "SELECT DISTINCT region FROM sales ORDER BY 1"}
{"id": "since", "label": "Since", "type": "date", "default": "2026-01-01"}
type: "select" (with "options": [...] or "options_sql" + "source"), "text", "date".
Use a filter in SQL as $id. An unset filter is NULL, so write:
  WHERE ($region IS NULL OR region = $region)
    AND ($since IS NULL OR order_date >= CAST($since AS DATE))

## Example
{
  "version": 1,
  "title": "Revenue",
  "filters": [{"id": "region", "label": "Region", "type": "select", "source": "sales",
               "options_sql": "SELECT DISTINCT region FROM sales ORDER BY 1"}],
  "panels": [
    {"id": "total", "type": "kpi", "title": "Revenue (last 30 days)", "source": "sales",
     "sql": "SELECT sum(amount) FILTER (WHERE order_date >= current_date - 30) AS now, sum(amount) FILTER (WHERE order_date >= current_date - 60 AND order_date < current_date - 30) AS before FROM sales WHERE ($region IS NULL OR region = $region)",
     "value": "now", "compare": "before", "format": "currency", "unit": "USD"},
    {"id": "by_month", "type": "line", "title": "Revenue by month", "source": "sales",
     "sql": "SELECT date_trunc('month', order_date) AS month, sum(amount) AS revenue FROM sales WHERE ($region IS NULL OR region = $region) GROUP BY 1 ORDER BY 1",
     "x": "month", "y": "revenue", "format": "currency", "width": "full"},
    {"id": "top_products", "type": "bar", "title": "Top products", "source": "sales", "horizontal": true,
     "sql": "SELECT product, sum(amount) AS revenue FROM sales WHERE ($region IS NULL OR region = $region) GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
     "x": "product", "y": "revenue", "format": "compact"}
  ]
}

## Workflow
1. describe_data → see sources, tables, columns.
2. preview_query → try each query.
3. save_dashboard → fix any errors it lists and save again (same name replaces).
4. get_dashboard → read the current spec before editing; keep panel ids stable.
`;
