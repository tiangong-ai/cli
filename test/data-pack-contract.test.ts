import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { DATA_PUBLIC_SCHEMA_IDS, dataPublicSchemas } from "../src/data/schemas.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("data package contract", () => {
  it("emits every public JSON Schema into dist", async () => {
    const filenames = {
      catalog: "catalog.v1.json",
      coreReceipt: "core-receipt.v1.json",
      describe: "describe.v1.json",
      discovery: "discovery.v1.json",
      doctor: "doctor.v1.json",
      error: "error.v1.json",
      manifest: "manifest.v1.json",
      runRequest: "run-request.v1.json",
      runResult: "run-result.v1.json",
    } as const;
    for (const [name, filename] of Object.entries(filenames)) {
      const parsed = JSON.parse(
        await readFile(join(repositoryRoot, "dist", "data", "schemas", filename), "utf8"),
      ) as { $id: string };
      const typedName = name as keyof typeof filenames;
      assert.equal(parsed.$id, DATA_PUBLIC_SCHEMA_IDS[typedName]);
      assert.deepEqual(parsed, dataPublicSchemas[typedName]);
    }
  });

  it("emits the built-in registry and every connector contract into dist", async () => {
    const modules = [
      "data/builtins.js",
      "data/connectors/airnow-hourly-observations.js",
      "data/connectors/airnow-hourly-observations.schemas.js",
      "data/connectors/bluesky-public-posts.js",
      "data/connectors/bluesky-public-posts.schemas.js",
      "data/connectors/epa-eis-records.js",
      "data/connectors/epa-eis-records.schemas.js",
      "data/connectors/federal-register-documents.js",
      "data/connectors/federal-register-documents.schemas.js",
      "data/connectors/gdelt-doc-search.js",
      "data/connectors/gdelt-doc-search.schemas.js",
      "data/connectors/gdelt-file-feeds.js",
      "data/connectors/gdelt-file-feeds.schemas.js",
      "data/connectors/gdelt-web-ngrams.js",
      "data/connectors/gdelt-web-ngrams.schemas.js",
      "data/connectors/nasa-firms-fire.js",
      "data/connectors/nasa-firms-fire.schemas.js",
      "data/connectors/open-meteo-air-quality.js",
      "data/connectors/open-meteo-air-quality.schemas.js",
      "data/connectors/open-meteo-flood.js",
      "data/connectors/open-meteo-flood.schemas.js",
      "data/connectors/open-meteo-historical-weather.js",
      "data/connectors/open-meteo-historical-weather.schemas.js",
      "data/connectors/openaq-air-quality.js",
      "data/connectors/openaq-air-quality.schemas.js",
      "data/connectors/regulations-gov-attachments.js",
      "data/connectors/regulations-gov-attachments.schemas.js",
      "data/connectors/regulations-gov-comments.js",
      "data/connectors/regulations-gov-comments.schemas.js",
      "data/connectors/usbr-project-records.js",
      "data/connectors/usbr-project-records.schemas.js",
      "data/connectors/usbr-rise.js",
      "data/connectors/usbr-rise.schemas.js",
      "data/connectors/usgs-water-instantaneous-values.js",
      "data/connectors/usgs-water-instantaneous-values.schemas.js",
      "data/connectors/youtube-public-content.js",
      "data/connectors/youtube-public-content.schemas.js",
      "data/runtime/csv.js",
      "data/runtime/artifacts.js",
    ];
    for (const modulePath of modules) {
      await access(join(repositoryRoot, "dist", ...modulePath.split("/")));
    }
    const builtins = (await import(
      pathToFileURL(join(repositoryRoot, "dist", "data", "builtins.js")).href
    )) as {
      builtInDataRegistry: {
        catalog(): { capabilities: Array<{ capabilityId: string }> };
      };
    };
    assert.deepEqual(
      builtins.builtInDataRegistry.catalog().capabilities.map((item) => item.capabilityId),
      [
        "airnow.hourly-observations",
        "bluesky.public-posts",
        "epa.eis-records",
        "federal-register.documents",
        "gdelt.doc-search",
        "gdelt.events",
        "gdelt.gkg",
        "gdelt.mentions",
        "gdelt.web-ngrams",
        "nasa-firms.active-fire",
        "open-meteo.air-quality",
        "open-meteo.flood",
        "open-meteo.historical-weather",
        "openaq.air-quality",
        "regulations-gov.attachments",
        "regulations-gov.comments",
        "usbr.project-records",
        "usbr.rise",
        "usgs.water-instantaneous-values",
        "youtube.public-content",
      ],
    );
  });
});
