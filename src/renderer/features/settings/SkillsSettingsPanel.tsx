import { useCallback, useEffect, useState } from "react";

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

export function SkillsSettingsPanel({
  api = window.charaMate.extensions,
}: {
  readonly api?: ExtensionsApi;
}) {
  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState("my-skill");
  const [content, setContent] = useState(newSkill);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const selected = skills.find(({ id }) => id === selectedId);

  const refresh = useCallback(async () => {
    const response = await api.skillRefresh({});
    if (response.ok) setSkills(response.value);
    else setError(response.error.message);
  }, [api]);

  useEffect(() => {
    let active = true;
    void api.skillList({}).then((response) => {
      if (!active) return;
      if (response.ok) setSkills(response.value);
      else setError(response.error.message);
    });
    return () => {
      active = false;
    };
  }, [api]);

  const select = async (skill: SkillDescriptor) => {
    setSelectedId(skill.id);
    setName(skill.name);
    setError(undefined);
    const response = await api.skillGet({ skillId: skill.id });
    if (response.ok) setContent(response.value.content);
    else setError(response.error.message);
  };

  const execute = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      await operation();
      await refresh();
    } catch {
      setError("Skill 操作没有完成。");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    execute(async () => {
      const response = await api.skillSave({ content, name });
      if (!response.ok) throw new Error(response.error.message);
      setSelectedId(response.value.id);
      setFeedback(`已保存 revision ${String(response.value.revision)}。`);
    });

  return (
    <section className={styles["panel"]}>
      <header className={styles["header"]}>
        <p className={styles["eyebrow"]}>Skills</p>
        <h2>Agent Skills</h2>
        <p>列表只常驻名称和描述；完整 SKILL.md 仅在命中后加载。</p>
      </header>
      <div className={styles["columns"]}>
        <aside className={styles["list"]} aria-label="Skills">
          {skills.map((skill) => (
            <button
              aria-current={skill.id === selectedId ? "true" : undefined}
              key={skill.id}
              type="button"
              onClick={() => void select(skill)}
            >
              <span>{skill.name}</span>
              <small>
                {skill.source === "workspace" ? "项目" : "用户"} · r
                {skill.revision}
                {skill.archived ? " · 已归档" : ""}
              </small>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setSelectedId(undefined);
              setName("my-skill");
              setContent(newSkill);
            }}
          >
            新建 Skill
          </button>
        </aside>
        <div className={styles["form"]}>
          <label>
            名称
            <input
              disabled={selected?.readOnly || selected?.archived}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            SKILL.md
            <textarea
              className={styles["editor"]}
              disabled={selected?.readOnly || selected?.archived}
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </label>
          {selected ? (
            <label className={styles["checkbox"]}>
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
                  })
                }
              />
              启用
            </label>
          ) : null}
          <p className={styles["meta"]}>
            {selected
              ? `${selected.source} · SHA-256 ${selected.contentSha256.slice(0, 12)}…${selected.lastUsedAt ? ` · 最近使用 ${selected.lastUsedAt}` : ""}`
              : "保存后写入用户 Skills 目录。"}
          </p>
          <p className={styles["feedback"]} role={error ? "alert" : "status"}>
            {error ?? feedback}
          </p>
          <div className={styles["actions"]}>
            {selected && !selected.readOnly && !selected.archived ? (
              <button
                className={styles["danger"]}
                disabled={busy}
                type="button"
                onClick={() =>
                  void execute(async () => {
                    const response = await api.skillArchive({
                      skillId: selected.id,
                    });
                    if (!response.ok) throw new Error(response.error.message);
                    setFeedback("Skill 已归档。");
                  })
                }
              >
                归档
              </button>
            ) : null}
            <button
              className={styles["primary"]}
              disabled={busy || selected?.readOnly || selected?.archived}
              type="button"
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
