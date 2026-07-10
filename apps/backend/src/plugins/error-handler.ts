import type { FastifyError, FastifyInstance } from "fastify";

type FieldError = { field: string; message: string };

/** Derive a human-friendly field name from an Ajv validation error. */
function fieldNameFor(error: {
  instancePath?: string;
  params?: Record<string, unknown>;
}): string {
  if (error.instancePath) {
    return error.instancePath.replace(/^\//, "").replaceAll("/", ".");
  }
  const missing = error.params?.["missingProperty"];
  return typeof missing === "string" ? missing : "";
}

/**
 * Global error handler:
 * - schema validation failures -> 422 with per-field messages
 * - errors carrying a statusCode (e.g. @fastify/sensible) -> that status
 * - everything else -> 500 (logged, message hidden)
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      const fields: FieldError[] = error.validation.map((v) => ({
        field: fieldNameFor(v),
        message: v.message ?? "invalid value",
      }));
      return reply.status(422).send({
        error: "Unprocessable Entity",
        message: "Validation failed",
        fields,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled request error");
      return reply
        .status(status)
        .send({ error: "Internal Server Error", message: "Internal Server Error" });
    }

    return reply
      .status(status)
      .send({ error: error.name || "Error", message: error.message });
  });
}
