import { FolderInput, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type {
  PetDescriptor,
  PetLibrarySnapshot,
  PetManagementApi,
} from "../../../shared/contracts/pet";
import styles from "./CharacterSettingsPanel.module.css";

interface CharacterSettingsPanelProps {
  readonly api?: PetManagementApi;
}

function sliderStyle(value: number, minimum: number): CSSProperties {
  const progress = Math.min(
    100,
    Math.max(0, ((value - minimum) / (1.5 - minimum)) * 100),
  );
  return {
    "--range-progress": `${String(progress)}%`,
  } as CSSProperties;
}

function PetPreview({ pet }: { readonly pet: PetDescriptor }) {
  const rows = pet.spriteVersionNumber === 2 ? 11 : 9;
  const style = {
    backgroundImage: `url("${pet.spriteUrl}")`,
    backgroundSize: `800% ${String(rows * 100)}%`,
  } satisfies CSSProperties;
  return (
    <span aria-hidden="true" className={styles["preview"]} style={style} />
  );
}

export function CharacterSettingsPanel({
  api = window.charaMate.pet,
}: CharacterSettingsPanelProps) {
  const [library, setLibrary] = useState<PetLibrarySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const scaleRequest = useRef(0);
  const speedRequest = useRef(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribeChanged((snapshot) => {
      if (active) {
        setLibrary(snapshot);
        setError(null);
      }
    });
    void api
      .getLibrary()
      .then((response) => {
        if (!active) return;
        if (response.ok) setLibrary(response.value);
        else setError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "无法读取桌宠列表。",
          );
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const importPet = () => {
    setImporting(true);
    setError(null);
    void api
      .importFromFolder()
      .then((response) => {
        if (!response.ok) setError(response.error.message);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "导入桌宠失败。");
      })
      .finally(() => setImporting(false));
  };

  const selectPet = (petId: string) => {
    setError(null);
    void api
      .select({ petId })
      .then((response) => {
        if (response.ok) setLibrary(response.value);
        else setError(response.error.message);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "切换桌宠失败。");
      });
  };

  const setScale = (scale: number) => {
    const request = ++scaleRequest.current;
    setLibrary((current) => (current ? { ...current, scale } : current));
    setError(null);
    void api
      .setScale({ scale })
      .then((response) => {
        if (request !== scaleRequest.current) return;
        if (response.ok) setLibrary(response.value);
        else setError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (request === scaleRequest.current) {
          setError(
            cause instanceof Error ? cause.message : "调整桌宠大小失败。",
          );
        }
      });
  };

  const setAnimationSpeed = (animationSpeed: number) => {
    const request = ++speedRequest.current;
    setLibrary((current) =>
      current ? { ...current, animationSpeed } : current,
    );
    setError(null);
    void api
      .setAnimationSpeed({ animationSpeed })
      .then((response) => {
        if (request !== speedRequest.current) return;
        if (response.ok) setLibrary(response.value);
        else setError(response.error.message);
      })
      .catch((cause: unknown) => {
        if (request === speedRequest.current) {
          setError(
            cause instanceof Error ? cause.message : "调整动画速度失败。",
          );
        }
      });
  };

  return (
    <section className={styles["panel"]}>
      <div className={styles["headingRow"]}>
        <div>
          <p className={styles["eyebrow"]}>Character</p>
          <h2>桌面角色</h2>
          <p className={styles["summary"]}>
            导入 Codex v1/v2 桌宠，验证后复制到 CharaMate 自有目录。
          </p>
        </div>
        <button type="button" disabled={importing} onClick={importPet}>
          {importing ? (
            <LoaderCircle aria-hidden="true" className={styles["spinner"]} />
          ) : (
            <FolderInput aria-hidden="true" />
          )}
          {importing ? "正在导入…" : "导入 Codex 桌宠"}
        </button>
      </div>

      {error ? (
        <div className={styles["error"]} role="alert">
          {error}
        </div>
      ) : null}

      {!library ? (
        <p className={styles["loading"]}>正在读取桌宠…</p>
      ) : library.pets.length === 0 ? (
        <div className={styles["empty"]}>
          <strong>还没有导入桌宠</strong>
          <span>选择一个包含 pet.json 与 spritesheet 的目录开始。</span>
        </div>
      ) : (
        <ul className={styles["petList"]} aria-label="已导入桌宠">
          {library.pets.map((pet) => {
            const selected = library.activePetId === pet.id;
            return (
              <li className={styles["petRow"]} key={pet.id}>
                <PetPreview pet={pet} />
                <div className={styles["petDetails"]}>
                  <div className={styles["petTitle"]}>
                    <strong>{pet.displayName}</strong>
                    <span>v{pet.spriteVersionNumber}</span>
                  </div>
                  <p>{pet.description}</p>
                  <small>
                    {pet.spriteWidth}×{pet.spriteHeight}
                  </small>
                </div>
                <button
                  aria-label={
                    selected
                      ? `${pet.displayName} 已选`
                      : `选择 ${pet.displayName}`
                  }
                  className={styles["selectButton"]}
                  disabled={selected}
                  type="button"
                  onClick={() => selectPet(pet.id)}
                >
                  {selected ? "已选" : "选择"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {library ? (
        <div className={styles["controls"]}>
          <label className={styles["rangeField"]}>
            <span>桌宠大小</span>
            <input
              aria-label="桌宠大小"
              max="1.5"
              min="0.3"
              step="0.01"
              style={sliderStyle(library.scale, 0.3)}
              type="range"
              value={library.scale}
              onChange={(event) => setScale(Number(event.currentTarget.value))}
            />
          </label>
          <label className={styles["rangeField"]}>
            <span>动画速度</span>
            <input
              aria-label="动画速度"
              max="1.5"
              min="0.1"
              step="0.01"
              style={sliderStyle(library.animationSpeed, 0.1)}
              type="range"
              value={library.animationSpeed}
              onChange={(event) =>
                setAnimationSpeed(Number(event.currentTarget.value))
              }
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}
