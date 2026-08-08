import type { AgentApi } from "../../../shared/contracts/agent";
import type {
  Chat,
  ChatApi,
  ChatDataSnapshot,
  ChatMutationResponse,
  ChatStatus,
} from "../../../shared/contracts/chat";
import type {
  ArtifactReference,
  Run,
  RunExecution,
} from "../../../shared/contracts/run";
import type {
  RunEventEnvelope,
  RunEventsApi,
} from "../../../shared/contracts/ipc";
import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import type { ChatModelOption } from "./types";

export interface ChatDomainState {
  readonly activeSnapshot: ChatDataSnapshot | null;
  readonly chats: readonly Chat[];
  readonly error: string | undefined;
  readonly models: readonly ChatModelOption[];
  readonly status: "loading" | "ready";
}

export interface SubmitChatRunInput {
  readonly attachments: readonly ArtifactReference[];
  readonly chatId: string;
  readonly content: string;
  readonly execution: RunExecution;
  readonly providerProfileId: string;
}

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>([
  "queued",
  "running",
  "waiting_approval",
]);

const initialState: ChatDomainState = {
  activeSnapshot: null,
  chats: [],
  error: undefined,
  models: [],
  status: "loading",
};

function profileToModel(profile: ProviderProfile): ChatModelOption | undefined {
  const modelId = profile.chatModel?.trim();
  if (!profile.hasApiKey || !modelId) {
    return undefined;
  }
  return {
    displayName: modelId,
    id: `${profile.id}::${modelId}`,
    provider: {
      apiStyle: profile.apiStyle,
      modelId,
      profileId: profile.id,
      profileName: profile.name,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "会话操作失败，请重试。";
}

export class ChatDomainStore {
  readonly #listeners = new Set<() => void>();
  #activeChatId: string | null = null;
  #eventSync: Promise<void> = Promise.resolve();
  #listGeneration = 0;
  #listQuery = "";
  #listStatus: ChatStatus = "active";
  #snapshotGeneration = 0;
  #state: ChatDomainState = initialState;
  #unsubscribeEvents: (() => void) | undefined;

  constructor(
    private readonly chatApi: ChatApi,
    private readonly agentApi: AgentApi,
    private readonly providerApi: ProviderApi,
    private readonly runEventsApi: RunEventsApi,
  ) {}

  readonly getState = (): ChatDomainState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): () => void {
    this.#unsubscribeEvents ??= this.runEventsApi.subscribe((envelope) => {
      this.#eventSync = this.#eventSync
        .catch(() => undefined)
        .then(() => this.#handleRunEvent(envelope));
    });
    void Promise.all([this.loadChats("active", ""), this.refreshModels()]).then(
      () => this.#setState({ status: "ready" }),
    );
    return () => this.stop();
  }

  stop(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
  }

  clearError(): void {
    this.#setState({ error: undefined });
  }

  async archive(chatId: string): Promise<Chat> {
    return this.#mutate(chatId, () => this.chatApi.archive({ chatId }));
  }

  async create(): Promise<Chat> {
    try {
      const result = await this.chatApi.create({});
      if (!result.ok) throw new Error(result.error.message);
      await this.loadChats("active", this.#listQuery);
      await this.loadSnapshot(result.value.id);
      return result.value;
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async delete(chatId: string): Promise<void> {
    try {
      const result = await this.chatApi.delete({ chatId });
      if (!result.ok) throw new Error(result.error.message);
      if (this.#activeChatId === chatId) {
        this.#activeChatId = null;
        this.#snapshotGeneration += 1;
        this.#setState({ activeSnapshot: null });
      }
      await this.loadChats(this.#listStatus, this.#listQuery);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async loadChats(status: ChatStatus, query: string): Promise<void> {
    this.#listStatus = status;
    this.#listQuery = query;
    const generation = ++this.#listGeneration;
    try {
      const result = await this.chatApi.list({ query, status });
      if (generation !== this.#listGeneration) return;
      if (!result.ok) throw new Error(result.error.message);
      this.#setState({ chats: result.value, error: undefined });
    } catch (error) {
      if (generation === this.#listGeneration) {
        this.#setState({ error: errorMessage(error) });
      }
    }
  }

  async loadSnapshot(chatId: string | null): Promise<void> {
    this.#activeChatId = chatId;
    const generation = ++this.#snapshotGeneration;
    if (!chatId) {
      this.#setState({ activeSnapshot: null });
      return;
    }
    try {
      const result = await this.chatApi.getSnapshot({ chatId });
      if (
        generation !== this.#snapshotGeneration ||
        this.#activeChatId !== chatId
      ) {
        return;
      }
      if (!result.ok) throw new Error(result.error.message);
      this.#setState({ activeSnapshot: result.value, error: undefined });
    } catch (error) {
      if (generation === this.#snapshotGeneration) {
        this.#setState({ activeSnapshot: null, error: errorMessage(error) });
      }
    }
  }

  async refreshModels(): Promise<void> {
    try {
      const result = await this.providerApi.listProfiles();
      if (!result.ok) throw new Error(result.error.message);
      const models = result.value.flatMap((profile) => {
        const model = profileToModel(profile);
        return model ? [model] : [];
      });
      this.#setState({ models, error: undefined });
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
    }
  }

  async rename(chatId: string, title: string): Promise<Chat> {
    return this.#mutate(chatId, () => this.chatApi.rename({ chatId, title }));
  }

  async restore(chatId: string): Promise<Chat> {
    return this.#mutate(chatId, () => this.chatApi.restore({ chatId }));
  }

  async setPinned(chatId: string, pinned: boolean): Promise<Chat> {
    return this.#mutate(chatId, () =>
      this.chatApi.setPinned({ chatId, pinned }),
    );
  }

  async submit(input: SubmitChatRunInput): Promise<void> {
    try {
      const activeRun = this.#activeRun(input.chatId);
      if (activeRun) {
        if (input.attachments.length > 0) {
          throw new Error("Run 进行中不能追加新附件，请先停止或等待本轮完成。");
        }
        const result = await this.agentApi.steer({
          content: input.content,
          requestedAt: new Date().toISOString(),
          runId: activeRun.id,
        });
        if (!result.ok) throw new Error(result.error.message);
      } else {
        const result = await this.agentApi.start({
          attachments: [...input.attachments],
          chatId: input.chatId,
          content: input.content,
          execution: input.execution,
          providerProfileId: input.providerProfileId,
          requestedAt: new Date().toISOString(),
        });
        if (!result.ok) throw new Error(result.error.message);
      }
      await this.loadSnapshot(input.chatId);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async cancelActive(chatId: string): Promise<void> {
    try {
      const run = this.#activeRun(chatId);
      if (!run) return;
      const result = await this.agentApi.cancel({
        requestedAt: new Date().toISOString(),
        runId: run.id,
      });
      if (!result.ok) throw new Error(result.error.message);
      await this.loadSnapshot(chatId);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<void> {
    try {
      const result = await this.agentApi.resolveApproval({
        approvalId,
        decidedAt: new Date().toISOString(),
        decision,
      });
      if (!result.ok) throw new Error(result.error.message);
      const run = this.#state.activeSnapshot?.runs.find(
        ({ id }) => id === result.value.runId,
      );
      if (run) await this.loadSnapshot(run.chatId);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async resume(runId: string): Promise<void> {
    try {
      const run = this.#state.activeSnapshot?.runs.find(
        (candidate) => candidate.id === runId,
      );
      if (!run) throw new Error("找不到要继续的 Run。");
      const result = await this.agentApi.resume({
        requestedAt: new Date().toISOString(),
        runId,
      });
      if (!result.ok) throw new Error(result.error.message);
      await this.loadSnapshot(run.chatId);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async #afterMutation(chatId: string): Promise<void> {
    await this.loadChats(this.#listStatus, this.#listQuery);
    if (this.#activeChatId === chatId) {
      await this.loadSnapshot(chatId);
    }
  }

  #activeRun(chatId: string): Run | undefined {
    const snapshot = this.#state.activeSnapshot;
    if (snapshot?.chat.id !== chatId) return undefined;
    return [...snapshot.runs]
      .reverse()
      .find(({ status }) => ACTIVE_RUN_STATUSES.has(status));
  }

  async #mutate(
    chatId: string,
    operation: () => Promise<ChatMutationResponse>,
  ): Promise<Chat> {
    try {
      const result = await operation();
      if (!result.ok) throw new Error(result.error.message);
      await this.#afterMutation(chatId);
      return result.value;
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
      throw error;
    }
  }

  async #handleRunEvent(envelope: RunEventEnvelope): Promise<void> {
    const snapshot = this.#state.activeSnapshot;
    if (!snapshot || !this.#activeChatId) return;
    const existingRun = snapshot.runs.find(
      ({ id }) => id === envelope.streamId,
    );
    const eventChatId =
      envelope.event.type === "run.started"
        ? envelope.event.run.chatId
        : existingRun?.chatId;
    if (eventChatId !== this.#activeChatId) return;

    const afterSequence = existingRun?.latestSequence ?? 0;
    if (envelope.sequence <= afterSequence) return;
    try {
      if (envelope.sequence > afterSequence + 1 && existingRun) {
        await this.runEventsApi.replay({
          afterSequence,
          streamId: envelope.streamId,
        });
      }
      await this.loadSnapshot(this.#activeChatId);
    } catch (error) {
      this.#setState({ error: errorMessage(error) });
    }
  }

  #setState(patch: Partial<ChatDomainState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
