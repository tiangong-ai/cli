import { createDataRegistry } from "./catalog.js";
import type { DataConnectorDefinition } from "./contracts.js";
import { airNowHourlyObservationsConnector } from "./connectors/airnow-hourly-observations.js";
import { blueskyPublicPostsConnector } from "./connectors/bluesky-public-posts.js";
import { epaEisRecordsConnector } from "./connectors/epa-eis-records.js";
import { federalRegisterDocumentsConnector } from "./connectors/federal-register-documents.js";
import { gdeltDocSearchConnector } from "./connectors/gdelt-doc-search.js";
import { gdeltWebNgramsConnector } from "./connectors/gdelt-web-ngrams.js";
import {
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
} from "./connectors/gdelt-file-feeds.js";
import { nasaFirmsFireConnector } from "./connectors/nasa-firms-fire.js";
import { openMeteoAirQualityConnector } from "./connectors/open-meteo-air-quality.js";
import { openMeteoFloodConnector } from "./connectors/open-meteo-flood.js";
import { openMeteoHistoricalWeatherConnector } from "./connectors/open-meteo-historical-weather.js";
import { openAqAirQualityConnector } from "./connectors/openaq-air-quality.js";
import { regulationsGovAttachmentsConnector } from "./connectors/regulations-gov-attachments.js";
import { regulationsGovCommentsConnector } from "./connectors/regulations-gov-comments.js";
import { usbrProjectRecordsConnector } from "./connectors/usbr-project-records.js";
import { usbrRiseConnector } from "./connectors/usbr-rise.js";
import { usgsWaterInstantaneousValuesConnector } from "./connectors/usgs-water-instantaneous-values.js";
import { youtubePublicContentConnector } from "./connectors/youtube-public-content.js";

export const builtInDataRegistry = createDataRegistry([
  airNowHourlyObservationsConnector,
  blueskyPublicPostsConnector,
  epaEisRecordsConnector,
  federalRegisterDocumentsConnector,
  suspendBuiltInCapability(
    gdeltDocSearchConnector,
    "The provider's legacy DOC search currently exhausts its documented pacing and retry budget under dynamic load shedding, so execution is paused while the capability remains discoverable.",
    [
      "Representative article-list and timeline requests both succeed within the declared pacing and retry bounds.",
      "A repeated live qualification run confirms that DOC responses are stable enough for Agent selection.",
    ],
  ),
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
  gdeltWebNgramsConnector,
  nasaFirmsFireConnector,
  openMeteoAirQualityConnector,
  openMeteoFloodConnector,
  openMeteoHistoricalWeatherConnector,
  openAqAirQualityConnector,
  suspendBuiltInCapability(
    regulationsGovAttachmentsConnector,
    "The provider currently returns HTTP 503 for validated production requests, so attachment execution is paused while the capability remains discoverable.",
    [
      "The Regulations.gov comment/detail live gate succeeds.",
      "A production attachment metadata and download request succeeds within the declared bounds.",
    ],
  ),
  suspendBuiltInCapability(
    regulationsGovCommentsConnector,
    "The provider currently returns HTTP 503 for validated production requests, so this capability is discoverable but execution is paused.",
    [
      "A production search request succeeds with the documented API contract.",
      "A production detail request succeeds with the documented API contract.",
    ],
  ),
  suspendBuiltInCapability(
    usbrProjectRecordsConnector,
    "The official www.usbr.gov origin currently returns a gateway-generated Request Rejected page for validated project-page requests from the supported CLI environment, so execution is paused.",
    [
      "A representative official project page returns its real HTML rather than the gateway rejection page.",
      "The project-page live gate parses a title and at least one same-origin record link.",
    ],
  ),
  suspendBuiltInCapability(
    usbrRiseConnector,
    "The official RISE legacy API and current EDR beta endpoint currently return a gateway-generated Request Rejected page from the supported CLI environment, so execution is paused.",
    [
      "The official RISE endpoint accepts a bounded catalog or location discovery request.",
      "A known-positive operational time-series request returns validated values within the declared bounds.",
    ],
  ),
  usgsWaterInstantaneousValuesConnector,
  youtubePublicContentConnector,
]);

function suspendBuiltInCapability(
  definition: DataConnectorDefinition,
  description: string,
  resumeCriteria: string[],
): DataConnectorDefinition {
  return {
    ...definition,
    availability: {
      status: "suspended",
      reasonCode: "provider-live-gate-failed",
      description,
      resumeCriteria,
    },
  };
}
