import { test, expect } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = await readFile(new URL("../defaults/mods/files/main.js", import.meta.url), "utf8");
const directorySource = source.slice(source.indexOf("async function directory("), source.indexOf("\nexport default class"));
const loadDirectory = (exec: Function, platform: string) => new Function("exec", "window", `${directorySource}; return directory;`)(exec, () => ({ platform }));
const directory = loadDirectory(
  async (command: string, args: string[]) => {
    // Hidden like the app's spawns: a visible console would give PowerShell UTF-8 and hide code page bugs.
    const p = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, stdout, stderr };
  },
  process.platform === "win32" ? "windows" : process.platform,
);

test("Files retries a remote Windows directory with PowerShell on that machine", async () => {
  const calls: { command: string; args: string[]; on: string }[] = [];
  const list = loadDirectory(async (command: string, args: string[], options: { on: string }) => {
    calls.push({ command, args, on: options.on });
    if (command === "sh") throw new Error("herdr.exec: cannot start sh: program not found");
    return { code: 0, stdout: '{"name":"中文.txt","dir":false}', stderr: "" };
  }, "linux");
  const path = "C:/O’Brien's $folder";
  expect(await list(path, "winvm")).toEqual([{ name: "中文.txt", dir: false }]);
  expect(calls.map(c => [c.command, c.on])).toEqual([["sh", "winvm"], ["powershell", "winvm"]]);
  expect(calls[0].args.at(-1)).toBe(path);
  expect(calls[1].args.at(-1)).toContain("'C:/O’’Brien''s $folder'");
  expect(calls[1].args.at(-1)).toContain("[Console]::OutputEncoding");
});

test("Files does not mask remote command failures with PowerShell", async () => {
  for (const failure of [new Error("connection lost"), new Error("cannot start sh: permission denied"), { code: 1, stdout: "", stderr: "folder denied" }]) {
    const calls: string[] = [];
    const list = loadDirectory(async (command: string) => {
      calls.push(command);
      if (failure instanceof Error) throw failure;
      return failure;
    }, "linux");
    await expect(list("/folder", "linuxvm")).rejects.toThrow(failure instanceof Error ? failure.message : failure.stderr);
    expect(calls).toEqual(["sh"]);
  }
});

test("Files keeps remote POSIX directory listings on sh", async () => {
  const calls: string[] = [];
  const list = loadDirectory(async (command: string) => {
    calls.push(command);
    return { code: 0, stdout: "d\0folder\0f\0file.txt\0", stderr: "" };
  }, "windows");
  expect(await list("/folder", "linuxvm")).toEqual([{ name: "folder", dir: true }, { name: "file.txt", dir: false }]);
  expect(calls).toEqual(["sh"]);
});

