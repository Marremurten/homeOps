import { describe, it, beforeAll } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { MessageStore } from "../../infra/constructs/message-store.js";

describe("MessageStore construct", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    new MessageStore(stack, "TestMessageStore");
    template = Template.fromStack(stack);
  });

  describe("resource count", () => {
    it("creates exactly 2 DynamoDB tables", () => {
      template.resourceCountIs("AWS::DynamoDB::Table", 2);
    });
  });

  describe("homeops-messages table", () => {
    it("has partition key chatId of type String", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops-messages",
        KeySchema: Match.arrayWith([
          { AttributeName: "chatId", KeyType: "HASH" },
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "chatId", AttributeType: "S" },
        ]),
      });
    });

    it("has sort key messageId of type Number", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops-messages",
        KeySchema: Match.arrayWith([
          { AttributeName: "messageId", KeyType: "RANGE" },
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "messageId", AttributeType: "N" },
        ]),
      });
    });

    it("uses on-demand billing", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops-messages",
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops-messages",
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    it("has TTL enabled on ttl attribute", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops-messages",
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      });
    });

    it("has DeletionPolicy set to Delete", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: {
          TableName: "homeops-messages",
        },
        DeletionPolicy: "Delete",
      });
    });
  });

  describe("homeops table", () => {
    it("has partition key pk of type String", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops",
        KeySchema: Match.arrayWith([
          { AttributeName: "pk", KeyType: "HASH" },
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "pk", AttributeType: "S" },
        ]),
      });
    });

    it("has sort key sk of type String", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops",
        KeySchema: Match.arrayWith([
          { AttributeName: "sk", KeyType: "RANGE" },
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "sk", AttributeType: "S" },
        ]),
      });
    });

    it("uses on-demand billing", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops",
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    it("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops",
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    it("has GSI named gsi1 with correct keys", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "homeops",
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "ALL",
            },
          },
        ],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ]),
      });
    });

    it("has DeletionPolicy set to Delete", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: {
          TableName: "homeops",
        },
        DeletionPolicy: "Delete",
      });
    });
  });
});
