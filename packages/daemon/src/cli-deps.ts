import type { PostCliDeps } from "./cli-client.js";

type CliConnectionInput = {
  fetchImpl?: typeof fetch;
  fetchFn?: typeof fetch;
  server?: string;
  token?: string;
  serverFlag?: string;
};

export function serverFlag(argv: string[]): string | undefined {
  const index = argv.indexOf("--server-url");
  return index >= 0 ? argv[index + 1] : undefined;
}

export function buildPostCliDeps(input: CliConnectionInput): PostCliDeps {
  return {
    fetchImpl: input.fetchImpl ?? input.fetchFn,
    serverFlag: input.serverFlag,
    ...(Object.prototype.hasOwnProperty.call(input, "server") ? { server: input.server } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "token") ? { deviceToken: input.token } : {}),
  };
}
