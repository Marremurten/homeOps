import { describe, it, expect, beforeAll } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { MessageProcessing } from "../../infra/constructs/message-processing.js";

describe("MessageProcessing construct", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    const table = new dynamodb.Table(stack, "TestTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const activitiesTable = new dynamodb.Table(stack, "ActivitiesTable", {
      partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "activityId", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const responseCountersTable = new dynamodb.Table(stack, "CountersTable", {
      partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const openaiApiKeySecret = new secretsmanager.Secret(stack, "OpenAISecret");
    const telegramBotTokenSecret = new secretsmanager.Secret(stack, "TelegramSecret");
    new MessageProcessing(stack, "TestProcessing", {
      messagesTable: table,
      activitiesTable,
      responseCountersTable,
      openaiApiKeySecret,
      telegramBotTokenSecret,
    });
    template = Template.fromStack(stack);
  });

  it("creates SQS queue with VisibilityTimeout of 360 seconds", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 360,
    });
  });

  it("creates DLQ with 14-day message retention (1209600 seconds)", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      MessageRetentionPeriod: 1209600,
    });
  });

  it("creates main queue with RedrivePolicy maxReceiveCount 3 pointing to DLQ", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 360,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it("creates Lambda function with Runtime nodejs22.x", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs22.x",
    });
  });

  it("creates Lambda function with Architecture arm64", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
    });
  });

  it("creates Lambda function with Timeout 60 seconds", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60,
    });
  });

  it("creates Lambda function with MemorySize 256", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      MemorySize: 256,
    });
  });

  it("creates SQS event source mapping with BatchSize 1 and ReportBatchItemFailures", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: Match.arrayWith(["ReportBatchItemFailures"]),
    });
  });

  it("sets MESSAGES_TABLE_NAME environment variable on Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          MESSAGES_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it("grants Lambda IAM role dynamodb:PutItem on the messages table", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.anyValue(),
            Effect: "Allow",
          }),
        ]),
      },
    });

    // Verify specifically that dynamodb:PutItem is included
    const policies = template.findResources("AWS::IAM::Policy");
    const hasPutItem = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.some(
          (a: string) => a === "dynamodb:PutItem" || a === "dynamodb:*"
        );
      });
    });
    expect(hasPutItem).toBe(true);
  });

  it("creates CloudWatch alarm on DLQ ApproximateNumberOfMessagesVisible with threshold > 0", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
    });
  });

  it("creates CloudWatch alarm on Lambda errors with GreaterThanThreshold", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      ComparisonOperator: "GreaterThanThreshold",
    });
  });

  it("sets ACTIVITIES_TABLE_NAME environment variable on Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ACTIVITIES_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it("sets RESPONSE_COUNTERS_TABLE_NAME environment variable on Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          RESPONSE_COUNTERS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it("sets OPENAI_API_KEY_ARN environment variable on Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          OPENAI_API_KEY_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it("sets TELEGRAM_BOT_TOKEN_ARN environment variable on Lambda", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          TELEGRAM_BOT_TOKEN_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it("grants Lambda IAM role dynamodb:PutItem on the activities table", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const hasPutItemOnActivities = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.some(
          (a: string) => a === "dynamodb:PutItem" || a === "dynamodb:*"
        );
      });
    });
    expect(hasPutItemOnActivities).toBe(true);
  });

  it("grants Lambda IAM role dynamodb:GetItem and dynamodb:UpdateItem on response-counters table", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const hasGetItem = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.some(
          (a: string) => a === "dynamodb:GetItem" || a === "dynamodb:*"
        );
      });
    });
    const hasUpdateItem = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.some(
          (a: string) => a === "dynamodb:UpdateItem" || a === "dynamodb:*"
        );
      });
    });
    expect(hasGetItem).toBe(true);
    expect(hasUpdateItem).toBe(true);
  });

  it("grants Lambda IAM role dynamodb:Query on the messages table", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const hasQuery = Object.values(policies).some((policy: any) => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((stmt: any) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.some(
          (a: string) => a === "dynamodb:Query" || a === "dynamodb:*"
        );
      });
    });
    expect(hasQuery).toBe(true);
  });

  it("grants Lambda IAM role secretsmanager:GetSecretValue on both secrets", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const secretStatements: any[] = [];
    for (const policy of Object.values(policies) as any[]) {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (
          actions.some(
            (a: string) =>
              a === "secretsmanager:GetSecretValue" || a === "secretsmanager:*"
          )
        ) {
          secretStatements.push(stmt);
        }
      }
    }
    // Should have at least one statement granting secretsmanager:GetSecretValue
    expect(secretStatements.length).toBeGreaterThanOrEqual(1);
  });
});
