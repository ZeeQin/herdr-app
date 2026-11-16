# Native file preview

Approved behavior: double-click Files entries opens/reuses one independently movable system window; single-click selects. Read-only text and Markdown source/rendered modes, Mermaid diagrams, image/PDF zoom and panning, animated SVG (SMIL/CSS, no embedded script), Markdown images/diagrams opening a lightbox, local and HTTP(S) images loading automatically. macOS pinch gestures and two-finger panning. Staged images/SVG20 MiB, PDF50 MiB, text prefix1 MiB with explicit truncation.

## Implementation

1. Host a mod copy in a keyed native GPUI window; openWindow reuses position/size, closes the prior mod copy, and loads new props. closeWindow closes it. setWindowDocument installs a child system WebView scoped to that owner. This shared API extension was explicitly approved in conversation. No herdr-core changes.
2. Keep file selection, local/remote bounded chunked reads, Markdown local-image resolution, staging and PDF page rendering in Files mod. Each mod copy owns a document generation and staging directory; stale jobs cannot display a replacement document. Native close/replacement runs mod cleanup.
3. Render browser content with pinned, offline Marked/DOMPurify/Mermaid/highlight.js distributions. Treat untrusted SVG as an image, never inline document markup. Sanitize Markdown, use nonce CSP, restrict custom-protocol assets to canonical descendants of the staging directory, prohibit navigation/download/new windows and route IPC only to the owner.
4. Use browser media viewports for aspect-preserving Fit/100%, pointer-anchored pinch and ordinary two-axis scroll. The Markdown lightbox closes before the window on Esc and preserves document position. Invalid Mermaid blocks show an error and their source without hiding other content.
5. Verify chunk boundaries, quoted paths, Windows/remote resolution, truncation, late jobs, root close/reuse/ownership, browser sanitization/IPC, Mermaid rendering, actual animated SVG pixels and synthetic gesture handling. Run existing JS/Rust suites and refresh bundled notices/docs.

## Platform boundary

macOS uses system WebKit; Windows uses installed WebView2. Linux retains the original GPUI preview and displays a browser-unavailable notice; no new GTK dependency is introduced. Physical trackpad behavior and non-macOS browser hosting require platform runtime verification. Web-image HTTP(S) requests happen automatically as approved; their loading/decoding is managed by the system browser. Local Markdown staging is bounded to100 image attempts/50 MiB per document.

## Progress

- Native host, browser UI and Files integration implemented.
- Browser tests cover actual CSS/SMIL frame changes, script isolation, Mermaid charts, lightbox, Escape, huge-image Fit and synthetic Safari gestures.
- macOS `cargo check --tests --locked`, `cargo build --locked` and full `cargo test --locked` pass (409 unit tests plus integration and screenshot checks; existing ignored tests remain ignored).
- JavaScript suite passes (105 tests); the Files suite also passes its added parent/rooted/UNC path case (29 tests total in that suite).
- Files loads in the actual QuickJS checker, and generated documentation checks pass.
- An isolated application home/core session passes a real native WebKit smoke test: Markdown, local SVG, Mermaid, source control and owner-directed IPC. The native lifecycle regression starts with the main ShellRuntime already installed, matching the real application.
- Physical trackpad gestures and Windows/Linux runtime behavior remain unverified. No installation or release was performed for this iteration.
