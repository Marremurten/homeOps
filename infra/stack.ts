import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { MessageStore } from "./constructs/message-store.js";
import { MessageProcessing } from "./constructs/message-processing.js";
import { IngestionApi } from "./constructs/ingestion-api.js";

export class HomeOpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const store = new MessageStore(this, "MessageStore");

    const botTokenSecret = new secretsmanager.Secret(this, "BotTokenSecret", {
      secretName: "homeops/telegram-bot-token",
    });

    const webhookSecret = new secretsmanager.Secret(this, "WebhookSecret", {
      secretName: "homeops/webhook-secret",
    });

    const openaiApiKeySecret = new secretsmanager.Secret(
      this,
      "OpenAiApiKeySecret",
      {
        secretName: "homeops/openai-api-key",
      },
    );

    const processing = new MessageProcessing(this, "MessageProcessing", {
      messagesTable: store.messagesTable,
    });

    new IngestionApi(this, "IngestionApi", {
      queue: processing.queue,
      webhookSecret,
    });

    // Add 30-day log retention for all Lambda functions
    const lambdas = this.node
      .findAll()
      .filter((c): c is lambda.Function => c instanceof lambda.Function);

    for (const fn of lambdas) {
      new logs.LogGroup(this, `${fn.node.id}LogGroup`, {
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
  }
}
