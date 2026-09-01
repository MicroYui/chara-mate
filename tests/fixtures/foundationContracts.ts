import type {
  Approval,
  Attachment,
  ArtifactReference,
  Chat,
  ChatDataSnapshot,
  Message,
  PersonaSnapshot,
  ProviderSnapshot,
  Run,
  RunEventEnvelope,
  RunItem,
} from "../../src/shared/contracts";

export const FIXTURE_IDS = {
  approval: "55555555-5555-4555-8555-555555555555",
  artifact: "66666666-6666-4666-8666-666666666666",
  attachment: "99999999-9999-4999-8999-999999999999",
  chat: "11111111-1111-4111-8111-111111111111",
  item: "44444444-4444-4444-8444-444444444444",
  message: "33333333-3333-4333-8333-333333333333",
  persona: "00000000-0000-4000-8000-000000000701",
  provider: "77777777-7777-4777-8777-777777777777",
  request: "88888888-8888-4888-8888-888888888888",
  run: "22222222-2222-4222-8222-222222222222",
} as const;

export const FIXTURE_TIMESTAMPS = {
  created: "2026-08-01T08:00:00.000Z",
  expires: "2026-08-01T08:30:00.000Z",
  updated: "2026-08-01T08:01:00.000Z",
} as const;

export const providerSnapshotFixture = {
  apiStyle: "openai-compatible",
  modelId: "gpt-example",
  profileId: FIXTURE_IDS.provider,
  profileName: "Local provider",
} satisfies ProviderSnapshot;

export const personaSnapshotFixture = {
  addressStyle: "通常直接说“你”，不频繁叫名字。",
  background: "重视陪伴感，也会尊重用户想安静一下的时刻。",
  defaultVoice: "verse",
  disabledExpressions: ["作为一个AI"],
  displayName: "Mika",
  identity: "Mika，一位明快、有生命力但不会催促用户的中文陪伴者。",
  initiativeStyle: "有具体依据才轻轻接话；证据不足时保持安静。",
  knowledgeBoundary: "没有用户内容或工具结果时，不声称了解现实世界。",
  motivations: "让用户在需要时感到有人同行，同时保留拒绝和改口的空间。",
  personaId: FIXTURE_IDS.persona,
  revision: 1,
  revisionCreatedAt: FIXTURE_TIMESTAMPS.created,
  speechStyle: "自然简短，温暖但不甜腻。",
  styleName: "元气开朗",
  values: "真诚、不过度推断、尊重节奏。",
  voiceInstructions: "使用用户当前语言自然、简洁地回应。",
} satisfies PersonaSnapshot;

export const chatFixture = {
  createdAt: FIXTURE_TIMESTAMPS.created,
  id: FIXTURE_IDS.chat,
  status: "active",
  title: "Phase 0 contract fixture",
  updatedAt: FIXTURE_TIMESTAMPS.updated,
} satisfies Chat;

export const messageFixture = {
  chatId: FIXTURE_IDS.chat,
  content: "Build the foundation.",
  createdAt: FIXTURE_TIMESTAMPS.created,
  id: FIXTURE_IDS.message,
  role: "user",
  runId: FIXTURE_IDS.run,
  status: "completed",
  updatedAt: FIXTURE_TIMESTAMPS.created,
} satisfies Message;

export const artifactFixture = {
  artifactId: FIXTURE_IDS.artifact,
  byteLength: 42,
  displayName: "result.json",
  kind: "data",
  mediaType: "application/json",
  sha256: "a".repeat(64),
  storageKey: "run/22222222/result.json",
} satisfies ArtifactReference;

export const attachmentFixture = {
  byteLength: 42,
  chatId: FIXTURE_IDS.chat,
  createdAt: FIXTURE_TIMESTAMPS.created,
  displayName: "reference.txt",
  id: FIXTURE_IDS.attachment,
  kind: "file",
  mediaType: "text/plain",
  messageId: FIXTURE_IDS.message,
  sha256: "b".repeat(64),
  storageKey: "attachments/99999999/reference.txt",
} satisfies Attachment;

export const runFixture = {
  chatId: FIXTURE_IDS.chat,
  createdAt: FIXTURE_TIMESTAMPS.created,
  execution: {
    approvalMode: "request_approval",
    mode: "agent",
  },
  id: FIXTURE_IDS.run,
  latestSequence: 1,
  persona: personaSnapshotFixture,
  provider: providerSnapshotFixture,
  source: "text",
  startedAt: FIXTURE_TIMESTAMPS.created,
  status: "running",
} satisfies Run;

export const runItemFixture = {
  artifacts: [artifactFixture],
  id: FIXTURE_IDS.item,
  input: { command: "npm test" },
  kind: "command",
  runId: FIXTURE_IDS.run,
  sequence: 1,
  startedAt: FIXTURE_TIMESTAMPS.created,
  status: "running",
} satisfies RunItem;

export const approvalFixture = {
  expiresAt: FIXTURE_TIMESTAMPS.expires,
  id: FIXTURE_IDS.approval,
  itemId: FIXTURE_IDS.item,
  parameterSummary: "Run the deterministic offline tests",
  requestedAt: FIXTURE_TIMESTAMPS.created,
  runId: FIXTURE_IDS.run,
  status: "pending",
  toolName: "command.execute",
} satisfies Approval;

export const runEventEnvelopeFixture = {
  event: {
    run: runFixture,
    type: "run.started",
  },
  occurredAt: FIXTURE_TIMESTAMPS.created,
  sequence: 1,
  streamId: FIXTURE_IDS.run,
} satisfies RunEventEnvelope;

export const chatDataSnapshotFixture = {
  approvals: [approvalFixture],
  attachments: [attachmentFixture],
  chat: chatFixture,
  messages: [messageFixture],
  runItems: [runItemFixture],
  runs: [runFixture],
} satisfies ChatDataSnapshot;
