import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type {
  SkillContent,
  SkillDescriptor,
  SkillSource,
  SkillVersionSnapshot,
} from "../../shared/contracts/extensions";
import type { JsonValue } from "../../shared/contracts/primitives";
import type { ToolResult } from "../../shared/contracts/tool";
import type { Clock } from "../../shared/pure/clock";
import type { IdGenerator } from "../../shared/pure/id";
import type { ToolRegistry } from "../tools/toolRegistry";
import { toolEvidenceHash } from "../tools/toolRegistry";
import { ExtensionError } from "./extensionError";
import type { SkillRepository, SkillVersionRecord } from "./skillRepository";

const SKILL_DIRECTORY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export interface SkillFrontmatter {
  readonly description: string;
  readonly name: string;
}

interface LoadedSkill {
  readonly contentPath: string;
  readonly descriptor: SkillDescriptor;
  readonly directoryPath: string;
}

type EvolutionSkillSaveInput = {
  readonly candidateId: string;
  readonly content: string;
  readonly name: string;
} & (
  | {
      readonly targetContentSha256: string;
      readonly targetRevision: number;
      readonly targetSkillId: string;
    }
  | {
      readonly targetContentSha256?: undefined;
      readonly targetRevision?: undefined;
      readonly targetSkillId?: undefined;
    }
);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseSkill(content: string): SkillFrontmatter {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ExtensionError(
      "SKILL.INVALID",
      "SKILL.md 必须以 YAML frontmatter 开头。",
      false,
    );
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new ExtensionError(
      "SKILL.INVALID",
      "SKILL.md 缺少 frontmatter 结束标记。",
      false,
    );
  }
  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = objectValue(parseYaml(normalized.slice(4, end)));
  } catch {
    throw new ExtensionError(
      "SKILL.INVALID",
      "SKILL.md frontmatter 不是有效 YAML。",
      false,
    );
  }
  const name = metadata?.["name"];
  const description = metadata?.["description"];
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    throw new ExtensionError(
      "SKILL.INVALID",
      "SKILL.md frontmatter 必须包含非空 name 和 description。",
      false,
    );
  }
  return { description: description.trim(), name: name.trim() };
}

function skillId(source: SkillSource, directoryName: string): string {
  return `${source}:${directoryName}`;
}

function descriptor(
  id: string,
  source: SkillSource,
  readOnly: boolean,
  metadata: SkillFrontmatter,
  version: SkillVersionRecord,
): SkillDescriptor {
  return {
    archived: version.archivedAt !== undefined,
    contentSha256: version.contentSha256,
    description: metadata.description,
    enabled: version.enabled,
    id,
    ...(version.lastSuccessAt ? { lastSuccessAt: version.lastSuccessAt } : {}),
    ...(version.lastUsedAt ? { lastUsedAt: version.lastUsedAt } : {}),
    lifecycle: version.lifecycle,
    name: metadata.name,
    patchCount: version.patchCount,
    pinned: version.pinned,
    readOnly,
    revision: version.revision,
    source,
    successCount: version.successCount,
    useCount: version.useCount,
  };
}

function success(summary: string, modelContent: JsonValue): ToolResult {
  return {
    artifacts: [],
    evidenceHash: toolEvidenceHash(modelContent),
    modelContent,
    retryable: false,
    status: "success",
    summary,
  };
}

export class SkillService {
  readonly #mutationTails = new Map<string, Promise<void>>();
  readonly #skills = new Map<string, LoadedSkill>();

