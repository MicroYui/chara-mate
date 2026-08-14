import type {
  TerritoryWorldChangeSet,
  TerritoryWorldState,
} from "../contracts/territoryWorld";

function replaceById<T extends { readonly id: string }>(
  values: readonly T[],
  value: T,
): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
}

function replaceRevision<
  T extends { readonly id: string; readonly revision: number },
>(values: readonly T[], value: T): T[] {
  const index = values.findIndex(
    (candidate) =>
      candidate.id === value.id && candidate.revision === value.revision,
  );
  if (index < 0) return [...values, value];
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate,
  );
}

export function applyTerritoryWorldChangeSet(
  current: TerritoryWorldState,
  changeSet: TerritoryWorldChangeSet,
): TerritoryWorldState {
  const next = structuredClone(current);
  for (const mutation of changeSet.mutations) {
    switch (mutation.kind) {
      case "active-zone.set":
        next.activeZoneId = mutation.zoneId;
        break;
      case "zone.put":
        next.zones = replaceById(next.zones, mutation.zone);
        break;
      case "zone.remove":
        next.zones = next.zones.filter((zone) => zone.id !== mutation.zoneId);
        next.connections = next.connections.filter(
          (connection) =>
            connection.fromZoneId !== mutation.zoneId &&
            connection.toZoneId !== mutation.zoneId,
        );
        break;
      case "connection.put":
        next.connections = replaceById(next.connections, mutation.connection);
        break;
      case "connection.remove":
        next.connections = next.connections.filter(
          (connection) => connection.id !== mutation.connectionId,
        );
        break;
      case "style.put":
        next.styles = replaceRevision(next.styles, mutation.style);
        break;
      case "asset-pack.put":
        break;
      case "definition.put":
        break;
      case "instance.put":
        next.instances = replaceById(next.instances, mutation.instance);
        break;
      case "instance.remove":
        next.instances = next.instances.filter(
          (instance) => instance.id !== mutation.instanceId,
        );
        next.groups = next.groups
          .map((group) => ({
            ...group,
            instanceIds: group.instanceIds.filter(
              (instanceId) => instanceId !== mutation.instanceId,
            ),
          }))
          .filter((group) => group.instanceIds.length >= 2);
        break;
      case "group.put":
        next.groups = replaceById(next.groups, mutation.group);
        break;
      case "group.remove":
        next.groups = next.groups.filter(
          (group) => group.id !== mutation.groupId,
        );
        break;
    }
  }
  return next;
}
