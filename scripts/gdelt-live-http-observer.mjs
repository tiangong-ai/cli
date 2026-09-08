import { subscribe } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";

// Imported only by the explicit live harness. No headers, query, body, socket
// addresses or arbitrary error prose are persisted.
const path = process.env.TIANGONG_GDELT_HTTP_OBSERVATIONS;
if (path) {
  const events = [];
  const began = performance.now();
  const starts = new WeakMap();
  const append = (event) => {
    events.push({ elapsedMs: Math.round(performance.now() - began), ...event });
    writeFileSync(path, `${JSON.stringify(events, null, 2)}\n`);
  };
  const isDoc = (request) =>
    String(request.origin) === "https://api.gdeltproject.org" &&
    request.path.startsWith("/api/v2/doc/");
  subscribe("undici:request:create", ({ request }) => {
    if (!isDoc(request)) return;
    starts.set(request, performance.now());
    append({ phase: "request-start" });
  });
  subscribe("undici:client:beforeConnect", ({ connectParams }) => {
    if (connectParams.hostname === "api.gdeltproject.org") append({ phase: "connect-start" });
  });
  subscribe("undici:client:connected", ({ connectParams }) => {
    if (connectParams.hostname === "api.gdeltproject.org") append({ phase: "connected" });
  });
  subscribe("undici:request:headers", ({ request, response }) => {
    if (!isDoc(request)) return;
    append({
      phase: "response-headers",
      status: response.statusCode,
      requestToHeadersMs: Math.round(performance.now() - starts.get(request)),
    });
  });
  subscribe("undici:request:error", ({ request, error }) => {
    if (!isDoc(request)) return;
    append({
      phase: "request-error",
      code: [
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_ABORTED",
        "ECONNRESET",
        "ETIMEDOUT",
      ].includes(error.code)
        ? error.code
        : "other",
    });
  });
}
