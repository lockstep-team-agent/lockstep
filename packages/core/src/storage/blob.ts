/**
 * Content-addressed blob storage for skill packages (S3-compatible: Railway Buckets in production,
 * MinIO for local and self-host). Keys are `orgs/<org>/blobs/<sha256>`, so identical files are
 * stored once per org and a blob can never change under its name. Callers verify sha256 on read.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../env.js";

export interface BlobStore {
  has(orgId: string, sha256: string): Promise<boolean>;
  put(orgId: string, sha256: string, bytes: Uint8Array): Promise<void>;
  get(orgId: string, sha256: string): Promise<Uint8Array>;
  presignGet(orgId: string, sha256: string, ttlSeconds?: number): Promise<string>;
}

export class StorageNotConfigured extends Error {
  readonly statusCode = 503;
  constructor() {
    super("object storage is not configured (set BLOB_ENDPOINT, BLOB_BUCKET and keys)");
  }
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const key = (orgId: string, sha: string) => `orgs/${orgId}/blobs/${sha}`;

class S3BlobStore implements BlobStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}
  async has(orgId: string, sha: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key(orgId, sha) }));
      return true;
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }
  async put(orgId: string, sha: string, bytes: Uint8Array): Promise<void> {
    if (sha256Hex(bytes) !== sha) throw new Error("blob hash mismatch");
    if (await this.has(orgId, sha)) return; // content-addressed: already there means identical
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key(orgId, sha), Body: bytes }));
  }
  async get(orgId: string, sha: string): Promise<Uint8Array> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key(orgId, sha) }));
    const bytes = await r.Body!.transformToByteArray();
    if (sha256Hex(bytes) !== sha) throw new Error("stored blob failed its integrity check");
    return bytes;
  }
  presignGet(orgId: string, sha: string, ttlSeconds = 900): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key(orgId, sha) }), {
      expiresIn: ttlSeconds,
    });
  }
}

/** In-memory store for tests (and nothing else). */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async has(orgId: string, sha: string) {
    return this.blobs.has(key(orgId, sha));
  }
  async put(orgId: string, sha: string, bytes: Uint8Array) {
    if (sha256Hex(bytes) !== sha) throw new Error("blob hash mismatch");
    this.blobs.set(key(orgId, sha), bytes);
  }
  async get(orgId: string, sha: string) {
    const b = this.blobs.get(key(orgId, sha));
    if (!b) throw new Error("not found");
    return b;
  }
  async presignGet(orgId: string, sha: string) {
    return `memory://${key(orgId, sha)}`;
  }
}

/**
 * Local-disk store for development without S3 (BLOB_DIR). ponytail: no presigned URLs, so skill
 * sync (milestone 2) needs MinIO/S3; use this only for authoring locally.
 */
class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}
  private path = (orgId: string, sha: string) => join(this.root, key(orgId, sha));
  async has(orgId: string, sha: string) {
    return stat(this.path(orgId, sha)).then(() => true, () => false);
  }
  async put(orgId: string, sha: string, bytes: Uint8Array) {
    if (sha256Hex(bytes) !== sha) throw new Error("blob hash mismatch");
    if (await this.has(orgId, sha)) return;
    await mkdir(dirname(this.path(orgId, sha)), { recursive: true });
    await writeFile(this.path(orgId, sha), bytes);
  }
  async get(orgId: string, sha: string) {
    const bytes = new Uint8Array(await readFile(this.path(orgId, sha)));
    if (sha256Hex(bytes) !== sha) throw new Error("stored blob failed its integrity check");
    return bytes;
  }
  async presignGet(): Promise<string> {
    throw new StorageNotConfigured();
  }
}

let store: BlobStore | null = null;

export function setBlobStore(s: BlobStore | null): void {
  store = s;
}

export function blobStore(): BlobStore {
  if (store) return store;
  if (env.BLOB_DIR && !env.BLOB_ENDPOINT) return (store = new FsBlobStore(env.BLOB_DIR));
  if (!env.BLOB_ENDPOINT || !env.BLOB_BUCKET || !env.BLOB_ACCESS_KEY_ID || !env.BLOB_SECRET_ACCESS_KEY) {
    throw new StorageNotConfigured();
  }
  store = new S3BlobStore(
    new S3Client({
      endpoint: env.BLOB_ENDPOINT,
      region: env.BLOB_REGION,
      forcePathStyle: true, // MinIO and most S3-compatible endpoints
      credentials: { accessKeyId: env.BLOB_ACCESS_KEY_ID, secretAccessKey: env.BLOB_SECRET_ACCESS_KEY },
    }),
    env.BLOB_BUCKET,
  );
  return store;
}
