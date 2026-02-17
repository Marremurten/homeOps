import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MessageProcessingProps {
  messagesTable: dynamodb.ITable;
  activitiesTable: dynamodb.ITable;
  responseCountersTable: dynamodb.ITable;
  homeopsTable: dynamodb.ITable;
  openaiApiKeySecret: secretsmanager.ISecret;
  telegramBotTokenSecret: secretsmanager.ISecret;
}

export class MessageProcessing extends Construct {
  public readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: MessageProcessingProps) {
    super(scope, id);

    const dlq = new sqs.Queue(this, "DeadLetterQueue", {
      retentionPeriod: cdk.Duration.seconds(1209600),
    });

    this.queue = new sqs.Queue(this, "Queue", {
      visibilityTimeout: cdk.Duration.seconds(360),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const worker = new lambdaNodejs.NodejsFunction(this, "Worker", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      entry: path.join(__dirname, "../../src/handlers/worker/index.ts"),
      handler: "handler",
      bundling: {
        format: lambdaNodejs.OutputFormat.ESM,
        minify: true,
        sourceMap: true,
      },
      environment: {
        MESSAGES_TABLE_NAME: props.messagesTable.tableName,
        ACTIVITIES_TABLE_NAME: props.activitiesTable.tableName,
        RESPONSE_COUNTERS_TABLE_NAME: props.responseCountersTable.tableName,
        HOMEOPS_TABLE_NAME: props.homeopsTable.tableName,
        EMA_ALPHA: "0.3",
        EMA_ALPHA_IGNORE: "0.2",
        OPENAI_API_KEY_ARN: props.openaiApiKeySecret.secretArn,
        TELEGRAM_BOT_TOKEN_ARN: props.telegramBotTokenSecret.secretArn,
      },
    });

    worker.addEventSource(
      new lambdaEventSources.SqsEventSource(this.queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    props.messagesTable.grant(worker, "dynamodb:PutItem");
    props.messagesTable.grant(worker, "dynamodb:Query");
    props.activitiesTable.grant(worker, "dynamodb:PutItem", "dynamodb:Query");
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [`${props.activitiesTable.tableArn}/index/*`],
      }),
    );
    props.responseCountersTable.grant(worker, "dynamodb:GetItem", "dynamodb:UpdateItem");
    props.homeopsTable.grant(worker, "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:DeleteItem");
    props.openaiApiKeySecret.grantRead(worker);
    props.telegramBotTokenSecret.grantRead(worker);

    new cloudwatch.Alarm(this, "DlqDepthAlarm", {
      metric: dlq.metricApproximateNumberOfMessagesVisible(),
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
    });

    new cloudwatch.Alarm(this, "WorkerErrorsAlarm", {
      metric: worker.metricErrors(),
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
    });
  }
}
