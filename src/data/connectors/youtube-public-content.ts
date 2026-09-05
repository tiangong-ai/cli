import type {
  DataConnectorDefinition,
  DataMachineError,
  DataOperationExecution,
  DataOperationExecutionContext,
  DataSourceObservation,
} from "../contracts.js";
import { DATA_MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { DataRuntimeError } from "../runtime/errors.js";
import {
  YOUTUBE_COMMENTS_INPUT_SCHEMA,
  YOUTUBE_COMMENTS_OUTPUT_SCHEMA,
  YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA,
  YOUTUBE_VIDEO_SEARCH_OUTPUT_SCHEMA,
} from "./youtube-public-content.schemas.js";

const API_PREFIX = "/youtube/v3/";
const SEARCH_PATH = `${API_PREFIX}search`;
const VIDEOS_PATH = `${API_PREFIX}videos`;
const COMMENT_THREADS_PATH = `${API_PREFIX}commentThreads`;
const COMMENTS_PATH = `${API_PREFIX}comments`;
const VIDEO_DETAIL_BATCH_SIZE = 50;
const MAX_VIDEO_SEARCH_PAGES = 10;
const MAX_VIDEO_CANDIDATES = 250;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

interface VideoSearchInput {
  query: string;
  channelId?: string;
  publishedAfter?: string;
  publishedBefore?: string;
  order?: "date" | "rating" | "relevance" | "title" | "viewCount";
  regionCode?: string;
  relevanceLanguage?: string;
  safeSearch?: "moderate" | "none" | "strict";
  videoCaption?: "any" | "closedCaption" | "none";
  videoDefinition?: "any" | "high" | "standard";
  videoDimension?: "2d" | "3d" | "any";
  videoDuration?: "any" | "long" | "medium" | "short";
  videoEmbeddable?: "any" | "true";
  videoEventType?: "completed" | "live" | "upcoming";
  videoLicense?: "any" | "creativeCommon" | "youtube";
  videoPaidProductPlacement?: "any" | "true";
  videoSyndicated?: "any" | "true";
  videoType?: "any" | "episode" | "movie";
  pageSize?: number;
  maxSearchPages?: number;
  requirePublicComments?: boolean;
  minimumCommentCount?: number;
  minimumViewCount?: number;
}

interface NormalizedVideoSearch {
  query: string;
  channelId: string | null;
  publishedAfter: string | null;
  publishedBefore: string | null;
  order: "date" | "rating" | "relevance" | "title" | "viewCount";
  regionCode: string | null;
  relevanceLanguage: string | null;
  safeSearch: "moderate" | "none" | "strict";
  videoCaption: VideoSearchInput["videoCaption"] | null;
  videoDefinition: VideoSearchInput["videoDefinition"] | null;
  videoDimension: VideoSearchInput["videoDimension"] | null;
  videoDuration: VideoSearchInput["videoDuration"] | null;
  videoEmbeddable: VideoSearchInput["videoEmbeddable"] | null;
  videoEventType: VideoSearchInput["videoEventType"] | null;
  videoLicense: VideoSearchInput["videoLicense"] | null;
  videoPaidProductPlacement: VideoSearchInput["videoPaidProductPlacement"] | null;
  videoSyndicated: VideoSearchInput["videoSyndicated"] | null;
  videoType: VideoSearchInput["videoType"] | null;
  pageSize: number;
  maxSearchPages: number;
  requirePublicComments: boolean;
  minimumCommentCount: number;
  minimumViewCount: number;
}

interface CommentsInput {
  videoIds: string[];
  startDateTime?: string;
  endDateTime?: string;
  timeField?: "published" | "updated";
  includeReplies?: boolean;
  replyStrategy?: "all-visible" | "top-level-only";
  searchTerms?: string;
  order?: "relevance" | "time";
  pageSize?: number;
  maxThreadPagesPerVideo?: number;
  maxReplyPagesPerThread?: number;
}

interface NormalizedCommentsQuery {
  videoIds: string[];
  startDateTime: string | null;
  endDateTime: string | null;
  timeField: "published" | "updated";
  includeReplies: boolean;
  replyStrategy: "all-visible" | "top-level-only";
  searchTerms: string | null;
  order: "relevance" | "time";
  pageSize: number;
  maxThreadPagesPerVideo: number;
  maxReplyPagesPerThread: number;
}

interface VideoRecord {
  videoId: string;
  searchRank: number;
  searchPage: number;
  searchPosition: number;
  publishedAt: string | null;
  channelId: string | null;
  channelTitle: string | null;
  title: string;
  description: string;
  tags: string[];
  thumbnailUrls: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  liveBroadcastContent: string | null;
  statistics: { viewCount: number | null; likeCount: number | null; commentCount: number | null };
  contentDetails: {
    duration: string | null;
    caption: string | null;
    definition: string | null;
    dimension: string | null;
    licensedContent: boolean | null;
    projection: string | null;
  };
  status: {
    privacyStatus: string | null;
    embeddable: boolean | null;
    license: string | null;
    madeForKids: boolean | null;
    selfDeclaredMadeForKids: boolean | null;
  };
  liveStreamingDetails: {
    actualStartTime: string | null;
    actualEndTime: string | null;
    scheduledStartTime: string | null;
    scheduledEndTime: string | null;
  };
}

type VideoDetailRecord = Omit<VideoRecord, "searchRank" | "searchPage" | "searchPosition">;

interface VideoSearchCandidate {
  videoId: string;
  searchRank: number;
  searchPage: number;
  searchPosition: number;
}

interface CommentRecord {
  commentId: string;
  threadId: string;
  videoId: string;
  parentId: string | null;
  kind: "top-level" | "reply";
  channelId: string | null;
  authorDisplayName: string | null;
  authorChannelId: string | null;
  authorChannelUrl: string | null;
  authorProfileImageUrl: string | null;
  textDisplay: string;
  textOriginal: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  likeCount: number | null;
  viewerRating: string | null;
  canRate: boolean | null;
}

export const youtubePublicContentConnector: DataConnectorDefinition = {
  schemaVersion: DATA_MANIFEST_SCHEMA_VERSION,
  capabilityId: "youtube.public-content",
  capabilityVersion: "1.0.1",
  minimumCliVersion: "0.0.55",
  provider: { providerId: "youtube", name: "YouTube Data API" },
  sourceCategory: "public-video-and-comment-metadata",
  endpoints: [
    {
      endpointId: "youtube-data-api",
      baseUrl: "https://www.googleapis.com",
      pathPrefixes: [API_PREFIX],
      allowedMethods: ["GET"],
      allowedContentTypes: ["application/json"],
    },
  ],
  license: {
    name: "YouTube API Services Terms and public-content policies",
    url: "https://developers.google.com/youtube/terms/api-services-terms-of-service",
    restrictions: [
      "Use the API and returned data in accordance with YouTube API Services Terms, developer policies, and applicable law.",
      "Videos, comments, authors, and engagement statistics are mutable user-generated content and can be removed, moderated, hidden, or unsafe.",
      "Do not treat search ranking, views, likes, or comment counts as representative public opinion, verified identity, endorsement, or factual truth.",
    ],
  },
  credentials: [
    {
      credentialId: "api-key",
      environmentVariable: "YOUTUBE_API_KEY",
      required: true,
      endpointIds: ["youtube-data-api"],
      injection: { kind: "header", name: "X-Goog-Api-Key", prefix: "" },
    },
  ],
  limits: {
    timeoutMs: 60_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 20_000_000,
    maxPages: 100,
    maxRecords: 5_000,
    maxRetries: 4,
    maxRetryDelayMs: 120_000,
    maxRedirects: 1,
  },
  diagnostics: { static: true, live: false },
  freshness: {
    kind: "provider-current",
    description:
      "Search results, metadata, statistics, visibility, comments, and moderation state reflect the YouTube Data API at request time and may change later.",
  },
  limitations: [
    "Search ranking and result availability are provider-defined; bounded pages and quota do not guarantee exhaustive topic coverage.",
    "Search and detail operations consume project quota under the provider's current quota policy, which can change independently of this connector.",
    "search.list uses the provider's separate Search Queries quota bucket; the available call allocation is project-specific and must be checked outside this connector.",
    "Public statistics can be hidden, delayed, rounded, disabled, or absent and are not stable measurements of audience or opinion.",
    "YouTube changed the public viewCount definition on August 24, 2026, so comparisons spanning that date require an explicit metric-break caveat.",
    "commentThreads.list may embed only a subset of replies; this connector uses comments.list when replies are requested, but page and record caps can still truncate them.",
    "Comments can be disabled, deleted, held, moderated, or unavailable and can contain personal, sensitive, deceptive, or unsafe content.",
    "The connector returns metadata and text only; it does not download video/audio, captions, transcripts, thumbnails, or channel profile content.",
  ],
  discovery: {
    source: {
      maintainedBy: "Google LLC / YouTube",
      summary:
        "Public YouTube video search metadata, enriched video details, and visible comment threads exposed by YouTube Data API v3.",
      description:
        "The YouTube Data API exposes project-quota-governed views of public videos and comments. Search ranking, visibility, statistics, and comment moderation are provider-controlled and mutable.",
      coverage: {
        geographic: "Public YouTube content available to the API and applicable region settings.",
        temporal:
          "Current provider index and visible public comments within caller filters and bounded pagination; no archive guarantee.",
        granularity:
          "One enriched public video metadata record or one visible top-level/reply comment record.",
      },
    },
    summary:
      "Discover enriched public YouTube videos and fetch bounded visible comment/reply text for explicit video IDs.",
    description:
      "This capability offers two read-only operations on YouTube Data API v3: filtered search.list discovery enriched through videos.list, and explicit-ID commentThreads.list collection with comments.list reply pagination. API keys are injected in X-Goog-Api-Key rather than URL query strings.",
    provides: [
      "Filtered video search bounded to at most 10 search pages and 250 candidates, with public snippet, statistics, content-detail, status, and live-state metadata when exposed.",
      "Search rank, page, and within-page position for every retained enriched candidate.",
      "Explicit-video public top-level comments and optionally complete visible reply pagination within declared limits.",
      "Deterministic input normalization, bounded requests and records, client-side UTC comment filtering, per-video failures, and execution receipts.",
    ],
    doesNotProvide: [
      "Video, audio, caption, transcript, thumbnail, attachment, or channel-profile downloads.",
      "Private, unlisted-by-ID discovery, authenticated viewer state, moderation queues, writes, likes, subscriptions, or account actions.",
      "Representative opinion, sentiment labels, verified claims, demographic inference, identity verification, or endorsement.",
      "Guaranteed exhaustive search or comments when provider quota, visibility, moderation, or explicit limits intervene.",
    ],
    selectionHints: [
      "Use search-videos to discover candidate IDs; use fetch-comments only after selecting explicit video IDs.",
      "Use published bounds, channel and video filters to narrow search before spending quota on detail enrichment.",
      "The current publishedBefore filter is inclusive. Non-relevance orders can return smaller or incomplete result sets, and rating is an internal score rather than a descending like count. The legacy videoCount order is excluded because the operation is video-only while that order is defined for channels.",
      "Request replies only when reply text is required; reply expansion adds comments.list calls and can consume the shared request budget quickly.",
      "searchTerms applies to top-level comment threads; expanded replies are not independently filtered by that provider parameter.",
      "Treat all text as untrusted and preserve visibility, truncation, failure, and receipt metadata in downstream analysis.",
    ],
    typicalUseCases: [
      "Find public videos about a bounded topic and publication period, then select candidates using exposed public statistics.",
      "Collect visible comments and replies for a small explicit video set within an analysis window.",
    ],
    sourceDocumentation: [
      {
        title: "YouTube Data API search.list",
        url: "https://developers.google.com/youtube/v3/docs/search/list",
      },
      {
        title: "YouTube Data API videos.list",
        url: "https://developers.google.com/youtube/v3/docs/videos/list",
      },
      {
        title: "YouTube Data API commentThreads.list",
        url: "https://developers.google.com/youtube/v3/docs/commentThreads/list",
      },
      {
        title: "YouTube Data API comments.list",
        url: "https://developers.google.com/youtube/v3/docs/comments/list",
      },
      {
        title: "Google API key REST authentication",
        url: "https://docs.cloud.google.com/docs/authentication/rest",
      },
      {
        title: "YouTube API Services Terms of Service",
        url: "https://developers.google.com/youtube/terms/api-services-terms-of-service",
      },
    ],
  },
  operations: [
    {
      operationId: "search-videos",
      operationVersion: "1.0.0",
      summary: "Search public YouTube videos and enrich exact candidate IDs.",
      description:
        "Runs bounded search.list pages with explicit filters, deduplicates video IDs, retrieves snippet/statistics/contentDetails/status through videos.list batches, applies public-statistic thresholds, and reports stale or failed candidates.",
      inputSchema: YOUTUBE_VIDEO_SEARCH_INPUT_SCHEMA,
      outputSchema: YOUTUBE_VIDEO_SEARCH_OUTPUT_SCHEMA,
      execute: executeVideoSearch,
    },
    {
      operationId: "fetch-comments",
      operationVersion: "1.0.1",
      features: ["youtube.reply-strategy"],
      summary: "Fetch visible public comments and replies for explicit YouTube video IDs.",
      description:
        "Runs bounded commentThreads.list pages for caller-supplied IDs, optionally expands every visible reply page through comments.list, applies an optional UTC window client-side, and preserves completed videos when another video fails.",
      inputSchema: YOUTUBE_COMMENTS_INPUT_SCHEMA,
      outputSchema: YOUTUBE_COMMENTS_OUTPUT_SCHEMA,
      execute: executeCommentsFetch,
    },
  ],
};

async function executeVideoSearch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeVideoSearch(context.input as VideoSearchInput);
  if (context.limits.maxPages < 2) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube video search requires at least two operation-wide requests so one search page can be enriched through videos.list.",
    );
  }
  const observations: DataSourceObservation[] = [];
  const searchPages: Array<{ pageNumber: number; inputRecords: number; newVideoIds: number }> = [];
  const candidates: VideoSearchCandidate[] = [];
  const seenIds = new Set<string>();
  let pageToken: string | undefined;
  let requestCount = 0;
  let stopReason: "completed" | "no-results" | "max-pages" | "max-records" | "partial" =
    "completed";
  let pageNumber = 0;
  let searchFailure: unknown;
  const candidateLimit = Math.min(context.limits.maxRecords, MAX_VIDEO_CANDIDATES);

  while (requestCount < context.limits.maxPages && pageNumber < query.maxSearchPages) {
    pageNumber += 1;
    requestCount += 1;
    try {
      const response = await context.http.request({
        endpointId: "youtube-data-api",
        method: "GET",
        path: SEARCH_PATH,
        query: searchParameters(query, pageToken),
        credentialId: "api-key",
      });
      observations.push({ ...response.observation, sourceId: `search:page:${pageNumber}` });
      const parsed = parseVideoSearchPage(response.json());
      let newVideoIds = 0;
      let recordLimitDiscarded = false;
      for (const [position, videoId] of parsed.videoIds.entries()) {
        if (seenIds.has(videoId)) continue;
        seenIds.add(videoId);
        if (candidates.length >= candidateLimit) {
          recordLimitDiscarded = true;
          continue;
        }
        candidates.push({
          videoId,
          searchRank: candidates.length + 1,
          searchPage: pageNumber,
          searchPosition: position + 1,
        });
        newVideoIds += 1;
      }
      searchPages.push({ pageNumber, inputRecords: parsed.videoIds.length, newVideoIds });
      if (candidates.length >= candidateLimit) {
        stopReason = recordLimitDiscarded || parsed.nextPageToken ? "max-records" : "completed";
        break;
      }
      if (!parsed.nextPageToken) {
        stopReason = candidates.length === 0 ? "no-results" : "completed";
        break;
      }
      if (parsed.nextPageToken === pageToken) {
        throw providerInvalid("YouTube search returned a repeated page token.");
      }
      pageToken = parsed.nextPageToken;
      if (pageNumber >= query.maxSearchPages) {
        stopReason = "max-pages";
        break;
      }
      const projectedCandidateCount = Math.min(candidateLimit, candidates.length + query.pageSize);
      const reservedDetailRequests = Math.ceil(projectedCandidateCount / VIDEO_DETAIL_BATCH_SIZE);
      if (requestCount + 1 + reservedDetailRequests > context.limits.maxPages) {
        stopReason = "max-pages";
        break;
      }
    } catch (error) {
      if (searchPages.length === 0) throw normalizeProviderFailure(error);
      searchFailure = error;
      stopReason = "partial";
      break;
    }
  }

  const records: VideoRecord[] = [];
  const filteredOut: Array<{ videoId: string; reason: string }> = [];
  const failures: Array<{ videoIds: string[]; code: string }> = [];
  const failureValues: unknown[] = [];
  const remainingCandidates = [...candidates];
  let detailBatchCount = 0;
  while (remainingCandidates.length > 0 && requestCount < context.limits.maxPages) {
    const batch = remainingCandidates.splice(0, VIDEO_DETAIL_BATCH_SIZE);
    const batchIds = batch.map((candidate) => candidate.videoId);
    requestCount += 1;
    detailBatchCount += 1;
    try {
      const response = await context.http.request({
        endpointId: "youtube-data-api",
        method: "GET",
        path: VIDEOS_PATH,
        query: {
          part: "snippet,statistics,contentDetails,status,liveStreamingDetails",
          id: batchIds.join(","),
          maxResults: batchIds.length,
        },
        credentialId: "api-key",
      });
      observations.push({
        ...response.observation,
        sourceId: `videos:${batchIds[0]}:${batchIds.length}`,
      });
      const details = parseVideoDetails(response.json(), batchIds);
      const byId = new Map(details.map((record) => [record.videoId, record]));
      const missingBatchIds: string[] = [];
      for (const candidate of batch) {
        const record = byId.get(candidate.videoId);
        if (!record) {
          missingBatchIds.push(candidate.videoId);
          continue;
        }
        const reason = videoFilterReason(record, query);
        if (reason) filteredOut.push({ videoId: candidate.videoId, reason });
        else records.push({ ...record, ...candidate });
      }
      if (missingBatchIds.length > 0) {
        const missingError = providerInvalid(
          "YouTube videos.list omitted one or more requested candidate IDs.",
        );
        failures.push({ videoIds: missingBatchIds, code: missingError.code });
        failureValues.push(missingError);
      }
    } catch (error) {
      const normalized = normalizeProviderFailure(error);
      failures.push({ videoIds: batchIds, code: normalized.code });
      failureValues.push(normalized);
    }
  }
  if (remainingCandidates.length > 0) {
    throw new DataRuntimeError(
      "invalid-request",
      "The operation-wide request limit left discovered YouTube candidates without required detail enrichment.",
    );
  }

  const truncated = stopReason === "max-pages" || stopReason === "max-records";
  const partial = searchFailure !== undefined || failures.length > 0;
  if (partial) stopReason = "partial";
  if (records.length === 0 && failures.length > 0 && filteredOut.length === 0) {
    throw failureValues[0];
  }
  const missingIds = failures.flatMap((failure) => failure.videoIds);
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message:
            searchFailure === undefined
              ? "Some YouTube video-detail batches could not be retrieved or validated."
              : "A later YouTube search page could not be retrieved or validated.",
          retryable: [searchFailure, ...failureValues].some(
            (value) => value instanceof DataRuntimeError && (value.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: {
            ...(missingIds.length > 0 ? { missingVideoIds: missingIds } : {}),
            ...(searchFailure === undefined ? {} : { failedSearchPage: pageNumber }),
          },
        },
      ]
    : [];
  const missing = [
    ...(missingIds.length > 0 ? [{ kind: "range" as const, identifiers: missingIds }] : []),
    ...(searchFailure === undefined
      ? []
      : [{ kind: "page" as const, identifiers: [String(pageNumber)] }]),
  ];
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor("metadata"),
      query,
      searchPages,
      records,
      filteredOut,
      failures,
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: observations.length,
      chunkCount: detailBatchCount,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(missing.length > 0 ? { missing } : {}),
    },
    warnings: [
      "YouTube search ranking, visibility, metadata, and public statistics are mutable provider snapshots.",
      "YouTube search.list consumes the provider's separate Search Queries quota bucket; project-specific availability is not inferred from this result.",
      "YouTube changed the public viewCount definition on August 24, 2026; comparisons spanning that date require a metric-break caveat.",
      "Video and engagement metadata must not be treated as representative public opinion, endorsement, verified identity, or factual verification.",
      ...(query.order === "relevance"
        ? []
        : [
            "YouTube warns that non-relevance ordering can return a smaller or incomplete result set, especially with publication-date filters.",
          ]),
      ...(truncated ? ["The result stopped at an explicit request or record limit."] : []),
    ],
    errors,
    observations,
  };
}

