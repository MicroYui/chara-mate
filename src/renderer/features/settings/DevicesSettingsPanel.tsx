import { Bell, CircleAlert, Smartphone, Unlink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CompanionApi,
  CompanionDesktopSnapshot,
} from "../../../shared/contracts/companion";
import baseStyles from "./CapabilitySettingsPanel.module.css";
import styles from "./DevicesSettingsPanel.module.css";

type PendingAction = "load" | "notifications" | "pair" | "unpair";

const statusLabels = {
  offline: "暂时离线",
  online: "在线",
  protocol_error: "协议异常",
} as const;

const permissionLabels = {
  denied: "未允许",
  granted: "已允许",
  unknown: "等待确认",
} as const;

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function notificationPermissionDescription(
  permission: Extract<
    CompanionDesktopSnapshot,
    { state: "paired" }
  >["device"]["notificationPermission"],
): string {
  if (permission === "granted") {
    return "手机可以显示 CharaMate 已投递的普通通知。";
  }
  if (permission === "denied") {
    return "手机当前不会显示通知；图片和文档分享仍可使用，请在 Android 系统设置中开启通知。";
  }
  return "等待手机确认通知权限；图片和文档分享仍可使用。";
}

function pendingMessage(action: PendingAction | undefined): string | undefined {
  switch (action) {
    case "load":
      return "正在读取 Android Companion 状态…";
    case "notifications":
      return "正在更新手机通知设置…";
    case "pair":
      return "正在生成配对二维码…";
    case "unpair":
      return "正在解除配对…";
    default:
      return undefined;
  }
}

