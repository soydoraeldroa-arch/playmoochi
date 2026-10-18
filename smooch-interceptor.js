/**
 * Smooch — Fetch interceptor for playsmooch.com
 *
 * Monkey-patches window.fetch() to intercept Firestore invite_codes requests
 * and route them through the rate-limited validation server instead.
 *
 * Install: Add this script tag to playsmooch.com's index.html BEFORE the app bundle:
 *   <script src="/smooch-interceptor.js"></script>
 *
 * Configure: Set VALIDATION_SERVER_URL to your deployed server URL
 */

(function () {
  // === CONFIGURATION ===
  const VALIDATION_SERVER_URL = "https://your-server-url.com"; // Replace with your deployed server URL
  const FIRESTORE_PATTERN = /firestore\.googleapis\.com\/v1\/projects\/smooch-game\/databases\/\(default\)\/documents\/invite_codes/;

  // Keep reference to original fetch
  const originalFetch = window.fetch;

  // Override fetch globally
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";

    // Only intercept invite_codes requests to Firestore
    if (FIRESTORE_PATTERN.test(url)) {
      console.log("[smooch-interceptor] Intercepted invite_codes request:", url);

      // Extract the invite code from the URL
      // URL format: .../invite_codes/CODE123?key=...
      const codeMatch = url.match(/invite_codes\/([A-Z0-9]+)(\?|$)/);
      if (!codeMatch) {
        console.warn("[smooch-interceptor] Could not extract code from URL");
        return originalFetch.apply(this, arguments);
      }

      const code = codeMatch[1];

      // Check if this is a GET request (read) or other method
      const method = init?.method || (typeof input === "object" && input.method) || "GET";

      if (method === "GET") {
        // Validate through our rate-limited server
        try {
          const response = await fetch(`${VALIDATION_SERVER_URL}/api/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          });

          const result = await response.json();
          console.log("[smooch-interceptor] Validation result:", result);

          if (result.success) {
            // Code is valid — return a success response that the app expects
            return new Response(JSON.stringify({
              name: `projects/smooch-game/databases/(default)/documents/invite_codes/${code}`,
              fields: {
                tier: { stringValue: result.tier },
                consumed: { booleanValue: true },
                consumedAt: { timestampValue: new Date().toISOString() },
              },
              createTime: new Date().toISOString(),
              updateTime: new Date().toISOString(),
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } else {
            // Code invalid or rate-limited
            if (response.status === 429) {
              return new Response(JSON.stringify({
                error: {
                  code: 429,
                  message: result.error,
                  status: "RESOURCE_EXHAUSTED",
                },
              }), {
                status: 429,
                headers: { "Content-Type": "application/json" },
              });
            }

            // Return 404 for invalid codes (what Firestore would return)
            return new Response(JSON.stringify({
              error: {
                code: 404,
                message: result.error || "Code not found",
                status: "NOT_FOUND",
              },
            }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
        } catch (err) {
          console.error("[smooch-interceptor] Validation server error, falling back to direct fetch:", err.message);
          // If our server is down, fall back to direct Firestore request
          return originalFetch.apply(this, arguments);
        }
      }
    }

    // For all other requests, pass through to original fetch
    return originalFetch.apply(this, arguments);
  };

  console.log("[smooch-interceptor] Active — intercepting Firestore invite_codes requests");
})();
