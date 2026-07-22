import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import {
  validateSnapshotObjectKey,
  type SnapshotObjectMetadata,
  type SnapshotObjectStore,
} from "./object-store.js";

export interface S3CommandClient {
  send(command: object): Promise<unknown>;
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
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
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
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    const result = (await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        ChecksumMode: "ENABLED",
      }),
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

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
      }),
    );
  }

  private key(key: string): string {
    return `${this.prefix}/${validateSnapshotObjectKey(key)}`;
  }
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
