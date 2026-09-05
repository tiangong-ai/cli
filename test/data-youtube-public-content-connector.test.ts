import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDataRegistry } from "../src/data/catalog.js";
import { youtubePublicContentConnector } from "../src/data/connectors/youtube-public-content.js";
import {
  YOUTUBE_COMMENTS_INPUT_SCHEMA,
  YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA,
} from "../src/data/connectors/youtube-public-content.schemas.js";
import type { DataRunRequest } from "../src/data/contracts.js";
import { executeDataRun } from "../src/data/runtime/execute.js";

const VIDEO_ONE = "video000001";
const VIDEO_TWO = "video000002";
const VIDEO_NO_STATS = "nostats0001";
const VIDEO_PRESENT = "present0001";
const VIDEO_OMITTED = "omitted0001";
const VIDEO_BUDGETED = "budget00001";

function searchRequest(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "youtube.public-content",
    capabilityVersion: "1.0.1",
    operationId: "search-videos",
    operationVersion: "1.0.0",
    input: {
      query: "climate policy",
      publishedAfter: "2026-03-01T00:00:00Z",
      publishedBefore: "2026-03-08T00:00:00Z",
      order: "date",
      regionCode: "US",
      relevanceLanguage: "en",
      safeSearch: "moderate",
      videoDuration: "medium",
      pageSize: 2,
      requirePublicComments: true,
      minimumCommentCount: 5,
      minimumViewCount: 100,
    },
  };
}

function commentsRequest(): DataRunRequest {
  return {
    schemaVersion: "tiangong.data.run-request.v1",
    capabilityId: "youtube.public-content",
    capabilityVersion: "1.0.1",
    operationId: "fetch-comments",
    operationVersion: "1.0.1",
    input: {
      videoIds: [VIDEO_ONE],
      startDateTime: "2026-03-01T00:00:00Z",
      endDateTime: "2026-03-08T00:00:00Z",
      timeField: "published",
      includeReplies: true,
      order: "time",
      pageSize: 100,
    },
  };
}

