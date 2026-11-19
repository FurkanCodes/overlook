# Third-party notices

Overlook bundles these projects into its dashboard page (`dist/ui`). The full
license text of every bundled package is in `dist/ui/licenses.txt`, which the
build generates from the bundle itself.

| Project | Use | License |
| --- | --- | --- |
| [Inter](https://rsms.me/inter/) by Rasmus Andersson, via `@fontsource-variable/inter` | UI typeface, served locally as `inter.woff2` | SIL Open Font License 1.1 (full text in `dist/ui/inter-LICENSE.txt`) |
| [Lucide](https://lucide.dev) | Icons | ISC |
| [d3](https://d3js.org): `d3-array`, `d3-color`, `d3-format`, `d3-interpolate`, `d3-path`, `d3-scale`, `d3-shape`, `d3-time`, `d3-time-format` | Chart scales, shapes, colors, and number and date formats | ISC |

Runtime dependencies keep their own licenses:

*   [`@duckdb/node-api`](https://github.com/duckdb/duckdb-node-neo) (MIT)
*   [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (MIT)
*   [`zod`](https://zod.dev) (MIT)

DuckDB downloads its `sqlite`, `postgres` and `mysql` extensions from
extensions.duckdb.org only when a source needs one. They are not bundled.
