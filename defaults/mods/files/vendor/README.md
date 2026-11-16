# Bundled preview renderer

Pinned npm packages, fetched from registry.npmjs.org. No CDN or package download is used at runtime. Upstream source files are copied without modification; LICENSE-mermaid-dependencies retains notices for Mermaid’s production dependency graph.

- Marked 15.0.12: https://www.npmjs.com/package/marked/v/15.0.12; LICENSE-marked.
- DOMPurify 3.3.3: https://www.npmjs.com/package/dompurify/v/3.3.3; LICENSE-purify.
- Mermaid 12.3.0: https://www.npmjs.com/package/mermaid/v/12.3.0; LICENSE-mermaid.
- highlight.js 11.11.1: https://www.npmjs.com/package/@highlightjs/cdn-assets/v/11.11.1; LICENSE-highlight.

SHA-256 of shipped renderer files:

```text
9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019  highlight.css
c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381  highlight.min.js
29e25cdf1a06075c90e9885af06ddd23fb22a5424ed23a61dda986c73a8af641  marked-module.js
3e7e7d7feb3e5d58cb6c804f68ab5c24cc7e5eb6270fd6e5cbb9124739217d0c  marked.min.js
336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3  mermaid.min.js
a95e028e5efd6a7413d1d18d6d9f918fdad19e2be6e962fcbaa10ab1b364725c  purify.min.js
```
