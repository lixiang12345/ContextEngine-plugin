import path from "node:path";
import { FilesystemSnapshotStore } from "./filesystem-store.js";
import { S3SnapshotStore } from "./s3-store.js";
import type { SnapshotObjectStore } from "./object-store.js";

export function snapshotStoreFromLocation(
  location: string | undefined,
  root = process.cwd(),
): SnapshotObjectStore | undefined {
  const value = location?.trim();
  if (!value) return undefined;
  if (!value.startsWith("s3://")) {
    return new FilesystemSnapshotStore(
      path.isAbsolute(value) ? value : path.resolve(root, value),
    );
  }
  const parsed = new URL(value);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Snapshot S3 location must be s3://bucket/prefix");
  }
  return new S3SnapshotStore({
    bucket: parsed.hostname,
    prefix: parsed.pathname.replace(/^\/+|\/+$/g, "") || "contextengine",
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
    endpoint:
      process.env.CONTEXTENGINE_S3_ENDPOINT || process.env.CC_S3_ENDPOINT,
    forcePathStyle: /^(1|true|yes|on)$/i.test(
      process.env.CONTEXTENGINE_S3_FORCE_PATH_STYLE ||
        process.env.CC_S3_FORCE_PATH_STYLE ||
        "",
    ),
    serverSideEncryption:
      process.env.CONTEXTENGINE_S3_SSE === "aws:kms"
        ? "aws:kms"
        : process.env.CONTEXTENGINE_S3_SSE === "AES256"
          ? "AES256"
          : undefined,
    kmsKeyId: process.env.CONTEXTENGINE_S3_KMS_KEY_ID,
  });
}
