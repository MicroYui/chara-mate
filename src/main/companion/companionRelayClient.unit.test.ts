import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPANION_FIXTURE_IDS,
  companionDeviceRegistrationAckFixture,
  companionMailboxFetchRequestFixture,
  companionMailboxPageFixture,
  companionNotificationEnqueueReceiptFixture,
  companionNotificationEnqueueRequestFixture,
  companionPairingCreateRequestFixture,
  companionPairingGrantFixture,
  companionPairingTicketFixture,
  companionShareAckFixture,
  companionUploadAssetFixture,
} from "../../../tests/fixtures/companionContracts";
import {
  HttpsCompanionRelayClient,
  waitForCompanionRetryAfter,
} from "./companionRelayClient";
import type { CompanionRelayClientError } from "./companionRelayClient";

const ORIGIN = "https://relay.example.test";
const CREDENTIAL = "opaque-device-mailbox-credential";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("Missing JSON body");
  return JSON.parse(init.body) as unknown;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HttpsCompanionRelayClient", () => {
  it("creates a same-origin pairing ticket with a schema-validated request", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(companionPairingTicketFixture));
    const client = new HttpsCompanionRelayClient({
      fetchImplementation,
      pairingOrigin: `${ORIGIN}/ignored/base?query=ignored`,
    });

    await expect(
      client.createPairingTicket({
        desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
      }),
    ).resolves.toEqual(companionPairingTicketFixture);

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/v1/companion/pairings`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(requestBody(init)).toEqual(companionPairingCreateRequestFixture);
  });

  it("uses the one-time pairing secret only as Bearer auth while waiting", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(companionPairingGrantFixture))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpsCompanionRelayClient({ fetchImplementation });

    await expect(
      client.waitForPairingGrant({ ticket: companionPairingTicketFixture }),
    ).resolves.toEqual(companionPairingGrantFixture);
    await expect(
      client.waitForPairingGrant({ ticket: companionPairingTicketFixture }),
    ).resolves.toBeUndefined();

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(
      `${ORIGIN}/v1/companion/pairings/${COMPANION_FIXTURE_IDS.pairing}/wait`,
    );
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${companionPairingTicketFixture.pairingSecret}`,
    });
    expect(init?.body).toBeUndefined();
    if (typeof url !== "string") throw new Error("Expected a string URL");
    expect(url).not.toContain(companionPairingTicketFixture.pairingSecret);
  });

  it("fetches and acknowledges the Desktop mailbox without serializing credentials", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(companionMailboxPageFixture))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpsCompanionRelayClient({ fetchImplementation });

    await expect(
      client.fetchDesktopMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionMailboxFetchRequestFixture,
      }),
    ).resolves.toEqual(companionMailboxPageFixture);
    await expect(
      client.acknowledgeDesktopMailbox({
        ack: companionShareAckFixture,
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
      }),
    ).resolves.toBeUndefined();
    await expect(
      client.acknowledgeDesktopMailbox({
        ack: companionDeviceRegistrationAckFixture,
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
      }),
    ).resolves.toBeUndefined();

    const [fetchUrl, fetchInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(fetchUrl).toBe(`${ORIGIN}/v1/companion/mailbox/fetch`);
    expect(fetchInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(fetchInit?.headers).toMatchObject({
      Authorization: `Bearer ${CREDENTIAL}`,
    });
    expect(requestBody(fetchInit)).toEqual(companionMailboxFetchRequestFixture);

    const [ackUrl, ackInit] = fetchImplementation.mock.calls[1] ?? [];
    expect(ackUrl).toBe(`${ORIGIN}/v1/companion/mailbox/ack`);
    expect(ackInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(requestBody(ackInit)).toEqual(companionShareAckFixture);
    expect(JSON.stringify(requestBody(fetchInit))).not.toContain(CREDENTIAL);
    expect(JSON.stringify(requestBody(ackInit))).not.toContain(CREDENTIAL);
    const [, registrationAckInit] = fetchImplementation.mock.calls[2] ?? [];
    expect(requestBody(registrationAckInit)).toEqual(
      companionDeviceRegistrationAckFixture,
    );
  });

  it("enqueues one stable Android event and accepts only its Relay-owned envelope", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(companionNotificationEnqueueReceiptFixture),
      );
    const client = new HttpsCompanionRelayClient({ fetchImplementation });

    await expect(
      client.enqueueAndroidMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionNotificationEnqueueRequestFixture,
      }),
    ).resolves.toEqual(companionNotificationEnqueueReceiptFixture);

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/v1/companion/mailbox/enqueue`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${CREDENTIAL}`,
    });
    expect(requestBody(init)).toEqual(
      companionNotificationEnqueueRequestFixture,
    );
    expect(JSON.stringify(requestBody(init))).not.toContain(CREDENTIAL);
  });

  it("rejects an Android enqueue receipt that changes the stable event identity", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...companionNotificationEnqueueReceiptFixture,
        envelope: {
          ...companionNotificationEnqueueReceiptFixture.envelope,
          id: COMPANION_FIXTURE_IDS.envelopeTargets,
        },
      }),
    );
    const client = new HttpsCompanionRelayClient({ fetchImplementation });

    await expect(
      client.enqueueAndroidMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionNotificationEnqueueRequestFixture,
      }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("reads an asset body and routes device mutations through fixed paths", async () => {
    const bytes = Buffer.from("sunset-bytes");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpsCompanionRelayClient({ fetchImplementation });

    await expect(
      client.readAsset({
        asset: companionUploadAssetFixture,
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
      }),
    ).resolves.toEqual(bytes);
    await client.setNotificationsEnabled({
      credential: CREDENTIAL,
      relayOrigin: ORIGIN,
      request: {
        deviceId: COMPANION_FIXTURE_IDS.device,
        enabled: false,
        protocolVersion: 1,
      },
    });
    await client.unpairDevice({
      credential: CREDENTIAL,
      relayOrigin: ORIGIN,
      request: {
        deviceId: COMPANION_FIXTURE_IDS.device,
        protocolVersion: 1,
      },
    });

    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/v1/companion/assets/${COMPANION_FIXTURE_IDS.relayAsset}`,
      `${ORIGIN}/v1/companion/devices/${COMPANION_FIXTURE_IDS.device}/notifications`,
      `${ORIGIN}/v1/companion/devices/${COMPANION_FIXTURE_IDS.device}/unpair`,
    ]);
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: `Bearer ${CREDENTIAL}`,
        accept: "application/octet-stream",
      },
      method: "GET",
      redirect: "error",
    });
    expect(fetchImplementation.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      redirect: "error",
    });
    expect(fetchImplementation.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
  });

  it("rejects non-HTTPS origins and schema-invalid relay responses", async () => {
    const insecureFetch = vi.fn<typeof fetch>();
    const insecureClient = new HttpsCompanionRelayClient({
      fetchImplementation: insecureFetch,
      pairingOrigin: "http://relay.example.test",
    });
    await expect(
      insecureClient.createPairingTicket({
        desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
      }),
    ).rejects.toMatchObject({ kind: "protocol" });

    const credentialedClient = new HttpsCompanionRelayClient({
      fetchImplementation: insecureFetch,
      pairingOrigin: "https://user:password@relay.example.test",
    });
    await expect(
      credentialedClient.createPairingTicket({
        desktopInstanceId: COMPANION_FIXTURE_IDS.desktop,
      }),
    ).rejects.toMatchObject({ kind: "protocol" });
    expect(insecureFetch).not.toHaveBeenCalled();

    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ...companionMailboxPageFixture, v: 2 }),
      );
    const client = new HttpsCompanionRelayClient({ fetchImplementation });
    await expect(
      client.fetchDesktopMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionMailboxFetchRequestFixture,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CompanionRelayClientError>>({
        kind: "protocol",
      }),
    );
  });

  it("classifies transport and retryable HTTP failures as network errors", async () => {
    const unreachable = new HttpsCompanionRelayClient({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError("connection reset")),
    });
    await expect(
      unreachable.fetchDesktopMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionMailboxFetchRequestFixture,
      }),
    ).rejects.toMatchObject({ kind: "network", retryAfterMs: undefined });

    const busy = new HttpsCompanionRelayClient({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          headers: { "retry-after": "2" },
          status: 503,
        }),
      ),
    });
    await expect(
      busy.fetchDesktopMailbox({
        credential: CREDENTIAL,
        relayOrigin: ORIGIN,
        request: companionMailboxFetchRequestFixture,
      }),
    ).rejects.toMatchObject({
      kind: "network",
      retryAfterMs: 2_000,
      status: 503,
    });
  });

  it("parses Retry-After HTTP dates without inventing an invalid fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
    try {
      const dated = new HttpsCompanionRelayClient({
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            headers: { "retry-after": "Tue, 01 Sep 2026 08:00:30 GMT" },
            status: 429,
          }),
        ),
      });
      await expect(
        dated.fetchDesktopMailbox({
          credential: CREDENTIAL,
          relayOrigin: ORIGIN,
          request: companionMailboxFetchRequestFixture,
        }),
      ).rejects.toMatchObject({ retryAfterMs: 30_000 });

      for (const retryAfter of [
        "Tuesday, 01-Sep-26 08:00:30 GMT",
        "Tue Sep  1 08:00:30 2026",
      ]) {
        const historicalFormat = new HttpsCompanionRelayClient({
          fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(null, {
              headers: { "retry-after": retryAfter },
              status: 429,
            }),
          ),
        });
        await expect(
          historicalFormat.fetchDesktopMailbox({
            credential: CREDENTIAL,
            relayOrigin: ORIGIN,
            request: companionMailboxFetchRequestFixture,
          }),
        ).rejects.toMatchObject({ retryAfterMs: 30_000 });
      }

      const oldRfc850Year = new HttpsCompanionRelayClient({
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            headers: { "retry-after": "Thursday, 01-Sep-77 08:00:30 GMT" },
            status: 429,
          }),
        ),
      });
      await expect(
        oldRfc850Year.fetchDesktopMailbox({
          credential: CREDENTIAL,
          relayOrigin: ORIGIN,
          request: companionMailboxFetchRequestFixture,
        }),
      ).rejects.toMatchObject({ retryAfterMs: 0 });

      const invalid = new HttpsCompanionRelayClient({
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            headers: { "retry-after": "soon" },
            status: 503,
          }),
        ),
      });
      await expect(
        invalid.fetchDesktopMailbox({
          credential: CREDENTIAL,
          relayOrigin: ORIGIN,
          request: companionMailboxFetchRequestFixture,
        }),
      ).rejects.toMatchObject({ retryAfterMs: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("chunks Retry-After waits that exceed Node's maximum timer delay", async () => {
    vi.useFakeTimers();
    const maximumTimerDelayMs = 2_147_483_647;
    const waiting = waitForCompanionRetryAfter(
      maximumTimerDelayMs + 1_000,
      new AbortController().signal,
    );
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(maximumTimerDelayMs);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});
