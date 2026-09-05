import type { DataMissingRange, DataRunResult } from "../../data/contracts.js";
import { canonicalJson } from "./storage.js";

export type ResearchDataResultShape = "artifact" | "record-list" | "structured" | "timeseries";

export type ResearchDataContextStrategy =
  | "artifact-manifest"
  | "full"
  | "metadata-only"
  | "record-groups"
  | "record-prefix"
  | "structured-prefix"
  | "timeseries-chunks";

export interface ResearchDataCoverage {
  status: "bounded" | "complete" | "partial";
  truncated: boolean;
  stopReason: string | null;
  recordCount: number;
  missing: DataMissingRange[];
}

export interface ResearchDataProviderCoverage {
  status: "complete" | "partial";
  missing: DataMissingRange[];
}

export interface ResearchDataLimitCoverage {
  status: "bounded" | "within-requested-limits";
  limitsHit: string[];
}

export interface ResearchDataContextView {
  status: "full" | "metadata-only" | "projected";
  strategy: ResearchDataContextStrategy;
  collection: string | null;
  itemCount: number;
  totalItems: number;
  offset: number;
  remainingItems: number;
  nextCursor: string | null;
  maxItems: number;
  maxBytes: number;
}

export interface ResearchDataCommunication {
  validation: {
    status: "issues" | "valid";
    issueCodes: string[];
  };
  providerCoverage: ResearchDataProviderCoverage;
  limitCoverage: ResearchDataLimitCoverage;
  requestCoverage: ResearchDataCoverage;
  contextView: ResearchDataContextView;
}

export interface BoundedResearchDataContext {
  bytes: Uint8Array;
  projected: boolean;
  itemCount: number;
  totalItems: number;
  offset: number;
  remainingItems: number;
  nextOffset: number | null;
  strategy: ResearchDataContextStrategy;
  collection: string | null;
  status: ResearchDataContextView["status"];
}

interface DataProjection {
  value: unknown;
  itemCount: number;
  collection: string;
  strategy: Exclude<ResearchDataContextStrategy, "full" | "metadata-only">;
}

interface DataCollectionSelection {
  key: string;
  itemCount: number;
}

export function inferResearchDataResultShape(
  outputSchema: Record<string, unknown>,
  artifactOutput: boolean,
): ResearchDataResultShape {
  if (artifactOutput) return "artifact";
  const properties = objectValue(outputSchema.properties);
  if (properties && "locations" in properties) return "timeseries";
  if (properties && "records" in properties) return "record-list";
  return "structured";
}

export function boundedResearchDataContext(
  result: DataRunResult,
  maxBytes: number,
  maxItems: number,
  offset = 0,
): BoundedResearchDataContext {
  const selectedCollection = selectDataCollection(result.data);
  const totalItems = selectedCollection?.itemCount ?? result.summary.recordCount;
  const full = encode(result);
  if (offset === 0 && full.byteLength <= maxBytes && totalItems <= maxItems) {
    return {
      bytes: full,
      projected: false,
      itemCount: totalItems,
      totalItems,
      offset: 0,
      remainingItems: 0,
      nextOffset: null,
      strategy: "full",
      collection: selectedCollection?.key ?? null,
      status: "full",
    };
  }

  let lower = 0;
  let upper = Math.min(maxItems, Math.max(0, totalItems - offset));
  let best:
    | { bytes: Uint8Array; itemCount: number; strategy: DataProjection["strategy"] }
    | undefined;
  while (lower <= upper) {
    const candidate = Math.floor((lower + upper) / 2);
    const projection = projectData(result.data, candidate, offset, selectedCollection);
    if (!projection) break;
    const nextOffset = Math.min(totalItems, offset + projection.itemCount);
    const bytes = encode(
      projectedResult(
        result,
        projection,
        totalItems,
        projection.collection,
        offset,
        nextOffset < totalItems ? nextOffset : null,
      ),
    );
    if (bytes.byteLength <= maxBytes) {
      best = { bytes, itemCount: projection.itemCount, strategy: projection.strategy };
      lower = candidate + 1;
    } else {
      upper = candidate - 1;
    }
  }
  if (best && best.itemCount > 0) {
    const nextOffset = Math.min(totalItems, offset + best.itemCount);
    return {
      ...best,
      projected: true,
      totalItems,
      collection: selectedCollection?.key ?? null,
      offset,
      remainingItems: Math.max(0, totalItems - nextOffset),
      nextOffset: nextOffset < totalItems ? nextOffset : null,
      status: "projected",
    };
  }

  const metadata = encode(
    metadataOnlyResult(result, totalItems, selectedCollection?.key ?? null, offset),
  );
  if (metadata.byteLength > maxBytes) {
    throw new Error("Data evidence metadata exceeds the Research bounded-context ceiling.");
  }
  return {
    bytes: metadata,
    projected: true,
    itemCount: 0,
    totalItems,
    collection: selectedCollection?.key ?? null,
    offset,
    remainingItems: Math.max(0, totalItems - offset),
    nextOffset: null,
    strategy: "metadata-only",
    status: "metadata-only",
  };
}

