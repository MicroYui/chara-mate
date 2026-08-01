import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface ProjectPackage {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  packageManager: string;
  scripts: Record<string, string>;
  type: string;
}

const projectRoot = process.cwd();

async function readProjectPackage(): Promise<ProjectPackage> {
  return JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as ProjectPackage;
}

describe("single-package quality contract", () => {
  it("pins npm and every direct dependency exactly", async () => {
    const projectPackage = await readProjectPackage();
    const dependencies = {
      ...projectPackage.dependencies,
      ...projectPackage.devDependencies,
    };

    expect(projectPackage.packageManager).toBe("npm@11.16.0");
    expect(projectPackage.type).toBe("module");
    expect(Object.entries(dependencies)).not.toHaveLength(0);
    for (const [name, version] of Object.entries(dependencies)) {
      expect(version, `${name} must use an exact registry version`).toMatch(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
      );
    }
  });

  it("keeps canonical offline, package, E2E, live and benchmark commands documented", async () => {
    const projectPackage = await readProjectPackage();
    const agents = await readFile(path.join(projectRoot, "AGENTS.md"), "utf8");
    const canonicalScripts = [
      "check:fast",
      "test:focused",
      "test:integration",
      "verify:offline",
      "build",
      "package",
      "test:e2e",
      "verify:phase0",
      "test:live",
      "test:benchmark",
    ] as const;

    for (const script of canonicalScripts) {
      expect(projectPackage.scripts[script]).toBeTruthy();
      expect(agents).toContain(`npm run ${script}`);
    }
    expect(projectPackage.scripts["verify:offline"]).not.toMatch(
      /live|benchmark/u,
    );
    expect(projectPackage.scripts["verify:phase0"]).not.toMatch(
      /test:(?:live|benchmark)/u,
    );
    expect(projectPackage.scripts["verify:phase0"]).toMatch(
      /smoke:dev.*package.*smoke:package.*test:e2e/u,
    );
  });
});
