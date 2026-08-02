import type {
  Approval,
  ArtifactReference,
  Chat,
  EntityId,
  Message,
  ProviderSnapshot,
  Run,
  RunItem,
  Timestamp,
} from "../../../shared/contracts";
import mikaPetImage from "../../assets/mika-pet.svg";
import type {
  ChatsFixtureSnapshot,
  ComposerAttachment,
  FixtureChat,
  FixtureMessage,
  FixtureRun,
} from "./types";

const ids = {
  approval: "00000000-0000-4000-8000-000000000501",
  approvalChat: "00000000-0000-4000-8000-000000000103",
  approvalItem: "00000000-0000-4000-8000-000000000405",
  approvalRun: "00000000-0000-4000-8000-000000000303",
  designChat: "00000000-0000-4000-8000-000000000101",
  designRun: "00000000-0000-4000-8000-000000000301",
  fileArtifact: "00000000-0000-4000-8000-000000000601",
  folderArtifact: "00000000-0000-4000-8000-000000000602",
  imageArtifact: "00000000-0000-4000-8000-000000000603",
  persona: "00000000-0000-4000-8000-000000000701",
  provider: "00000000-0000-4000-8000-000000000201",
  travelChat: "00000000-0000-4000-8000-000000000102",
  travelRun: "00000000-0000-4000-8000-000000000302",
} as const satisfies Record<string, EntityId>;

const timestamps = {
  designCreated: "2026-08-01T07:52:00.000Z",
  designEnded: "2026-08-01T08:04:13.000Z",
  designUpdated: "2026-08-01T08:04:13.000Z",
  now: "2026-08-01T08:15:00.000Z",
  travelCreated: "2026-07-31T13:20:00.000Z",
} as const satisfies Record<string, Timestamp>;

const provider = {
  apiStyle: "openai-compatible",
  modelId: "gpt-5",
  profileId: ids.provider,
  profileName: "OpenAI",
} satisfies ProviderSnapshot;

function entityId(group: number, value: number): EntityId {
  return `00000000-0000-4${group.toString().padStart(3, "0")}-8000-${value.toString().padStart(12, "0")}`;
}

function message(
  value: Omit<Message, "id"> & { readonly idNumber: number },
  attachments: readonly ArtifactReference[] = [],
): FixtureMessage {
  const { idNumber, ...record } = value;
  return {
    attachments,
    record: {
      ...record,
      id: entityId(100, idNumber),
    },
  };
}

function runItem(
  runId: EntityId,
  sequence: number,
  value: Omit<RunItem, "id" | "runId" | "sequence">,
): RunItem {
  return {
    ...value,
    id: entityId(400, sequence + Number(runId.slice(-2)) * 10),
    runId,
    sequence,
  };
}

const fileArtifact = {
  artifactId: ids.fileArtifact,
  byteLength: 4_812,
  displayName: "phase-1-ui-notes.md",
  kind: "file",
  mediaType: "text/markdown",
  sha256: "a".repeat(64),
  storageKey: "fixtures/phase-1-ui-notes.md",
} satisfies ArtifactReference;

const folderArtifact = {
  artifactId: ids.folderArtifact,
  displayName: "src/renderer/features/chats",
  kind: "directory",
  storageKey: "fixtures/chats-folder",
} satisfies ArtifactReference;

const imageArtifact = {
  artifactId: ids.imageArtifact,
  byteLength: 184_220,
  displayName: "chats-layout-reference.png",
  kind: "image",
  mediaType: "image/png",
  sha256: "b".repeat(64),
  storageKey: "fixtures/chats-layout-reference.png",
} satisfies ArtifactReference;

const designMarkdown = `这一版先把信息层级收敛到一个安静的阅读面：

1. **侧栏只承担导航和最近会话**，不再叠加第二条工具栏。
2. **助手回答保持无气泡**，用户消息使用轻量背景。
3. **Run 完成后折叠成一行**，需要时再查看真实动作。

| 区域 | 默认行为 | 目标 |
| --- | --- | --- |
| Chats | 单栏阅读 | 降低视觉噪音 |
| Composer | 输入在上、控制在下 | 模式始终可见 |
| Run | 完成后折叠 | 结果优先 |

行内公式使用 $E = mc^2$，块公式可以保持独立滚动：

$$
L = \\sum_{i=1}^{n} w_i x_i
$$

\`\`\`ts
type ComposerMode = "chat" | "agent";
\`\`\`

\`\`\`mermaid
flowchart LR
  Draft --> Run
  Run --> Answer
\`\`\``;

