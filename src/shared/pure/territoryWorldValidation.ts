import type {
  TerritoryChangeCandidate,
  TerritoryDefinition,
  TerritoryInstance,
  TerritoryWorldChangeSet,
  TerritoryWorldSnapshot,
  TerritoryZone,
  TerritoryZoneView,
} from "../contracts/territoryWorld";

export interface TerritoryWorldValidationIssue {
  readonly code:
    | "ATTACHMENT_CYCLE"
    | "CANDIDATE_STATE"
    | "DUPLICATE_ID"
    | "GROUP_INVALID"
    | "IMMUTABLE_DEFINITION"
    | "INVALID_LIFECYCLE"
    | "INVALID_PLACEMENT"
    | "LOCKED_CONTENT_CHANGED"
    | "MISSING_REFERENCE"
    | "REVISION_CONFLICT"
    | "SOURCE_IDENTITY_CONFLICT";
  readonly message: string;
  readonly path: string;
}

type IssueCode = TerritoryWorldValidationIssue["code"];

function addIssue(
  issues: TerritoryWorldValidationIssue[],
  code: IssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, message, path });
}

function definitionKey(definition: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${definition.id}@${String(definition.revision)}`;
}

function profileKey(profile: {
  readonly id: string;
  readonly revision: number;
}): string {
  return `${profile.id}@${String(profile.revision)}`;
}

function uniqueValues<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  path: string,
  issues: TerritoryWorldValidationIssue[],
): Map<string, T> {
  const result = new Map<string, T>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    if (result.has(key)) {
      addIssue(
        issues,
        "DUPLICATE_ID",
        `${path}[${String(index)}]`,
        `标识 ${key} 重复。`,
      );
      return;
    }
    result.set(key, value);
  });
  return result;
}

function isPointInZone(
  point: { readonly x: number; readonly y: number },
  zone: TerritoryZone,
): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < zone.bounds.width &&
    point.y < zone.bounds.height
  );
}

function validateDefinition(
  definition: TerritoryDefinition,
  path: string,
  issues: TerritoryWorldValidationIssue[],
): void {
  const requiredMode =
    definition.layer === "terrain"
      ? "tile"
      : definition.layer === "attachment"
        ? "attachment"
        : definition.layer === "foreground" || definition.layer === "effect"
          ? "free"
          : definition.layer === "object"
            ? "grid"
            : null;
  if (requiredMode && definition.placement.mode !== requiredMode) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      `${path}.placement`,
      `${definition.layer} 定义必须使用 ${requiredMode} 放置规则。`,
    );
  }
  if (
    (definition.layer === "underlay" || definition.layer === "structure") &&
    definition.placement.mode !== "tile" &&
    definition.placement.mode !== "grid"
  ) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      `${path}.placement`,
      `${definition.layer} 定义只能使用 tile 或 grid 放置规则。`,
    );
  }

  const allowedDepthModes =
    definition.layer === "terrain" || definition.layer === "underlay"
      ? (["flat"] as const)
      : definition.layer === "object" || definition.layer === "attachment"
        ? (["sorted"] as const)
        : definition.layer === "foreground"
          ? (["overlay"] as const)
          : definition.layer === "effect"
            ? (["flat", "overlay"] as const)
            : (["flat", "sorted"] as const);
  if (!allowedDepthModes.includes(definition.visual.depthMode as never)) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      `${path}.visual.depthMode`,
      `${definition.layer} 定义不能使用 ${definition.visual.depthMode} 深度模式。`,
    );
  }

  uniqueValues(
    definition.anchors,
    (anchor) => anchor.id,
    `${path}.anchors`,
    issues,
  );
  if (definition.placement.mode === "grid") {
    const footprint = new Set(
      definition.placement.footprintCells.map(
        (cell) => `${String(cell.x)},${String(cell.y)}`,
      ),
    );
    definition.placement.collisionCells.forEach((cell, index) => {
      if (!footprint.has(`${String(cell.x)},${String(cell.y)}`)) {
        addIssue(
          issues,
          "INVALID_PLACEMENT",
          `${path}.placement.collisionCells[${String(index)}]`,
          "碰撞格必须位于占地范围内。",
        );
      }
    });
  }
}

function validateLifecycle(
  instance: TerritoryInstance,
  path: string,
  issues: TerritoryWorldValidationIssue[],
): void {
  if (
    (instance.status === "active" && instance.trashedAt !== null) ||
    (instance.status === "trashed" && instance.trashedAt === null)
  ) {
    addIssue(
      issues,
      "INVALID_LIFECYCLE",
      path,
      "物件状态与 trashedAt 不一致。",
    );
  }
}

function validateCandidate(
  candidate: TerritoryChangeCandidate,
  snapshot: TerritoryWorldSnapshot,
  path: string,
  issues: TerritoryWorldValidationIssue[],
): void {
  const revisionIds = new Set(
    snapshot.revisions.map((revision) => revision.id),
  );
  if (!revisionIds.has(candidate.baseRevisionId)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      `${path}.baseRevisionId`,
      "候选引用了不存在的基础 World Revision。",
    );
  }
  if (
    candidate.status === "ready" &&
    candidate.baseRevisionId !== snapshot.world.currentRevision.id
  ) {
    addIssue(
      issues,
      "REVISION_CONFLICT",
      `${path}.baseRevisionId`,
      "候选基础版本已落后，必须标记为 stale 并重新预览。",
    );
  }
  if (
    candidate.status === "ready" &&
    (candidate.changeSet === null || candidate.error !== null)
  ) {
    addIssue(
      issues,
      "CANDIDATE_STATE",
      path,
      "ready 候选必须有 change set 且没有错误。",
    );
  }
  if (candidate.status === "failed" && candidate.error === null) {
    addIssue(
      issues,
      "CANDIDATE_STATE",
      `${path}.error`,
      "failed 候选必须保存错误。",
    );
  }
  if (candidate.status === "applied" && candidate.appliedRevisionId === null) {
    addIssue(
      issues,
      "CANDIDATE_STATE",
      `${path}.appliedRevisionId`,
      "applied 候选必须引用已提交 Revision。",
    );
  }
  if (candidate.changeSet) {
    if (candidate.changeSet.baseRevisionId !== candidate.baseRevisionId) {
      addIssue(
        issues,
        "REVISION_CONFLICT",
        `${path}.changeSet.baseRevisionId`,
        "候选与 change set 的基础 Revision 不一致。",
      );
    }
    const lockedIds = new Set(candidate.lockedInstanceIds);
    candidate.changeSet.mutations.forEach((mutation, index) => {
      const instanceId =
        mutation.kind === "instance.put"
          ? mutation.instance.id
          : mutation.kind === "instance.remove"
            ? mutation.instanceId
            : null;
      if (instanceId && lockedIds.has(instanceId)) {
        addIssue(
          issues,
          "LOCKED_CONTENT_CHANGED",
          `${path}.changeSet.mutations[${String(index)}]`,
          "候选不能修改用户锁定的物件。",
        );
      }
    });
  }

  const zoneIds = new Set(snapshot.world.zones.map((zone) => zone.id));
  const scopeZoneId =
    candidate.scope.kind === "zone" ||
    candidate.scope.kind === "selection" ||
    candidate.scope.kind === "entities"
      ? candidate.scope.zoneId
      : candidate.scope.kind === "expansion"
        ? candidate.scope.fromZoneId
        : null;
  if (scopeZoneId && !zoneIds.has(scopeZoneId)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      `${path}.scope`,
      "候选作用域引用了不存在的 Zone。",
    );
  }
}

export function validateTerritoryWorldSnapshot(
  snapshot: TerritoryWorldSnapshot,
): TerritoryWorldValidationIssue[] {
  const issues: TerritoryWorldValidationIssue[] = [];
  const revisions = uniqueValues(
    snapshot.revisions,
    (revision) => revision.id,
    "revisions",
    issues,
  );
  if (!revisions.has(snapshot.world.currentRevision.id)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "world.currentRevision",
      "当前 World Revision 不在历史列表中。",
    );
  }
  uniqueValues(
    snapshot.revisions,
    (revision) => String(revision.sequence),
    "revisions",
    issues,
  );
  snapshot.revisions.forEach((revision, index) => {
    if (
      revision.parentRevisionId !== null &&
      !revisions.has(revision.parentRevisionId)
    ) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `revisions[${String(index)}].parentRevisionId`,
        "Revision 的父版本不存在。",
      );
    }
  });

  const zones = uniqueValues(
    snapshot.world.zones,
    (zone) => zone.id,
    "world.zones",
    issues,
  );
  const activeZone = zones.get(snapshot.world.activeZoneId);
  if (!activeZone || activeZone.status !== "active") {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "world.activeZoneId",
      "活动 Zone 不存在或已进入回收站。",
    );
  }

  const styles = uniqueValues(snapshot.styles, profileKey, "styles", issues);
  snapshot.world.zones.forEach((zone, index) => {
    if (!styles.has(profileKey(zone.styleProfile))) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `world.zones[${String(index)}].styleProfile`,
        "Zone 引用了不存在的 Style Profile Revision。",
      );
    }
    if (
      (zone.status === "active" && zone.trashedAt !== null) ||
      (zone.status === "trashed" && zone.trashedAt === null)
    ) {
      addIssue(
        issues,
        "INVALID_LIFECYCLE",
        `world.zones[${String(index)}]`,
        "Zone 状态与 trashedAt 不一致。",
      );
    }
  });

  snapshot.world.connections.forEach((connection, index) => {
    if (!zones.has(connection.fromZoneId) || !zones.has(connection.toZoneId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `world.connections[${String(index)}]`,
        "Zone 连接引用了不存在的端点。",
      );
    }
    if (connection.fromZoneId === connection.toZoneId) {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `world.connections[${String(index)}]`,
        "Zone 连接不能指向自身。",
      );
    }
  });

  const assets = uniqueValues(
    snapshot.assets,
    (asset) => asset.id,
    "assets",
    issues,
  );
  uniqueValues(snapshot.assetPacks, definitionKey, "assetPacks", issues);
  snapshot.assetPacks.forEach((pack, packIndex) => {
    if (!styles.has(profileKey(pack.styleProfile))) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `assetPacks[${String(packIndex)}].styleProfile`,
        "Asset Pack 引用了不存在的 Style Profile Revision。",
      );
    }
    pack.assets.forEach((entry, entryIndex) => {
      if (!assets.has(entry.assetId)) {
        addIssue(
          issues,
          "MISSING_REFERENCE",
          `assetPacks[${String(packIndex)}].assets[${String(entryIndex)}]`,
          "Asset Pack 引用了不存在的图片资产。",
        );
      }
    });
  });

  const definitions = uniqueValues(
    snapshot.definitions,
    definitionKey,
    "definitions",
    issues,
  );
  snapshot.definitions.forEach((definition, index) => {
    validateDefinition(definition, `definitions[${String(index)}]`, issues);
    if (!assets.has(definition.visual.assetId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `definitions[${String(index)}].visual.assetId`,
        "Definition 引用了不存在的图片资产。",
      );
    }
  });

  const snapshotInstances = [...snapshot.collection, ...snapshot.trash];
  uniqueValues(
    snapshotInstances,
    (instance) => instance.id,
    "instances",
    issues,
  );
  snapshot.collection.forEach((instance, index) => {
    validateLifecycle(instance, `collection[${String(index)}]`, issues);
    if (
      instance.status !== "active" ||
      instance.placement.kind !== "collection"
    ) {
      addIssue(
        issues,
        "INVALID_LIFECYCLE",
        `collection[${String(index)}]`,
        "收藏库只能包含 active collection 物件。",
      );
    }
  });
  snapshot.trash.forEach((instance, index) => {
    validateLifecycle(instance, `trash[${String(index)}]`, issues);
    if (instance.status !== "trashed") {
      addIssue(
        issues,
        "INVALID_LIFECYCLE",
        `trash[${String(index)}]`,
        "回收站只能包含 trashed 物件。",
      );
    }
  });
  snapshotInstances.forEach((instance, index) => {
    if (!definitions.has(definitionKey(instance.definition))) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `instances[${String(index)}].definition`,
        "物件引用了不存在的 Definition Revision。",
      );
    }
  });

  if (!activeZone || snapshot.pet.zoneId !== activeZone.id) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      "pet.zoneId",
      "桌宠必须位于当前活动 Zone。",
    );
  } else if (!isPointInZone(snapshot.pet.point, activeZone)) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      "pet.point",
      "桌宠位置超出 Zone 边界。",
    );
  }

  uniqueValues(
    snapshot.candidates,
    (candidate) => candidate.id,
    "candidates",
    issues,
  );
  snapshot.candidates.forEach((candidate, index) =>
    validateCandidate(
      candidate,
      snapshot,
      `candidates[${String(index)}]`,
      issues,
    ),
  );
  return issues;
}

function validateInstanceGraph(
  instances: readonly TerritoryInstance[],
  definitions: ReadonlyMap<string, TerritoryDefinition>,
  zone: TerritoryZone,
  issues: TerritoryWorldValidationIssue[],
  pathPrefix: string,
): void {
  const instanceMap = uniqueValues(
    instances,
    (instance) => instance.id,
    pathPrefix,
    issues,
  );
  const parentByChild = new Map<string, string>();
  instances.forEach((instance, index) => {
    const path = `${pathPrefix}[${String(index)}]`;
    validateLifecycle(instance, path, issues);
    if (instance.status !== "active") {
      addIssue(
        issues,
        "INVALID_LIFECYCLE",
        path,
        "Zone view 不能包含回收站物件。",
      );
    }
    const definition = definitions.get(definitionKey(instance.definition));
    if (!definition) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${path}.definition`,
        "物件引用了不在 projection 中的 Definition Revision。",
      );
      return;
    }
    if (instance.placement.kind === "collection") {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `${path}.placement`,
        "Zone view 不能包含收藏库物件。",
      );
      return;
    }
    if (instance.placement.zoneId !== zone.id) {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `${path}.placement.zoneId`,
        "物件不属于当前 Zone。",
      );
    }
    if (
      !definition.transforms.rotations.includes(instance.placement.rotation)
    ) {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `${path}.placement.rotation`,
        "物件使用了 Definition 不支持的旋转。",
      );
    }
    if (instance.placement.flipped && !definition.transforms.flippable) {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `${path}.placement.flipped`,
        "物件使用了 Definition 不支持的翻转。",
      );
    }
    if (instance.placement.kind === "zone") {
      if (definition.placement.mode === "attachment") {
        addIssue(
          issues,
          "INVALID_PLACEMENT",
          `${path}.placement`,
          "Attachment Definition 必须附着到兼容锚点。",
        );
      }
      if (!isPointInZone(instance.placement.point, zone)) {
        addIssue(
          issues,
          "INVALID_PLACEMENT",
          `${path}.placement.point`,
          "物件位置超出 Zone 边界。",
        );
      }
      if (
        definition.placement.mode === "tile" &&
        (instance.placement.point.x % definition.placement.span.width !== 0 ||
          instance.placement.point.y % definition.placement.span.height !== 0)
      ) {
        addIssue(
          issues,
          "INVALID_PLACEMENT",
          `${path}.placement.point`,
          "Tile 物件必须对齐自身宏格跨度。",
        );
      }
      return;
    }

    const attachmentPlacement = instance.placement;
    parentByChild.set(instance.id, attachmentPlacement.parentInstanceId);
    const parent = instanceMap.get(attachmentPlacement.parentInstanceId);
    if (!parent) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${path}.placement.parentInstanceId`,
        "附件的承载物件不存在。",
      );
      return;
    }
    const parentDefinition = definitions.get(definitionKey(parent.definition));
    const anchor = parentDefinition?.anchors.find(
      (candidate) => candidate.id === attachmentPlacement.anchorId,
    );
    if (!anchor) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${path}.placement.anchorId`,
        "承载物件没有这个锚点。",
      );
      return;
    }
    if (
      definition.placement.mode !== "attachment" ||
      !definition.placement.allowedAnchors.includes(anchor.kind)
    ) {
      addIssue(
        issues,
        "INVALID_PLACEMENT",
        `${path}.placement.anchorId`,
        "附件与目标锚点类型不兼容。",
      );
    }
  });

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (instanceId: string): void => {
    if (visited.has(instanceId)) return;
    if (visiting.has(instanceId)) {
      addIssue(
        issues,
        "ATTACHMENT_CYCLE",
        pathPrefix,
        "附件承载关系形成了循环。",
      );
      return;
    }
    visiting.add(instanceId);
    const parentId = parentByChild.get(instanceId);
    if (parentId) visit(parentId);
    visiting.delete(instanceId);
    visited.add(instanceId);
  };
  for (const instance of instances) visit(instance.id);
}

