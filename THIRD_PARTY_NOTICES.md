# Third-party notices

Live Deck code is licensed under MIT. Vendored dependencies retain their own licenses:

| Dependency | Version | License file |
| --- | --- | --- |
| reveal.js | 5.2.1 | [MIT](web/vendor/reveal.LICENSE) |
| Marked | 15.0.12 | [MIT and bundled notices](web/vendor/marked.LICENSE) |
| DOMPurify | 3.2.6 | [Apache-2.0 OR MPL-2.0](web/vendor/purify.LICENSE) |
| Apache ECharts | 5.6.0 | [Apache-2.0](web/vendor/echarts.LICENSE), [NOTICE](web/vendor/echarts.NOTICE) |

Exact upstream URLs, file sizes and SHA-256 hashes are recorded in
[the vendor manifest](web/vendor/manifest.json). These files are served locally;
the player does not fetch runtime dependencies from a CDN.

Playwright is a development dependency under Apache-2.0 and is installed from npm.
Jupyter and Codex are external tools; their respective licenses and service terms apply.