async function executeCommentsFetch(
  context: DataOperationExecutionContext,
): Promise<DataOperationExecution> {
  const query = normalizeCommentsQuery(context.input as CommentsInput);
  const records: CommentRecord[] = [];
  const seenComments = new Set<string>();
  const observations: DataSourceObservation[] = [];
  const videos: Array<{
    videoId: string;
    threadPages: number;
    replyPages: number;
    threads: number;
    comments: number;
    truncated: boolean;
  }> = [];
  const failures: Array<{ videoId: string; code: string }> = [];
  const failureValues: unknown[] = [];
  const knownThreadsWithReplies = new Set<string>();
  const fullyExpandedThreads = new Set<string>();
  let requestCount = 0;
  let threadRequestCount = 0;
  let replyRequestCount = 0;
  let truncationReason: "max-pages" | "max-records" | null = null;
  let globalStop = false;

  for (const [videoIndex, videoId] of query.videoIds.entries()) {
    if (requestCount >= context.limits.maxPages) {
      truncationReason ??= "max-pages";
      globalStop = true;
      break;
    }
    if (records.length >= context.limits.maxRecords) {
      truncationReason = "max-records";
      globalStop = true;
      break;
    }
    const startCount = records.length;
    const videoSummary = {
      videoId,
      threadPages: 0,
      replyPages: 0,
      threads: 0,
      comments: 0,
      truncated: false,
    };
    let nextThreadPageToken: string | undefined;
    try {
      for (let threadPage = 1; threadPage <= query.maxThreadPagesPerVideo; threadPage += 1) {
        if (requestCount >= context.limits.maxPages) {
          videoSummary.truncated = true;
          truncationReason ??= "max-pages";
          globalStop = true;
          break;
        }
        requestCount += 1;
        threadRequestCount += 1;
        const response = await context.http.request({
          endpointId: "youtube-data-api",
          method: "GET",
          path: COMMENT_THREADS_PATH,
          query: {
            part: "snippet",
            videoId,
            maxResults: query.pageSize,
            order: query.order,
            textFormat: "plainText",
            ...(query.searchTerms ? { searchTerms: query.searchTerms } : {}),
            ...(nextThreadPageToken ? { pageToken: nextThreadPageToken } : {}),
          },
          credentialId: "api-key",
        });
        observations.push({
          ...response.observation,
          sourceId: `comments:${videoId}:page:${threadPage}`,
        });
        videoSummary.threadPages += 1;
        const page = parseCommentThreadsPage(response.json(), videoId);
        for (const thread of page.threads) {
          if (records.length >= context.limits.maxRecords) {
            videoSummary.truncated = true;
            truncationReason = "max-records";
            globalStop = true;
            break;
          }
          videoSummary.threads += 1;
          if (insideCommentWindow(thread.topLevel, query)) {
            addComment(records, seenComments, thread.topLevel, context.limits.maxRecords);
          }
          if (records.length >= context.limits.maxRecords) {
            videoSummary.truncated = true;
            truncationReason = "max-records";
            globalStop = true;
            break;
          }
          if (thread.totalReplyCount === 0) continue;
          knownThreadsWithReplies.add(thread.threadId);
          if (!query.includeReplies) {
            continue;
          }

          let nextReplyPageToken: string | undefined;
          let replyExpansionComplete = false;
          for (let replyPage = 1; replyPage <= query.maxReplyPagesPerThread; replyPage += 1) {
            if (
              requestCount >= context.limits.maxPages ||
              records.length >= context.limits.maxRecords
            ) {
              videoSummary.truncated = true;
              truncationReason =
                records.length >= context.limits.maxRecords
                  ? "max-records"
                  : (truncationReason ?? "max-pages");
              globalStop = true;
              break;
            }
            requestCount += 1;
            replyRequestCount += 1;
            const replyResponse = await context.http.request({
              endpointId: "youtube-data-api",
              method: "GET",
              path: COMMENTS_PATH,
              query: {
                part: "snippet",
                parentId: thread.topLevel.commentId,
                maxResults: query.pageSize,
                textFormat: "plainText",
                ...(nextReplyPageToken ? { pageToken: nextReplyPageToken } : {}),
              },
              credentialId: "api-key",
            });
            observations.push({
              ...replyResponse.observation,
              sourceId: `replies:${thread.topLevel.commentId}:page:${replyPage}`,
            });
            videoSummary.replyPages += 1;
            const replyResult = parseRepliesPage(
              replyResponse.json(),
              videoId,
              thread.threadId,
              thread.topLevel.commentId,
            );
            for (const reply of replyResult.records) {
              if (records.length >= context.limits.maxRecords) break;
              if (insideCommentWindow(reply, query)) {
                addComment(records, seenComments, reply, context.limits.maxRecords);
              }
              if (records.length >= context.limits.maxRecords) {
                videoSummary.truncated = true;
                truncationReason = "max-records";
                globalStop = true;
                break;
              }
            }
            if (globalStop) break;
            if (!replyResult.nextPageToken) {
              replyExpansionComplete = true;
              break;
            }
            if (replyResult.nextPageToken === nextReplyPageToken) {
              throw providerInvalid("YouTube replies returned a repeated page token.");
            }
            nextReplyPageToken = replyResult.nextPageToken;
            if (replyPage >= query.maxReplyPagesPerThread) {
              videoSummary.truncated = true;
              truncationReason ??= "max-pages";
            }
          }
          if (replyExpansionComplete) fullyExpandedThreads.add(thread.threadId);
          if (globalStop) break;
        }
        if (globalStop) break;
        if (!page.nextPageToken) break;
        if (page.nextPageToken === nextThreadPageToken) {
          throw providerInvalid("YouTube comment threads returned a repeated page token.");
        }
        nextThreadPageToken = page.nextPageToken;
        if (threadPage >= query.maxThreadPagesPerVideo) {
          videoSummary.truncated = true;
          truncationReason ??= "max-pages";
        }
      }
    } catch (error) {
      const normalized = normalizeProviderFailure(error);
      failures.push({ videoId, code: normalized.code });
      failureValues.push(normalized);
    }
    videoSummary.comments = records.length - startCount;
    videos.push(videoSummary);
    if (globalStop && videoIndex < query.videoIds.length - 1) break;
  }

  const blockingFailure = failureValues.find((failure) => !isCommentsDisabledFailure(failure));
  if (records.length === 0 && blockingFailure) throw blockingFailure;
  const partial = failures.length > 0;
  const stopReason = partial
    ? "partial"
    : (truncationReason ?? (records.length === 0 ? "no-results" : "completed"));
  const missingVideoIds = failures.map((failure) => failure.videoId);
  const errors: DataMachineError[] = partial
    ? [
        {
          code: "partial-result",
          message: "Some YouTube videos or reply pages could not be retrieved or validated.",
          retryable: failureValues.some(
            (value) => value instanceof DataRuntimeError && (value.options.retryable ?? false),
          ),
          userActionRequired: false,
          details: {
            missingVideoIds,
            causeCodes: [...new Set(failures.map((failure) => failure.code))],
            failureDiagnostics: failureValues.map((failure, index) => ({
              videoId: failures[index]!.videoId,
              code: failures[index]!.code,
              ...safeFailureTelemetry(failure),
            })),
          },
        },
      ]
    : [];
  const truncated = truncationReason !== null;
  const completeReplies = query.includeReplies && !truncated && !partial;
  const knownUnexpandedThreadIds = [...knownThreadsWithReplies].filter(
    (threadId) => !fullyExpandedThreads.has(threadId),
  );
  return {
    status: partial ? "partial" : "success",
    data: {
      source: sourceDescriptor("comments"),
      query,
      videos,
      records,
      failures,
      requestBudget: {
        maxRequests: context.limits.maxPages,
        usedRequests: requestCount,
        threadRequests: threadRequestCount,
        replyRequests: replyRequestCount,
        remainingRequests: Math.max(0, context.limits.maxPages - requestCount),
      },
      replyCompleteness: {
        requested: query.includeReplies,
        strategy: query.includeReplies ? "comments-list-pagination" : "not-requested",
        completeWithinLimits: completeReplies,
        knownThreadsWithReplies: knownThreadsWithReplies.size,
        fullyExpandedThreads: fullyExpandedThreads.size,
        knownUnexpandedThreadIds,
      },
      stopReason,
    },
    summary: {
      recordCount: records.length,
      pageCount: observations.length,
      chunkCount: videos.length,
      truncated,
      completeness: partial ? "partial" : "complete",
      ...(partial ? { missing: [{ kind: "range" as const, identifiers: missingVideoIds }] } : {}),
    },
    warnings: [
      "YouTube comments are mutable user-generated content and can contain personal, sensitive, deceptive, or unsafe material.",
      "Visible comments are self-selected and moderation-dependent; they must not be treated as representative opinion or statistically valid sentiment.",
      ...(query.includeReplies
        ? [
            "Replies were read with comments.list rather than the incomplete embedded sample, but explicit request and record limits can still truncate them.",
          ]
        : [
            `Replies were not requested; ${knownUnexpandedThreadIds.length} known thread(s) have replies that were not expanded, and top-level comments do not represent the full conversation.`,
          ]),
      ...(query.searchTerms
        ? [
            "The provider searchTerms filter applies to top-level comment threads; expanded replies were not independently term-filtered.",
          ]
        : []),
      ...(truncated ? ["The comment result stopped at an explicit request or record limit."] : []),
    ],
    errors,
    observations,
  };
}

