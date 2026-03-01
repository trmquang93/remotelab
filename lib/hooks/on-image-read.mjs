import http from "node:http";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
]);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const json = JSON.parse(raw);
  const filePath = json?.tool_input?.file_path;
  if (!filePath) return;

  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return;

  const port = process.env.REMOTELAB_PORT || "7681";
  const body = JSON.stringify({ filePath });

  await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: "/api/image-preview",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.end(body);
  });
}

main().catch(() => process.exit(0));