export function buildResearchDataCommunication(
  result: DataRunResult,
  context: BoundedResearchDataContext,
  limits: { maxBytes: number; maxItems: number },
  cursorForOffset: (offset: number) => string = (offset) => String(offset),
): ResearchDataCommunication {
  const issueCodes = collectIssueCodes(result);
  const providerStatus = result.summary.completeness === "partial" ? "partial" : "complete";
  const limitsHit = result.summary.truncated ? limitReasons(result.data) : [];
  const coverageStatus =
    result.summary.completeness === "partial"
      ? "partial"
      : result.summary.truncated
        ? "bounded"
        : "complete";
  return {
    validation: {
      status: issueCodes.length === 0 && result.status === "success" ? "valid" : "issues",
      issueCodes,
    },
    providerCoverage: {
      status: providerStatus,
      missing: structuredClone(result.summary.missing ?? []),
    },
    limitCoverage: {
      status: result.summary.truncated ? "bounded" : "within-requested-limits",
      limitsHit,
    },
    requestCoverage: {
      status: coverageStatus,
      truncated: result.summary.truncated,
      stopReason: stopReason(result.data),
      recordCount: result.summary.recordCount,
      missing: structuredClone(result.summary.missing ?? []),
    },
    contextView: {
      status: context.status,
      strategy: context.strategy,
      collection: context.collection,
      itemCount: context.itemCount,
      totalItems: context.totalItems,
      offset: context.offset,
      remainingItems: context.remainingItems,
      nextCursor: context.nextOffset === null ? null : cursorForOffset(context.nextOffset),
      maxItems: limits.maxItems,
      maxBytes: limits.maxBytes,
    },
  };
}

function projectedResult(
  result: DataRunResult,
  projection: DataProjection,
  totalItems: number,
  collection: string,
  offset: number,
  nextOffset: number | null,
): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    status: result.status,
    requestId: result.requestId,
    contract: result.contract,
    summary: result.summary,
    warnings: result.warnings,
    errors: result.errors,
    receipt: result.receipt,
    data: {
      contextView: {
        projected: true,
        strategy: projection.strategy,
        collection,
        offset,
        itemCount: projection.itemCount,
        totalItems,
        remainingItems: Math.max(0, totalItems - offset - projection.itemCount),
        nextOffset,
        normalizedDataDigest: result.receipt.normalizedDataDigest,
        fullEvidenceLocatorAvailableInReceipt: true,
      },
      value: projection.value,
    },
  };
}

function metadataOnlyResult(
  result: DataRunResult,
  totalItems: number,
  collection: string | null,
  offset: number,
): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    status: result.status,
    requestId: result.requestId,
    contract: result.contract,
    summary: result.summary,
    warnings: result.warnings,
    errors: result.errors,
    receipt: result.receipt,
    data: {
      contextView: {
        projected: true,
        strategy: "metadata-only",
        collection,
        offset,
        itemCount: 0,
        totalItems,
        remainingItems: Math.max(0, totalItems - offset),
        nextOffset: null,
        normalizedDataDigest: result.receipt.normalizedDataDigest,
        fullEvidenceLocatorAvailableInReceipt: true,
      },
    },
  };
}

