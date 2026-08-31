import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import styles from "./CopyButton.module.css";

type CopyState = "idle" | "copied" | "failed";

export interface CopyButtonProps {
  readonly label?: string;
  readonly value: string;
}

async function writeClipboard(value: string): Promise<void> {
  await window.charaMate.clipboard.writeText(value);
}

export function CopyButton({ label = "复制", value }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const statusLabel =
    state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label;
  const Icon =
    state === "copied" ? Check : state === "failed" ? TriangleAlert : Copy;

  return (
    <button
      className={styles["button"]}
      type="button"
      aria-label={statusLabel}
      onClick={() => {
        void writeClipboard(value)
          .then(() => {
            setState("copied");
            if (resetTimer.current !== undefined) {
              clearTimeout(resetTimer.current);
            }
            resetTimer.current = setTimeout(() => {
              setState("idle");
            }, 1_200);
          })
          .catch(() => {
            setState("failed");
          });
      }}
    >
      <Icon aria-hidden="true" size={12} strokeWidth={1.75} />
      <span>{statusLabel}</span>
    </button>
  );
}
