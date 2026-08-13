import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ExtensionsApi,
  SkillDescriptor,
} from "../../../shared/contracts/extensions";
import styles from "./CapabilitySettingsPanel.module.css";

const newSkill = `---
name: my-skill
description: Describe when this reusable workflow should be used.
---

# Workflow

1. Add the workflow instructions here.
`;

type SkillListView = "active" | "archived";

export function SkillsSettingsPanel({
  api = window.charaMate.extensions,
}: {
  readonly api?: ExtensionsApi;
}) {
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>();
  const [name, setName] = useState("my-skill");
  const [content, setContent] = useState(newSkill);
  const [savedDraft, setSavedDraft] = useState<{
    readonly content: string;
    readonly name: string;
  }>();
  const [listView, setListView] = useState<SkillListView>("active");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = skills.find(({ id }) => id === selectedId);
  const visibleSkills = useMemo(
    () =>
      skills.filter((skill) =>
        listView === "archived" ? skill.archived : !skill.archived,
      ),
    [listView, skills],
  );
  const hasUnsavedChanges =
    !selected || savedDraft?.name !== name || savedDraft?.content !== content;

  const upsertSkill = useCallback((skill: SkillDescriptor) => {
    setSkills((current) =>
      [...current.filter(({ id }) => id !== skill.id), skill].sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id),
      ),
    );
  }, []);

  const refresh = useCallback(async () => {
    const response = await api.skillRefresh({});
    if (response.ok) setSkills(response.value);
    else setError(response.error.message);
  }, [api]);

  const select = useCallback(
    async (skill: SkillDescriptor) => {
      setSelectedId(skill.id);
      setName(skill.name);
      setSavedDraft(undefined);
      setError(undefined);
      setFeedback(undefined);
      const contentResponse = await api.skillGet({ skillId: skill.id });
      if (contentResponse.ok) {
        setContent(contentResponse.value.content);
        setName(contentResponse.value.skill.name);
        setSavedDraft({
          content: contentResponse.value.content,
          name: contentResponse.value.skill.name,
        });
        upsertSkill(contentResponse.value.skill);
      } else setError(contentResponse.error.message);
    },
    [api, upsertSkill],
  );

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setName("my-skill");
    setContent(newSkill);
    setSavedDraft(undefined);
    setError(undefined);
    setFeedback(undefined);
  }, []);

  const switchListView = (nextView: SkillListView) => {
    setListView(nextView);
    const nextSkill = skills.find((skill) =>
      nextView === "archived" ? skill.archived : !skill.archived,
    );
    if (nextSkill) void select(nextSkill);
    else clearSelection();
  };

  useEffect(() => {
    let active = true;
    void api.skillList({}).then((response) => {
      if (!active) return;
      if (response.ok) {
        setSkills(response.value);
        const initialSkill =
          response.value.find((skill) => !skill.readOnly && !skill.archived) ??
          response.value.find((skill) => !skill.archived);
        if (initialSkill) void select(initialSkill);
        else setSelectedId(null);
      } else {
        setError(response.error.message);
        setSelectedId(null);
      }
    });
    return () => {
      active = false;
    };
  }, [api, select]);

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await operation();
      await refresh();
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : "Skill 操作没有完成。",
      );
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    execute(async () => {
      const response = await api.skillSave({ content, name });
      if (!response.ok) throw new Error(response.error.message);
      setSelectedId(response.value.id);
      upsertSkill(response.value);
      setSavedDraft({ content, name });
      setListView("active");
      setFeedback("已保存。");
    });

  const restoreArchived = () => {
    if (!selected || !selected.archived) return;
    void execute(async () => {
      const response = await api.skillRestore({
        revision: selected.revision,
        skillId: selected.id,
      });
      if (!response.ok) throw new Error(response.error.message);
      setSelectedId(response.value.id);
      upsertSkill(response.value);
      setSavedDraft({ content, name });
      setListView("active");
      setFeedback("Skill 已恢复并重新启用。");
    });
  };

  const requestDelete = (skill: SkillDescriptor) => {
    if (
      !window.confirm(
        `永久删除“${skill.name}”及其整个目录？其中的 SKILL.md、脚本、模板和 references 都会被清除。此操作无法撤销。`,
      )
    ) {
      return;
    }
    void execute(async () => {
      const response = await api.skillDelete({ skillId: skill.id });
      if (!response.ok) throw new Error(response.error.message);
      setSelectedId(null);
      setName("my-skill");
      setContent(newSkill);
      setSavedDraft(undefined);
      setFeedback("Skill 已永久删除。");
    });
  };

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Skills</p>
        <h2>Agent Skills</h2>
        <p>管理 Agent 在匹配任务时按需使用的可复用流程。</p>
      </header>
      <div className={`${styles["columns"]} ${styles["skillsColumns"]}`}>
        <aside className={styles["skillSidebar"]}>
          <button
            className={styles["skillCreate"]}
            type="button"
            onClick={() => {
              setListView("active");
              clearSelection();
            }}
          >
            新建 Skill
          </button>
          <div
            aria-label="Skill 列表范围"
            className={styles["skillListTabs"]}
            role="group"
          >
            <button
              aria-pressed={listView === "active"}
              type="button"
              onClick={() => switchListView("active")}
            >
              当前
            </button>
            <button
              aria-pressed={listView === "archived"}
              type="button"
              onClick={() => switchListView("archived")}
            >
              已归档
            </button>
          </div>
          <div
            aria-label={
              listView === "active" ? "当前 Skills" : "已归档的 Skills"
            }
            className={styles["skillList"]}
          >
            {visibleSkills.map((skill) => (
              <button
                aria-current={skill.id === selectedId ? "true" : undefined}
                key={skill.id}
                type="button"
                onClick={() => void select(skill)}
              >
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </button>
            ))}
            {visibleSkills.length === 0 ? (
              <p>
                {listView === "active"
                  ? "还没有 Skill。"
                  : "没有已归档的 Skill。"}
              </p>
            ) : null}
          </div>
        </aside>
        <div className={styles["form"]}>
          <div className={styles["skillToolbar"]}>
            <div className={styles["skillState"]}>
              <strong>
                {!selected
                  ? "新建 Skill"
                  : selected.readOnly
                    ? "项目 Skill · 只读"
                    : selected.archived
                      ? "已归档"
                      : "可编辑"}
              </strong>
              <span>
                {!selected
                  ? "填写后保存到用户 Skills 目录。"
                  : selected.readOnly
                    ? "内容由工作区拥有；这里可以启用或停用，但不能编辑或删除。"
                    : selected.archived
                      ? "它不会被 Agent 加载；恢复后可以继续编辑。"
                      : "编辑完成后保存；归档和删除位于页面底部。"}
              </span>
            </div>
            <div className={styles["actions"]}>
              {selected && !selected.readOnly && selected.archived ? (
                <button
                  className={styles["primary"]}
                  disabled={busy}
                  type="button"
                  onClick={restoreArchived}
                >
                  恢复 Skill
                </button>
              ) : null}
              {!selected || (!selected.readOnly && !selected.archived) ? (
                <button
                  className={styles["primary"]}
                  disabled={
                    busy ||
                    !hasUnsavedChanges ||
                    !name.trim() ||
                    !content.trim()
                  }
                  type="button"
                  onClick={() => void save()}
                >
                  {!selected
                    ? "创建 Skill"
                    : hasUnsavedChanges
                      ? "保存更改"
                      : "已保存"}
                </button>
              ) : null}
            </div>
          </div>
          <p className={styles["feedback"]} role={error ? "alert" : "status"}>
            {error ?? feedback}
          </p>
          <label>
            名称
            <input
              disabled={selected?.readOnly || selected?.archived}
              spellCheck={false}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            SKILL.md
            <textarea
              className={styles["editor"]}
              disabled={selected?.readOnly || selected?.archived}
              spellCheck={false}
              value={content}
              wrap="soft"
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </label>
          {selected && !selected.archived ? (
            <div
              aria-label="Skill 行为"
              className={styles["skillOptions"]}
              role="group"
            >
              <label className={styles["skillOption"]}>
                <input
                  checked={selected.enabled}
                  disabled={busy || selected.archived}
                  type="checkbox"
                  onChange={(event) =>
                    void execute(async () => {
                      const response = await api.skillSetEnabled({
                        enabled: event.currentTarget.checked,
                        skillId: selected.id,
                      });
                      if (!response.ok) throw new Error(response.error.message);
                      upsertSkill(response.value);
                    })
                  }
                />
                <span>
                  <strong>启用 Skill</strong>
                  <small>允许 Agent 在匹配请求时加载它</small>
                </span>
              </label>
              {!selected.readOnly ? (
                <label className={styles["skillOption"]}>
                  <input
                    checked={selected.pinned}
                    disabled={busy || selected.archived}
                    type="checkbox"
                    onChange={(event) =>
                      void execute(async () => {
                        const response = await api.skillSetPinned({
                          pinned: event.currentTarget.checked,
                          skillId: selected.id,
                        });
                        if (!response.ok)
                          throw new Error(response.error.message);
                        upsertSkill(response.value);
                      })
                    }
                  />
                  <span>
                    <strong>Pin 当前 Skill</strong>
                    <small>阻止后台成长候选修改它</small>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}
          {!selected ? (
            <p className={styles["meta"]}>保存后写入用户 Skills 目录。</p>
          ) : null}
          {selected && !selected.readOnly ? (
            <section
              aria-label="Skill 管理"
              className={styles["skillManagement"]}
            >
              <div>
                <strong>Skill 管理</strong>
                <span>
                  {selected.archived
                    ? "永久删除会清除整个 Skill 目录，无法撤销。"
                    : hasUnsavedChanges
                      ? "请先保存更改再归档，避免丢失尚未保存的内容。"
                      : "归档会将它移出“当前”列表，之后仍可恢复。"}
                </span>
              </div>
              <div className={styles["actions"]}>
                {!selected.archived ? (
                  <button
                    disabled={busy || hasUnsavedChanges}
                    type="button"
                    onClick={() =>
                      void execute(async () => {
                        const response = await api.skillArchive({
                          skillId: selected.id,
                        });
                        if (!response.ok)
                          throw new Error(response.error.message);
                        upsertSkill(response.value);
                        setSavedDraft({ content, name });
                        setListView("archived");
                        setFeedback("Skill 已归档；它已移出当前列表。");
                      })
                    }
                  >
                    归档 Skill
                  </button>
                ) : null}
                <button
                  className={styles["danger"]}
                  disabled={busy}
                  type="button"
                  onClick={() => requestDelete(selected)}
                >
                  永久删除
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
