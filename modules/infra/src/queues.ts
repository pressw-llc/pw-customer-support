import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  type ResourceNames,
  TRIAGE_WAKE_MAX_RECEIVES,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export const WAKE_OLDEST_AGE_ALARM_SECONDS = 15 * 60;
export const ADAPTER_OLDEST_AGE_ALARM_SECONDS = 10 * 60;
export const DLQ_RETENTION = Duration.days(14);

export interface SupportQueuesProps {
  names: ResourceNames;
  alarmEmail?: string;
}

export class SupportQueues extends Construct {
  readonly triageWakeQueue: sqs.Queue;
  readonly triageWakeDlq: sqs.Queue;
  readonly linearAdapterQueue: sqs.Queue;
  readonly linearAdapterDlq: sqs.Queue;
  readonly alarmTopic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: SupportQueuesProps) {
    super(scope, id);
    const { names } = props;

    const queue = (
      name: string,
      queueName: string,
      visibilitySeconds: number | undefined,
      dlq: sqs.Queue | undefined,
    ) =>
      new sqs.Queue(this, name, {
        queueName,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: dlq ? undefined : DLQ_RETENTION,
        visibilityTimeout:
          visibilitySeconds === undefined
            ? undefined
            : Duration.seconds(visibilitySeconds),
        deadLetterQueue: dlq
          ? { queue: dlq, maxReceiveCount: TRIAGE_WAKE_MAX_RECEIVES }
          : undefined,
      });

    this.triageWakeDlq = queue(
      "TriageWakeDlq",
      names.triageWakeDlq,
      undefined,
      undefined,
    );
    this.triageWakeQueue = queue(
      "TriageWakeQueue",
      names.triageWakeQueue,
      TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
      this.triageWakeDlq,
    );
    this.linearAdapterDlq = queue(
      "LinearAdapterDlq",
      names.linearAdapterDlq,
      undefined,
      undefined,
    );
    this.linearAdapterQueue = queue(
      "LinearAdapterQueue",
      names.linearAdapterQueue,
      LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
      this.linearAdapterDlq,
    );

    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "PressW support alarms",
      enforceSSL: true,
    });
    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(
        new subs.EmailSubscription(props.alarmEmail),
      );
    }

    this.alarmOnMessages("TriageWakeDlqMessages", this.triageWakeDlq);
    this.alarmOnMessages("LinearAdapterDlqMessages", this.linearAdapterDlq);
    this.alarmOnAge(
      "TriageWakeOldestMessage",
      this.triageWakeQueue,
      WAKE_OLDEST_AGE_ALARM_SECONDS,
    );
    this.alarmOnAge(
      "LinearAdapterOldestMessage",
      this.linearAdapterQueue,
      ADAPTER_OLDEST_AGE_ALARM_SECONDS,
    );
  }

  addAlarm(alarm: cloudwatch.Alarm): void {
    alarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));
    this.alarms.push(alarm);
  }

  private alarmOnMessages(id: string, target: sqs.Queue): void {
    this.addAlarm(
      new cloudwatch.Alarm(this, id, {
        alarmDescription: `A message sits in ${target.queueName}. Triage it with the runbook.`,
        metric: target.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        threshold: 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
  }

  private alarmOnAge(id: string, target: sqs.Queue, seconds: number): void {
    this.addAlarm(
      new cloudwatch.Alarm(this, id, {
        alarmDescription: `The oldest message in ${target.queueName} waits too long. Check the consumer.`,
        metric: target.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        threshold: seconds,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
  }
}
