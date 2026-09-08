import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { gdeltDocSearchConnector } from "../src/data/connectors/gdelt-doc-search.js";
import { GDELT_DOC_SEARCH_INPUT_SCHEMA } from "../src/data/connectors/gdelt-doc-search.schemas.js";
import {
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
} from "../src/data/connectors/gdelt-file-feeds.js";
import {
  GDELT_EVENTS_OUTPUT_SCHEMA,
  GDELT_FILE_FEED_INPUT_SCHEMA,
  GDELT_GKG_OUTPUT_SCHEMA,
  GDELT_MENTIONS_OUTPUT_SCHEMA,
} from "../src/data/connectors/gdelt-file-feeds.schemas.js";
import type { DataConnectorDefinition, DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";
import { assertDataConnectorConformance } from "./support/data-connector-conformance.js";

const DOC_ARTICLE_RESPONSE = {
  articles: [
    {
      url: "https://news.example.invalid/synthetic-article",
      url_mobile: "",
      title: "Synthetic climate article",
      seendate: "20260301T121500Z",
      socialimage: "https://images.example.invalid/synthetic.jpg",
      domain: "news.example.invalid",
      language: "English",
      sourcecountry: "United States",
    },
  ],
};

it("declares GDELT DOC's five-second provider request interval", () => {
  assert.equal(Reflect.get(gdeltDocSearchConnector.endpoints[0]!, "minRequestIntervalMs"), 5_000);
});

const DOC_TIMELINE_RESPONSE = {
  query_details: { title: "synthetic climate", date_resolution: "15m" },
  timeline: [
    {
      series: "Article Count",
      data: [
        { date: "20260301T120000Z", value: 2, norm: 1000 },
        { date: "20260301T121500Z", value: 3, norm: 1100 },
      ],
    },
  ],
};

const FEEDS = {
  events: {
    capabilityId: "gdelt.events",
    connector: gdeltEventsConnector,
    filename: "20260301120000.export.CSV.zip",
    columns: 61,
    row: eventRow(),
  },
  gkg: {
    capabilityId: "gdelt.gkg",
    connector: gdeltGkgConnector,
    filename: "20260301120000.gkg.csv.zip",
    columns: 27,
    row: gkgRow(),
  },
  mentions: {
    capabilityId: "gdelt.mentions",
    connector: gdeltMentionsConnector,
    filename: "20260301120000.mentions.CSV.zip",
    columns: 16,
    row: mentionsRow(),
  },
} as const;

const ZIPS = Object.fromEntries(
  Object.entries(FEEDS).map(([name, feed]) => [
    name,
    singleEntryZip(feed.filename.replace(/\.zip$/, ""), `${feed.row.join("\t")}\n`),
  ]),
) as Record<keyof typeof FEEDS, Buffer>;

function docRequest(inputOverrides: Record<string, unknown> = {}): DataRunRequest {
  const input = {
    query: '"climate change" sourcecountry:us',
    mode: "artlist",
    absoluteWindow: {
      from: "2026-03-01T00:00:00Z",
      to: "2026-03-02T00:00:00Z",
    },
    maxRecords: 25,
    sort: "datedesc",
    ...inputOverrides,
  };
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "gdelt.doc-search",
    capabilityVersion: "1.0.0",
    operationId: "search",
    operationVersion: "1.0.0",
    input: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  };
}

function feedRequest(
  capabilityId: string,
  inputOverrides: Record<string, unknown> = {},
): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId,
    capabilityVersion: "1.0.0",
    operationId: "fetch",
    operationVersion: "1.0.0",
    input: { mode: "latest", maxFiles: 1, ...inputOverrides },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function zipResponse(value: Buffer, status = 200): Response {
  return new Response(new Uint8Array(value), {
    status,
    headers: { "content-type": "application/zip" },
  });
}