const designMessages: readonly FixtureMessage[] = [
  message({
    chatId: ids.designChat,
    content: "参考 ChatGPT 和 Codex，把 Chats 页面重新整理得更干净。",
    createdAt: timestamps.designCreated,
    idNumber: 1,
    role: "user",
    runId: ids.designRun,
    status: "completed",
    updatedAt: timestamps.designCreated,
  }),
  message(
    {
      chatId: ids.designChat,
      content: designMarkdown,
      createdAt: timestamps.designEnded,
      idNumber: 2,
      role: "assistant",
      runId: ids.designRun,
      status: "completed",
      updatedAt: timestamps.designEnded,
    },
    [fileArtifact, imageArtifact],
  ),
];

const designItems: readonly RunItem[] = [
  runItem(ids.designRun, 1, {
    artifacts: [],
    durationMs: 0,
    endedAt: timestamps.designCreated,
    kind: "user_message",
    startedAt: timestamps.designCreated,
    status: "completed",
  }),
  runItem(ids.designRun, 2, {
    artifacts: [],
    displayOutput: "核对产品设计、UI 设计和 Phase 1 工作包。",
    durationMs: 8_200,
    endedAt: "2026-08-01T07:52:08.200Z",
    input: {
      steps: ["读取设计", "整理组件边界", "验证 fixture"],
    },
    kind: "plan",
    startedAt: timestamps.designCreated,
    status: "completed",
  }),
  runItem(ids.designRun, 3, {
    artifacts: [],
    displayOutput: "已读取 3 份设计文档。",
    durationMs: 24_410,
    endedAt: "2026-08-01T07:52:32.610Z",
    input: {
      files: [
        "REFACTOR_PRODUCT_DESIGN.md",
        "CHARA_MATE_UI_DESIGN.md",
        "docs/progress/ROADMAP.md",
      ],
      tool: "file.read",
    },
    kind: "tool_call",
    startedAt: "2026-08-01T07:52:08.200Z",
    status: "completed",
  }),
  runItem(ids.designRun, 4, {
    artifacts: [],
    displayOutput: "Tests 16 passed\nTypeScript 0 errors\nFormatting matched",
    durationMs: 12_340,
    endedAt: "2026-08-01T08:03:52.340Z",
    input: {
      command: "npm run test:focused",
      cwd: "chara-mate-phase1-chats-ui",
      exitCode: 0,
    },
    kind: "command",
    startedAt: "2026-08-01T08:03:40.000Z",
    status: "completed",
  }),
  runItem(ids.designRun, 5, {
    artifacts: [fileArtifact],
    displayOutput: "已整理 Chats fixture 与组件边界。",
    durationMs: 20_660,
    endedAt: timestamps.designEnded,
    input: {
      files: [
        "src/renderer/features/chats/fixtures.ts",
        "src/renderer/features/chats/types.ts",
      ],
    },
    kind: "file_change",
    startedAt: "2026-08-01T08:03:52.340Z",
    status: "completed",
  }),
  runItem(ids.designRun, 6, {
    artifacts: [],
    durationMs: 0,
    endedAt: timestamps.designEnded,
    kind: "assistant_message",
    startedAt: timestamps.designEnded,
    status: "completed",
  }),
];

const designRun = {
  approvals: [],
  items: designItems,
  record: {
    chatId: ids.designChat,
    createdAt: timestamps.designCreated,
    endedAt: timestamps.designEnded,
    execution: { approvalMode: "request_approval", mode: "agent" },
    id: ids.designRun,
    latestSequence: designItems.length,
    provider,
    startedAt: timestamps.designCreated,
    status: "completed",
  } satisfies Run,
} satisfies FixtureRun;

const designChat = {
  messages: designMessages,
  record: {
    createdAt: timestamps.designCreated,
    id: ids.designChat,
    pinnedAt: timestamps.designCreated,
    status: "active",
    title: "Phase 1 UI",
    updatedAt: timestamps.designUpdated,
  } satisfies Chat,
  runs: [designRun],
} satisfies FixtureChat;

const travelRunRecord = {
  chatId: ids.travelChat,
  createdAt: timestamps.travelCreated,
  endedAt: "2026-07-31T13:20:08.000Z",
  execution: { mode: "chat" },
  id: ids.travelRun,
  latestSequence: 2,
  provider,
  startedAt: timestamps.travelCreated,
  status: "completed",
} satisfies Run;

