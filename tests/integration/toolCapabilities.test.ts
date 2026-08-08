import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JsonValue } from "../../src/shared/contracts/primitives";
import { CryptoIdGenerator } from "../../src/shared/pure/id";
import { ArtifactStore } from "../../src/main/tools/artifactStore";
import { registerLocalTools } from "../../src/main/tools/localTools";
import { runProcess } from "../../src/main/tools/processRunner";
import {
  ToolRegistry,
  type ToolExecutionContext,
} from "../../src/main/tools/toolRegistry";
import {
  registerComputerTools,
  type ComputerAdapter,
  type ScreenCapture,
} from "../../src/main/computer/macosComputer";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const ITEM_ID = "10000000-0000-4000-8000-000000000002";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

function executionContext(
  signal = new AbortController().signal,
  onDelta: (delta: string) => void = () => undefined,
): ToolExecutionContext {
  return { itemId: ITEM_ID, onDelta, runId: RUN_ID, signal };
}

async function execute(
  registry: ToolRegistry,
  name: string,
  input: Readonly<Record<string, JsonValue>>,
  context = executionContext(),
) {
  return registry.execute(name, input, context);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Phase 2 local capabilities", () => {
  it("runs File, Command and App operations through one structured Tool boundary", async () => {
    const root = await temporaryDirectory("chara-mate-local-tools-");
    const artifactRoot = path.join(root, "artifacts");
    const registry = new ToolRegistry();
    const trashed: string[] = [];
    const openedPaths: string[] = [];
    const openedUrls: string[] = [];
    registerLocalTools(registry, {
      artifacts: new ArtifactStore(artifactRoot, new CryptoIdGenerator()),
      openPath: (target) => {
        openedPaths.push(target);
        return Promise.resolve("");
      },
      openUrl: (url) => {
        openedUrls.push(url);
        return Promise.resolve();
      },
      resolvePath: (target) => path.resolve(root, target),
      trashItem: (target) => {
        trashed.push(target);
        return Promise.resolve();
      },
    });

    const written = await execute(registry, "file.write", {
      content: "first\nneedle\n",
      path: "notes/example.txt",
    });
    expect(written.status).toBe("success");
    expect(written.summary).toContain("example.txt");
    expect(await readFile(path.join(root, "notes/example.txt"), "utf8")).toBe(
      "first\nneedle\n",
    );

    const listed = await execute(registry, "file.list", { path: "notes" });
    expect(JSON.stringify(listed.modelContent)).toContain("example.txt");
    const searched = await execute(registry, "file.search", {
      path: ".",
      query: "needle",
    });
    expect(JSON.stringify(searched.modelContent)).toContain(
      "notes/example.txt:2:needle",
    );
    await mkdir(path.join(root, "node_modules"));
    await writeFile(
      path.join(root, "node_modules", "ignored.txt"),
      "needle",
      "utf8",
    );
    const boundedSearch = await execute(registry, "file.search", {
      path: ".",
      query: "needle",
    });
    expect(JSON.stringify(boundedSearch.modelContent)).not.toContain(
      "node_modules/ignored.txt",
    );
    await expect(
      execute(registry, "file.patch", {
        path: "notes/example.txt",
        replacement: "updated",
        search: "needle",
      }),
    ).resolves.toMatchObject({ status: "success" });
    expect(await readFile(path.join(root, "notes/example.txt"), "utf8")).toBe(
      "first\nupdated\n",
    );

    const largeContent = "line\n".repeat(8_000);
    await writeFile(path.join(root, "large.txt"), largeContent, "utf8");
    const read = await execute(registry, "file.read", { path: "large.txt" });
    expect(read.artifacts).toHaveLength(1);
    expect(JSON.stringify(read.modelContent)).toContain("完整输出已保存");
    const artifactPath = path.join(artifactRoot, read.artifacts[0]!.storageKey);
    expect(await readFile(artifactPath, "utf8")).toBe(largeContent);

    const deltas: string[] = [];
    const command = await execute(
      registry,
      "command.run",
      { command: "printf 'command-result'" },
      executionContext(new AbortController().signal, (delta) =>
        deltas.push(delta),
      ),
    );
    expect(command).toMatchObject({
      modelContent: { exitCode: 0, output: "command-result" },
      status: "success",
    });
    expect(deltas.join("")).toContain("command-result");

    await execute(registry, "app.open_url", {
      url: "https://example.test/path",
    });
    await execute(registry, "app.open_path", { path: "notes/example.txt" });
    await execute(registry, "file.trash", { path: "notes/example.txt" });
    expect(openedUrls).toEqual(["https://example.test/path"]);
    expect(openedPaths).toEqual([path.join(root, "notes/example.txt")]);
    expect(trashed).toEqual([path.join(root, "notes/example.txt")]);
  });

  it("terminates an owned process group through AbortSignal", async () => {
    const root = await temporaryDirectory("chara-mate-process-cancel-");
    const marker = path.join(root, "completed.txt");
    const abort = new AbortController();
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = runProcess(
      {
        args: [
          "-e",
          [
            "process.stdout.write('started\\n')",
            "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 60_000)",
          ].join(";"),
          marker,
        ],
        command: process.execPath,
      },
      abort.signal,
      (delta) => {
        if (delta.includes("started")) started();
      },
    );
    await childStarted;
    abort.abort(new DOMException("test cancellation", "AbortError"));
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class FakeComputer implements ComputerAdapter {
  readonly calls: string[] = [];

  clickCoordinates(x: number, y: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`click:${String(x)},${String(y)}`);
    return Promise.resolve();
  }

  focusApplication(name: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`focus:${name}`);
    return Promise.resolve();
  }

  pressElement(
    name: string,
    role: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`element:${role ?? ""}:${name}`);
    return Promise.resolve();
  }

  pressKey(keyCode: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`key:${String(keyCode)}`);
    return Promise.resolve();
  }

  snapshot(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    this.calls.push("snapshot");
    return Promise.resolve("AXWindow | Notes\nAXButton | Save");
  }

  typeText(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.calls.push(`type:${text}`);
    return Promise.resolve();
  }
}