function lastUpdateText(): string {
  return (Object.keys(FEEDS) as Array<keyof typeof FEEDS>)
    .map((name) => {
      const bytes = ZIPS[name];
      const digest = createHash("md5").update(bytes).digest("hex");
      return `${bytes.byteLength} ${digest} http://data.gdeltproject.org/gdeltv2/${FEEDS[name].filename}`;
    })
    .join("\n");
}

function eventLastUpdateText(bytes: Buffer): string {
  const digest = createHash("md5").update(bytes).digest("hex");
  return `${bytes.byteLength} ${digest} http://data.gdeltproject.org/gdeltv2/${FEEDS.events.filename}`;
}

async function successfulFeedFetch(target: string | URL | Request): Promise<Response> {
  const url = new URL(String(target));
  if (url.pathname === "/gdeltv2/lastupdate.txt") return textResponse(lastUpdateText());
  const name = (Object.keys(FEEDS) as Array<keyof typeof FEEDS>).find(
    (candidate) => url.pathname === `/gdeltv2/${FEEDS[candidate].filename}`,
  );
  if (name) return zipResponse(ZIPS[name]);
  throw new Error(`Unexpected GDELT fixture URL: ${url.pathname}`);
}

describe("GDELT connectors", () => {
  it("documents DOC fields, nested windows, and file-feed fields for agent construction", () => {
    for (const schema of [GDELT_DOC_SEARCH_INPUT_SCHEMA, GDELT_FILE_FEED_INPUT_SCHEMA]) {
      for (const [name, field] of Object.entries(schema.properties)) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
    for (const connector of [gdeltEventsConnector, gdeltGkgConnector, gdeltMentionsConnector]) {
      assert.match(connector.discovery.description, /first published 15-minute snapshots/);
      assert.ok(
        connector.discovery.selectionHints.some((hint) =>
          hint.includes("range bounds may be unaligned"),
        ),
      );
    }
    for (const window of ["relativeWindow", "absoluteWindow"] as const) {
      for (const [name, field] of Object.entries(
        GDELT_DOC_SEARCH_INPUT_SCHEMA.properties[window].properties,
      )) {
        assert.equal(typeof (field as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((field as Record<string, unknown>).examples), name);
      }
    }
    for (const [schema, count] of [
      [GDELT_EVENTS_OUTPUT_SCHEMA, 61],
      [GDELT_GKG_OUTPUT_SCHEMA, 27],
      [GDELT_MENTIONS_OUTPUT_SCHEMA, 16],
    ] as const) {
      const fields = (
        schema.properties as {
          records: {
            items: {
              properties: { fields: { properties: object; additionalProperties: boolean } };
            };
          };
        }
      ).records.items.properties.fields;
      assert.equal(fields.additionalProperties, false);
      assert.equal(Object.keys(fields.properties).length, count);
    }
  });

  it("runs a closed JSON article-list query and normalizes article metadata", async () => {
    let requested = "";
    const result = await executeDataRun(docRequest(), {
      registry: createDataRegistry([gdeltDocSearchConnector]),
      environment: {},
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        requested = `${url.pathname}?${url.searchParams.toString()}`;
        return jsonResponse(DOC_ARTICLE_RESPONSE);
      }) as typeof fetch,
    });
    assert.equal(result.status, "success", JSON.stringify(result.errors));
    assert.equal(result.summary.recordCount, 1);
    assert.equal(
      requested,
      "/api/v2/doc/doc?ENDDATETIME=20260302000000&MAXRECORDS=25&STARTDATETIME=20260301000000&format=json&mode=artlist&query=%22climate+change%22+sourcecountry%3Aus&sort=datedesc",
    );
    const data = result.data as { kind: string; articles: Array<Record<string, unknown>> };
    assert.equal(data.kind, "articles");
    assert.deepEqual(data.articles[0], {
      recordIndex: 0,
      sourceQuery: '"climate change" sourcecountry:us',
      url: "https://news.example.invalid/synthetic-article",
      mobileUrl: null,
      title: "Synthetic climate article",
      seenDateTime: "2026-03-01T12:15:00Z",
      socialImageUrl: "https://images.example.invalid/synthetic.jpg",
      domain: "news.example.invalid",
      language: "English",
      sourceCountry: "United States",
    });
  });

  it("runs a closed timeline query and applies the runtime record cap", async () => {
    let requested = "";
    const result = await executeDataRun(
      {
        ...docRequest({
          mode: "timelinevolraw",
          maxRecords: undefined,
          sort: undefined,
          timelineSmooth: 5,
        }),
        limits: { maxRecords: 1 },
      },
      {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requested = `${url.pathname}?${url.searchParams.toString()}`;
          return jsonResponse(DOC_TIMELINE_RESPONSE);
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success", JSON.stringify(result.errors));
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.match(requested, /mode=timelinevolraw/);
    assert.match(requested, /TIMELINESMOOTH=5/);
    const data = result.data as { kind: string; timelines: Array<{ data: unknown[] }> };
    assert.equal(data.kind, "timeline");
    assert.equal(data.timelines[0]?.data.length, 1);
  });

  it("rejects ambiguous, mode-incompatible, syntactically unsafe, and unbounded split DOC requests before fetch", async () => {
    const requests = [
      docRequest({ relativeWindow: { value: 1, unit: "days" } }),
      docRequest({ mode: "artlist", timelineSmooth: 2 }),
      docRequest({ mode: "timelinevol", maxRecords: 5, sort: undefined }),
      docRequest({ query: "https://evil.invalid/\nunsafe" }),
      docRequest({ query: "smoke OR advisory" }),
      docRequest({ query: "smoke site:epa.gov" }),
      { ...docRequest({ exactDomains: ["epa.gov", "airnow.gov"] }), limits: { maxPages: 1 } },
    ];
    for (const request of requests) {
      let fetched = false;
      const result = await executeDataRun(request, {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    }
  });

  it("uses the provider default window and accepts a long absolute timeline window", async () => {
    const requests = [
      docRequest({ absoluteWindow: undefined }),
      docRequest({
        mode: "timelinevol",
        absoluteWindow: { from: "2024-01-01T00:00:00Z", to: "2026-03-02T00:00:00Z" },
        maxRecords: undefined,
        sort: undefined,
      }),
    ];
    for (const request of requests) {
      let target: URL | undefined;
      const result = await executeDataRun(request, {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async (value) => {
          target = new URL(String(value));
          return jsonResponse(
            (request.input as { mode: string }).mode === "artlist"
              ? DOC_ARTICLE_RESPONSE
              : DOC_TIMELINE_RESPONSE,
          );
        }) as typeof fetch,
      });
      assert.equal(result.status, "success", JSON.stringify(result.errors));
      if ((request.input as { mode: string }).mode === "artlist") {
        assert.equal(target?.searchParams.has("TIMESPAN"), false);
        assert.equal(target?.searchParams.has("STARTDATETIME"), false);
      }
    }
  });

  it("splits exact-domain queries, de-duplicates articles, and preserves partial batches", async () => {
    const requestedQueries: string[] = [];
    const result = await executeDataRun(
      docRequest({
        query: "smoke OR advisory",
        exactDomains: ["epa.gov", "airnow.gov"],
        continueOnQueryError: true,
      }),
      {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const query = new URL(String(target)).searchParams.get("query") ?? "";
          requestedQueries.push(query);
          return query.startsWith("domainis:epa.gov")
            ? jsonResponse(DOC_ARTICLE_RESPONSE)
            : textResponse("missing", 404);
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "partial");
    assert.deepEqual(requestedQueries, [
      "domainis:epa.gov (smoke OR advisory)",
      "domainis:airnow.gov (smoke OR advisory)",
    ]);
    assert.equal(result.summary.recordCount, 1);
    assert.equal((result.data as { queryErrors: unknown[] }).queryErrors.length, 1);
  });

  it("normalizes DOC tonechart bins and representative article links", async () => {
    const result = await executeDataRun(
      docRequest({ mode: "tonechart", maxRecords: undefined, sort: undefined }),
      {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async () =>
          jsonResponse({
            tonechart: {
              bins: [
                {
                  bin: "-2",
                  count: 3,
                  articles: DOC_ARTICLE_RESPONSE.articles,
                },
              ],
            },
          })) as typeof fetch,
      },
    );

    assert.equal(result.status, "success", JSON.stringify(result.errors));
    const data = result.data as {
      kind: string;
      toneBins: Array<{ toneBin: string; articleCount: number; representativeArticles: unknown[] }>;
    };
    assert.equal(data.kind, "tone-chart");
    assert.equal(data.toneBins[0]?.toneBin, "-2");
    assert.equal(data.toneBins[0]?.articleCount, 3);
    assert.equal(data.toneBins[0]?.representativeArticles.length, 1);
  });

  it("preserves numeric tone bins including zero and reports malformed bins instead of false no-results", async () => {
    const result = await executeDataRun(
      docRequest({ mode: "tonechart", maxRecords: undefined, sort: undefined }),
      {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async () =>
          jsonResponse({
            tonechart: [
              { bin: -2, count: 3 },
              { bin: 0, count: 4 },
              { bin: "2", count: 1 },
              { bin: {}, count: 5 },
              { bin: 3, count: -1 },
            ],
          })) as typeof fetch,
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.summary.completeness, "partial");
    const data = result.data as {
      toneBins: Array<{ toneBin: string; articleCount: number }>;
      stopReason: string;
    };
    assert.deepEqual(
      data.toneBins.map((b) => [b.toneBin, b.articleCount]),
      [
        ["-2", 3],
        ["0", 4],
        ["2", 1],
      ],
    );
    assert.equal(data.stopReason, "partial");
    assert.equal(result.errors[0]?.details?.invalidBinCount, 2);
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["batches[0].tonechart[3]", "batches[0].tonechart[4]"] },
    ]);
  });

  it("retains the provider's toparts links in numeric tone bins", async () => {
    const result = await executeDataRun(
      docRequest({ mode: "tonechart", maxRecords: undefined, sort: undefined }),
      {
        registry: createDataRegistry([gdeltDocSearchConnector]),
        environment: {},
        fetchImpl: (async () =>
          jsonResponse({
            tonechart: [
              {
                bin: -11,
                count: 3,
                toparts: [
                  {
                    url: "https://news.example.invalid/tone",
                    title: "Synthetic representative headline",
                  },
                ],
              },
              { bin: 0, count: 2, toparts: [] },
            ],
          })) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    const bins = (
      result.data as {
        toneBins: Array<{ representativeArticles: Array<{ url: string; title: string }> }>;
      }
    ).toneBins;
    assert.equal(bins[0]?.representativeArticles.length, 1);
    assert.equal(bins[0]?.representativeArticles[0]?.url, "https://news.example.invalid/tone");
    assert.equal(bins[1]?.representativeArticles.length, 0);
  });

  it("fetches each latest file feed through HTTPS and emits closed named columns", async () => {
    for (const [name, feed] of Object.entries(FEEDS) as Array<
      [keyof typeof FEEDS, (typeof FEEDS)[keyof typeof FEEDS]]
    >) {
      const requested: string[] = [];
      const result = await executeDataRun(feedRequest(feed.capabilityId), {
        registry: createDataRegistry([feed.connector]),
        environment: {},
        fetchImpl: (async (target) => {
          requested.push(String(target));
          return successfulFeedFetch(target);
        }) as typeof fetch,
      });
      assert.equal(result.status, "success", name);
      assert.equal(result.summary.recordCount, 1, name);
      assert.equal(requested.length, 2, name);
      assert.ok(requested.every((url) => url.startsWith("https://data.gdeltproject.org/")));
      const data = result.data as {
        files: Array<{ verifiedMd5: boolean; crc32Verified: boolean }>;
        records: Array<{ fields: Record<string, string> }>;
      };
      assert.equal(data.files[0]?.verifiedMd5, true);
      assert.equal(data.files[0]?.crc32Verified, true);
      assert.equal(Object.keys(data.records[0]?.fields ?? {}).length, feed.columns);
    }
  });

  it("maps the defining identifiers for Events, GKG, and Mentions", async () => {
    const expected = {
      events: ["globalEventId", "dateAdded", "sourceUrl"],
      gkg: ["recordId", "documentIdentifier", "tone"],
      mentions: ["globalEventId", "mentionIdentifier", "confidence"],
    } as const;
    for (const [name, feed] of Object.entries(FEEDS) as Array<
      [keyof typeof FEEDS, (typeof FEEDS)[keyof typeof FEEDS]]
    >) {
      const result = await executeDataRun(feedRequest(feed.capabilityId), {
        registry: createDataRegistry([feed.connector]),
        environment: {},
        fetchImpl: successfulFeedFetch as typeof fetch,
      });
      const fields = (result.data as { records: Array<{ fields: Record<string, string> }> })
        .records[0]?.fields;
      for (const key of expected[name]) assert.ok(fields?.[key], `${name}.${key}`);
    }
  });

  it("generates bounded 15-minute range paths without downloading masterfilelist", async () => {
    const requested: string[] = [];
    const result = await executeDataRun(
      feedRequest("gdelt.events", {
        mode: "range",
        startDateTime: "2026-03-01T12:00:00Z",
        endDateTime: "2026-03-01T12:15:00Z",
        maxFiles: 2,
      }),
      {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requested.push(url.pathname);
          if (url.pathname.endsWith("120000.export.CSV.zip")) {
            return zipResponse(
              singleEntryZip("20260301120000.export.CSV", `${eventRow("1000000001").join("\t")}\n`),
            );
          }
          return zipResponse(
            singleEntryZip("20260301121500.export.CSV", `${eventRow("1000000002").join("\t")}\n`),
          );
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 2);
    assert.deepEqual(requested, [
      "/gdeltv2/20260301120000.export.CSV.zip",
      "/gdeltv2/20260301121500.export.CSV.zip",
    ]);
    assert.equal(requested.includes("/gdeltv2/masterfilelist.txt"), false);
  });

  it("selects the first capped snapshots from a larger unaligned UTC range", async () => {
    const requested: string[] = [];
    const result = await executeDataRun(
      feedRequest("gdelt.events", {
        mode: "range",
        startDateTime: "2026-03-01T12:01:30Z",
        endDateTime: "2026-03-01T13:00:00Z",
        maxFiles: 2,
      }),
      {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async (target) => {
          const url = new URL(String(target));
          requested.push(url.pathname);
          const member = url.pathname
            .split("/")
            .at(-1)!
            .replace(/\.zip$/, "");
          return zipResponse(singleEntryZip(member, `${eventRow().join("\t")}\n`));
        }) as typeof fetch,
      },
    );

    assert.equal(result.status, "success");
    assert.equal(result.summary.truncated, true);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-files");
    assert.deepEqual(requested, [
      "/gdeltv2/20260301121500.export.CSV.zip",
      "/gdeltv2/20260301123000.export.CSV.zip",
    ]);
  });

  it("preserves earlier feed records when a later range file is unavailable", async () => {
    const result = await executeDataRun(
      feedRequest("gdelt.events", {
        mode: "range",
        startDateTime: "2026-03-01T12:00:00Z",
        endDateTime: "2026-03-01T12:15:00Z",
        maxFiles: 2,
      }),
      {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async (target) =>
          String(target).includes("120000")
            ? zipResponse(singleEntryZip("20260301120000.export.CSV", `${eventRow().join("\t")}\n`))
            : textResponse("missing", 404)) as typeof fetch,
      },
    );
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [
      { kind: "file", identifiers: ["20260301121500.export.CSV.zip"] },
    ]);
  });

  it("rejects reversed and mode-incompatible feed requests before network access", async () => {
    const requests = [
      feedRequest("gdelt.events", {
        mode: "range",
        startDateTime: "2026-03-01T12:15:00Z",
        endDateTime: "2026-03-01T12:00:00Z",
        maxFiles: 2,
      }),
      feedRequest("gdelt.events", { mode: "latest", startDateTime: "../unsafe" }),
    ];
    for (const request of requests) {
      let fetched = false;
      const result = await executeDataRun(request, {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
      assert.equal(fetched, false);
    }
  });

  it("blocks malformed ZIP structure, unsafe members, and checksum drift", async () => {
    const cases = [
      {
        bytes: singleEntryZip("../unsafe.export.CSV", `${eventRow().join("\t")}\n`),
        advertisedBytes: null,
      },
      { bytes: corruptLastByte(ZIPS.events), advertisedBytes: ZIPS.events },
    ];
    for (const { bytes, advertisedBytes } of cases) {
      const result = await executeDataRun(feedRequest("gdelt.events"), {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async (target) =>
          String(target).endsWith("lastupdate.txt")
            ? textResponse(eventLastUpdateText(advertisedBytes ?? bytes))
            : zipResponse(bytes)) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "provider-response-invalid");
    }
  });

  it("isolates malformed table rows while preserving valid rows from the same ZIP", async () => {
    const bytes = singleEntryZip(
      "20260301120000.export.CSV",
      `too\tfew\tcolumns\n${eventRow().join("\t")}\n`,
    );
    const result = await executeDataRun(feedRequest("gdelt.events"), {
      registry: createDataRegistry([gdeltEventsConnector]),
      environment: {},
      fetchImpl: (async (target) =>
        String(target).endsWith("lastupdate.txt")
          ? textResponse(eventLastUpdateText(bytes))
          : zipResponse(bytes)) as typeof fetch,
    });

    assert.equal(result.status, "partial", JSON.stringify(result.errors));
    assert.equal(result.summary.completeness, "partial");
    assert.equal(result.errors[0]?.code, "partial-result");
    assert.deepEqual(result.summary.missing, [
      { kind: "field", identifiers: ["20260301120000.export.CSV.zip:invalid-rows"] },
    ]);
    assert.equal(result.summary.recordCount, 1);
    const file = (
      result.data as {
        files: Array<{
          rowCount: number;
          validRowCount: number;
          invalidRowCount: number;
          validationIssues: string[];
          sha256: string;
        }>;
      }
    ).files[0];
    assert.equal(file?.rowCount, 2);
    assert.equal(file?.validRowCount, 1);
    assert.equal(file?.invalidRowCount, 1);
    assert.equal(file?.validationIssues.length, 1);
    assert.match(file?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  it("stops a file feed at the record cap before another download", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      {
        ...feedRequest("gdelt.events", {
          mode: "range",
          startDateTime: "2026-03-01T12:00:00Z",
          endDateTime: "2026-03-01T12:15:00Z",
          maxFiles: 2,
        }),
        limits: { maxRecords: 1 },
      },
      {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetchCount += 1;
          return zipResponse(
            singleEntryZip(
              "20260301120000.export.CSV",
              `${eventRow().join("\t")}\n${eventRow("1000000002").join("\t")}\n`,
            ),
          );
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal(fetchCount, 1);
  });

  it("honors a stricter runtime file limit without downloading the next range file", async () => {
    let fetchCount = 0;
    const result = await executeDataRun(
      {
        ...feedRequest("gdelt.events", {
          mode: "range",
          startDateTime: "2026-03-01T12:00:00Z",
          endDateTime: "2026-03-01T12:15:00Z",
          maxFiles: 2,
        }),
        limits: { maxPages: 1 },
      },
      {
        registry: createDataRegistry([gdeltEventsConnector]),
        environment: {},
        fetchImpl: (async () => {
          fetchCount += 1;
          return zipResponse(
            singleEntryZip("20260301120000.export.CSV", `${eventRow().join("\t")}\n`),
          );
        }) as typeof fetch,
      },
    );
    assert.equal(result.status, "success");
    assert.equal(result.summary.truncated, true);
    assert.equal(fetchCount, 1);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-files");
  });

  it("publishes dataset, automation, interpretation, and content boundaries", () => {
    const connectors = [
      gdeltDocSearchConnector,
      gdeltEventsConnector,
      gdeltGkgConnector,
      gdeltMentionsConnector,
    ];
    for (const connector of connectors) {
      const discovery = createDataRegistry([connector]).discovery(connector.capabilityId);
      assert.ok(discovery);
      assert.ok(
        discovery.limitations.some((item) => /automated|machine|coding|coverage/i.test(item)),
      );
      assert.ok(
        discovery.doesNotProvide.some((item) =>
          /representative|ground truth|caus|fact/i.test(item),
        ),
      );
      assert.ok(
        discovery.doesNotProvide.some((item) =>
          /full text|article body|downloaded file/i.test(item),
        ),
      );
    }
  });

  it("conforms for DOC and all three independently discoverable file feeds", async () => {
    await assertDataConnectorConformance({
      connector: gdeltDocSearchConnector,
      request: docRequest(),
      fetchImpl: (async () => jsonResponse(DOC_ARTICLE_RESPONSE)) as typeof fetch,
    });
    for (const feed of Object.values(FEEDS)) {
      await assertDataConnectorConformance({
        connector: feed.connector as DataConnectorDefinition,
        request: feedRequest(feed.capabilityId),
        fetchImpl: successfulFeedFetch as typeof fetch,
      });
    }
  });
});

function eventRow(globalEventId = "1000000001"): string[] {
  const row = Array.from({ length: 61 }, () => "");
  row[0] = globalEventId;
  row[1] = "20260301";
  row[25] = "1";
  row[26] = "010";
  row[59] = "20260301120000";
  row[60] = "https://news.example.invalid/synthetic-event";
  return row;
}

function gkgRow(): string[] {
  const row = Array.from({ length: 27 }, () => "");
  row[0] = "20260301120000-1";
  row[1] = "20260301120000";
  row[2] = "1";
  row[3] = "news.example.invalid";
  row[4] = "https://news.example.invalid/synthetic-gkg";
  row[15] = "-1.5,3,4,1,5,2,10";
  row[26] = "<PAGE_LINKS>synthetic</PAGE_LINKS>";
  return row;
}

function mentionsRow(): string[] {
  const row = Array.from({ length: 16 }, () => "");
  row[0] = "1000000001";
  row[1] = "20260301120000";
  row[2] = "20260301121500";
  row[3] = "1";
  row[4] = "news.example.invalid";
  row[5] = "https://news.example.invalid/synthetic-mention";
  row[6] = "4";
  row[11] = "80";
  return row;
}

function singleEntryZip(filename: string, text: string): Buffer {
  const filenameBytes = Buffer.from(filename, "utf8");
  const content = Buffer.from(text, "utf8");
  const compressed = deflateRawSync(content);
  const crc = crc32(content);
  const localExtra = Buffer.alloc(28);
  const centralExtra = Buffer.alloc(24);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.byteLength, 18);
  local.writeUInt32LE(content.byteLength, 22);
  local.writeUInt16LE(filenameBytes.byteLength, 26);
  local.writeUInt16LE(localExtra.byteLength, 28);
  const centralOffset =
    local.byteLength + filenameBytes.byteLength + localExtra.byteLength + compressed.byteLength;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.byteLength, 20);
  central.writeUInt32LE(content.byteLength, 24);
  central.writeUInt16LE(filenameBytes.byteLength, 28);
  central.writeUInt16LE(centralExtra.byteLength, 30);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.byteLength + filenameBytes.byteLength + centralExtra.byteLength, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([
    local,
    filenameBytes,
    localExtra,
    compressed,
    central,
    filenameBytes,
    centralExtra,
    end,
  ]);
}

function corruptLastByte(bytes: Buffer): Buffer {
  const result = Buffer.from(bytes);
  result[result.byteLength - 23] = (result[result.byteLength - 23] ?? 0) ^ 0xff;
  return result;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
