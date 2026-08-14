export interface SingleInstanceApplication {
  on(
    event: "second-instance",
    listener: (
      event: unknown,
      argv: string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void,
  ): unknown;
  quit(): void;
  requestSingleInstanceLock(): boolean;
}

export function initializeSingleInstance(
  application: SingleInstanceApplication,
  activatePrimary: () => void,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }

  application.on("second-instance", () => activatePrimary());
  return true;
}
