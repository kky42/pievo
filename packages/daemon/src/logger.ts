/**
 * pino-pretty is wired as a synchronous stream rather than a worker-thread
 * transport so logs flush before process.exit() in the one-shot CLI paths.
 * Writes to stderr so stdout carries only command output.
 */
import pino from "pino";
import pretty from "pino-pretty";

const level = (process.env.PIEVO_LOG_LEVEL || "info").toLowerCase();

const stream = pretty({
  destination: 2,
  colorize: true,
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
});

export const logger = pino({ level }, stream).child({ mod: "daemon" });
