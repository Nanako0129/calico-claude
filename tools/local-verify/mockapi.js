// Minimal Anthropic-compatible endpoint that returns a canned streaming
// response, so the full client + render path can be exercised with no
// credentials and no network.
const http = require("node:http");

const MODEL = "claude-sonnet-4-5-20250929";

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url.split("?")[0];
    if (!url.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url } }));
      return;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    process.stderr.write(
      `REQUEST thinking=${JSON.stringify(parsed.thinking)} stream=${parsed.stream}\n`
    );

    if (!parsed.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        })
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const wantsThinking =
      parsed.thinking && (parsed.thinking.type === "enabled" || parsed.thinking.type === "adaptive");
    let index = 0;

    sse(res, "message_start", {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    });

    if (wantsThinking) {
      sse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      for (const piece of ["Let me ", "think about ", "this carefully."]) {
        sse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: piece },
        });
      }
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "mock-signature" },
      });
      sse(res, "content_block_stop", { type: "content_block_stop", index });
      index += 1;
    }

    sse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    for (const piece of ["pong", " from ", "the mock"]) {
      sse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: piece },
      });
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });

    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
});

server.listen(Number(process.argv[2] || 8787), "127.0.0.1", () => {
  process.stderr.write(`mock listening on ${server.address().port}\n`);
});