function normalizeVideoSearch(input: VideoSearchInput): NormalizedVideoSearch {
  const publishedAfter = input.publishedAfter ? exactDateTime(input.publishedAfter) : null;
  const publishedBefore = input.publishedBefore ? exactDateTime(input.publishedBefore) : null;
  if (publishedAfter && publishedBefore && publishedAfter >= publishedBefore) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube publishedAfter must precede publishedBefore.",
    );
  }
  return {
    query: nonBlankInput(input.query, "YouTube search query"),
    channelId: nullableText(input.channelId),
    publishedAfter,
    publishedBefore,
    order: input.order ?? "relevance",
    regionCode: nullableText(input.regionCode),
    relevanceLanguage: nullableText(input.relevanceLanguage),
    safeSearch: input.safeSearch ?? "moderate",
    videoCaption: input.videoCaption ?? null,
    videoDefinition: input.videoDefinition ?? null,
    videoDimension: input.videoDimension ?? null,
    videoDuration: input.videoDuration ?? null,
    videoEmbeddable: input.videoEmbeddable ?? null,
    videoEventType: input.videoEventType ?? null,
    videoLicense: input.videoLicense ?? null,
    videoPaidProductPlacement: input.videoPaidProductPlacement ?? null,
    videoSyndicated: input.videoSyndicated ?? null,
    videoType: input.videoType ?? null,
    pageSize: input.pageSize ?? 25,
    maxSearchPages: input.maxSearchPages ?? 5,
    requirePublicComments: input.requirePublicComments ?? true,
    minimumCommentCount: input.minimumCommentCount ?? 0,
    minimumViewCount: input.minimumViewCount ?? 0,
  };
}

