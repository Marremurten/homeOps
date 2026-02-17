export async function handler(_event: unknown) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "ok",
      version: process.env.DEPLOY_VERSION || "unknown",
    }),
  };
}