test("Files lists literal folder names, not shell expressions", async () => {
  const root = await mkdtemp(join(process.platform === "linux" ? "/var/tmp" : tmpdir(), "herdr-files-"));
  try {
    for (const name of ["Test Folder (ACME)", "O'Brien $folder; (ACME)", "O’Brien ‘quoted’ ‚low‛"]) {
      const folder = join(root, name);
      await mkdir(join(folder, "child"), { recursive: true });
      await writeFile(join(folder, "hello.txt"), "hello");
      const entries = await directory(folder, null);
      expect(entries.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
        { name: "child", dir: true }, { name: "hello.txt", dir: false },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files preserves Unicode names when listing and expanding folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-unicode-"));
  try {
    const folder = "中文目录 O'Brien (测试)", file = "项目说明.txt", child = "子文件.txt";
    await mkdir(join(root, folder));
    await writeFile(join(root, file), "hello");
    await writeFile(join(root, folder, child), "hello");
    const entries = await directory(root, null);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ name: folder, dir: true });
    expect(entries).toContainEqual({ name: file, dir: false });
    expect(await directory(join(root, folder), null)).toEqual([{ name: child, dir: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Files follows directory links one level at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-files-links-"));
  try {
    const target = join(root, "versions");
    await mkdir(target);
    for (let minor = 1; minor <= 9; minor++) {
      await mkdir(join(target, `0.${minor}.0`));
    }
    await writeFile(join(target, "0.9.0", "STORY.md"), "story preview");
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "ordinary.txt"), "ordinary");
    await symlink("versions", join(root, ".kb"), "dir");
    if (process.platform === "win32") await symlink(target, join(root, "junction"), "junction");
    await symlink(join(root, "ordinary.txt"), join(root, "file-link"), "file");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    // A cycle must be listed without recursively walking it.
    await symlink(target, join(target, "loop"), "dir");

    const entries = await directory(root, null);
    expect(entries).toHaveLength(process.platform === "win32" ? 7 : 6);
    if (process.platform === "win32") expect(entries).toContainEqual({ name: "junction", dir: true });
    expect(entries).toContainEqual({ name: ".kb", dir: true });
    expect(entries).toContainEqual({ name: "versions", dir: true });
    expect(entries).toContainEqual({ name: ".hidden", dir: true });
    expect(entries).toContainEqual({ name: "ordinary.txt", dir: false });
    expect(entries).toContainEqual({ name: "file-link", dir: false });
    expect(entries).toContainEqual({ name: "dangling", dir: false });
    const versions = await directory(join(root, ".kb"), null);
    expect(versions).toHaveLength(10);
    for (let minor = 1; minor <= 9; minor++) {
      expect(versions).toContainEqual({ name: `0.${minor}.0`, dir: true });
    }
    expect(versions).toContainEqual({ name: "loop", dir: true });
    expect(await directory(join(root, ".kb", "0.9.0"), null)).toEqual([{ name: "STORY.md", dir: false }]);
    expect(await readFile(join(root, ".kb", "0.9.0", "STORY.md"), "utf8")).toBe("story preview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ContextElement {
  nodes: any[] = [];
  calls: Record<string, any[]> = {};
  constructor() {
    const proxy: ContextElement = new Proxy(this, { get: (target, key: string) => key in target ? (target as any)[key] : (...args: any[]) => {
      if (key === "child") target.nodes.push(args[0]);
      else if (key === "children") target.nodes.push(...args[0]);
      else if (key === "when") { if (args[0]) args[1](proxy); }
      else target.calls[key] = args;
      return proxy;
    } });
    return proxy;
  }
}

function contextHarness(extra: Record<string, any> = {}) {
  const commands: any[] = [];
  const opened: any[] = [];
  let list: any[] = [], paneList: any[] = [], focus: any = null, menu: any = {};
  const bindings: Record<string, any> = {
    View: class {}, focused: () => focus, agents: () => list, panes: () => paneList,
    div: () => new ContextElement(), svg: () => new ContextElement(), h_flex: () => new ContextElement(), v_flex: () => new ContextElement(), theme: () => ({}),
    spaces: () => [{ id: "s1", active: true }], props: () => menu,
    run: (...args: any[]) => commands.push(args), closeOverlay: () => commands.push(["close"]),
    openOverlay: (options: any) => opened.push(options),
    ...extra,
  };
  const Files = new Function(...Object.keys(bindings), source.replace(/^import .*;\n/gm, "").replace("export default class Files", "return class Files"))(...Object.values(bindings));
  const view = new Files();
  return { view, commands, opened, set(agents: any[], panes: any[], current: any = null) { list = agents; paneList = panes; focus = current; }, menu(value: any) { menu = value; } };
}
const contextCx = { notify() {} };

test("Files attaches relative paths to a working agent without submitting or using the clipboard", () => {
  const h = contextHarness();
  h.set([{ address: "t1", space: "s1", status: "working" }], [{ terminal: "t1", cwd: "/repo/app" }]);
  h.view.menu = { root: "/repo", path: "src/中文 file.ts", on: null, space: "s1" };
  h.view.attach("t1", contextCx);
  expect(h.commands).toEqual([
    ["close"],
    ["terminal.paste", { terminal: "t1", text: ' "../src/中文 file.ts" ' }],
    ["agent.focus", { terminal: "t1" }],
  ]);
});

test("Files rejects cross-machine, unknown cwd and control characters without sending input", () => {
  for (const [address, cwd, path] of [["remote/t1", "/repo", "file"], ["t1", null, "file"], ["t1", "/repo", "bad\nfile"], ["t1", "/repo", "bad\x1bfile"]]) {
    const h = contextHarness();
    h.set([{ address, space: "s1" }], [{ terminal: address, cwd }]);
    h.view.menu = { root: "/repo", path, on: null, space: "s1" };
    h.view.attach(address, contextCx);
    expect(h.commands).toEqual([]);
    expect(h.view.attachError).toBeTruthy();
  }
});

test("Files resolves Windows relative paths and rejects different drives", () => {
  const h = contextHarness();
  h.set([{ address: "win/t1", space: "s1" }], [{ terminal: "win/t1", cwd: "c:\\Repo\\app" }]);
  h.view.menu = { root: "C:/Repo", path: "src/file.ts", on: "win", space: "s1" };
  h.view.attach("win/t1", contextCx);
  expect(h.commands[1]).toEqual(["terminal.paste", { terminal: "win/t1", text: " ../src/file.ts " }]);
  h.commands.length = 0;
  h.view.menu.root = "D:/Repo";
  h.view.attach("win/t1", contextCx);
  expect(h.commands).toEqual([]);
  expect(h.view.attachError).toBeTruthy();
});

test("Files targets the last focused agent in this space or offers a choice", () => {
  const h = contextHarness();
  const a = { address: "t1", space: "s1" }, b = { address: "t2", space: "s1" };
  h.set([a, b, { address: "t3", space: "other" }], [], { terminal: "t2", space: "s1" });
  h.view.lastAgent = new Map();
  expect(h.view.contextTargets("s1")).toEqual([b]);
  h.set([a, b], [], { terminal: null, space: "s1" });
  expect(h.view.contextTargets("s1")).toEqual([b]);
  h.set([a], []);
  expect(h.view.contextTargets("s1")).toEqual([a]);
  h.view.lastAgent.clear();
  h.set([a, b], []);
  expect(h.view.contextTargets("s1")).toEqual([a, b]);
});

test("Files attaches directories, preserves POSIX backslashes, and rejects a vanished target", () => {
  const h = contextHarness();
  h.set([{ address: "t1", space: "s1" }], [{ terminal: "t1", cwd: "/repo" }]);
  h.view.menu = { root: "/repo", path: "src", on: null, space: "s1" };
  h.view.attach("t1", contextCx);
  expect(h.commands[1]).toEqual(["terminal.paste", { terminal: "t1", text: " src " }]);
  h.commands.length = 0;
  h.view.menu.path = "back\\slash";
  h.view.attach("t1", contextCx);
  expect(h.commands[1]).toEqual(["terminal.paste", { terminal: "t1", text: ' "back\\\\slash" ' }]);
  h.commands.length = 0;
  h.set([], []);
  h.view.attach("t1", contextCx);
  expect(h.commands).toEqual([]);
  expect(h.view.attachError).toContain("no longer available");
});

test("Files refuses relative references across Windows network shares", () => {
  const h = contextHarness();
  h.set([{ address: "t1", space: "s1" }], [{ terminal: "t1", cwd: "\\\\server\\share\\app" }]);
  h.view.menu = { root: "\\\\server\\share", path: "src", on: null, space: "s1" };
  h.view.attach("t1", contextCx);
  expect(h.commands[1]).toEqual(["terminal.paste", { terminal: "t1", text: " ../src " }]);
  h.commands.length = 0;
  h.view.menu.root = "\\\\server\\other";
  h.view.attach("t1", contextCx);
  expect(h.commands).toEqual([]);
  expect(h.view.attachError).toContain("different drive or share");
});

test("Files follows the actual terminal instead of a stale agent block selection", () => {
  const h = contextHarness();
  const a = { address: "t1", space: "s1" }, b = { address: "t2", space: "s1" };
  h.view.lastAgent = new Map();
  h.set([a, b], [], { terminal: "t2", agent: "t1", space: "s1" });
  expect(h.view.contextTargets("s1")).toEqual([b]);
  h.view.lastAgent.clear();
  h.set([a, b], [], { terminal: "shell", agent: "t1", space: "s1" });
  expect(h.view.contextTargets("s1")).toEqual([a, b]);
});

test("Files right-click captures the file and targets without opening the preview", () => {
  const h = contextHarness();
  const agent = { address: "t1", space: "s1" };
  h.set([agent], [], { terminal: "t1" });
  Object.assign(h.view, { context: { space: "s1" }, root: "/repo", on: null, entries: new Map([["", [{ name: "src", dir: true }]]]), folders: new Set(), marks: {}, lastAgent: new Map() });
  const row = h.view.rows("", 0, [], {})[0];
  let stopped = false;
  row.calls.on_mouse_down[1]({}, { stop_propagation() { stopped = true; } });
  expect(stopped).toBe(true);
  expect(h.view.file).toBeUndefined();
  expect(h.opened[0]).toMatchObject({ mod: "files", kind: "popup", props: { context: { root: "/repo", path: "src", on: null, space: "s1", targets: [agent] } } });
});

test("Files popup keyboard chooses the captured target and Escape never pastes", () => {
  const h = contextHarness();
  const targets = [{ address: "t1", space: "s1" }, { address: "t2", space: "s1" }];
  h.set(targets, [{ terminal: "t1", cwd: "/repo" }, { terminal: "t2", cwd: "/repo" }], { terminal: "t1" });
  h.menu({ overlay: "popup", context: { root: "/repo", path: "file", on: null, space: "s1", targets } });
  h.view.init({}, { focus_handle: () => ({ focus() {} }) });
  const handler = h.view.render(contextCx).calls.on_key_down[0];
  handler({ key: "down" }, contextCx);
  handler({ key: "enter" }, contextCx);
  expect(h.commands[1]).toEqual(["terminal.paste", { terminal: "t2", text: " file " }]);
  h.commands.length = 0;
  handler({ key: "escape" }, contextCx);
  expect(h.commands).toEqual([["close"]]);
});

test("Files single click selects and double click opens a centered frozen preview", () => {
  const h = contextHarness();
  Object.assign(h.view, { context: { space: "s1" }, root: "/repo", on: "remote", entries: new Map([["", [{ name: "README.md", dir: false }]]]), folders: new Set(), marks: {} });
  const row = h.view.rows("", 0, [], {})[0];
  row.calls.on_click[0]({ click_count: 1 }, contextCx);
  expect(h.view.selected).toBe("README.md");
  expect(h.opened).toEqual([]);
  row.calls.on_click[0]({ click_count: 2 }, contextCx);
  expect(h.opened[0]).toMatchObject({ mod: "files", kind: "dialog", props: { preview: { root: "/repo", path: "README.md", on: "remote" } } });
  expect(h.view.file).toBeUndefined();
});

test("Files wheel zoom stays bounded and fit resets it", () => {
  const h = contextHarness();
  h.view.zoom = 1;
  h.view.changeZoom(100, contextCx);
  expect(h.view.zoom).toBe(8);
  h.view.changeZoom(0.001, contextCx);
  expect(h.view.zoom).toBe(0.1);
  h.view.changeZoom(1, contextCx, true);
  expect(h.view.zoom).toBe(1);
});

test("Files Markdown defaults to rendered and toggles to the same read-only source", async () => {
  const states: any[] = [], reads: any[] = [];
  const h = contextHarness({
    readTextFile: async (...args: any[]) => { reads.push(args); return "# Hello\n```java\nclass Main {}\n```"; },
    settings: () => ({}),
    EditorState: { new: (options: any) => { states.push(options); return options; } },
    Editor: { new: () => new ContextElement() },
    TextView: { markdown: (_id: string, text: string) => new ContextElement().child(text) },
  });
  h.menu({ preview: { root: "/original", path: "README.MD", on: "remote" } });
  let task: Promise<void>;
  h.view.init({}, { focus_handle: () => ({ focus() {} }), spawn: (fn: Function) => { task = fn(contextCx); } });
  await task!;
  expect(reads).toEqual([["/original/README.MD", { on: "remote" }]]);
  expect(h.view.mode).toBe("rendered");
  expect(states[0]).toMatchObject({ readonly: true, value: "# Hello\n```java\nclass Main {}\n```" });
  const nodes = (el: any): any[] => [el, ...(el?.nodes ?? []).flatMap(nodes)];
  const rendered = nodes(h.view.previewView());
  expect(rendered.some(el => el?.nodes?.includes(states[0].value))).toBe(true);
  const toggle = rendered.find(el => el?.calls?.id?.[0] === "preview-source");
  toggle.calls.on_click[0]({}, contextCx);
  expect(h.view.mode).toBe("source");
  expect(nodes(h.view.previewView()).some(el => el?.nodes?.includes(states[0].value))).toBe(false);
  expect(states).toHaveLength(1);
});

test("Files previews JSON and Java as read-only syntax-highlighted text and reports unreadable files", async () => {
  for (const [path, text, expected] of [["code.java", "class Main {}", "java"], ["data.json", '{"hello":true}', "json"], ["binary.bin", "bad\0data", null], ["missing.txt", null, null]]) {
    const states: any[] = [];
    const h = contextHarness({ readTextFile: async () => text, settings: () => ({}), EditorState: { new: (options: any) => { states.push(options); return options; } } });
    Object.assign(h.view, { preview: { root: "/repo", path, on: null } });
    let task: Promise<void>;
    h.view.loadPreview({ spawn: (fn: Function) => { task = fn(contextCx); } });
    await task!;
    if (expected) expect(states[0]).toMatchObject({ readonly: true, language: expected, value: text });
    else { expect(states).toEqual([]); expect(h.view.fileError).toBeTruthy(); }
  }
});

const mediaSource = source.slice(source.indexOf("async function mediaBytes("), source.indexOf("async function directory("));
const mediaReader = (exec: Function, platform = "linux") => new Function("exec", "window", "Buffer", `${mediaSource}; return mediaBytes;`)(exec, () => ({ platform }), Buffer);

test("Files stages literal image bytes without treating paths as shell code", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-image-"));
  try {
    const path = join(root, "O'Brien $(echo nope).png"), bytes = Buffer.from([0, 255, 128, 65]);
    await writeFile(path, bytes);
    const read = mediaReader(async (cmd: string, args: string[]) => {
      const child = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
      return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
    });
    expect(await read(path, null)).toEqual(bytes);
    await writeFile(path, Buffer.alloc(4194305));
    await expect(read(path, null)).rejects.toThrow("4 MiB");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Files rejects truncated image output and retries Windows on the captured machine", async () => {
  for (const stdout of ["", "eA", "eA==oops", "!@#$"]) {
    await expect(mediaReader(async () => ({ code: 0, stdout, stderr: "" }))("/img.png", null)).rejects.toThrow("preview data");
  }
  const calls: any[] = [];
  const read = mediaReader(async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (command === "sh") throw new Error("cannot start sh: program not found");
    return { code: 0, stdout: "eA==", stderr: "" };
  });
  expect(await read("C:/O’Brien's.png", "win")).toEqual(Buffer.from("x"));
  expect(calls.map(c => [c.command, c.options.on])).toEqual([["sh", "win"], ["powershell", "win"]]);
  expect(calls[1].args.at(-1)).toContain("'C:/O’’Brien''s.png'");
});

test("Files renders PDF page one, prevents out-of-range paging, and preserves zoom", async () => {
  const renders: any[] = [], writes: any[] = [], removed: string[] = [];
  const h = contextHarness({
    Buffer, appHome: () => "/app", window: () => ({ platform: "linux" }),
    exec: async () => ({ code: 0, stdout: "JVBERi0xLjQ=", stderr: "" }),
    mkdir: async () => {}, writeFile: async (...args: any[]) => { writes.push(args); },
    unlink: async (path: string) => { removed.push(path); },
    renderPdf: async (path: string, options: any) => { renders.push({ path, ...options }); return { path: `data/files/page-${options.page}.png`, pages: 2, width: 200, height: 100 }; },
  });
  Object.assign(h.view, { preview: { root: "/repo", path: "report.PDF", on: null }, zoom: 2 });
  let task: Promise<void>;
  const cx = { ...contextCx, spawn: (fn: Function) => { task = fn(contextCx); } };
  h.view.loadPreview(cx);
  await task!;
  expect(renders[0]).toMatchObject({ page: 1, width: 1600 });
  expect(renders[0].path).toBe(writes[0][0]);
  expect(h.view.page).toBe(1);
  expect(h.view.pages).toBe(2);
  expect(h.view.asset).toBe("data/files/page-1.png");
  h.view.turnPage(-1, cx);
  expect(renders).toHaveLength(1);
  h.view.turnPage(1, cx);
  await task!;
  expect(h.view.page).toBe(2);
  expect(h.view.zoom).toBe(2);
  expect(removed).toEqual(["/app/data/files/page-1.png"]);
  h.view.turnPage(1, cx);
  expect(renders).toHaveLength(2);
});

test("Files ignores repeat PDF page requests and allows retry after a render failure", async () => {
  let finish: Function;
  const h = contextHarness({ renderPdf: () => new Promise(resolve => { finish = resolve; }) });
  Object.assign(h.view, { pdfFile: "/staged/report.pdf", pdf: true, page: 1, pages: 3 });
  let task: Promise<void>;
  const cx = { ...contextCx, spawn: (fn: Function) => { task = fn(contextCx); } };
  h.view.turnPage(1, cx);
  expect(h.view.pageLoading).toBe(true);
  const first = task!;
  h.view.turnPage(1, cx);
  expect(task!).toBe(first);
  finish!({ path: "data/files/page2.png", pages: 3 });
  await first;
  expect(h.view.pageLoading).toBe(false);
  expect(h.view.page).toBe(2);
});

test("Files closes immediately during PDF rendering and a late result cannot republish an image", async () => {
  let finish: Function;
  const removed: string[] = [];
  const h = contextHarness({
    appHome: () => "/app", exists: async () => true,
    readdir: async () => ["source.pdf", "reserved.png"],
    unlink: async (path: string) => { removed.push(path); },
    rmdir: async (path: string) => { removed.push(path); },
    renderPdf: () => new Promise(resolve => { finish = resolve; }),
  });
  Object.assign(h.view, { pdfFile: "/app/data/files/preview/source.pdf", temp: "data/files/preview", pdf: true, page: 1, pages: 2 });
  let task: Promise<void>;
  h.view.turnPage(1, { ...contextCx, spawn: (fn: Function) => { task = fn(contextCx); } });
  await h.view.close();
  expect(removed).toEqual(["/app/data/files/preview/source.pdf", "/app/data/files/preview/reserved.png", "/app/data/files/preview"]);
  finish!({ path: "data/files/preview/reserved.png", pages: 2 });
  await task!;
  expect(h.view.asset).toBeUndefined();
  expect(h.view.page).toBe(1);
});

test("Files can retry a PDF page after a render error", async () => {
  let calls = 0;
  const h = contextHarness({ renderPdf: async () => {
    if (++calls === 1) throw new Error("Cannot render this PDF");
    return { path: "data/files/page.png", pages: 2 };
  } });
  Object.assign(h.view, { pdfFile: "/staged/report.pdf", pdf: true });
  await h.view.readPdfPage(1);
  expect(h.view.fileError).toBe("Cannot render this PDF");
  expect(h.view.pageLoading).toBe(false);
  await h.view.readPdfPage(1);
  expect(h.view.fileError).toBeNull();
  expect(h.view.page).toBe(1);
});
