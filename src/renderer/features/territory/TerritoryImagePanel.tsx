import { Check, ImagePlus, RefreshCw, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  ProviderApi,
  ProviderProfile,
} from "../../../shared/contracts/provider";
import type {
  TerritoryApi,
  TerritoryImageCandidate,
  TerritoryImageMutationResponse,
  TerritorySceneId,
  TerritorySnapshot,
} from "../../../shared/contracts/territory";
import { territoryCandidateUrl } from "../../../shared/pure/territoryAsset";
import styles from "./TerritoryPage.module.css";

interface TerritoryImagePanelProps {
  readonly api: TerritoryApi;
  readonly candidates: readonly TerritoryImageCandidate[];
  readonly onAccepted: () => void;
  readonly onClose: () => void;
  readonly onSnapshot: (snapshot: TerritorySnapshot) => void;
  readonly providerApi: Pick<ProviderApi, "listProfiles">;
  readonly sceneId: TerritorySceneId;
}

const statusLabel: Record<TerritoryImageCandidate["status"], string> = {
  accepted: "已加入收藏库",
  failed: "生成失败",
  generating: "生成中",
  ready: "等待确认",
};

function usableImageProfiles(profiles: readonly ProviderProfile[]) {
  return profiles.filter(
    (profile) =>
      profile.apiStyle === "azure-openai" &&
      profile.hasApiKey &&
      profile.imageGenerationEndpoint &&
      profile.imageModel,
  );
}

