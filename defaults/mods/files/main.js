// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, agents, focused, appHome, exec, renderPdf, readTextFile, watchFolder, theme, settings, window, props, openOverlay, closeOverlay, openWindow, closeWindow, setWindowDocument, nextCommand, run } from "herdr";
import { mkdir, writeFile, readFile, readdir, unlink, rmdir, exists } from "fs/promises";
import { Buffer } from "buffer";
import { marked } from "./vendor/marked-module.js";
import { buildPreviewPage } from "./preview-page.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

function relativePath(file, cwd) {
  const windows = /^[a-z]:[\\/]|^(?:\\\\|\/\/)/i.test(cwd);
  const parts = value => {
    if (windows) value = value.replace(/\\/g, "/");
    const root = windows ? value.match(/^(?:[a-z]:|\/\/[^/]+\/[^/]+)(?=\/|$)/i)?.[0] : value.startsWith("/") ? "/" : null;
    if (!root) throw new Error("Cannot determine a relative path for this terminal");
    const rest = [];
    for (const part of value.slice(root.length).split("/")) {
      if (part === "..") rest.pop();
      else if (part && part !== ".") rest.push(part);
    }
    return { root, rest };
  };
  const from = parts(cwd), to = parts(file), same = (a, b) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(from.root, to.root)) throw new Error("Cannot attach a path on a different drive or share");
  let common = 0;
  while (common < from.rest.length && common < to.rest.length && same(from.rest[common], to.rest[common])) common++;
  return [...from.rest.slice(common).map(() => ".."), ...to.rest.slice(common)].join("/") || ".";
}