function searchParameters(
  query: NormalizedVideoSearch,
  pageToken: string | undefined,
): Record<string, number | string> {
  return {
    part: "snippet",
    type: "video",
    q: query.query,
    order: query.order,
    safeSearch: query.safeSearch,
    maxResults: query.pageSize,
    ...(pageToken ? { pageToken } : {}),
    ...(query.channelId ? { channelId: query.channelId } : {}),
    ...(query.publishedAfter ? { publishedAfter: query.publishedAfter } : {}),
    ...(query.publishedBefore ? { publishedBefore: query.publishedBefore } : {}),
    ...(query.regionCode ? { regionCode: query.regionCode } : {}),
    ...(query.relevanceLanguage ? { relevanceLanguage: query.relevanceLanguage } : {}),
    ...(query.videoCaption ? { videoCaption: query.videoCaption } : {}),
    ...(query.videoDefinition ? { videoDefinition: query.videoDefinition } : {}),
    ...(query.videoDimension ? { videoDimension: query.videoDimension } : {}),
    ...(query.videoDuration ? { videoDuration: query.videoDuration } : {}),
    ...(query.videoEmbeddable ? { videoEmbeddable: query.videoEmbeddable } : {}),
    ...(query.videoEventType ? { eventType: query.videoEventType } : {}),
    ...(query.videoLicense ? { videoLicense: query.videoLicense } : {}),
    ...(query.videoPaidProductPlacement
      ? { videoPaidProductPlacement: query.videoPaidProductPlacement }
      : {}),
    ...(query.videoSyndicated ? { videoSyndicated: query.videoSyndicated } : {}),
    ...(query.videoType ? { videoType: query.videoType } : {}),
  };
}

