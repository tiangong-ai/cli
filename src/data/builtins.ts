import { createDataRegistry } from "./catalog.js";
import type { DataConnectorDefinition } from "./contracts.js";
import { airNowHourlyObservationsConnector } from "./connectors/airnow-hourly-observations.js";
import { blueskyPublicPostsConnector } from "./connectors/bluesky-public-posts.js";
import { epaEisRecordsConnector } from "./connectors/epa-eis-records.js";
import { federalRegisterDocumentsConnector } from "./connectors/federal-register-documents.js";
import { gdeltDocSearchConnector } from "./connectors/gdelt-doc-search.js";
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
  gdeltDocSearchConnector,
  gdeltEventsConnector,
  gdeltGkgConnector,
  gdeltMentionsConnector,
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
  usbrProjectRecordsConnector,
  usbrRiseConnector,
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