export function validateTerritoryZoneView(
  view: TerritoryZoneView,
  snapshot: TerritoryWorldSnapshot,
): TerritoryWorldValidationIssue[] {
  const issues: TerritoryWorldValidationIssue[] = [];
  const snapshotZone = snapshot.world.zones.find(
    (zone) => zone.id === view.zone.id,
  );
  if (!snapshotZone) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "zone.id",
      "Zone view 引用了不存在的 Zone。",
    );
  }
  if (!snapshot.revisions.some((revision) => revision.id === view.revisionId)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "revisionId",
      "Zone view 引用了不存在的 World Revision。",
    );
  }
  if (profileKey(view.style) !== profileKey(view.zone.styleProfile)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "style",
      "Zone view 的 Style Profile 与 Zone 引用不一致。",
    );
  }

  const definitions = uniqueValues(
    view.definitions,
    definitionKey,
    "definitions",
    issues,
  );
  view.definitions.forEach((definition, index) =>
    validateDefinition(definition, `definitions[${String(index)}]`, issues),
  );
  validateInstanceGraph(
    view.instances,
    definitions,
    view.zone,
    issues,
    "instances",
  );

  const instances = new Map(
    view.instances.map((instance) => [instance.id, instance]),
  );
  uniqueValues(view.groups, (group) => group.id, "groups", issues);
  view.groups.forEach((group, groupIndex) => {
    if (group.zoneId !== view.zone.id) {
      addIssue(
        issues,
        "GROUP_INVALID",
        `groups[${String(groupIndex)}].zoneId`,
        "组合不属于当前 Zone。",
      );
    }
    group.instanceIds.forEach((instanceId, instanceIndex) => {
      const instance = instances.get(instanceId);
      if (!instance || instance.groupId !== group.id) {
        addIssue(
          issues,
          "GROUP_INVALID",
          `groups[${String(groupIndex)}].instanceIds[${String(instanceIndex)}]`,
          "组合成员不存在或没有反向引用该组合。",
        );
      }
    });
  });

  if (view.pet && view.pet.zoneId !== view.zone.id) {
    addIssue(
      issues,
      "INVALID_PLACEMENT",
      "pet.zoneId",
      "Zone view 中的桌宠属于另一个 Zone。",
    );
  }
  return issues;
}

