import {
  Annotations,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export function removalFor(stage: string): RemovalPolicy {
  return stage === "production" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
}

export const AVAILABILITY_ZONES = ["us-east-1a", "us-east-1b"];

export class RegionalStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    Annotations.of(this).acknowledgeWarning(
      "CloudFormation-Validate::W3010",
      "The region is fixed, and named zones keep synth free of AWS lookups.",
    );
  }

  override get availabilityZones(): string[] {
    return AVAILABILITY_ZONES;
  }
}