export function DevicesSettingsPanel({
  api = window.charaMate.companion,
}: {
  readonly api?: CompanionApi;
}) {
  const [snapshot, setSnapshot] = useState<CompanionDesktopSnapshot>();
  const [pending, setPending] = useState<PendingAction>();
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const changedRevision = useRef(0);
  const mounted = useRef(false);
  const nextOperationToken = useRef(0);
  const currentOperationToken = useRef<number | undefined>(undefined);

  const readSnapshot = useCallback(
    async (baselineRevision = changedRevision.current) => {
      const operationToken = ++nextOperationToken.current;
      currentOperationToken.current = operationToken;
      setPending("load");
      setError(undefined);
      setFeedback(undefined);
      try {
        const response = await api.getSnapshot();
        if (!mounted.current) return;
        if (currentOperationToken.current !== operationToken) return;
        if (changedRevision.current !== baselineRevision) return;
        if (response.ok) {
          setSnapshot(response.value);
        } else {
          setError(response.error.message);
        }
      } catch (cause: unknown) {
        if (
          mounted.current &&
          currentOperationToken.current === operationToken &&
          changedRevision.current === baselineRevision
        ) {
          setError(
            cause instanceof Error
              ? cause.message
              : "无法读取 Android Companion 状态。",
          );
        }
      } finally {
        if (
          mounted.current &&
          currentOperationToken.current === operationToken
        ) {
          currentOperationToken.current = undefined;
          setPending(undefined);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    mounted.current = true;
    const baselineRevision = changedRevision.current;
    const unsubscribe = api.subscribeChanged((nextSnapshot) => {
      if (!mounted.current) return;
      changedRevision.current += 1;
      setSnapshot(nextSnapshot);
      setError(undefined);
      setFeedback(undefined);
    });
    void readSnapshot(baselineRevision);
    return () => {
      mounted.current = false;
      currentOperationToken.current = undefined;
      unsubscribe();
    };
  }, [api, readSnapshot]);

  const runMutation = async (
    action: Exclude<PendingAction, "load">,
    operation: () => ReturnType<
      | CompanionApi["setNotificationsEnabled"]
      | CompanionApi["startPairing"]
      | CompanionApi["unpair"]
    >,
    successMessage?: string,
  ) => {
    if (pending) return;
    const baselineRevision = changedRevision.current;
    const operationToken = ++nextOperationToken.current;
    currentOperationToken.current = operationToken;
    setPending(action);
    setError(undefined);
    setFeedback(undefined);
    try {
      const response = await operation();
      if (!mounted.current) return;
      if (currentOperationToken.current !== operationToken) return;
      if (response.ok) {
        if (changedRevision.current === baselineRevision) {
          setSnapshot(response.value);
        }
        setFeedback(successMessage);
      } else {
        setError(response.error.message);
      }
    } catch (cause: unknown) {
      if (mounted.current && currentOperationToken.current === operationToken) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Android Companion 操作没有完成。",
        );
      }
    } finally {
      if (mounted.current && currentOperationToken.current === operationToken) {
        currentOperationToken.current = undefined;
        setPending(undefined);
      }
    }
  };

  const startPairing = () => runMutation("pair", () => api.startPairing());

  const toggleNotifications = (
    paired: Extract<CompanionDesktopSnapshot, { state: "paired" }>,
  ) => {
    const enabled = !paired.device.notificationsEnabled;
    return runMutation(
      "notifications",
      () =>
        api.setNotificationsEnabled({
          deviceId: paired.device.id,
          enabled,
        }),
      enabled ? "手机通知已开启。" : "手机通知已关闭。",
    );
  };

  const unpair = (
    paired: Extract<CompanionDesktopSnapshot, { state: "paired" }>,
  ) => {
    if (
      !window.confirm(
        `解除与“${paired.device.displayName}”的配对？手机通知和分享会停止，之后可以重新配对。`,
      )
    ) {
      return Promise.resolve();
    }
    return runMutation(
      "unpair",
      () => api.unpair({ deviceId: paired.device.id }),
      "已解除配对。",
    );
  };

  const liveMessage = error ?? pendingMessage(pending) ?? feedback;

  return (
    <section className={baseStyles["panel"]}>
      <header className={baseStyles["header"]}>
        <p className={baseStyles["eyebrow"]}>Devices</p>
        <h2>Android Companion</h2>
        <p>把手机作为通知和分享入口；对话、记忆和处理仍在这台电脑完成。</p>
      </header>

      {!snapshot ? (
        <div className={baseStyles["section"]}>
          <div className={baseStyles["capabilityRow"]}>
            <span className={baseStyles["capabilityIcon"]}>
              <Smartphone aria-hidden="true" size={17} />
            </span>
            <div>
              <h3>{error ? "无法读取设备状态" : "正在读取设备状态"}</h3>
              <p>
                {error
                  ? "请重试读取当前 Android Companion 状态。"
                  : "正在确认这台电脑是否已连接手机。"}
              </p>
            </div>
            {error ? (
              <button
                disabled={pending === "load"}
                type="button"
                onClick={() => void readSnapshot()}
              >
                重试
              </button>
            ) : null}
          </div>
        </div>
      ) : snapshot.state === "unpaired" ? (
        <div className={baseStyles["section"]}>
          <div className={baseStyles["capabilityRow"]}>
            <span className={baseStyles["capabilityIcon"]}>
              <Smartphone aria-hidden="true" size={17} />
            </span>
            <div>
              <h3>尚未连接手机</h3>
              <p>连接后可以接收普通通知，并从手机分享单张图片或文档。</p>
            </div>
            <button
              className={baseStyles["primary"]}
              disabled={pending !== undefined}
              type="button"
              onClick={() => void startPairing()}
            >
              {pending === "pair" ? "正在生成…" : "开始配对"}
            </button>
          </div>
        </div>
      ) : snapshot.state === "pairing" ? (
        <div className={baseStyles["section"]}>
          <div className={styles["pairingLayout"]}>
            <div className={styles["qrFrame"]}>
              <QRCodeSVG
                aria-label="Android 配对二维码"
                bgColor="#ffffff"
                fgColor="#111827"
                level="M"
                marginSize={4}
                role="img"
                size={208}
                title="Android 配对二维码"
                value={snapshot.qrPayload}
              />
            </div>
            <div className={styles["pairingInstructions"]}>
              <h3>用 Android Companion 扫描</h3>
              <p>
                在手机中打开配对入口并扫描二维码。连接成功后这里会自动更新。
              </p>
              <p className={styles["pairingExpiry"]}>
                二维码有效至
                <time dateTime={snapshot.expiresAt}>
                  {formatDateTime(snapshot.expiresAt)}
                </time>
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className={baseStyles["section"]}>
            <div className={baseStyles["capabilityRow"]}>
              <span className={baseStyles["capabilityIcon"]}>
                <Smartphone aria-hidden="true" size={17} />
              </span>
              <div>
                <h3>{snapshot.device.displayName}</h3>
                <p>
                  Android Companion · 配对于
                  {formatDateTime(snapshot.device.pairedAt)}
                </p>
              </div>
              <span
                className={baseStyles["status"]}
                data-tone={
                  snapshot.device.status.state === "online"
                    ? "positive"
                    : snapshot.device.status.state === "protocol_error"
                      ? "attention"
                      : "neutral"
                }
              >
                {statusLabels[snapshot.device.status.state]}
              </span>
            </div>
            {snapshot.device.status.state === "protocol_error" ? (
              <div className={styles["protocolAlert"]} role="alert">
                <CircleAlert aria-hidden="true" size={16} />
                <div>
                  <strong>连接协议异常</strong>
                  <p>
                    {snapshot.device.status.message}
                    请解除配对后重新连接。
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          <div className={baseStyles["section"]}>
            <button
              aria-checked={snapshot.device.notificationsEnabled}
              className={baseStyles["wakeToggle"]}
              disabled={pending !== undefined}
              role="switch"
              type="button"
              onClick={() => void toggleNotifications(snapshot)}
            >
              <span>
                <strong>手机通知</strong>
                <small>允许 CharaMate 把已完成的消息投影到这台手机。</small>
              </span>
              <span aria-hidden="true" className={baseStyles["wakeSwitch"]} />
            </button>
            <div className={baseStyles["permissionList"]}>
              <div className={baseStyles["permissionRow"]}>
                <span className={baseStyles["permissionIcon"]}>
                  <Bell aria-hidden="true" size={15} />
                </span>
                <div>
                  <strong>Android 通知权限</strong>
                  <small>
                    {notificationPermissionDescription(
                      snapshot.device.notificationPermission,
                    )}
                  </small>
                </div>
                <span
                  className={baseStyles["status"]}
                  data-tone={
                    snapshot.device.notificationPermission === "granted"
                      ? "positive"
                      : snapshot.device.notificationPermission === "denied"
                        ? "attention"
                        : "neutral"
                  }
                >
                  {permissionLabels[snapshot.device.notificationPermission]}
                </span>
              </div>
            </div>
          </div>

          <div className={baseStyles["section"]}>
            <div className={baseStyles["sectionHeading"]}>
              <div>
                <h3>设备管理</h3>
                <p>解除后手机通知和分享会停止；之后可以重新配对。</p>
              </div>
              <button
                className={baseStyles["danger"]}
                disabled={pending !== undefined}
                type="button"
                onClick={() => void unpair(snapshot)}
              >
                <Unlink aria-hidden="true" size={13} />
                {pending === "unpair" ? "解除中…" : "解除配对"}
              </button>
            </div>
          </div>
        </>
      )}

      {liveMessage ? (
        <p
          className={baseStyles["panelFeedback"]}
          role={error ? "alert" : "status"}
        >
          {liveMessage}
        </p>
      ) : null}
    </section>
  );
}
