import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface CognitoSettings {
  issuer: string;
  audience: string[];
  clientId?: string;
}

export interface AdminSiteProps {
  cognito?: CognitoSettings;
  apiUrl?: string;
}

export function cognitoFromContext(
  read: (key: string) => unknown,
): CognitoSettings | undefined {
  const issuer = read("cognitoIssuer");
  const audience = read("cognitoAudience");
  if (typeof issuer !== "string" || typeof audience !== "string") {
    return undefined;
  }
  const list = audience
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return issuer && list.length > 0 ? { issuer, audience: list } : undefined;
}

export class AdminSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AdminSiteProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
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

    new CfnOutput(this, "AdminUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "AdminBucketName", { value: this.bucket.bucketName });
    if (props.cognito) {
      new CfnOutput(this, "AdminOidcAuthority", {
        value: props.cognito.issuer,
      });
      new CfnOutput(this, "AdminOidcAudience", {
        value: props.cognito.audience.join(","),
      });
    }
  }
}
