import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  PetAnimation,
  PetCharacterSnapshot,
  PetDragPoint,
  PetFacing,
} from "../../shared/contracts/pet";
import { getDragAnimation } from "./petAtlas";
import { PixiPetCanvas } from "./PixiPetCanvas";
import styles from "./CharacterApp.module.css";

function pointFromEvent(event: ReactPointerEvent): PetDragPoint | null {
  const point = { screenX: event.screenX, screenY: event.screenY };
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY)
    ? point
    : null;
}

export function CharacterApp() {
  const [snapshot, setSnapshot] = useState<PetCharacterSnapshot | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragFacing, setDragFacing] = useState<PetFacing>("right");
  const [lookAngleDegrees, setLookAngleDegrees] = useState<number | null>(null);
  const activePointer = useRef<number | null>(null);
  const lastDragPoint = useRef<PetDragPoint | null>(null);
  const markedReady = useRef(false);

  const markReady = useCallback(() => {
    if (markedReady.current) return;
    markedReady.current = true;
    window.charaMateCharacter.markReady();
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.charaMateCharacter.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void window.charaMateCharacter
      .getSnapshot()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        if (!next.activePet) markReady();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStartupError(
          error instanceof Error ? error.message : "无法读取桌宠状态。",
        );
        markReady();
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [markReady]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || activePointer.current !== null) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    activePointer.current = pointerId;
    lastDragPoint.current = point;
    setDragFacing(snapshot?.facing ?? "right");
    setDragging(true);
    target.setPointerCapture(pointerId);
    void window.charaMateCharacter.startDrag(point).catch(() => {
      if (activePointer.current !== pointerId) return;
      activePointer.current = null;
      lastDragPoint.current = null;
      setDragging(false);
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointer.current === event.pointerId) {
      const point = pointFromEvent(event);
      if (!point) return;
      const previousPoint = lastDragPoint.current;
      const deltaX = previousPoint ? point.screenX - previousPoint.screenX : 0;
      lastDragPoint.current = point;
      if (Math.abs(deltaX) >= 1) setDragFacing(deltaX < 0 ? "left" : "right");
      window.charaMateCharacter.moveDrag(point);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = event.clientX - (bounds.left + bounds.width / 2);
    const deltaY = event.clientY - (bounds.top + bounds.height / 2);
    const angle = (Math.atan2(deltaX, -deltaY) * 180) / Math.PI;
    setLookAngleDegrees(Math.round(((angle + 360) % 360) / 22.5) * 22.5);
  };

  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (activePointer.current !== event.pointerId) return;
    const point = pointFromEvent(event) ?? lastDragPoint.current;
    activePointer.current = null;
    lastDragPoint.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!point) return;
    void window.charaMateCharacter
      .endDrag(point)
      .then(({ moved }) => {
        if (!moved) window.charaMateCharacter.focusMain();
      })
      .catch(() => undefined);
  };

  const animation: PetAnimation = dragging
    ? getDragAnimation(dragFacing)
    : lookAngleDegrees === null
      ? (snapshot?.animation ?? "idle")
      : "look";

  return (
    <main
      aria-label={
        snapshot?.activePet
          ? `${snapshot.activePet.displayName} 桌宠`
          : "CharaMate 桌宠"
      }
      className={styles["character"]}
      data-dragging={dragging || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        window.charaMateCharacter.showContextMenu();
      }}
      onDoubleClick={() => window.charaMateCharacter.focusMain()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          window.charaMateCharacter.focusMain();
        }
      }}
      onPointerCancel={finishDrag}
      onPointerDown={handlePointerDown}
      onPointerLeave={() => {
        if (activePointer.current === null) setLookAngleDegrees(null);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      role="button"
      tabIndex={0}
    >
      {startupError ? (
        <span className={styles["status"]} role="alert">
          {startupError}
        </span>
      ) : snapshot?.activePet ? (
        <PixiPetCanvas
          animation={animation}
          animationSpeed={snapshot.animationSpeed}
          lookAngleDegrees={lookAngleDegrees ?? 0}
          onReady={markReady}
          pet={snapshot.activePet}
        />
      ) : snapshot ? (
        <span className={styles["status"]}>请在 Character 设置中导入桌宠</span>
      ) : null}
    </main>
  );
}
