import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { canonicalJson, isObject, sha256Text, workspacePaths } from "./storage.js";
import type { OutputRecord } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
export const RESULT_CORE_FILES = [
  "analysis.json",
  "report.md",
  "claim-evidence-graph.json",
  "content-snapshot.json",
  "inference-snapshot.json",
  "evidence-snapshot.json",
] as const;

export interface AnalysisLineage {
  projectId: string;
  analysisRunId: string;
  analysisSha256: string;
  claimEvidenceGraphSha256: string;
  reportSha256: string;
}
export interface MaterialResultFile {
  role: string;
  sha256: string;
  analysisSha256: string;
}
export interface PublicationResultLineage extends AnalysisLineage {
  schemaVersion: 1;
  files: MaterialResultFile[];
}

export function lineageError(code: string, message: string, details?: Record<string, unknown>) {
  return new CliError(message, { code, exitCode: 3, ...(details ? { details } : {}) });
}

export function publicationResultLineageSchema(): Record<string, unknown> {
  const hash = { type: "string", pattern: HASH.source };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "projectId",
      "analysisRunId",
      "analysisSha256",
      "claimEvidenceGraphSha256",
      "reportSha256",
      "files",
    ],
    properties: {
      schemaVersion: { const: 1 },
      projectId: { type: "string", minLength: 1 },
      analysisRunId: { type: "string", minLength: 1 },
      analysisSha256: hash,
      claimEvidenceGraphSha256: hash,
      reportSha256: hash,
      files: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "sha256", "analysisSha256"],
          properties: {
            role: { type: "string", minLength: 1 },
            sha256: hash,
            analysisSha256: hash,
          },
        },
      },
    },
  };
}

/** Bind the already closed/reviewed core, without a new authority ledger. */
export async function closedAnalysisLineage(input: {
  root: string;
  projectId: string;
  closure: Record<string, unknown>;
  analysis: Record<string, unknown>;
  records: Record<string, OutputRecord>;
}): Promise<AnalysisLineage> {
  const assertRecord = (records: unknown, name: string, source: string) => {
    const path = `outputs/${name}`;
    const matches = Array.isArray(records)
      ? records.filter((record) => isObject(record) && record.path === path)
      : [];
    const expected = matches.length === 1 ? matches[0] : null;
    const actual = input.records[name];
    if (
      !isObject(expected) ||
      !actual ||
      expected.sha256 !== actual.sha256 ||
      expected.bytes !== actual.bytes
    ) {
      throw lineageError(
        "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
        "Publication requires the exact analysis and material core from its closed review; rebuild the affected base outputs before freezing.",
        {
          object: path,
          binding: source,
          expectedSha256: isObject(expected) ? (expected.sha256 ?? null) : null,
          currentSha256: actual?.sha256 ?? null,
        },
      );
    }
  };
  for (const name of ["analysis.json", "report.md"])
    assertRecord(input.closure.artifacts, name, "base-closure");
  const binding = input.closure.reviewPacket;
  if (
    !isObject(binding) ||
    typeof binding.packetSha256 !== "string" ||
    !HASH.test(binding.packetSha256)
  ) {
    throw lineageError(
      "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      "The base closure has no verifiable reviewed result binding.",
      { object: "closure.reviewPacket" },
    );
  }
  const { loadVerifiedReviewPacket } = await import("./runtime.js");
  const verified = await loadVerifiedReviewPacket(
    input.root,
    input.projectId,
    binding.packetSha256,
  );
  if (
    binding.path !== verified.path ||
    binding.sha256 !== verified.sha256 ||
    binding.bytes !== verified.bytes
  ) {
    throw lineageError(
      "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      "The closure's reviewed packet changed.",
      {
        object: "closure.reviewPacket",
        expectedSha256: binding.sha256 ?? null,
        currentSha256: verified.sha256,
      },
    );
  }
  const bytes = await readFile(
    join(workspacePaths(input.root).projects, input.projectId, verified.path),
    "utf8",
  );
  if (sha256Text(bytes) !== verified.sha256)
    throw lineageError(
      "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      "The reviewed packet changed during inspection.",
      { object: verified.path },
    );
  const packet = JSON.parse(bytes) as Record<string, unknown>;
  for (const name of RESULT_CORE_FILES) assertRecord(packet.artifacts, name, "review-packet");
  const run = input.analysis.analysisRun;
  if (!isObject(run) || typeof run.id !== "string" || !run.id)
    throw lineageError(
      "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
      "The closed analysis has no run identity.",
      { object: "analysis.analysisRun.id" },
    );
  return {
    projectId: input.projectId,
    analysisRunId: run.id,
    analysisSha256: input.records["analysis.json"]!.sha256,
    claimEvidenceGraphSha256: input.records["claim-evidence-graph.json"]!.sha256,
    reportSha256: input.records["report.md"]!.sha256,
  };
}

export function analysisGenerationId(base: AnalysisLineage): string {
  return sha256Text(canonicalJson(base));
}

export function verifyMaterialResultLineage(
  value: unknown,
  base: AnalysisLineage,
  files: Array<{ role: string; sha256: string }>,
): PublicationResultLineage {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw lineageError(
      "RESEARCH_PUBLICATION_RESULT_LINEAGE_REQUIRED",
      "Provide resultLineage in the submission manifest, recorded from the closed analysis when producing the material files. Inspect research publication lineage and its schema; do not relabel stale results.",
    );
  }
  const allowed = new Set(["schemaVersion", "files", ...Object.keys(base)]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw lineageError(
      "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      "The material result manifest has unknown fields.",
    );
  for (const [key, expected] of Object.entries(base)) {
    if (value[key] !== expected)
      throw lineageError(
        "RESEARCH_PUBLICATION_ANALYSIS_BINDING_STALE",
        "The prepared material results belong to a different closed analysis generation.",
        {
          object: key,
          expected,
          supplied: value[key] ?? null,
          currentAnalysisGenerationId: analysisGenerationId(base),
        },
      );
  }
  const expected = new Map(files.map((file) => [file.role, file.sha256]));
  const seen = new Set<string>();
  for (const file of value.files) {
    if (
      !isObject(file) ||
      typeof file.role !== "string" ||
      typeof file.sha256 !== "string" ||
      !HASH.test(file.sha256) ||
      Object.keys(file).some((key) => !["role", "sha256", "analysisSha256"].includes(key)) ||
      seen.has(file.role) ||
      expected.get(file.role) !== file.sha256 ||
      file.analysisSha256 !== base.analysisSha256
    ) {
      throw lineageError(
        "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
        "Every material file must match its prepared bytes and the same closed analysis.",
        {
          object: isObject(file) ? (file.role ?? null) : null,
          expectedSha256:
            isObject(file) && typeof file.role === "string"
              ? (expected.get(file.role) ?? null)
              : null,
          expectedAnalysisSha256: base.analysisSha256,
        },
      );
    }
    seen.add(file.role);
  }
  const missing = files.filter((file) => !seen.has(file.role)).map((file) => file.role);
  if (missing.length)
    throw lineageError(
      "RESEARCH_PUBLICATION_RESULT_LINEAGE_MISMATCH",
      "The material result manifest omits frozen files.",
      { missingRoles: missing },
    );
  return {
    schemaVersion: 1,
    ...base,
    files: files
      .map((file) => ({ ...file, analysisSha256: base.analysisSha256 }))
      .sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0)),
  };
}
