import { MACHINE_BODY_CAP, readJsonBody } from "./http";
import { machineRouteLimit } from "./rateLimit";

type MachineRouteOptions<T> = {
  missingCredential: string;
  invalidJsonError?: string;
  invalidBody?: T;
  parseBody: (value: unknown) => T | null;
  invalidBodyError?: string;
  handle: (token: string, body: T) => Promise<Response>;
};

export async function machineJsonRoute<T>(request: Request, options: MachineRouteOptions<T>): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const limited = machineRouteLimit(request, token || undefined);
  if (limited) return limited;
  if (!token) return Response.json({ error: options.missingCredential }, { status: 401 });

  const parsed = await readJsonBody(request, MACHINE_BODY_CAP);
  if (parsed.kind === "too-large") return Response.json({ error: "body too large" }, { status: 413 });
  if (parsed.kind !== "ok") {
    if (options.invalidBody === undefined) {
      return Response.json({ error: options.invalidJsonError ?? "invalid JSON body" }, { status: 400 });
    }
    return options.handle(token, options.invalidBody);
  }
  const body = options.parseBody(parsed.body);
  if (body === null) return Response.json({ error: options.invalidBodyError ?? "invalid request body" }, { status: 400 });
  return options.handle(token, body);
}