function parseVideoSearchPage(value: unknown): { videoIds: string[]; nextPageToken?: string } {
  const root = object(value, "YouTube search response");
  if (!Array.isArray(root.items)) throw providerInvalid("YouTube search items are missing.");
  const videoIds = root.items.map((item) => {
    const id = object(object(item, "YouTube search item").id, "YouTube search item ID");
    return requiredVideoId(id.videoId, "YouTube search video ID");
  });
  return { videoIds, ...optionalPageToken(root.nextPageToken) };
}

function parseVideoDetails(value: unknown, requestedIds: string[]): VideoDetailRecord[] {
  const root = object(value, "YouTube videos response");
  if (!Array.isArray(root.items)) throw providerInvalid("YouTube video-detail items are missing.");
  const requested = new Set(requestedIds);
  const seen = new Set<string>();
  return root.items.map((item) => {
    const record = object(item, "YouTube video detail");
    const videoId = requiredVideoId(record.id, "YouTube video ID");
    if (!requested.has(videoId)) {
      throw providerInvalid("YouTube videos.list returned an unrequested video ID.");
    }
    if (seen.has(videoId)) throw providerInvalid("YouTube returned a duplicate video detail.");
    seen.add(videoId);
    const snippet = objectOrEmpty(record.snippet);
    const statistics = objectOrEmpty(record.statistics);
    const contentDetails = objectOrEmpty(record.contentDetails);
    const status = objectOrEmpty(record.status);
    const liveStreamingDetails = objectOrEmpty(record.liveStreamingDetails);
    return {
      videoId,
      publishedAt: optionalDateTime(snippet.publishedAt),
      channelId: optionalString(snippet.channelId),
      channelTitle: optionalString(snippet.channelTitle),
      title: typeof snippet.title === "string" ? snippet.title : "",
      description: typeof snippet.description === "string" ? snippet.description : "",
      tags: stringArray(snippet.tags),
      thumbnailUrls: httpsUrlsFromObject(snippet.thumbnails),
      categoryId: optionalString(snippet.categoryId),
      defaultLanguage: optionalString(snippet.defaultLanguage),
      defaultAudioLanguage: optionalString(snippet.defaultAudioLanguage),
      liveBroadcastContent: optionalString(snippet.liveBroadcastContent),
      statistics: {
        viewCount: numericString(statistics.viewCount),
        likeCount: numericString(statistics.likeCount),
        commentCount: numericString(statistics.commentCount),
      },
      contentDetails: {
        duration: optionalString(contentDetails.duration),
        caption: optionalString(contentDetails.caption),
        definition: optionalString(contentDetails.definition),
        dimension: optionalString(contentDetails.dimension),
        licensedContent: optionalBoolean(contentDetails.licensedContent),
        projection: optionalString(contentDetails.projection),
      },
      status: {
        privacyStatus: optionalString(status.privacyStatus),
        embeddable: optionalBoolean(status.embeddable),
        license: optionalString(status.license),
        madeForKids: optionalBoolean(status.madeForKids),
        selfDeclaredMadeForKids: optionalBoolean(status.selfDeclaredMadeForKids),
      },
      liveStreamingDetails: {
        actualStartTime: optionalDateTime(liveStreamingDetails.actualStartTime),
        actualEndTime: optionalDateTime(liveStreamingDetails.actualEndTime),
        scheduledStartTime: optionalDateTime(liveStreamingDetails.scheduledStartTime),
        scheduledEndTime: optionalDateTime(liveStreamingDetails.scheduledEndTime),
      },
    };
  });
}

