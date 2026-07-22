import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import {
  validateSnapshotObjectKey,
  type SnapshotConditionalWriteResult,
  type SnapshotObjectMetadata,
  type SnapshotObjectRequestOptions,
  type SnapshotObjectStore,
  type SnapshotObjectVersion,
  type SnapshotObjectWriteCondition,
} from "./object-store.js";

export interface S3CommandClient {
  send(
    command: object,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface S3SnapshotStoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  serverSideEncryption?: "AES256" | "aws:kms";
  kmsKeyId?: string;
  client?: S3CommandClient;
}

export class S3SnapshotStore implements SnapshotObjectStore {
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: S3CommandClient;
  private readonly encryption?: ServerSideEncryption;
  private readonly kmsKeyId?: string;

  constructor(options: S3SnapshotStoreOptions) {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      options.bucket.includes("..") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(options.bucket)
    ) {
      throw new Error("S3 snapshot bucket name is invalid");
    }
    this.bucket = options.bucket;
    this.prefix = normalizePrefix(options.prefix ?? "contextengine");
    this.encryption = options.serverSideEncryption;
    this.kmsKeyId = options.kmsKeyId;
    if (this.kmsKeyId && this.encryption !== "aws:kms") {
      throw new Error("S3 KMS key id requires aws:kms server-side encryption");
    }
    if (options.endpoint) validateEndpoint(options.endpoint);
    const config: S3ClientConfig = {
      region: options.region ?? "us-east-1",
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
    };
    this.client = options.client ?? new S3Client(config);
  }

  async put(
    key: string,
    source: Readable,
    metadata: SnapshotObjectMetadata = {},
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand(this.putInput(key, source, metadata)),
      requestOptions(options),
    );
  }

  async get(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<Readable> {
    const result = (await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        ChecksumMode: "ENABLED",
      }),
      requestOptions(options),
    )) as { Body?: unknown };
    if (!result.Body) throw new Error(`S3 snapshot object has no body: ${key}`);
    if (result.Body instanceof Readable) return result.Body;
    const body = result.Body as {
      transformToWebStream?: () => ReadableStream<Uint8Array>;
    };
    if (body.transformToWebStream) {
      return Readable.fromWeb(body.transformToWebStream() as never);
    }
    throw new Error(`S3 snapshot object body is not streamable: ${key}`);
  }

  async delete(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
      }),
      requestOptions(options),
    );
  }

  async list(
    prefix = "",
    options?: SnapshotObjectRequestOptions,
  ): Promise<string[]> {
    const normalized = prefix.replace(/\/+$/, "");
    const listedPrefix = normalized
      ? `${this.key(normalized)}/`
      : `${this.prefix}/`;
    const output: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listedPrefix,
          ContinuationToken: continuationToken,
        }),
        requestOptions(options),
      )) as {
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const item of result.Contents ?? []) {
        if (item.Key?.startsWith(`${this.prefix}/`)) {
          output.push(item.Key.slice(this.prefix.length + 1));
        }
      }
      if (result.IsTruncated && !result.NextContinuationToken) {
        throw new Error(
          "S3 snapshot listing was truncated without a continuation token",
        );
      }
      continuationToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return output;
  }

  async head(
    key: string,
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotObjectVersion | null> {
    try {
      const result = (await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        requestOptions(options),
      )) as { ETag?: string; ContentLength?: number };
      if (!result.ETag) {
        throw new Error(`S3 snapshot object has no entity tag: ${key}`);
      }
      return {
        entityTag: result.ETag,
        contentLength: result.ContentLength,
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async putConditional(
    key: string,
    source: Readable,
    condition: SnapshotObjectWriteCondition,
    metadata: SnapshotObjectMetadata = {},
    options?: SnapshotObjectRequestOptions,
  ): Promise<SnapshotConditionalWriteResult> {
    try {
      const result = (await this.client.send(
        new PutObjectCommand({
          ...this.putInput(key, source, metadata),
          ...("ifAbsent" in condition
            ? { IfNoneMatch: "*" }
            : { IfMatch: condition.entityTag }),
        }),
        requestOptions(options),
      )) as { ETag?: string };
      return { written: true, entityTag: result.ETag };
    } catch (error) {
      if (isConditionalWriteConflict(error)) {
        source.destroy();
        return { written: false };
      }
      throw error;
    }
  }

  private putInput(
    key: string,
    source: Readable,
    metadata: SnapshotObjectMetadata,
  ): ConstructorParameters<typeof PutObjectCommand>[0] {
    return {
      Bucket: this.bucket,
      Key: this.key(key),
      Body: source,
      ContentType: metadata.contentType,
      ContentEncoding: metadata.contentEncoding,
      ContentLength: metadata.contentLength,
      ChecksumSHA256: metadata.checksumSha256
        ? Buffer.from(metadata.checksumSha256, "hex").toString("base64")
        : undefined,
      ServerSideEncryption: this.encryption,
      SSEKMSKeyId: this.kmsKeyId,
    };
  }

  private key(key: string): string {
    return `${this.prefix}/${validateSnapshotObjectKey(key)}`;
  }
}

function requestOptions(
  options?: SnapshotObjectRequestOptions,
): { abortSignal?: AbortSignal } | undefined {
  return options?.signal ? { abortSignal: options.signal } : undefined;
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

function isConditionalWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === "PreconditionFailed" ||
    candidate.name === "ConditionalRequestConflict" ||
    candidate.$metadata?.httpStatusCode === 409 ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

function normalizePrefix(value: string): string {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("S3 snapshot prefix is empty");
  validateSnapshotObjectKey(`${prefix}/placeholder`);
  return prefix;
}

function validateEndpoint(value: string): void {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "S3 snapshot endpoint must be an HTTP(S) URL without credentials",
    );
  }
}
