import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EvolutionApi,
  EvolutionCandidate,
} from "../../../shared/contracts/evolution";
import {
  EvolutionCandidateCard,
  EvolutionCandidates,
} from "./EvolutionCandidates";

const candidate: EvolutionCandidate = {
  chatId: "10000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-13T08:00:00.000Z",
  evidence: ["以后先给结论"],
  id: "10000000-0000-4000-8000-000000000002",
  kind: "persona_preference",
  pinned: false,
  proposal: {
    claimSlot: "preference.response_style",
    content: "回答时先给结论。",
    kind: "persona_preference",
    reason: "用户明确教学",
  },
  rationale: "这是可复用的表达偏好。",
  replayCases: [],
  replayResult: { status: "not_required" },
  reviewId: "10000000-0000-4000-8000-000000000003",
  sourceItemIds: ["10000000-0000-4000-8000-000000000004"],
  sourceRunIds: ["10000000-0000-4000-8000-000000000005"],
  status: "draft",
  updatedAt: "2026-08-13T08:00:00.000Z",
};

afterEach(cleanup);

function makeApi() {
  let current = candidate;
  const updateCandidate = vi.fn<EvolutionApi["updateCandidate"]>((request) => {
    current = {
      ...current,
      proposal: request.proposal,
      rationale: request.rationale,
      replayCases: request.replayCases,
    };
    return Promise.resolve({ ok: true, value: current });
  });
  const acceptCandidate = vi.fn<EvolutionApi["acceptCandidate"]>(() => {
    current = {
      ...current,
      activatedAt: current.updatedAt,
      activatedMemoryId: "10000000-0000-4000-8000-000000000006",
      status: "active",
    };
    return Promise.resolve({ ok: true, value: current });
  });
  const unchanged = () =>
    Promise.resolve({ ok: true as const, value: current });
  const api: EvolutionApi = {
    acceptCandidate,
    archiveCandidate: vi.fn<EvolutionApi["archiveCandidate"]>(unchanged),
    list: vi.fn<EvolutionApi["list"]>(() =>
      Promise.resolve({
        ok: true as const,
        value: { candidates: [current], reviews: [] },
      }),
    ),
    rejectCandidate: vi.fn<EvolutionApi["rejectCandidate"]>(unchanged),
    restoreCandidate: vi.fn<EvolutionApi["restoreCandidate"]>(unchanged),
    retryReplay: vi.fn<EvolutionApi["retryReplay"]>(unchanged),
    retryReview: vi.fn<EvolutionApi["retryReview"]>(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "EVOLUTION.NOT_USED",
          message: "not used",
          retryable: false,
        },
      }),
    ),
    setCandidatePinned: vi.fn<EvolutionApi["setCandidatePinned"]>(unchanged),
    subscribe: vi.fn(() => () => undefined),
    updateCandidate,
  };
  return { acceptCandidate, api, updateCandidate };
}

describe("EvolutionCandidates", () => {
  it("shows evidence, lets the user edit, and never activates before confirmation", async () => {
    const { acceptCandidate, api, updateCandidate } = makeApi();
    render(
      <EvolutionCandidates
        allowEdit
        api={api}
        kinds={["persona_preference"]}
      />,
    );

    expect(await screen.findByText("Persona 偏好")).toBeVisible();
    expect(screen.getByText("待确认")).toBeVisible();
    expect(acceptCandidate).not.toHaveBeenCalled();

    const textarea = screen.getByRole("textbox", { name: "候选内容" });
    fireEvent.change(textarea, {
      target: { value: "回答时先给结论，再列证据。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(updateCandidate).toHaveBeenCalledTimes(1));
    expect(updateCandidate.mock.calls[0]?.[0].proposal.content).toBe(
      "回答时先给结论，再列证据。",
    );

    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    await waitFor(() => expect(acceptCandidate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已生效")).toBeVisible();
  });

  it("surfaces a failed background Review and retries it explicitly", async () => {
    const { api } = makeApi();
    const review = {
      chatId: candidate.chatId,
      completedAt: candidate.updatedAt,
      createdAt: candidate.createdAt,
      error: {
        code: "EVOLUTION.REVIEW_FAILED",
        message: "Provider 暂时不可用。",
        retryable: true,
      },
      id: candidate.reviewId,
      runId: candidate.sourceRunIds[0]!,
      startedAt: candidate.createdAt,
      status: "failed" as const,
      triggers: ["explicit_teaching" as const],
      updatedAt: candidate.updatedAt,
    };
    const retryReview = vi.fn<EvolutionApi["retryReview"]>(() =>
      Promise.resolve({
        ok: true,
        value: { ...review, status: "queued" as const },
      }),
    );
    const failedApi: EvolutionApi = {
      ...api,
      list: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: { candidates: [], reviews: [review] },
        }),
      ),
      retryReview,
    };

    render(<EvolutionCandidates api={failedApi} />);
    expect(await screen.findByText("复盘失败")).toBeVisible();
    expect(screen.getByText("Provider 暂时不可用。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试复盘" }));
    await waitFor(() =>
      expect(retryReview).toHaveBeenCalledWith({
        runId: candidate.sourceRunIds[0],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("复盘失败")).not.toBeInTheDocument(),
    );
  });

  it("collapses a later-edited Skill candidate into a result record instead of a second Skill manager", () => {
    const { api } = makeApi();
    const settledSkillCandidate: EvolutionCandidate = {
      ...candidate,
      activatedAt: candidate.updatedAt,
      activatedSkillId: "user:release-flow",
      activatedSkillRevision: 2,
      kind: "new_skill",
      proposal: {
        content: "---\nname: release-flow\ndescription: Release safely.\n---",
        kind: "new_skill",
        name: "release-flow",
      },
      replayResult: {
        completedAt: candidate.updatedAt,
        status: "passed",
      },
      status: "stale",
    };

    const { container } = render(
      <EvolutionCandidateCard
        api={api}
        candidate={settledSkillCandidate}
        compact
      />,
    );

    expect(
      screen.getByText("Skill 后来已更新；当前内容以 Settings → Skills 为准。"),
    ).toBeVisible();
    expect(screen.getByText("成长结果")).toBeVisible();
    expect(screen.getByText("release-flow")).toBeVisible();
    expect(screen.getByText("已保存为 Skill")).toBeVisible();
    expect(container.querySelector("pre")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "归档" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Pin" }),
    ).not.toBeInTheDocument();
  });
});