const travelChat = {
  messages: [
    message({
      chatId: ids.travelChat,
      content: "周末去杭州，两天时间怎样安排会比较松弛？",
      createdAt: timestamps.travelCreated,
      idNumber: 3,
      role: "user",
      runId: ids.travelRun,
      status: "completed",
      updatedAt: timestamps.travelCreated,
    }),
    message({
      chatId: ids.travelChat,
      content:
        "可以把一天留给西湖周边，另一天只选一个近郊目的地。不要把灵隐、龙井和西溪都塞进同一天。",
      createdAt: "2026-07-31T13:20:08.000Z",
      idNumber: 4,
      role: "assistant",
      runId: ids.travelRun,
      status: "completed",
      updatedAt: "2026-07-31T13:20:08.000Z",
    }),
  ],
  record: {
    createdAt: timestamps.travelCreated,
    id: ids.travelChat,
    status: "active",
    title: "周末旅行计划",
    updatedAt: "2026-07-31T13:20:08.000Z",
  } satisfies Chat,
  runs: [
    {
      approvals: [],
      items: [
        runItem(ids.travelRun, 1, {
          artifacts: [],
          durationMs: 0,
          endedAt: timestamps.travelCreated,
          kind: "user_message",
          startedAt: timestamps.travelCreated,
          status: "completed",
        }),
        runItem(ids.travelRun, 2, {
          artifacts: [],
          durationMs: 8_000,
          endedAt: "2026-07-31T13:20:08.000Z",
          kind: "assistant_message",
          startedAt: timestamps.travelCreated,
          status: "completed",
        }),
      ],
      record: travelRunRecord,
    },
  ],
} satisfies FixtureChat;

const pendingApproval = {
  expiresAt: "2026-08-01T09:00:00.000Z",
  id: ids.approval,
  itemId: ids.approvalItem,
  parameterSummary: "修改 8 个 Renderer 文件，并运行 npm run test:focused",
  requestedAt: "2026-08-01T08:12:30.000Z",
  runId: ids.approvalRun,
  status: "pending",
  toolName: "file.apply_patch",
} satisfies Approval;

const approvalRun = {
  approvals: [pendingApproval],
  items: [
    runItem(ids.approvalRun, 1, {
      artifacts: [],
      durationMs: 0,
      endedAt: "2026-08-01T08:12:00.000Z",
      kind: "user_message",
      startedAt: "2026-08-01T08:12:00.000Z",
      status: "completed",
    }),
    runItem(ids.approvalRun, 2, {
      artifacts: [],
      displayOutput: "已读取相关组件和样式。",
      durationMs: 30_000,
      endedAt: "2026-08-01T08:12:30.000Z",
      input: { files: ["src/renderer/app/App.tsx", "App.module.css"] },
      kind: "tool_call",
      startedAt: "2026-08-01T08:12:00.000Z",
      status: "completed",
    }),
    {
      artifacts: [],
      id: ids.approvalItem,
      input: {
        action: "修改 Renderer fixture 文件并运行 focused tests",
      },
      kind: "approval",
      runId: ids.approvalRun,
      sequence: 3,
      startedAt: "2026-08-01T08:12:30.000Z",
      status: "waiting_approval",
    },
  ],
  record: {
    chatId: ids.approvalChat,
    createdAt: "2026-08-01T08:12:00.000Z",
    execution: { approvalMode: "request_approval", mode: "agent" },
    id: ids.approvalRun,
    latestSequence: 3,
    provider,
    startedAt: "2026-08-01T08:12:00.000Z",
    status: "waiting_approval",
  } satisfies Run,
} satisfies FixtureRun;

const approvalChat = {
  messages: [
    message({
      chatId: ids.approvalChat,
      content: "把确认后的界面实现到项目里，并运行测试。",
      createdAt: "2026-08-01T08:12:00.000Z",
      idNumber: 5,
      role: "user",
      runId: ids.approvalRun,
      status: "completed",
      updatedAt: "2026-08-01T08:12:00.000Z",
    }),
  ],
  record: {
    createdAt: "2026-08-01T08:12:00.000Z",
    id: ids.approvalChat,
    status: "active",
    title: "实现 Chats UI",
    updatedAt: timestamps.now,
  } satisfies Chat,
  runs: [approvalRun],
} satisfies FixtureChat;

export const chatsFixture = {
  chats: [designChat, approvalChat, travelChat],
  models: [
    {
      displayName: "GPT-5",
      id: "gpt-5",
      provider,
    },
    {
      displayName: "GPT-5 mini",
      id: "gpt-5-mini",
      provider: { ...provider, modelId: "gpt-5-mini" },
    },
  ],
  persona: {
    accent: "violet",
    displayName: "Mika",
    id: ids.persona,
    imageSource: mikaPetImage,
    initials: "M",
    styleName: "元气开朗",
  },
} as const satisfies ChatsFixtureSnapshot;

export const composerAttachmentFixtures = {
  file: {
    byteLength: fileArtifact.byteLength,
    displayName: fileArtifact.displayName,
    id: fileArtifact.artifactId,
    mediaType: fileArtifact.mediaType,
    source: "file",
  },
  folder: {
    displayName: folderArtifact.displayName,
    id: folderArtifact.artifactId,
    source: "folder",
  },
  image: {
    byteLength: imageArtifact.byteLength,
    displayName: imageArtifact.displayName,
    id: imageArtifact.artifactId,
    mediaType: imageArtifact.mediaType,
    source: "image",
  },
} as const satisfies Record<string, ComposerAttachment>;

export const chatsFixtureIds = ids;