function videoFilterReason(record: VideoDetailRecord, query: NormalizedVideoSearch): string | null {
  const comments = record.statistics.commentCount;
  const views = record.statistics.viewCount;
  if (query.requirePublicComments && (comments === null || comments === 0)) {
    return "public-comments-unavailable";
  }
  if (
    query.minimumCommentCount > 0 &&
    (comments === null || comments < query.minimumCommentCount)
  ) {
    return "below-minimum-comment-count";
  }
  if (query.minimumViewCount > 0 && (views === null || views < query.minimumViewCount)) {
    return "below-minimum-view-count";
  }
  return null;
}

function normalizeCommentsQuery(input: CommentsInput): NormalizedCommentsQuery {
  const startDateTime = input.startDateTime ? exactDateTime(input.startDateTime) : null;
  const endDateTime = input.endDateTime ? exactDateTime(input.endDateTime) : null;
  if ((startDateTime === null) !== (endDateTime === null)) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube comment startDateTime and endDateTime must be provided together.",
    );
  }
  if (startDateTime && endDateTime && startDateTime >= endDateTime) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube comment startDateTime must precede endDateTime.",
    );
  }
  const videoIds = input.videoIds.map(videoIdInput);
  if (new Set(videoIds).size !== videoIds.length) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube video IDs must remain unique after whitespace normalization.",
    );
  }
  const replyStrategy =
    input.replyStrategy ?? (input.includeReplies === false ? "top-level-only" : "all-visible");
  if (
    input.includeReplies !== undefined &&
    input.includeReplies !== (replyStrategy === "all-visible")
  ) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube includeReplies and replyStrategy must describe the same reply policy.",
    );
  }
  return {
    videoIds,
    startDateTime,
    endDateTime,
    timeField: input.timeField ?? "published",
    includeReplies: replyStrategy === "all-visible",
    replyStrategy,
    searchTerms: nullableText(input.searchTerms),
    order: input.order ?? "time",
    pageSize: input.pageSize ?? 100,
    maxThreadPagesPerVideo: input.maxThreadPagesPerVideo ?? 10,
    maxReplyPagesPerThread: input.maxReplyPagesPerThread ?? 20,
  };
}

