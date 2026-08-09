import { powerMonitor } from "electron";

export type ActivitySystemBoundary = "active" | "inactive";

export interface ActivitySystemSource {
  isIdle(): boolean;
  subscribe(listener: (boundary: ActivitySystemBoundary) => void): () => void;
}

export class ElectronActivitySystemSource implements ActivitySystemSource {
  constructor(private readonly idleThresholdSeconds: number) {}

  isIdle(): boolean {
    const state = powerMonitor.getSystemIdleState(this.idleThresholdSeconds);
    return state === "idle" || state === "locked";
  }

  subscribe(listener: (boundary: ActivitySystemBoundary) => void): () => void {
    const inactive = () => listener("inactive");
    const active = () => listener("active");
    powerMonitor.on("lock-screen", inactive);
    powerMonitor.on("suspend", inactive);
    powerMonitor.on("unlock-screen", active);
    powerMonitor.on("resume", active);
    return () => {
      powerMonitor.off("lock-screen", inactive);
      powerMonitor.off("suspend", inactive);
      powerMonitor.off("unlock-screen", active);
      powerMonitor.off("resume", active);
    };
  }
}