export function TerritoryImagePanel({
  api,
  candidates,
  onAccepted,
  onClose,
  onSnapshot,
  providerApi,
  sceneId,
}: TerritoryImagePanelProps) {
  const [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    candidates.find(({ status }) => status !== "accepted")?.id ??
      candidates[0]?.id ??
      null,
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visualPrompt, setVisualPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void providerApi
      .listProfiles()
      .then((response) => {
        if (!active) return;
        if (!response.ok) {
          setError(response.error.message);
          return;
        }
        const available = usableImageProfiles(response.value);
        setProfiles(available);
        setProfileId((current) => current || available[0]?.id || "");
      })
      .catch(() => {
        if (active) setError("无法读取 Image Provider 配置。");
      });
    return () => {
      active = false;
    };
  }, [providerApi]);

  const selected = useMemo(
    () => candidates.find(({ id }) => id === selectedId) ?? null,
    [candidates, selectedId],
  );

  const startNewCandidate = () => {
    setSelectedId(null);
    setName("");
    setDescription("");
    setVisualPrompt("");
    setInstruction("");
    setError(null);
  };

  const applyMutation = async (
    request: () => Promise<TerritoryImageMutationResponse>,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(response.error.message);
        return false;
      }
      onSnapshot(response.value.snapshot);
      setSelectedId(response.value.candidateId);
      return true;
    } catch {
      setError("图片操作没有完成，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generate = (event: FormEvent) => {
    event.preventDefault();
    if (!profileId) {
      setError("请先在 Models 中配置可用的 Azure Image Provider。");
      return;
    }
    void applyMutation(() =>
      api.generateImageCandidate({
        description,
        name,
        providerProfileId: profileId,
        sceneId,
        visualPrompt,
      }),
    );
  };

  const edit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    void applyMutation(() =>
      api.editImageCandidate({ candidateId: selected.id, instruction }),
    ).then((succeeded) => {
      if (succeeded) setInstruction("");
    });
  };

  const confirm = () => {
    if (!selected) return;
    void applyMutation(() =>
      api.confirmImageCandidate({ candidateId: selected.id }),
    ).then((succeeded) => {
      if (succeeded) onAccepted();
    });
  };

  return (
    <aside className={styles["imagePanel"]} aria-label="生成领地物件">
      <header>
        <span>
          <strong>生成领地物件</strong>
          <small>预览满意后才会加入收藏库，当前场景不会被改动。</small>
        </span>
        <button type="button" aria-label="关闭生成面板" onClick={onClose}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>

      {candidates.length ? (
        <div className={styles["candidateHistory"]}>
          <label>
            <span>生成记录</span>
            <select
              value={selectedId ?? ""}
              onChange={(event) => {
                if (event.target.value) setSelectedId(event.target.value);
                else startNewCandidate();
              }}
            >
              <option value="">新物件</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {statusLabel[candidate.status]}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <button type="button" onClick={startNewCandidate}>
              <ImagePlus aria-hidden="true" size={13} />
              新物件
            </button>
          ) : null}
        </div>
      ) : null}

      {selected ? (
        <section className={styles["candidateDetail"]}>
          <div
            className={styles["candidatePreview"]}
            data-status={selected.status}
          >
            {selected.status === "ready" || selected.status === "accepted" ? (
              <img
                alt={`${selected.name}预览`}
                src={territoryCandidateUrl(selected.id, selected.updatedAt)}
              />
            ) : selected.status === "failed" ? (
              <span>{selected.error?.message ?? "图片生成失败。"}</span>
            ) : (
              <span>正在生成透明背景预览…</span>
            )}
          </div>
          <div className={styles["candidateTitle"]}>
            <span>
              <small>{statusLabel[selected.status]}</small>
              <strong>{selected.name}</strong>
            </span>
            {selected.status === "failed" ? (
              <button
                disabled={busy}
                type="button"
                onClick={() =>
                  void applyMutation(() =>
                    api.retryImageCandidate({ candidateId: selected.id }),
                  )
                }
              >
                <RefreshCw aria-hidden="true" size={13} />
                重试
              </button>
            ) : null}
          </div>
          <p className={styles["candidateDescription"]}>
            {selected.description}
          </p>
          {selected.status === "ready" || selected.status === "accepted" ? (
            <>
              <form className={styles["candidateEdit"]} onSubmit={edit}>
                <label>
                  <span>继续修改</span>
                  <textarea
                    required
                    rows={2}
                    value={instruction}
                    placeholder="例如：把灯光改成更柔和的琥珀色"
                    onChange={(event) => setInstruction(event.target.value)}
                  />
                </label>
                <button disabled={busy} type="submit">
                  <WandSparkles aria-hidden="true" size={13} />
                  生成修改版
                </button>
              </form>
              {selected.status === "ready" ? (
                <button
                  className={styles["confirmCandidate"]}
                  disabled={busy}
                  type="button"
                  onClick={confirm}
                >
                  <Check aria-hidden="true" size={14} />
                  确认加入收藏库
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : (
        <form className={styles["candidateForm"]} onSubmit={generate}>
          {profiles.length > 1 ? (
            <label>
              <span>Image Provider</span>
              <select
                required
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.imageModel}
                  </option>
                ))}
              </select>
            </label>
          ) : profiles[0] ? (
            <p className={styles["providerHint"]}>
              使用 {profiles[0].name} · {profiles[0].imageModel}
            </p>
          ) : (
            <p className={styles["providerHint"]}>
              请先在 Models 中为 Azure Image Profile 保存 Endpoint、Model 和 API
              Key。
            </p>
          )}
          <label>
            <span>名称</span>
            <input
              required
              value={name}
              placeholder="例如：长夜台灯"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            <span>简短描述</span>
            <input
              required
              value={description}
              placeholder="留一盏灯，纪念完成项目的夜晚。"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            <span>想生成的样子</span>
            <textarea
              required
              rows={4}
              value={visualPrompt}
              placeholder="一盏小巧的黄铜工坊台灯，灯罩下有温暖光晕"
              onChange={(event) => setVisualPrompt(event.target.value)}
            />
          </label>
          <button disabled={busy || profiles.length === 0} type="submit">
            <WandSparkles aria-hidden="true" size={14} />
            {busy ? "正在生成…" : "生成预览"}
          </button>
        </form>
      )}

      {busy ? (
        <p className={styles["imageProgress"]} aria-live="polite">
          请求已接收，正在生成并处理透明背景…
        </p>
      ) : null}
      {error ? (
        <p className={styles["imageError"]} role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
