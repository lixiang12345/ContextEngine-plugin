import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_DOCKER_CPUS = 2;
const DEFAULT_DOCKER_MEMORY_MB = 2_048;
const DEFAULT_DOCKER_PIDS_LIMIT = 256;
const DEFAULT_DOCKER_TMPFS_MB = 256;
const MIN_DOCKER_CPUS = 0.1;
const MIN_DOCKER_MEMORY_MB = 64;
const MIN_DOCKER_PIDS_LIMIT = 16;
const MIN_DOCKER_TMPFS_MB = 16;
const MAX_DOCKER_CPUS = 64;
const MAX_DOCKER_MEMORY_MB = 262_144;
const MAX_DOCKER_PIDS_LIMIT = 4_096;
const MAX_DOCKER_TMPFS_MB = 4_096;

export interface PrEvalDockerSandboxConfig {
  type: "docker";
  /** Immutable OCI image reference, including an sha256 digest. */
  image: string;
  network: "none" | "bridge";
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  tmpfsMb: number;
}

export interface PrEvalDockerCommandInput {
  sandbox: PrEvalDockerSandboxConfig;
  workspace: string;
  runDirectory: string;
  containerName: string;
  command: string[];
  environmentFile: string;
  user?: string;
}

export interface PrEvalDockerCommand {
  command: string[];
  reportedCommand: string[];
}

interface DockerCommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

type JsonObject = Record<string, unknown>;

export function parsePrEvalDockerSandbox(
  value: unknown,
  label: string,
): PrEvalDockerSandboxConfig | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, label);
  assertAllowedKeys(
    raw,
    ["type", "image", "network", "cpus", "memoryMb", "pidsLimit", "tmpfsMb"],
    label,
  );
  if (raw.type !== "docker") {
    throw new Error(`${label}.type must be \"docker\"`);
  }
  const image = immutableImageValue(raw.image, `${label}.image`);
  const network = raw.network ?? "none";
  if (network !== "none" && network !== "bridge") {
    throw new Error(`${label}.network must be \"none\" or \"bridge\"`);
  }
  return {
    type: "docker",
    image,
    network,
    cpus: boundedPositiveNumber(
      raw.cpus,
      `${label}.cpus`,
      DEFAULT_DOCKER_CPUS,
      MIN_DOCKER_CPUS,
      MAX_DOCKER_CPUS,
    ),
    memoryMb: boundedPositiveInteger(
      raw.memoryMb,
      `${label}.memoryMb`,
      DEFAULT_DOCKER_MEMORY_MB,
      MIN_DOCKER_MEMORY_MB,
      MAX_DOCKER_MEMORY_MB,
    ),
    pidsLimit: boundedPositiveInteger(
      raw.pidsLimit,
      `${label}.pidsLimit`,
      DEFAULT_DOCKER_PIDS_LIMIT,
      MIN_DOCKER_PIDS_LIMIT,
      MAX_DOCKER_PIDS_LIMIT,
    ),
    tmpfsMb: boundedPositiveInteger(
      raw.tmpfsMb,
      `${label}.tmpfsMb`,
      DEFAULT_DOCKER_TMPFS_MB,
      MIN_DOCKER_TMPFS_MB,
      MAX_DOCKER_TMPFS_MB,
    ),
  };
}

/** Build a hardened, shell-free Docker invocation for an agent run. */
export function buildPrEvalDockerCommand(
  input: PrEvalDockerCommandInput,
): PrEvalDockerCommand {
  if (!input.command.length || !input.command[0]) {
    throw new Error("Docker agent command must contain an executable");
  }
  const workspaceMount = dockerBindMount(input.workspace, "/workspace");
  const runMount = dockerBindMount(input.runDirectory, "/run");
  const common = [
    "docker",
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    input.containerName,
    "--hostname",
    "contextengine-pr-agent",
    "--network",
    input.sandbox.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(input.sandbox.pidsLimit),
    "--memory",
    `${input.sandbox.memoryMb}m`,
    "--cpus",
    String(input.sandbox.cpus),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${input.sandbox.tmpfsMb}m`,
    "--mount",
    workspaceMount,
    "--mount",
    runMount,
    "--workdir",
    "/workspace",
    "--env-file",
    path.resolve(input.environmentFile),
    "--entrypoint",
    input.command[0],
  ];
  if (input.user) common.push("--user", input.user);
  const command = [...common, input.sandbox.image, ...input.command.slice(1)];
  return { command, reportedCommand: [...command] };
}

export function dockerEnvironmentFileContent(
  environment: Record<string, string>,
): string {
  const lines = Object.entries(environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid Docker environment variable name: ${key}`);
      }
      if (/[\0\r\n]/.test(value)) {
        throw new Error(
          `Docker agent environment value for ${key} must not contain NUL or newlines`,
        );
      }
      return `${key}=${value}`;
    });
  return `${lines.join("\n")}\n`;
}

export function resolvePassedEnvironment(
  names: string[] | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (names ?? []).map((name) => {
      const value = process.env[name];
      if (value === undefined) {
        throw new Error(
          `Docker agent environment variable ${name} is allowlisted by envPass but is not set`,
        );
      }
      return [name, value];
    }),
  );
}

export function validateDockerEnvironmentNames(
  environment: Record<string, string> | undefined,
  label: string,
): void {
  const invalid = Object.keys(environment ?? {}).find(
    (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
  );
  if (invalid) {
    throw new Error(`${label} has invalid environment variable name: ${invalid}`);
  }
}

export function createDockerContainerName(runId: string): string {
  const label = safeRunLabel(runId).slice(0, 40).replace(/[._-]+$/g, "");
  return `ce-pr-${label || "run"}-${randomUUID().slice(0, 8)}`;
}

export function dockerUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

export function dockerCleanupSucceeded(result: DockerCommandOutcome): boolean {
  if (result.spawnError || result.timedOut) return false;
  if (result.exitCode === 0) return true;
  return /No such container/i.test(`${result.stdout}\n${result.stderr}`);
}

export function dockerInfrastructureError(
  result: DockerCommandOutcome,
  sandbox: PrEvalDockerSandboxConfig | undefined,
): boolean {
  return Boolean(
    sandbox &&
      result.exitCode !== null &&
      [125, 126, 127].includes(result.exitCode),
  );
}

function dockerBindMount(source: string, target: string): string {
  const resolved = path.resolve(source);
  if (resolved.includes(",") || /[\r\n]/.test(resolved)) {
    throw new Error(
      `Docker bind-mount path contains an unsupported character: ${resolved}`,
    );
  }
  return `type=bind,source=${resolved},target=${target}`;
}

function immutableImageValue(value: unknown, label: string): string {
  const image = requiredString(value, label);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/.test(image)
  ) {
    throw new Error(
      `${label} must be an immutable OCI image reference ending in @sha256:<64 lowercase hex characters>`,
    );
  }
  return image;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function assertAllowedKeys(
  value: JsonObject,
  allowed: string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function boundedPositiveInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = optionalPositiveInteger(value, label) ?? fallback;
  if (result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function boundedPositiveNumber(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeRunLabel(runId: string): string {
  return runId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}