  constructor(
    private workspaceSkillsDirectory: string,
    private readonly userSkillsDirectory: string,
    private readonly repository: SkillRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.userSkillsDirectory, { recursive: true });
    await this.refresh();
  }

  async setWorkspaceDirectory(workspaceDirectory: string): Promise<void> {
    this.workspaceSkillsDirectory = path.join(
      workspaceDirectory,
      ".agents",
      "skills",
    );
    await this.refresh();
  }

  instructions(): string {
    const enabled = this.list().filter(
      (skill) => skill.enabled && !skill.archived,
    );
    if (enabled.length === 0) return "";
    return [
      "Available Agent Skills (metadata only). Load a Skill with skills.load only when its description matches the user's task; then follow the returned SKILL.md and resolve relative resources from its directoryPath:",
      ...enabled.map(
        (skill) => `- ${skill.id} — ${skill.name}: ${skill.description}`,
      ),
    ].join("\n");
  }

  list(): SkillDescriptor[] {
    return [...this.#skills.values()]
      .map(({ descriptor: value }) => value)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      );
  }

  async get(id: string): Promise<SkillContent> {
    const skill = this.#require(id);
    return {
      content: await readFile(skill.contentPath, "utf8"),
      skill: skill.descriptor,
    };
  }

  history(id: string): SkillVersionSnapshot[] {
    this.#require(id);
    return this.repository.listVersions(id).map((version) => ({
      ...(version.content === undefined ? {} : { content: version.content }),
      contentSha256: version.contentSha256,
      createdAt: version.createdAt,
      lifecycle: version.lifecycle,
      revision: version.revision,
      ...(version.sourceCandidateId
        ? { sourceCandidateId: version.sourceCandidateId }
        : {}),
    }));
  }

  async refresh(): Promise<SkillDescriptor[]> {
    const discovered = [
      ...(await this.#scanDirectory(
        this.workspaceSkillsDirectory,
        "workspace",
        true,
      )),
      ...(await this.#scanDirectory(this.userSkillsDirectory, "user", false)),
      ...(await this.#scanArchivedDirectory()),
    ];
    this.#skills.clear();
    for (const skill of discovered)
      this.#skills.set(skill.descriptor.id, skill);
    return this.list();
  }

  async save(
    directoryName: string,
    content: string,
    sourceCandidateId?: string,
  ): Promise<SkillDescriptor> {
    return this.#withSkillMutation(directoryName, () =>
      this.#save(directoryName, content, sourceCandidateId),
    );
  }

  async #save(
    directoryName: string,
    content: string,
    sourceCandidateId?: string,
  ): Promise<SkillDescriptor> {
    this.#assertDirectoryName(directoryName);
    const metadata = parseSkill(content);
    if (metadata.name !== directoryName) {
      throw new ExtensionError(
        "SKILL.NAME_MISMATCH",
        "目录名必须与 SKILL.md frontmatter 的 name 一致。",
        false,
      );
    }
    const directoryPath = path.join(this.userSkillsDirectory, directoryName);
    const contentPath = path.join(directoryPath, "SKILL.md");
    const temporaryPath = path.join(
      directoryPath,
      `.SKILL.${this.ids.generate()}.tmp`,
    );
    await mkdir(directoryPath, { recursive: true });
    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, contentPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new ExtensionError(
        "SKILL.SAVE_FAILED",
        error instanceof Error ? error.message : "无法保存 Skill。",
        true,
      );
    }
    const id = skillId("user", directoryName);
    const version = this.repository.recordContent(
      id,
      "user",
      sha256(content),
      content,
      this.clock.now(),
      sourceCandidateId,
    );
    const loaded: LoadedSkill = {
      contentPath,
      descriptor: descriptor(id, "user", false, metadata, version),
      directoryPath,
    };
    this.#skills.set(id, loaded);
    return loaded.descriptor;
  }

  setEnabled(id: string, enabled: boolean): SkillDescriptor {
    const skill = this.#require(id);
    const version = this.repository.setEnabled(id, enabled);
    const next = {
      ...skill,
      descriptor: { ...skill.descriptor, enabled: version.enabled },
    };
    this.#skills.set(id, next);
    return next.descriptor;
  }

  setPinned(id: string, pinned: boolean): SkillDescriptor {
    const skill = this.#require(id);
    if (skill.descriptor.readOnly) {
      throw new ExtensionError(
        "SKILL.READ_ONLY",
        "Workspace Skill 由项目拥有，不能设置用户 pin。",
        false,
      );
    }
    const version = this.repository.setPinned(id, pinned);
    const next = {
      ...skill,
      descriptor: { ...skill.descriptor, pinned: version.pinned },
    };
    this.#skills.set(id, next);
    return next.descriptor;
  }

  async archive(id: string): Promise<SkillDescriptor> {
    const name = this.#require(id).descriptor.name;
    return this.#withSkillMutation(name, () => this.#archive(id));
  }

  async #archive(id: string): Promise<SkillDescriptor> {
    const skill = this.#require(id);
    if (skill.descriptor.readOnly) {
      throw new ExtensionError(
        "SKILL.READ_ONLY",
        "Workspace Skill 是只读的；可以停用，但不能在这里归档。",
        false,
      );
    }
    const archivedAt = this.clock.now();
    const archiveDirectory = path.join(this.userSkillsDirectory, ".archive");
    const destination = path.join(
      archiveDirectory,
      `${path.basename(skill.directoryPath)}-${this.ids.generate()}`,
    );
    await mkdir(archiveDirectory, { recursive: true });
    await rename(skill.directoryPath, destination);
    const version = this.repository.setArchived(id, archivedAt);
    const next: LoadedSkill = {
      contentPath: path.join(destination, "SKILL.md"),
      descriptor: descriptor(
        skill.descriptor.id,
        skill.descriptor.source,
        skill.descriptor.readOnly,
        {
          description: skill.descriptor.description,
          name: skill.descriptor.name,
        },
        version,
      ),
      directoryPath: destination,
    };
    this.#skills.set(id, next);
    return next.descriptor;
  }

  async restoreRevision(
    id: string,
    revision: number,
  ): Promise<SkillDescriptor> {
    const name = this.#require(id).descriptor.name;
    return this.#withSkillMutation(name, () =>
      this.#restoreRevision(id, revision),
    );
  }

  async #restoreRevision(
    id: string,
    revision: number,
  ): Promise<SkillDescriptor> {
    const skill = this.#require(id);
    if (skill.descriptor.readOnly) {
      throw new ExtensionError(
        "SKILL.READ_ONLY",
        "Workspace Skill 是只读的，不能恢复用户版本。",
        false,
      );
    }
    const version = this.repository.getVersion(id, revision);
    if (!version?.content) {
      throw new ExtensionError(
        "SKILL.VERSION_UNAVAILABLE",
        "这个历史版本没有可恢复的内容快照。",
        false,
      );
    }
    const metadata = parseSkill(version.content);
    if (skill.descriptor.archived) {
      const destination = path.join(this.userSkillsDirectory, metadata.name);
      try {
        await rename(skill.directoryPath, destination);
      } catch (error) {
        throw new ExtensionError(
          "SKILL.RESTORE_FAILED",
          error instanceof Error ? error.message : "无法恢复 Skill。",
          true,
        );
      }
      this.#skills.set(id, {
        ...skill,
        contentPath: path.join(destination, "SKILL.md"),
        directoryPath: destination,
      });
    }
    return this.#save(metadata.name, version.content);
  }

  async saveFromEvolution(
    input: EvolutionSkillSaveInput,
  ): Promise<SkillDescriptor> {
    return this.#withSkillMutation(input.name, () =>
      this.#saveFromEvolution(input),
    );
  }

  async #saveFromEvolution(
    input: EvolutionSkillSaveInput,
  ): Promise<SkillDescriptor> {
    this.#assertDirectoryName(input.name);
    const metadata = parseSkill(input.content);
    if (metadata.name !== input.name) {
      throw new ExtensionError(
        "SKILL.NAME_MISMATCH",
        "目录名必须与 SKILL.md frontmatter 的 name 一致。",
        false,
      );
    }
    const contentSha256 = sha256(input.content);
    if (input.targetSkillId) {
      const target = this.#require(input.targetSkillId);
      if (
        target.descriptor.source !== "user" ||
        target.descriptor.readOnly ||
        target.descriptor.archived ||
        target.descriptor.pinned
      ) {
        throw new ExtensionError(
          "SKILL.PROTECTED",
          "只读、归档或 pinned Skill 不能由成长候选修改。",
          false,
        );
      }
      if (target.descriptor.name !== input.name) {
        throw new ExtensionError(
          "SKILL.NAME_MISMATCH",
          "Skill patch 的名称必须与目标 Skill 一致。",
          false,
        );
      }
      if (target.descriptor.contentSha256 === contentSha256) {
        const version = this.repository.claimEvolutionSource(
          target.descriptor.id,
          input.candidateId,
          true,
        );
        const claimed = {
          ...target,
          descriptor: descriptor(
            target.descriptor.id,
            target.descriptor.source,
            target.descriptor.readOnly,
            metadata,
            version,
          ),
        };
        this.#skills.set(target.descriptor.id, claimed);
        return claimed.descriptor;
      }
      if (
        target.descriptor.revision !== input.targetRevision ||
        target.descriptor.contentSha256 !== input.targetContentSha256
      ) {
        throw new ExtensionError(
          "SKILL.STALE_PATCH",
          "目标 Skill 已有更新；请基于当前版本重新生成或编辑候选。",
          false,
        );
      }
    } else {
      const existing = this.list().find(
        ({ archived, name }) => name === input.name && !archived,
      );
      if (existing?.contentSha256 === contentSha256) {
        if (existing.source !== "user" || existing.readOnly) {
          throw new ExtensionError(
            "SKILL.PROTECTED",
            "Workspace Skill 不能被成长候选认领或覆盖。",
            false,
          );
        }
        const loaded = this.#require(existing.id);
        const version = this.repository.claimEvolutionSource(
          existing.id,
          input.candidateId,
          false,
        );
        const claimed = {
          ...loaded,
          descriptor: descriptor(
            existing.id,
            existing.source,
            existing.readOnly,
            metadata,
            version,
          ),
        };
        this.#skills.set(existing.id, claimed);
        return claimed.descriptor;
      }
      if (existing) {
        throw new ExtensionError(
          "SKILL.DUPLICATE",
          "已有同名 Skill；请改为 patch，而不是创建重复 Skill。",
          false,
        );
      }
    }
    return this.#save(input.name, input.content, input.candidateId);
  }

  recordRunSuccess(skillIds: readonly string[]): void {
    const succeededAt = this.clock.now();
    for (const id of new Set(skillIds)) {
      const skill = this.#skills.get(id);
      if (!skill || skill.descriptor.archived) continue;
      const version = this.repository.recordSuccess(id, succeededAt);
      this.#skills.set(id, {
        ...skill,
        descriptor: {
          ...skill.descriptor,
          ...(version.lastSuccessAt
            ? { lastSuccessAt: version.lastSuccessAt }
            : {}),
          successCount: version.successCount,
        },
      });
    }
  }

  registerTools(
    registry: ToolRegistry,
    onSkillChanged: (skillId: string) => void = () => undefined,
  ): void {
    registry.register({
      descriptor: {
        description:
          "Load the complete SKILL.md only after an available Skill's metadata matches the current task.",
        effect: "read",
        idempotency: "idempotent",
        inputSchema: {
          additionalProperties: false,
          properties: { skillId: { type: "string" } },
          required: ["skillId"],
          type: "object",
        },
        itemKind: "tool_call",
        name: "skills.load",
        namespace: "skills",
        summary: "加载 Skill",
        source: "builtin",
      },
      execute: async (input) => {
        const id = input["skillId"];
        if (typeof id !== "string") throw new TypeError("skillId is required");
        const skill = this.#require(id);
        if (!skill.descriptor.enabled || skill.descriptor.archived) {
          throw new ExtensionError(
            "SKILL.UNAVAILABLE",
            "该 Skill 当前未启用。",
            false,
          );
        }
        const content = await readFile(skill.contentPath, "utf8");
        const version = this.repository.setLastUsed(id, this.clock.now());
        this.#skills.set(id, {
          ...skill,
          descriptor: {
            ...skill.descriptor,
            ...(version.lastUsedAt ? { lastUsedAt: version.lastUsedAt } : {}),
            useCount: version.useCount,
          },
        });
        return success(`已加载 ${skill.descriptor.name}`, {
          content,
          directoryPath: skill.directoryPath,
          skillId: id,
        });
      },
      summarize: (input) =>
        `加载 Skill ${typeof input["skillId"] === "string" ? input["skillId"] : ""}`,
    });

    registry.register({
      descriptor: {
        description:
          "Create or update a user Skill only when the user explicitly asks CharaMate to learn or save a reusable workflow. Content must be a complete standard SKILL.md.",
        effect: "write",
        idempotency: "idempotent",
        inputSchema: {
          additionalProperties: false,
          properties: {
            content: { type: "string" },
            name: {
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              type: "string",
            },
          },
          required: ["name", "content"],
          type: "object",
        },
        itemKind: "file_change",
        name: "skills.save",
        namespace: "skills",
        summary: "保存 Skill",
        source: "builtin",
      },
      execute: async (input) => {
        const name = input["name"];
        const content = input["content"];
        if (typeof name !== "string" || typeof content !== "string") {
          throw new TypeError("name and content are required");
        }
        const saved = await this.save(name, content);
        onSkillChanged(saved.id);
        return success(`已保存 Skill ${saved.name}`, {
          revision: saved.revision,
          skillId: saved.id,
        });
      },
      summarize: (input) =>
        `保存 Skill ${typeof input["name"] === "string" ? input["name"] : ""}`,
    });
  }

  async #scanDirectory(
    root: string,
    source: SkillSource,
    readOnly: boolean,
  ): Promise<LoadedSkill[]> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const loaded: LoadedSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const contentPath = path.join(root, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(contentPath, "utf8");
      } catch {
        continue;
      }
      let metadata: SkillFrontmatter;
      try {
        metadata = parseSkill(content);
      } catch {
        continue;
      }
      const id = skillId(source, entry.name);
      const version = this.repository.recordContent(
        id,
        source,
        sha256(content),
        content,
        this.clock.now(),
      );
      const directoryPath = path.join(root, entry.name);
      loaded.push({
        contentPath,
        descriptor: descriptor(id, source, readOnly, metadata, version),
        directoryPath,
      });
    }
    return loaded;
  }

  async #scanArchivedDirectory(): Promise<LoadedSkill[]> {
    const root = path.join(this.userSkillsDirectory, ".archive");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const loaded: LoadedSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directoryPath = path.join(root, entry.name);
      const contentPath = path.join(directoryPath, "SKILL.md");
      let content: string;
      let metadata: SkillFrontmatter;
      try {
        content = await readFile(contentPath, "utf8");
        metadata = parseSkill(content);
      } catch {
        continue;
      }
      const id = skillId("user", metadata.name);
      let version = this.repository.getLatest(id);
      if (!version?.archivedAt || version.contentSha256 !== sha256(content)) {
        continue;
      }
      version = this.repository.ensureContentSnapshot(
        id,
        version.revision,
        version.contentSha256,
        content,
      );
      loaded.push({
        contentPath,
        descriptor: descriptor(id, "user", false, metadata, version),
        directoryPath,
      });
    }
    return loaded;
  }

  #assertDirectoryName(name: string): void {
    if (!SKILL_DIRECTORY_PATTERN.test(name)) {
      throw new ExtensionError(
        "SKILL.INVALID_NAME",
        "Skill 名称只能包含小写字母、数字和连字符，且最长 64 个字符。",
        false,
      );
    }
  }

  async #withSkillMutation<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#mutationTails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#mutationTails.set(name, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(name) === tail) {
        this.#mutationTails.delete(name);
      }
    }
  }

  #require(id: string): LoadedSkill {
    const skill = this.#skills.get(id);
    if (!skill) {
      throw new ExtensionError("SKILL.NOT_FOUND", "Skill 不存在。", false);
    }
    return skill;
  }
}
