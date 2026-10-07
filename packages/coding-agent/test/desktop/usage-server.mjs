import { createInterface } from "node:readline";
const expected = ["initialize", "initialized", "account/login/start", "account/rateLimits/read"];
let index = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (process.argv[2] === "stall") continue;
  const request = JSON.parse(line);
  if (request.method !== expected[index++]) process.exit(2);
  if (request.method === "account/login/start" && (request.params.type !== "chatgptAuthTokens" || request.params.accessToken !== "synthetic-never-send")) process.exit(3);
  if (request.id) process.stdout.write(`${JSON.stringify({ id: request.id, result: request.method === "account/rateLimits/read" ? { accountId: "synthetic", rateLimits: { planType: "pro" } } : {} })}\n`);
}
