import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ApiConfig } from "./config";

export interface StoredObject {
  stream: ReadableStream;
  contentType: string | undefined;
}

export interface ObjectStorage {
  put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  get(key: string): Promise<StoredObject>;
}

export function createS3Storage(config: ApiConfig): ObjectStorage {
  const client = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: config.s3.endpoint !== undefined,
    credentials: config.s3.credentials,
  });
  const bucket = config.bucket;
  return {
    async put({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!result.Body) throw new Error("empty object body");
      return {
        stream: result.Body.transformToWebStream(),
        contentType: result.ContentType,
      };
    },
  };
}