// Each chunk stays below exec's 8 MiB output bound, including the remote JSON wrapper.
async function mediaBytes(path, on, limit = 20 * 1024 * 1024, truncate = false) {
  let windows = !on && window()?.platform === "windows";
  const quote = value => "'" + value.replace(/['‘’‚‛]/g, "$&$&") + "'";
  const call = async (offset, count) => {
    const powershell = () => exec("powershell", ["-NoProfile", "-Command", offset === null ?
      "& { param($p) $f=Get-Item -LiteralPath $p -ErrorAction Stop; if ($f.PSIsContainer) { throw 'Not a regular file' }; $f.Length } " + quote(path) :
      "& { param($p,$offset,$count) $f=[IO.File]::OpenRead($p); try { $f.Position=$offset; $b=New-Object byte[] $count; $n=0; while ($n -lt $count) { $r=$f.Read($b,$n,$count-$n); if ($r -eq 0) { break }; $n+=$r }; [Convert]::ToBase64String($b,0,$n) } finally { $f.Dispose() } } " + quote(path) + ` ${offset} ${count}`], { on });
    let result;
    if (windows) result = await powershell();
    else {
      try { result = await exec("sh", ["-c", offset === null ? 'test -f "$1" || exit 1; wc -c < "$1"' : 'dd if="$1" bs=1048576 skip="$2" count=1 2>/dev/null | head -c "$3" | base64', "preview", path, String((offset ?? 0) / 1048576), String(count ?? 0)], { on }); }
      catch (e) { if (on && String(e).includes("cannot start sh: program not found")) { windows = true; result = await powershell(); } else throw e; }
    }
    if (result.code !== 0) throw new Error(result.stderr || "Cannot read this file");
    return result.stdout.trim();
  };
  const size = await call(null);
  if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) throw new Error("Invalid preview file size");
  const length = Number(size);
  if (!truncate && length > limit) throw new Error(`Preview limit: ${limit / 1048576} MiB`);
  const take = Math.min(length, limit), chunks = [];
  for (let offset = 0; offset < take; offset += 1048576) {
    const count = Math.min(1048576, take - offset), encoded = (await call(offset, count)).replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 || encoded.length > Math.ceil(count / 3) * 4) throw new Error("Invalid or oversized preview data");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== count) throw new Error("File changed or incomplete preview data");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.preview = props()?.preview;
    if (this.preview) {
      this.handle = cx.focus_handle(); this.handle.focus();
      this.windowKey = props()?.windowKey;
      this.generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (this.windowKey) this.listenWindow(cx);
      this.zoom = 1; this.mode = "rendered"; this.viewport = { width: 800, height: 500 };
      this.loadPreview(cx);
      return;
    }
    this.menu = props()?.context;
    if (this.menu) {
      this.handle = cx.focus_handle(); this.handle.focus(); this.at = 0;
      return;
    }
    this.lastAgent = new Map();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  contextTargets(space) {
    const all = agents().filter(a => a.space === space), f = focused();
    const current = all.find(a => a.address === (f?.shown || f?.terminal));
    if (current) this.lastAgent.set(space, current.address);
    const last = all.find(a => a.address === this.lastAgent.get(space));
    return last ? [last] : all;
  }

  attach(address, cx) {
    try {
      const { root, path, on, space } = this.menu;
      if (!agents().some(a => a.address === address && a.space === space)) throw new Error("This AI conversation is no longer available");
      const machine = address.includes("/") ? address.split("/")[0] : null;
      if (machine !== on) throw new Error("The file and AI conversation must be on the same machine");
      const cwd = panes().find(p => p.terminal === address)?.cwd;
      if (!cwd) throw new Error("The AI terminal's working directory is unavailable");
      const relative = relativePath(`${root}/${path}`, cwd);
      if (/[\x00-\x1f\x7f-\x9f]/.test(relative)) throw new Error("Cannot attach a path containing control characters");
      const text = ` ${/[\s"\\]/.test(relative) ? JSON.stringify(relative) : relative} `;
      closeOverlay(props()?.overlay);
      run("terminal.paste", { terminal: address, text });
      run("agent.focus", { terminal: address });
    } catch (error) { this.attachError = String(error.message ?? error); cx.notify(); }
  }

  contextMenu() {
    const t = theme(), targets = this.menu.targets;
    return v_flex().id("files-context").track_focus(this.handle).p(5).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props()?.overlay);
        else if (targets.length && e.key === "enter") this.attach(targets[this.at].address, cx);
        else if (targets.length && (e.key === "up" || e.key === "down")) { this.at = (this.at + (e.key === "down" ? 1 : targets.length - 1)) % targets.length; cx.notify(); }
      })
      .when(targets.length !== 1, el => el.child(div().p(8).text_color(t.dim).child(targets.length ? "Attach as context to…" : "No AI conversation in this workspace")))
      .children(targets.map((a, i) => div().id(`attach-${a.address}`).px(8).py(7).rounded(7).cursor_pointer()
        .when(i === this.at, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.attach(a.address, cx)).child(targets.length === 1 ? "Attach as context" : a.title ? `${a.title} · ${a.address}` : a.address)))
      .when(Boolean(this.attachError), el => el.child(div().p(8).text_color(t.ansi1).child(this.attachError)));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, space } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, selected: this.selected });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, space }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.selected = saved?.selected; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  listenWindow(cx) {
    cx.spawn(async cx => {
      while (!this.closed) {
        const command = await nextCommand();
        if (this.closed || !command.startsWith("webview:")) continue;
        let event;
        try { event = JSON.parse(command.slice(8)); } catch { continue; }
        if (event.type === "error") { this.browserError = event.message; cx.notify(); continue; }
        if (event.generation !== this.generation) continue;
        if (event.type === "close") closeWindow(this.windowKey);
        else if (event.type === "page" && Number.isInteger(event.page)) this.turnPage(event.page - (this.page ?? 1), cx);
      }
    });
  }

  async stage(bytes, name) {
    if (this.closed) return;
    if (!this.temp) {
      this.temp = `data/files/preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await mkdir(`${appHome()}/${this.temp}`, { recursive: true });
    }
    if (this.closed) { await this.removeTemporary(); return; }
    const path = `${this.temp}/${name}`;
    await writeFile(`${appHome()}/${path}`, bytes);
    if (this.closed) { await this.removeTemporary(); return; }
    return path;
  }

  async markdownImages(text) {
    const images = Object.create(null), sources = new Set();
    marked.walkTokens(marked.lexer(text), token => {
      if (token.type === "image") sources.add(token.href);
    });
    const windows = /^[a-z]:[\\/]|^(?:\\\\|\/\/)/i.test(this.preview.root);
    const separators = value => windows ? value.replace(/\\/g, "/") : value;
    const folder = separators(`${this.preview.root}/${this.preview.path}`).replace(/\/[^/]*$/, "");
    const volume = windows ? folder.match(/^(?:[a-z]:|\/\/[^/]+\/[^/]+)/i)?.[0] ?? "" : "";
    let index = 0, total = 0;
    for (const src of sources) {
      if (this.closed) break;
      // Network images load directly in the browser; data URLs and arbitrary schemes are not files.
      if (/^https?:\/\//i.test(src)) continue;
      if (index >= 100 || total >= 50 * 1048576) { images[src] = { error: "Document image budget exceeded (100 images / 50 MiB)" }; continue; }
      if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) { images[src] = { error: "Unsupported image URL" }; continue; }
      const number = index++;
      try {
        const path = separators(decodeURIComponent(src.split(/[?#]/)[0]));
        if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid image path");
        const full = windows && /^(?:[a-z]:\/|\/\/)/i.test(path) ? path : path.startsWith("/") ? volume + path : `${folder}/${path}`;
        const prefix = windows ? full.match(/^(?:[a-z]:|\/\/[^/]+\/[^/]+)/i)?.[0] : "";
        if (windows && !prefix || !windows && !full.startsWith("/")) throw new Error("Image path must be absolute");
        const parts = [];
        for (const part of full.slice(prefix?.length ?? 0).split("/")) {
          if (part === "..") parts.pop();
          else if (part && part !== ".") parts.push(part);
        }
        const absolute = `${prefix ?? ""}/${parts.join("/")}`, ext = path.match(/\.[^./]*$/)?.[0].toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".svg", ".ico", ".avif"].includes(ext)) throw new Error("Unsupported image format");
        const bytes = await mediaBytes(absolute, this.preview.on, Math.min(20 * 1048576, 50 * 1048576 - total));
        total += bytes.length;
        const staged = await this.stage(bytes, `image-${number}${ext}`);
        if (staged) images[src] = { url: staged.split("/").pop() };
      } catch (e) { images[src] = { error: String(e.message ?? e) }; }
    }
    return images;
  }

  async publishDocument() {
    if (!this.windowKey || this.closed) return;
    if (!this.libraries) {
      const base = `${appHome()}/${"mods/files"}`;
      const names = ["vendor/marked.min.js", "vendor/purify.min.js", "vendor/mermaid.min.js", "vendor/highlight.min.js", "preview.css", "preview-client.js", "vendor/highlight.css"];
      const parts = await Promise.all(names.map(path => readFile(`${base}/${path}`, "utf8")));
      this.libraries = { marked: parts[0], purify: parts[1], mermaid: parts[2], highlight: parts[3], css: parts[4] + "\n" + parts[6], client: parts[5] };
    }
    if (this.closed) return;
    const data = { path: this.preview.path, generation: this.generation,
      kind: this.pdf ? "pdf" : this.asset ? "image" : this.markdown ? "markdown" : "text",
      text: this.text ?? "", language: this.language, images: this.images ?? {},
      src: this.asset?.split("/").pop(), width: this.rasterWidth, height: this.rasterHeight,
      page: this.page, pages: this.pages, error: this.fileError, truncated: this.truncated };
    const path = await this.stage(buildPreviewPage(data, this.libraries), "index.html");
    if (!this.closed && path) setWindowDocument(`${appHome()}/${path}`);
  }

  loadPreview(cx) {
    const { root, path, on } = this.preview;
    const ext = path.split(".").pop().toLowerCase();
    this.markdown = ext === "md" || ext === "markdown";
    this.pdf = ext === "pdf";
    this.language = LANG[ext] ?? ({ py: "python", rb: "ruby", rs: "rust", sh: "bash" }[ext] || ext);
    cx.spawn(async cx => {
      if (this.closed) return;
      try {
        if (this.pdf || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "ico", "avif"].includes(ext)) {
          const bytes = await mediaBytes(`${root}/${path}`, on, (this.pdf ? 50 : 20) * 1048576);
          if (!bytes.length) throw new Error("This file is empty");
          const staged = await this.stage(bytes, `source.${ext}`);
          if (!staged || this.closed) return;
          if (this.pdf) {
            this.pdfFile = `${appHome()}/${staged}`;
            await this.readPdfPage(1);
          } else this.asset = staged;
        } else {
          // Preserve a UTF-8 prefix even when the cut falls inside a multi-byte character.
          const bytes = await mediaBytes(`${root}/${path}`, on, 1048577, true);
          if (this.closed) return;
          this.truncated = bytes.length > 1048576;
          this.text = bytes.subarray(0, 1048576).toString("utf8");
          if (/[\x00-\x08\x0e-\x1f]/.test(this.text)) throw new Error("Binary file · no preview available");
          const t = theme();
          this.code = EditorState.new({ language: this.language, readonly: true, value: this.text,
            font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
          if (this.markdown && this.windowKey) this.images = await this.markdownImages(this.text);
        }
      } catch (error) { if (!this.closed) this.fileError = String(error.message ?? error); }
      finally {
        if (!this.closed) {
          try { await this.publishDocument(); } catch (error) { if (!this.closed) this.fileError = String(error.message ?? error); }
          if (!this.closed) cx.notify();
        }
      }
    });
  }

  async readPdfPage(page) {
    this.pageLoading = true; this.fileError = null;
    try {
      const result = await renderPdf(this.pdfFile, { page, width: 1600 });
      if (this.closed) return;
      const previous = this.asset;
      this.asset = result.path; this.page = page; this.pages = result.pages;
      this.rasterWidth = result.width; this.rasterHeight = result.height;
      // A failed temporary-file removal is retried by close().
      if (previous) await unlink(`${appHome()}/${previous}`).catch(() => {});
    } catch (error) { this.fileError = String(error.message ?? error); }
    finally { this.pageLoading = false; }
  }

  turnPage(delta, cx) {
    const page = (this.page ?? 1) + delta;
    if (this.closed || !this.pdfFile || this.pageLoading || page < 1 || (this.pages && page > this.pages)) return;
    this.pageLoading = true;
    cx.spawn(async cx => { if (this.closed) return; await this.readPdfPage(page); if (!this.closed) { await this.publishDocument(); cx.notify(); } });
    cx.notify();
  }

  async close() {
    this.closed = true;
    this.code?.release();
    await this.removeTemporary();
  }

  async removeTemporary() {
    if (this.temp) {
      const dir = `${appHome()}/${this.temp}`;
      if (!await exists(dir)) return;
      for (const name of await readdir(dir)) await unlink(`${dir}/${name}`);
      await rmdir(dir);
    }
  }

  changeZoom(factor, cx, reset = false) {
    this.zoom = reset ? 1 : Math.max(0.1, Math.min(8, this.zoom * factor));
    cx.notify();
  }

  previewView() {
    const t = theme();
    const button = (id, label, action) => div().id(id).px(10).py(5).rounded(6).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click(action).child(label);
    return v_flex().id("files-preview").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e) => { if (e.key === "escape") this.windowKey ? closeWindow(this.windowKey) : closeOverlay(props()?.overlay); })
      .child(h_flex().h(46).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().child(this.preview.path))
        .when(this.markdown, el => el.children([
          button("preview-rendered", this.mode === "rendered" ? "● Rendered" : "Rendered", (_e, cx) => { this.mode = "rendered"; cx.notify(); }),
          button("preview-source", this.mode === "source" ? "● Source" : "Source", (_e, cx) => { this.mode = "source"; cx.notify(); })]))
        .when(this.pdf, el => el.children([
          button("preview-prev", "←", (_e, cx) => this.turnPage(-1, cx)),
          div().text_color(t.dim).child(this.pageLoading ? "Rendering…" : `Page ${this.page ?? 1} / ${this.pages ?? "…"}`),
          button("preview-next", "→", (_e, cx) => this.turnPage(1, cx))]))
        .when(Boolean(this.pdfFile) && Boolean(this.fileError), el => el.child(button("preview-retry", "Retry", (_e, cx) => this.turnPage(0, cx))))
        .when(Boolean(this.asset), el => el.children([
          button("preview-minus", "−", (_e, cx) => this.changeZoom(1 / 1.25, cx)),
          div().text_color(t.dim).child(`${Math.round(this.zoom * 100)}%`),
          button("preview-plus", "+", (_e, cx) => this.changeZoom(1.25, cx)),
          button("preview-fit", "Fit", (_e, cx) => this.changeZoom(1, cx, true))]))
        .child(button("preview-close", "Close · Esc", () => this.windowKey ? closeWindow(this.windowKey) : closeOverlay(props()?.overlay))))
      .when(Boolean(this.browserError), el => el.child(div().p(8).text_color(t.ansi3).child(this.browserError)))
      .child(this.fileError ? div().p(16).text_color(t.ansi1).child(this.fileError) : this.asset ?
        div().id("preview-image-scroll").flex_1().min_h(0).overflow_scrollbar()
          .on_size_change((size, cx) => { this.viewport = size; cx.notify(); })
          .on_scroll_wheel((e, cx) => { cx.stop_propagation(); this.changeZoom(Math.exp(Math.max(-1, Math.min(1, e.delta.y * 0.005))), cx); })
          .child(image(this.asset).w(this.viewport.width * this.zoom).h(this.viewport.height * this.zoom).flex_none()) :
        this.code ? (this.markdown && this.mode === "rendered" ?
          TextView.markdown("preview-markdown", this.text).selectable(true).scrollable(true).flex_1().min_h(0) : Editor.new(this.code).flex_1().min_h(0)) :
          div().p(16).text_color(t.dim).child("Loading preview…"));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const space = this.context.space;
          openOverlay({ mod: "files", kind: "popup", width: 290, props: { context: { root: this.root, path, on: this.on, space, targets: this.contextTargets(space) } } });
        })
        .when(this.selected === path, el => el.bg(t.selected))
        .on_click((e, cx) => {
          if (entry.dir) { this.toggle(path, cx); return; }
          this.selected = path; cx.notify();
          if (e.click_count === 2) openWindow({ key: "files-preview", mod: "files", title: path, width: 1000, height: 740,
            props: { windowKey: "files-preview", preview: { root: this.root, path, on: this.on } } });
        })
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (this.preview) return this.previewView();
    if (this.menu) return this.contextMenu();
    this.contextTargets(location().space);
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