function projectData(
  data: unknown,
  maxItems: number,
  offset: number,
  selected: DataCollectionSelection | null,
): DataProjection | null {
  const value = objectValue(data);
  if (!value || !selected) return null;
  if (selected.key === "records" && Array.isArray(value.records)) {
    const grouped = projectRecords(value.records, maxItems, offset);
    return {
      value: { ...value, records: grouped.records },
      itemCount: grouped.records.length,
      collection: selected.key,
      strategy: grouped.grouped ? "record-groups" : "record-prefix",
    };
  }
  if (
    selected.key === "locations" &&
    Array.isArray(value.locations) &&
    value.locations.some(hasTimeAxis)
  ) {
    const projected = projectLocations(value.locations, maxItems, offset);
    return {
      value: { ...value, locations: projected.locations },
      itemCount: projected.itemCount,
      collection: selected.key,
      strategy: "timeseries-chunks",
    };
  }
  if (selected.key === "files" && Array.isArray(value.files)) {
    return {
      value: projectTopLevelCollections(value, maxItems, offset, "files"),
      itemCount: Math.min(maxItems, Math.max(0, value.files.length - offset)),
      collection: selected.key,
      strategy: "artifact-manifest",
    };
  }
  const collection = value[selected.key];
  if (Array.isArray(collection)) {
    return {
      value: {
        ...value,
        [selected.key]: collection.slice(offset, offset + maxItems),
      },
      itemCount: Math.min(maxItems, Math.max(0, collection.length - offset)),
      collection: selected.key,
      strategy: "structured-prefix",
    };
  }
  return null;
}

function projectRecords(
  records: unknown[],
  maxItems: number,
  offset: number,
): { records: unknown[]; grouped: boolean } {
  const rows = records.map(objectValue);
  if (!rows.every((row) => row && typeof row.threadId === "string")) {
    return { records: records.slice(offset, offset + maxItems), grouped: false };
  }
  const groups = new Map<string, unknown[]>();
  for (let index = 0; index < records.length; index += 1) {
    const key = String(rows[index]!.threadId);
    const group = groups.get(key) ?? [];
    group.push(records[index]);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].flatMap((group) => {
    const root = group.find((record) => objectValue(record)?.parentId === null);
    return root === undefined ? group : [root, ...group.filter((record) => record !== root)];
  });
  return { records: ordered.slice(offset, offset + maxItems), grouped: true };
}

function projectLocations(
  locations: unknown[],
  maxItems: number,
  offset: number,
): { locations: unknown[]; itemCount: number } {
  const capacities = locations.map(locationRecordCount);
  const starts = allocateAcross(capacities, offset);
  const ends = allocateAcross(capacities, offset + maxItems);
  return {
    locations: locations.map((location, index) =>
      projectLocationRange(location, starts[index] ?? 0, ends[index] ?? 0),
    ),
    itemCount: ends.reduce(
      (total, count, index) => total + Math.max(0, count - (starts[index] ?? 0)),
      0,
    ),
  };
}

function projectLocationRange(location: unknown, offset: number, end: number): unknown {
  const value = objectValue(location);
  if (!value) return location;
  const directAxis = timeAxis(value);
  if (directAxis) return sliceAlignedSeries(value, directAxis, offset, end);
  const sectionKeys = Object.keys(value).filter((key) => {
    const section = objectValue(value[key]);
    return section !== null && timeAxis(section) !== null;
  });
  if (sectionKeys.length === 0) return structuredClone(value);
  const capacities = sectionKeys.map((key) => {
    const section = objectValue(value[key])!;
    return timeAxis(section)!.values.length;
  });
  const starts = allocateAcross(capacities, offset);
  const ends = allocateAcross(capacities, end);
  const projected: Record<string, unknown> = { ...value };
  for (let index = 0; index < sectionKeys.length; index += 1) {
    const key = sectionKeys[index]!;
    const section = objectValue(value[key])!;
    projected[key] = sliceAlignedSeries(
      section,
      timeAxis(section)!,
      starts[index] ?? 0,
      ends[index] ?? 0,
    );
  }
  return projected;
}