describe("YouTube public-content connector", () => {
  it("documents all top-level inputs for both operations", () => {
    for (const schema of [YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA, YOUTUBE_COMMENTS_INPUT_SCHEMA]) {
      for (const [name, property] of Object.entries(schema.properties)) {
        assert.equal(typeof (property as Record<string, unknown>).description, "string", name);
        assert.ok(Array.isArray((property as Record<string, unknown>).examples), name);
      }
    }
    assert.equal(YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA.properties.maxSearchPages.maximum, 10);
    assert.equal(YOUTUBE_COMMENTS_INPUT_SCHEMA.properties.videoIds.maxItems, 50);
  });

  it("publishes current quota, metric-break, search-order, and reply-filter semantics", () => {
    assert.ok(
      youtubePublicContentConnector.limitations.some((item) => /Search Queries.*quota/i.test(item)),
    );
    assert.ok(
      youtubePublicContentConnector.limitations.some((item) =>
        /viewCount.*August 24, 2026/i.test(item),
      ),
    );
    const hints = youtubePublicContentConnector.discovery?.selectionHints ?? [];
    assert.ok(hints.some((item) => /publishedBefore.*inclusive/i.test(item)));
    assert.ok(hints.some((item) => /rating.*internal score/i.test(item)));
    assert.ok(hints.some((item) => /searchTerms.*top-level/i.test(item)));
  });

  it("injects the API key in a header, searches videos, and enriches details", async () => {
    const targets: URL[] = [];
    const headers: Headers[] = [];
    const result = await executeDataRun(searchRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target, init) => {
        const url = new URL(String(target));
        targets.push(url);
        headers.push(new Headers(init?.headers));
        if (url.pathname.endsWith("/search")) {
          return Response.json({
            items: [
              {
                id: { kind: "youtube#video", videoId: VIDEO_ONE },
                snippet: {
                  publishedAt: "2026-03-04T00:00:00Z",
                  channelId: "channel-1",
                  title: "Climate video",
                  description: "Description",
                  channelTitle: "Example channel",
                  liveBroadcastContent: "none",
                },
              },
            ],
            pageInfo: { totalResults: 1, resultsPerPage: 2 },
          });
        }
        return Response.json({
          items: [
            {
              id: VIDEO_ONE,
              snippet: {
                publishedAt: "2026-03-04T00:00:00Z",
                channelId: "channel-1",
                title: "Climate video",
                description: "Description",
                channelTitle: "Example channel",
                tags: ["climate"],
                thumbnails: {
                  default: { url: `https://i.ytimg.com/vi/${VIDEO_ONE}/default.jpg` },
                },
                categoryId: "28",
                defaultLanguage: "en",
                defaultAudioLanguage: "en-US",
                liveBroadcastContent: "none",
              },
              statistics: { viewCount: "250", likeCount: "12", commentCount: "8" },
              contentDetails: {
                duration: "PT4M2S",
                caption: "true",
                definition: "hd",
                dimension: "2d",
                licensedContent: false,
                projection: "rectangular",
              },
              status: {
                privacyStatus: "public",
                embeddable: true,
                license: "youtube",
                madeForKids: false,
                selfDeclaredMadeForKids: false,
              },
              liveStreamingDetails: {
                actualStartTime: "2026-03-04T00:01:00Z",
                actualEndTime: "2026-03-04T01:01:00Z",
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.pageCount, 2);
    assert.equal(targets[0]?.searchParams.has("key"), false);
    assert.equal(headers[0]?.get("X-Goog-Api-Key"), "secret-youtube-key");
    assert.equal(targets[0]?.searchParams.get("q"), "climate policy");
    assert.equal(targets[1]?.searchParams.get("id"), VIDEO_ONE);
    assert.equal(targets[1]?.searchParams.get("maxResults"), "1");
    const records = (
      result.data as {
        records: Array<{
          videoId: string;
          searchRank: number;
          searchPage: number;
          searchPosition: number;
          thumbnailUrls: string[];
          defaultAudioLanguage: string | null;
          liveStreamingDetails: Record<string, unknown>;
          statistics: unknown;
        }>;
      }
    ).records;
    assert.deepEqual(
      records.map((item) => item.videoId),
      [VIDEO_ONE],
    );
    assert.equal(records[0]?.searchRank, 1);
    assert.equal(records[0]?.searchPage, 1);
    assert.equal(records[0]?.searchPosition, 1);
    assert.equal((result.data as { query: { maxSearchPages: number } }).query.maxSearchPages, 5);
    assert.deepEqual(records[0]?.thumbnailUrls, [
      `https://i.ytimg.com/vi/${VIDEO_ONE}/default.jpg`,
    ]);
    assert.equal(records[0]?.defaultAudioLanguage, "en-US");
    assert.equal(records[0]?.liveStreamingDetails.actualEndTime, "2026-03-04T01:01:00.000Z");
    assert.ok(records[0]?.statistics);
  });

  it("keeps videos with unavailable public statistics when no statistic filter requires them", async () => {
    const request = {
      ...searchRequest(),
      input: {
        query: "metadata only",
        requirePublicComments: false,
        minimumCommentCount: 0,
        minimumViewCount: 0,
      },
    };
    const result = await executeDataRun(request, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        return url.pathname.endsWith("/search")
          ? Response.json({ items: [{ id: { videoId: VIDEO_NO_STATS } }] })
          : Response.json({
              items: [{ id: VIDEO_NO_STATS, snippet: { title: "No public stats" } }],
            });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal((result.data as { filteredOut: unknown[] }).filteredOut.length, 0);
  });

  it("preserves enriched candidates and reports IDs omitted by videos.list as partial", async () => {
    const request = {
      ...searchRequest(),
      input: {
        query: "detail race",
        requirePublicComments: false,
        minimumCommentCount: 0,
        minimumViewCount: 0,
      },
    };
    const result = await executeDataRun(request, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        return url.pathname.endsWith("/search")
          ? Response.json({
              items: [{ id: { videoId: VIDEO_PRESENT } }, { id: { videoId: VIDEO_OMITTED } }],
            })
          : Response.json({ items: [{ id: VIDEO_PRESENT, snippet: { title: "Present" } }] });
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: [VIDEO_OMITTED] }]);
    assert.equal(
      (result.data as { records: Array<{ videoId: string }> }).records[0]?.videoId,
      VIDEO_PRESENT,
    );
  });

  it("reserves request budget for mandatory detail enrichment", async () => {
    const targets: URL[] = [];
    const request = {
      ...searchRequest(),
      limits: { maxPages: 2, maxRecords: 10 },
      input: {
        query: "bounded enrichment",
        pageSize: 2,
        requirePublicComments: false,
        minimumCommentCount: 0,
        minimumViewCount: 0,
      },
    };
    const result = await executeDataRun(request, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        return url.pathname.endsWith("/search")
          ? Response.json({
              items: [{ id: { videoId: VIDEO_BUDGETED } }],
              nextPageToken: "would-cost-another-search",
            })
          : Response.json({
              items: [{ id: VIDEO_BUDGETED, snippet: { title: "Budgeted" } }],
            });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal((result.data as { stopReason: string }).stopReason, "max-pages");
    assert.deepEqual(
      targets.map((url) => url.pathname.split("/").at(-1)),
      ["search", "videos"],
    );
  });

  it("fetches complete reply pages rather than trusting embedded replies", async () => {
    const targets: URL[] = [];
    const result = await executeDataRun(commentsRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        if (url.pathname.endsWith("/commentThreads")) {
          return Response.json({
            items: [
              {
                id: "thread-1",
                snippet: {
                  videoId: VIDEO_ONE,
                  totalReplyCount: 2,
                  topLevelComment: {
                    id: "comment-top",
                    snippet: {
                      videoId: VIDEO_ONE,
                      channelId: "video-channel",
                      textDisplay: "Top comment",
                      textOriginal: "Top comment",
                      authorDisplayName: "A",
                      authorChannelId: { value: "channel-a" },
                      canRate: true,
                      viewerRating: "none",
                      likeCount: 2,
                      publishedAt: "2026-03-03T00:00:00Z",
                      updatedAt: "2026-03-03T01:00:00Z",
                    },
                  },
                },
                replies: { comments: [{ id: "embedded-only" }] },
              },
            ],
          });
        }
        return Response.json({
          items: [
            {
              id: "reply-1",
              snippet: {
                parentId: "comment-top",
                textDisplay: "Reply one",
                textOriginal: "Reply one",
                authorDisplayName: "B",
                publishedAt: "2026-03-03T02:00:00Z",
                updatedAt: "2026-03-03T02:00:00Z",
                likeCount: 1,
              },
            },
            {
              id: "reply-2",
              snippet: {
                parentId: "comment-top",
                textDisplay: "Reply two",
                textOriginal: "Reply two",
                authorDisplayName: "C",
                publishedAt: "2026-03-03T03:00:00Z",
                updatedAt: "2026-03-03T03:00:00Z",
                likeCount: 0,
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 3);
    assert.equal(result.summary.pageCount, 2);
    assert.ok(targets[1]?.pathname.endsWith("/comments"));
    assert.equal(targets[1]?.searchParams.get("parentId"), "comment-top");
    const records = (
      result.data as {
        records: Array<{ commentId: string; kind: string; channelId: string | null }>;
      }
    ).records;
    assert.deepEqual(
      records.map((item) => item.commentId),
      ["comment-top", "reply-1", "reply-2"],
    );
    assert.equal(records[0]?.channelId, "video-channel");
    const communication = result.data as {
      requestBudget: {
        maxRequests: number;
        usedRequests: number;
        threadRequests: number;
        replyRequests: number;
        remainingRequests: number;
      };
      replyCompleteness: {
        knownThreadsWithReplies: number;
        fullyExpandedThreads: number;
        knownUnexpandedThreadIds: string[];
      };
    };
    assert.deepEqual(communication.requestBudget, {
      maxRequests: 100,
      usedRequests: 2,
      threadRequests: 1,
      replyRequests: 1,
      remainingRequests: 98,
    });
    assert.equal(communication.replyCompleteness.knownThreadsWithReplies, 1);
    assert.equal(communication.replyCompleteness.fullyExpandedThreads, 1);
    assert.deepEqual(communication.replyCompleteness.knownUnexpandedThreadIds, []);
  });

  it("supports an explicit top-level-only strategy without spending reply requests", async () => {
    const targets: URL[] = [];
    const nextRequest = {
      ...commentsRequest(),
      input: {
        videoIds: [VIDEO_ONE],
        replyStrategy: "top-level-only",
        order: "time",
      },
    };
    const result = await executeDataRun(nextRequest, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        targets.push(url);
        return Response.json({
          items: [
            {
              id: "thread-1",
              snippet: {
                videoId: VIDEO_ONE,
                totalReplyCount: 5,
                topLevelComment: {
                  id: "comment-top",
                  snippet: {
                    videoId: VIDEO_ONE,
                    textDisplay: "Top comment",
                    publishedAt: "2026-03-03T00:00:00Z",
                    updatedAt: "2026-03-03T00:00:00Z",
                  },
                },
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 1);
    assert.equal(targets.length, 1);
    assert.ok(targets[0]?.pathname.endsWith("/commentThreads"));
    const data = result.data as {
      query: { includeReplies: boolean; replyStrategy: string };
      requestBudget: { threadRequests: number; replyRequests: number };
      replyCompleteness: { requested: boolean; knownUnexpandedThreadIds: string[] };
    };
    assert.equal(data.query.includeReplies, false);
    assert.equal(data.query.replyStrategy, "top-level-only");
    assert.equal(data.requestBudget.threadRequests, 1);
    assert.equal(data.requestBudget.replyRequests, 0);
    assert.equal(data.replyCompleteness.requested, false);
    assert.deepEqual(data.replyCompleteness.knownUnexpandedThreadIds, ["thread-1"]);
  });

  it("continues later videos after a per-video thread-page cap", async () => {
    const request = {
      ...commentsRequest(),
      input: {
        videoIds: [VIDEO_ONE, VIDEO_TWO],
        includeReplies: false,
        maxThreadPagesPerVideo: 1,
      },
    };
    const requestedVideoIds: string[] = [];
    const result = await executeDataRun(request, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        const videoId = url.searchParams.get("videoId") ?? "";
        requestedVideoIds.push(videoId);
        return Response.json({
          items: [
            {
              id: `thread-${videoId}`,
              snippet: {
                videoId,
                totalReplyCount: 0,
                topLevelComment: {
                  id: `comment-${videoId}`,
                  snippet: {
                    videoId,
                    textDisplay: videoId,
                    publishedAt: "2026-03-03T00:00:00Z",
                    updatedAt: "2026-03-03T00:00:00Z",
                  },
                },
              },
            },
          ],
          nextPageToken: `next-${videoId}`,
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 2);
    assert.equal(result.summary.truncated, true);
    assert.deepEqual(requestedVideoIds, [VIDEO_ONE, VIDEO_TWO]);
    assert.ok(
      (result.data as { videos: Array<{ truncated: boolean }> }).videos.every(
        (video) => video.truncated,
      ),
    );
  });

  it("continues later threads after a per-thread reply-page cap", async () => {
    const request = {
      ...commentsRequest(),
      input: {
        ...(commentsRequest().input as object),
        maxReplyPagesPerThread: 1,
      },
    };
    const requestedParents: string[] = [];
    const result = await executeDataRun(request, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.pathname.endsWith("/commentThreads")) {
          return Response.json({
            items: ["one", "two"].map((suffix) => ({
              id: `thread-${suffix}`,
              snippet: {
                videoId: VIDEO_ONE,
                totalReplyCount: 2,
                topLevelComment: {
                  id: `comment-${suffix}`,
                  snippet: {
                    videoId: VIDEO_ONE,
                    textDisplay: `Top ${suffix}`,
                    publishedAt: "2026-03-03T00:00:00Z",
                    updatedAt: "2026-03-03T00:00:00Z",
                  },
                },
              },
            })),
          });
        }
        const parentId = url.searchParams.get("parentId") ?? "";
        requestedParents.push(parentId);
        return Response.json({
          items: [
            {
              id: `reply-${parentId}`,
              snippet: {
                videoId: VIDEO_ONE,
                parentId,
                textDisplay: `Reply ${parentId}`,
                publishedAt: "2026-03-03T01:00:00Z",
                updatedAt: "2026-03-03T01:00:00Z",
              },
            },
          ],
          nextPageToken: `next-${parentId}`,
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary.recordCount, 4);
    assert.equal(result.summary.truncated, true);
    assert.deepEqual(requestedParents, ["comment-one", "comment-two"]);
    assert.deepEqual(
      (result.data as { replyCompleteness: { knownUnexpandedThreadIds: string[] } })
        .replyCompleteness.knownUnexpandedThreadIds,
      ["thread-one", "thread-two"],
    );
  });

  it("marks a mismatched reply parent as partial while preserving the top-level comment", async () => {
    const result = await executeDataRun(commentsRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.pathname.endsWith("/commentThreads")) {
          return Response.json({
            items: [
              {
                id: "thread-1",
                snippet: {
                  videoId: VIDEO_ONE,
                  totalReplyCount: 1,
                  topLevelComment: {
                    id: "comment-top",
                    snippet: {
                      videoId: VIDEO_ONE,
                      textDisplay: "Top comment",
                      publishedAt: "2026-03-03T00:00:00Z",
                      updatedAt: "2026-03-03T00:00:00Z",
                    },
                  },
                },
              },
            ],
          });
        }
        return Response.json({
          items: [
            {
              id: "reply-wrong-parent",
              snippet: {
                videoId: VIDEO_ONE,
                parentId: "different-parent",
                textDisplay: "Wrong linkage",
                publishedAt: "2026-03-03T01:00:00Z",
                updatedAt: "2026-03-03T01:00:00Z",
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: [VIDEO_ONE] }]);
  });

  it("blocks without the declared logical credential before network access", async () => {
    let fetched = false;
    const result = await executeDataRun(searchRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: {},
      fetchImpl: (async () => {
        fetched = true;
        throw new Error("must not fetch");
      }) as typeof fetch,
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.errors[0]?.code, "credential-missing");
    assert.equal(fetched, false);
  });

  it("rejects unsupported search order, malformed or duplicate video IDs, and one-sided windows", async () => {
    let fetched = false;
    for (const request of [
      { ...searchRequest(), input: { query: "   " } },
      { ...searchRequest(), input: { query: "video only", order: "videoCount" } },
      {
        ...commentsRequest(),
        input: { videoIds: [VIDEO_ONE, VIDEO_ONE] },
      },
      {
        ...commentsRequest(),
        input: { videoIds: ["bad"] },
      },
      {
        ...commentsRequest(),
        input: { videoIds: [VIDEO_ONE], startDateTime: "2026-03-01T00:00:00Z" },
      },
    ]) {
      const result = await executeDataRun(request, {
        registry: createDataRegistry([youtubePublicContentConnector]),
        environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.errors[0]?.code, "invalid-request");
    }
    assert.equal(fetched, false);
  });

  it("preserves comments from completed videos when a later video is disabled", async () => {
    const nextRequest = {
      ...commentsRequest(),
      input: {
        ...(commentsRequest().input as object),
        videoIds: [VIDEO_ONE, VIDEO_TWO],
        includeReplies: false,
      },
    };
    const result = await executeDataRun(nextRequest, {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async (target) => {
        const url = new URL(String(target));
        if (url.searchParams.get("videoId") === VIDEO_TWO) {
          return Response.json(
            { error: { errors: [{ reason: "commentsDisabled" }] } },
            { status: 403 },
          );
        }
        return Response.json({
          items: [
            {
              id: "thread-1",
              snippet: {
                videoId: VIDEO_ONE,
                totalReplyCount: 0,
                topLevelComment: {
                  id: "comment-top",
                  snippet: {
                    videoId: VIDEO_ONE,
                    textDisplay: "Top comment",
                    authorDisplayName: "A",
                    publishedAt: "2026-03-03T00:00:00Z",
                    updatedAt: "2026-03-03T00:00:00Z",
                    likeCount: 0,
                  },
                },
              },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 1);
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: [VIDEO_TWO] }]);
    assert.deepEqual(result.errors[0]?.details?.causeCodes, ["provider-response-invalid"]);
  });

  it("returns an explicit empty partial when comments are disabled", async () => {
    const result = await executeDataRun(commentsRequest(), {
      registry: createDataRegistry([youtubePublicContentConnector]),
      environment: { YOUTUBE_API_KEY: "secret-youtube-key" },
      fetchImpl: (async () =>
        Response.json(
          { error: { errors: [{ reason: "commentsDisabled" }] } },
          { status: 403 },
        )) as typeof fetch,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.summary.recordCount, 0);
    assert.deepEqual(result.summary.missing, [{ kind: "range", identifiers: [VIDEO_ONE] }]);
    assert.deepEqual(result.errors[0]?.details?.causeCodes, ["provider-response-invalid"]);
  });
});
