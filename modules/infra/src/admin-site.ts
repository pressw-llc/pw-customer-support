import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Annotations,
  CfnOutput,
  Duration,
  type RemovalPolicy,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { REPO_ROOT } from "./support-stack";

export const ADMIN_DIST_DIR = join(REPO_ROOT, "modules", "admin", "dist");
export const CALLBACK_PATH = "/auth/callback";
export const SIGNED_OUT_PATH = "/signed-out";

export interface AdminOidc {
  authority: string;
  clientId: string;
  logoutUrl?: string;
}

export interface AdminSiteProps {
  apiUrl: string;
  oidc: AdminOidc;
  distDir?: string;
  removalPolicy: RemovalPolicy;
}

export function adminRuntimeConfig(
  props: Pick<AdminSiteProps, "apiUrl" | "oidc">,
): Record<string, string> {
  return {
    VITE_API_URL: props.apiUrl,
    VITE_OIDC_AUTHORITY: props.oidc.authority,
    VITE_OIDC_CLIENT_ID: props.oidc.clientId,
    ...(props.oidc.logoutUrl
      ? { VITE_OIDC_LOGOUT_URL: props.oidc.logoutUrl }
      : {}),
  };
}

export class AdminSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly origin: string;

  constructor(scope: Construct, id: string, props: AdminSiteProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        compress: true,
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: Duration.seconds(0),
      })),
    });
    this.origin = `https://${this.distribution.distributionDomainName}`;

    const distDir = props.distDir ?? ADMIN_DIST_DIR;
    const built = existsSync(join(distDir, "index.html"));
    if (!built) {
      Annotations.of(this).addWarning(
        `admin build not found at ${distDir}; run bun run build before a deploy`,
      );
    }
    new s3deploy.BucketDeployment(this, "Deployment", {
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: true,
      sources: [
        built
          ? s3deploy.Source.asset(distDir)
          : s3deploy.Source.data("index.html", "<!-- admin build missing -->"),
        s3deploy.Source.jsonData("config.json", adminRuntimeConfig(props)),
      ],
    });

    new CfnOutput(this, "AdminUrl", { value: this.origin });
    new CfnOutput(this, "AdminCallbackUrl", {
      value: `${this.origin}${CALLBACK_PATH}`,
    });
    new CfnOutput(this, "AdminSignedOutUrl", {
      value: `${this.origin}${SIGNED_OUT_PATH}`,
    });
    new CfnOutput(this, "AdminBucketName", { value: this.bucket.bucketName });
  }
}