function safeFailureTelemetry(error: unknown): Record<string, boolean | number | string> {
  if (!(error instanceof DataRuntimeError)) return {};
  const result: Record<string, boolean | number | string> = {};
  for (const key of ["attempts", "phase", "redirects", "retries", "status"] as const) {
    const value = error.options.details?.[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function parseCommentThreadsPage(
  value: unknown,
  requestedVideoId: string,
): {
  threads: Array<{ threadId: string; topLevel: CommentRecord; totalReplyCount: number }>;
  nextPageToken?: string;
} {
  const root = object(value, "YouTube commentThreads response");
  if (!Array.isArray(root.items))
    throw providerInvalid("YouTube comment-thread items are missing.");
  const threads = root.items.map((item) => {
    const record = object(item, "YouTube comment thread");
    const threadId = requiredText(record.id, "YouTube comment-thread ID");
    const snippet = object(record.snippet, "YouTube comment-thread snippet");
    const topLevel = object(snippet.topLevelComment, "YouTube top-level comment");
    const topSnippet = object(topLevel.snippet, "YouTube top-level comment snippet");
    const videoId = optionalString(snippet.videoId) ?? optionalString(topSnippet.videoId);
    if (videoId && videoId !== requestedVideoId) {
      throw providerInvalid("YouTube comment thread belongs to an unexpected video.");
    }
    return {
      threadId,
      topLevel: normalizeComment(topLevel, threadId, requestedVideoId, "top-level"),
      totalReplyCount: nonNegativeInteger(snippet.totalReplyCount) ?? 0,
    };
  });
  return { threads, ...optionalPageToken(root.nextPageToken) };
}

function parseRepliesPage(
  value: unknown,
  videoId: string,
  threadId: string,
  parentCommentId: string,
): { records: CommentRecord[]; nextPageToken?: string } {
  const root = object(value, "YouTube comments response");
  if (!Array.isArray(root.items)) throw providerInvalid("YouTube reply items are missing.");
  return {
    records: root.items.map((item) =>
      normalizeComment(item, threadId, videoId, "reply", parentCommentId),
    ),
    ...optionalPageToken(root.nextPageToken),
  };
}

function normalizeComment(
  value: unknown,
  threadId: string,
  videoId: string,
  kind: "top-level" | "reply",
  expectedParentId: string | null = null,
): CommentRecord {
  const root = object(value, "YouTube comment");
  const snippet = object(root.snippet, "YouTube comment snippet");
  const authorChannelId = objectOrEmpty(snippet.authorChannelId);
  const providerVideoId = optionalString(snippet.videoId);
  if (providerVideoId && providerVideoId !== videoId) {
    throw providerInvalid("YouTube comment belongs to an unexpected video.");
  }
  const parentId = kind === "reply" ? optionalString(snippet.parentId) : null;
  if (kind === "reply" && parentId !== expectedParentId) {
    throw providerInvalid("YouTube reply belongs to an unexpected parent comment.");
  }
  return {
    commentId: requiredText(root.id, "YouTube comment ID"),
    threadId,
    videoId,
    parentId,
    kind,
    channelId: optionalString(snippet.channelId),
    authorDisplayName: optionalString(snippet.authorDisplayName),
    authorChannelId: optionalString(authorChannelId.value),
    authorChannelUrl: optionalString(snippet.authorChannelUrl),
    authorProfileImageUrl: optionalString(snippet.authorProfileImageUrl),
    textDisplay: typeof snippet.textDisplay === "string" ? snippet.textDisplay : "",
    textOriginal: optionalString(snippet.textOriginal),
    publishedAt: optionalDateTime(snippet.publishedAt),
    updatedAt: optionalDateTime(snippet.updatedAt),
    likeCount: nonNegativeInteger(snippet.likeCount),
    viewerRating: optionalString(snippet.viewerRating),
    canRate: optionalBoolean(snippet.canRate),
  };
}

function insideCommentWindow(record: CommentRecord, query: NormalizedCommentsQuery): boolean {
  if (!query.startDateTime && !query.endDateTime) return true;
  const value = query.timeField === "published" ? record.publishedAt : record.updatedAt;
  if (!value) return false;
  if (query.startDateTime && value < query.startDateTime) return false;
  return !(query.endDateTime && value >= query.endDateTime);
}

function addComment(
  records: CommentRecord[],
  seen: Set<string>,
  record: CommentRecord,
  maxRecords: number,
): void {
  if (records.length >= maxRecords || seen.has(record.commentId)) return;
  seen.add(record.commentId);
  records.push(record);
}

function sourceDescriptor(mode: "metadata" | "comments") {
  return mode === "metadata"
    ? {
        providerId: "youtube" as const,
        apiVersion: "v3" as const,
        metadataOnly: true as const,
        userGeneratedContent: true as const,
      }
    : {
        providerId: "youtube" as const,
        apiVersion: "v3" as const,
        publicComments: true as const,
        userGeneratedContent: true as const,
      };
}

function exactDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube datetime values must be valid UTC timestamps.",
    );
  }
  return parsed.toISOString();
}