class FakeCapture implements ScreenCapture {
  capturePrimaryDisplay(): Promise<Buffer> {
    return Promise.resolve(Buffer.from("fake-png"));
  }
}

describe("Phase 2 Computer capabilities", () => {
  it("exposes semantic Accessibility actions before the coordinate fallback", async () => {
    const root = await temporaryDirectory("chara-mate-computer-tools-");
    const registry = new ToolRegistry();
    const computer = new FakeComputer();
    registerComputerTools(
      registry,
      computer,
      new FakeCapture(),
      new ArtifactStore(path.join(root, "artifacts"), new CryptoIdGenerator()),
    );

    expect(
      registry
        .search("accessibility semantic button", 8)
        .map(({ descriptor }) => descriptor.name),
    ).toContain("computer.press_element");
    await execute(registry, "computer.focus_app", { name: "Notes" });
    const snapshot = await execute(registry, "computer.snapshot", {});
    await execute(registry, "computer.press_element", {
      name: "Save",
      role: "AXButton",
    });
    await execute(registry, "computer.type_text", { text: "hello" });
    await execute(registry, "computer.press_key", { keyCode: 36 });
    const screenshot = await execute(registry, "computer.screenshot", {});
    await execute(registry, "computer.click_coordinates", { x: 40, y: 80 });

    expect(JSON.stringify(snapshot.modelContent)).toContain("AXButton");
    expect(screenshot.artifacts).toHaveLength(1);
    expect(computer.calls).toEqual([
      "focus:Notes",
      "snapshot",
      "element:AXButton:Save",
      "type:hello",
      "key:36",
      "click:40,80",
    ]);
  });

  it("does not enter a Computer adapter after cancellation", async () => {
    const root = await temporaryDirectory("chara-mate-computer-abort-");
    const registry = new ToolRegistry();
    const computer = new FakeComputer();
    registerComputerTools(
      registry,
      computer,
      new FakeCapture(),
      new ArtifactStore(path.join(root, "artifacts"), new CryptoIdGenerator()),
    );
    const abort = new AbortController();
    abort.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      execute(
        registry,
        "computer.press_element",
        { name: "Save" },
        executionContext(abort.signal),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(computer.calls).toEqual([]);
  });
});