export function validateTerritoryWorldChangeSet(
  changeSet: TerritoryWorldChangeSet,
  snapshot: TerritoryWorldSnapshot,
  views: readonly TerritoryZoneView[] = [],
): TerritoryWorldValidationIssue[] {
  const issues: TerritoryWorldValidationIssue[] = [];
  if (changeSet.baseRevisionId !== snapshot.world.currentRevision.id) {
    addIssue(
      issues,
      "REVISION_CONFLICT",
      "baseRevisionId",
      "Change set 不是基于当前 World Revision。",
    );
  }
  uniqueValues(
    changeSet.mutations,
    (mutation) => mutation.changeId,
    "mutations",
    issues,
  );

  const existingDefinitions = new Map(
    snapshot.definitions.map((definition) => [
      definitionKey(definition),
      definition,
    ]),
  );
  const latestRevisionByDefinition = new Map<string, number>();
  snapshot.definitions.forEach((definition) => {
    latestRevisionByDefinition.set(
      definition.id,
      Math.max(
        latestRevisionByDefinition.get(definition.id) ?? 0,
        definition.revision,
      ),
    );
  });
  changeSet.mutations.forEach((mutation, index) => {
    if (mutation.kind !== "definition.put") return;
    const key = definitionKey(mutation.definition);
    const latest = latestRevisionByDefinition.get(mutation.definition.id) ?? 0;
    if (
      existingDefinitions.has(key) ||
      mutation.definition.revision !== latest + 1
    ) {
      addIssue(
        issues,
        "IMMUTABLE_DEFINITION",
        `mutations[${String(index)}].definition`,
        "Definition 必须以连续的新 Revision 写入，不能覆盖既有版本。",
      );
      return;
    }
    validateDefinition(
      mutation.definition,
      `mutations[${String(index)}].definition`,
      issues,
    );
    existingDefinitions.set(key, mutation.definition);
    latestRevisionByDefinition.set(
      mutation.definition.id,
      mutation.definition.revision,
    );
  });

  const existingPacks = new Set(snapshot.assetPacks.map(definitionKey));
  const latestRevisionByPack = new Map<string, number>();
  snapshot.assetPacks.forEach((pack) => {
    latestRevisionByPack.set(
      pack.id,
      Math.max(latestRevisionByPack.get(pack.id) ?? 0, pack.revision),
    );
  });
  const assetIds = new Set(snapshot.assets.map(({ id }) => id));
  const styleIds = new Set(snapshot.styles.map(profileKey));
  changeSet.mutations.forEach((mutation, index) => {
    if (mutation.kind !== "asset-pack.put") return;
    const key = definitionKey(mutation.assetPack);
    const latest = latestRevisionByPack.get(mutation.assetPack.id) ?? 0;
    if (existingPacks.has(key) || mutation.assetPack.revision !== latest + 1) {
      addIssue(
        issues,
        "IMMUTABLE_DEFINITION",
        `mutations[${String(index)}].assetPack`,
        "Asset Pack 必须以连续的新 Revision 写入，不能覆盖既有版本。",
      );
      return;
    }
    if (!styleIds.has(profileKey(mutation.assetPack.styleProfile))) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `mutations[${String(index)}].assetPack.styleProfile`,
        "Asset Pack 引用了不存在的 Style Profile Revision。",
      );
    }
    mutation.assetPack.assets.forEach((entry, entryIndex) => {
      if (!assetIds.has(entry.assetId)) {
        addIssue(
          issues,
          "MISSING_REFERENCE",
          `mutations[${String(index)}].assetPack.assets[${String(entryIndex)}]`,
          "Asset Pack 引用了不存在的图片资产。",
        );
      }
    });
    existingPacks.add(key);
    latestRevisionByPack.set(
      mutation.assetPack.id,
      mutation.assetPack.revision,
    );
  });

  const allInstances = [
    ...snapshot.collection,
    ...snapshot.trash,
    ...views.flatMap((view) => view.instances),
  ];
  const instanceMap = new Map(
    allInstances.map((instance) => [instance.id, instance]),
  );
  changeSet.mutations.forEach((mutation, index) => {
    if (mutation.kind === "instance.remove") {
      const existing = instanceMap.get(mutation.instanceId);
      if (existing?.locked) {
        addIssue(
          issues,
          "LOCKED_CONTENT_CHANGED",
          `mutations[${String(index)}]`,
          "锁定物件不能永久删除。",
        );
      }
      instanceMap.delete(mutation.instanceId);
      return;
    }
    if (mutation.kind !== "instance.put") return;
    const existing = instanceMap.get(mutation.instance.id);
    if (existing?.locked) {
      addIssue(
        issues,
        "LOCKED_CONTENT_CHANGED",
        `mutations[${String(index)}]`,
        "锁定物件不能被 change set 改写。",
      );
    }
    if (!existingDefinitions.has(definitionKey(mutation.instance.definition))) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `mutations[${String(index)}].instance.definition`,
        "Change set 中的物件引用了不存在的 Definition Revision。",
      );
    }
    validateLifecycle(
      mutation.instance,
      `mutations[${String(index)}].instance`,
      issues,
    );
    instanceMap.set(mutation.instance.id, mutation.instance);
  });

  const sourceOwners = new Map<string, string>();
  for (const instance of instanceMap.values()) {
    for (const source of instance.sources) {
      const key = `${source.kind}:${source.id}`;
      const owner = sourceOwners.get(key);
      if (owner && owner !== instance.id) {
        addIssue(
          issues,
          "SOURCE_IDENTITY_CONFLICT",
          "mutations",
          "同一 Memory/Activity 来源不能形成多个独立物件身份。",
        );
      } else {
        sourceOwners.set(key, instance.id);
      }
    }
  }
  return issues;
}