function nullableText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function nonBlankInput(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DataRuntimeError("invalid-request", `${label} must not be blank.`);
  return normalized;
}

function videoIdInput(value: string): string {
  const normalized = nonBlankInput(value, "YouTube video ID");
  if (!VIDEO_ID_PATTERN.test(normalized)) {
    throw new DataRuntimeError(
      "invalid-request",
      "YouTube video IDs must contain exactly 11 URL-safe identifier characters.",
    );
  }
  return normalized;
}

function optionalDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function optionalPageToken(value: unknown): { nextPageToken?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value) throw providerInvalid("YouTube page token is invalid.");
  return { nextPageToken: value };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw providerInvalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw providerInvalid(`${label} is missing.`);
  return value.trim();
}

function requiredVideoId(value: unknown, label: string): string {
  const normalized = requiredText(value, label);
  if (!VIDEO_ID_PATTERN.test(normalized)) {
    throw providerInvalid(`${label} must contain exactly 11 URL-safe identifier characters.`);
  }
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function httpsUrlsFromObject(value: unknown): string[] {
  const source = objectOrEmpty(value);
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of Object.values(source)) {
    const url = optionalString(objectOrEmpty(candidate).url);
    if (!url || seen.has(url)) continue;
    try {
      if (new URL(url).protocol !== "https:") continue;
    } catch {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numericString(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeProviderFailure(error: unknown): DataRuntimeError {
  if (!(error instanceof DataRuntimeError)) {
    return providerInvalid("YouTube response could not be normalized.");
  }
  if (error.options.details?.providerReason === "commentsDisabled") {
    return new DataRuntimeError(
      "provider-response-invalid",
      "YouTube comments are unavailable for this video.",
      { details: { providerReason: "commentsDisabled" } },
    );
  }
  return error;
}

function isCommentsDisabledFailure(error: unknown): boolean {
  return (
    error instanceof DataRuntimeError &&
    error.options.details?.providerReason === "commentsDisabled"
  );
}

function providerInvalid(message: string): DataRuntimeError {
  return new DataRuntimeError("provider-response-invalid", message);
}
