import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { VoiceWakeSnapshot } from "../../shared/contracts/voiceWake";
import type { Clock } from "../../shared/pure/clock";
import type { SettingsRepository } from "../app/settingsRepository";
import {
  VoiceWakeService,
  type VoiceWakePowerEvents,
} from "./voiceWakeService";

function createFixture(
  permission: VoiceWakeSnapshot["microphone"] = "granted",
) {
  let enabled = false;
  let permissionState = permission;
  const saveVoiceWakeEnabled = vi.fn((value: boolean) => {
    enabled = value;
    return value;
  });
  const request = vi.fn(() => {
    permissionState = "granted";
    return Promise.resolve(true);
  });
  const snapshot = vi.fn();
  const service = new VoiceWakeService(
    {
      getVoiceWakeEnabled: () => enabled,
      saveVoiceWakeEnabled,
    } as unknown as SettingsRepository,
    { read: () => permissionState, request },
    { now: () => "2026-08-25T07:00:00.000Z" } satisfies Clock,
    { snapshot },
  );
  return { request, saveVoiceWakeEnabled, service, snapshot };
}

describe("VoiceWakeService", () => {
  it("persists an off-by-default setting and requests microphone access once", async () => {
    const fixture = createFixture("not_determined");

    expect(fixture.service.getSnapshot()).toMatchObject({
      enabled: false,
      phase: "disabled",
    });
    await expect(fixture.service.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      microphone: "granted",
      phase: "arming",
      phrase: "Hi Mika",
    });
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(fixture.saveVoiceWakeEnabled).toHaveBeenCalledWith(
      true,
      "2026-08-25T07:00:00.000Z",
    );

    await fixture.service.setEnabled(true);
    expect(fixture.request).toHaveBeenCalledOnce();
    expect(fixture.saveVoiceWakeEnabled).toHaveBeenCalledOnce();
  });

  it("does not persist an enabled state when microphone permission is denied", async () => {
    const fixture = createFixture("denied");

    await expect(fixture.service.setEnabled(true)).rejects.toThrow(
      /允许 CharaMate 使用麦克风/u,
    );
    expect(fixture.saveVoiceWakeEnabled).not.toHaveBeenCalled();
    expect(fixture.service.getSnapshot().phase).toBe("disabled");
  });

  it("projects system suspension, active Voice and renderer reports through one snapshot", async () => {
    const fixture = createFixture();
    const powerEvents = new EventEmitter() as VoiceWakePowerEvents &
      EventEmitter;
    fixture.service.initialize(powerEvents);
    await fixture.service.setEnabled(true);

    expect(fixture.service.report({ phase: "listening" }).phase).toBe(
      "listening",
    );
    fixture.service.setVoiceActive(true);
    expect(fixture.service.getSnapshot().phase).toBe("voice_active");
    powerEvents.emit("suspend");
    expect(fixture.service.getSnapshot().phase).toBe("suspended");
    powerEvents.emit("resume");
    expect(fixture.service.getSnapshot().phase).toBe("voice_active");
    fixture.service.setVoiceActive(false);
    expect(fixture.service.getSnapshot().phase).toBe("listening");

    expect(
      fixture.service.report({ error: "   ", phase: "error" }),
    ).toMatchObject({
      error: "本地语音唤醒暂时不可用。",
      phase: "error",
    });
    expect(fixture.snapshot).toHaveBeenCalled();

    fixture.service.shutdown();
    powerEvents.emit("suspend");
    expect(fixture.service.getSnapshot().phase).toBe("error");
  });
});