function sliceAlignedSeries(
  value: Record<string, unknown>,
  axis: { key: string; values: unknown[] },
  offset: number,
  end: number,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...value,
    [axis.key]: axis.values.slice(offset, end),
  };
  for (const [key, candidate] of Object.entries(value)) {
    if (key === axis.key) continue;
    if (Array.isArray(candidate) && candidate.length === axis.values.length) {
      projected[key] = candidate.slice(offset, end);
      continue;
    }
    if (
      Array.isArray(candidate) &&
      candidate.every((item) => Array.isArray(objectValue(item)?.values))
    ) {
      projected[key] = candidate.map((item) => {
        const record = objectValue(item)!;
        return { ...record, values: (record.values as unknown[]).slice(offset, end) };
      });
    }
  }
  return projected;
}

function projectTopLevelCollections(
  value: Record<string, unknown>,
  maxItems: number,
  offset: number,
  primaryKey: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...value };
  for (const [key, candidate] of Object.entries(value)) {
    if (!Array.isArray(candidate)) continue;
    const count = key === primaryKey ? maxItems : Math.min(maxItems, 20);
    projected[key] = candidate.slice(offset, offset + count);
  }
  return projected;
}

function allocateAcross(capacities: number[], requested: number): number[] {
  const allocations = new Array<number>(capacities.length).fill(0);
  let remaining = Math.max(0, requested);
  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < capacities.length && remaining > 0; index += 1) {
      if (allocations[index]! >= capacities[index]!) continue;
      allocations[index]! += 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  return allocations;
}

function locationRecordCount(location: unknown): number {
  const value = objectValue(location);
  if (!value) return 0;
  const direct = timeAxis(value);
  if (direct) return direct.values.length;
  return Object.values(value).reduce<number>((total, section) => {
    const sectionValue = objectValue(section);
    return total + (sectionValue ? (timeAxis(sectionValue)?.values.length ?? 0) : 0);
  }, 0);
}

function hasTimeAxis(location: unknown): boolean {
  return locationRecordCount(location) > 0;
}

function timeAxis(value: Record<string, unknown>): { key: string; values: unknown[] } | null {
  for (const key of ["timesUtc", "dates", "time"]) {
    if (Array.isArray(value[key])) return { key, values: value[key] };
  }
  return null;
}

function largestTopLevelArray(
  value: Record<string, unknown>,
): { key: string; values: unknown[] } | null {
  let selected: { key: string; values: unknown[] } | null = null;
  for (const [key, candidate] of Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    if (!Array.isArray(candidate)) continue;
    if (!selected || candidate.length > selected.values.length)
      selected = { key, values: candidate };
  }
  return selected;
}

function selectDataCollection(data: unknown): DataCollectionSelection | null {
  const value = objectValue(data);
  if (!value) return null;
  if (Array.isArray(value.records) && value.records.length > 0) {
    return { key: "records", itemCount: value.records.length };
  }
  if (Array.isArray(value.locations)) {
    const itemCount = value.locations.reduce(
      (total, location) => total + locationRecordCount(location),
      0,
    );
    if (itemCount > 0) return { key: "locations", itemCount };
  }
  if (Array.isArray(value.files) && value.files.length > 0) {
    return { key: "files", itemCount: value.files.length };
  }
  const nonEmpty = largestTopLevelArray(value);
  if (nonEmpty && nonEmpty.values.length > 0) {
    return { key: nonEmpty.key, itemCount: nonEmpty.values.length };
  }
  if (Array.isArray(value.records)) return { key: "records", itemCount: 0 };
  if (Array.isArray(value.locations)) return { key: "locations", itemCount: 0 };
  if (Array.isArray(value.files)) return { key: "files", itemCount: 0 };
  return nonEmpty ? { key: nonEmpty.key, itemCount: nonEmpty.values.length } : null;
}

function collectIssueCodes(result: DataRunResult): string[] {
  const codes = new Set<string>(result.errors.map((error) => error.code));
  const data = objectValue(result.data);
  const validation = data ? objectValue(data.validation) : null;
  if (validation && Array.isArray(validation.issues)) {
    for (const issue of validation.issues) {
      const code = objectValue(issue)?.code;
      if (typeof code === "string" && code.length > 0) codes.add(code);
    }
  }
  return [...codes].sort();
}

function stopReason(data: unknown): string | null {
  const value = objectValue(data)?.stopReason;
  return typeof value === "string" ? value : null;
}

function limitReasons(data: unknown): string[] {
  const reason = stopReason(data);
  return reason?.startsWith("max-") ? [reason] : ["runtime-limit"];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
