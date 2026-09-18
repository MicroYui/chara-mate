import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CalendarDays,
  HardDrive,
  Map as MapIcon,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ActivityApi,
  ActivityEpisode,
  ActivityEvent,
  ActivitySnapshot,
} from "../../../shared/contracts/activity";
import type { TerritoryWorldApi } from "../../../shared/contracts/territoryWorld";
import { activityAssetUrl } from "../../../shared/pure/activityAsset";
import styles from "./ActivityPage.module.css";

function localDate(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

function timeLabel(timestamp: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function durationMinutes(episode: ActivityEpisode): number {
  return Math.max(
    1,
    Math.round(
      (Date.parse(episode.endedAt) - Date.parse(episode.startedAt)) / 60_000,
    ),
  );
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function assetId(storageKey: string): string {
  return storageKey.endsWith(".png") ? storageKey.slice(0, -4) : storageKey;
}

interface ActivityPageProps {
  readonly api?: ActivityApi;
  readonly focusEpisodeId?: string;
  readonly focusEventId?: string;
  readonly onFocusConsumed?: () => void;
  readonly onOpenTerritory?: (candidateId: string) => void;
  readonly territoryApi?: Pick<TerritoryWorldApi, "createSourceCandidate">;
}

const emptyEpisodes: readonly ActivityEpisode[] = [];

export function ActivityPage({
  api = window.charaMate.activity,
  focusEpisodeId,
  focusEventId,
  onFocusConsumed,
  onOpenTerritory,
  territoryApi,
}: ActivityPageProps) {
  const [date, setDate] = useState(localDate);
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null);
  const [sourceEvent, setSourceEvent] = useState<ActivityEvent | null>(null);
  const [selected, setSelected] = useState<ActivityEpisode | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const episodeListRef = useRef<HTMLDivElement>(null);
  const focusSequence = useRef(0);
  const episodes = useMemo(() => {
    const values = snapshot?.episodes ?? emptyEpisodes;
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return values;
    return values.filter((episode) =>
      [
        episode.title,
        episode.summary,
        ...episode.appNames,
        ...episode.domains,
      ].some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [query, snapshot]);
  const episodeVirtualizer = useVirtualizer({
    count: episodes.length,
    estimateSize: () => 106,
    getScrollElement: () => episodeListRef.current,
    initialRect: { height: 520, width: 0 },
    overscan: 6,
  });

  const load = useCallback(async () => {
    try {
      const response = await api.getSnapshot({ date });
      if (response.ok) {
        setSnapshot(response.value);
        setError(null);
      } else setError(response.error.message);
    } catch {
      setError("无法读取 Activity，请重试。");
    }
  }, [api, date]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSnapshot({ date })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) {
          setSnapshot(response.value);
          setError(null);
        } else setError(response.error.message);
      })
      .catch(() => {
        if (!cancelled) setError("无法读取 Activity，请重试。");
      });
    return () => {
      cancelled = true;
    };
  }, [api, date]);

  useEffect(() => {
    if (!focusEpisodeId && !focusEventId) return;
    const sequence = ++focusSequence.current;
    void (async () => {
      let episodeId = focusEpisodeId;
      if (focusEventId) {
        const reference = await api.resolveEventReference({
          eventId: focusEventId,
        });
        if (sequence !== focusSequence.current) return;
        if (!reference.ok) throw new Error(reference.error.message);
        setSourceEvent(reference.value.event);
        setDate(reference.value.date);
        setQuery("");
        episodeId = reference.value.episodeId;
        if (!episodeId) {
          setSelected(null);
          setError(null);
          setNotice("这条观察尚未归入活动片段，已打开发生当天。");
          return;
        }
      }
      if (!episodeId) return;
      const response = await api.getEpisode({ episodeId });
      if (sequence !== focusSequence.current) return;
      if (!response.ok) throw new Error(response.error.message);
      const episode = response.value;
      setDate(localDate(new Date(episode.startedAt)));
      setQuery("");
      setSelected(episode);
      setTitle(episode.title);
      setSummary(episode.summary);
      setNotice(null);
      setError(null);
    })()
      .catch((cause: unknown) => {
        if (sequence === focusSequence.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "无法打开这段 Activity，请重试。",
          );
        }
      })
      .finally(() => {
        if (sequence === focusSequence.current) onFocusConsumed?.();
      });
    return () => {
      focusSequence.current += 1;
    };
  }, [api, focusEpisodeId, focusEventId, onFocusConsumed]);

  const totals = useMemo(() => {
    const values = new Map<string, number>();
    for (const episode of episodes) {
      const label = episode.domains[0] ?? episode.appNames[0] ?? episode.title;
      values.set(label, (values.get(label) ?? 0) + durationMinutes(episode));
    }
    return [...values.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6);
  }, [episodes]);

  const togglePaused = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const response = await api.setPaused({ paused: !snapshot.paused });
      if (response.ok) {
        setSnapshot(response.value);
        setError(null);
      } else setError(response.error.message);
    } catch {
      setError("无法更新 Activity 采集状态，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await api.cleanup({});
      if (response.ok) {
        setError(null);
        setNotice(
          `已清理 ${response.value.deletedEvents} 条原始事件和 ${response.value.deletedAssets} 个截图资产。`,
        );
        await load();
      } else setError(response.error.message);
    } catch {
      setError("Activity 清理没有完成，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const addDigestToTerritory = async (digestId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await (
        territoryApi ?? window.charaMate.territory
      ).createSourceCandidate({
        source: { digestId, kind: "activity_digest" },
      });
      if (response.ok) {
        onOpenTerritory?.(response.value.candidateId);
      } else setError(response.error.message);
    } catch {
      setError("无法把这段趋势放入领地，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const saveEpisode = async () => {
    if (!selected || !title.trim() || !summary.trim() || busy) return;
    setBusy(true);
    try {
      const response = await api.updateEpisode({
        episodeId: selected.id,
        summary: summary.trim(),
        title: title.trim(),
      });
      if (response.ok) {
        setError(null);
        setSelected(response.value);
        await load();
      } else setError(response.error.message);
    } catch {
      setError("Episode 没有保存，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const deleteEpisode = async () => {
    if (
      !selected ||
      busy ||
      !window.confirm("删除这段 Activity 及其原始截图？")
    )
      return;
    setBusy(true);
    try {
      const response = await api.deleteEpisode({ episodeId: selected.id });
      if (response.ok) {
        setError(null);
        setSnapshot(response.value);
        setSelected(null);
      } else setError(response.error.message);
    } catch {
      setError("Episode 没有删除，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles["page"]}>
      <header className={styles["toolbar"]}>
        <label>
          <CalendarDays aria-hidden="true" size={15} />
          <input
            aria-label="Activity 日期"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.currentTarget.value);
              setSelected(null);
              setSourceEvent(null);
              setTitle("");
              setSummary("");
            }}
          />
        </label>
        <label className={styles["search"]}>
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="搜索 Activity"
            placeholder="搜索活动"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button
          className={styles["pauseButton"]}
          disabled={busy || !snapshot}
          type="button"
          onClick={() => void togglePaused()}
        >
          {snapshot?.paused ? (
            <Play aria-hidden="true" size={15} />
          ) : (
            <Pause aria-hidden="true" size={15} />
          )}
          {snapshot?.paused ? "恢复采集" : "暂停采集"}
        </button>
        <span className={styles["spacer"]} />
        <span className={styles["storage"]}>
          <HardDrive aria-hidden="true" size={14} />
          原始资产 {bytesLabel(snapshot?.rawBytes ?? 0)}
        </span>
        <button disabled={busy} type="button" onClick={() => void cleanup()}>
          <Trash2 aria-hidden="true" size={14} />
          立即清理
        </button>
        <button
          aria-label="刷新 Activity"
          disabled={busy}
          type="button"
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" size={14} />
        </button>
      </header>
      {error ? (
        <div className={styles["error"]} role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <button
          className={styles["notice"]}
          type="button"
          onClick={() => setNotice(null)}
        >
          {notice}
        </button>
      ) : null}
      <div className={styles["content"]}>
        <main className={styles["timeline"]}>
          {sourceEvent ? (
            <article
              className={styles["sourceEvidence"]}
              aria-label="记忆的原始观察"
            >
              <header>
                <strong>当时的观察</strong>
                <time>{timeLabel(sourceEvent.startedAt)}</time>
              </header>
              {sourceEvent.details.source === "screenshot" ? (
                <>
                  <p>
                    {sourceEvent.details.visual?.surface.appName}{" "}
                    {sourceEvent.details.visual?.surface.windowTitle}
                  </p>
                  <img
                    src={activityAssetUrl(sourceEvent.details.artifactId)}
                    alt="这条记忆所依据的屏幕画面"
                  />
                  {sourceEvent.details.ocrText ? (
                    <pre>{sourceEvent.details.ocrText}</pre>
                  ) : null}
                </>
              ) : sourceEvent.details.source === "active_app" ||
                sourceEvent.details.source === "managed_browser" ? (
                <>
                  <p>
                    {sourceEvent.details.source === "active_app"
                      ? `${sourceEvent.details.appName} · ${sourceEvent.details.windowTitle ?? ""}`
                      : (sourceEvent.details.title ?? sourceEvent.details.url)}
                  </p>
                  {sourceEvent.details.content?.text ? (
                    <pre>{sourceEvent.details.content.text}</pre>
                  ) : (
                    <p>这条记录没有可读的页面文字。</p>
                  )}
                  <small>只表示当时可观察的内容，不代表已经阅读或认同。</small>
                </>
              ) : (
                <p>这条记录描述一次活动状态变化。</p>
              )}
              <button type="button" onClick={() => setSourceEvent(null)}>
                关闭来源
              </button>
            </article>
          ) : null}
          {snapshot?.paused ? (
            <div className={styles["paused"]}>
              <Pause aria-hidden="true" size={14} />
              Activity 采集已暂停
            </div>
          ) : null}
          {snapshot?.digests.length ? (
            <section className={styles["digests"]}>
              <header>
                <span>Period digest</span>
                <strong>这段时间的脉络</strong>
              </header>
              <div>
                {snapshot.digests.map((digest) => (
                  <article key={digest.id} data-kind={digest.kind}>
                    <span>
                      {digest.kind === "weekly" ? "跨期趋势" : "每日摘要"}
                    </span>
                    <h2>{digest.title}</h2>
                    <p>{digest.summary}</p>
                    <small>
                      {digest.episodeIds.length} 段活动 · {digest.evidenceDays}{" "}
                      个日期
                      {digest.candidateIds.length
                        ? ` · ${String(digest.candidateIds.length)} 个待确认记忆`
                        : ""}
                    </small>
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void addDigestToTerritory(digest.id)}
                    >
                      <MapIcon aria-hidden="true" size={13} />
                      放入领地
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          {totals.length ? (
            <section className={styles["totals"]}>
              {totals.map(([label, minutes]) => (
                <span key={label}>
                  <strong>{label}</strong>
                  {minutes} 分钟
                </span>
              ))}
            </section>
          ) : null}
          <section className={styles["episodes"]}>
            <header>
              <span>Timeline</span>
              <strong>{date} 的活动</strong>
            </header>
            <div ref={episodeListRef} className={styles["episodeList"]}>
              {snapshot && episodes.length === 0 ? (
                <p className={styles["empty"]}>
                  {query.trim()
                    ? "没有符合搜索条件的活动。"
                    : "这一天还没有活动记录。"}
                </p>
              ) : (
                <div
                  className={styles["episodeSizer"]}
                  style={{ height: episodeVirtualizer.getTotalSize() }}
                >
                  {episodeVirtualizer.getVirtualItems().map((row) => {
                    const episode = episodes[row.index];
                    if (!episode) return null;
                    return (
                      <article
                        key={episode.id}
                        ref={episodeVirtualizer.measureElement}
                        data-index={row.index}
                        style={{
                          transform: `translateY(${String(row.start)}px)`,
                        }}
                      >
                        <time>
                          {timeLabel(episode.startedAt)}
                          <span>{durationMinutes(episode)} min</span>
                        </time>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(episode);
                            setTitle(episode.title);
                            setSummary(episode.summary);
                          }}
                        >
                          <span className={styles["episodeMeta"]}>
                            {episode.actor === "agent"
                              ? "Agent 执行 · "
                              : episode.actor === "system"
                                ? "系统边界 · "
                                : ""}
                            {episode.sourceTypes
                              .map((source) => source.replaceAll("_", " "))
                              .join(" · ")}
                            {episode.rawClearedAt
                              ? " · 原始活动已按保留策略清理"
                              : ""}
                          </span>
                          <h3>{episode.title}</h3>
                          <p>{episode.summary}</p>
                          {episode.screenshotStorageKeys.length ? (
                            <div className={styles["screenshots"]}>
                              {episode.screenshotStorageKeys
                                .slice(0, 3)
                                .map((key) => (
                                  <img
                                    key={key}
                                    alt={`${episode.title} 截图`}
                                    src={activityAssetUrl(assetId(key))}
                                  />
                                ))}
                            </div>
                          ) : null}
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </main>
        <aside
          className={styles["detail"]}
          data-open={Boolean(selected) || undefined}
        >
          {selected ? (
            <>
              <header>
                <span>Episode</span>
                <strong>
                  {timeLabel(selected.startedAt)}–{timeLabel(selected.endedAt)}
                </strong>
              </header>
              <label>
                标题
                <input
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
              </label>
              <label>
                摘要
                <textarea
                  value={summary}
                  onChange={(event) => setSummary(event.currentTarget.value)}
                />
              </label>
              <dl>
                <div>
                  <dt>应用</dt>
                  <dd>{selected.appNames.join("、") || "—"}</dd>
                </div>
                <div>
                  <dt>网站</dt>
                  <dd>{selected.domains.join("、") || "—"}</dd>
                </div>
                <div>
                  <dt>事件</dt>
                  <dd>{selected.eventCount}</dd>
                </div>
              </dl>
              {selected.screenshotStorageKeys.length ? (
                <section
                  aria-label="Episode 截图"
                  className={styles["detailScreenshots"]}
                >
                  <span>截图</span>
                  <div>
                    {selected.screenshotStorageKeys.map((key) => (
                      <img
                        key={key}
                        alt={`${selected.title} 截图`}
                        src={activityAssetUrl(assetId(key))}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <div className={styles["detailActions"]}>
                <button type="button" onClick={() => setSelected(null)}>
                  关闭
                </button>
                <button
                  className={styles["dangerButton"]}
                  disabled={busy}
                  type="button"
                  onClick={() => void deleteEpisode()}
                >
                  删除
                </button>
                <button
                  className={styles["primaryButton"]}
                  disabled={busy || !title.trim() || !summary.trim()}
                  type="button"
                  onClick={() => void saveEpisode()}
                >
                  保存
                </button>
              </div>
            </>
          ) : (
            <div className={styles["detailEmpty"]}>
              选择一段 Episode 查看与编辑。
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
