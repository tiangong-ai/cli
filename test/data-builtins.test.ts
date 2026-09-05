import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { builtInDataRegistry } from "../src/data/builtins.js";
import { runDataCommand } from "../src/data/commands.js";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      env: {},
      stdout: { write: (chunk: string) => void (stdout += chunk) },
      stderr: { write: (chunk: string) => void (stderr += chunk) },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("built-in data connectors", () => {
  it("publishes every built-in capability in deterministic order", () => {
    const capabilities = builtInDataRegistry.catalog().capabilities;
    assert.deepEqual(
      capabilities.map((item) => item.capabilityId),
      [
        "airnow.hourly-observations",
        "bluesky.public-posts",
        "epa.eis-records",
        "federal-register.documents",
        "gdelt.doc-search",
        "gdelt.events",
        "gdelt.gkg",
        "gdelt.mentions",
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
    for (const capability of capabilities) {
      assert.equal(typeof capability.summary, "string");
      assert.ok(capability.summary.length > 0);
      assert.ok(Array.isArray(capability.provides));
      assert.ok(capability.provides.length > 0);
      assert.ok(Array.isArray(capability.doesNotProvide));
      assert.match(String(capability.discoveryDigest), /^[a-f0-9]{64}$/);
      assert.equal(
        capability.availability.status,
        capability.capabilityId.startsWith("regulations-gov.") ? "suspended" : "available",
      );
    }
  });

  it("describes and diagnoses each capability offline", async () => {
    for (const capabilityId of [
      "airnow.hourly-observations",
      "bluesky.public-posts",
      "epa.eis-records",
      "federal-register.documents",
      "gdelt.doc-search",
      "gdelt.events",
      "gdelt.gkg",
      "gdelt.mentions",
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
    ]) {
      const description = builtInDataRegistry.describe(capabilityId);
      assert.equal(
        description?.operations.length,
        [
          "openaq.air-quality",
          "regulations-gov.comments",
          "usbr.rise",
          "youtube.public-content",
        ].includes(capabilityId)
          ? 2
          : 1,
      );
      const discovery = (
        builtInDataRegistry as unknown as {
          discovery(id: string):
            | {
                summary: string;
                provides: string[];
                doesNotProvide: string[];
                sourceDocumentation: Array<{ title: string; url: string }>;
                discoveryDigest: string;
              }
            | undefined;
        }
      ).discovery(capabilityId);
      assert.ok(discovery);
      assert.ok(discovery.summary.length > 0);
      assert.ok(discovery.provides.length > 0);
      assert.ok(discovery.doesNotProvide.length > 0);
      assert.ok(discovery.sourceDocumentation.length > 0);
      assert.match(discovery.discoveryDigest, /^[a-f0-9]{64}$/);
      let fetched = false;
      const capture = captureIo();
      const exitCode = await runDataCommand(["doctor", capabilityId, "--json"], capture.io, {
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("offline doctor must not fetch");
        }) as typeof fetch,
      });
      const requiresCredential = [
        "nasa-firms.active-fire",
        "openaq.air-quality",
        "youtube.public-content",
      ].includes(capabilityId);
      const suspended = capabilityId.startsWith("regulations-gov.");
      assert.equal(exitCode, requiresCredential || suspended ? 3 : 0);
      assert.equal(fetched, false);
      const doctor = JSON.parse(capture.stdout()) as {
        networkAttempted: boolean;
        status: string;
        checks: Array<{ checkId: string; status: string }>;
      };
      assert.equal(doctor.networkAttempted, false);
      assert.equal(doctor.status, requiresCredential || suspended ? "blocked" : "ready");
      if (suspended) {
        assert.ok(
          doctor.checks.some(
            (check) => check.checkId === "availability" && check.status === "fail",
          ),
        );
      }
      if (capabilityId === "nasa-firms.active-fire") {
        assert.ok(
          doctor.checks.some(
            (check) => check.checkId === "credential:map-key" && check.status === "fail",
          ),
        );
      }
      if (capabilityId === "openaq.air-quality") {
        assert.ok(
          doctor.checks.some(
            (check) => check.checkId === "credential:api-key" && check.status === "fail",
          ),
        );
      }
      if (capabilityId === "youtube.public-content") {
        assert.ok(
          doctor.checks.some(
            (check) => check.checkId === "credential:api-key" && check.status === "fail",
          ),
        );
      }
      assert.equal(capture.stderr(), "");
    }
  });

  it("keeps temporarily suspended Regulations.gov capabilities discoverable but unavailable", () => {
    for (const capabilityId of ["regulations-gov.comments", "regulations-gov.attachments"]) {
      const catalogEntry = builtInDataRegistry
        .catalog()
        .capabilities.find((item) => item.capabilityId === capabilityId);
      assert.equal(catalogEntry?.availability.status, "suspended");
      assert.equal(catalogEntry?.availability.reasonCode, "provider-live-gate-failed");
      assert.equal(builtInDataRegistry.describe(capabilityId)?.availability?.status, "suspended");
      assert.equal(builtInDataRegistry.discovery(capabilityId)?.availability?.status, "suspended");
      assert.ok(builtInDataRegistry.registered(capabilityId));
    }
  });

  it("publishes operation features required by thin Skills", () => {
    for (const capabilityId of [
      "open-meteo.air-quality",
      "open-meteo.flood",
      "open-meteo.historical-weather",
    ]) {
      assert.ok(
        builtInDataRegistry
          .describe(capabilityId)
          ?.operations[0]?.features?.includes("open-meteo.series-all-null"),
      );
    }
    assert.ok(
      builtInDataRegistry
        .describe("youtube.public-content")
        ?.operations.find((operation) => operation.operationId === "fetch-comments")
        ?.features?.includes("youtube.reply-strategy"),
    );
  });
});
