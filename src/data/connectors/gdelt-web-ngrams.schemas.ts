import type { JsonSchema } from "../contracts.js";

const count = { type: "integer", minimum: 0 } as const;
const nullableText = { type: ["string", "null"] } as const;

export const GDELT_WEB_NGRAMS_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/gdelt/web-ngrams-search-input.v1.json",
  type: "object",
  additionalProperties: false,
  required: ["fileTimestamp", "phrases"],
  properties: {
    fileTimestamp: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00Z$",
      description:
        "One explicit UTC minute identifying a paired NGrams/TOC file, not an article publication-time filter. Missing minutes are possible; no implicit time-window expansion or latest polling.",
      examples: ["2026-06-30T20:16:00Z"],
    },
    phrases: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      description:
        "Literal phrases, each 1–4 whitespace-separated words. Matches ignore case and repeated whitespace, use Unicode letter/number word boundaries, and otherwise preserve punctuation. No stemming, translation, DOC operators, regex, or full-text reconstruction.",
      examples: [["climate change", "disease"]],
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    match: {
      enum: ["any", "all"],
      default: "any",
      description:
        "Whether any or all phrases must occur in the same document; all may match different quadgrams. Returned matches indicate presence, not occurrence counts.",
      examples: ["any"],
    },
    languages: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      description:
        "Optional exact TOC language-code filter. Missing language metadata cannot satisfy a filter. This is not a query-translation instruction.",
      examples: [["en", "fr"]],
      items: { type: "string", pattern: "^[a-z]{2,3}$" },
    },
  },
} as const satisfies JsonSchema;

export const GDELT_WEB_NGRAMS_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.tiangong.ai/data/gdelt/web-ngrams-search-output.v1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "fileTimestamp",
    "phrases",
    "match",
    "languages",
    "records",
    "matchedDocumentCount",
    "omittedRecordCount",
    "statistics",
    "files",
    "stopReason",
  ],
  properties: {
    fileTimestamp: { type: "string" },
    phrases: { type: "array", items: { type: "string" } },
    match: { enum: ["any", "all"] },
    languages: { type: "array", items: { type: "string" } },
    matchedDocumentCount: count,
    omittedRecordCount: count,
    stopReason: { enum: ["file-complete", "invalid-source-rows", "record-limit"] },
    statistics: {
      type: "object",
      additionalProperties: false,
      required: [
        "tocRows",
        "ngramRows",
        "invalidTocRows",
        "invalidNgramRows",
        "orphanNgramRows",
        "ambiguousDocumentCount",
        "duplicateTocRows",
      ],
      properties: {
        tocRows: count,
        ngramRows: count,
        invalidTocRows: count,
        invalidNgramRows: count,
        orphanNgramRows: count,
        ambiguousDocumentCount: count,
        duplicateTocRows: count,
      },
    },
    files: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "sourceUrl", "compressedBytes", "uncompressedBytes", "responseDigest"],
        properties: {
          kind: { enum: ["toc", "ngrams"] },
          sourceUrl: { type: "string" },
          compressedBytes: count,
          uncompressedBytes: count,
          responseDigest: { type: "string" },
        },
      },
    },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "fileTimestamp",
          "documentId",
          "url",
          "title",
          "language",
          "date",
          "imageReference",
          "matchedPhrases",
        ],
        properties: {
          fileTimestamp: { type: "string" },
          documentId: count,
          url: { type: "string" },
          title: nullableText,
          language: nullableText,
          date: nullableText,
          imageReference: {
            ...nullableText,
            description:
              "Unvalidated provider image-reference text, preserved verbatim; it may not be a usable URL. Never fetched or rendered by this operation.",
          },
          matchedPhrases: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
  },
} as const satisfies JsonSchema;
